// Turns Bivi's Voice Memos recordings into labelled takes for eval/run.mjs.
// Usage: node eval/import-real.mjs <folder-with-recordings> [outDir=takes_real]
// Files are matched by name: "1 silence", "2 keys medium", "3 keys soft", "4 keys loud", "5 chords", "6 repeats", "7 scale"
// (any audio format ffmpeg reads; Voice Memos gives .m4a). Strikes are found by an energy-onset detector that is
// independent of the listener, then labelled in script order. If the count does not match the script, the take is
// reported and skipped instead of being mislabelled.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFFT, mpm } from '../dsp/listener.js';

const SR = 48000, src = path.resolve(process.argv[2]), out = path.resolve(process.argv[3] || 'takes_real');
const isWhite = m => ![1, 3, 6, 8, 10].includes(m % 12);
const range = (a, b, f = () => true) => { const r = []; for (let m = a; m <= b; m++) if (f(m)) r.push(m); return r; };
const CHORDS = [['C', [60, 64, 67]], ['F/C', [60, 65, 69]], ['G/B', [59, 62, 67]], ['Am', [60, 64, 69]], ['Dm', [62, 65, 69]], ['Em', [64, 67, 71]], ['G7', [55, 59, 65]],
  ['C both hands', [48, 60, 64, 67]], ['F both hands', [41, 60, 65, 69]], ['G both hands', [43, 59, 62, 67]], ['Am both hands', [45, 60, 64, 69]],
  ['C-E third', [60, 64]], ['C-G fifth', [60, 67]], ['C3-C4 octave', [48, 60]], ['C4-C5 octave', [60, 72]]];
const sc = range(60, 84, isWhite);
const SCRIPT = {
  keys_mf: { match: /keys.*med|medium|mf/i, seq: range(36, 96).map(m => [m]), gap: 0.7 },
  keys_soft: { match: /soft/i, seq: range(48, 84).map(m => [m]), gap: 0.7 },
  keys_loud: { match: /loud/i, seq: range(48, 84, isWhite).map(m => [m]), gap: 0.7 },
  chords: { match: /chord/i, seq: CHORDS.flatMap(c => [c, c, c]).map(c => c[1]), names: CHORDS.flatMap(c => [c[0], c[0], c[0]]), gap: 0.7 },
  repeats: { match: /repeat/i, seq: [...Array(8).fill([60]), ...Array(8).fill([64])], gap: 0.2 },
  scale: { match: /scale/i, seq: [...sc, ...sc.slice(0, -1).reverse()].map(m => [m]), gap: 0.15 },
};

function decode(file) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}
// strike finder: band energy 200-5000 Hz (fans and hum live lower) in 5 ms steps. Every local rise is a
// candidate; we keep the N strongest that are at least minGap apart, N being what the script says was played.
function onsets(x, minGap, N) {
  const n = 1024, hop = 240, fft = makeFFT(n), re = new Float64Array(n), im = new Float64Array(n), e = [];
  const k0 = Math.floor(200 * n / SR), k1 = Math.ceil(5000 * n / SR);
  for (let i = 0; i + n <= x.length; i += hop) {
    for (let j = 0; j < n; j++) { re[j] = x[i + j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / (n - 1))); im[j] = 0; }
    fft(re, im); let s = 0; for (let k = k0; k <= k1; k++) s += re[k] * re[k] + im[k] * im[k];
    e.push(10 * Math.log10(s + 1e-12));
  }
  const room = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.2)], cand = [];
  for (let i = 8; i < e.length - 1; i++) {
    const rise = e[i] - Math.min(...e.slice(i - 8, i));
    if (rise > 3 && e[i] > room + 6 && rise >= e[i + 1] - Math.min(...e.slice(i - 7, i + 1))) cand.push({ t: (i * hop + n / 2) / SR, rise });
  }
  const picked = [];
  for (const c of cand.sort((a, b) => b.rise - a.rise)) { if (picked.length === N) break; if (picked.every(p => Math.abs(p.t - c.t) > minGap)) picked.push(c); }
  return picked.map(p => p.t - 0.033).sort((a, b) => a - b); // measured: raw estimates run ~21 ms late
}
// independent check of the labels: pitch (MPM) 80 ms after each strike should match the scripted note
function pitchAgreement(x, starts, seq) {
  let ok = 0, tried = 0;
  starts.forEach((t, i) => {
    if (seq[i].length !== 1) return; tried++;
    const s = Math.floor((t + 0.08) * SR), r = mpm(x.subarray(s, s + 2048), SR);
    if (r.hz > 0 && Math.round(12 * Math.log2(r.hz / 440) + 69) % 12 === seq[i][0] % 12) ok++;
  });
  return tried ? ok / tried : 1;
}

fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter(f => /\.(m4a|wav|mp3|aac|caf|aiff?)$/i.test(f));
for (const [take, spec] of Object.entries(SCRIPT)) {
  const f = files.find(n => spec.match.test(n));
  if (!f) { console.log(`- ${take}: no file found`); continue; }
  const x = decode(path.join(src, f)), on = onsets(x, spec.gap, spec.seq.length);
  if (on.length !== spec.seq.length) { console.log(`! ${take} (${f}): found ${on.length} strikes, script has ${spec.seq.length}. Skipped; listen for a missed or extra note.`); continue; }
  const agree = pitchAgreement(x, on, spec.seq);
  if (agree < 0.85) { console.log(`! ${take} (${f}): labels look shifted (pitch agrees on ${(100 * agree).toFixed(0)}% of strikes). Skipped; check the order was followed.`); continue; }
  fs.mkdirSync(path.join(out, 'real'), { recursive: true });
  fs.writeFileSync(path.join(out, 'real', take + '.f32'), Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  fs.writeFileSync(path.join(out, 'real', take + '.json'), JSON.stringify(spec.seq.map((notes, i) => ({ start: on[i], notes, name: spec.names?.[i] }))));
  console.log(`✓ ${take} (${f}): ${on.length} strikes labelled` + (spec.seq[0].length === 1 ? `, pitch check ${(100 * pitchAgreement(x, on, spec.seq)).toFixed(0)}%` : ''));
}
const sil = files.find(n => /silence|quiet|room/i.test(n));
if (sil) {
  const x = decode(path.join(src, sil)), d = x.length / SR, third = d / 3;
  fs.mkdirSync(path.join(out, 'silence'), { recursive: true });
  fs.writeFileSync(path.join(out, 'silence', 'silence.f32'), Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  fs.writeFileSync(path.join(out, 'silence', 'silence.json'), JSON.stringify([{ section: 'quiet', from: 0, to: third }, { section: 'fan + knocks', from: third, to: 2 * third }, { section: 'TV voice + knocks', from: 2 * third, to: d }]));
  console.log(`✓ silence (${sil}): ${d.toFixed(0)} s in 3 sections`);
}
