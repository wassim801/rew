import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  CameraEnergy,
  EditingProfileId,
  HighlightRecord,
  ProjectSourceVideo,
  StudioSettings,
  TranscriptSegment,
  TransitionStyle,
  VideoMetadata,
} from '../../types/studio';
import { ensureBgmTrack, resolveHighlightBgmVibe } from '../audio/bgmGenerator';
import {
  inferSceneSfxCue,
  renderCompositeSfxTrack,
  resolveHighlightSfxMode,
  type SfxEvent,
} from '../audio/sfxGenerator';
import { EDITING_PROFILES } from '../categories';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import {
  type AlignedSubtitleCue,
  alignClipSubtitlesWithAudio,
} from './transcriptionAgent';
import { probeVideoMetadata } from './videoIngestionAgent';

const execFileAsync = promisify(execFile);

function hexToAssColor(hex: string): string {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return '&H00F6823B'; // Studio blue in BGR
  }
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.floor((clamped % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

interface RenderSubtitleChunk {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * Splits voice-aligned cues into crisp 2-to-4 word beats weighted by spoken character count
 * so every subtitle line pops cleanly in sync with the audio.
 */
function buildRhythmicSubtitleChunks(
  alignedCues: AlignedSubtitleCue[],
  clipDuration: number
): RenderSubtitleChunk[] {
  const chunks: RenderSubtitleChunk[] = [];

  for (const cue of alignedCues) {
    const cStart = Math.max(0, cue.start);
    const cEnd = Math.min(clipDuration, cue.end);
    if (cEnd - cStart < 0.15) continue;

    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // Group words cleanly: max 4 words or ~22 characters per subtitle screen
    const groups: string[][] = [];
    let current: string[] = [];
    for (const word of words) {
      const candidateLen = [...current, word].join(' ').length;
      if (current.length >= 4 || (current.length >= 2 && candidateLen > 22)) {
        groups.push(current);
        current = [word];
      } else {
        current.push(word);
      }
    }
    if (current.length > 0) {
      groups.push(current);
    }
    // Rebalance single-word trailing orphan when previous group has >=3 words
    if (
      groups.length >= 2 &&
      groups[groups.length - 1].length === 1 &&
      groups[groups.length - 2].length >= 3
    ) {
      const moved = groups[groups.length - 2].pop();
      if (moved) {
        groups[groups.length - 1].unshift(moved);
      }
    }

    const totalWeight =
      groups.reduce((acc, grp) => acc + Math.max(2, grp.join('').length), 0) || 1;
    const totalDur = Math.max(0.25, cEnd - cStart);
    let cursor = cStart;

    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const weight = Math.max(2, grp.join('').length);
      const fracDur = i === groups.length - 1 ? cEnd - cursor : (totalDur * weight) / totalWeight;
      const gStart = Math.max(0, cursor);
      const gEnd = Math.min(clipDuration, Math.max(gStart + 0.2, gStart + fracDur));
      chunks.push({
        start: gStart,
        end: gEnd,
        speaker: cue.speaker || 'Speaker 1',
        text: grp.join(' '),
      });
      cursor = gEnd;
    }
  }

  return chunks;
}

function buildKaraokeWordTags(
  text: string,
  durationSec: number,
  keywords: string[],
  highlightAssColor: string,
  stylePreset: HighlightRecord['subtitleStyle'],
  isArabic: boolean
): string {
  const safe = escapeAssText(text);
  const words = safe.split(' ').filter(Boolean);
  if (words.length === 0) return safe;

  const lowerKeywords = (keywords ?? [])
    .flatMap((k) => k.toLowerCase().split(/\s+/))
    .filter((w) => w.length >= 3);

  // Preserve connected RTL glyph shaping in HarfBuzz for Arabic text without mid-line \k splits
  if (isArabic || stylePreset === 'minimal-caption') {
    return words.join(' ');
  }

  const totalWeight = words.reduce((acc, w) => acc + Math.max(2, w.length), 0) || 1;
  const totalCs = Math.max(20, Math.round(durationSec * 100));

  if (stylePreset === 'karaoke-pop' || stylePreset === 'bold-highlight') {
    let usedCs = 0;
    return words
      .map((tok, idx) => {
        const wWeight = Math.max(2, tok.length);
        const cs =
          idx === words.length - 1
            ? Math.max(8, totalCs - usedCs)
            : Math.max(8, Math.round((totalCs * wWeight) / totalWeight));
        usedCs += cs;
        const cleanTok = tok.replace(/[.,!?;:"'()«»؟،]/g, '').toLowerCase();
        const isKw = lowerKeywords.includes(cleanTok);
        const displayTok = stylePreset === 'karaoke-pop' && isKw ? tok.toUpperCase() : tok;
        return `{\\k${cs}}${isKw ? `{\\fscx110\\fscy110}${displayTok}{\\fscx100\\fscy100}` : displayTok}`;
      })
      .join(' ');
  }

  // 'clean' style: crisp keyword color pop without changing unread base styling
  return words
    .map((tok) => {
      const cleanTok = tok.replace(/[.,!?;:"'()«»؟،]/g, '').toLowerCase();
      if (lowerKeywords.includes(cleanTok)) {
        return `{\\c${highlightAssColor}\\b1}${tok}{\\c&H00FFFFFF&\\b0}`;
      }
      return tok;
    })
    .join(' ');
}

function buildHookHeadline(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length <= 7) return cleaned;
  return `${words.slice(0, 6).join(' ')}…`;
}

function generateAssSubtitleFile(params: {
  outAssPath: string;
  highlight: HighlightRecord;
  alignedCues: AlignedSubtitleCue[];
  clipDuration: number;
  settings: StudioSettings;
  languageCode: string;
}): { chunks: RenderSubtitleChunk[] } {
  const { outAssPath, highlight, alignedCues, clipDuration, settings, languageCode } = params;
  const isArabic = languageCode === 'ar' || /[\u0600-\u06FF]/.test(alignedCues.map((c) => c.text).join(' '));
  const fontName = isArabic ? 'Noto Sans Arabic' : 'Noto Sans';
  const baseFontSize = Math.max(38, Math.min(72, settings.subtitleFontSize || 54));
  const assHighlightColor = hexToAssColor(highlight.highlightColor || settings.defaultHighlightColor);

  const subFontSize =
    highlight.subtitleStyle === 'karaoke-pop'
      ? Math.min(72, baseFontSize + 8)
      : highlight.subtitleStyle === 'bold-highlight'
      ? Math.min(68, baseFontSize + 4)
      : highlight.subtitleStyle === 'minimal-caption'
      ? Math.max(38, baseFontSize - 8)
      : baseFontSize;

  // In ASS \k karaoke: SecondaryColour shows BEFORE the word is spoken, PrimaryColour shows AS/AFTER spoken
  const primaryColor =
    highlight.subtitleStyle === 'karaoke-pop' || highlight.subtitleStyle === 'bold-highlight'
      ? assHighlightColor
      : '&H00FFFFFF';
  const secondaryColor = '&H00FFFFFF';

  const useBoxCaption =
    !isArabic && (highlight.subtitleStyle === 'clean' || highlight.subtitleStyle === 'minimal-caption');
  const borderStyle = useBoxCaption ? 3 : 1;
  const outlineColour = useBoxCaption ? '&HAA080D1A' : '&H00070B14';
  const backColour = useBoxCaption ? '&HAA080D1A' : '&HA0050810';
  const outlineWidth = useBoxCaption ? 14 : highlight.subtitleStyle === 'karaoke-pop' ? 4.5 : 3.8;
  const shadowDepth = useBoxCaption ? 0 : 2.8;
  const marginV = highlight.subtitleStyle === 'minimal-caption' ? 235 : 350;
  const boldFlag = highlight.subtitleStyle === 'minimal-caption' ? 0 : -1;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${subFontSize},${primaryColor},${secondaryColor},${outlineColour},${backColour},${boldFlag},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowDepth},2,68,68,${marginV},1
Style: HookCard,${fontName},40,&H00FFFFFF,&H00FFFFFF,&HD8080D1A,&HD8080D1A,-1,0,0,0,100,100,0.4,0,3,18,0,8,76,76,168,1
Style: HookAccent,${fontName},23,&H00090E1A,&H00090E1A,${assHighlightColor},${assHighlightColor},-1,0,0,0,100,100,1.4,0,3,8,0,8,76,76,112,1
Style: ProgressTrack,Noto Sans,10,&H66000000,&H66000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: ProgressFill,Noto Sans,10,${assHighlightColor},${assHighlightColor},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Watermark,Noto Sans,25,&HA8E2E8F0,&H000000FF,&H90080C16,&H00000000,-1,0,0,0,100,100,0.5,0,1,2,0,9,40,48,54,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const chunks = buildRhythmicSubtitleChunks(alignedCues, clipDuration);
  const lines: string[] = [];

  for (const chunk of chunks) {
    const startStr = formatAssTime(chunk.start);
    const endStr = formatAssTime(Math.min(clipDuration, chunk.end));
    const styled = buildKaraokeWordTags(
      chunk.text,
      chunk.end - chunk.start,
      highlight.keywords,
      assHighlightColor,
      highlight.subtitleStyle,
      isArabic
    );
    const animTag =
      highlight.subtitleStyle === 'karaoke-pop'
        ? '{\\fscx110\\fscy110\\t(0,90,\\fscx100\\fscy100)}'
        : highlight.subtitleStyle === 'bold-highlight'
        ? '{\\fscx105\\fscy105\\t(0,80,\\fscx100\\fscy100)}'
        : '{\\fad(45,45)}';
    lines.push(`Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${animTag}${styled}`);
  }

  // Kinetic Hook Title Overlay during opening 3.2 seconds (skipped only for minimal captions)
  const rawHookHeadline = (highlight.hookHeadline || highlight.title).trim();
  if (highlight.subtitleStyle !== 'minimal-caption' && clipDuration >= 4 && rawHookHeadline) {
    const hookDur = Math.min(3.2, clipDuration * 0.45);
    const hookEndStr = formatAssTime(hookDur);
    const hookText = escapeAssText(buildHookHeadline(rawHookHeadline));
    lines.push(
      `Dialogue: 2,0:00:00.00,${hookEndStr},HookAccent,,0,0,0,,{\\fad(100,220)}${escapeAssText(
        highlight.categoryName.toUpperCase()
      )}`
    );
    lines.push(
      `Dialogue: 2,0:00:00.00,${hookEndStr},HookCard,,0,0,0,,{\\fad(100,220)}${hookText}`
    );
  }

  // Smooth Animated Progress Bar across bottom edge
  const endClipStr = formatAssTime(clipDuration);
  const totalMs = Math.max(500, Math.round(clipDuration * 1000));
  lines.push(
    `Dialogue: 3,0:00:00.00,${endClipStr},ProgressTrack,,0,0,0,,{\\an7\\pos(0,1911)\\p1}m 0 0 l 1080 0 l 1080 9 l 0 9{\\p0}`
  );
  lines.push(
    `Dialogue: 4,0:00:00.00,${endClipStr},ProgressFill,,0,0,0,,{\\an7\\pos(0,1911)\\org(0,1911)\\fscx1\\fscy100\\t(0,${totalMs},\\fscx100)\\p1}m 0 0 l 1080 0 l 1080 9 l 0 9{\\p0}`
  );

  if (highlight.watermarkEnabled && settings.watermarkText.trim()) {
    const wmText = escapeAssText(settings.watermarkText.trim());
    lines.push(`Dialogue: 5,0:00:00.00,${endClipStr},Watermark,,0,0,0,,${wmText}`);
  }

  fs.writeFileSync(outAssPath, header + lines.join('\n') + '\n', 'utf-8');
  return { chunks };
}

interface MontageShot {
  start: number;
  end: number;
  zoomExpr: string;
  focusX: number;
  shakeXExpr: string;
  shakeYExpr: string;
  hasShake: boolean;
}

function resolveEffectiveTransitionStyle(highlight: HighlightRecord): Exclude<TransitionStyle, 'auto'> {
  if (highlight.transitionStyle && highlight.transitionStyle !== 'auto') {
    return highlight.transitionStyle;
  }
  switch (highlight.editingProfile) {
    case 'Dynamic':
    case 'Gaming':
      return 'zoom-punch';
    case 'Comedy':
    case 'Travel':
      return 'whip-slide';
    case 'Cinematic':
      return 'dissolve';
    case 'Podcast':
    case 'Minimal':
    case 'Educational':
    default:
      return 'hard-cut';
  }
}

function resolveEffectiveCameraEnergy(highlight: HighlightRecord): Exclude<CameraEnergy, 'auto'> {
  if (highlight.cameraEnergy && highlight.cameraEnergy !== 'auto') {
    return highlight.cameraEnergy;
  }
  if (highlight.editingProfile === 'Minimal' || highlight.editingProfile === 'Educational') {
    return highlight.dynamicZoom ? 'dynamic' : 'calm';
  }
  if (
    highlight.editingProfile === 'Dynamic' ||
    highlight.editingProfile === 'Gaming' ||
    highlight.editingProfile === 'Comedy'
  ) {
    return highlight.dynamicZoom ? 'viral-shake' : 'dynamic';
  }
  return highlight.dynamicZoom ? 'dynamic' : 'calm';
}

function getXfadePlan(style: Exclude<TransitionStyle, 'auto'>): {
  duration: number;
  transitions: string[];
} {
  switch (style) {
    case 'whip-slide':
      return { duration: 0.22, transitions: ['smoothleft', 'smoothup', 'smoothright', 'slideleft'] };
    case 'zoom-punch':
      return { duration: 0.20, transitions: ['circleopen', 'radial', 'hblur', 'smoothleft'] };
    case 'dissolve':
      return { duration: 0.28, transitions: ['dissolve', 'fade', 'fadeblack'] };
    case 'flash-cut':
      return { duration: 0.16, transitions: ['fadewhite', 'hblur', 'fadewhite'] };
    case 'hard-cut':
    default:
      return { duration: 0, transitions: [] };
  }
}

function buildMontageShotPlan(params: {
  chunks: RenderSubtitleChunk[];
  clipDuration: number;
  highlight: HighlightRecord;
  profileId: EditingProfileId;
  allowDynamicZoom: boolean;
  isLandscapeSource: boolean;
}): { shots: MontageShot[]; hasMultiSpeakerSwitching: boolean; anyShake: boolean } {
  const { chunks, clipDuration, highlight, profileId, allowDynamicZoom, isLandscapeSource } = params;

  const energy = resolveEffectiveCameraEnergy(highlight);
  const isRestrained = (profileId === 'Minimal' || profileId === 'Educational') && energy === 'calm';
  const enablePunchCuts =
    highlight.cropMode !== 'fit-blur' && (!isRestrained || highlight.dynamicZoom || energy !== 'calm');

  // Merge voice chunks into deliberate camera shots (>= 2.2s each, max 10 shots per clip)
  const rawBeats: Array<{ start: number; end: number; speaker: string; hasKeyword: boolean }> = [];
  const lowerKws = (highlight.keywords ?? []).map((k) => k.toLowerCase());

  if (chunks.length === 0) {
    rawBeats.push({ start: 0, end: clipDuration, speaker: 'Speaker 1', hasKeyword: false });
  } else {
    let cur = {
      start: 0,
      end: chunks[0].end,
      speaker: chunks[0].speaker,
      hasKeyword: lowerKws.some((k) => chunks[0].text.toLowerCase().includes(k)),
    };

    for (let i = 1; i < chunks.length; i++) {
      const ch = chunks[i];
      const speakerChanged = ch.speaker !== cur.speaker;
      const curLen = cur.end - cur.start;
      const chHasKw = lowerKws.some((k) => ch.text.toLowerCase().includes(k));

      if ((speakerChanged && curLen >= 2.0) || curLen >= 4.0) {
        cur.end = ch.start;
        rawBeats.push(cur);
        cur = {
          start: ch.start,
          end: ch.end,
          speaker: ch.speaker,
          hasKeyword: chHasKw,
        };
      } else {
        cur.end = ch.end;
        cur.hasKeyword = cur.hasKeyword || chHasKw;
      }
    }
    cur.end = clipDuration;
    rawBeats.push(cur);
  }

  // Collapse if > 10 shots so FFmpeg expression stays lean and cuts stay intentional
  while (rawBeats.length > 10) {
    let shortestIdx = 0;
    let shortestDur = Infinity;
    for (let i = 0; i < rawBeats.length; i++) {
      const d = rawBeats[i].end - rawBeats[i].start;
      if (d < shortestDur) {
        shortestDur = d;
        shortestIdx = i;
      }
    }
    const targetIdx = shortestIdx === rawBeats.length - 1 ? shortestIdx - 1 : shortestIdx;
    rawBeats[targetIdx].end = rawBeats[targetIdx + 1].end;
    rawBeats[targetIdx].hasKeyword = rawBeats[targetIdx].hasKeyword || rawBeats[targetIdx + 1].hasKeyword;
    rawBeats.splice(targetIdx + 1, 1);
  }

  const speakers = Array.from(new Set(rawBeats.map((b) => b.speaker))).filter(Boolean);
  const hasMultiSpeakerSwitching =
    highlight.cropMode === 'auto-speaker' && isLandscapeSource && speakers.length >= 2;

  const baseX =
    highlight.cropMode === 'left-subject'
      ? 0.22
      : highlight.cropMode === 'right-subject'
      ? 0.78
      : 0.5;

  let anyShake = false;

  const shots: MontageShot[] = rawBeats.map((beat, idx) => {
    let focusX = baseX;
    if (hasMultiSpeakerSwitching) {
      const spkIdx = speakers.indexOf(beat.speaker);
      focusX = spkIdx % 2 === 0 ? 0.28 : 0.72;
    }

    const dur = Math.max(0.5, beat.end - beat.start);
    const allowSmoothPush = (highlight.dynamicZoom && allowDynamicZoom) || energy !== 'calm';
    const triggerImpactShake =
      highlight.cropMode !== 'fit-blur' &&
      ((idx === 0 && energy !== 'calm') ||
        (energy === 'viral-shake' && (beat.hasKeyword || idx % 2 === 1)));

    const overscan = triggerImpactShake ? 1.045 : 1.0;
    let zoomExpr = '1.000';
    if (enablePunchCuts) {
      if (idx === 0) {
        if (allowSmoothPush) {
          const restDur = Math.max(0.5, dur - 0.38).toFixed(2);
          const startZ = (1.18 * overscan).toFixed(3);
          const settleZ = (1.05 * overscan).toFixed(3);
          const endZ = (1.095 * overscan).toFixed(3);
          zoomExpr = `if(lt(t,0.38),(${startZ}-${(1.18 * overscan - 1.05 * overscan).toFixed(3)}*(t/0.38)),(${settleZ}+${(1.095 * overscan - 1.05 * overscan).toFixed(3)}*(t-0.38)/${restDur}))`;
        } else {
          zoomExpr = (1.08 * overscan).toFixed(3);
        }
      } else if (idx % 2 === 1) {
        // Zoom-In push on emphasis beat
        zoomExpr = allowSmoothPush
          ? `(${(1.02 * overscan).toFixed(3)}+${(0.125 * overscan).toFixed(3)}*(t-${beat.start.toFixed(2)})/${dur.toFixed(2)})`
          : (1.12 * overscan).toFixed(3);
      } else {
        // Smooth Zoom-Out pullback for visual variety & reveal contrast
        zoomExpr = allowSmoothPush
          ? `(${(1.14 * overscan).toFixed(3)}-${(0.115 * overscan).toFixed(3)}*(t-${beat.start.toFixed(2)})/${dur.toFixed(2)})`
          : (1.02 * overscan).toFixed(3);
      }
    }

    let shakeXExpr = '0';
    let shakeYExpr = '0';
    if (triggerImpactShake) {
      anyShake = true;
      const localT = `(t-${beat.start.toFixed(2)})`;
      shakeXExpr = `if(lt(${localT},0.36),14*exp(-8.5*${localT})*sin(${localT}*54),0)`;
      shakeYExpr = `if(lt(${localT},0.36),11*exp(-8.5*${localT})*cos(${localT}*46),0)`;
    }

    return {
      start: beat.start,
      end: beat.end,
      zoomExpr,
      focusX,
      shakeXExpr,
      shakeYExpr,
      hasShake: triggerImpactShake,
    };
  });

  return { shots, hasMultiSpeakerSwitching, anyShake };
}

function buildPiecewiseExpr(shots: MontageShot[], getter: (s: MontageShot) => string): string {
  if (shots.length === 1) {
    return getter(shots[0]);
  }
  let expr = getter(shots[shots.length - 1]);
  for (let i = shots.length - 2; i >= 0; i--) {
    const s = shots[i];
    expr = `if(lt(t,${s.end.toFixed(2)}),${getter(s)},${expr})`;
  }
  return expr;
}

function getProfileColorFilters(profileId: EditingProfileId): string[] {
  switch (profileId) {
    case 'Cinematic':
    case 'Travel':
      return ['eq=contrast=1.06:saturation=1.10:brightness=0.01', 'vignette=PI/6', 'unsharp=5:5:0.45:5:5:0.0'];
    case 'Podcast':
    case 'Dynamic':
    case 'Comedy':
    case 'Gaming':
      return ['eq=contrast=1.05:saturation=1.11:brightness=0.01', 'unsharp=5:5:0.50:5:5:0.0'];
    case 'Educational':
    case 'Minimal':
    default:
      return ['eq=contrast=1.02:saturation=1.04', 'unsharp=3:3:0.30:3:3:0.0'];
  }
}

function buildStitchedFallbackTranscript(
  highlight: HighlightRecord,
  sources: ProjectSourceVideo[],
  transitionDurSec = 0
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const segs = highlight.editSegments ?? [];
  let cursor = 0;
  for (let idx = 0; idx < segs.length; idx++) {
    const seg = segs[idx];
    const segDur = Math.max(0.5, seg.endTime - seg.startTime);
    const src = sources[seg.sourceIndex] ?? sources[0];
    const srcLines = (src?.transcript ?? []).filter(
      (t) => t.end > seg.startTime && t.start < seg.endTime
    );
    for (const line of srcLines) {
      const localStart = Math.max(0, line.start - seg.startTime);
      const localEnd = Math.min(segDur, line.end - seg.startTime);
      if (localEnd - localStart < 0.15) continue;
      out.push({
        ...line,
        start: Number(Math.max(0, cursor + localStart).toFixed(2)),
        end: Number(Math.max(0.2, cursor + localEnd).toFixed(2)),
      });
    }
    cursor += segDur - (idx < segs.length - 1 ? transitionDurSec : 0);
  }
  return out;
}

function buildAudioMixFilterGraph(params: {
  hasVoice: boolean;
  voiceInput: string;
  bgmInputIdx: number | null;
  sfxInputIdx: number | null;
  normalizeAudio: boolean;
  targetLufs: number;
  clipDuration: number;
}): { filterStr: string; mapAudio: boolean } {
  const { hasVoice, voiceInput, bgmInputIdx, sfxInputIdx, normalizeAudio, targetLufs, clipDuration } =
    params;
  const hasBgm = bgmInputIdx !== null;
  const hasSfx = sfxInputIdx !== null;
  const audioFadeOut = Math.max(0.2, clipDuration - 0.14).toFixed(2);
  const bgmFadeOut = Math.max(0.2, clipDuration - 0.55).toFixed(2);

  if (hasVoice && (hasBgm || hasSfx)) {
    const parts: string[] = [];
    const baseVoice = normalizeAudio
      ? `${voiceInput}aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,highpass=f=75,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180`
      : `${voiceInput}aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo`;

    if (hasBgm && hasSfx) {
      parts.push(`${baseVoice}[vnorm];[vnorm]asplit=3[vsc_bgm][vsc_sfx][vmix]`);
    } else if (hasBgm) {
      parts.push(`${baseVoice}[vnorm];[vnorm]asplit=2[vsc_bgm][vmix]`);
    } else {
      parts.push(`${baseVoice}[vnorm];[vnorm]asplit=2[vsc_sfx][vmix]`);
    }

    const mixInputs = ['[vmix]'];

    if (hasBgm && bgmInputIdx !== null) {
      parts.push(
        `[${bgmInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.22,lowpass=f=2800,afade=t=in:st=0:d=0.35,afade=t=out:st=${bgmFadeOut}:d=0.55[bgm0];[bgm0][vsc_bgm]sidechaincompress=threshold=0.018:ratio=7:attack=20:release=320:makeup=1[bgmd]`
      );
      mixInputs.push('[bgmd]');
    }

    if (hasSfx && sfxInputIdx !== null) {
      parts.push(
        `[${sfxInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.62[sfx0];[sfx0][vsc_sfx]sidechaincompress=threshold=0.055:ratio=2.3:attack=8:release=180:makeup=1[sfxd]`
      );
      mixInputs.push('[sfxd]');
    }

    parts.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.04,afade=t=out:st=${audioFadeOut}:d=0.14[aout]`
    );
    return { filterStr: parts.join(';'), mapAudio: true };
  }

  if (hasVoice) {
    const chain = normalizeAudio
      ? `${voiceInput}aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,highpass=f=75,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.04,afade=t=out:st=${audioFadeOut}:d=0.14[aout]`
      : `${voiceInput}aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=0.04,afade=t=out:st=${audioFadeOut}:d=0.14[aout]`;
    return { filterStr: chain, mapAudio: true };
  }

  if (hasBgm && hasSfx && bgmInputIdx !== null && sfxInputIdx !== null) {
    return {
      filterStr: `[${bgmInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.35,afade=t=in:st=0:d=0.35,afade=t=out:st=${bgmFadeOut}:d=0.55[bgm0];[${sfxInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.68[sfx0];[bgm0][sfx0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11[aout]`,
      mapAudio: true,
    };
  }

  if (hasBgm && bgmInputIdx !== null) {
    return {
      filterStr: `[${bgmInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.35,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.35,afade=t=out:st=${bgmFadeOut}:d=0.55[aout]`,
      mapAudio: true,
    };
  }

  if (hasSfx && sfxInputIdx !== null) {
    return {
      filterStr: `[${sfxInputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=0.68,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11[aout]`,
      mapAudio: true,
    };
  }

  return { filterStr: '', mapAudio: false };
}

async function renderMultiSegmentRemixClip(params: {
  projectId: string;
  projectBrief?: string;
  sources: ProjectSourceVideo[];
  highlight: HighlightRecord;
  settings: StudioSettings;
  languageCode: string;
  outputPath: string;
  assPath: string;
  tmpOutputPath: string;
  outFilename: string;
}): Promise<{ outputPath: string; outputUrl: string }> {
  const {
    projectId,
    projectBrief,
    sources,
    highlight,
    settings,
    languageCode,
    outputPath,
    assPath,
    tmpOutputPath,
    outFilename,
  } = params;
  const profile = EDITING_PROFILES[highlight.editingProfile] ?? EDITING_PROFILES.Minimal;
  const segments = highlight.editSegments ?? [];
  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const rendersDir = resolveSafePath(projectDir, 'renders');
  const workDir = resolveSafePath(rendersDir, `remix_work_${highlight.id}_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const transitionStyle = resolveEffectiveTransitionStyle(highlight);
  const cameraEnergy = resolveEffectiveCameraEnergy(highlight);
  const xfadePlan = getXfadePlan(transitionStyle);

  try {
    const segFiles: Array<{ path: string; duration: number }> = [];
    let hasAnyAudio = false;

    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      const src = sources[seg.sourceIndex] ?? sources[0];
      if (!src?.sourcePath || !fs.existsSync(src.sourcePath)) {
        throw new Error(`Missing source video file for remix segment #${idx + 1} (${seg.sourceFilename}).`);
      }

      // Snap segment duration to exact 30fps frame boundary to eliminate A/V drift
      const rawDur = Math.max(1.2, seg.endTime - seg.startTime);
      const exactFrames = Math.max(36, Math.round(rawDur * 30));
      const exactDur = Number((exactFrames / 30).toFixed(4));
      const segOutPath = path.join(workDir, `seg_${String(idx).padStart(2, '0')}.mov`);
      const srcHasAudio = src.metadata?.hasAudio !== false;
      if (srcHasAudio) hasAnyAudio = true;

      // IMPORTANT: NEVER alter voice speed or pitch (no setpts multiplier / atempo)
      let vf: string;
      const useFitBlur = highlight.cropMode === 'fit-blur';
      if (useFitBlur) {
        vf =
          `setpts=PTS-STARTPTS,` +
          `split[bg][fg];` +
          `[bg]crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='(iw-ow)/2':y='(ih-oh)/2',scale=270:480:flags=bilinear,boxblur=8:2,scale=1080:1920:flags=bilinear[bgb];` +
          `[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=bilinear,scale='trunc(iw/2)*2':'trunc(ih/2)*2'[fgs];` +
          `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,fps=30,trim=duration=${exactDur},setpts=PTS-STARTPTS,format=yuv420p,setsar=1`;
      } else {
        let cropX = '(iw-ow)/2';
        if (highlight.cropMode === 'left-subject') cropX = '(iw-ow)*0.22';
        if (highlight.cropMode === 'right-subject') cropX = '(iw-ow)*0.78';

        const triggerShake =
          (idx === 0 && cameraEnergy !== 'calm') ||
          (cameraEnergy === 'viral-shake' && (seg.role === 'hook' || seg.role === 'product' || seg.role === 'payoff' || idx % 2 === 1));
        const overscan = triggerShake ? 1.045 : 1.0;

        let zoomExpr = '1.000';
        const allowMotion = highlight.dynamicZoom || cameraEnergy !== 'calm';
        if (allowMotion) {
          if (idx === 0) {
            // Opening hook snap zoom-in + smooth settle
            const restDur = Math.max(0.4, exactDur - 0.36).toFixed(2);
            const z0 = (1.18 * overscan).toFixed(3);
            const z1 = (1.05 * overscan).toFixed(3);
            const z2 = (1.095 * overscan).toFixed(3);
            zoomExpr = `if(lt(t,0.36),(${z0}-${(1.18 * overscan - 1.05 * overscan).toFixed(3)}*(t/0.36)),(${z1}+${(1.095 * overscan - 1.05 * overscan).toFixed(3)}*(t-0.36)/${restDur}))`;
          } else if (idx % 2 === 1 || seg.role === 'product') {
            // Dynamic Zoom-In toward focal subject/product
            const zA = (1.015 * overscan).toFixed(3);
            const zDelta = (0.125 * overscan).toFixed(3);
            zoomExpr = `(${zA}+${zDelta}*t/${exactDur.toFixed(2)})`;
          } else {
            // Smooth Zoom-Out reveal pullback
            const zA = (1.14 * overscan).toFixed(3);
            const zDelta = (0.12 * overscan).toFixed(3);
            zoomExpr = `(${zA}-${zDelta}*t/${exactDur.toFixed(2)})`;
          }
        } else if (triggerShake) {
          zoomExpr = overscan.toFixed(3);
        }

        const shakeX = triggerShake
          ? `if(lt(t,0.36),14*exp(-8.5*t)*sin(t*54),0)`
          : '0';
        const shakeY = triggerShake
          ? `if(lt(t,0.36),11*exp(-8.5*t)*cos(t*46),0)`
          : '0';

        vf =
          `setpts=PTS-STARTPTS,` +
          `crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='${cropX}':y='(ih-oh)/2'`;
        if (zoomExpr !== '1.000' || triggerShake) {
          vf +=
            `,scale=w='max(1080,trunc(1080*(${zoomExpr})/2)*2)':h='max(1920,trunc(1920*(${zoomExpr})/2)*2)':eval=frame:flags=bilinear,` +
            `crop=1080:1920:x='max(0,min(iw-1080,(iw-1080)/2+(${shakeX})))':y='max(0,min(ih-1920,(ih-1920)/2+(${shakeY})))'`;
        } else {
          vf += `,scale=1080:1920:flags=bilinear`;
        }
        vf += `,fps=30,trim=duration=${exactDur},setpts=PTS-STARTPTS,format=yuv420p,setsar=1`;
      }

      const preSeek = Math.max(0, Number((seg.startTime - 3.5).toFixed(3)));
      const fineSeek = Number((seg.startTime - preSeek).toFixed(3));
      const fadeOutSt = Math.max(0.04, exactDur - 0.025).toFixed(3);

      const trimPrefix = `trim=start=${fineSeek}:duration=${exactDur},setpts=PTS-STARTPTS`;
      const vfTrimmed = vf.replace(/^setpts=PTS-STARTPTS,/, `${trimPrefix},`);

      const args: string[] = [
        '-y',
        '-ss',
        String(preSeek),
        '-i',
        src.sourcePath,
      ];

      if (!srcHasAudio) {
        args.push('-f', 'lavfi', '-t', String(exactDur), '-i', 'anullsrc=r=44100:cl=stereo');
      }

      if (useFitBlur) {
        args.push('-filter_complex', `${vfTrimmed}[vout]`, '-map', '[vout]');
        args.push('-map', srcHasAudio ? '0:a:0' : '1:a:0');
      } else {
        args.push('-vf', vfTrimmed);
        args.push('-map', '0:v:0');
        args.push('-map', srcHasAudio ? '0:a:0' : '1:a:0');
      }

      const audioTrimStart = srcHasAudio ? fineSeek : 0;
      // Use uncompressed pcm_s16le with exact atrim/apad so AAC priming frames never desync cuts
      args.push(
        '-af',
        `atrim=start=${audioTrimStart}:duration=${exactDur},asetpts=PTS-STARTPTS,aresample=44100:async=1:first_pts=0,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,apad=whole_dur=${exactDur},afade=t=in:st=0:d=0.015,afade=t=out:st=${fadeOutSt}:d=0.020`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        '15',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-t',
        String(exactDur),
        segOutPath
      );

      await execFileAsync('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });
      const segProbe = await probeVideoMetadata(segOutPath);
      segFiles.push({
        path: segOutPath,
        duration: Math.max(0.5, segProbe.duration || exactDur),
      });
    }

    const stitchedVideoPath = path.join(workDir, 'stitched_video.mov');
    const stitchedDialogueWav = path.join(workDir, 'stitched_dialogue.wav');

    const minSegDur = segFiles.reduce((m, s) => Math.min(m, s.duration), Infinity);
    const effectiveTransDur =
      segFiles.length >= 2 && xfadePlan.duration > 0
        ? Number(Math.min(xfadePlan.duration, minSegDur * 0.32).toFixed(3))
        : 0;

    if (segFiles.length === 1) {
      fs.copyFileSync(segFiles[0].path, stitchedVideoPath);
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', stitchedVideoPath, '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', stitchedDialogueWav],
        { maxBuffer: 10 * 1024 * 1024 }
      );
    } else {
      const stitchArgs: string[] = ['-y'];
      for (const sf of segFiles) {
        stitchArgs.push('-i', sf.path);
      }

      const filterParts: string[] = [];
      if (effectiveTransDur > 0.04) {
        // Chain xfade (video) and acrossfade (audio) with identical overlap duration so A/V remain 100% locked
        let curV = '[0:v]';
        let curA = '[0:a]';
        let cumDur = segFiles[0].duration;

        for (let i = 1; i < segFiles.length; i++) {
          const offset = Math.max(0.1, Number((cumDur - effectiveTransDur).toFixed(4)));
          const txName = xfadePlan.transitions[(i - 1) % xfadePlan.transitions.length];
          const nextV = i === segFiles.length - 1 ? '[vout]' : `[vx${i}]`;
          const nextA = i === segFiles.length - 1 ? '[aout]' : `[ax${i}]`;

          filterParts.push(
            `${curV}[${i}:v]xfade=transition=${txName}:duration=${effectiveTransDur}:offset=${offset}${nextV}`
          );
          filterParts.push(
            `${curA}[${i}:a]acrossfade=d=${effectiveTransDur}:c1=tri:c2=tri${nextA}`
          );

          curV = nextV;
          curA = nextA;
          cumDur = cumDur + segFiles[i].duration - effectiveTransDur;
        }
      } else {
        const inputs = segFiles.map((_, idx) => `[${idx}:v][${idx}:a]`).join('');
        filterParts.push(`${inputs}concat=n=${segFiles.length}:v=1:a=1[vout][aout]`);
      }

      stitchArgs.push(
        '-filter_complex',
        filterParts.join(';'),
        '-map',
        '[vout]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        stitchedVideoPath,
        '-map',
        '[aout]',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '44100',
        '-ac',
        '2',
        stitchedDialogueWav
      );

      await execFileAsync('ffmpeg', stitchArgs, { maxBuffer: 15 * 1024 * 1024 });
    }

    const stitchedProbe = await probeVideoMetadata(stitchedVideoPath);
    const clipDuration = Math.max(1, Number(stitchedProbe.duration.toFixed(2)));
    const fallbackTranscript = buildStitchedFallbackTranscript(highlight, sources, effectiveTransDur);
    const segHash = crypto
      .createHash('sha1')
      .update(
        `${transitionStyle}|` +
          segments.map((s) => `${s.sourceIndex}:${s.startTime.toFixed(2)}-${s.endTime.toFixed(2)}`).join('|')
      )
      .digest('hex')
      .slice(0, 10);

    // Align subtitles directly against the CLEAN stitched dialogue stem BEFORE mixing background music
    const alignedCues = hasAnyAudio
      ? await alignClipSubtitlesWithAudio({
          projectId,
          sourcePath: stitchedDialogueWav,
          highlightId: highlight.id,
          startTime: 0,
          endTime: clipDuration,
          fallbackTranscript,
          languageHint: languageCode,
          overrideCacheKey: `${highlight.id}_remix_${segHash}`,
        })
      : fallbackTranscript.map((s) => ({
          start: s.start,
          end: Math.min(clipDuration, s.end),
          speaker: s.speaker,
          text: s.text,
        }));

    generateAssSubtitleFile({
      outAssPath: assPath,
      highlight,
      alignedCues,
      clipDuration,
      settings,
      languageCode,
    });

    const bgmVibe = resolveHighlightBgmVibe(highlight, projectBrief);
    const bgmWavPath = await ensureBgmTrack(bgmVibe);

    const sfxMode = resolveHighlightSfxMode(highlight, projectBrief);
    const sfxEvents: SfxEvent[] = [];
    if (sfxMode !== 'none') {
      let prevCue: SfxEvent['cue'] | null = null;
      let segCursor = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segDur = segFiles[i]?.duration ?? Math.max(1.2, seg.endTime - seg.startTime);
        const src = sources[seg.sourceIndex] ?? sources[0];
        const segText = (src?.transcript ?? [])
          .filter((t) => t.end > seg.startTime && t.start < seg.endTime)
          .map((t) => t.text)
          .join(' ');

        const cue = inferSceneSfxCue({
          explicitCue: i === 0 ? highlight.hookSfx ?? seg.sfxCue : seg.sfxCue,
          mode: sfxMode,
          text: `${i === 0 ? highlight.hookHeadline || highlight.title : ''} ${segText}`,
          visualNote: seg.visualNote,
          role: seg.role,
          keywords: highlight.keywords,
          categoryId: highlight.categoryId,
          transitionStyle,
          isHook: i === 0,
          previousCue: prevCue,
          seedIdx: i,
        });

        if (cue) {
          const eventTime = i === 0 ? 0.08 : Math.max(0.25, Number((segCursor - 0.08).toFixed(3)));
          sfxEvents.push({
            cue,
            timeSec: eventTime,
            gain: i === 0 ? 0.78 : cue === 'whoosh-swish' ? 0.65 : 0.72,
          });
          prevCue = cue;
        }
        segCursor += segDur - (i < segments.length - 1 ? effectiveTransDur : 0);
      }

      // Optional mid-clip semantic reaction cue on longer clips if aligned subtitle hits a keyword/emotion beat
      for (const ac of alignedCues) {
        if (ac.start < 2.2 || ac.start > clipDuration - 1.5) continue;
        const tooClose = sfxEvents.some((e) => Math.abs(e.timeSec - ac.start) < 2.2);
        if (tooClose) continue;
        if (/\b(wrong|mistake|never|shock|omg|what|clever|smart|tip|gift|kitsch|click|look)\b/i.test(ac.text)) {
          const midCue = inferSceneSfxCue({
            mode: sfxMode,
            text: ac.text,
            keywords: highlight.keywords,
            categoryId: highlight.categoryId,
            previousCue: prevCue,
            seedIdx: sfxEvents.length + 3,
          });
          if (midCue) {
            sfxEvents.push({ cue: midCue, timeSec: Number(ac.start.toFixed(3)), gain: 0.68 });
            prevCue = midCue;
            break;
          }
        }
      }
    }

    const sfxTrackPath = await renderCompositeSfxTrack({
      clipDuration,
      events: sfxEvents,
      outWavPath: path.join(workDir, 'sfx_track.wav'),
    });

    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const postFilters: string[] = [...getProfileColorFilters(profile.id)];
    if (profile.fadeTransitionSec > 0 && clipDuration > 2.5) {
      const fade = profile.fadeTransitionSec;
      const fadeOutStart = Math.max(0.5, clipDuration - fade).toFixed(2);
      postFilters.push(`fade=t=in:st=0:d=${fade},fade=t=out:st=${fadeOutStart}:d=${fade}`);
    }
    postFilters.push(`ass='${escapedAss}'`);

    const hasBgm = Boolean(bgmWavPath && fs.existsSync(bgmWavPath));
    const hasSfx = Boolean(sfxTrackPath && fs.existsSync(sfxTrackPath));
    const finalArgs: string[] = ['-y', '-i', stitchedVideoPath];
    let nextInputIdx = 1;
    let voiceInputIdx: number | null = null;
    let bgmInputIdx: number | null = null;
    let sfxInputIdx: number | null = null;

    if (hasAnyAudio) {
      finalArgs.push('-i', stitchedDialogueWav);
      voiceInputIdx = nextInputIdx++;
    }
    if (hasBgm && bgmWavPath) {
      finalArgs.push('-stream_loop', '-1', '-t', String(clipDuration), '-i', bgmWavPath);
      bgmInputIdx = nextInputIdx++;
    }
    if (hasSfx && sfxTrackPath) {
      finalArgs.push('-i', sfxTrackPath);
      sfxInputIdx = nextInputIdx++;
    }

    const targetLufs = settings.audioTargetLufs || -14;
    const { filterStr, mapAudio } = buildAudioMixFilterGraph({
      hasVoice: hasAnyAudio && voiceInputIdx !== null,
      voiceInput: voiceInputIdx !== null ? `[${voiceInputIdx}:a]` : '[1:a]',
      bgmInputIdx,
      sfxInputIdx,
      normalizeAudio: highlight.normalizeAudio,
      targetLufs,
      clipDuration,
    });

    if (mapAudio) {
      finalArgs.push(
        '-filter_complex',
        `[0:v]${postFilters.join(',')}[vout];${filterStr}`,
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '44100'
      );
    } else {
      finalArgs.push('-vf', postFilters.join(','), '-an');
    }

    finalArgs.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-threads',
      '0',
      '-max_muxing_queue_size',
      '1024',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      tmpOutputPath
    );

    await execFileAsync('ffmpeg', finalArgs, { maxBuffer: 10 * 1024 * 1024 });
    fs.renameSync(tmpOutputPath, outputPath);

    return {
      outputPath,
      outputUrl: `/api/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(
        outFilename
      )}?v=${Date.now()}`,
    };
  } catch (err) {
    if (fs.existsSync(tmpOutputPath)) {
      try {
        fs.unlinkSync(tmpOutputPath);
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

export async function renderAdaptiveClip(params: {
  projectId: string;
  projectBrief?: string;
  sourcePath: string;
  metadata: VideoMetadata | null;
  highlight: HighlightRecord;
  transcript: TranscriptSegment[];
  settings: StudioSettings;
  languageCode: string;
  sources?: ProjectSourceVideo[];
}): Promise<{ outputPath: string; outputUrl: string }> {
  const { projectId, projectBrief, sourcePath, metadata, highlight, transcript, settings, languageCode, sources } = params;

  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const rendersDir = resolveSafePath(projectDir, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });

  const outFilename = `${highlight.id}.mp4`;
  const outputPath = resolveSafePath(rendersDir, outFilename);
  const assPath = resolveSafePath(rendersDir, `${highlight.id}.ass`);

  const tmpFilename = `${highlight.id}.tmp.${Date.now()}.mp4`;
  const tmpOutputPath = resolveSafePath(rendersDir, tmpFilename);

  if (highlight.editSegments && highlight.editSegments.length > 0 && sources && sources.length > 0) {
    return renderMultiSegmentRemixClip({
      projectId,
      projectBrief,
      sources,
      highlight,
      settings,
      languageCode,
      outputPath,
      assPath,
      tmpOutputPath,
      outFilename,
    });
  }

  const profile = EDITING_PROFILES[highlight.editingProfile] ?? EDITING_PROFILES.Minimal;
  const clipDuration = Math.max(1, Number((highlight.endTime - highlight.startTime).toFixed(2)));

  // Step 1: Align subtitles directly to the clipped [startTime, endTime] voice audio
  const alignedCues =
    metadata?.hasAudio !== false
      ? await alignClipSubtitlesWithAudio({
          projectId,
          sourcePath,
          highlightId: highlight.id,
          startTime: highlight.startTime,
          endTime: highlight.endTime,
          fallbackTranscript: transcript,
          languageHint: languageCode,
        })
      : transcript
          .filter((s) => s.end > highlight.startTime && s.start < highlight.endTime)
          .map((s) => ({
            start: Math.max(0, s.start - highlight.startTime),
            end: Math.min(clipDuration, s.end - highlight.startTime),
            speaker: s.speaker,
            text: s.text,
          }));

  // Step 2: Generate karaoke + hook card + animated progress bar ASS script
  const { chunks } = generateAssSubtitleFile({
    outAssPath: assPath,
    highlight,
    alignedCues,
    clipDuration,
    settings,
    languageCode,
  });

  const srcWidth = metadata?.width || 1920;
  const srcHeight = metadata?.height || 1080;
  const isLandscapeSource = srcWidth / Math.max(1, srcHeight) > 1.15;

  const { shots, hasMultiSpeakerSwitching, anyShake } = buildMontageShotPlan({
    chunks,
    clipDuration,
    highlight,
    profileId: profile.id,
    allowDynamicZoom: profile.allowDynamicZoom,
    isLandscapeSource,
  });

  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Step 3: Build montage video filtergraph starting with PTS normalization + zoom-in/out & damped shake
  const zoomExpr = buildPiecewiseExpr(shots, (s) => s.zoomExpr);
  const focusXExpr = buildPiecewiseExpr(shots, (s) => s.focusX.toFixed(2));
  const shakeXExpr = anyShake ? buildPiecewiseExpr(shots, (s) => s.shakeXExpr) : '0';
  const shakeYExpr = anyShake ? buildPiecewiseExpr(shots, (s) => s.shakeYExpr) : '0';
  const needsDynamicZoomOrCuts = shots.some((s) => s.zoomExpr !== '1.000') || anyShake;

  let baseVideoFilter: string;
  const useComplex = highlight.cropMode === 'fit-blur';

  if (useComplex) {
    baseVideoFilter =
      `setpts=PTS-STARTPTS,split[bg][fg];` +
      `[bg]crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='(iw-ow)/2':y='(ih-oh)/2',scale=270:480:flags=bilinear,boxblur=8:2,scale=1080:1920:flags=bilinear[bgb];` +
      `[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=bilinear,scale='trunc(iw/2)*2':'trunc(ih/2)*2'[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1`;
  } else if (hasMultiSpeakerSwitching) {
    baseVideoFilter =
      `setpts=PTS-STARTPTS,` +
      `scale=w='trunc(max(1080,iw*1920/ih)*(${zoomExpr})/2)*2':h='trunc(max(1920,ih*1080/iw)*(${zoomExpr})/2)*2':eval=frame:flags=bilinear,` +
      `crop=1080:1920:x='max(0,min(iw-1080,(iw-1080)*(${focusXExpr})+(${shakeXExpr})))':y='max(0,min(ih-1920,(ih-1920)/2+(${shakeYExpr})))',fps=30,setsar=1`;
  } else {
    let cropX = '(iw-ow)/2';
    if (highlight.cropMode === 'left-subject') cropX = '(iw-ow)*0.22';
    if (highlight.cropMode === 'right-subject') cropX = '(iw-ow)*0.78';

    baseVideoFilter =
      `setpts=PTS-STARTPTS,` +
      `crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='${cropX}':y='(ih-oh)/2'`;

    if (needsDynamicZoomOrCuts) {
      baseVideoFilter +=
        `,scale=w='max(1080,trunc(1080*(${zoomExpr})/2)*2)':h='max(1920,trunc(1920*(${zoomExpr})/2)*2)':eval=frame:flags=bilinear,` +
        `crop=1080:1920:x='max(0,min(iw-1080,(iw-1080)/2+(${shakeXExpr})))':y='max(0,min(ih-1920,(ih-1920)/2+(${shakeYExpr})))',fps=30,setsar=1`;
    } else {
      baseVideoFilter += `,scale=1080:1920:flags=bilinear,fps=30,setsar=1`;
    }
  }

  const postFilters: string[] = [...getProfileColorFilters(profile.id)];
  if (profile.fadeTransitionSec > 0 && clipDuration > 2.5) {
    const fade = profile.fadeTransitionSec;
    const fadeOutStart = Math.max(0.5, clipDuration - fade).toFixed(2);
    postFilters.push(`fade=t=in:st=0:d=${fade},fade=t=out:st=${fadeOutStart}:d=${fade}`);
  }
  postFilters.push(`ass='${escapedAss}'`);

  const bgmVibe = resolveHighlightBgmVibe(highlight, projectBrief);
  const bgmWavPath = await ensureBgmTrack(bgmVibe);
  const hasBgm = Boolean(bgmWavPath && fs.existsSync(bgmWavPath));

  const sfxMode = resolveHighlightSfxMode(highlight, projectBrief);
  const transitionStyle = resolveEffectiveTransitionStyle(highlight);
  const sfxEvents: SfxEvent[] = [];
  if (sfxMode !== 'none') {
    let prevCue: SfxEvent['cue'] | null = null;
    const hookText = `${highlight.hookHeadline || highlight.title} ${chunks[0]?.text || ''}`;
    const hookCue = inferSceneSfxCue({
      explicitCue: highlight.hookSfx,
      mode: sfxMode,
      text: hookText,
      keywords: highlight.keywords,
      categoryId: highlight.categoryId,
      transitionStyle,
      isHook: true,
      previousCue: null,
      seedIdx: 0,
    });
    if (hookCue) {
      sfxEvents.push({ cue: hookCue, timeSec: 0.08, gain: 0.78 });
      prevCue = hookCue;
    }

    for (let sIdx = 1; sIdx < shots.length; sIdx++) {
      const sh = shots[sIdx];
      if (sh.start < 1.8 || sh.start > clipDuration - 0.6) continue;
      const nearbyText = chunks
        .filter((c) => c.end >= sh.start - 0.4 && c.start <= sh.end)
        .map((c) => c.text)
        .join(' ');
      const shotCue = inferSceneSfxCue({
        mode: sfxMode,
        text: nearbyText,
        keywords: highlight.keywords,
        categoryId: highlight.categoryId,
        transitionStyle,
        previousCue: prevCue,
        seedIdx: sIdx,
      });
      if (shotCue) {
        sfxEvents.push({
          cue: shotCue,
          timeSec: Math.max(0.25, Number((sh.start - 0.05).toFixed(3))),
          gain: shotCue === 'whoosh-swish' ? 0.64 : 0.72,
        });
        prevCue = shotCue;
      }
    }
  }

  const tmpSfxWavPath = resolveSafePath(rendersDir, `${highlight.id}.sfx.${Date.now()}.wav`);
  const sfxTrackPath = await renderCompositeSfxTrack({
    clipDuration,
    events: sfxEvents,
    outWavPath: tmpSfxWavPath,
  });
  const hasSfx = Boolean(sfxTrackPath && fs.existsSync(sfxTrackPath));

  // Hybrid seek: keyframe pre-seek before -i + exact filtergraph trim/atrim for millisecond A/V sync
  const preSeek = Math.max(0, Number((highlight.startTime - 4).toFixed(3)));
  const fineSeek = Number((highlight.startTime - preSeek).toFixed(3));
  const singleTrimPrefix = `trim=start=${fineSeek}:duration=${clipDuration},setpts=PTS-STARTPTS`;
  const trimmedBaseVideoFilter = baseVideoFilter.replace(/^setpts=PTS-STARTPTS,/, `${singleTrimPrefix},`);

  const args: string[] = [
    '-y',
    '-ss',
    String(preSeek),
    '-i',
    sourcePath,
  ];

  let nextInputIdx = 1;
  let bgmInputIdx: number | null = null;
  let sfxInputIdx: number | null = null;
  if (hasBgm && bgmWavPath) {
    args.push('-stream_loop', '-1', '-t', String(clipDuration), '-i', bgmWavPath);
    bgmInputIdx = nextInputIdx++;
  }
  if (hasSfx && sfxTrackPath) {
    args.push('-i', sfxTrackPath);
    sfxInputIdx = nextInputIdx++;
  }

  const targetLufs = settings.audioTargetLufs || -14;
  const hasVoice = metadata?.hasAudio !== false;

  if (useComplex || hasBgm || hasSfx) {
    const videoChain = `${trimmedBaseVideoFilter},${postFilters.join(',')}[vout]`;
    const { filterStr, mapAudio } = buildAudioMixFilterGraph({
      hasVoice,
      voiceInput: `[0:a]atrim=start=${fineSeek}:duration=${clipDuration},asetpts=PTS-STARTPTS,`,
      bgmInputIdx,
      sfxInputIdx,
      normalizeAudio: highlight.normalizeAudio,
      targetLufs,
      clipDuration,
    });
    if (mapAudio) {
      args.push('-filter_complex', `${videoChain};${filterStr}`, '-map', '[vout]', '-map', '[aout]');
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
    } else {
      args.push('-filter_complex', videoChain, '-map', '[vout]', '-an');
    }
  } else {
    args.push('-vf', `${trimmedBaseVideoFilter},${postFilters.join(',')}`);
    if (hasVoice) {
      const audioFadeOut = Math.max(0.2, clipDuration - 0.14).toFixed(2);
      const audioChain = highlight.normalizeAudio
        ? `atrim=start=${fineSeek}:duration=${clipDuration},asetpts=PTS-STARTPTS,aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,highpass=f=75,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.04,afade=t=out:st=${audioFadeOut}:d=0.14`
        : `atrim=start=${fineSeek}:duration=${clipDuration},asetpts=PTS-STARTPTS,aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=0.04,afade=t=out:st=${audioFadeOut}:d=0.14`;
      args.push('-af', audioChain, '-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
    } else {
      args.push('-an');
    }
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-threads',
    '0',
    '-max_muxing_queue_size',
    '1024',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    tmpOutputPath
  );

  try {
    await execFileAsync('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });
    fs.renameSync(tmpOutputPath, outputPath);
  } catch (err) {
    if (fs.existsSync(tmpOutputPath)) {
      try {
        fs.unlinkSync(tmpOutputPath);
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  } finally {
    if (fs.existsSync(tmpSfxWavPath)) {
      try {
        fs.unlinkSync(tmpSfxWavPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  return {
    outputPath,
    outputUrl: `/api/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(
      outFilename
    )}?v=${Date.now()}`,
  };
}
