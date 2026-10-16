import fs from 'node:fs';
import { NoteListener } from '../dsp/listener.js';
const SR = 48000, load = f => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'], nm = m => NAMES[m%12] + (Math.floor(m/12)-1);
const cond = process.argv[2] || 'quiet', ev = JSON.parse(fs.readFileSync(`takes/${cond}/chords.json`)), audio = load(`takes/${cond}/chords.f32`);
for (const e of ev.filter((_, i) => i % 3 === 0)) {
  const L = new NoteListener(SR); L.process(audio.subarray(Math.floor((e.start - 0.5) * SR), Math.floor(e.start * SR))); L.setExpected(e.notes);
  const reasons = Object.fromEntries(e.notes.map(m => [m, {}])); let maxScore = Object.fromEntries(e.notes.map(m => [m, 0]));
  for (let p = Math.floor(e.start * SR); p < (e.start + 0.2) * SR; p += 256) {
    L.process(audio.subarray(p, p + 256));
    for (const m of e.notes) { const r = L.why(m, true) || 'OK'; reasons[m][r] = (reasons[m][r] || 0) + 1; maxScore[m] = Math.max(maxScore[m], L.noteScore(m).score); }
  }
  console.log(e.name.padEnd(14), e.notes.map(m => `${nm(m)}[${maxScore[m].toFixed(0)}] ${Object.entries(reasons[m]).map(([k, v]) => k + ':' + v).join(' ')}`).join(' | '));
}
