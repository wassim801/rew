import fs from 'fs';
import path from 'path';
import type { BgmVibe, HighlightRecord } from '../../types/studio';
import { DATA_ROOT } from '../db';

const BGM_CACHE_DIR = path.join(DATA_ROOT, 'bgm_cache');
const BGM_VERSION = 'v1';

const SAMPLE_RATE = 44100;

export type ResolvedBgmVibe = Exclude<BgmVibe, 'auto'>;

export function resolveHighlightBgmVibe(
  highlight: Pick<HighlightRecord, 'bgmVibe' | 'editingProfile' | 'categoryId'>,
  brief?: string
): ResolvedBgmVibe {
  if (highlight.bgmVibe && highlight.bgmVibe !== 'auto') {
    return highlight.bgmVibe;
  }

  const lowerBrief = (brief || '').toLowerCase();
  if (
    /\b(no background music|no music|voice only|no bgm|raw audio only|sans musique)\b/.test(
      lowerBrief
    )
  ) {
    return 'none';
  }

  if (/\b(holiday|santa|gift|fun|sweet|comedy|cheerful|party|happy|upbeat)\b/.test(lowerBrief)) {
    return highlight.editingProfile === 'Cinematic' ? 'cinematic-warm' : 'upbeat-pop';
  }
  if (/\b(hype|energetic|fast|gaming|trap|workout|viral)\b/.test(lowerBrief)) {
    return 'hype-beat';
  }

  switch (highlight.editingProfile) {
    case 'Comedy':
    case 'Travel':
      return 'upbeat-pop';
    case 'Dynamic':
    case 'Gaming':
      return 'hype-beat';
    case 'Cinematic':
      return 'cinematic-warm';
    case 'Podcast':
    case 'Educational':
      return 'lofi-warm';
    case 'Minimal':
    default:
      return highlight.categoryId === 'educational' ? 'none' : 'lofi-warm';
  }
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Deterministic pseudo-random for brushed percussion texture
function makeNoiseGen(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function writeStereoWav(filePath: string, left: Float32Array, right: Float32Array): void {
  const numSamples = left.length;
  const dataBytes = numSamples * 4; // 2 channels * 16-bit
  const buf = Buffer.allocUnsafe(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 4, 28); // Byte rate
  buf.writeUInt16LE(4, 32); // Block align
  buf.writeUInt16LE(16, 34); // Bits per sample
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

function applyWarmLowPassAndLoopSmooth(
  left: Float32Array,
  right: Float32Array,
  cutoffHz: number
): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);

  let prevL = 0;
  let prevR = 0;
  // Two-pass 1-pole for warm 12dB/oct roll-off
  for (let pass = 0; pass < 2; pass++) {
    prevL = left[left.length - 1] * 0.5;
    prevR = right[right.length - 1] * 0.5;
    for (let i = 0; i < left.length; i++) {
      prevL = prevL + alpha * (left[i] - prevL);
      prevR = prevR + alpha * (right[i] - prevR);
      left[i] = prevL;
      right[i] = prevR;
    }
  }

  // Seamless 20ms crossfade at loop edges so -stream_loop -1 never clicks
  const fadeSamples = Math.min(882, Math.floor(left.length / 8));
  for (let i = 0; i < fadeSamples; i++) {
    const g = i / fadeSamples;
    left[i] *= g;
    right[i] *= g;
    left[left.length - 1 - i] *= g;
    right[right.length - 1 - i] *= g;
  }
}

function addRhodesChord(
  left: Float32Array,
  right: Float32Array,
  startSec: number,
  durSec: number,
  midiNotes: number[],
  gain: number
): void {
  const startIdx = Math.max(0, Math.floor(startSec * SAMPLE_RATE));
  const endIdx = Math.min(left.length, Math.floor((startSec + durSec) * SAMPLE_RATE));
  const totalLen = endIdx - startIdx;
  if (totalLen <= 0) return;

  for (let nIdx = 0; nIdx < midiNotes.length; nIdx++) {
    const freq = midiToHz(midiNotes[nIdx]);
    const pan = ((nIdx % 2 === 0 ? -1 : 1) * 0.28) / Math.max(1, midiNotes.length * 0.35);
    const lGain = gain * (1 - Math.max(0, pan));
    const rGain = gain * (1 + Math.min(0, pan));
    const attackSamp = Math.max(1, Math.floor(0.022 * SAMPLE_RATE));
    const releaseSamp = Math.max(1, Math.floor(0.14 * SAMPLE_RATE));

    for (let i = startIdx; i < endIdx; i++) {
      const local = i - startIdx;
      const t = local / SAMPLE_RATE;
      let env = Math.exp(-t * 1.45);
      if (local < attackSamp) env *= local / attackSamp;
      if (totalLen - local < releaseSamp) env *= (totalLen - local) / releaseSamp;

      // Warm electric-piano harmonic blend + subtle chorus detune
      const waveL =
        Math.sin(2 * Math.PI * freq * t) +
        0.26 * Math.sin(2 * Math.PI * (freq * 2) * t + 0.2) * Math.exp(-t * 3.2) +
        0.08 * Math.sin(2 * Math.PI * (freq * 3) * t) * Math.exp(-t * 5.0);
      const waveR =
        Math.sin(2 * Math.PI * (freq + 0.35) * t + 0.15) +
        0.26 * Math.sin(2 * Math.PI * (freq * 2 + 0.35) * t + 0.3) * Math.exp(-t * 3.2) +
        0.08 * Math.sin(2 * Math.PI * (freq * 3) * t) * Math.exp(-t * 5.0);

      left[i] += waveL * env * lGain;
      right[i] += waveR * env * rGain;
    }
  }
}

function addWarmBassNote(
  left: Float32Array,
  right: Float32Array,
  startSec: number,
  durSec: number,
  midiNote: number,
  gain: number
): void {
  const startIdx = Math.max(0, Math.floor(startSec * SAMPLE_RATE));
  const endIdx = Math.min(left.length, Math.floor((startSec + durSec) * SAMPLE_RATE));
  const totalLen = endIdx - startIdx;
  if (totalLen <= 0) return;

  const freq = midiToHz(midiNote);
  const attackSamp = Math.floor(0.014 * SAMPLE_RATE);
  const releaseSamp = Math.floor(0.06 * SAMPLE_RATE);

  for (let i = startIdx; i < endIdx; i++) {
    const local = i - startIdx;
    const t = local / SAMPLE_RATE;
    let env = Math.exp(-t * 1.8);
    if (local < attackSamp) env *= local / attackSamp;
    if (totalLen - local < releaseSamp) env *= (totalLen - local) / releaseSamp;
    const sample =
      (Math.sin(2 * Math.PI * freq * t) + 0.22 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * gain;
    left[i] += sample;
    right[i] += sample;
  }
}

function addSoftKick(
  left: Float32Array,
  right: Float32Array,
  startSec: number,
  gain: number
): void {
  const startIdx = Math.max(0, Math.floor(startSec * SAMPLE_RATE));
  const len = Math.floor(0.16 * SAMPLE_RATE);
  const endIdx = Math.min(left.length, startIdx + len);

  let phase = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const t = (i - startIdx) / SAMPLE_RATE;
    const freq = 46 + 92 * Math.exp(-t * 36);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const env = Math.min(1, (i - startIdx) / 120) * Math.exp(-t * 20);
    const val = Math.sin(phase) * env * gain;
    left[i] += val;
    right[i] += val;
  }
}

function addSoftShaker(
  left: Float32Array,
  right: Float32Array,
  startSec: number,
  gain: number,
  rand: () => number,
  pan = 0.15
): void {
  const startIdx = Math.max(0, Math.floor(startSec * SAMPLE_RATE));
  const len = Math.floor(0.055 * SAMPLE_RATE);
  const endIdx = Math.min(left.length, startIdx + len);
  let last = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const t = (i - startIdx) / SAMPLE_RATE;
    const raw = rand();
    // Gentle high-pass difference for airy shaker tick
    const hp = raw - last * 0.7;
    last = raw;
    const env = Math.exp(-t * 68);
    left[i] += hp * env * gain * (1 - pan);
    right[i] += hp * env * gain * (1 + pan);
  }
}

function synthesizeVibeTrack(vibe: Exclude<ResolvedBgmVibe, 'none'>, outPath: string): void {
  const rand = makeNoiseGen(vibe === 'hype-beat' ? 42 : vibe === 'upbeat-pop' ? 77 : 99);

  if (vibe === 'upbeat-pop') {
    // 112 BPM, 8 bars (16 beats = 8.571s * 2 = 17.143s loop), bright major feel
    const beat = 60 / 112;
    const bars = 8;
    const totalDur = bars * 4 * beat;
    const n = Math.floor(totalDur * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);

    const prog = [
      { bass: 41, chord: [65, 69, 72, 76] }, // Fmaj7
      { bass: 43, chord: [67, 71, 74, 76] }, // G6
      { bass: 40, chord: [64, 67, 71, 74] }, // Em7
      { bass: 45, chord: [69, 72, 76, 79] }, // Am7
    ];

    for (let bar = 0; bar < bars; bar++) {
      const p = prog[bar % prog.length];
      const barStart = bar * 4 * beat;
      addRhodesChord(L, R, barStart, 1.85 * beat, p.chord, 0.11);
      addRhodesChord(L, R, barStart + 2.0 * beat, 1.7 * beat, p.chord, 0.085);
      addWarmBassNote(L, R, barStart, 1.5 * beat, p.bass, 0.22);
      addWarmBassNote(L, R, barStart + 2.5 * beat, 1.2 * beat, p.bass + 7, 0.16);

      // Gentle pop groove
      for (let b = 0; b < 4; b++) {
        if (b === 0 || b === 2) addSoftKick(L, R, barStart + b * beat, 0.26);
        addSoftShaker(L, R, barStart + (b + 0.5) * beat, 0.055, rand, b % 2 === 0 ? 0.2 : -0.2);
      }
    }

    applyWarmLowPassAndLoopSmooth(L, R, 3000);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (vibe === 'lofi-warm') {
    // 84 BPM, 4 bars (~11.428s loop), warm chill jazz chords
    const beat = 60 / 84;
    const bars = 4;
    const totalDur = bars * 4 * beat;
    const n = Math.floor(totalDur * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);

    const prog = [
      { bass: 38, chord: [62, 65, 69, 72, 76] }, // Dm9
      { bass: 43, chord: [65, 69, 71, 74] }, // G13
      { bass: 36, chord: [60, 64, 67, 71, 74] }, // Cmaj9
      { bass: 45, chord: [67, 70, 73, 76] }, // A7b9-ish warm
    ];

    for (let bar = 0; bar < bars; bar++) {
      const p = prog[bar % prog.length];
      const barStart = bar * 4 * beat;
      addRhodesChord(L, R, barStart, 3.6 * beat, p.chord, 0.095);
      addWarmBassNote(L, R, barStart, 2.2 * beat, p.bass, 0.22);
      addWarmBassNote(L, R, barStart + 2.5 * beat, 1.3 * beat, p.bass + 5, 0.15);

      addSoftKick(L, R, barStart, 0.22);
      addSoftKick(L, R, barStart + 2.5 * beat, 0.18);
      for (let step = 0; step < 8; step++) {
        addSoftShaker(
          L,
          R,
          barStart + step * 0.5 * beat,
          step % 2 === 1 ? 0.038 : 0.022,
          rand,
          step % 2 === 0 ? -0.18 : 0.18
        );
      }
    }

    applyWarmLowPassAndLoopSmooth(L, R, 2200);
    writeStereoWav(outPath, L, R);
    return;
  }

  if (vibe === 'hype-beat') {
    // 124 BPM, 8 bars (~15.484s loop), energetic tight groove
    const beat = 60 / 124;
    const bars = 8;
    const totalDur = bars * 4 * beat;
    const n = Math.floor(totalDur * SAMPLE_RATE);
    const L = new Float32Array(n);
    const R = new Float32Array(n);

    const prog = [
      { bass: 33, chord: [57, 60, 64, 67] }, // Am7
      { bass: 41, chord: [60, 64, 65, 69] }, // Fmaj7
      { bass: 36, chord: [60, 64, 67, 71] }, // Cmaj7
      { bass: 43, chord: [59, 62, 67, 71] }, // G6
    ];

    for (let bar = 0; bar < bars; bar++) {
      const p = prog[bar % prog.length];
      const barStart = bar * 4 * beat;
      addRhodesChord(L, R, barStart, 1.2 * beat, p.chord, 0.105);
      addRhodesChord(L, R, barStart + 1.5 * beat, 1.2 * beat, p.chord, 0.085);
      addRhodesChord(L, R, barStart + 3.0 * beat, 0.85 * beat, p.chord, 0.095);

      addWarmBassNote(L, R, barStart, 1.3 * beat, p.bass, 0.28);
      addWarmBassNote(L, R, barStart + 1.5 * beat, 1.1 * beat, p.bass, 0.22);
      addWarmBassNote(L, R, barStart + 3.0 * beat, 0.8 * beat, p.bass + 7, 0.20);

      addSoftKick(L, R, barStart, 0.34);
      addSoftKick(L, R, barStart + 1.5 * beat, 0.28);
      addSoftKick(L, R, barStart + 2.75 * beat, 0.25);

      for (let step = 0; step < 8; step++) {
        addSoftShaker(
          L,
          R,
          barStart + step * 0.5 * beat,
          step % 2 === 0 ? 0.05 : 0.032,
          rand,
          step % 2 === 0 ? 0.25 : -0.25
        );
      }
    }

    applyWarmLowPassAndLoopSmooth(L, R, 3400);
    writeStereoWav(outPath, L, R);
    return;
  }

  // 'cinematic-warm': 76 BPM lush pad + delicate felt arpeggio (~12.63s loop)
  const beat = 60 / 76;
  const bars = 4;
  const totalDur = bars * 4 * beat;
  const n = Math.floor(totalDur * SAMPLE_RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  const prog = [
    { bass: 36, chord: [60, 67, 71, 74] },
    { bass: 33, chord: [57, 64, 67, 72] },
    { bass: 41, chord: [65, 69, 72, 76] },
    { bass: 43, chord: [62, 67, 71, 74] },
  ];

  for (let bar = 0; bar < bars; bar++) {
    const p = prog[bar % prog.length];
    const barStart = bar * 4 * beat;
    addRhodesChord(L, R, barStart, 3.85 * beat, p.chord, 0.095);
    addWarmBassNote(L, R, barStart, 3.8 * beat, p.bass, 0.2);
    // Gentle felt arpeggio sparkle
    for (let step = 0; step < 4; step++) {
      addRhodesChord(L, R, barStart + step * beat, 0.9 * beat, [p.chord[step % p.chord.length] + 12], 0.055);
    }
  }

  applyWarmLowPassAndLoopSmooth(L, R, 2500);
  writeStereoWav(outPath, L, R);
}

export async function ensureBgmTrack(vibe: ResolvedBgmVibe): Promise<string | null> {
  if (vibe === 'none') return null;
  fs.mkdirSync(BGM_CACHE_DIR, { recursive: true });
  const filePath = path.join(BGM_CACHE_DIR, `${vibe}_${BGM_VERSION}.wav`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 10000) {
    return filePath;
  }
  synthesizeVibeTrack(vibe, filePath);
  return filePath;
}
