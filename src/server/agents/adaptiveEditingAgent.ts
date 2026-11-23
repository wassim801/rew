import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import type {
  EditingProfileId,
  HighlightRecord,
  StudioSettings,
  TranscriptSegment,
  VideoMetadata,
} from '../../types/studio';
import { EDITING_PROFILES } from '../categories';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import {
  type AlignedSubtitleCue,
  alignClipSubtitlesWithAudio,
} from './transcriptionAgent';

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

  const lowerKeywords = keywords
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
}

function buildMontageShotPlan(params: {
  chunks: RenderSubtitleChunk[];
  clipDuration: number;
  highlight: HighlightRecord;
  profileId: EditingProfileId;
  allowDynamicZoom: boolean;
  isLandscapeSource: boolean;
}): { shots: MontageShot[]; hasMultiSpeakerSwitching: boolean } {
  const { chunks, clipDuration, highlight, profileId, allowDynamicZoom, isLandscapeSource } = params;

  const isRestrained = profileId === 'Minimal' || profileId === 'Educational';
  const enablePunchCuts =
    highlight.cropMode !== 'fit-blur' && (!isRestrained || highlight.dynamicZoom);

  // Merge voice chunks into deliberate camera shots (>= 2.5s each, max 10 shots per clip)
  const rawBeats: Array<{ start: number; end: number; speaker: string; hasKeyword: boolean }> = [];
  const lowerKws = highlight.keywords.map((k) => k.toLowerCase());

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

      if ((speakerChanged && curLen >= 2.0) || curLen >= 4.2) {
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

  const shots: MontageShot[] = rawBeats.map((beat, idx) => {
    let focusX = baseX;
    if (hasMultiSpeakerSwitching) {
      const spkIdx = speakers.indexOf(beat.speaker);
      focusX = spkIdx % 2 === 0 ? 0.28 : 0.72;
    }

    let zoomExpr = '1.000';
    if (enablePunchCuts) {
      const dur = Math.max(0.5, beat.end - beat.start);
      const allowSmoothPush = highlight.dynamicZoom && allowDynamicZoom;
      if (idx === 0) {
        // Opening hook: crisp 0.45s snap-zoom settle into gentle slow push for immediate viewer retention
        if (allowSmoothPush) {
          const restDur = Math.max(0.5, dur - 0.45).toFixed(2);
          zoomExpr = `if(lt(t,0.45),(1.160-0.110*(t/0.45)),(1.050+0.040*(t-0.45)/${restDur}))`;
        } else {
          zoomExpr = '1.080';
        }
      } else if (beat.hasKeyword || idx % 2 === 1) {
        // Studio close-up jump-cut punch-in on emphasis / alternate beat
        zoomExpr = allowSmoothPush
          ? `(1.110+0.045*(t-${beat.start.toFixed(2)})/${dur.toFixed(2)})`
          : '1.125';
      } else {
        // Clean reset to 1.00x wide framing for visual rhythm contrast
        zoomExpr = allowSmoothPush
          ? `(1.000+0.040*(t-${beat.start.toFixed(2)})/${dur.toFixed(2)})`
          : '1.000';
      }
    }

    return {
      start: beat.start,
      end: beat.end,
      zoomExpr,
      focusX,
    };
  });

  return { shots, hasMultiSpeakerSwitching };
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

export async function renderAdaptiveClip(params: {
  projectId: string;
  sourcePath: string;
  metadata: VideoMetadata | null;
  highlight: HighlightRecord;
  transcript: TranscriptSegment[];
  settings: StudioSettings;
  languageCode: string;
}): Promise<{ outputPath: string; outputUrl: string }> {
  const { projectId, sourcePath, metadata, highlight, transcript, settings, languageCode } = params;

  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const rendersDir = resolveSafePath(projectDir, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });

  const outFilename = `${highlight.id}.mp4`;
  const outputPath = resolveSafePath(rendersDir, outFilename);
  const assPath = resolveSafePath(rendersDir, `${highlight.id}.ass`);

  const tmpFilename = `${highlight.id}.tmp.${Date.now()}.mp4`;
  const tmpOutputPath = resolveSafePath(rendersDir, tmpFilename);

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

  const { shots, hasMultiSpeakerSwitching } = buildMontageShotPlan({
    chunks,
    clipDuration,
    highlight,
    profileId: profile.id,
    allowDynamicZoom: profile.allowDynamicZoom,
    isLandscapeSource,
  });

  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Step 3: Build montage video filtergraph starting with PTS normalization for exact A/V/subtitle sync
  const zoomExpr = buildPiecewiseExpr(shots, (s) => s.zoomExpr);
  const focusXExpr = buildPiecewiseExpr(shots, (s) => s.focusX.toFixed(2));
  const needsDynamicZoomOrCuts = shots.some((s) => s.zoomExpr !== '1.000');

  let baseVideoFilter: string;
  const useComplex = highlight.cropMode === 'fit-blur';

  if (useComplex) {
    baseVideoFilter =
      `setpts=PTS-STARTPTS,split[bg][fg];` +
      `[bg]crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='(iw-ow)/2':y='(ih-oh)/2',scale=270:480:flags=bilinear,boxblur=8:2,scale=1080:1920:flags=bilinear[bgb];` +
      `[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=bilinear,scale='trunc(iw/2)*2':'trunc(ih/2)*2'[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  } else if (hasMultiSpeakerSwitching) {
    // Keep wide frame horizontally so camera switches cleanly between Left & Right speakers + punch-ins
    baseVideoFilter =
      `setpts=PTS-STARTPTS,` +
      `scale=w='trunc(max(1080,iw*1920/ih)*(${zoomExpr})/2)*2':h='trunc(max(1920,ih*1080/iw)*(${zoomExpr})/2)*2':eval=frame:flags=bilinear,` +
      `crop=1080:1920:x='(iw-1080)*(${focusXExpr})':y='(ih-1920)/2',setsar=1`;
  } else {
    // Crop 9:16 first on source resolution for maximum encode speed, then apply beat punch-in/zoom cuts
    let cropX = '(iw-ow)/2';
    if (highlight.cropMode === 'left-subject') cropX = '(iw-ow)*0.22';
    if (highlight.cropMode === 'right-subject') cropX = '(iw-ow)*0.78';

    baseVideoFilter =
      `setpts=PTS-STARTPTS,` +
      `crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='${cropX}':y='(ih-oh)/2'`;

    if (needsDynamicZoomOrCuts) {
      baseVideoFilter +=
        `,scale=w='max(1080,trunc(1080*(${zoomExpr})/2)*2)':h='max(1920,trunc(1920*(${zoomExpr})/2)*2)':eval=frame:flags=bilinear,` +
        `crop=1080:1920:x='(iw-1080)/2':y='(ih-1920)/2',setsar=1`;
    } else {
      baseVideoFilter += `,scale=1080:1920:flags=bilinear,setsar=1`;
    }
  }

  const postFilters: string[] = [...getProfileColorFilters(profile.id)];
  if (profile.fadeTransitionSec > 0 && clipDuration > 2.5) {
    const fade = profile.fadeTransitionSec;
    const fadeOutStart = Math.max(0.5, clipDuration - fade).toFixed(2);
    postFilters.push(`fade=t=in:st=0:d=${fade},fade=t=out:st=${fadeOutStart}:d=${fade}`);
  }
  postFilters.push(`ass='${escapedAss}'`);

  // Hybrid seek (pre-seek before -i + fine-seek after -i) eliminates keyframe audio/subtitle offset
  const preSeek = Math.max(0, Number((highlight.startTime - 4).toFixed(3)));
  const fineSeek = Number((highlight.startTime - preSeek).toFixed(3));

  const args: string[] = [
    '-y',
    '-ss',
    String(preSeek),
    '-i',
    sourcePath,
    '-ss',
    String(fineSeek),
    '-t',
    String(clipDuration),
    '-avoid_negative_ts',
    'make_zero',
  ];

  if (useComplex) {
    const chain = `${baseVideoFilter},${postFilters.join(',')}[vout]`;
    args.push('-filter_complex', chain, '-map', '[vout]');
    if (metadata?.hasAudio !== false) {
      args.push('-map', '0:a?');
    }
  } else {
    args.push('-vf', `${baseVideoFilter},${postFilters.join(',')}`);
  }

  if (metadata?.hasAudio !== false) {
    const targetLufs = settings.audioTargetLufs || -14;
    const audioFadeOut = Math.max(0.2, clipDuration - 0.1).toFixed(2);
    const audioChain = highlight.normalizeAudio
      ? `asetpts=PTS-STARTPTS,highpass=f=75,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.06,afade=t=out:st=${audioFadeOut}:d=0.10`
      : `asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.06,afade=t=out:st=${audioFadeOut}:d=0.10`;
    args.push('-af', audioChain);
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
  } else {
    args.push('-an');
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
  }

  return {
    outputPath,
    outputUrl: `/api/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(
      outFilename
    )}?v=${Date.now()}`,
  };
}
