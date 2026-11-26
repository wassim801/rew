import { ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  BgmVibe,
  CameraEnergy,
  CategoryConfig,
  ContentAnalysis,
  CropFocusMode,
  EditingProfileId,
  HighlightRecord,
  HighlightScoreBreakdown,
  ProjectSourceVideo,
  RemixSegment,
  SceneKeyframe,
  SfxCueType,
  SfxMode,
  StudioSettings,
  SubtitleStylePreset,
  ThumbnailVibeStyle,
  TranscriptSegment,
  TransitionStyle,
  VideoMetadata,
} from '../../types/studio';
import { EDITING_PROFILES, findCategoryByIdOrName } from '../categories';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import { getGeminiClient, withModelFallback } from '../geminiClient';
import {
  VALID_THUMBNAIL_STYLES,
  deriveFallbackThumbnailCopy,
  resolveThumbnailStyle,
  splitGraphemeEmojis,
} from './thumbnailAgent';
import { detectSpeechIntervals } from './transcriptionAgent';

const execFileAsync = promisify(execFile);

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Computes word-overlap / phrase similarity (0..1) between a model-quoted anchor phrase
 * and a transcript window so clip boundaries lock onto real spoken words instead of drifted timestamps.
 */
function scorePhraseMatch(anchorWords: string[], candidateText: string): number {
  if (anchorWords.length === 0) return 0;
  const target = normalizeWords(candidateText);
  if (target.length === 0) return 0;

  const anchorStr = anchorWords.join(' ');
  const targetStr = target.join(' ');
  if (targetStr.includes(anchorStr)) return 1;

  const targetSet = new Set(target);
  let hits = 0;
  for (const w of anchorWords) {
    if (targetSet.has(w)) hits++;
  }
  return hits / anchorWords.length;
}

export function findQuoteMatchedSpan(
  startHint: number,
  endHint: number,
  exactStartPhrase: string | undefined,
  exactEndPhrase: string | undefined,
  transcript: TranscriptSegment[],
  totalDuration: number,
  minDur: number,
  maxDur: number
): { startTime: number; endTime: number; startSegIdx: number; endSegIdx: number } {
  if (transcript.length === 0) {
    return {
      startTime: Number(Math.max(0, startHint).toFixed(2)),
      endTime: Number(Math.min(totalDuration, Math.max(startHint + 3, endHint)).toFixed(2)),
      startSegIdx: -1,
      endSegIdx: -1,
    };
  }

  const startAnchorWords = normalizeWords(exactStartPhrase || '').slice(0, 8);
  const endAnchorWords = normalizeWords(exactEndPhrase || '').slice(-8);

  // Locate start segment index inside +/- 25s search radius (or fallback to nearest timestamp)
  let bestStartIdx = -1;
  let bestStartScore = 0.45;
  for (let i = 0; i < transcript.length; i++) {
    const seg = transcript[i];
    if (Math.abs(seg.start - startHint) > 25 && Math.abs(seg.end - startHint) > 25) continue;
    const windowText =
      i + 1 < transcript.length ? `${seg.text} ${transcript[i + 1].text}` : seg.text;
    const phraseScore = scorePhraseMatch(startAnchorWords, windowText);
    const proxBonus = Math.max(0, 1 - Math.abs(seg.start - startHint) / 25) * 0.15;
    const combined = phraseScore + proxBonus;
    if (phraseScore >= 0.45 && combined > bestStartScore) {
      bestStartScore = combined;
      bestStartIdx = i;
    }
  }

  if (bestStartIdx === -1) {
    bestStartIdx = transcript.reduce(
      (best, cur, idx) =>
        Math.abs(cur.start - startHint) < Math.abs(transcript[best].start - startHint) ? idx : best,
      0
    );
  }

  // Locate end segment index at or after bestStartIdx within reasonable max length
  let bestEndIdx = -1;
  let bestEndScore = 0.45;
  for (let i = bestStartIdx; i < transcript.length; i++) {
    const seg = transcript[i];
    const spanLen = seg.end - transcript[bestStartIdx].start;
    if (spanLen > Math.max(maxDur + 20, 90)) break;
    if (Math.abs(seg.end - endHint) > 25 && Math.abs(seg.start - endHint) > 25) continue;
    const windowText = i > 0 ? `${transcript[i - 1].text} ${seg.text}` : seg.text;
    const phraseScore = scorePhraseMatch(endAnchorWords, windowText);
    const proxBonus = Math.max(0, 1 - Math.abs(seg.end - endHint) / 25) * 0.15;
    const combined = phraseScore + proxBonus;
    if (phraseScore >= 0.45 && combined > bestEndScore) {
      bestEndScore = combined;
      bestEndIdx = i;
    }
  }

  if (bestEndIdx === -1 || bestEndIdx < bestStartIdx) {
    let closest = bestStartIdx;
    let minDiff = Infinity;
    for (let i = bestStartIdx; i < transcript.length; i++) {
      const diff = Math.abs(transcript[i].end - endHint);
      if (diff < minDiff) {
        minDiff = diff;
        closest = i;
      }
    }
    bestEndIdx = closest;
  }

  // Ensure duration reaches at least effective minDur by expanding along complete sentences if needed
  const ceilingMax = Math.min(totalDuration, maxDur + 8);
  while (
    bestEndIdx + 1 < transcript.length &&
    transcript[bestEndIdx].end - transcript[bestStartIdx].start < minDur
  ) {
    const nextSpan = transcript[bestEndIdx + 1].end - transcript[bestStartIdx].start;
    if (nextSpan > ceilingMax) break;
    bestEndIdx++;
  }

  // Trim backward if span vastly exceeds maxDur while keeping sentence completion
  while (
    bestEndIdx > bestStartIdx &&
    transcript[bestEndIdx].end - transcript[bestStartIdx].start > ceilingMax
  ) {
    bestEndIdx--;
  }

  const first = transcript[bestStartIdx];
  const last = transcript[bestEndIdx];
  const prevEnd = bestStartIdx > 0 ? transcript[bestStartIdx - 1].end : 0;
  const nextStart =
    bestEndIdx < transcript.length - 1 ? transcript[bestEndIdx + 1].start : totalDuration;

  const snappedStart = Math.max(0, prevEnd, first.start - 0.14);
  const snappedEnd = Math.min(totalDuration, nextStart, last.end + 0.24);

  return {
    startTime: Number(snappedStart.toFixed(2)),
    endTime: Number(Math.max(snappedStart + 3, snappedEnd).toFixed(2)),
    startSegIdx: bestStartIdx,
    endSegIdx: bestEndIdx,
  };
}

function computeWeightedScore(
  raw: Omit<HighlightScoreBreakdown, 'totalScore'>,
  category: CategoryConfig
): HighlightScoreBreakdown {
  const w = category.criteriaWeights;
  const rawValues = [
    Number(raw.hookStrength) || 0,
    Number(raw.standaloneContext) || 0,
    Number(raw.audienceInterest) || 0,
    Number(raw.emotionalOrInfoValue) || 0,
    Number(raw.contentCompleteness) || 0,
    Number(raw.audioVisualQuality) || 0,
  ];
  const scaleFactor = Math.max(...rawValues) > 0 && Math.max(...rawValues) <= 10 ? 10 : 1;
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round((Number(v) || 0) * scaleFactor)));

  const hookStrength = clamp(raw.hookStrength);
  const standaloneContext = clamp(raw.standaloneContext);
  const audienceInterest = clamp(raw.audienceInterest);
  const emotionalOrInfoValue = clamp(raw.emotionalOrInfoValue);
  const contentCompleteness = clamp(raw.contentCompleteness);
  const audioVisualQuality = clamp(raw.audioVisualQuality);

  const totalScore = Math.round(
    hookStrength * w.hookStrength +
      standaloneContext * w.standaloneContext +
      audienceInterest * w.audienceInterest +
      emotionalOrInfoValue * w.emotionalOrInfoValue +
      contentCompleteness * w.contentCompleteness +
      audioVisualQuality * w.audioVisualQuality
  );

  return {
    hookStrength,
    standaloneContext,
    audienceInterest,
    emotionalOrInfoValue,
    contentCompleteness,
    audioVisualQuality,
    totalScore,
  };
}

/**
 * Trims leading/trailing silence on final selected clips using FFmpeg silencedetect
 * so every highlight opens tightly on the first spoken word and ends cleanly after the payoff.
 */
async function polishHighlightAcousticBounds(params: {
  projectId: string;
  sourcePath: string;
  startTime: number;
  endTime: number;
  totalDuration: number;
}): Promise<{ startTime: number; endTime: number }> {
  const { projectId, sourcePath, startTime, endTime, totalDuration } = params;
  const padStart = Math.max(0, Number((startTime - 0.8).toFixed(2)));
  const padEnd = Math.min(totalDuration, Number((endTime + 0.8).toFixed(2)));
  const sliceDur = Math.max(1, Number((padEnd - padStart).toFixed(2)));

  const rendersDir = resolveSafePath(PROJECTS_DIR, projectId, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const tmpMp3 = resolveSafePath(rendersDir, `bound_polish_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`);

  try {
    const preSeek = Math.max(0, Number((padStart - 3).toFixed(2)));
    const fineSeek = Number((padStart - preSeek).toFixed(2));
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-nostats',
        '-loglevel',
        'error',
        '-ss',
        String(preSeek),
        '-i',
        sourcePath,
        '-ss',
        String(fineSeek),
        '-t',
        String(sliceDur),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '48k',
        tmpMp3,
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );

    if (!fs.existsSync(tmpMp3) || fs.statSync(tmpMp3).size < 256) {
      return { startTime, endTime };
    }

    const intervals = await detectSpeechIntervals(tmpMp3, sliceDur);
    if (intervals.length === 0) {
      return { startTime, endTime };
    }

    const relOrigStart = startTime - padStart;
    const relOrigEnd = endTime - padStart;

    // Find first voiced burst overlapping near startTime
    const firstVoiced =
      intervals.find((iv) => iv.end >= relOrigStart - 0.3 && iv.start <= relOrigStart + 2.5) ??
      intervals[0];
    // Find last voiced burst overlapping near endTime
    const reversed = [...intervals].reverse();
    const lastVoiced =
      reversed.find((iv) => iv.start <= relOrigEnd + 0.3 && iv.end >= relOrigEnd - 2.5) ??
      intervals[intervals.length - 1];

    const polishedStart = Math.max(
      0,
      Math.min(startTime + 1.5, padStart + firstVoiced.start - 0.16)
    );
    const polishedEnd = Math.min(
      totalDuration,
      Math.max(polishedStart + 3, padStart + lastVoiced.end + 0.32)
    );

    // Guard against over-aggressive shifts (>2.5s) vs transcript-verified bounds
    const finalStart = Math.abs(polishedStart - startTime) <= 2.2 ? polishedStart : startTime;
    const finalEnd = Math.abs(polishedEnd - endTime) <= 2.2 ? polishedEnd : endTime;

    return {
      startTime: Number(finalStart.toFixed(2)),
      endTime: Number(Math.max(finalStart + 3, finalEnd).toFixed(2)),
    };
  } catch {
    return { startTime, endTime };
  } finally {
    if (fs.existsSync(tmpMp3)) {
      try {
        fs.unlinkSync(tmpMp3);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

async function generateMultiSourceRemixHighlights(params: {
  projectId: string;
  title: string;
  brief?: string;
  sources: ProjectSourceVideo[];
  scenes: SceneKeyframe[];
  analysis: ContentAnalysis;
  settings: StudioSettings;
}): Promise<HighlightRecord[]> {
  const { projectId, title, brief, sources, scenes, analysis, settings } = params;
  const category = findCategoryByIdOrName(analysis.primaryCategoryId, settings.customCategories);
  const profileSpec =
    EDITING_PROFILES[analysis.recommendedProfile] ?? EDITING_PROFILES[category.defaultEditingProfile];
  const ai = getGeminiClient();

  const cleanBrief = brief?.trim() || '';
  const briefBlock = cleanBrief
    ? `\nUSER CONSIGNE / CAMPAIGN BRIEF (MANDATORY COMPLIANCE):\n"""\n${cleanBrief}\n"""\n${
        analysis.briefInterpretation ? `AI Editorial & Compliance Plan: ${analysis.briefInterpretation}\n` : ''
      }`
    : analysis.briefInterpretation
    ? `\nAI Editorial Plan: ${analysis.briefInterpretation}\n`
    : '';

  const VALID_PROFILES = Object.keys(EDITING_PROFILES) as EditingProfileId[];
  const VALID_CROP_MODES: CropFocusMode[] = [
    'auto-speaker',
    'center',
    'left-subject',
    'right-subject',
    'fit-blur',
  ];
  const VALID_SUBTITLE_STYLES: SubtitleStylePreset[] = [
    'karaoke-pop',
    'bold-highlight',
    'clean',
    'minimal-caption',
  ];

  // Extract dense visual keyframes (every ~6-10s per source, up to 6 per clip) so AI knows exact timestamps of visual moments & products
  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
  const tmpFramesDir = resolveSafePath(
    PROJECTS_DIR,
    projectId,
    'renders',
    `remix_frames_${Date.now()}`
  );
  fs.mkdirSync(tmpFramesDir, { recursive: true });

  const sampledFrameSummary: string[] = [];
  try {
    for (const src of sources) {
      const dur = src.metadata?.duration ?? 30;
      const count = Math.min(5, Math.max(3, Math.floor(dur / 10)));
      for (let i = 0; i < count; i++) {
        const ts = Number(Math.max(0.3, Math.min(dur - 0.3, ((i + 0.5) / count) * dur)).toFixed(2));
        const framePath = path.join(tmpFramesDir, `src${src.index}_f${i}.jpg`);
        try {
          if (src.sourcePath && fs.existsSync(src.sourcePath)) {
            await execFileAsync(
              'ffmpeg',
              [
                '-y',
                '-nostats',
                '-loglevel',
                'error',
                '-ss',
                String(ts),
                '-i',
                src.sourcePath,
                '-frames:v',
                '1',
                '-vf',
                'scale=360:-2',
                '-q:v',
                '5',
                framePath,
              ],
              { maxBuffer: 2 * 1024 * 1024 }
            );
          }
          if (fs.existsSync(framePath)) {
            parts.push({
              text: `Frame from Source #${src.index} ("${src.filename}") at ${ts.toFixed(1)}s:`,
            });
            parts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: fs.readFileSync(framePath).toString('base64'),
              },
            });
            sampledFrameSummary.push(`Source #${src.index} @ ${ts.toFixed(1)}s`);
          }
        } catch {
          // Best-effort frame extraction
        }
      }
    }

    // Fallback to pre-extracted project scenes if live extraction returned nothing
    if (sampledFrameSummary.length === 0 && scenes.length > 0) {
      const scenesDir = resolveSafePath(PROJECTS_DIR, projectId, 'scenes');
      for (const sc of scenes.slice(0, 10)) {
        const fn = sc.thumbnailUrl.split('/').pop();
        if (!fn) continue;
        const p = resolveSafePath(scenesDir, fn);
        if (fs.existsSync(p)) {
          parts.push({
            text: `Frame from Source #${sc.sourceIndex ?? 0} (${sc.sourceFilename || 'clip'}) at ${sc.timestamp.toFixed(1)}s:`,
          });
          parts.push({
            inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(p).toString('base64') },
          });
        }
      }
    }

    const sourceDetailsText = sources
      .map((src) => {
        const dur = src.metadata?.duration ?? 0;
        const lines = (src.transcript ?? []).map(
          (t) => `[${t.start.toFixed(2)}s -> ${t.end.toFixed(2)}s] (${t.speaker}): ${t.text}`
        );
        return `=== SOURCE #${src.index}: "${src.filename}" | Duration: ${dur.toFixed(2)}s | Resolution: ${
          src.metadata?.width ?? 0
        }x${src.metadata?.height ?? 0} ===\n${
          lines.join('\n') || '(No spoken dialogue in this source — use visual frame timestamps above)'
        }`;
      })
      .join('\n\n');

    const minTotal = Math.max(12, Math.min(20, settings.minClipDuration || 15));
    const maxTotal = Math.max(minTotal + 10, Math.min(55, settings.maxClipDuration || 45));

    const sourceSpeechIntervals = new Map<number, Array<{ start: number; end: number }>>();
    for (const src of sources) {
      const audioTarget =
        src.audioPath && fs.existsSync(src.audioPath)
          ? src.audioPath
          : src.sourcePath && fs.existsSync(src.sourcePath)
          ? src.sourcePath
          : null;
      if (audioTarget && src.metadata?.hasAudio !== false) {
        const dur = src.metadata?.duration ?? 60;
        sourceSpeechIntervals.set(src.index, await detectSpeechIntervals(audioTarget, dur));
      } else {
        sourceSpeechIntervals.set(src.index, []);
      }
    }

    parts.push({
      text: `You are the Senior Viral Short-Form Remix Director & Brand Campaign Editor.
You have ${sources.length} raw source video files. Your job is to MIX AND MATCH cuts ACROSS these source videos to produce 5 to 7 distinct, high-retention, scroll-stopping vertical (9:16) viral videos ready for TikTok, Instagram Reels, and YouTube Shorts.

Project Title: "${title}"
Detected Language: ${analysis.detectedLanguage} (${analysis.languageCode})
Primary Category: ${category.name}
${briefBlock}
CRITICAL REMIX & COMPLIANCE RULES:
1. NO RAW REPOSTS: NEVER output a single uncut segment from 1 video. EVERY generated video MUST be a curated montage of 2 to 5 fast-paced cuts ("segments"), actively mixing moments across multiple source videos (e.g., grab an exciting visual/verbal Hook from Source #1 or #2, cut to Product/Action from Source #0, finish with the funniest/sweetest Payoff reaction from Source #2).
2. STRICT CONSIGNE COMPLIANCE: Read every rule in USER CONSIGNE carefully. If the brief requires showing a specific product/person on screen in every clip, verify against the attached frames and include a segment where it is clearly visible! Never include banned topics or altered voice speeds.
3. VARIED PRO EDITING STYLES, MUSIC & TRANSITIONS: Give each generated video a DIFFERENT narrative angle, punchy hookHeadline (3–6 words), and VARIED creative direction:
   - editingProfile: mix "${VALID_PROFILES.join('", "')}"
   - subtitleStyle: mix "karaoke-pop", "bold-highlight", "clean" with high-contrast #RRGGBB highlightColor
   - bgmVibe: choose from "upbeat-pop", "lofi-warm", "hype-beat", "cinematic-warm", or "none" (use "none" ONLY if brief forbids music or pure ASMR/raw speech fits best; otherwise match the mood, e.g. "upbeat-pop" for fun/holiday/gifts, "cinematic-warm" for sweet emotional family reveals, "hype-beat" for fast energetic hooks!)
   - transitionStyle: mix "whip-slide", "zoom-punch", "dissolve", "flash-cut", "hard-cut"
   - cameraEnergy: mix "dynamic" (smooth zoom-in/zoom-out + hook pop), "viral-shake" (impact vibration + fast punches), "calm" (gentle cinematic motion)
   - sfxMode: choose from "playful-viral", "dramatic-impact", "smart-ui", "subtle-clean", or "none" (use "none" ONLY if brief explicitly bans sound effects; otherwise tailor to the clip vibe!)
   - hookSfx & per-segment sfxCue: creatively match sound effects to each scene & highlight type from ["mouse-click", "clever-ding", "shock-boom", "buzz-zap", "whoosh-swish", "pop-bubble", "cash-sparkle", "riser-hit", "none"]:
     * "buzz-zap" for mistakes, awkward/funny fails, tense warnings, or "oops" beats
     * "shock-boom" for jaw-dropping hooks, surprises, plot twists, or big reactions
     * "clever-ding" for smart tips, clever punchlines, "aha!" insights, or smooth reveals
     * "mouse-click" for on-screen text/UI pops, quick steps, or cursor/demo beats
     * "cash-sparkle" or "pop-bubble" for gifts, cute/sweet moments, product reveals, or wins
     * "whoosh-swish" or "riser-hit" for fast transitions or suspense build-ups
      * IMPORTANT: NEVER assign the exact same sfxCue twice in a row on consecutive segments (avoid repetitive SFX)!
   - COVER THUMBNAIL DIRECTION (attractive vertical cover matching this specific highlight & video vibe):
     * thumbnailText: 2 to 4 ultra-punchy scroll-stopping cover words in ${analysis.detectedLanguage} (e.g., "SAINT NIC TAX", "HUGE KITSCH DROP", "WAIT WHO IS IT?")
     * thumbnailEmojis: array of 2 to 3 expressive emojis that fit the exact moment & emotion (e.g., ["🎅", "😭", "🎁"] or ["✨", "💖", "🔥"])
     * thumbnailStyle: choose best cover vibe from ["viral-pop", "lifestyle-warm", "cinematic-editorial", "comedy-sticker", "tech-neon", "podcast-quote"] matching this clip & brand vibe
     * thumbnailSegmentIndex: 0-based index into your segments array showing the clearest hero face/product/action frame for the cover
4. EXACT SOURCE TIMESTAMPS: For every segment in a remix video, sourceIndex MUST be between 0 and ${sources.length - 1}, and startTime/endTime MUST stay strictly inside that source's exact duration, with each cut >= 2.2s and total assembled duration around ${minTotal}s-${maxTotal}s.
5. COMPLETE SPOKEN THOUGHTS: When a segment contains dialogue, start and end on natural phrase boundaries so sentences NEVER cut mid-word.
6. SAME-LANGUAGE METADATA: Write hookHeadline, title, thumbnailText, and description in ${analysis.detectedLanguage}.

Source Footage & Transcripts:
${sourceDetailsText}`,
    });

    const resp = await withModelFallback(
      ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
      (model) =>
        ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                remixVideos: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      hookHeadline: { type: Type.STRING },
                      description: { type: Type.STRING },
                      secondaryCategoryName: { type: Type.STRING },
                      selectionExplanation: { type: Type.STRING },
                      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
                      editingProfile: { type: Type.STRING },
                      cropMode: { type: Type.STRING },
                      subtitleStyle: { type: Type.STRING },
                      highlightColor: { type: Type.STRING },
                      dynamicZoom: { type: Type.BOOLEAN },
                      bgmVibe: { type: Type.STRING },
                      transitionStyle: { type: Type.STRING },
                      cameraEnergy: { type: Type.STRING },
                      sfxMode: { type: Type.STRING },
                      hookSfx: { type: Type.STRING },
                      thumbnailText: { type: Type.STRING },
                      thumbnailEmojis: { type: Type.ARRAY, items: { type: Type.STRING } },
                      thumbnailStyle: { type: Type.STRING },
                      thumbnailSegmentIndex: { type: Type.INTEGER },
                      segments: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            sourceIndex: { type: Type.INTEGER },
                            startTime: { type: Type.NUMBER },
                            endTime: { type: Type.NUMBER },
                            role: { type: Type.STRING },
                            visualNote: { type: Type.STRING },
                            sfxCue: { type: Type.STRING },
                          },
                          required: ['sourceIndex', 'startTime', 'endTime', 'role'],
                        },
                      },
                      scores: {
                        type: Type.OBJECT,
                        properties: {
                          hookStrength: { type: Type.NUMBER },
                          standaloneContext: { type: Type.NUMBER },
                          audienceInterest: { type: Type.NUMBER },
                          emotionalOrInfoValue: { type: Type.NUMBER },
                          contentCompleteness: { type: Type.NUMBER },
                          audioVisualQuality: { type: Type.NUMBER },
                        },
                        required: [
                          'hookStrength',
                          'standaloneContext',
                          'audienceInterest',
                          'emotionalOrInfoValue',
                          'contentCompleteness',
                          'audioVisualQuality',
                        ],
                      },
                    },
                    required: [
                      'title',
                      'hookHeadline',
                      'description',
                      'selectionExplanation',
                      'keywords',
                      'editingProfile',
                      'cropMode',
                      'subtitleStyle',
                      'highlightColor',
                      'dynamicZoom',
                      'thumbnailText',
                      'thumbnailEmojis',
                      'thumbnailStyle',
                      'segments',
                      'scores',
                    ],
                  },
                },
              },
              required: ['remixVideos'],
            },
          },
        }),
      'multi-video-remix-director'
    );

    const parsed = JSON.parse((resp.text ?? '{}').trim()) as {
      remixVideos?: Array<{
        title: string;
        hookHeadline?: string;
        description: string;
        secondaryCategoryName?: string;
        selectionExplanation: string;
        keywords?: string[];
        editingProfile?: string;
        cropMode?: string;
        subtitleStyle?: string;
        highlightColor?: string;
        dynamicZoom?: boolean;
        bgmVibe?: string;
        transitionStyle?: string;
        cameraEnergy?: string;
        sfxMode?: string;
        hookSfx?: string;
        thumbnailText?: string;
        thumbnailEmojis?: string[];
        thumbnailStyle?: string;
        thumbnailSegmentIndex?: number;
        segments?: Array<{
          sourceIndex: number;
          startTime: number;
          endTime: number;
          role: string;
          visualNote?: string;
          sfxCue?: string;
        }>;
        scores: Omit<HighlightScoreBreakdown, 'totalScore'>;
      }>;
    };

    const VALID_ROLES = new Set(['hook', 'story', 'product', 'payoff', 'cutaway']);
    const VALID_BGM_VIBES = new Set<BgmVibe>(['auto', 'none', 'upbeat-pop', 'lofi-warm', 'hype-beat', 'cinematic-warm']);
    const VALID_TRANSITIONS = new Set<TransitionStyle>(['auto', 'whip-slide', 'zoom-punch', 'dissolve', 'flash-cut', 'hard-cut']);
    const VALID_ENERGIES = new Set<CameraEnergy>(['auto', 'calm', 'dynamic', 'viral-shake']);
    const VALID_SFX_MODES = new Set<SfxMode>(['auto', 'none', 'playful-viral', 'dramatic-impact', 'smart-ui', 'subtle-clean']);
    const VALID_SFX_CUES = new Set<SfxCueType | 'none'>([
      'mouse-click',
      'clever-ding',
      'shock-boom',
      'buzz-zap',
      'whoosh-swish',
      'pop-bubble',
      'cash-sparkle',
      'riser-hit',
      'none',
    ]);

    const fallbackPalette = ['#FACC15', '#38BDF8', '#FB7185', '#22C55E', '#A78BFA', '#F97316'];
    const fallbackProfiles: EditingProfileId[] = ['Dynamic', 'Comedy', 'Cinematic', 'Podcast', 'Travel'];
    const fallbackSubs: SubtitleStylePreset[] = ['karaoke-pop', 'bold-highlight', 'clean', 'karaoke-pop'];
    const fallbackBgms: BgmVibe[] = ['upbeat-pop', 'hype-beat', 'cinematic-warm', 'lofi-warm', 'upbeat-pop'];
    const fallbackTransitions: TransitionStyle[] = ['whip-slide', 'zoom-punch', 'dissolve', 'flash-cut', 'whip-slide'];
    const fallbackEnergies: CameraEnergy[] = ['viral-shake', 'dynamic', 'calm', 'dynamic', 'viral-shake'];
    const fallbackSfxModes: SfxMode[] = ['playful-viral', 'dramatic-impact', 'smart-ui', 'subtle-clean', 'playful-viral'];
    const fallbackHookSfx: Array<SfxCueType> = ['shock-boom', 'clever-ding', 'pop-bubble', 'mouse-click', 'cash-sparkle'];

    const results: HighlightRecord[] = [];
    const rawRemixes = Array.isArray(parsed.remixVideos) ? parsed.remixVideos : [];

    for (let rIdx = 0; rIdx < rawRemixes.length; rIdx++) {
      const item = rawRemixes[rIdx];
      const rawSegs = Array.isArray(item.segments) ? item.segments : [];
      const cleanSegs: RemixSegment[] = [];

      for (const seg of rawSegs) {
        const srcIdx = Math.max(0, Math.min(sources.length - 1, Math.round(Number(seg.sourceIndex) || 0)));
        const src = sources[srcIdx];
        const srcDur = Math.max(4, src.metadata?.duration ?? 30);
        let sStart = Math.max(0, Math.min(srcDur - 2, Number(seg.startTime) || 0));
        let sEnd = Math.min(srcDur, Math.max(sStart + 2, Number(seg.endTime) || sStart + 5));

        // Step A: Protect spoken words using transcript lines so no sentence gets sliced mid-word
        const srcTranscript = src.transcript ?? [];
        if (srcTranscript.length > 0) {
          const overlappingStart = srcTranscript.find((t) => sStart > t.start && sStart < t.end);
          if (overlappingStart && sStart - overlappingStart.start <= 2.4) {
            sStart = Math.max(0, overlappingStart.start - 0.16);
          } else {
            const nearStart = srcTranscript.find((t) => Math.abs(t.start - sStart) <= 0.75);
            if (nearStart) sStart = Math.max(0, nearStart.start - 0.16);
          }

          const overlappingEnd = [...srcTranscript].reverse().find((t) => sEnd > t.start && sEnd < t.end);
          if (overlappingEnd && overlappingEnd.end - sEnd <= 2.8) {
            sEnd = Math.min(srcDur, overlappingEnd.end + 0.30);
          } else {
            const nearEnd = [...srcTranscript].reverse().find((t) => Math.abs(t.end - sEnd) <= 0.85);
            if (nearEnd && nearEnd.end > sStart + 1.8) sEnd = Math.min(srcDur, nearEnd.end + 0.30);
          }
        }

        // Step B: Polish against real FFmpeg acoustic speech intervals so word attack/release is never clipped
        const speechIvs = sourceSpeechIntervals.get(srcIdx) ?? [];
        if (speechIvs.length > 0) {
          const hitStart = speechIvs.find((iv) => sStart > iv.start && sStart < iv.end);
          if (hitStart && sStart - hitStart.start <= 2.0) {
            sStart = Math.max(0, hitStart.start - 0.16);
          }
          const hitEnd = [...speechIvs].reverse().find((iv) => sEnd > iv.start && sEnd < iv.end);
          if (hitEnd && hitEnd.end - sEnd <= 2.2) {
            sEnd = Math.min(srcDur, hitEnd.end + 0.30);
          }
        }

        if (sEnd - sStart < 1.8) continue;
        const role = VALID_ROLES.has(String(seg.role).toLowerCase())
          ? (String(seg.role).toLowerCase() as RemixSegment['role'])
          : cleanSegs.length === 0
          ? 'hook'
          : 'story';

        const rawCue = String(seg.sfxCue || '').trim() as SfxCueType | 'none';
        let cleanCue: SfxCueType | 'none' | undefined = VALID_SFX_CUES.has(rawCue)
          ? rawCue
          : undefined;
        const prevSegCue = cleanSegs.length > 0 ? cleanSegs[cleanSegs.length - 1].sfxCue : undefined;
        if (cleanCue && cleanCue !== 'none' && cleanCue === prevSegCue) {
          cleanCue = undefined; // Let scene-aware anti-repeat scheduler pick a fresh complementary SFX
        }

        cleanSegs.push({
          id: `seg_${rIdx}_${cleanSegs.length + 1}`,
          sourceIndex: srcIdx,
          sourceFilename: src.filename,
          startTime: Number(sStart.toFixed(2)),
          endTime: Number(sEnd.toFixed(2)),
          role,
          visualNote: seg.visualNote?.trim() || undefined,
          ...(cleanCue ? { sfxCue: cleanCue } : {}),
        });
      }

      if (cleanSegs.length === 0) continue;

      // Guarantee no raw single-source full-length repost: if model emitted only 1 segment, add a short reaction/product cut from another source
      if (cleanSegs.length === 1 && sources.length > 1) {
        const otherIdx = (cleanSegs[0].sourceIndex + 1) % sources.length;
        const otherSrc = sources[otherIdx];
        const otherDur = otherSrc.metadata?.duration ?? 15;
        const cutStart = Number(Math.min(Math.max(0, otherDur - 5), otherDur * 0.35).toFixed(2));
        const cutEnd = Number(Math.min(otherDur, cutStart + 4.5).toFixed(2));
        if (cutEnd - cutStart >= 2) {
          cleanSegs.push({
            id: `seg_${rIdx}_extra`,
            sourceIndex: otherIdx,
            sourceFilename: otherSrc.filename,
            startTime: cutStart,
            endTime: cutEnd,
            role: 'payoff',
            visualNote: 'Cross-clip payoff cut',
          });
        }
      }

      const totalDur = Number(
        cleanSegs.reduce((acc, s) => acc + Math.max(1, s.endTime - s.startTime), 0).toFixed(2)
      );
      if (totalDur < 4) continue;

      const breakdown = computeWeightedScore(item.scores, category);
      const chosenProfile: EditingProfileId = VALID_PROFILES.includes(
        item.editingProfile as EditingProfileId
      )
        ? (item.editingProfile as EditingProfileId)
        : fallbackProfiles[rIdx % fallbackProfiles.length] ?? profileSpec.id;
      const chosenCrop: CropFocusMode = VALID_CROP_MODES.includes(item.cropMode as CropFocusMode)
        ? (item.cropMode as CropFocusMode)
        : EDITING_PROFILES[chosenProfile].cropMode;
      const chosenSub: SubtitleStylePreset = VALID_SUBTITLE_STYLES.includes(
        item.subtitleStyle as SubtitleStylePreset
      )
        ? (item.subtitleStyle as SubtitleStylePreset)
        : fallbackSubs[rIdx % fallbackSubs.length];
      const chosenColor =
        typeof item.highlightColor === 'string' &&
        /^#[0-9a-fA-F]{6}$/.test(item.highlightColor.trim())
          ? item.highlightColor.trim().toUpperCase()
          : fallbackPalette[rIdx % fallbackPalette.length];
      const chosenZoom =
        chosenCrop === 'fit-blur'
          ? false
          : typeof item.dynamicZoom === 'boolean'
          ? item.dynamicZoom
          : EDITING_PROFILES[chosenProfile].allowDynamicZoom;
      const chosenBgm: BgmVibe = VALID_BGM_VIBES.has(item.bgmVibe as BgmVibe)
        ? (item.bgmVibe as BgmVibe)
        : fallbackBgms[rIdx % fallbackBgms.length];
      const chosenTransition: TransitionStyle = VALID_TRANSITIONS.has(item.transitionStyle as TransitionStyle)
        ? (item.transitionStyle as TransitionStyle)
        : fallbackTransitions[rIdx % fallbackTransitions.length];
      const chosenEnergy: CameraEnergy = VALID_ENERGIES.has(item.cameraEnergy as CameraEnergy)
        ? (item.cameraEnergy as CameraEnergy)
        : fallbackEnergies[rIdx % fallbackEnergies.length];
      const chosenSfxMode: SfxMode = VALID_SFX_MODES.has(item.sfxMode as SfxMode)
        ? (item.sfxMode as SfxMode)
        : fallbackSfxModes[rIdx % fallbackSfxModes.length];
      const rawHookSfx = String(item.hookSfx || '').trim() as SfxCueType | 'auto' | 'none';
      const chosenHookSfx: HighlightRecord['hookSfx'] =
        rawHookSfx === 'auto' || VALID_SFX_CUES.has(rawHookSfx)
          ? rawHookSfx
          : fallbackHookSfx[rIdx % fallbackHookSfx.length];

      const cleanTitle = (item.title || `Viral Remix #${rIdx + 1}`).trim();
      const cleanHook =
        (item.hookHeadline || '').trim() || cleanTitle.split(/\s+/).slice(0, 5).join(' ');

      if (typeof item.thumbnailSegmentIndex === 'number' && cleanSegs.length > 0) {
        const tIdx = Math.max(0, Math.min(cleanSegs.length - 1, Math.round(item.thumbnailSegmentIndex)));
        cleanSegs[tIdx] = { ...cleanSegs[tIdx], isThumbnailFrame: true };
      }

      const rawThumbStyle = String(item.thumbnailStyle || '').trim() as Exclude<ThumbnailVibeStyle, 'auto'>;
      const chosenThumbStyle: Exclude<ThumbnailVibeStyle, 'auto'> = VALID_THUMBNAIL_STYLES.includes(rawThumbStyle)
        ? rawThumbStyle
        : resolveThumbnailStyle(
            {
              thumbnailStyle: 'auto',
              editingProfile: chosenProfile,
              categoryId: category.id,
              categoryName: category.name,
              bgmVibe: chosenBgm,
              sfxMode: chosenSfxMode,
              title: cleanTitle,
              description: (item.description || '').trim(),
            },
            brief
          );

      const fallbackThumbCopy = deriveFallbackThumbnailCopy(
        {
          thumbnailText: item.thumbnailText,
          thumbnailEmojis: splitGraphemeEmojis(item.thumbnailEmojis),
          hookHeadline: cleanHook,
          title: cleanTitle,
          description: (item.description || '').trim(),
          categoryName: category.name,
          keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 6) : [],
        },
        chosenThumbStyle,
        brief
      );

      results.push({
        id: `hl_${crypto.randomUUID().slice(0, 8)}`,
        projectId,
        startTime: 0,
        endTime: totalDur,
        duration: totalDur,
        title: cleanTitle,
        hookHeadline: cleanHook,
        description: (item.description || '').trim(),
        categoryId: category.id,
        categoryName: category.name,
        secondaryCategoryName: item.secondaryCategoryName?.trim() || null,
        selectionExplanation: (item.selectionExplanation || 'Cross-clip viral remix montage').trim(),
        keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 6) : [],
        criteriaBreakdown: breakdown,
        status: breakdown.totalScore >= 75 || results.length < 3 ? 'selected' : 'candidate',
        editingProfile: chosenProfile,
        subtitleStyle: chosenSub,
        highlightColor: chosenColor,
        cropMode: chosenCrop,
        dynamicZoom: chosenZoom,
        normalizeAudio: EDITING_PROFILES[chosenProfile]?.normalizeAudio ?? profileSpec.normalizeAudio,
        watermarkEnabled: settings.enableWatermarkByDefault,
        renderedVideoUrl: null,
        qcReport: null,
        editSegments: cleanSegs,
        bgmVibe: chosenBgm,
        transitionStyle: chosenTransition,
        cameraEnergy: chosenEnergy,
        sfxMode: chosenSfxMode,
        hookSfx: chosenHookSfx,
        thumbnailText: fallbackThumbCopy.text,
        thumbnailEmojis: fallbackThumbCopy.emojis,
        thumbnailStyle: chosenThumbStyle,
      });
    }

    results.sort((a, b) => b.criteriaBreakdown.totalScore - a.criteriaBreakdown.totalScore);
    return results;
  } finally {
    if (fs.existsSync(tmpFramesDir)) {
      fs.rmSync(tmpFramesDir, { recursive: true, force: true });
    }
  }
}

export async function generateAndScoreHighlights(params: {
  projectId: string;
  title: string;
  brief?: string;
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  analysis: ContentAnalysis;
  settings: StudioSettings;
  sourcePath?: string;
  sources?: ProjectSourceVideo[];
  scenes?: SceneKeyframe[];
}): Promise<HighlightRecord[]> {
  const { projectId, title, brief, metadata, transcript, analysis, settings, sourcePath, sources, scenes } = params;

  if (sources && sources.length > 1) {
    const remixes = await generateMultiSourceRemixHighlights({
      projectId,
      title,
      brief,
      sources,
      scenes: scenes ?? [],
      analysis,
      settings,
    });
    if (remixes.length > 0) {
      return remixes;
    }
  }
  const cleanBrief = brief?.trim() || '';
  const briefBlock = cleanBrief
    ? `\nUSER CONSIGNE / CREATIVE BRIEF (HIGH PRIORITY — follow strictly when picking moments, tone, and length):\n"""\n${cleanBrief}\n"""\n${
        analysis.briefInterpretation
          ? `AI Creative Plan from Brief: ${analysis.briefInterpretation}\n`
          : ''
      }`
    : analysis.briefInterpretation
    ? `\nAI Creative Plan: ${analysis.briefInterpretation}\n`
    : '';
  const category = findCategoryByIdOrName(analysis.primaryCategoryId, settings.customCategories);
  const profileSpec =
    EDITING_PROFILES[analysis.recommendedProfile] ?? EDITING_PROFILES[category.defaultEditingProfile];
  const ai = getGeminiClient();

  const duration = metadata.duration;
  const effectiveMin = Math.min(settings.minClipDuration, Math.max(3, duration * 0.25));
  const effectiveMax = Math.min(settings.maxClipDuration, duration);

  const formattedLines = transcript.map(
    (s) => `[${s.start.toFixed(2)}s -> ${s.end.toFixed(2)}s] (${s.speaker}): ${s.text}`
  );

  // Split ultra-long transcripts (e.g. 3+ hour videos) into overlapping ~90k-char chronological windows
  // so highlights crossing a chunk edge are never broken in half.
  const windows: Array<{ text: string; startSec: number; endSec: number }> = [];
  if (formattedLines.length === 0) {
    windows.push({ text: '', startSec: 0, endSec: duration });
  } else {
    let idx = 0;
    while (idx < formattedLines.length) {
      let charCount = 0;
      const startIdx = idx;
      let endIdx = idx;
      while (endIdx < formattedLines.length) {
        const lineLen = formattedLines[endIdx].length + 1;
        if (charCount + lineLen > 90000 && endIdx > startIdx) break;
        charCount += lineLen;
        endIdx++;
      }
      windows.push({
        text: formattedLines.slice(startIdx, endIdx).join('\n'),
        startSec: transcript[startIdx].start,
        endSec: transcript[endIdx - 1].end,
      });
      if (endIdx >= formattedLines.length) break;
      // Overlap last 5 segments into the next window for continuous boundary context
      idx = Math.max(startIdx + 1, endIdx - 5);
    }
  }

  const perWindowTarget =
    windows.length > 1 ? '3 to 5' : duration >= 3600 ? '5 to 8' : '3 to 6';

  type RawCandidate = {
    startTime: number;
    endTime: number;
    exactStartPhrase?: string;
    exactEndPhrase?: string;
    title: string;
    description: string;
    secondaryCategoryName?: string;
    selectionExplanation: string;
    keywords: string[];
    scores: Omit<HighlightScoreBreakdown, 'totalScore'>;
  };

  const pass1Candidates: RawCandidate[] = [];

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const win = windows[wIdx];
    const windowNote =
      windows.length > 1
        ? `Transcript Section ${wIdx + 1} of ${windows.length} (${win.startSec.toFixed(0)}s – ${win.endSec.toFixed(0)}s):`
        : 'Transcript:';

    const prompt = `You are the Senior Short-Form Highlight Director & Virality Analyst (>95% Precision Mode).
Video Title: "${title}"
Total Duration: ${duration.toFixed(2)}s
Detected Language: ${analysis.detectedLanguage} (${analysis.languageCode})
Primary Category: ${category.name}
Secondary Categories: ${analysis.secondaryCategories.map((c) => c.categoryName).join(', ') || 'None'}
Key Topics: ${analysis.mainTopics.join(', ') || 'General'}
Emotional & Narrative Arc: ${analysis.emotionalArc}
${briefBlock}
Category-Specific Selection Strategy (${category.name}):
${category.highlightStrategy}

Target Clip Duration Window:
- For videos over 25s, select cohesive, complete-arc clips strictly between ${effectiveMin.toFixed(0)}s and ${effectiveMax.toFixed(0)}s.
- For short source videos (<30s), pick the strongest 1-3 self-contained segments (>=4s).

HIGH-ACCURACY EDITORIAL GATES (MUST PASS ALL):
1. ZERO DANGLING OPENINGS: The very first sentence MUST grab attention cold without relying on earlier context (avoid clips starting with "And so...", "That's why...", "Like I said...", or unanswered pronouns).
2. COMPLETE PAYOFF ARC: Every clip MUST contain Hook -> Core Insight/Story -> Satisfying Resolution/Punchline. Never end mid-thought or cut before the reaction/takeaway.
3. EXACT QUOTE ANCHORS: Provide exactStartPhrase (the verbatim first 5-8 words spoken at clip start) and exactEndPhrase (the verbatim last 5-8 words spoken at clip end) copied directly from the transcript so boundaries lock onto exact voice utterances.
4. HONEST RUBRIC SCORING (0-100 integers): Reserve 85+ ONLY for genuinely standout, scroll-stopping, standalone moments. Never inflate scores on filler or rambling transitions.
5. SAME-LANGUAGE METADATA: Write concise punchy hook titles (3-7 words) and descriptions in ${analysis.detectedLanguage}.
6. Propose ${perWindowTarget} distinct non-overlapping candidates from this section.

${windowNote}
${win.text}`;

    const response = await withModelFallback(
      ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
      (model) =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                candidates: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startTime: { type: Type.NUMBER },
                      endTime: { type: Type.NUMBER },
                      exactStartPhrase: {
                        type: Type.STRING,
                        description: 'Verbatim first 5-8 words spoken at start of highlight',
                      },
                      exactEndPhrase: {
                        type: Type.STRING,
                        description: 'Verbatim last 5-8 words spoken at end of highlight',
                      },
                      title: { type: Type.STRING },
                      description: { type: Type.STRING },
                      secondaryCategoryName: { type: Type.STRING },
                      selectionExplanation: { type: Type.STRING },
                      keywords: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      scores: {
                        type: Type.OBJECT,
                        properties: {
                          hookStrength: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                          standaloneContext: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                          audienceInterest: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                          emotionalOrInfoValue: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                          contentCompleteness: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                          audioVisualQuality: { type: Type.NUMBER, description: 'Integer 0 to 100' },
                        },
                        required: [
                          'hookStrength',
                          'standaloneContext',
                          'audienceInterest',
                          'emotionalOrInfoValue',
                          'contentCompleteness',
                          'audioVisualQuality',
                        ],
                      },
                    },
                    required: [
                      'startTime',
                      'endTime',
                      'exactStartPhrase',
                      'exactEndPhrase',
                      'title',
                      'description',
                      'selectionExplanation',
                      'keywords',
                      'scores',
                    ],
                  },
                },
              },
              required: ['candidates'],
            },
          },
        }),
      windows.length > 1 ? `highlight-discovery-part-${wIdx + 1}` : 'highlight-discovery'
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      candidates?: RawCandidate[];
    };
    if (Array.isArray(parsed.candidates)) {
      pass1Candidates.push(...parsed.candidates);
    }
  }

  // Deterministically snap Pass 1 candidates to verbatim transcript segments & deduplicate overlaps
  interface SnappedCandidate {
    cand: RawCandidate;
    startTime: number;
    endTime: number;
    startSegIdx: number;
    endSegIdx: number;
    breakdown: HighlightScoreBreakdown;
    excerptText: string;
  }

  const preRanked: SnappedCandidate[] = [];
  for (const cand of pass1Candidates) {
    const snapped = findQuoteMatchedSpan(
      cand.startTime,
      cand.endTime,
      cand.exactStartPhrase,
      cand.exactEndPhrase,
      transcript,
      duration,
      effectiveMin,
      effectiveMax
    );
    const clipDuration = Number((snapped.endTime - snapped.startTime).toFixed(2));
    if (clipDuration < 3) continue;

    const breakdown = computeWeightedScore(cand.scores, category);
    const excerptSegs =
      snapped.startSegIdx >= 0 && snapped.endSegIdx >= snapped.startSegIdx
        ? transcript.slice(
            Math.max(0, snapped.startSegIdx - 1),
            Math.min(transcript.length, snapped.endSegIdx + 2)
          )
        : transcript.filter((s) => s.end > snapped.startTime && s.start < snapped.endTime);

    const excerptText = excerptSegs
      .map(
        (s, idx) =>
          `[${s.start.toFixed(2)}s-${s.end.toFixed(2)}s]${
            snapped.startSegIdx >= 0 && idx + Math.max(0, snapped.startSegIdx - 1) === snapped.startSegIdx
              ? ' <CLIP_START>'
              : ''
          } (${s.speaker}): ${s.text}${
            snapped.endSegIdx >= 0 && idx + Math.max(0, snapped.startSegIdx - 1) === snapped.endSegIdx
              ? ' <CLIP_END>'
              : ''
          }`
      )
      .join('\n');

    preRanked.push({
      cand,
      startTime: snapped.startTime,
      endTime: snapped.endTime,
      startSegIdx: snapped.startSegIdx,
      endSegIdx: snapped.endSegIdx,
      breakdown,
      excerptText,
    });
  }

  preRanked.sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);

  const dedupedPass1: SnappedCandidate[] = [];
  for (const item of preRanked) {
    const dur = item.endTime - item.startTime;
    const overlaps = dedupedPass1.some((kept) => {
      const keptDur = kept.endTime - kept.startTime;
      const inter = Math.max(
        0,
        Math.min(kept.endTime, item.endTime) - Math.max(kept.startTime, item.startTime)
      );
      return inter / Math.min(keptDur, dur) > 0.35;
    });
    if (!overlaps) {
      dedupedPass1.push(item);
    }
    if (dedupedPass1.length >= 12) break;
  }

  const VALID_PROFILES = Object.keys(EDITING_PROFILES) as EditingProfileId[];
  const VALID_CROP_MODES: CropFocusMode[] = [
    'auto-speaker',
    'center',
    'left-subject',
    'right-subject',
    'fit-blur',
  ];
  const VALID_SUBTITLE_STYLES: SubtitleStylePreset[] = [
    'karaoke-pop',
    'bold-highlight',
    'clean',
    'minimal-caption',
  ];

  // Pass 2: Multimodal Precision Critic & Viral Art Director (inspects actual video frames + transcript per clip)
  interface VerifiedCandidateItem {
    item: SnappedCandidate;
    keep: boolean;
    title: string;
    hookHeadline: string;
    selectionExplanation: string;
    breakdown: HighlightScoreBreakdown;
    startTime: number;
    endTime: number;
    editingProfile: EditingProfileId;
    cropMode: CropFocusMode;
    subtitleStyle: SubtitleStylePreset;
    highlightColor: string;
    dynamicZoom: boolean;
    sfxMode: SfxMode;
    hookSfx: HighlightRecord['hookSfx'];
    thumbnailText?: string;
    thumbnailEmojis?: string[];
    thumbnailStyle?: ThumbnailVibeStyle;
  }

  let verifiedItems: VerifiedCandidateItem[] = [];

  if (dedupedPass1.length > 0 && transcript.length > 0) {
    const tmpFramesDir = resolveSafePath(PROJECTS_DIR, projectId, 'renders', `critic_frames_${Date.now()}`);
    try {
      const criticParts: Array<
        { inlineData: { mimeType: string; data: string } } | { text: string }
      > = [];

      // Sample 1 lightweight frame per candidate clip so AI sees framing (slides vs 2 speakers vs off-center)
      if (sourcePath && fs.existsSync(sourcePath)) {
        fs.mkdirSync(tmpFramesDir, { recursive: true });
        await Promise.all(
          dedupedPass1.map(async (entry, idx) => {
            const midSec = Number(((entry.startTime + entry.endTime) / 2).toFixed(2));
            const framePath = path.join(tmpFramesDir, `cand_${idx}.jpg`);
            try {
              await execFileAsync(
                'ffmpeg',
                [
                  '-y',
                  '-nostats',
                  '-loglevel',
                  'error',
                  '-ss',
                  String(midSec),
                  '-i',
                  sourcePath,
                  '-frames:v',
                  '1',
                  '-vf',
                  'scale=384:-2',
                  '-q:v',
                  '5',
                  framePath,
                ],
                { maxBuffer: 2 * 1024 * 1024 }
              );
            } catch {
              // Best-effort visual sampling
            }
          })
        );

        for (let idx = 0; idx < dedupedPass1.length; idx++) {
          const framePath = path.join(tmpFramesDir, `cand_${idx}.jpg`);
          if (fs.existsSync(framePath)) {
            criticParts.push({ text: `Visual Frame for Candidate #${idx}:` });
            criticParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: fs.readFileSync(framePath).toString('base64'),
              },
            });
          }
        }
      }

      const reviewBlock = dedupedPass1
        .map(
          (entry, idx) =>
            `=== CANDIDATE #${idx} ===\nProposed Title: ${entry.cand.title}\nWindow: ${entry.startTime.toFixed(
              2
            )}s -> ${entry.endTime.toFixed(2)}s (${(entry.endTime - entry.startTime).toFixed(
              1
            )}s)\nPre-Score: ${entry.breakdown.totalScore}/100\nTranscript Context (+/-1 adjacent line included):\n${
              entry.excerptText
            }`
        )
        .join('\n\n');

      criticParts.push({
        text: `You are the Final Editorial Quality Critic AND Viral Short-Form Art Director.
Your goal: >95% highlight selection precision + tailored, high-retention 9:16 visual editing so each clip maximizes views on TikTok, Reels, and Shorts.

Video Title: "${title}" | Source Resolution: ${metadata.width}x${metadata.height} | Category: ${category.name} | Language: ${analysis.detectedLanguage}
Category Rubric Weights: Hook=${category.criteriaWeights.hookStrength}, Context=${category.criteriaWeights.standaloneContext}, Interest=${category.criteriaWeights.audienceInterest}, Value=${category.criteriaWeights.emotionalOrInfoValue}, Completeness=${category.criteriaWeights.contentCompleteness}.
${briefBlock}
For EVERY candidate index (0 to ${dedupedPass1.length - 1}), inspect BOTH its Visual Frame (if attached), the User Consigne (if provided), AND its Transcript Context:
1. BOUNDARIES & KEEP GATE: Verify <CLIP_START> opens with an immediate attention-grabbing hook (zero unresolved context) and <CLIP_END> delivers a complete payoff. If 1 adjacent line makes it cleaner while staying near ${effectiveMin.toFixed(0)}s-${effectiveMax.toFixed(0)}s, supply verbatim refinedStartPhrase / refinedEndPhrase. Set keep=false ONLY if genuinely weak/filler.
2. VIRAL TITLING & HOOK BANNER:
   - refinedTitle: engaging social title (4-8 words in ${analysis.detectedLanguage}).
   - hookHeadline: ultra-punchy 3-5 word on-screen banner headline in ${analysis.detectedLanguage} that sparks curiosity in <0.5s (e.g. "NEVER IGNORE THIS SIGN", "THE $100K PRICING SECRET").
3. PER-CLIP VISUAL FRAMING & EDITING DIRECTION (DO NOT blindly copy one preset to every clip — tailor each clip!):
   - editingProfile: choose best from [${VALID_PROFILES.join(', ')}] matching this specific clip's mood & content.
   - cropMode: choose accurately from [${VALID_CROP_MODES.join(', ')}]:
     * Use "fit-blur" if visual frame shows slides, text overlays, charts, code, UI demos, or critical wide action that cropping to 9:16 would cut off!
     * Use "auto-speaker" if 2+ speakers appear or it's an active podcast/interview exchange.
     * Use "left-subject" or "right-subject" if single main subject clearly sits off-center left/right.
     * Use "center" for centered speaker/action.
   - subtitleStyle: choose best from [${VALID_SUBTITLE_STYLES.join(', ')}] ("karaoke-pop" for high-energy/viral/comedy/gaming, "bold-highlight" for podcasts/motivation/debates, "clean" for cinematic/stories/travel, "minimal-caption" ONLY for dense text/tutorials where captions shouldn't cover visuals).
   - highlightColor: choose a high-contrast #RRGGBB hex accent that pops cleanly over that clip's frame & mood (e.g. #FACC15, #38BDF8, #F59E0B, #22C55E, #FB7185, #A78BFA).
   - dynamicZoom: true for engaging talking heads/stories/action to boost retention; false ONLY when screens/slides require crisp static readability.
   - sfxMode: choose from ["playful-viral", "dramatic-impact", "smart-ui", "subtle-clean", "none"] matching the clip's mood & brief ("none" only if brief forbids SFX).
   - hookSfx: pick the best opening sound effect from ["mouse-click", "clever-ding", "shock-boom", "buzz-zap", "whoosh-swish", "pop-bubble", "cash-sparkle", "riser-hit", "none"] (e.g. "shock-boom" for surprises, "clever-ding" for smart tips, "buzz-zap" for mistakes/tension, "mouse-click" for screens/UI, "cash-sparkle" for gifts/wins).
4. COVER THUMBNAIL DESIGN (attractive vertical cover tailored to this highlight & overall video vibe):
   - thumbnailText: 2 to 4 ultra-punchy cover words in ${analysis.detectedLanguage} that spark instant curiosity.
   - thumbnailEmojis: array of 2 to 3 expressive emojis matching the exact scene emotion & topic.
   - thumbnailStyle: choose best art-direction style from ["viral-pop", "lifestyle-warm", "cinematic-editorial", "comedy-sticker", "tech-neon", "podcast-quote"] matching this clip & overall video type.

${reviewBlock}`,
      });

      const criticResp = await withModelFallback(
        ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
        (model) =>
          ai.models.generateContent({
            model,
            contents: { parts: criticParts },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  reviews: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        candidateIndex: { type: Type.INTEGER },
                        keep: { type: Type.BOOLEAN },
                        refinedTitle: { type: Type.STRING },
                        hookHeadline: { type: Type.STRING },
                        refinedStartPhrase: { type: Type.STRING },
                        refinedEndPhrase: { type: Type.STRING },
                        critiqueNote: { type: Type.STRING },
                        editingProfile: { type: Type.STRING },
                        cropMode: { type: Type.STRING },
                        subtitleStyle: { type: Type.STRING },
                        highlightColor: { type: Type.STRING },
                        dynamicZoom: { type: Type.BOOLEAN },
                        sfxMode: { type: Type.STRING },
                        hookSfx: { type: Type.STRING },
                        thumbnailText: { type: Type.STRING },
                        thumbnailEmojis: { type: Type.ARRAY, items: { type: Type.STRING } },
                        thumbnailStyle: { type: Type.STRING },
                        scores: {
                          type: Type.OBJECT,
                          properties: {
                            hookStrength: { type: Type.NUMBER },
                            standaloneContext: { type: Type.NUMBER },
                            audienceInterest: { type: Type.NUMBER },
                            emotionalOrInfoValue: { type: Type.NUMBER },
                            contentCompleteness: { type: Type.NUMBER },
                            audioVisualQuality: { type: Type.NUMBER },
                          },
                          required: [
                            'hookStrength',
                            'standaloneContext',
                            'audienceInterest',
                            'emotionalOrInfoValue',
                            'contentCompleteness',
                            'audioVisualQuality',
                          ],
                        },
                      },
                      required: [
                        'candidateIndex',
                        'keep',
                        'refinedTitle',
                        'hookHeadline',
                        'critiqueNote',
                        'editingProfile',
                        'cropMode',
                        'subtitleStyle',
                        'highlightColor',
                        'dynamicZoom',
                        'thumbnailText',
                        'thumbnailEmojis',
                        'thumbnailStyle',
                        'scores',
                      ],
                    },
                  },
                },
                required: ['reviews'],
              },
            },
          }),
        'highlight-precision-critic'
      );

      const criticParsed = JSON.parse((criticResp.text ?? '{}').trim()) as {
        reviews?: Array<{
          candidateIndex: number;
          keep: boolean;
          refinedTitle: string;
          hookHeadline?: string;
          refinedStartPhrase?: string;
          refinedEndPhrase?: string;
          critiqueNote: string;
          editingProfile?: string;
          cropMode?: string;
          subtitleStyle?: string;
          highlightColor?: string;
          dynamicZoom?: boolean;
          sfxMode?: string;
          hookSfx?: string;
          thumbnailText?: string;
          thumbnailEmojis?: string[];
          thumbnailStyle?: string;
          scores: Omit<HighlightScoreBreakdown, 'totalScore'>;
        }>;
      };

      const VALID_CRITIC_SFX_MODES = new Set<SfxMode>(['auto', 'none', 'playful-viral', 'dramatic-impact', 'smart-ui', 'subtle-clean']);
      const VALID_CRITIC_SFX_CUES = new Set<SfxCueType | 'none'>([
        'mouse-click',
        'clever-ding',
        'shock-boom',
        'buzz-zap',
        'whoosh-swish',
        'pop-bubble',
        'cash-sparkle',
        'riser-hit',
        'none',
      ]);

      const reviewMap = new Map(
        (criticParsed.reviews ?? []).map((r) => [r.candidateIndex, r])
      );

      verifiedItems = dedupedPass1.map((item, idx) => {
        const rev = reviewMap.get(idx);
        if (!rev) {
          return {
            item,
            keep: true,
            title: item.cand.title.trim(),
            hookHeadline: item.cand.title.trim().split(/\s+/).slice(0, 5).join(' '),
            selectionExplanation: item.cand.selectionExplanation.trim(),
            breakdown: item.breakdown,
            startTime: item.startTime,
            endTime: item.endTime,
            editingProfile: profileSpec.id,
            cropMode: profileSpec.cropMode,
            subtitleStyle: profileSpec.subtitlePreset,
            highlightColor: profileSpec.highlightColorHex || settings.defaultHighlightColor,
            dynamicZoom: category.avoidEffects ? false : profileSpec.allowDynamicZoom,
            sfxMode: 'auto',
            hookSfx: 'auto',
          };
        }

        const reSnapped =
          rev.refinedStartPhrase || rev.refinedEndPhrase
            ? findQuoteMatchedSpan(
                item.startTime,
                item.endTime,
                rev.refinedStartPhrase || item.cand.exactStartPhrase,
                rev.refinedEndPhrase || item.cand.exactEndPhrase,
                transcript,
                duration,
                effectiveMin,
                effectiveMax
              )
            : { startTime: item.startTime, endTime: item.endTime };

        const chosenProfile: EditingProfileId = VALID_PROFILES.includes(
          rev.editingProfile as EditingProfileId
        )
          ? (rev.editingProfile as EditingProfileId)
          : profileSpec.id;
        const chosenCrop: CropFocusMode = VALID_CROP_MODES.includes(rev.cropMode as CropFocusMode)
          ? (rev.cropMode as CropFocusMode)
          : EDITING_PROFILES[chosenProfile].cropMode;
        const chosenSub: SubtitleStylePreset = VALID_SUBTITLE_STYLES.includes(
          rev.subtitleStyle as SubtitleStylePreset
        )
          ? (rev.subtitleStyle as SubtitleStylePreset)
          : EDITING_PROFILES[chosenProfile].subtitlePreset;
        const chosenColor =
          typeof rev.highlightColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(rev.highlightColor.trim())
            ? rev.highlightColor.trim().toUpperCase()
            : EDITING_PROFILES[chosenProfile].highlightColorHex || settings.defaultHighlightColor;
        const chosenZoom =
          chosenCrop === 'fit-blur'
            ? false
            : typeof rev.dynamicZoom === 'boolean'
            ? rev.dynamicZoom
            : EDITING_PROFILES[chosenProfile].allowDynamicZoom;

        const cleanTitle = (rev.refinedTitle || item.cand.title).trim();
        const cleanHook =
          (rev.hookHeadline || '').trim() || cleanTitle.split(/\s+/).slice(0, 5).join(' ');

        const chosenSfxMode: SfxMode = VALID_CRITIC_SFX_MODES.has(rev.sfxMode as SfxMode)
          ? (rev.sfxMode as SfxMode)
          : 'auto';
        const rawHookSfx = String(rev.hookSfx || '').trim() as SfxCueType | 'auto' | 'none';
        const chosenHookSfx: HighlightRecord['hookSfx'] =
          rawHookSfx === 'auto' || VALID_CRITIC_SFX_CUES.has(rawHookSfx) ? rawHookSfx : 'auto';

        const rawThumbStyle = String(rev.thumbnailStyle || '').trim() as Exclude<ThumbnailVibeStyle, 'auto'>;
        const chosenThumbStyle: Exclude<ThumbnailVibeStyle, 'auto'> = VALID_THUMBNAIL_STYLES.includes(
          rawThumbStyle
        )
          ? rawThumbStyle
          : resolveThumbnailStyle(
              {
                thumbnailStyle: 'auto',
                editingProfile: chosenProfile,
                categoryId: category.id,
                categoryName: category.name,
                bgmVibe: 'auto',
                sfxMode: chosenSfxMode,
                title: cleanTitle,
                description: item.cand.description.trim(),
              },
              brief
            );

        return {
          item,
          keep: Boolean(rev.keep),
          title: cleanTitle,
          hookHeadline: cleanHook,
          selectionExplanation: rev.critiqueNote
            ? `${rev.critiqueNote.trim()} (${item.cand.selectionExplanation.trim()})`
            : item.cand.selectionExplanation.trim(),
          breakdown: computeWeightedScore(rev.scores, category),
          startTime: reSnapped.startTime,
          endTime: reSnapped.endTime,
          editingProfile: chosenProfile,
          cropMode: chosenCrop,
          subtitleStyle: chosenSub,
          highlightColor: chosenColor,
          dynamicZoom: chosenZoom,
          sfxMode: chosenSfxMode,
          hookSfx: chosenHookSfx,
          thumbnailText: rev.thumbnailText?.trim() || undefined,
          thumbnailEmojis: splitGraphemeEmojis(rev.thumbnailEmojis),
          thumbnailStyle: chosenThumbStyle,
        };
      });
    } catch {
      console.log(
        '[HighlightAgent] Precision critic pass bypassed after retry limit; using verified quote-snapped Pass 1 highlights.'
      );
    } finally {
      if (fs.existsSync(tmpFramesDir)) {
        fs.rmSync(tmpFramesDir, { recursive: true, force: true });
      }
    }
  }

  if (verifiedItems.length === 0) {
    verifiedItems = dedupedPass1.map((item) => ({
      item,
      keep: true,
      title: item.cand.title.trim(),
      hookHeadline: item.cand.title.trim().split(/\s+/).slice(0, 5).join(' '),
      selectionExplanation: item.cand.selectionExplanation.trim(),
      breakdown: item.breakdown,
      startTime: item.startTime,
      endTime: item.endTime,
      editingProfile: profileSpec.id,
      cropMode: profileSpec.cropMode,
      subtitleStyle: profileSpec.subtitlePreset,
      highlightColor: profileSpec.highlightColorHex || settings.defaultHighlightColor,
      dynamicZoom: category.avoidEffects ? false : profileSpec.allowDynamicZoom,
      sfxMode: 'auto',
      hookSfx: 'auto',
    }));
  }

  // Keep verified items; if Critic pruned everything on a sparse video, retain top 2 by score
  const kept = verifiedItems.filter((v) => v.keep);
  const finalPool =
    kept.length > 0
      ? kept
      : [...verifiedItems].sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore).slice(0, 2);

  // Deduplicate once more after Critic boundary refinements and sort highest score first
  finalPool.sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);
  const results: HighlightRecord[] = [];
  const hasLocalAudio = Boolean(sourcePath && fs.existsSync(sourcePath) && metadata.hasAudio);

  for (const entry of finalPool) {
    let startTime = entry.startTime;
    let endTime = entry.endTime;
    const clipDuration = Number((endTime - startTime).toFixed(2));
    if (clipDuration < 3) continue;

    const isDuplicate = results.some((existing) => {
      const overlap = Math.max(
        0,
        Math.min(existing.endTime, endTime) - Math.max(existing.startTime, startTime)
      );
      return overlap / Math.min(existing.duration, clipDuration) > 0.35;
    });
    if (isDuplicate) continue;

    // Optional ultra-fast acoustic onset/offset polish for top candidates
    if (hasLocalAudio && sourcePath && results.length < 8) {
      const polished = await polishHighlightAcousticBounds({
        projectId,
        sourcePath,
        startTime,
        endTime,
        totalDuration: duration,
      });
      startTime = polished.startTime;
      endTime = polished.endTime;
    }

    const finalDuration = Number(Math.max(3, endTime - startTime).toFixed(2));
    const resolvedThumbStyle = resolveThumbnailStyle(
      {
        thumbnailStyle: entry.thumbnailStyle ?? 'auto',
        editingProfile: entry.editingProfile,
        categoryId: category.id,
        categoryName: category.name,
        bgmVibe: 'auto',
        sfxMode: entry.sfxMode,
        title: entry.title,
        description: entry.item.cand.description.trim(),
      },
      brief
    );
    const fallbackThumbCopy = deriveFallbackThumbnailCopy(
      {
        thumbnailText: entry.thumbnailText,
        thumbnailEmojis: entry.thumbnailEmojis,
        hookHeadline: entry.hookHeadline,
        title: entry.title,
        description: entry.item.cand.description.trim(),
        categoryName: category.name,
        keywords: Array.isArray(entry.item.cand.keywords) ? entry.item.cand.keywords.slice(0, 6) : [],
      },
      resolvedThumbStyle,
      brief
    );

    results.push({
      id: `hl_${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      startTime,
      endTime,
      duration: finalDuration,
      title: entry.title,
      hookHeadline: entry.hookHeadline,
      description: entry.item.cand.description.trim(),
      categoryId: category.id,
      categoryName: category.name,
      secondaryCategoryName: entry.item.cand.secondaryCategoryName?.trim() || null,
      selectionExplanation: entry.selectionExplanation,
      keywords: Array.isArray(entry.item.cand.keywords) ? entry.item.cand.keywords.slice(0, 6) : [],
      criteriaBreakdown: entry.breakdown,
      status: entry.breakdown.totalScore >= 75 ? 'selected' : 'candidate',
      editingProfile: entry.editingProfile,
      subtitleStyle: entry.subtitleStyle,
      highlightColor: entry.highlightColor,
      cropMode: entry.cropMode,
      dynamicZoom: entry.dynamicZoom,
      normalizeAudio: EDITING_PROFILES[entry.editingProfile]?.normalizeAudio ?? profileSpec.normalizeAudio,
      watermarkEnabled: settings.enableWatermarkByDefault,
      renderedVideoUrl: null,
      qcReport: null,
      sfxMode: entry.sfxMode,
      hookSfx: entry.hookSfx,
      thumbnailText: fallbackThumbCopy.text,
      thumbnailEmojis: fallbackThumbCopy.emojis,
      thumbnailStyle: resolvedThumbStyle,
    });
  }

  return results;
}
