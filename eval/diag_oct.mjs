import fs from 'node:fs';
import { NoteListener, midiToHz } from '../dsp/listener.js';
const SR = 48000, load = f => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'], nm = m => NAMES[m%12] + (Math.floor(m/12)-1);
// for expected note x, the "between" partials 1.5x, 2.5x, 3.5x: zero if x is played, strong if x-12 is played
function feats(L, x) { const f = midiToHz(x), c = L.o.cents; const v = [L.snrAt(1.5*f, c+9), L.snrAt(2.5*f, c+15), L.snrAt(3.5*f, c+21)]; return { mx: Math.max(...v), sum: v.reduce((a,b)=>a+b,0), cnt: v.filter(z => z > 8).length, score: L.noteScore(x).score }; }
const rows = { right: [], lower: [] };
for (const [cond, take] of [['quiet','keys_mf'],['quiet','keys_soft'],['fan','keys_soft'],['fan','keys_mf'],['tv','keys_soft']]) {
  const ev = JSON.parse(fs.readFileSync(`takes/${cond}/${take}.json`)), a = load(`takes/${cond}/${take}.f32`);
  for (const e of ev) {
    const m = e.notes[0], L = new NoteListener(SR); L.process(a.subarray(Math.floor((e.start - 0.4) * SR), Math.floor(e.start * SR)));
    let bestR = null, bestL = null;
    for (let p = Math.floor(e.start * SR); p < (e.start + 0.12) * SR; p += 256) {
      L.process(a.subarray(p, p + 256));
      const r = feats(L, m), l = feats(L, m + 12);
      if (!bestR || r.score > bestR.score) bestR = r; if (!bestL || l.score > bestL.score) bestL = l;
    }
    rows.right.push({ cond, take, m, ...bestR }); rows.lower.push({ cond, take, m, ...bestL });
  }
}
const q = (arr, k, p) => { const s = arr.map(r => r[k]).sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))].toFixed(1); };
for (const k of ['mx', 'sum', 'cnt']) console.log(k.padEnd(4), 'RIGHT note  p50', q(rows.right, k, .5), 'p95', q(rows.right, k, .95), 'max', q(rows.right, k, 1), '| LOWER octave played  p5', q(rows.lower, k, .05), 'p10', q(rows.lower, k, .1), 'p50', q(rows.lower, k, .5));
console.log('right notes with mx>8:', rows.right.filter(r => r.mx > 8).map(r => `${r.cond}/${r.take}:${nm(r.m)}=${r.mx.toFixed(0)}`).join(' '));
console.log('lower-played with mx<=8 AND score>=12:', rows.lower.filter(r => r.mx <= 8 && r.score >= 12).map(r => `${r.cond}/${r.take}:${nm(r.m)}`).join(' '));
