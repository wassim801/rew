import { ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { TranscriptSegment } from '../../types/studio';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import {
  clearModelCooldown,
  getGeminiClient,
  isModelInCooldown,
  isTransientGeminiError,
  markModelCooldown,
  withModelFallback,
  withRetry,
} from '../geminiClient';

const execFileAsync = promisify(execFile);

const TRANSCRIPT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedLanguage: {
      type: Type.STRING,
      description: 'Primary spoken language name, e.g. English, French, Arabic',
    },
    languageCode: {
      type: Type.STRING,
      description: 'ISO 639-1 code such as en, fr, or ar',
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start: {
            type: Type.NUMBER,
            description: 'Start timestamp in seconds',
          },
          end: {
            type: Type.NUMBER,
            description: 'End timestamp in seconds',
          },
          speaker: {
            type: Type.STRING,
            description: 'Speaker label such as Speaker 1 or Host',
          },
          text: {
            type: Type.STRING,
            description: 'Verbatim spoken sentence or clause in original language script',
          },
        },
        required: ['start', 'end', 'speaker', 'text'],
      },
    },
  },
  required: ['detectedLanguage', 'languageCode', 'segments'],
};

export interface AlignedSubtitleCue {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * Runs a fast FFmpeg silencedetect pass (<100ms on clips) to pinpoint active spoken
 * intervals so timestamps lock to real acoustic speech energy rather than silence.
 */
export async function detectSpeechIntervals(
  audioPath: string,
  totalDuration: number
): Promise<Array<{ start: number; end: number }>> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-nostats',
        '-i',
        audioPath,
        '-af',
        'silencedetect=noise=-36dB:d=0.24',
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );

    const silences: Array<{ start: number; end: number }> = [];
    let pendingStart: number | null = null;
    for (const line of stderr.split(/\r?\n/)) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        pendingStart = Number(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
      if (endMatch) {
        const sEnd = Number(endMatch[1]);
        silences.push({
          start: pendingStart ?? 0,
          end: sEnd,
        });
        pendingStart = null;
      }
    }
    if (pendingStart !== null && pendingStart < totalDuration) {
      silences.push({ start: pendingStart, end: totalDuration });
    }

    if (silences.length === 0) {
      return [{ start: 0, end: Number(totalDuration.toFixed(2)) }];
    }

    const speech: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const sil of silences) {
      if (sil.start - cursor > 0.12) {
        speech.push({
          start: Number(cursor.toFixed(2)),
          end: Number(Math.min(totalDuration, sil.start).toFixed(2)),
        });
      }
      cursor = Math.max(cursor, sil.end);
    }
    if (totalDuration - cursor > 0.12) {
      speech.push({
        start: Number(cursor.toFixed(2)),
        end: Number(totalDuration.toFixed(2)),
      });
    }
    return speech;
  } catch {
    return [{ start: 0, end: Number(totalDuration.toFixed(2)) }];
  }
}

function formatSpeechIntervalsHint(intervals: Array<{ start: number; end: number }>): string {
  if (!intervals.length) return '';
  const preview = intervals
    .slice(0, 40)
    .map((iv) => `${iv.start.toFixed(2)}s-${iv.end.toFixed(2)}s`)
    .join(', ');
  return `Detected active speech windows (anchor captions inside these voiced regions, never over silent gaps): ${preview}`;
}

async function transcribeSingleAudioChunk(params: {
  audioBytes: Buffer;
  chunkDuration: number;
  languageHint: 'auto' | 'en' | 'fr' | 'ar';
  speechIntervals?: Array<{ start: number; end: number }>;
}): Promise<{
  detectedLanguage: string;
  languageCode: string;
  segments: Array<{ start: number; end: number; speaker: string; text: string }>;
}> {
  const { audioBytes, chunkDuration, languageHint, speechIntervals = [] } = params;
  const ai = getGeminiClient();
  const base64Audio = audioBytes.toString('base64');

  const hintText =
    languageHint === 'auto'
      ? 'Automatically detect the primary spoken language (supports English, French, Arabic, and mixed speech).'
      : `Language hint: ${languageHint}. Still verify and report the true spoken language.`;
  const acousticHint = formatSpeechIntervalsHint(speechIntervals);

  let rawJsonText: string | null = null;

  // Step 1: Use dedicated gemini-3.5-transcribe when healthy and yielding explicit timestamped lines
  if (!isModelInCooldown('gemini-3.5-transcribe')) {
    try {
      const transcribeResponse = await withRetry(
        () =>
          ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/mp3',
                    data: base64Audio,
                  },
                },
                {
                  text: `Transcribe this ${chunkDuration.toFixed(1)}-second audio track verbatim into tightly timed lines.
${hintText}
${acousticHint}
Preserve complete sentence/phrase boundaries and label distinct speakers if audible (e.g. Speaker 1, Host, Guest).
IMPORTANT: Include REAL acoustic start/end seconds from the audio for every line:
[start_seconds - end_seconds] Speaker: verbatim text`,
                },
              ],
            },
          }),
        1,
        'audio-transcribe-3.5'
      );

      clearModelCooldown('gemini-3.5-transcribe');
      const rawTranscriptText = (transcribeResponse.text ?? '').trim();
      const lines = rawTranscriptText.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const timestampedCount = lines.filter((l) =>
        /\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*\]/.test(l)
      ).length;

      // Only structure 3.5-transcribe output when real timestamps were actually emitted;
      // otherwise let multimodal Gemini listen directly to the audio waveform for accurate sync.
      if (rawTranscriptText && timestampedCount >= Math.max(1, Math.floor(lines.length * 0.5))) {
        const structureResponse = await withModelFallback(
          ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
          (model) =>
            ai.models.generateContent({
              model,
              contents: `Convert the following verbatim timestamped transcript into strictly valid JSON matching the schema.
Total media duration is ${chunkDuration.toFixed(2)} seconds.
${acousticHint}
Preserve the exact timestamps from each line, keeping start >= 0, end <= ${chunkDuration.toFixed(2)}, end > start.

Raw Transcript:
${rawTranscriptText}`,
              config: {
                thinkingConfig: {
                  thinkingLevel: model === 'gemini-3.1-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
                },
                responseMimeType: 'application/json',
                responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
              },
            }),
          'transcript-structure'
        );
        rawJsonText = (structureResponse.text ?? '{}').trim();
      } else if (rawTranscriptText) {
        console.log(
          '[TranscriptionAgent] 3.5-transcribe omitted timestamps; aligning directly against audio waveform with multimodal Gemini.'
        );
      }
    } catch (err) {
      if (!isTransientGeminiError(err)) {
        throw err;
      }
      markModelCooldown('gemini-3.5-transcribe', 120000);
      console.log(
        '[TranscriptionAgent] Switching to multimodal audio JSON transcription after temporary 3.5-transcribe unavailability.'
      );
    }
  }

  // Step 2: Multimodal audio waveform transcription for exact voice-synced timestamps
  if (!rawJsonText) {
    const multimodalResponse = await withModelFallback(
      ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
      (model) =>
        ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: base64Audio,
                },
              },
              {
                text: `Listen carefully to the audio waveform and transcribe it into tightly voice-synced timestamped segments.
Total media duration is ${chunkDuration.toFixed(2)} seconds.
${hintText}
${acousticHint}
CRITICAL TIMING RULES:
- Timestamp start and end must match the EXACT moment speech starts and finishes in the audio (never span across silent gaps or drift).
- Keep segments concise (1 short sentence or natural 4-10 word spoken phrase) so captions follow the voice accurately.
- Identify distinct speakers when audible (e.g., "Speaker 1", "Speaker 2", or "Host"/"Guest").
Return strictly valid JSON matching the schema.`,
              },
            ],
          },
          config: {
            thinkingConfig: {
              thinkingLevel: model === 'gemini-3.1-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
            },
            responseMimeType: 'application/json',
            responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          },
        }),
      'audio-transcribe-multimodal'
    );
    rawJsonText = (multimodalResponse.text ?? '{}').trim();
  }

  const parsed = JSON.parse(rawJsonText) as {
    detectedLanguage?: string;
    languageCode?: string;
    segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
  };

  return {
    detectedLanguage: parsed.detectedLanguage || 'English',
    languageCode: parsed.languageCode || 'en',
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
  };
}

/**
 * Aligns captions to the EXACT audio waveform of a short highlight clip [startTime, endTime]
 * (0.00s = frame 0 of the rendered MP4), eliminating keyframe drift or long-chunk timestamp skew.
 */
export async function alignClipSubtitlesWithAudio(params: {
  projectId: string;
  sourcePath: string;
  highlightId: string;
  startTime: number;
  endTime: number;
  fallbackTranscript: TranscriptSegment[];
  languageHint?: string;
  overrideCacheKey?: string;
}): Promise<AlignedSubtitleCue[]> {
  const {
    projectId,
    sourcePath,
    highlightId,
    startTime,
    endTime,
    fallbackTranscript,
    languageHint,
    overrideCacheKey,
  } = params;
  const clipDur = Math.max(1, Number((endTime - startTime).toFixed(2)));
  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const rendersDir = resolveSafePath(projectDir, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });

  const safeKey = overrideCacheKey
    ? overrideCacheKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
    : `${highlightId}_${startTime.toFixed(2)}_${endTime.toFixed(2)}`;
  const cacheFilename = `subalign_${safeKey}.json`;
  const cachePath = resolveSafePath(rendersDir, cacheFilename);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as AlignedSubtitleCue[];
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    } catch {
      // Rebuild alignment cache if unreadable
    }
  }

  const overlappingText = fallbackTranscript
    .filter((s) => s.end > startTime && s.start < endTime)
    .map((s) => `${s.speaker}: ${s.text}`)
    .join('\n');

  const tmpClipAudio = resolveSafePath(rendersDir, `subalign_tmp_${highlightId}_${Date.now()}.mp3`);
  try {
    const ffArgs =
      startTime <= 0.05
        ? [
            '-y',
            '-nostats',
            '-loglevel',
            'error',
            '-i',
            sourcePath,
            '-t',
            String(clipDur),
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-b:a',
            '64k',
            tmpClipAudio,
          ]
        : [
            '-y',
            '-nostats',
            '-loglevel',
            'error',
            '-ss',
            String(startTime),
            '-t',
            String(clipDur),
            '-i',
            sourcePath,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-b:a',
            '64k',
            tmpClipAudio,
          ];

    await execFileAsync('ffmpeg', ffArgs, { maxBuffer: 10 * 1024 * 1024 });

    if (fs.existsSync(tmpClipAudio) && fs.statSync(tmpClipAudio).size > 256) {
      const speechIntervals = await detectSpeechIntervals(tmpClipAudio, clipDur);
      const audioBytes = fs.readFileSync(tmpClipAudio);
      const ai = getGeminiClient();

      const resp = await withModelFallback(
        ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
        (model) =>
          ai.models.generateContent({
            model,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/mp3',
                    data: audioBytes.toString('base64'),
                  },
                },
                {
                  text: `You are an expert short-form subtitle timecode aligner.
Listen directly to this ${clipDur.toFixed(2)}-second clip audio (from 0.00s to ${clipDur.toFixed(2)}s).
${formatSpeechIntervalsHint(speechIntervals)}
${languageHint ? `Language hint: ${languageHint}.` : ''}
${overlappingText ? `\nReference transcript (verify/correct against what you actually hear in the audio):\n${overlappingText}` : ''}

Produce tightly voice-synchronized 2 to 5 word subtitle cues:
- Every cue's start and end MUST match the exact fraction of a second the words are spoken in this audio (0.00 to ${clipDur.toFixed(2)}).
- Never extend subtitles across silent pauses. Leave gaps when the speaker pauses.
- Split long sentences into 2 to 5 word rhythmic cues (~18-24 chars max) that pop on beat with the speaker's voice.
- Preserve exact spoken language script and identify speakers accurately.
Return strictly valid JSON matching the schema.`,
                },
              ],
            },
            config: {
              thinkingConfig: {
                thinkingLevel: model === 'gemini-3.1-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
              },
              responseMimeType: 'application/json',
              responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
            },
          }),
        'clip-subtitle-align'
      );

      const parsed = JSON.parse((resp.text ?? '{}').trim()) as {
        segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
      };

      const rawSegs = Array.isArray(parsed.segments) ? parsed.segments : [];
      const cleaned: AlignedSubtitleCue[] = [];
      let prevEnd = 0;

      for (const seg of rawSegs) {
        const text = (seg.text || '').trim();
        if (!text) continue;
        let s = Math.max(prevEnd, Math.max(0, Math.min(clipDur - 0.15, Number(seg.start) || 0)));
        let e = Math.min(clipDur, Math.max(s + 0.25, Number(seg.end) || s + 0.8));
        if (s >= clipDur) break;
        e = Math.min(clipDur, e);
        cleaned.push({
          start: Number(s.toFixed(2)),
          end: Number(e.toFixed(2)),
          speaker: (seg.speaker || 'Speaker 1').trim(),
          text,
        });
        prevEnd = e;
      }

      if (cleaned.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(cleaned, null, 2), 'utf-8');
        return cleaned;
      }
    }
  } catch {
    console.log(
      '[TranscriptionAgent] Clip audio alignment skipped; using project transcript cues.'
    );
  } finally {
    if (fs.existsSync(tmpClipAudio)) {
      try {
        fs.unlinkSync(tmpClipAudio);
      } catch {
        // ignore cleanup error
      }
    }
  }

  // Fallback: proportional character-weighted slicing from project transcript
  const overlapping = fallbackTranscript.filter((s) => s.end > startTime && s.start < endTime);
  const cues: AlignedSubtitleCue[] = [];
  for (const seg of overlapping) {
    const segStart = Math.max(startTime, seg.start);
    const segEnd = Math.min(endTime, seg.end);
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const groups: string[][] = [];
    for (let i = 0; i < words.length; i += 4) {
      groups.push(words.slice(i, i + 4));
    }
    const totalChars = groups.reduce((acc, g) => acc + g.join('').length, 0) || 1;
    const segDur = Math.max(0.4, segEnd - segStart);
    let cursor = segStart - startTime;

    for (const grp of groups) {
      const grpChars = grp.join('').length || 1;
      const grpDur = Math.max(0.28, (segDur * grpChars) / totalChars);
      const cStart = Math.max(0, cursor);
      const cEnd = Math.min(clipDur, cStart + grpDur);
      cues.push({
        start: Number(cStart.toFixed(2)),
        end: Number(Math.max(cStart + 0.25, cEnd).toFixed(2)),
        speaker: seg.speaker || 'Speaker 1',
        text: grp.join(' '),
      });
      cursor = cEnd;
    }
  }
  return cues;
}

export async function transcribeProjectAudio(params: {
  projectId: string;
  audioPath: string | null;
  duration: number;
  languageHint?: 'auto' | 'en' | 'fr' | 'ar';
  onChunkProgress?: (completed: number, total: number) => void;
  sourceIndex?: number;
  sourceFilename?: string;
}): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string }> {
  const {
    projectId,
    audioPath,
    duration,
    languageHint = 'auto',
    onChunkProgress,
    sourceIndex,
    sourceFilename,
  } = params;

  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('No audio track available for transcription.');
  }

  const audioStat = fs.statSync(audioPath);
  const fileSizeMb = audioStat.size / (1024 * 1024);

  let detectedLanguage = 'English';
  let languageCode = 'en';
  const mergedRaw: Array<{ start: number; end: number; speaker: string; text: string }> = [];

  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const chunkCacheDir = resolveSafePath(
    projectDir,
    sourceIndex !== undefined ? `transcript_chunks_src_${sourceIndex}` : 'transcript_chunks'
  );

  if (fileSizeMb <= 10 && duration <= 180) {
    const speechIntervals = await detectSpeechIntervals(audioPath, duration);
    const audioBytes = fs.readFileSync(audioPath);
    const res = await transcribeSingleAudioChunk({
      audioBytes,
      chunkDuration: duration,
      languageHint,
      speechIntervals,
    });
    detectedLanguage = res.detectedLanguage;
    languageCode = res.languageCode;
    mergedRaw.push(...res.segments);
    onChunkProgress?.(1, 1);
  } else {
    // Split long-form audio into 2-minute segments for faster responses + tight voice sync
    fs.mkdirSync(chunkCacheDir, { recursive: true });
    const chunkMetaPath = resolveSafePath(chunkCacheDir, 'chunk_meta.json');
    let chunkSeconds = 120;
    if (fs.existsSync(chunkMetaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(chunkMetaPath, 'utf-8')) as { chunkSeconds?: number };
        if (meta.chunkSeconds && meta.chunkSeconds > 0) chunkSeconds = meta.chunkSeconds;
      } catch {
        // use default 120s
      }
    } else if (fs.existsSync(resolveSafePath(chunkCacheDir, 'chunk_0.json'))) {
      // Preserve 240s alignment when resuming a pre-existing partial checkpoint folder
      chunkSeconds = 240;
    } else {
      fs.writeFileSync(chunkMetaPath, JSON.stringify({ chunkSeconds }), 'utf-8');
    }

    const totalChunks = Math.max(1, Math.ceil(duration / chunkSeconds));
    const tmpChunkDir = path.join(projectDir, `audio_chunks_${Date.now()}`);
    fs.mkdirSync(tmpChunkDir, { recursive: true });

    try {
      for (let i = 0; i < totalChunks; i++) {
        const offsetSec = i * chunkSeconds;
        const segDur = Math.max(1, Math.min(chunkSeconds, duration - offsetSec));
        const chunkCachePath = resolveSafePath(chunkCacheDir, `chunk_${i}.json`);

        let chunkRes: {
          detectedLanguage: string;
          languageCode: string;
          segments: Array<{ start: number; end: number; speaker: string; text: string }>;
        } | null = null;

        if (fs.existsSync(chunkCachePath)) {
          try {
            const cached = JSON.parse(fs.readFileSync(chunkCachePath, 'utf-8')) as {
              detectedLanguage?: string;
              languageCode?: string;
              segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
            };
            if (Array.isArray(cached.segments)) {
              chunkRes = {
                detectedLanguage: cached.detectedLanguage || 'English',
                languageCode: cached.languageCode || 'en',
                segments: cached.segments,
              };
              console.log(
                `[TranscriptionAgent] Reusing cached transcript chunk ${i + 1}/${totalChunks} for project ${projectId}`
              );
            }
          } catch {
            // Corrupted cache entry — re-transcribe this chunk cleanly
          }
        }

        if (!chunkRes) {
          const chunkPath = path.join(tmpChunkDir, `chunk_${i}.mp3`);
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-nostats',
              '-loglevel',
              'error',
              '-ss',
              String(offsetSec),
              '-t',
              String(segDur),
              '-i',
              audioPath,
              '-c',
              'copy',
              chunkPath,
            ],
            { maxBuffer: 10 * 1024 * 1024 }
          );

          if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size === 0) {
            onChunkProgress?.(i + 1, totalChunks);
            continue;
          }

          const speechIntervals = await detectSpeechIntervals(chunkPath, segDur);
          chunkRes = await transcribeSingleAudioChunk({
            audioBytes: fs.readFileSync(chunkPath),
            chunkDuration: segDur,
            languageHint,
            speechIntervals,
          });

          fs.writeFileSync(chunkCachePath, JSON.stringify(chunkRes), 'utf-8');
          try {
            fs.unlinkSync(chunkPath);
          } catch {
            // Best-effort cleanup of processed chunk MP3
          }
          if (i < totalChunks - 1) {
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }

        if (i === 0) {
          detectedLanguage = chunkRes.detectedLanguage;
          languageCode = chunkRes.languageCode;
        }
        for (const s of chunkRes.segments) {
          mergedRaw.push({
            start: offsetSec + (Number(s.start) || 0),
            end: offsetSec + (Number(s.end) || (Number(s.start) || 0) + 2),
            speaker: s.speaker,
            text: s.text,
          });
        }
        onChunkProgress?.(i + 1, totalChunks);
      }
    } finally {
      fs.rmSync(tmpChunkDir, { recursive: true, force: true });
    }
  }

  const normalized: TranscriptSegment[] = mergedRaw
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s, idx) => {
      const start = Math.max(0, Math.min(duration, Number(s.start) || 0));
      const end = Math.max(start + 0.5, Math.min(duration, Number(s.end) || start + 2));
      return {
        id: sourceIndex !== undefined ? `src${sourceIndex}_seg_${idx + 1}` : `seg_${idx + 1}`,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        speaker: (s.speaker || 'Speaker 1').trim(),
        text: s.text.trim(),
        language: languageCode,
        ...(sourceIndex !== undefined ? { sourceIndex } : {}),
        ...(sourceFilename ? { sourceFilename } : {}),
      };
    });

  // Save transcript locally as JSON artifact per project (or per source clip)
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptFilename =
    sourceIndex !== undefined ? `transcript_src_${sourceIndex}.json` : 'transcript.json';
  fs.writeFileSync(
    resolveSafePath(projectDir, transcriptFilename),
    JSON.stringify(
      {
        detectedLanguage,
        languageCode,
        segments: normalized,
      },
      null,
      2
    ),
    'utf-8'
  );

  // Clean up chunk checkpoints now that full transcript.json is saved
  if (fs.existsSync(chunkCacheDir)) {
    fs.rmSync(chunkCacheDir, { recursive: true, force: true });
  }

  return {
    segments: normalized,
    detectedLanguage,
  };
}
