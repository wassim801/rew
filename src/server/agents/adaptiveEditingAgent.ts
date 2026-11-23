import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import type {
  HighlightRecord,
  StudioSettings,
  TranscriptSegment,
  VideoMetadata,
} from '../../types/studio';
import { EDITING_PROFILES } from '../categories';
import { PROJECTS_DIR, resolveSafePath } from '../db';

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

function buildSubtitleChunks(
  transcript: TranscriptSegment[],
  clipStart: number,
  clipEnd: number
): Array<{ start: number; end: number; text: string }> {
  const overlapping = transcript.filter((s) => s.end > clipStart && s.start < clipEnd);
  const chunks: Array<{ start: number; end: number; text: string }> = [];

  for (const seg of overlapping) {
    const segStart = Math.max(clipStart, seg.start);
    const segEnd = Math.min(clipEnd, seg.end);
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const wordsPerChunk = 5;
    const chunkCount = Math.ceil(words.length / wordsPerChunk);
    const segDur = Math.max(0.5, segEnd - segStart);

    for (let i = 0; i < chunkCount; i++) {
      const slice = words.slice(i * wordsPerChunk, (i + 1) * wordsPerChunk);
      const cStart = segStart + (segDur * i) / chunkCount - clipStart;
      const cEnd = segStart + (segDur * (i + 1)) / chunkCount - clipStart;
      chunks.push({
        start: Math.max(0, cStart),
        end: Math.max(cStart + 0.35, cEnd),
        text: slice.join(' '),
      });
    }
  }

  return chunks;
}

function applyKeywordHighlighting(
  text: string,
  keywords: string[],
  highlightAssColor: string,
  stylePreset: HighlightRecord['subtitleStyle']
): string {
  const safe = escapeAssText(text);
  if (!keywords.length || stylePreset === 'minimal-caption') {
    return safe;
  }

  const lowerKeywords = keywords
    .flatMap((k) => k.toLowerCase().split(/\s+/))
    .filter((w) => w.length >= 3);

  const tokens = safe.split(' ');
  return tokens
    .map((tok) => {
      const cleanTok = tok.replace(/[.,!?;:"'()«»؟،]/g, '').toLowerCase();
      if (lowerKeywords.includes(cleanTok)) {
        return `{\\c${highlightAssColor}\\b1}${tok}{\\c&H00FFFFFF&\\b0}`;
      }
      return tok;
    })
    .join(' ');
}

function generateAssSubtitleFile(params: {
  outAssPath: string;
  highlight: HighlightRecord;
  transcript: TranscriptSegment[];
  settings: StudioSettings;
  languageCode: string;
}): void {
  const { outAssPath, highlight, transcript, settings, languageCode } = params;
  const isArabic = languageCode === 'ar';
  const fontName = isArabic ? 'Noto Sans Arabic' : 'Noto Sans';
  const fontSize = Math.max(36, Math.min(72, settings.subtitleFontSize || 54));
  const assHighlightColor = hexToAssColor(highlight.highlightColor || settings.defaultHighlightColor);

  const boldFlag =
    highlight.subtitleStyle === 'bold-highlight' || highlight.subtitleStyle === 'karaoke-pop'
      ? -1
      : 0;
  const outlineWidth = highlight.subtitleStyle === 'minimal-caption' ? 2 : 3.5;
  const marginV = highlight.subtitleStyle === 'minimal-caption' ? 230 : 320;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H000A0F1A,&H80000000,${boldFlag},0,0,0,100,100,0,0,1,${outlineWidth},1.5,2,64,64,${marginV},1
Style: Watermark,Noto Sans,26,&H99E2E8F0,&H000000FF,&H80000000,&H00000000,0,0,0,0,100,100,0.5,0,1,1.5,0,9,40,48,54,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const chunks = buildSubtitleChunks(transcript, highlight.startTime, highlight.endTime);
  const clipDur = Math.max(1, highlight.endTime - highlight.startTime);

  const lines: string[] = [];
  for (const chunk of chunks) {
    const startStr = formatAssTime(chunk.start);
    const endStr = formatAssTime(Math.min(clipDur, chunk.end));
    const styled = applyKeywordHighlighting(
      chunk.text,
      highlight.keywords,
      assHighlightColor,
      highlight.subtitleStyle
    );
    const animTag =
      highlight.subtitleStyle === 'karaoke-pop'
        ? '{\\fscx108\\fscy108\\t(0,110,\\fscx100\\fscy100)}'
        : '{\\fad(60,60)}';
    lines.push(`Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${animTag}${styled}`);
  }

  if (highlight.watermarkEnabled && settings.watermarkText.trim()) {
    const wmText = escapeAssText(settings.watermarkText.trim());
    lines.push(
      `Dialogue: 1,0:00:00.00,${formatAssTime(clipDur)},Watermark,,0,0,0,,${wmText}`
    );
  }

  fs.writeFileSync(outAssPath, header + lines.join('\n') + '\n', 'utf-8');
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

  generateAssSubtitleFile({
    outAssPath: assPath,
    highlight,
    transcript,
    settings,
    languageCode,
  });

  const profile = EDITING_PROFILES[highlight.editingProfile] ?? EDITING_PROFILES.Minimal;
  const clipDuration = Math.max(1, Number((highlight.endTime - highlight.startTime).toFixed(2)));
  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Build 9:16 1080x1920 video filtergraph (crop on source resolution first to avoid unnecessary multi-MP upscaling)
  let baseVideoFilter: string;
  if (highlight.cropMode === 'fit-blur') {
    baseVideoFilter =
      `split[bg][fg];` +
      `[bg]crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='(iw-ow)/2':y='(ih-oh)/2',scale=270:480:flags=bilinear,boxblur=8:2,scale=1080:1920:flags=bilinear[bgb];` +
      `[fg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=bilinear,scale='trunc(iw/2)*2':'trunc(ih/2)*2'[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  } else {
    let cropXExpr = '(iw-ow)/2';
    if (highlight.cropMode === 'left-subject') cropXExpr = '(iw-ow)*0.22';
    if (highlight.cropMode === 'right-subject') cropXExpr = '(iw-ow)*0.78';
    baseVideoFilter =
      `crop=w='trunc(min(iw,ih*9/16)/2)*2':h='trunc(min(ih,iw*16/9)/2)*2':x='${cropXExpr}':y='(ih-oh)/2',` +
      `scale=1080:1920:flags=bilinear,setsar=1`;
  }

  const postFilters: string[] = [];
  if (highlight.dynamicZoom && profile.allowDynamicZoom) {
    postFilters.push(
      `scale=w='max(1080,trunc(iw*(1+0.03*(1-cos(t*0.9)))/2)*2)':h='max(1920,trunc(ih*(1+0.03*(1-cos(t*0.9)))/2)*2)':eval=frame:flags=bilinear,crop=1080:1920:x='(iw-1080)/2':y='(ih-1920)/2'`
    );
  }
  if (profile.fadeTransitionSec > 0 && clipDuration > 2.5) {
    const fade = profile.fadeTransitionSec;
    const fadeOutStart = Math.max(0.5, clipDuration - fade).toFixed(2);
    postFilters.push(`fade=t=in:st=0:d=${fade},fade=t=out:st=${fadeOutStart}:d=${fade}`);
  }
  postFilters.push(`ass='${escapedAss}'`);

  const useComplex = highlight.cropMode === 'fit-blur';
  const args: string[] = [
    '-y',
    '-ss',
    String(highlight.startTime),
    '-t',
    String(clipDuration),
    '-i',
    sourcePath,
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
    if (highlight.normalizeAudio) {
      args.push('-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`);
    }
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
    '22',
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
