import { ThinkingLevel, Type } from '@google/genai';
import crypto from 'crypto';
import type {
  CategoryConfig,
  ContentAnalysis,
  HighlightRecord,
  HighlightScoreBreakdown,
  StudioSettings,
  TranscriptSegment,
  VideoMetadata,
} from '../../types/studio';
import { EDITING_PROFILES, findCategoryByIdOrName } from '../categories';
import { getGeminiClient, withModelFallback } from '../geminiClient';

function snapToSentenceBoundaries(
  start: number,
  end: number,
  transcript: TranscriptSegment[],
  totalDuration: number
): { startTime: number; endTime: number; clippedSentence: boolean } {
  if (transcript.length === 0) {
    return {
      startTime: Number(Math.max(0, start).toFixed(2)),
      endTime: Number(Math.min(totalDuration, Math.max(start + 3, end)).toFixed(2)),
      clippedSentence: false,
    };
  }

  const overlapping = transcript.filter((seg) => seg.end > start + 0.25 && seg.start < end - 0.25);
  if (overlapping.length === 0) {
    // Pick nearest segment
    const nearest = transcript.reduce((best, cur) =>
      Math.abs(cur.start - start) < Math.abs(best.start - start) ? cur : best
    );
    return {
      startTime: Number(Math.max(0, nearest.start - 0.15).toFixed(2)),
      endTime: Number(Math.min(totalDuration, nearest.end + 0.25).toFixed(2)),
      clippedSentence: false,
    };
  }

  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  const firstIdx = transcript.indexOf(first);
  const lastIdx = transcript.indexOf(last);
  const prevEnd = firstIdx > 0 ? transcript[firstIdx - 1].end : 0;
  const nextStart = lastIdx >= 0 && lastIdx < transcript.length - 1 ? transcript[lastIdx + 1].start : totalDuration;

  const snappedStart = Math.max(0, prevEnd, first.start - 0.15);
  const snappedEnd = Math.min(totalDuration, nextStart, last.end + 0.25);
  return {
    startTime: Number(snappedStart.toFixed(2)),
    endTime: Number(snappedEnd.toFixed(2)),
    clippedSentence: false,
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

export async function generateAndScoreHighlights(params: {
  projectId: string;
  title: string;
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  analysis: ContentAnalysis;
  settings: StudioSettings;
}): Promise<HighlightRecord[]> {
  const { projectId, title, metadata, transcript, analysis, settings } = params;
  const category = findCategoryByIdOrName(analysis.primaryCategoryId, settings.customCategories);
  const profileSpec = EDITING_PROFILES[analysis.recommendedProfile] ?? EDITING_PROFILES[category.defaultEditingProfile];
  const ai = getGeminiClient();

  const duration = metadata.duration;
  const effectiveMin = Math.min(settings.minClipDuration, Math.max(3, duration * 0.25));
  const effectiveMax = Math.min(settings.maxClipDuration, duration);

  const formattedLines = transcript.map(
    (s) => `[${s.start.toFixed(2)}s -> ${s.end.toFixed(2)}s] (${s.speaker}): ${s.text}`
  );

  // Split ultra-long transcripts (e.g. 3+ hour videos) into ~95k-char chronological windows
  const windows: string[] = [];
  let currentChunk = '';
  for (const line of formattedLines) {
    if (currentChunk.length + line.length + 1 > 95000 && currentChunk.length > 0) {
      windows.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
    }
  }
  if (currentChunk) {
    windows.push(currentChunk);
  }
  if (windows.length === 0) {
    windows.push('');
  }

  const perWindowTarget =
    windows.length > 1 ? '2 to 4' : duration >= 3600 ? '4 to 8' : '2 to 6';

  type RawCandidate = {
    startTime: number;
    endTime: number;
    title: string;
    description: string;
    secondaryCategoryName?: string;
    selectionExplanation: string;
    keywords: string[];
    scores: Omit<HighlightScoreBreakdown, 'totalScore'>;
  };

  const candidates: RawCandidate[] = [];

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const windowNote =
      windows.length > 1
        ? `Transcript Section ${wIdx + 1} of ${windows.length}:`
        : 'Transcript:';

    const prompt = `You are the Category-Specific Highlight Agent & Scoring Engine.
Video Title: "${title}"
Total Duration: ${duration.toFixed(2)}s
Detected Language: ${analysis.detectedLanguage} (${analysis.languageCode})
Primary Category: ${category.name}
Secondary Categories: ${analysis.secondaryCategories.map((c) => c.categoryName).join(', ') || 'None'}

Category-Specific Highlight Strategy (${category.name}):
${category.highlightStrategy}

Target Clip Duration Window:
- For videos over 25s, aim for ${effectiveMin.toFixed(0)}s to ${effectiveMax.toFixed(0)}s per clip.
- If the source video is short (under 30s), extract the strongest 1-3 self-contained segments (each >= 4s) plus optionally the full cohesive arc if it is a complete short statement.

CRITICAL RULES:
- Never cut mid-sentence. Align startTime and endTime cleanly to transcript segment boundaries.
- Avoid misleading edits, duplicate/overlapping clips, excessive silence, or missing prerequisite context.
- Write clip titles and descriptions in the SAME language as the video (${analysis.detectedLanguage}), or clearly tailored to its audience.
- Score every criterion on a 0 to 100 integer scale (for example: 85, 78, 92 — NEVER 0-10).
- Propose between ${perWindowTarget} distinct candidate clips from this section ranked by quality.

${windowNote}
${windows[wIdx]}`;

    const response = await withModelFallback(
      ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
      (model) =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
                          hookStrength: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
                          standaloneContext: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
                          audienceInterest: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
                          emotionalOrInfoValue: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
                          contentCompleteness: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
                          audioVisualQuality: { type: Type.NUMBER, description: 'Integer score from 0 to 100' },
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
      windows.length > 1 ? `highlight-scoring-part-${wIdx + 1}` : 'highlight-scoring'
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      candidates?: RawCandidate[];
    };
    if (Array.isArray(parsed.candidates)) {
      candidates.push(...parsed.candidates);
    }
  }

  const results: HighlightRecord[] = [];

  for (const cand of candidates) {
    const snapped = snapToSentenceBoundaries(cand.startTime, cand.endTime, transcript, duration);
    const clipDuration = Number((snapped.endTime - snapped.startTime).toFixed(2));
    if (clipDuration < 3) continue;

    // Deduplicate near-identical boundaries (>80% overlap with already accepted higher clip)
    const isDuplicate = results.some((existing) => {
      const overlap = Math.max(
        0,
        Math.min(existing.endTime, snapped.endTime) - Math.max(existing.startTime, snapped.startTime)
      );
      return overlap / Math.min(existing.duration, clipDuration) > 0.8;
    });
    if (isDuplicate) continue;

    const breakdown = computeWeightedScore(cand.scores, category);

    results.push({
      id: `hl_${crypto.randomUUID().slice(0, 8)}`,
      projectId,
      startTime: snapped.startTime,
      endTime: snapped.endTime,
      duration: clipDuration,
      title: cand.title.trim(),
      description: cand.description.trim(),
      categoryId: category.id,
      categoryName: category.name,
      secondaryCategoryName: cand.secondaryCategoryName?.trim() || null,
      selectionExplanation: cand.selectionExplanation.trim(),
      keywords: Array.isArray(cand.keywords) ? cand.keywords.slice(0, 6) : [],
      criteriaBreakdown: breakdown,
      status: breakdown.totalScore >= 72 ? 'selected' : 'candidate',
      editingProfile: profileSpec.id,
      subtitleStyle: profileSpec.subtitlePreset,
      highlightColor: profileSpec.highlightColorHex || settings.defaultHighlightColor,
      cropMode: profileSpec.cropMode,
      dynamicZoom: category.avoidEffects ? false : profileSpec.allowDynamicZoom,
      normalizeAudio: profileSpec.normalizeAudio,
      watermarkEnabled: settings.enableWatermarkByDefault,
      renderedVideoUrl: null,
      qcReport: null,
    });
  }

  // Sort highest scored first
  results.sort((a, b) => b.criteriaBreakdown.totalScore - a.criteriaBreakdown.totalScore);
  return results;
}
