// Builds labelled test takes that follow the recording script, from real Salamander grand piano
// samples, degraded to resemble a CT-S1 (small speakers) heard by a phone mic in a room.
// Usage: node eval/synth.mjs   -> writes takes/<condition>/<take>.f32 + .json
import fs from 'node:fs';
import path from 'node:path';
import { makeFFT } from '../dsp/listener.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SR = 48000;
const E = process.env, OUT = E.OUT || 'takes', HP = +(E.HP || 160), RT = +(E.RT || 0.35), NOFF = +(E.NOISE_OFFSET || 0);
let seed = +(E.SEED || 7); const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---- samples: Salamander has A, C, D#, F# in each octave; shift by resampling to fill gaps
const NAMES = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
const cache = new Map();
function rawSample(m) {
  if (!cache.has(m)) {
    const name = NAMES[m % 12] + (Math.floor(m / 12) - 1), file = path.join(ROOT, 'samples', name + '.f32');
    const b = fs.readFileSync(file); cache.set(m, new Float32Array(b.buffer, b.byteOffset, b.length / 4));
  }
  return cache.get(m);
}
function note(m, holdSec) {
  let base = m; while (!(base % 12 in NAMES)) base--;          // nearest sample at or below
  if (m - base > 1) base += 3;                                     // or above, max 1 semitone away
  const src = rawSample(base), ratio = Math.pow(2, (m - base) / 12);
  const len = Math.floor((holdSec + 0.12) * SR), out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = i * ratio, j = x | 0, f = x - j;
    if (j + 1 >= src.length) break;
    out[i] = src[j] * (1 - f) + src[j + 1] * f;
  }
  const rel = Math.floor(0.12 * SR), start = len - rel;             // damper release
  for (let i = start; i < len; i++) out[i] *= Math.exp(-6 * (i - start) / rel);
  return out;
}

// ---- degradations
function biquad(x, type, f, q = 0.7071) {
  const w = 2 * Math.PI * f / SR, a = Math.sin(w) / (2 * q), c = Math.cos(w);
  let b0, b1, b2; const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; } else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function reverb(x, rt = 0.35, wet = 0.25) {
  const irLen = Math.floor(rt * SR), ir = new Float64Array(irLen);
  for (let i = 0; i < irLen; i++) ir[i] = (rnd() * 2 - 1) * Math.exp(-6.9 * i / irLen);
  let e = 0; for (const v of ir) e += v * v; const g = wet / Math.sqrt(e);
  const N = 65536, B = N - irLen, fft = makeFFT(N);
  const hr = new Float64Array(N), hi = new Float64Array(N); for (let i = 0; i < irLen; i++) hr[i] = ir[i] * g; fft(hr, hi);
  const y = new Float32Array(x.length + irLen);
  for (let s = 0; s < x.length; s += B) {
    const r = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < B && s + i < x.length; i++) r[i] = x[s + i];
    fft(r, im);
    for (let k = 0; k < N; k++) { const a = r[k] * hr[k] - im[k] * hi[k], b = r[k] * hi[k] + im[k] * hr[k]; r[k] = a; im[k] = -b; }
    fft(r, im); // inverse via conjugate trick
    for (let i = 0; i < N && s + i < y.length; i++) y[s + i] += r[i] / N;
  }
  for (let i = 0; i < x.length; i++) y[i] += x[i];
  return y.subarray(0, x.length);
}
function pink(len, rmsDb) {
  const y = new Float32Array(len); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    y[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
  }
  return scaleRms(y, rmsDb);
}
function fan(len, rmsDb) { // broadband noise + motor hum at 100/200 Hz
  const y = biquad(pink(len, 0), 'lp', 2500);
  for (let i = 0; i < len; i++) y[i] += 0.3 * Math.sin(2 * Math.PI * 100 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 200 * i / SR);
  return scaleRms(y, rmsDb);
}
function voice(len, rmsDb) { // harmonic, gliding, syllabic: the hardest kind of noise for a pitch detector
  const y = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR, f = 140 + 60 * Math.sin(2 * Math.PI * 0.7 * t) + 25 * Math.sin(2 * Math.PI * 3.1 * t);
    ph += f / SR; ph -= Math.floor(ph);
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4.2 * t)) * (Math.sin(2 * Math.PI * 0.23 * t) > -0.3 ? 1 : 0);
    y[i] = (2 * ph - 1) * syl;
  }
  return scaleRms(biquad(biquad(y, 'lp', 1800), 'hp', 120), rmsDb);
}
function knocks(len, every = 2.5) { // table taps, footsteps: sharp onsets with no pitch
  const y = new Float32Array(len);
  for (let t = 0.7; t < len / SR; t += every * (0.6 + 0.8 * rnd())) {
    const s = Math.floor(t * SR), amp = 0.05 + 0.1 * rnd();
    for (let i = 0; i < 0.06 * SR && s + i < len; i++) y[s + i] += amp * (rnd() * 2 - 1) * Math.exp(-i / (0.008 * SR));
  }
  return biquad(y, 'lp', 3000);
}
function scaleRms(y, db) { let e = 0; for (const v of y) e += v * v; const g = Math.pow(10, db / 20) / Math.sqrt(e / y.length || 1); for (let i = 0; i < y.length; i++) y[i] *= g; return y; }

// ---- protocol (mirrors the recording script)
const CHORDS = [
  ['C', [60, 64, 67]], ['F/C', [60, 65, 69]], ['G/B', [59, 62, 67]], ['Am', [60, 64, 69]], ['Dm', [62, 65, 69]], ['Em', [64, 67, 71]], ['G7', [55, 59, 65]],
  ['C both hands', [48, 60, 64, 67]], ['F both hands', [41, 60, 65, 69]], ['G both hands', [43, 59, 62, 67]], ['Am both hands', [45, 60, 64, 69]],
  ['C-E third', [60, 64]], ['C-G fifth', [60, 67]], ['C3-C4 octave', [48, 60]], ['C4-C5 octave', [60, 72]],
];
const isWhite = m => ![1, 3, 6, 8, 10].includes(m % 12);
function takes() {
  const T = {};
  const seq = (notes, gap, hold, vel, jitter = 0.08) => notes.map((n, i) => ({ start: 1.0 + i * gap + (rnd() * 2 - 1) * jitter, notes: [].concat(n), hold, vel }));
  const range = (a, b, f = () => true) => { const r = []; for (let m = a; m <= b; m++) if (f(m)) r.push(m); return r; };
  T.keys_mf = seq(range(36, 96), 2.0, 1.2, 1.0);
  T.keys_soft = seq(range(48, 84), 2.0, 1.2, 0.3);
  T.keys_loud = seq(range(48, 84, isWhite), 2.0, 1.2, 1.8);
  T.chords = CHORDS.flatMap(c => [c, c, c]).map((c, i) => ({ start: 1.0 + i * 2.5 + (rnd() * 2 - 1) * 0.08, notes: c[1], name: c[0], hold: 1.5, vel: 1.0, spread: 0.025 }));
  const rep = [...seq(Array(8).fill(60), 0.5, 0.35, 1.0, 0.02)];
  const rep2 = seq(Array(8).fill(64), 0.375, 0.28, 1.0, 0.02).map(e => ({ ...e, start: e.start + 5.5 }));
  T.repeats = [...rep, ...rep2];
  const sc = range(60, 84, isWhite); T.scale = seq([...sc, ...sc.slice(0, -1).reverse()], 0.3, 0.29, 1.0, 0.015);
  return T;
}

function render(events, len) {
  const y = new Float32Array(len);
  for (const e of events) e.notes.forEach(m => {
    const off = e.spread ? rnd() * e.spread : 0, g = e.vel * Math.pow(10, ((rnd() * 2 - 1) * 2) / 20);
    const s = Math.floor((e.start + off) * SR), x = note(m, e.hold);
    for (let i = 0; i < x.length && s + i < len; i++) y[s + i] += g * x[i];
  });
  return y;
}

const C4peak = (() => { const x = rawSample(60); let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; })();
const GAIN = Math.pow(10, -14 / 20) / C4peak;     // mf C4 peaks around -14 dBFS at the phone
function speakerAndRoom(y) {
  for (let i = 0; i < y.length; i++) y[i] *= GAIN;
  y = biquad(biquad(y, 'hp', HP), 'hp', HP);      // small speakers: little below ~160 Hz
  y = biquad(y, 'lp', 9000);
  return reverb(y, RT);
}
const CONDITIONS = {
  quiet: len => pink(len, -62 + NOFF),
  fan: len => { const a = fan(len, -46 + NOFF), b = pink(len, -60 + NOFF); for (let i = 0; i < len; i++) a[i] += b[i]; return a; },
  tv: len => { const a = voice(len, -40 + NOFF), b = pink(len, -60 + NOFF); for (let i = 0; i < len; i++) a[i] += b[i]; return a; },
};

export { note, render, speakerAndRoom, CONDITIONS, SR };
export function main() {
const all = takes();
for (const [cond, noise] of Object.entries(CONDITIONS)) {
  fs.mkdirSync(path.join(ROOT, OUT, cond), { recursive: true });
  for (const [name, events] of Object.entries(all)) {
    const end = Math.max(...events.map(e => e.start + e.hold)) + 1.5, len = Math.floor(end * SR);
    const y = speakerAndRoom(render(events, len)), nz = noise(len);
    for (let i = 0; i < len; i++) y[i] += nz[i];
    fs.writeFileSync(path.join(ROOT, OUT, cond, name + '.f32'), Buffer.from(y.buffer, y.byteOffset, y.byteLength));
    fs.writeFileSync(path.join(ROOT, OUT, cond, name + '.json'), JSON.stringify(events.map(({ start, notes, name }) => ({ start, notes, name }))));
  }
}
// silence take: 30 s quiet room, 30 s fan with knocks, 30 s TV voice with knocks
{
  const L = 30 * SR, parts = [pink(L, -62), (() => { const a = fan(L, -46), k = knocks(L); for (let i = 0; i < L; i++) a[i] += k[i]; return a; })(),
    (() => { const a = voice(L, -34), k = knocks(L); for (let i = 0; i < L; i++) a[i] += k[i]; return a; })()];
  const y = new Float32Array(3 * L); parts.forEach((p, j) => y.set(p, j * L));
  fs.mkdirSync(path.join(ROOT, OUT, 'silence'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT, 'silence', 'silence.f32'), Buffer.from(y.buffer));
  fs.writeFileSync(path.join(ROOT, OUT, 'silence', 'silence.json'), JSON.stringify([{ section: 'quiet', from: 0, to: 30 }, { section: 'fan + knocks', from: 30, to: 60 }, { section: 'TV voice + knocks', from: 60, to: 90 }]));
}
console.log('takes written');
}

if (process.argv[1] && process.argv[1].endsWith('synth.mjs')) main();
