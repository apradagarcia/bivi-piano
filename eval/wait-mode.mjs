// Plays a demo through the listener the way the app will: wait mode, the target advances only on a hit.
// Reports right strikes accepted, mistakes rejected, and delay. Usage: node eval/wait-mode.mjs lab
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NoteListener } from '../dsp/listener.js';
const dir = process.argv[2], SR = 48000;
for (const d of JSON.parse(fs.readFileSync(path.join(dir, 'demos.json')))) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(dir, d.file), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), L = new NoteListener(SR);
  let ti = 0; L.setExpected(d.targets[0]); const hits = [];
  for (let p = 0; p < x.length && ti < d.targets.length; p += 128) for (const e of L.process(x.subarray(p, p + 128))) if (e.type === 'hit') { hits.push(e.time); if (++ti < d.targets.length) L.setExpected(d.targets[ti]); }
  // match each hit to the strike just before it (mp3 encoder adds a small fixed delay; allow up to 400 ms)
  let okAcc = 0, wrongAcc = 0; const lat = [];
  for (const h of hits) { const s = [...d.strikes].reverse().find(s => s.t <= h + 0.03); if (!s || h - s.t > 0.4) continue; if (s.ok) { okAcc++; lat.push((h - s.t) * 1000); } else wrongAcc++; }
  const mistakes = d.strikes.filter(s => !s.ok).length; lat.sort((a, b) => a - b);
  console.log(`${d.title.padEnd(34)} targets done ${ti}/${d.targets.length} | mistakes rejected ${mistakes - wrongAcc}/${mistakes} | median delay ${lat[lat.length >> 1]?.toFixed(0)} ms`);
}
