// Per-strike diagnostics: what the score looks like for the right note vs wrong candidates, and noise.
import fs from 'node:fs';
import { NoteListener, midiToHz } from '../dsp/listener.js';
const SR = 48000, load = f => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'], nm = m => NAMES[m%12] + (Math.floor(m/12)-1);
function scan(audio, t0, t1, m) { // max over hops in [t0,t1] of score + checks for note m
  const L = new NoteListener(SR); const s0 = Math.max(0, Math.floor((t0 - 0.3) * SR));
  L.process(audio.subarray(s0, Math.floor(t0 * SR)));
  let best = null; const pre = L.noteScore(m).score;
  for (let p = Math.floor(t0 * SR); p < t1 * SR; p += 256) {
    L.process(audio.subarray(p, p + 256));
    const sc = L.noteScore(m), f0 = midiToHz(m), odd = Math.max(L.snrAt(f0), L.snrAt(3*f0, 39), L.snrAt(5*f0, 45));
    const nb = Math.max(L.noteScore(m-1).score, L.noteScore(m+1).score), lo = Math.min(L.snrAt(1.5*f0, 39), L.snrAt(2.5*f0, 45));
    if (!best || sc.score > best.score) best = { score: sc.score, strong: sc.strong, odd, nbGap: sc.score - nb, lowerOct: lo, jump: sc.score - pre };
  }
  return best;
}
const cond = process.argv[2] || 'quiet', take = process.argv[3] || 'keys_mf';
const ev = JSON.parse(fs.readFileSync(`takes/${cond}/${take}.json`)), audio = load(`takes/${cond}/${take}.f32`);
const f = x => x.toFixed(1).padStart(5);
console.log('note  | RIGHT: score strong odd nbGap lowOct jump | OCT-ABOVE-PLAYED(expect m-12): score odd | OCT-BELOW-PLAYED(expect m+12): score lowOct');
for (const e of ev) {
  const m = e.notes[0], r = scan(audio, e.start, e.start + 0.15, m), a = scan(audio, e.start, e.start + 0.15, m - 12), b = scan(audio, e.start, e.start + 0.15, m + 12);
  console.log(`${nm(m).padEnd(5)} | ${f(r.score)} ${String(r.strong).padStart(2)} ${f(r.odd)} ${f(r.nbGap)} ${f(r.lowerOct)} ${f(r.jump)} | ${f(a.score)} ${f(a.odd)} | ${f(b.score)} ${f(b.lowerOct)}`);
}
// noise: score distribution of random notes over the silence take
const sil = load('takes/silence/silence.f32'); const sec = [[0,30,'quiet'],[30,60,'fan'],[60,90,'tv']];
for (const [a, bnd, label] of sec) {
  const L = new NoteListener(SR), vals = []; let r = 3;
  for (let p = a * SR; p < bnd * SR; p += 256) { L.process(sil.subarray(p, p + 256)); if (p % (256*8) === 0) { r = (r*1103515245+12345)>>>0; vals.push(L.noteScore(48 + r % 37).score); } }
  vals.sort((x, y) => x - y); const q = p => vals[Math.floor(p * (vals.length - 1))].toFixed(1);
  console.log(`noise ${label}: score p50 ${q(.5)} p90 ${q(.9)} p99 ${q(.99)} max ${q(1)}`);
}
