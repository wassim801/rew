import { Quality, Ytdl, chooseFormat, parseVideoId } from '@distube/ytdl-core';
import { ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import type { SceneKeyframe, TranscriptSegment } from '../../types/studio';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import { getGeminiClient, withModelFallback } from '../geminiClient';

const execFileAsync = promisify(execFile);

const ALLOWED_YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

export function validateYouTubeUrl(rawUrl: string): { canonicalUrl: string; videoId: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Please enter a valid YouTube URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP/HTTPS YouTube URLs are supported.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_YT_HOSTS.has(host)) {
    throw new Error('URL must be from youtube.com, youtu.be, or music.youtube.com.');
  }

  const videoId = parseVideoId(parsed.toString());
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error('Could not find a valid 11-character YouTube video ID in that URL.');
  }

  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

export async function fetchYouTubeOEmbed(canonicalUrl: string): Promise<{
  title: string;
  authorName: string;
  thumbnailUrl: string;
}> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
  const res = await fetch(oembedUrl);
  if (!res.ok) {
    throw new Error('YouTube video is private, unavailable, or invalid.');
  }
  const data = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };
  return {
    title: data.title || 'YouTube Video',
    authorName: data.author_name || '',
    thumbnailUrl: data.thumbnail_url || '',
  };
}

export async function fetchYouTubeMetadata(params: {
  rawUrl: string;
  cookie?: string;
}): Promise<{
  canonicalUrl: string;
  videoId: string;
  title: string;
  durationSec: number;
  thumbnailUrl?: string;
}> {
  const { canonicalUrl, videoId } = validateYouTubeUrl(params.rawUrl);
  const ytdl = new Ytdl(params.cookie?.trim() ? { cookie: params.cookie.trim() } : undefined);

  try {
    const info = await ytdl.getInfo(canonicalUrl);
    return {
      canonicalUrl,
      videoId,
      title: info.videoDetails.title || `YouTube Video (${videoId})`,
      durationSec: Number(info.videoDetails.lengthSeconds || 0),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If bot verification blocks direct stream inspection on a cloud IP,
    // verify via YouTube's public oEmbed endpoint so Gemini multimodal analysis can proceed seamlessly.
    if (msg.includes('Sign in to confirm') || msg.includes('BOT_CHECK')) {
      const oembed = await fetchYouTubeOEmbed(canonicalUrl);
      return {
        canonicalUrl,
        videoId,
        title: oembed.title,
        durationSec: 0,
        thumbnailUrl: oembed.thumbnailUrl,
      };
    }
    throw normalizeYouTubeError(err);
  }
}

export async function downloadYouTubeVideo(params: {
  canonicalUrl: string;
  outputMp4Path: string;
  cookie?: string;
  onProgress?: (percent: number, detail: string) => void;
}): Promise<{ title: string }> {
  const { canonicalUrl, outputMp4Path, cookie, onProgress } = params;
  const ytdl = new Ytdl(cookie?.trim() ? { cookie: cookie.trim() } : undefined);

  try {
    onProgress?.(4, 'Fetching YouTube stream manifest...');
    const info = await ytdl.getInfo(canonicalUrl);
    const title = info.videoDetails.title || 'YouTube Video';

    let muxedFormat = null;
    try {
      const candidate = chooseFormat(info.formats, {
        quality: Quality.Highest,
        filter: { hasVideo: true, hasAudio: true, container: 'mp4', isLive: false },
      });
      if (candidate && (candidate.height ?? 0) >= 720) {
        muxedFormat = candidate;
      }
    } catch {
      muxedFormat = null;
    }

    if (muxedFormat) {
      onProgress?.(10, `Downloading ${muxedFormat.qualityLabel || 'MP4'} stream...`);
      const readable = ytdl.download(info, {
        format: muxedFormat,
        onProgress: (ev) => {
          if (ev.total && ev.total > 0) {
            const pct = Math.min(95, Math.round((ev.downloaded / ev.total) * 85) + 10);
            onProgress?.(pct, `Downloading MP4 (${Math.round((ev.downloaded / ev.total) * 100)}%)...`);
          }
        },
      });
      await pipeline(readable, fs.createWriteStream(outputMp4Path));
      onProgress?.(100, 'Download complete.');
      return { title };
    }

    const tempDir = path.join(path.dirname(outputMp4Path), `yt_tmp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempVideo = path.join(tempDir, 'video.mp4');
    const tempAudio = path.join(tempDir, 'audio.m4a');

    try {
      const videoFmt = chooseFormat(info.formats, {
        quality: Quality.HighestVideo,
        filter: [
          { hasVideo: true, hasAudio: false, container: 'mp4', isLive: false },
          { hasVideo: true, hasAudio: false, isLive: false },
        ],
      });
      const audioFmt = chooseFormat(info.formats, {
        quality: Quality.HighestAudio,
        filter: [
          { hasAudio: true, hasVideo: false, container: 'mp4', isLive: false },
          { hasAudio: true, hasVideo: false, isLive: false },
        ],
      });

      onProgress?.(12, `Downloading video stream (${videoFmt.qualityLabel || 'HD'})...`);
      await pipeline(
        ytdl.download(info, {
          format: videoFmt,
          onProgress: (ev) => {
            if (ev.total && ev.total > 0) {
              const pct = Math.min(60, Math.round((ev.downloaded / ev.total) * 48) + 12);
              onProgress?.(pct, `Downloading video (${Math.round((ev.downloaded / ev.total) * 100)}%)...`);
            }
          },
        }),
        fs.createWriteStream(tempVideo)
      );

      onProgress?.(64, 'Downloading audio stream...');
      await pipeline(ytdl.download(info, { format: audioFmt }), fs.createWriteStream(tempAudio));

      onProgress?.(85, 'Muxing video and audio tracks with FFmpeg...');
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        tempVideo,
        '-i',
        tempAudio,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputMp4Path,
      ]);

      onProgress?.(100, 'Download complete.');
      return { title };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    throw normalizeYouTubeError(err);
  }
}

export async function downloadYouTubeThumbnail(
  projectId: string,
  videoId: string
): Promise<SceneKeyframe[]> {
  const scenesDir = resolveSafePath(PROJECTS_DIR, projectId, 'scenes');
  fs.mkdirSync(scenesDir, { recursive: true });
  const frameName = 'scene_01.jpg';
  const framePath = resolveSafePath(scenesDir, frameName);

  try {
    const res = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(framePath, buf);
      return [
        {
          timestamp: 0,
          thumbnailUrl: `/api/projects/${encodeURIComponent(projectId)}/scenes/${frameName}`,
          sceneScore: 0.9,
        },
      ];
    }
  } catch {
    // Non-fatal
  }
  return [];
}

/**
 * Fallback multimodal transcription directly via Gemini YouTube URL understanding
 * when the cloud IP is rate-limited by YouTube's raw MP4 download bot-check.
 */
export async function transcribeYouTubeUrlWithGemini(params: {
  projectId: string;
  canonicalUrl: string;
  languageHint?: 'auto' | 'en' | 'fr' | 'ar';
}): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string; estimatedDurationSec: number }> {
  const { projectId, canonicalUrl, languageHint = 'auto' } = params;
  const ai = getGeminiClient();

  const hintText =
    languageHint === 'auto'
      ? 'Automatically detect the primary spoken language (English, French, Arabic, etc.).'
      : `Language hint: ${languageHint}.`;

  const response = await withModelFallback(
    ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
    (model) =>
      ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              fileData: {
                fileUri: canonicalUrl,
                mimeType: 'video/mp4',
              },
            },
            {
              text: `Watch and transcribe this YouTube video into accurate, sentence-complete timestamped segments.
${hintText}
Preserve complete sentence boundaries and identify distinct speakers (e.g., Speaker 1, Host, Guest).
Estimate the total video duration in seconds accurately.
Return strictly valid JSON matching the schema.`,
            },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLanguage: { type: Type.STRING },
              languageCode: { type: Type.STRING },
              estimatedDurationSec: { type: Type.NUMBER },
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    start: { type: Type.NUMBER },
                    end: { type: Type.NUMBER },
                    speaker: { type: Type.STRING },
                    text: { type: Type.STRING },
                  },
                  required: ['start', 'end', 'speaker', 'text'],
                },
              },
            },
            required: ['detectedLanguage', 'languageCode', 'estimatedDurationSec', 'segments'],
          },
        },
      }),
    'youtube-url-transcribe'
  );

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    detectedLanguage?: string;
    languageCode?: string;
    estimatedDurationSec?: number;
    segments?: Array<{ start: number; end: number; speaker: string; text: string }>;
  };

  const segments: TranscriptSegment[] = (parsed.segments ?? [])
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s, idx) => ({
      id: `seg_${idx + 1}`,
      start: Math.max(0, Number(Number(s.start || 0).toFixed(2))),
      end: Math.max(0.5, Number(Number(s.end || (s.start || 0) + 2).toFixed(2))),
      speaker: (s.speaker || 'Speaker 1').trim(),
      text: s.text.trim(),
      language: parsed.languageCode || 'en',
    }));

  const maxEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const estimatedDurationSec = Math.max(
    maxEnd,
    Number(parsed.estimatedDurationSec || 0),
    30
  );

  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    resolveSafePath(projectDir, 'transcript.json'),
    JSON.stringify(
      {
        detectedLanguage: parsed.detectedLanguage || 'English',
        languageCode: parsed.languageCode || 'en',
        segments,
      },
      null,
      2
    ),
    'utf-8'
  );

  return {
    segments,
    detectedLanguage: parsed.detectedLanguage || 'English',
    estimatedDurationSec,
  };
}

export function isYouTubeBotCheckError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('bot verification') ||
    msg.includes('Sign in to confirm') ||
    msg.includes('BOT_CHECK')
  );
}

function normalizeYouTubeError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Sign in to confirm') || msg.includes('BOT_CHECK')) {
    return new Error(
      'YouTube requested bot verification for this server IP. Expand "Optional YouTube Cookies" and paste your browser Cookie header (or run locally on your personal machine) to import this video.'
    );
  }
  if (msg.includes('LOGIN_REQUIRED') || msg.includes('Private video')) {
    return new Error(
      'This YouTube video is private or requires sign-in. Provide valid YouTube Cookies or choose a public video.'
    );
  }
  if (msg.includes('UNPLAYABLE') || msg.includes('Video unavailable')) {
    return new Error('YouTube video is unavailable or region-restricted.');
  }
  return err instanceof Error ? err : new Error(msg);
}
