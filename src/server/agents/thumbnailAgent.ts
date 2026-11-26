import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp, { type OverlayOptions } from 'sharp';
import { promisify } from 'util';
import type {
  CropFocusMode,
  HighlightRecord,
  ProjectSourceVideo,
  SceneKeyframe,
  ThumbnailVibeStyle,
} from '../../types/studio';
import { PROJECTS_DIR, resolveSafePath } from '../db';

const execFileAsync = promisify(execFile);

const THUMB_W = 720;
const THUMB_H = 1280;

export const VALID_THUMBNAIL_STYLES: ReadonlyArray<Exclude<ThumbnailVibeStyle, 'auto'>> = [
  'viral-pop',
  'lifestyle-warm',
  'cinematic-editorial',
  'comedy-sticker',
  'tech-neon',
  'podcast-quote',
];

function escapePango(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXml(input: string): string {
  return escapePango(input);
}

function hasArabicScript(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

export function splitGraphemeEmojis(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const emojiRe = /\p{Extended_Pictographic}/u;
  const out: string[] = [];

  try {
    const Seg = (Intl as unknown as { Segmenter?: new (loc: string, opts: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
    if (Seg) {
      const segmenter = new Seg('en', { granularity: 'grapheme' });
      for (const { segment } of segmenter.segment(trimmed)) {
        const s = segment.trim();
        if (s && emojiRe.test(s) && !out.includes(s)) {
          out.push(s);
        }
      }
      return out.slice(0, 3);
    }
  } catch {
    // Fallback below
  }

  for (const ch of Array.from(trimmed)) {
    if (emojiRe.test(ch) && !out.includes(ch)) {
      out.push(ch);
    }
  }
  return out.slice(0, 3);
}

function normalizeHexColor(hex: string | undefined, fallback: string): string {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) {
    return hex.trim().toUpperCase();
  }
  return fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 250;
  const g = parseInt(clean.slice(2, 4), 16) || 204;
  const b = parseInt(clean.slice(4, 6), 16) || 21;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function resolveThumbnailStyle(
  highlight: Pick<
    HighlightRecord,
    'thumbnailStyle' | 'editingProfile' | 'categoryId' | 'categoryName' | 'bgmVibe' | 'sfxMode' | 'title' | 'description'
  >,
  projectBrief?: string
): Exclude<ThumbnailVibeStyle, 'auto'> {
  if (
    highlight.thumbnailStyle &&
    highlight.thumbnailStyle !== 'auto' &&
    VALID_THUMBNAIL_STYLES.includes(highlight.thumbnailStyle)
  ) {
    return highlight.thumbnailStyle;
  }

  const hay = `${highlight.categoryId} ${highlight.categoryName} ${highlight.title} ${highlight.description} ${projectBrief ?? ''}`.toLowerCase();

  if (
    /(holiday|christmas|santa|gift|kitsch|beauty|hair|makeup|skincare|fashion|lifestyle|family|mom|sister|travel|vlog|aesthetic)/.test(
      hay
    ) ||
    highlight.editingProfile === 'Travel' ||
    highlight.bgmVibe === 'cinematic-warm'
  ) {
    if (/(comedy|funny|steal|tax|meme|fail|prank|laugh)/.test(hay) && highlight.editingProfile === 'Comedy') {
      return 'comedy-sticker';
    }
    return 'lifestyle-warm';
  }

  if (
    highlight.editingProfile === 'Comedy' ||
    /(comedy|funny|meme|fail|roast|prank|joke|hilarious|blooper)/.test(hay)
  ) {
    return 'comedy-sticker';
  }

  if (
    highlight.editingProfile === 'Gaming' ||
    highlight.editingProfile === 'Educational' ||
    /(tech|code|coding|software|ai|tutorial|hack|gaming|game|app|crypto|science|howto)/.test(hay)
  ) {
    return 'tech-neon';
  }

  if (
    highlight.editingProfile === 'Podcast' ||
    /(podcast|interview|debate|speech|motivation|business|mindset|quote|founder|money)/.test(hay)
  ) {
    return 'podcast-quote';
  }

  if (
    highlight.editingProfile === 'Cinematic' ||
    highlight.editingProfile === 'Minimal' ||
    /(cinematic|documentary|story|emotional|film)/.test(hay)
  ) {
    return 'cinematic-editorial';
  }

  return 'viral-pop';
}

export function deriveFallbackThumbnailCopy(
  highlight: Pick<
    HighlightRecord,
    'thumbnailText' | 'thumbnailEmojis' | 'hookHeadline' | 'title' | 'description' | 'categoryName' | 'keywords'
  >,
  style: Exclude<ThumbnailVibeStyle, 'auto'>,
  projectBrief?: string
): { text: string; emojis: string[] } {
  const existingText = (highlight.thumbnailText || '').trim();
  const baseSource = existingText || (highlight.hookHeadline || '').trim() || highlight.title.trim();

  // Keep cover writing tight & bold (2 to 5 punchy words, <= 34 chars when possible)
  const words = baseSource.replace(/[“”"']/g, '').split(/\s+/).filter(Boolean);
  let text = existingText
    ? words.slice(0, 6).join(' ')
    : words.slice(0, 4).join(' ');
  if (!text) text = 'WATCH THIS MOMENT';
  if (!hasArabicScript(text) && style !== 'cinematic-editorial' && style !== 'podcast-quote') {
    text = text.toUpperCase();
  }

  const existingEmojis = splitGraphemeEmojis(highlight.thumbnailEmojis);
  if (existingEmojis.length >= 2) {
    return { text, emojis: existingEmojis };
  }

  const hay = `${highlight.title} ${highlight.hookHeadline ?? ''} ${highlight.description} ${
    highlight.keywords?.join(' ') ?? ''
  } ${projectBrief ?? ''}`.toLowerCase();

  const picked: string[] = [...existingEmojis];
  const add = (e: string) => {
    if (!picked.includes(e) && picked.length < 3) picked.push(e);
  };

  if (/(santa|christmas|holiday|xmas|december)/.test(hay)) add('🎅');
  if (/(gift|present|drop|haul|advent|box|surprise)/.test(hay)) add('🎁');
  if (/(hair|curl|kitsch|beauty|glow|glam|skincare)/.test(hay)) add('✨');
  if (/(steal|tax|stole|funny|hilarious|laugh|comedy|cry|lol)/.test(hay)) add('😭');
  if (/(secret|mystery|cliffhanger|who is|wait|shock|omg|no way|insane|wild)/.test(hay)) add('👀');
  if (/(mistake|wrong|stop|never|warning|fail|avoid)/.test(hay)) add('🚨');
  if (/(money|rich|cash|dollar|100k|profit|business|sale)/.test(hay)) add('💰');
  if (/(mom|sister|family|love|sweet|heart)/.test(hay)) add('💖');
  if (/(tech|ai|code|hack|tip|smart|brain|learn)/.test(hay)) add('⚡');
  if (/(podcast|talk|truth|mic|real|debate)/.test(hay)) add('🎙️');
  if (/(game|gaming|win|clutch|pro)/.test(hay)) add('🎮');

  const styleDefaults: Record<Exclude<ThumbnailVibeStyle, 'auto'>, string[]> = {
    'viral-pop': ['🔥', '👀', '⚡'],
    'lifestyle-warm': ['✨', '💖', '🎁'],
    'cinematic-editorial': ['🎬', '✨'],
    'comedy-sticker': ['😂', '💀', '🔥'],
    'tech-neon': ['⚡', '🧠', '🚀'],
    'podcast-quote': ['🎙️', '💯', '🔥'],
  };

  for (const fallbackEmoji of styleDefaults[style]) {
    if (picked.length >= 3) break;
    add(fallbackEmoji);
  }

  return { text, emojis: picked.slice(0, 3) };
}

function resolveBestThumbnailFrame(params: {
  highlight: HighlightRecord;
  sourcePath?: string | null;
  sources?: ProjectSourceVideo[];
  scenes?: SceneKeyframe[];
  durationFallback?: number;
}): {
  videoPath: string | null;
  timestamp: number;
  sceneFallbackUrl?: string;
} {
  const { highlight, sourcePath, sources, scenes, durationFallback } = params;

  // Remix montage: pick the user-flagged segment or best visual moment (product > hook > payoff > first)
  if (highlight.editSegments && highlight.editSegments.length > 0) {
    const segs = highlight.editSegments;
    const chosen =
      segs.find((s) => s.isThumbnailFrame) ??
      segs.find((s) => s.role === 'product') ??
      segs.find((s) => s.role === 'hook') ??
      segs.find((s) => s.role === 'payoff') ??
      segs[0];

    const segSrc = sources?.[chosen.sourceIndex];
    const segVideoPath =
      segSrc?.sourcePath && fs.existsSync(segSrc.sourcePath)
        ? segSrc.sourcePath
        : sourcePath && fs.existsSync(sourcePath)
        ? sourcePath
        : null;

    const segDur = Math.max(1, chosen.endTime - chosen.startTime);
    const ts =
      typeof highlight.thumbnailTimestamp === 'number' &&
      highlight.thumbnailTimestamp >= chosen.startTime &&
      highlight.thumbnailTimestamp <= chosen.endTime
        ? highlight.thumbnailTimestamp
        : Number((chosen.startTime + Math.min(2.2, segDur * 0.35)).toFixed(2));

    const segScene = (segSrc?.scenes ?? scenes ?? []).find(
      (sc) =>
        (sc.sourceIndex === undefined || sc.sourceIndex === chosen.sourceIndex) &&
        sc.timestamp >= chosen.startTime &&
        sc.timestamp <= chosen.endTime
    );

    return {
      videoPath: segVideoPath,
      timestamp: ts,
      sceneFallbackUrl: segScene?.thumbnailUrl ?? scenes?.[0]?.thumbnailUrl,
    };
  }

  // Single-source highlight
  const validSource = sourcePath && fs.existsSync(sourcePath) ? sourcePath : null;
  const clipDur = Math.max(2, highlight.endTime - highlight.startTime);

  if (typeof highlight.thumbnailTimestamp === 'number' && highlight.thumbnailTimestamp >= 0) {
    const clamped = Math.min(
      durationFallback ? Math.max(0.5, durationFallback - 0.5) : highlight.endTime,
      Math.max(0, highlight.thumbnailTimestamp)
    );
    return {
      videoPath: validSource,
      timestamp: Number(clamped.toFixed(2)),
      sceneFallbackUrl: scenes?.[0]?.thumbnailUrl,
    };
  }

  const matchingScenes = (scenes ?? []).filter(
    (sc) => sc.timestamp >= highlight.startTime + 0.4 && sc.timestamp <= highlight.endTime - 0.4
  );
  if (matchingScenes.length > 0) {
    const bestScene = [...matchingScenes].sort((a, b) => b.sceneScore - a.sceneScore)[0];
    return {
      videoPath: validSource,
      timestamp: Number(bestScene.timestamp.toFixed(2)),
      sceneFallbackUrl: bestScene.thumbnailUrl,
    };
  }

  const defaultTs = Number((highlight.startTime + Math.min(3.5, clipDur * 0.32)).toFixed(2));
  return {
    videoPath: validSource,
    timestamp: defaultTs,
    sceneFallbackUrl: scenes?.[0]?.thumbnailUrl,
  };
}

function buildThumbnailVideoFilter(
  cropMode: CropFocusMode,
  style: Exclude<ThumbnailVibeStyle, 'auto'>
): string {
  const gradeByStyle: Record<Exclude<ThumbnailVibeStyle, 'auto'>, string> = {
    'viral-pop': 'eq=contrast=1.08:saturation=1.24:brightness=0.02,unsharp=5:5:0.45:3:3:0.0',
    'lifestyle-warm': 'eq=contrast=1.04:saturation=1.18:brightness=0.03:gamma_r=1.04:gamma_b=0.96,unsharp=5:5:0.4:3:3:0.0',
    'cinematic-editorial': 'eq=contrast=1.12:saturation=0.95:brightness=-0.02:gamma=0.98,unsharp=5:5:0.45:3:3:0.0',
    'comedy-sticker': 'eq=contrast=1.10:saturation=1.26:brightness=0.03,unsharp=5:5:0.5:3:3:0.0',
    'tech-neon': 'eq=contrast=1.10:saturation=1.12:brightness=-0.01:gamma_b=1.06,unsharp=5:5:0.5:3:3:0.0',
    'podcast-quote': 'eq=contrast=1.08:saturation=1.06:brightness=-0.01,unsharp=5:5:0.4:3:3:0.0',
  };
  const grade = gradeByStyle[style];

  if (cropMode === 'fit-blur') {
    return `[0:v]split=2[bg][fg];[bg]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H},boxblur=24:4,eq=brightness=-0.12[bgb];[fg]scale=${THUMB_W}:-2:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${grade}`;
  }

  const cropX =
    cropMode === 'left-subject'
      ? `(iw-${THUMB_W})*0.18`
      : cropMode === 'right-subject'
      ? `(iw-${THUMB_W})*0.82`
      : `(iw-${THUMB_W})/2`;

  return `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}:${cropX}:(ih-${THUMB_H})/2,${grade}`;
}

async function extractCleanVerticalFrameBuffer(params: {
  projectId: string;
  highlightId: string;
  videoPath: string | null;
  timestamp: number;
  cropMode: CropFocusMode;
  style: Exclude<ThumbnailVibeStyle, 'auto'>;
  sceneFallbackUrl?: string;
  accentHex: string;
}): Promise<Buffer> {
  const { projectId, highlightId, videoPath, timestamp, cropMode, style, sceneFallbackUrl, accentHex } = params;
  const thumbsDir = resolveSafePath(PROJECTS_DIR, projectId, 'thumbnails');
  fs.mkdirSync(thumbsDir, { recursive: true });
  const tmpRawPng = resolveSafePath(thumbsDir, `_raw_${highlightId}_${Date.now()}.png`);

  try {
    if (videoPath && fs.existsSync(videoPath)) {
      const preSeek = Math.max(0, Number((timestamp - 3).toFixed(2)));
      const fineSeek = Math.max(0, Number((timestamp - preSeek).toFixed(2)));
      const vf = buildThumbnailVideoFilter(cropMode, style);
      const args =
        cropMode === 'fit-blur'
          ? [
              '-y',
              '-nostats',
              '-loglevel',
              'error',
              '-ss',
              String(preSeek),
              '-i',
              videoPath,
              '-ss',
              String(fineSeek),
              '-filter_complex',
              vf,
              '-frames:v',
              '1',
              tmpRawPng,
            ]
          : [
              '-y',
              '-nostats',
              '-loglevel',
              'error',
              '-ss',
              String(preSeek),
              '-i',
              videoPath,
              '-ss',
              String(fineSeek),
              '-vf',
              vf,
              '-frames:v',
              '1',
              tmpRawPng,
            ];

      try {
        await execFileAsync('ffmpeg', args, { maxBuffer: 4 * 1024 * 1024 });
        if (fs.existsSync(tmpRawPng) && fs.statSync(tmpRawPng).size > 2048) {
          return fs.readFileSync(tmpRawPng);
        }
      } catch {
        // Fallback smoothly to scene JPEG or atmospheric canvas below
      }
    }

    if (sceneFallbackUrl) {
      const fn = sceneFallbackUrl.split('/').pop()?.split('?')[0];
      if (fn) {
        try {
          const scenePath = resolveSafePath(PROJECTS_DIR, projectId, 'scenes', fn);
          if (fs.existsSync(scenePath)) {
            return await sharp(scenePath)
              .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'centre' })
              .modulate({ saturation: 1.15, brightness: 0.98 })
              .png()
              .toBuffer();
          }
        } catch {
          // Fall through to stylized gradient canvas
        }
      }
    }

    // Stylish gradient backdrop when no local video/scene frame exists yet
    const bgSvg = `<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0F172A"/>
          <stop offset="52%" stop-color="#1E293B"/>
          <stop offset="100%" stop-color="#090E1A"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.5" cy="0.38" r="0.55">
          <stop offset="0%" stop-color="${hexToRgba(accentHex, 0.35)}"/>
          <stop offset="100%" stop-color="rgba(15,23,42,0)"/>
        </radialGradient>
      </defs>
      <rect width="${THUMB_W}" height="${THUMB_H}" fill="url(#bg)"/>
      <rect width="${THUMB_W}" height="${THUMB_H}" fill="url(#glow)"/>
    </svg>`;
    return await sharp(Buffer.from(bgSvg)).png().toBuffer();
  } finally {
    if (fs.existsSync(tmpRawPng)) {
      try {
        fs.unlinkSync(tmpRawPng);
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

function buildVibeSvgOverlay(params: {
  style: Exclude<ThumbnailVibeStyle, 'auto'>;
  accentHex: string;
  categoryLabel: string;
  textBoxHeight: number;
  headlineTopY: number;
}): Buffer {
  const { style, accentHex, categoryLabel, textBoxHeight, headlineTopY } = params;
  const safeKicker = escapeXml(categoryLabel.toUpperCase().slice(0, 26));
  const boxTop = Math.max(760, headlineTopY - 24);
  const boxH = Math.min(THUMB_H - boxTop - 72, textBoxHeight + 48);

  if (style === 'lifestyle-warm') {
    return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="topWarm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(28,16,12,0.58)"/>
          <stop offset="100%" stop-color="rgba(28,16,12,0)"/>
        </linearGradient>
        <linearGradient id="botWarm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(20,12,10,0)"/>
          <stop offset="35%" stop-color="rgba(20,12,10,0.62)"/>
          <stop offset="100%" stop-color="rgba(12,8,8,0.92)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${THUMB_W}" height="240" fill="url(#topWarm)"/>
      <rect x="0" y="700" width="${THUMB_W}" height="${THUMB_H - 700}" fill="url(#botWarm)"/>
      <rect x="48" y="48" width="${THUMB_W - 96}" height="${THUMB_H - 96}" rx="28" fill="none" stroke="rgba(255,244,232,0.22)" stroke-width="2"/>
      <rect x="56" y="${boxTop - 10}" width="112" height="5" rx="2.5" fill="${accentHex}"/>
      <text x="56" y="96" font-family="Noto Sans Display, sans-serif" font-size="22" font-weight="700" letter-spacing="3" fill="#FFF7ED" opacity="0.92">${safeKicker}</text>
    </svg>`);
  }

  if (style === 'comedy-sticker') {
    return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="botCom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0.72)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="760" width="${THUMB_W}" height="${THUMB_H - 760}" fill="url(#botCom)"/>
      <g transform="rotate(-2.2 ${THUMB_W / 2} ${boxTop + boxH / 2})">
        <rect x="48" y="${boxTop + 8}" width="${THUMB_W - 96}" height="${boxH}" rx="20" fill="#09090B"/>
        <rect x="42" y="${boxTop}" width="${THUMB_W - 96}" height="${boxH}" rx="20" fill="${accentHex}" stroke="#09090B" stroke-width="6"/>
      </g>
      <g transform="rotate(-3 170 92)">
        <rect x="48" y="64" width="260" height="44" rx="10" fill="#09090B"/>
        <rect x="44" y="60" width="260" height="44" rx="10" fill="#FFFFFF" stroke="#09090B" stroke-width="4"/>
        <text x="174" y="89" text-anchor="middle" font-family="Noto Sans Display, sans-serif" font-size="20" font-weight="800" fill="#09090B">${safeKicker.slice(0, 18)}</text>
      </g>
    </svg>`);
  }

  if (style === 'tech-neon') {
    return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="botTech" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(2,6,23,0)"/>
          <stop offset="40%" stop-color="rgba(2,6,23,0.72)"/>
          <stop offset="100%" stop-color="rgba(2,6,23,0.95)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="720" width="${THUMB_W}" height="${THUMB_H - 720}" fill="url(#botTech)"/>
      <path d="M 40 96 L 40 40 L 96 40 M ${THUMB_W - 96} 40 L ${THUMB_W - 40} 40 L ${THUMB_W - 40} 96 M 40 ${THUMB_H - 96} L 40 ${THUMB_H - 40} L 96 ${THUMB_H - 40} M ${THUMB_W - 96} ${THUMB_H - 40} L ${THUMB_W - 40} ${THUMB_H - 40} L ${THUMB_W - 40} ${THUMB_H - 96}" fill="none" stroke="${accentHex}" stroke-width="4" stroke-linecap="square"/>
      <rect x="52" y="62" width="12" height="24" fill="${accentHex}"/>
      <text x="76" y="82" font-family="JetBrains Mono, monospace" font-size="20" font-weight="700" letter-spacing="2" fill="${accentHex}">${safeKicker}</text>
      <rect x="44" y="${boxTop - 6}" width="${THUMB_W - 88}" height="${boxH + 12}" rx="12" fill="rgba(15,23,42,0.58)" stroke="${hexToRgba(accentHex, 0.6)}" stroke-width="2"/>
    </svg>`);
  }

  if (style === 'cinematic-editorial') {
    return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="topCin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(0,0,0,0.68)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
        </linearGradient>
        <linearGradient id="botCin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
          <stop offset="35%" stop-color="rgba(0,0,0,0.65)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0.95)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${THUMB_W}" height="220" fill="url(#topCin)"/>
      <rect x="0" y="700" width="${THUMB_W}" height="${THUMB_H - 700}" fill="url(#botCin)"/>
      <line x1="64" y1="88" x2="${THUMB_W - 64}" y2="88" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>
      <text x="${THUMB_W / 2}" y="72" text-anchor="middle" font-family="Noto Serif Display, serif" font-size="20" letter-spacing="5" fill="${accentHex}">${safeKicker}</text>
      <line x1="220" y1="${boxTop - 16}" x2="${THUMB_W - 220}" y2="${boxTop - 16}" stroke="${accentHex}" stroke-width="2"/>
    </svg>`);
  }

  if (style === 'podcast-quote') {
    return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="botPod" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(9,14,26,0)"/>
          <stop offset="32%" stop-color="rgba(9,14,26,0.72)"/>
          <stop offset="100%" stop-color="rgba(9,14,26,0.96)"/>
        </linearGradient>
      </defs>
      <rect x="0" y="690" width="${THUMB_W}" height="${THUMB_H - 690}" fill="url(#botPod)"/>
      <rect x="48" y="62" width="6" height="36" fill="${accentHex}"/>
      <text x="68" y="88" font-family="Noto Sans Display, sans-serif" font-size="22" font-weight="700" letter-spacing="2.5" fill="#F8FAFC" opacity="0.9">${safeKicker}</text>
      <text x="48" y="${boxTop + 26}" font-family="Noto Serif Display, serif" font-size="112" font-weight="700" fill="${accentHex}" opacity="0.92">“</text>
    </svg>`);
  }

  // 'viral-pop'
  return Buffer.from(`<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="topViral" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(5,8,20,0.64)"/>
        <stop offset="100%" stop-color="rgba(5,8,20,0)"/>
      </linearGradient>
      <linearGradient id="botViral" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(5,8,20,0)"/>
        <stop offset="32%" stop-color="rgba(5,8,20,0.68)"/>
        <stop offset="100%" stop-color="rgba(5,8,20,0.96)"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${THUMB_W}" height="230" fill="url(#topViral)"/>
    <rect x="0" y="700" width="${THUMB_W}" height="${THUMB_H - 700}" fill="url(#botViral)"/>
    <polygon points="0,0 380,0 330,68 0,68" fill="${accentHex}"/>
    <text x="28" y="43" font-family="Noto Sans Display, sans-serif" font-size="24" font-weight="900" letter-spacing="1.5" fill="#090E1A">${safeKicker.slice(0, 18)}</text>
    <rect x="190" y="${boxTop + boxH + 8}" width="${THUMB_W - 380}" height="7" rx="3.5" fill="${accentHex}"/>
  </svg>`);
}

function splitHeadlineIntoTwoLines(text: string, rtl: boolean): { line1: string; line2: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) {
    return { line1: words.join(' '), line2: '' };
  }
  const mid = Math.ceil(words.length / 2);
  if (rtl) {
    return {
      line1: words.slice(0, mid).join(' '),
      line2: words.slice(mid).join(' '),
    };
  }
  return {
    line1: words.slice(0, mid).join(' '),
    line2: words.slice(mid).join(' '),
  };
}

async function renderHeadlineLayer(params: {
  text: string;
  style: Exclude<ThumbnailVibeStyle, 'auto'>;
  accentHex: string;
}): Promise<{ fg: Buffer; shadow: Buffer; width: number; height: number }> {
  const { text, style, accentHex } = params;
  const rtl = hasArabicScript(text);
  const { line1, line2 } = splitHeadlineIntoTwoLines(text, rtl);

  const fontFamily = rtl
    ? 'Noto Kufi Arabic Bold'
    : style === 'cinematic-editorial'
    ? 'Noto Serif Display Bold'
    : 'Noto Sans Display Heavy';

  const fontSize = line2 ? 42 : 48;
  const primaryFg = style === 'comedy-sticker' ? '#09090B' : '#FFFFFF';
  const secondaryFg = style === 'comedy-sticker' ? '#FFFFFF' : accentHex;

  const pangoFg = line2
    ? `<span font="${fontFamily} ${fontSize}" foreground="${primaryFg}">${escapePango(
        line1
      )}</span>\n<span font="${fontFamily} ${fontSize + 2}" foreground="${secondaryFg}">${escapePango(
        line2
      )}</span>`
    : `<span font="${fontFamily} ${fontSize}" foreground="${primaryFg}">${escapePango(line1)}</span>`;

  const shadowHex = style === 'comedy-sticker' ? '#09090B' : '#000000';
  const pangoShadow = line2
    ? `<span font="${fontFamily} ${fontSize}" foreground="${shadowHex}">${escapePango(
        line1
      )}</span>\n<span font="${fontFamily} ${fontSize + 2}" foreground="${shadowHex}">${escapePango(
        line2
      )}</span>`
    : `<span font="${fontFamily} ${fontSize}" foreground="${shadowHex}">${escapePango(line1)}</span>`;

  const maxW = 610;
  let fgImg = sharp({
    text: {
      text: pangoFg,
      rgba: true,
      dpi: 150,
      width: maxW,
      align: 'center',
    },
  });
  let shadowImg = sharp({
    text: {
      text: pangoShadow,
      rgba: true,
      dpi: 150,
      width: maxW,
      align: 'center',
    },
  });

  const fgMeta = await fgImg.metadata();
  const rawW = fgMeta.width ?? 560;
  const rawH = fgMeta.height ?? 140;

  let finalW = rawW;
  let finalH = rawH;
  if (rawH > 270) {
    const scale = 270 / rawH;
    finalW = Math.round(rawW * scale);
    finalH = 270;
    fgImg = fgImg.resize(finalW, finalH, { fit: 'inside' });
    shadowImg = shadowImg.resize(finalW, finalH, { fit: 'inside' });
  }

  const fg = await fgImg.png().toBuffer();
  const shadow = await shadowImg.blur(style === 'comedy-sticker' ? 2 : 7).png().toBuffer();

  return { fg, shadow, width: finalW, height: finalH };
}

async function renderEmojiSticker(
  emoji: string,
  sizePt: number,
  angleDeg: number
): Promise<{ sticker: Buffer; shadow: Buffer; width: number; height: number }> {
  const rendered = await sharp({
    text: {
      text: `<span font="Noto Color Emoji ${sizePt}">${escapePango(emoji)}</span>`,
      rgba: true,
      dpi: 150,
    },
  })
    .rotate(angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const meta = await sharp(rendered).metadata();
  const w = meta.width ?? 90;
  const h = meta.height ?? 90;

  const shadow = await sharp(rendered)
    .tint({ r: 0, g: 0, b: 0 })
    .blur(6)
    .png()
    .toBuffer();

  return { sticker: rendered, shadow, width: w, height: h };
}

export async function generateHighlightThumbnail(params: {
  projectId: string;
  highlight: HighlightRecord;
  sourcePath?: string | null;
  sources?: ProjectSourceVideo[];
  scenes?: SceneKeyframe[];
  projectBrief?: string;
  durationFallback?: number;
}): Promise<{
  thumbnailPath: string;
  thumbnailUrl: string;
  thumbnailText: string;
  thumbnailEmojis: string[];
  thumbnailStyle: Exclude<ThumbnailVibeStyle, 'auto'>;
  thumbnailTimestamp: number;
}> {
  const { projectId, highlight, sourcePath, sources, scenes, projectBrief, durationFallback } = params;

  const resolvedStyle = resolveThumbnailStyle(highlight, projectBrief);
  const fallbackAccentByStyle: Record<Exclude<ThumbnailVibeStyle, 'auto'>, string> = {
    'viral-pop': '#FACC15',
    'lifestyle-warm': '#FB7185',
    'cinematic-editorial': '#F59E0B',
    'comedy-sticker': '#FACC15',
    'tech-neon': '#38BDF8',
    'podcast-quote': '#38BDF8',
  };
  const accentHex = normalizeHexColor(highlight.highlightColor, fallbackAccentByStyle[resolvedStyle]);
  const { text: coverText, emojis } = deriveFallbackThumbnailCopy(
    highlight,
    resolvedStyle,
    projectBrief
  );

  const framePick = resolveBestThumbnailFrame({
    highlight,
    sourcePath,
    sources,
    scenes,
    durationFallback,
  });

  const baseFrame = await extractCleanVerticalFrameBuffer({
    projectId,
    highlightId: highlight.id,
    videoPath: framePick.videoPath,
    timestamp: framePick.timestamp,
    cropMode: highlight.cropMode,
    style: resolvedStyle,
    sceneFallbackUrl: framePick.sceneFallbackUrl,
    accentHex,
  });

  const headlineLayer = await renderHeadlineLayer({
    text: coverText,
    style: resolvedStyle,
    accentHex,
  });

  const headlineLeft = Math.max(24, Math.round((THUMB_W - headlineLayer.width) / 2));
  const headlineTopY = Math.max(820, Math.min(1060, THUMB_H - headlineLayer.height - 135));

  const svgOverlay = buildVibeSvgOverlay({
    style: resolvedStyle,
    accentHex,
    categoryLabel: highlight.categoryName || 'HIGHLIGHT',
    textBoxHeight: headlineLayer.height,
    headlineTopY,
  });

  const composites: OverlayOptions[] = [
    { input: svgOverlay, top: 0, left: 0 },
    {
      input: headlineLayer.shadow,
      top: headlineTopY + (resolvedStyle === 'comedy-sticker' ? 5 : 6),
      left: headlineLeft + (resolvedStyle === 'comedy-sticker' ? 5 : 0),
    },
    {
      input: headlineLayer.fg,
      top: headlineTopY,
      left: headlineLeft,
    },
  ];

  // Place 1-3 scene-matched emojis cleanly outside center face/product zone (Y 240..780 clear)
  const emojiPlacements = [
    { top: 112, left: THUMB_W - 148, size: 52, angle: 12 },
    { top: Math.max(765, headlineTopY - 72), left: 48, size: 48, angle: -12 },
    { top: Math.min(THUMB_H - 125, headlineTopY + headlineLayer.height - 18), left: THUMB_W - 138, size: 44, angle: 10 },
  ];

  const stickerCount =
    resolvedStyle === 'cinematic-editorial' ? Math.min(2, emojis.length) : emojis.length;

  for (let i = 0; i < stickerCount; i++) {
    const slot = emojiPlacements[i];
    if (!slot) break;
    try {
      const renderedEmoji = await renderEmojiSticker(emojis[i], slot.size, slot.angle);
      const safeLeft = Math.max(24, Math.min(THUMB_W - renderedEmoji.width - 24, slot.left));
      const safeTop = Math.max(40, Math.min(THUMB_H - renderedEmoji.height - 40, slot.top));
      composites.push(
        { input: renderedEmoji.shadow, top: safeTop + 5, left: safeLeft + 3 },
        { input: renderedEmoji.sticker, top: safeTop, left: safeLeft }
      );
    } catch {
      // Skip individual emoji on unexpected font glitch without failing whole thumbnail
    }
  }

  const thumbsDir = resolveSafePath(PROJECTS_DIR, projectId, 'thumbnails');
  fs.mkdirSync(thumbsDir, { recursive: true });
  const filename = `${highlight.id}.jpg`;
  const outPath = resolveSafePath(thumbsDir, filename);

  await sharp(baseFrame)
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outPath);

  return {
    thumbnailPath: outPath,
    thumbnailUrl: `/api/projects/${encodeURIComponent(projectId)}/thumbnails/${encodeURIComponent(
      filename
    )}?v=${Date.now()}`,
    thumbnailText: coverText,
    thumbnailEmojis: emojis,
    thumbnailStyle: resolvedStyle,
    thumbnailTimestamp: framePick.timestamp,
  };
}

export async function generateProjectHighlightThumbnails(params: {
  projectId: string;
  highlights: HighlightRecord[];
  sourcePath?: string | null;
  sources?: ProjectSourceVideo[];
  scenes?: SceneKeyframe[];
  projectBrief?: string;
  durationFallback?: number;
  onEachComplete?: (
    highlightId: string,
    result: Awaited<ReturnType<typeof generateHighlightThumbnail>>
  ) => void;
}): Promise<HighlightRecord[]> {
  const {
    projectId,
    highlights,
    sourcePath,
    sources,
    scenes,
    projectBrief,
    durationFallback,
    onEachComplete,
  } = params;

  const updated = [...highlights];
  const CONCURRENCY = 3;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, updated.length) }, async () => {
    while (cursor < updated.length) {
      const idx = cursor++;
      const hl = updated[idx];
      try {
        const res = await generateHighlightThumbnail({
          projectId,
          highlight: hl,
          sourcePath,
          sources,
          scenes,
          projectBrief,
          durationFallback,
        });
        updated[idx] = {
          ...hl,
          thumbnailUrl: res.thumbnailUrl,
          thumbnailText: res.thumbnailText,
          thumbnailEmojis: res.thumbnailEmojis,
          thumbnailStyle: res.thumbnailStyle,
          thumbnailTimestamp: res.thumbnailTimestamp,
        };
        onEachComplete?.(hl.id, res);
      } catch (err) {
        console.warn(`[ThumbnailAgent] Failed for highlight ${hl.id}:`, err);
      }
    }
  });

  await Promise.all(workers);
  return updated;
}
