import fs from 'fs';
import path from 'path';
import type {
  HighlightRecord,
  RemixSegment,
  SfxCueType,
  SfxMode,
  TransitionStyle,
} from '../../types/studio';
import { DATA_ROOT } from '../db';

const SFX_CACHE_DIR = path.join(DATA_ROOT, 'sfx_cache');
const SFX_VERSION = 'v1';
const SAMPLE_RATE = 44100;

export type ResolvedSfxMode = Exclude<SfxMode, 'auto'>;

export interface SfxEvent {
  cue: SfxCueType;
  timeSec: number;
  gain?: number;
}

export const ALL_SFX_CUES: SfxCueType[] = [
  'mouse-click',
  'clever-ding',
  'shock-boom',
  'buzz-zap',
  'whoosh-swish',
  'pop-bubble',
  'cash-sparkle',
  'riser-hit',
];

export function resolveHighlightSfxMode(
  highlight: Pick<HighlightRecord, 'sfxMode' | 'editingProfile' | 'categoryId'>,
  brief?: string
): ResolvedSfxMode {
  if (highlight.sfxMode && highlight.sfxMode !== 'auto') {
    return highlight.sfxMode;
  }

  const lowerBrief = (brief || '').toLowerCase();
  if (
    /\b(no sound effects|no sfx|without sound effects|voice only|raw audio only|sans bruitage|sans effets sonores)\b/.test(
      lowerBrief
    )
  ) {
    return 'none';
  }

  if (/\b(holiday|santa|gift|sweet|fun|comedy|playful|viral|tiktok|reels|memes?)\b/.test(lowerBrief)) {
    return 'playful-viral';
  }
  if (/\b(shock|drama|dramatic|twist|cinematic|reveal|mystery|intense)\b/.test(lowerBrief)) {
    return 'dramatic-impact';
  }

  switch (highlight.editingProfile) {
    case 'Comedy':
    case 'Dynamic':
    case 'Gaming':
      return 'playful-viral';
    case 'Cinematic':
    case 'Travel':
      return 'dramatic-impact';
    case 'Educational':
    case 'Podcast':
      return 'smart-ui';
    case 'Minimal':
    default:
      return highlight.categoryId === 'educational' ? 'smart-ui' : 'subtle-clean';
  }
}

function makeNoiseGen(seed = 2026) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function applySoftFadeAndLowPass(
  left: Float32Array,
  right: Float32Array,
  cutoffHz: number
): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);

  let prevL = 0;
  let prevR = 0;
  for (let i = 0; i < left.length; i++) {
    prevL = prevL + alpha * (left[i] - prevL);
    prevR = prevR + alpha * (right[i] - prevR);
    left[i] = prevL;
    right[i] = prevR;
  }

  const fadeIn = Math.min(88, Math.floor(left.length / 8));
  const fadeOut = Math.min(441, Math.floor(left.length / 4));
  for (let i = 0; i < fadeIn; i++) {
    const g = i / Math.max(1, fadeIn);
    left[i] *= g;
    right[i] *= g;
  }
  for (let i = 0; i < fadeOut; i++) {
    const g = i / Math.max(1, fadeOut);
    left[left.length - 1 - i] *= g;
    right[right.length - 1 - i] *= g;
  }
}

function writeStereoWav(filePath: string, left: Float32Array, right: Float32Array): void {
  const numSamples = left.length;
  const dataBytes = numSamples * 4;
  const buf = Buffer.allocUnsafe(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-0.98, Math.min(0.98, Math.tanh(left[i])));
    const r = Math.max(-0.98, Math.min(0.98, Math.tanh(right[i])));
    buf.writeInt16LE(Math.round(l * 32767), offset);
    buf.writeInt16LE(Math.round(r * 32767), offset + 2);
    offset += 4;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, filePath);
}

function readStereoWavSamples(filePath: string): { left: Float32Array; right: Float32Array } {
  const buf = fs.readFileSync(filePath);
  const dataOffset = 44;
  const sampleCount = Math.max(0, Math.floor((buf.length - dataOffset) / 4));
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  let offset = dataOffset;
  for (let i = 0; i < sampleCount; i++) {
    left[i] = buf.readInt16LE(offset) / 32768;
    right[i] = buf.readInt16LE(offset + 2) / 32768;
    offset += 4;
  }
  return { left, right };
}

function synthesizeSfxCue(cue: SfxCueType, outPath: string): void {
  const rand = makeNoiseGen(cue.length * 997 + cue.charCodeAt(0) * 31);

  if (cue === 'mouse-click') {
    const n = Math.floor(0.11 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const hit2 = Math.floor(0.036 * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      // Press transient
      const env1 = Math.exp(-t * 190);
      const press =
        (Math.sin(2 * Math.PI * 2450 * t) * 0.55 +
          Math.sin(2 * Math.PI * 1120 * t) * 0.45 +
          rand() * 0.35) *
        env1;
      // Release micro-click
      let rel = 0;
      if (i >= hit2) {
        const t2 = (i - hit2) / SAMPLE_RATE;
        const env2 = Math.exp(-t2 * 220);
        rel =
          (Math.sin(2 * Math.PI * 3100 * t2) * 0.45 +
            Math.sin(2 * Math.PI * 1450 * t2) * 0.3 +
            rand() * 0.25) *
          env2 *
          0.65;
      }
      const val = (press + rel) * 0.85;
      L[i] = val * 0.96;
      R[i] = val * 1.02;
    }
    applySoftFadeAndLowPass(L, R, 7500);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'clever-ding') {
    // Crisp lightbulb "aha!" two-note chime (E6 -> B6)
    const n = Math.floor(0.58 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const note2Start = Math.floor(0.085 * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const t1 = i / SAMPLE_RATE;
      const e1 = Math.min(1, t1 / 0.004) * Math.exp(-t1 * 11.5);
      const s1 =
        (Math.sin(2 * Math.PI * 1318.5 * t1) +
          0.32 * Math.sin(2 * Math.PI * 2637 * t1) +
          0.12 * Math.sin(2 * Math.PI * 3955 * t1)) *
        e1 *
        0.38;

      let s2L = 0;
      let s2R = 0;
      if (i >= note2Start) {
        const t2 = (i - note2Start) / SAMPLE_RATE;
        const e2 = Math.min(1, t2 / 0.004) * Math.exp(-t2 * 6.8);
        const core =
          Math.sin(2 * Math.PI * 1975.5 * t2) +
          0.3 * Math.sin(2 * Math.PI * 3951 * t2) +
          0.1 * Math.sin(2 * Math.PI * 5926 * t2);
        s2L = core * e2 * 0.48;
        s2R =
          (Math.sin(2 * Math.PI * 1977.5 * t2 + 0.18) +
            0.3 * Math.sin(2 * Math.PI * 3951 * t2)) *
          e2 *
          0.48;
      }

      L[i] = s1 + s2L;
      R[i] = s1 + s2R;
    }
    applySoftFadeAndLowPass(L, R, 6800);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'shock-boom') {
    // Deep cinematic sub-bass drop + sharp transient snap + stereo tail
    const n = Math.floor(0.82 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let phase = 0;
    let lastNoise = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const freq = 35 + 108 * Math.exp(-t * 14);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const subEnv = Math.min(1, t / 0.008) * Math.exp(-t * 3.8);
      const sub = Math.sin(phase) * subEnv * 0.82;

      // Crisp punch crack at t=0
      const crackEnv = Math.exp(-t * 52);
      const raw = rand();
      const shapedNoise = raw * 0.55 + lastNoise * 0.45;
      lastNoise = raw;
      const crack = shapedNoise * crackEnv * 0.42;

      // Low wide rumble tail
      const tailEnv = Math.min(1, t / 0.03) * Math.exp(-t * 3.1);
      const airL = rand() * tailEnv * 0.11;
      const airR = rand() * tailEnv * 0.11;

      L[i] = sub + crack + airL;
      R[i] = sub + crack + airR;
    }
    applySoftFadeAndLowPass(L, R, 3400);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'buzz-zap') {
    // Snappy electric glitch/game-show buzz (warmly filtered so it pops without harshness)
    const n = Math.floor(0.34 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 5.5);
      // Slight double-pulse stutter at 0.12s for expressive comic buzz feel
      const pulse = t > 0.11 && t < 0.135 ? 0.35 : 1.0;
      const f1 = 132 + 24 * Math.sin(2 * Math.PI * 26 * t);
      const f2 = 198 + 18 * Math.cos(2 * Math.PI * 33 * t);
      const saw1 = 2 * ((t * f1) % 1) - 1;
      const saw2 = 2 * ((t * f2) % 1) - 1;
      const buzz = (saw1 * 0.52 + saw2 * 0.42 + rand() * 0.18) * env * pulse * 0.48;
      L[i] = buzz * (0.9 + 0.1 * Math.sin(t * 45));
      R[i] = buzz * (0.9 - 0.1 * Math.sin(t * 45));
    }
    applySoftFadeAndLowPass(L, R, 2900);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'whoosh-swish') {
    // Stereo bandpass-swept air whoosh for whip/zoom transitions
    const n = Math.floor(0.32 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let lpL = 0;
    let lpR = 0;
    let hpL = 0;
    let hpR = 0;
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const bell = Math.sin(Math.PI * p);
      const env = Math.pow(bell, 1.35);
      const centerHz = 360 + 2200 * bell;
      const alpha = Math.min(0.65, (2 * Math.PI * centerHz) / SAMPLE_RATE);
      const nL = rand();
      const nR = rand();
      lpL = lpL + alpha * (nL - lpL);
      lpR = lpR + alpha * (nR - lpR);
      hpL = lpL - hpL * 0.55;
      hpR = lpR - hpR * 0.55;
      // Pan sweeps smoothly left -> right
      const pan = p * 0.6 - 0.3;
      L[i] = (hpL * 0.65 + Math.sin(2 * Math.PI * (90 + 80 * bell) * (i / SAMPLE_RATE)) * 0.18) * env * (1 - pan);
      R[i] = (hpR * 0.65 + Math.sin(2 * Math.PI * (90 + 80 * bell) * (i / SAMPLE_RATE)) * 0.18) * env * (1 + pan);
    }
    applySoftFadeAndLowPass(L, R, 4200);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'pop-bubble') {
    // Playful rapid upward-swept cork/bubble pop
    const n = Math.floor(0.14 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const freq = 240 + 560 * Math.min(1, t / 0.045) - 180 * Math.max(0, t - 0.045) / 0.08;
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 28);
      const val = (Math.sin(phase) + 0.25 * Math.sin(phase * 2)) * env * 0.72;
      L[i] = val;
      R[i] = val;
    }
    applySoftFadeAndLowPass(L, R, 5200);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (cue === 'cash-sparkle') {
    // Shimmering ascending chime cascade (C6-E6-G6-B6-E7) for reveals/gifts/wins
    const notes = [1046.5, 1318.5, 1568.0, 1975.5, 2637.0];
    const n = Math.floor(0.66 * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let idx = 0; idx < notes.length; idx++) {
      const startSample = Math.floor(idx * 0.055 * SAMPLE_RATE);
      const freq = notes[idx];
      const pan = (idx - 2) * 0.14;
      for (let i = startSample; i < n; i++) {
        const t = (i - startSample) / SAMPLE_RATE;
        const env = Math.min(1, t / 0.004) * Math.exp(-t * 7.2);
        const s = (Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * 0.28;
        L[i] += s * (1 - pan);
        R[i] += s * (1 + pan);
      }
    }
    applySoftFadeAndLowPass(L, R, 7200);
    writeStereoWav(outPath, L, R);
    return;
  }

  // 'riser-hit': Rising tension swell ending with crisp impact hit
  const n = Math.floor(0.58 * SAMPLE_RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const hitSample = Math.floor(0.42 * SAMPLE_RATE);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    if (i < hitSample) {
      const p = i / hitSample;
      const freq = 180 + 480 * p * p;
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const swell = Math.pow(p, 1.8) * 0.42;
      const val = (Math.sin(phase) * 0.55 + rand() * 0.35 * p) * swell;
      L[i] = val;
      R[i] = val;
    } else {
      const ht = (i - hitSample) / SAMPLE_RATE;
      const hitEnv = Math.exp(-ht * 16);
      const thump = Math.sin(2 * Math.PI * (72 + 120 * Math.exp(-ht * 35)) * ht) * hitEnv * 0.65;
      const snap = rand() * Math.exp(-ht * 45) * 0.35;
      L[i] = thump + snap;
      R[i] = thump + snap;
    }
  }
  applySoftFadeAndLowPass(L, R, 4600);
  writeStereoWav(outPath, L, R);
}

export async function ensureSfxCue(cue: SfxCueType): Promise<string> {
  fs.mkdirSync(SFX_CACHE_DIR, { recursive: true });
  const filePath = path.join(SFX_CACHE_DIR, `${cue}_${SFX_VERSION}.wav`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 2000) {
    return filePath;
  }
  synthesizeSfxCue(cue, filePath);
  return filePath;
}

const MODE_DEFAULT_ROTATION: Record<Exclude<ResolvedSfxMode, 'none'>, SfxCueType[]> = {
  'playful-viral': ['pop-bubble', 'clever-ding', 'whoosh-swish', 'cash-sparkle', 'buzz-zap', 'mouse-click'],
  'dramatic-impact': ['shock-boom', 'whoosh-swish', 'riser-hit', 'clever-ding', 'cash-sparkle'],
  'smart-ui': ['mouse-click', 'clever-ding', 'pop-bubble', 'whoosh-swish'],
  'subtle-clean': ['whoosh-swish', 'mouse-click', 'clever-ding', 'pop-bubble'],
};

function avoidRepeat(
  preferred: SfxCueType,
  previousCue: SfxCueType | null,
  mode: Exclude<ResolvedSfxMode, 'none'>,
  seedIdx = 0
): SfxCueType {
  if (preferred !== previousCue) return preferred;
  const pool = MODE_DEFAULT_ROTATION[mode].filter((c) => c !== previousCue);
  if (pool.length === 0) return 'whoosh-swish';
  return pool[Math.abs(seedIdx) % pool.length];
}

export function inferSceneSfxCue(params: {
  explicitCue?: SfxCueType | 'auto' | 'none';
  mode: ResolvedSfxMode;
  text?: string;
  visualNote?: string;
  role?: RemixSegment['role'];
  keywords?: string[];
  categoryId?: string;
  transitionStyle?: TransitionStyle;
  isHook?: boolean;
  previousCue: SfxCueType | null;
  seedIdx?: number;
}): SfxCueType | null {
  const {
    explicitCue,
    mode,
    text = '',
    visualNote = '',
    role,
    keywords = [],
    categoryId = '',
    transitionStyle,
    isHook = false,
    previousCue,
    seedIdx = 0,
  } = params;

  if (mode === 'none' || explicitCue === 'none') return null;

  if (explicitCue && explicitCue !== 'auto') {
    return avoidRepeat(explicitCue, previousCue, mode, seedIdx);
  }

  const combined = `${text} ${visualNote} ${keywords.join(' ')}`.toLowerCase();

  let picked: SfxCueType | null = null;

  // Semantic scene & emotion matching (buzz / shock / clever / mouse / sparkle / pop / whoosh / riser)
  if (
    /\b(wrong|mistake|error|fail|bad|never|stop|awkward|buzz|ouch|oops|weird|cringe|avoid|rejected|problem)\b/.test(
      combined
    )
  ) {
    picked = 'buzz-zap';
  } else if (
    /\b(shock|shocked|what|no way|omg|crazy|insane|unbelievable|secret|plot twist|wait|surprise|wow|boom|scream|react)\b/.test(
      combined
    )
  ) {
    picked = 'shock-boom';
  } else if (
    /\b(clever|smart|tip|hack|idea|trick|genius|actually|learned|reason|fact|explain|how to|answer|best)\b/.test(
      combined
    )
  ) {
    picked = 'clever-ding';
  } else if (
    /\b(click|screen|slide|app|link|button|cursor|mouse|ui|demo|step|check|menu|scroll|tap)\b/.test(
      combined
    )
  ) {
    picked = 'mouse-click';
  } else if (
    /\b(gift|unbox|open|present|reveal|product|kitsch|love|sweet|cute|shine|beauty|glow|win|prize|holiday|santa)\b/.test(
      combined
    )
  ) {
    picked = role === 'payoff' || role === 'product' ? 'cash-sparkle' : 'pop-bubble';
  }

  // Fallback to role / mode / transition choreography
  if (!picked) {
    if (isHook) {
      if (mode === 'dramatic-impact') picked = 'shock-boom';
      else if (mode === 'smart-ui') picked = 'mouse-click';
      else if (mode === 'subtle-clean') picked = 'whoosh-swish';
      else picked = categoryId === 'comedy' ? 'pop-bubble' : 'shock-boom';
    } else if (role === 'product') {
      picked = mode === 'smart-ui' ? 'clever-ding' : 'cash-sparkle';
    } else if (role === 'payoff') {
      picked = mode === 'dramatic-impact' ? 'riser-hit' : 'clever-ding';
    } else if (transitionStyle === 'whip-slide' || transitionStyle === 'zoom-punch') {
      picked = 'whoosh-swish';
    } else {
      const pool = MODE_DEFAULT_ROTATION[mode];
      picked = pool[Math.abs(seedIdx) % pool.length];
    }
  }

  return avoidRepeat(picked, previousCue, mode, seedIdx);
}

export async function renderCompositeSfxTrack(params: {
  clipDuration: number;
  events: SfxEvent[];
  outWavPath: string;
}): Promise<string | null> {
  const { clipDuration, events, outWavPath } = params;
  if (events.length === 0 || clipDuration <= 0.5) {
    return null;
  }

  // Sort chronologically, enforce >= 1.45s minimum gap and zero back-to-back duplicate cue types
  const sorted = [...events]
    .filter((e) => e.timeSec >= 0 && e.timeSec < clipDuration - 0.15)
    .sort((a, b) => a.timeSec - b.timeSec);

  const filtered: SfxEvent[] = [];
  let lastTime = -10;
  let lastCue: SfxCueType | null = null;
  for (const ev of sorted) {
    if (ev.timeSec - lastTime < 1.45) continue;
    if (ev.cue === lastCue) continue;
    filtered.push(ev);
    lastTime = ev.timeSec;
    lastCue = ev.cue;
    if (filtered.length >= 6) break;
  }

  if (filtered.length === 0) return null;

  const totalSamples = Math.max(SAMPLE_RATE, Math.ceil(clipDuration * SAMPLE_RATE));
  const mixL = new Float32Array(totalSamples);
  const mixR = new Float32Array(totalSamples);

  const loaded = new Map<SfxCueType, { left: Float32Array; right: Float32Array }>();
  for (const ev of filtered) {
    let sfxData = loaded.get(ev.cue);
    if (!sfxData) {
      const wavPath = await ensureSfxCue(ev.cue);
      sfxData = readStereoWavSamples(wavPath);
      loaded.set(ev.cue, sfxData);
    }
    const startIdx = Math.max(0, Math.floor(ev.timeSec * SAMPLE_RATE));
    const gain = ev.gain ?? 0.72;
    const len = Math.min(sfxData.left.length, totalSamples - startIdx);
    for (let i = 0; i < len; i++) {
      mixL[startIdx + i] += sfxData.left[i] * gain;
      mixR[startIdx + i] += sfxData.right[i] * gain;
    }
  }

  writeStereoWav(outWavPath, mixL, mixR);
  return outWavPath;
}
