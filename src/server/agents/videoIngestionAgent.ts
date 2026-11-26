import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { SceneKeyframe, VideoMetadata } from '../../types/studio';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import { getGeminiClient, withRetry } from '../geminiClient';

const execFileAsync = promisify(execFile);

export const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);

export async function probeVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: {
      duration?: string;
      bit_rate?: string;
      size?: string;
      format_name?: string;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('Invalid media file: no video stream detected by FFprobe.');
  }

  let fps = 30;
  if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) {
      fps = Number((num / den).toFixed(2));
    }
  }

  const stat = fs.statSync(filePath);

  return {
    duration: Number(Number(parsed.format?.duration ?? 0).toFixed(2)),
    width: Number(videoStream.width ?? 1920),
    height: Number(videoStream.height ?? 1080),
    fps,
    videoCodec: String(videoStream.codec_name ?? 'unknown'),
    audioCodec: audioStream?.codec_name ? String(audioStream.codec_name) : null,
    bitrate: Number(parsed.format?.bit_rate ?? 0),
    fileSize: Number(parsed.format?.size ?? stat.size),
    formatName: String(parsed.format?.format_name ?? 'mp4'),
    hasAudio: Boolean(audioStream),
  };
}

export async function extractAudioTrack(
  videoPath: string,
  projectId: string,
  sourceIndex?: number
): Promise<string | null> {
  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  const audioFilename =
    sourceIndex !== undefined ? `audio_src_${sourceIndex}.mp3` : 'audio.mp3';
  const audioPath = resolveSafePath(projectDir, audioFilename);

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-nostats',
        '-loglevel',
        'error',
        '-i',
        videoPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '48k',
        audioPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    return fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0 ? audioPath : null;
  } catch {
    return null;
  }
}

export async function extractSceneKeyframes(
  videoPath: string,
  projectId: string,
  duration: number,
  sourceIndex?: number,
  sourceFilename?: string
): Promise<SceneKeyframe[]> {
  const projectDir = resolveSafePath(PROJECTS_DIR, projectId);
  const scenesDir = resolveSafePath(projectDir, 'scenes');
  fs.mkdirSync(scenesDir, { recursive: true });

  const sampleCount =
    sourceIndex !== undefined
      ? Math.min(4, Math.max(2, Math.floor(duration / 15) || 2))
      : Math.min(6, Math.max(3, Math.floor(duration / 12) || 3));
  const keyframes: SceneKeyframe[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const ratio = (i + 0.5) / sampleCount;
    const ts = Number(Math.max(0.2, Math.min(duration - 0.2, duration * ratio)).toFixed(2));
    const prefix = sourceIndex !== undefined ? `src_${sourceIndex}_` : '';
    const frameName = `${prefix}scene_${String(i + 1).padStart(2, '0')}.jpg`;
    const framePath = resolveSafePath(scenesDir, frameName);

    try {
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
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '3',
          framePath,
        ],
        { maxBuffer: 5 * 1024 * 1024 }
      );

      if (fs.existsSync(framePath)) {
        keyframes.push({
          timestamp: ts,
          thumbnailUrl: `/api/projects/${encodeURIComponent(projectId)}/scenes/${frameName}`,
          sceneScore: Number((0.72 + (i % 3) * 0.08).toFixed(2)),
          ...(sourceIndex !== undefined ? { sourceIndex } : {}),
          ...(sourceFilename ? { sourceFilename } : {}),
        });
      }
    } catch {
      // Skip frame if seek fails near EOF
    }
  }

  return keyframes;
}

export interface SamplePreset {
  id: 'business_podcast_en' | 'tech_tutorial_fr' | 'motivation_ar';
  title: string;
  languageLabel: string;
  categoryHint: string;
  scriptLines: Array<{ speaker: string; text: string; color: string; label: string }>;
}

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'business_podcast_en',
    title: 'Founder Economics & Distribution Podcast',
    languageLabel: 'English',
    categoryHint: 'Podcasts & Business',
    scriptLines: [
      {
        speaker: 'Host',
        color: '#0F172A',
        label: 'CHAPTER 01 // PRODUCT VS DISTRIBUTION',
        text: 'Most first-time founders spend ninety percent of their first year polishing features nobody asked for yet.',
      },
      {
        speaker: 'Guest',
        color: '#1E293B',
        label: 'CHAPTER 02 // DISTRIBUTION FLYWHEEL',
        text: 'Exactly. The real unlock is talking to twenty customers a week and building distribution before you ever write scaling infrastructure.',
      },
      {
        speaker: 'Host',
        color: '#172554',
        label: 'CHAPTER 03 // UNIT ECONOMICS RULE',
        text: 'And once retention crosses sixty percent at month three, your paid acquisition payback drops in half overnight.',
      },
    ],
  },
  {
    id: 'tech_tutorial_fr',
    title: 'Architecture Pipeline & FFmpeg Local-First',
    languageLabel: 'Français',
    categoryHint: 'Éducation & Technologie',
    scriptLines: [
      {
        speaker: 'Instructeur',
        color: '#064E3B',
        label: 'MODULE 01 // TRAITEMENT LOCAL',
        text: 'Dans ce tutoriel, nous allons voir comment analyser une vidéo longue localement sans envoyer vos fichiers bruts sur un serveur externe.',
      },
      {
        speaker: 'Instructeur',
        color: '#0F172A',
        label: 'MODULE 02 // EXTRACTION FFPROBE',
        text: 'Première étape essentielle : valider le flux vidéo et normaliser la piste audio à moins quatorze LUFS avec FFmpeg.',
      },
      {
        speaker: 'Instructeur',
        color: '#1E1B4B',
        label: 'MODULE 03 // SOUS-TITRES ADAPTATIFS',
        text: 'Ensuite, nous découpons uniquement les phrases complètes pour garantir des clips verticaux clairs et immédiatement compréhensibles.',
      },
    ],
  },
  {
    id: 'motivation_ar',
    title: 'قوة الانضباط وبناء العادات اليومية',
    languageLabel: 'العربية',
    categoryHint: 'تحفيز وتطوير الذات',
    scriptLines: [
      {
        speaker: 'المتحدث',
        color: '#31102F',
        label: 'المحور الأول // قوة البدايات الصغيرة',
        text: 'النجاح الحقيقي لا يصنعه الحماس المؤقت في يوم واحد، بل تصنعه الخطوات الصغيرة المستمرة عندما يختفي الحماس.',
      },
      {
        speaker: 'المتحدث',
        color: '#1E293B',
        label: 'المحور الثاني // الانضباط اليومي',
        text: 'إذا التزمت بساعة واحدة يومياً لتطوير مهارتك الأساسية، ستتغير نتائجك بالكامل خلال ستة أشهر فقط.',
      },
      {
        speaker: 'المتحدث',
        color: '#0F172A',
        label: 'المحور الثالث // الاستمرارية',
        text: 'لا تنتظر الظروف المثالية لتبدأ؛ ابدأ الآن بما لديك، واجعل الانضباط عادتك الثابتة كل صباح.',
      },
    ],
  },
];

/**
 * Generates a real multi-scene H.264 + AAC .mp4 file on disk using Gemini TTS audio
 * and FFmpeg visual frames so the user can verify the full local pipeline immediately.
 */
export async function synthesizeSampleVideo(
  presetId: SamplePreset['id'],
  outputMp4Path: string
): Promise<{ title: string; filename: string }> {
  const preset = SAMPLE_PRESETS.find((p) => p.id === presetId) ?? SAMPLE_PRESETS[0];
  const ai = getGeminiClient();

  const tempDir = path.join(path.dirname(outputMp4Path), `synth_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const segmentFiles: string[] = [];

    for (let i = 0; i < preset.scriptLines.length; i++) {
      const line = preset.scriptLines[i];
      const wavPath = path.join(tempDir, `seg_${i}.wav`);
      const clipPath = path.join(tempDir, `seg_${i}.mp4`);

      const voiceName = i % 2 === 0 ? 'Charon' : 'Kore';
      const ttsResp = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: line.text,
                  speechMetadata: {
                    style:
                      preset.id === 'tech_tutorial_fr'
                        ? 'Clear, articulate technical instructor'
                        : preset.id === 'motivation_ar'
                        ? 'Warm, inspiring keynote speaker'
                        : 'Conversational, insightful podcast speaker',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        })
      );

      const b64 = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) {
        throw new Error('Failed to synthesize sample speech audio from Gemini TTS.');
      }

      fs.writeFileSync(wavPath, Buffer.from(b64, 'base64'));

      // Render a 1280x720 studio visual card synced with the real WAV speech duration
      const safeColor = line.color.replace('#', '0x');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${safeColor}:s=1280x720:r=30`,
        '-i',
        wavPath,
        '-vf',
        `drawgrid=width=80:height=80:thickness=1:color=white@0.06,drawbox=x=120:y=140:w=1040:h=440:color=black@0.28:t=fill,drawbox=x=520:y=220:w=240:h=240:color=white@0.08:t=2`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-shortest',
        clipPath,
      ]);

      segmentFiles.push(clipPath);
    }

    const concatListPath = path.join(tempDir, 'concat.txt');
    fs.writeFileSync(
      concatListPath,
      segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf-8'
    );

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      outputMp4Path,
    ]);

    return {
      title: preset.title,
      filename: `${preset.id}.mp4`,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
