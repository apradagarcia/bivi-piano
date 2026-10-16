// Renders the Listener Lab demo recordings (mp3) + their ground truth.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render, speakerAndRoom, CONDITIONS, SR } from './synth.mjs';
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const T = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60]; // Twinkle, first two phrases
function demo(name, cond, strikes, targets, title, desc) {
  // strikes: [{t, notes, hold, ok}] ; targets: the song the app expects
  const events = strikes.map(s => ({ start: s.t, notes: s.notes, hold: s.hold ?? 0.42, vel: s.vel ?? 1, spread: s.notes.length > 1 ? 0.025 : 0 }));
  const len = Math.floor((Math.max(...strikes.map(s => s.t)) + 2) * SR), y = speakerAndRoom(render(events, len)), nz = CONDITIONS[cond](len);
  for (let i = 0; i < len; i++) y[i] = Math.max(-1, Math.min(1, y[i] + nz[i]));
  const raw = path.join(OUT, name + '.f32'); fs.writeFileSync(raw, Buffer.from(y.buffer));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw, '-b:a', '96k', path.join(OUT, name + '.mp3')]); fs.unlinkSync(raw);
  return { name, cond, title, desc, file: name + '.mp3', targets, strikes: strikes.map(s => ({ t: +s.t.toFixed(3), notes: s.notes, ok: s.ok })) };
}
const seqStrikes = (notes, gap, t0 = 1) => notes.map((n, i) => ({ t: t0 + i * gap, notes: [n], ok: true }));
const demos = [];
demos.push(demo('twinkle-quiet', 'quiet', seqStrikes(T, 0.6), T.map(n => [n]), 'Twinkle, quiet room', 'A clean run of the first two phrases.'));
// mistakes a learner makes: wrong neighbour key, right note in the wrong octave, a slip, each followed by the fix
{
  const s = []; let t = 1; const add = (n, ok, gap = 0.6) => { s.push({ t, notes: [n], ok }); t += gap; };
  add(60, true); add(60, true); add(68, false, 0.75); add(67, true); add(67, true); add(81, false, 0.75); add(69, true); add(69, true); add(67, true, 0.9);
  add(65, true); add(64, false, 0.75); add(65, true); add(64, true); add(64, true); add(62, true); add(50, false, 0.75); add(62, true); add(60, true);
  demos.push(demo('twinkle-mistakes-fan', 'fan', s, T.map(n => [n]), 'Twinkle with 4 mistakes, fan on', 'Wrong key (G♯ for G), right note an octave too high (A5 for A4), a slip to E instead of F, and D an octave low. Each is followed by the fix.'));
}
{
  const sc = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84]; const up = [...sc, ...sc.slice(0, -1).reverse()];
  demos.push(demo('scale-fast-fan', 'fan', seqStrikes(up, 0.3), up.map(n => [n]), 'Fast scale, fan on', 'Two octaves up and down at about 3 notes per second.'));
}
{
  const C = [['C', [60, 64, 67]], ['F/C', [60, 65, 69]], ['G/B', [59, 62, 67]], ['Am', [60, 64, 69]], ['C both hands', [48, 60, 64, 67]], ['F both hands', [41, 60, 65, 69]], ['G both hands', [43, 59, 62, 67]], ['C', [60, 64, 67]]];
  const s = C.map((c, i) => ({ t: 1 + i * 1.6, notes: c[1], hold: 1.2, ok: true }));
  // one wrong chord: C minor played where C major is expected, then the fix
  s.splice(1, 0, { t: 0, notes: [60, 63, 67], hold: 1.0, ok: false }); s.forEach((x, i) => x.t = 1 + i * 1.6);
  demos.push(demo('chords-tv', 'tv', s, C.map(c => c[1]), 'Chords with the TV on', 'Pop progression C, F, G, Am, then both hands. The 2nd chord is a mistake (C minor instead of C major), then the fix.'));
}
fs.writeFileSync(path.join(OUT, 'demos.json'), JSON.stringify(demos));
console.log(demos.map(d => `${d.file}: ${d.strikes.length} strikes`).join('\n'));
