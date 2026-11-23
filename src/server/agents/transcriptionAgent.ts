import { ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { TranscriptSegment } from '../../types/studio';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import {
  getGeminiClient,
  isTransientGeminiError,
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

async function transcribeSingleAudioChunk(params: {
  audioBytes: Buffer;
  chunkDuration: number;
  languageHint: 'auto' | 'en' | 'fr' | 'ar';
}): Promise<{
  detectedLanguage: string;
  languageCode: string;
  segments: Array<{ start: number; end: number; speaker: string; text: string }>;
}> {
  const { audioBytes, chunkDuration, languageHint } = params;
  const ai = getGeminiClient();
  const base64Audio = audioBytes.toString('base64');

  const hintText =
    languageHint === 'auto'
      ? 'Automatically detect the primary spoken language (supports English, French, Arabic, and mixed speech).'
      : `Language hint: ${languageHint}. Still verify and report the true spoken language.`;

  let rawJsonText: string | null = null;

  // Preferred path: dedicated gemini-3.5-transcribe (plain text) -> fast text-only structuring
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
                text: `Transcribe this ${chunkDuration.toFixed(1)}-second audio track verbatim into timestamped plain-text lines.
${hintText}
Preserve complete sentence boundaries and label distinct speakers if audible (e.g. Speaker 1, Host, Guest).
Format each line as:
[start_seconds - end_seconds] Speaker: verbatim text`,
              },
            ],
          },
        }),
      1,
      'audio-transcribe-3.5'
    );

    const rawTranscriptText = (transcribeResponse.text ?? '').trim();
    if (rawTranscriptText) {
      const structureResponse = await withModelFallback(
        ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
        (model) =>
          ai.models.generateContent({
            model,
            contents: `Convert the following verbatim audio transcript into strictly valid JSON matching the schema.
Total media duration is ${chunkDuration.toFixed(2)} seconds.
Ensure every segment has start >= 0, end <= ${chunkDuration.toFixed(2)}, end > start, complete sentence boundaries, and accurate speaker attribution. If timestamps are missing or approximate in the source text, distribute timestamps proportionally across 0 to ${chunkDuration.toFixed(2)} seconds based on sentence length.

Raw Transcript:
${rawTranscriptText}`,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
            },
          }),
        'transcript-structure'
      );
      rawJsonText = (structureResponse.text ?? '{}').trim();
    }
  } catch (err) {
    if (!isTransientGeminiError(err)) {
      throw err;
    }
    console.log(
      '[TranscriptionAgent] Switching to multimodal audio JSON transcription after transient 3.5-transcribe error.'
    );
  }

  // Fallback path if gemini-3.5-transcribe is experiencing high demand (503) or returned empty
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
                text: `Transcribe this audio track into accurate, sentence-complete timestamped segments.
Total media duration is ${chunkDuration.toFixed(2)} seconds.
${hintText}
Preserve complete sentence boundaries so no sentence is split awkwardly.
Identify distinct speakers when audible (e.g., "Speaker 1", "Speaker 2", or "Host"/"Guest").
Return strictly valid JSON matching the schema.`,
              },
            ],
          },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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

export async function transcribeProjectAudio(params: {
  projectId: string;
  audioPath: string | null;
  duration: number;
  languageHint?: 'auto' | 'en' | 'fr' | 'ar';
  onChunkProgress?: (completed: number, total: number) => void;
}): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string }> {
  const { projectId, audioPath, duration, languageHint = 'auto', onChunkProgress } = params;

  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('No audio track available for transcription.');
  }

  const audioStat = fs.statSync(audioPath);
  const fileSizeMb = audioStat.size / (1024 * 1024);

  let detectedLanguage = 'English';
  let languageCode = 'en';
  const mergedRaw: Array<{ start: number; end: number; speaker: string; text: string }> = [];

  if (fileSizeMb <= 12 && duration <= 720) {
    const audioBytes = fs.readFileSync(audioPath);
    const res = await transcribeSingleAudioChunk({
      audioBytes,
      chunkDuration: duration,
      languageHint,
    });
    detectedLanguage = res.detectedLanguage;
    languageCode = res.languageCode;
    mergedRaw.push(...res.segments);
    onChunkProgress?.(1, 1);
  } else {
    // Split long-form audio into 10-minute segments so multi-hour (3h+) videos transcribe fast & accurately
    const chunkSeconds = 600;
    const totalChunks = Math.max(1, Math.ceil(duration / chunkSeconds));
    const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
    const tmpChunkDir = path.join(projectDir, `audio_chunks_${Date.now()}`);
    fs.mkdirSync(tmpChunkDir, { recursive: true });

    try {
      for (let i = 0; i < totalChunks; i++) {
        const offsetSec = i * chunkSeconds;
        const segDur = Math.max(1, Math.min(chunkSeconds, duration - offsetSec));
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

        if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size === 0) continue;
        const chunkRes = await transcribeSingleAudioChunk({
          audioBytes: fs.readFileSync(chunkPath),
          chunkDuration: segDur,
          languageHint,
        });
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
        id: `seg_${idx + 1}`,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        speaker: (s.speaker || 'Speaker 1').trim(),
        text: s.text.trim(),
        language: languageCode,
      };
    });

  // Save transcript locally as JSON artifact per project
  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    resolveSafePath(projectDir, 'transcript.json'),
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

  return {
    segments: normalized,
    detectedLanguage,
  };
}
