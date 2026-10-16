// Scores the listener on labelled takes.
// Usage: node eval/run.mjs [takesDir=takes] [--json out.json]
// Each take is <name>.f32 (mono float32, 48 kHz) + <name>.json ([{start, notes}] or silence sections).
import fs from 'node:fs';
import path from 'node:path';
import { NoteListener } from '../dsp/listener.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = path.resolve(ROOT, process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'takes');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const SR = 48000, NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const load = f => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

// Drive the listener through a take. schedule: [{at, notes}] = when the app would show each target.
// probes: times at which to ask the MPM guess. Returns hit events and guesses.
function drive(audio, schedule, probes = []) {
  const L = new NoteListener(SR), hits = [], guesses = [];
  const marks = [...schedule.map(s => ({ t: s.at, s })), ...probes.map(p => ({ t: p, p }))].sort((a, b) => a.t - b.t);
  let pos = 0, mi = 0;
  const CH = 128; // AudioWorklet render quantum
  while (pos < audio.length) {
    const tNow = pos / SR;
    while (mi < marks.length && marks[mi].t <= tNow) { const m = marks[mi++]; if (m.s) { L.setExpected(m.s.notes); m.s.idx !== undefined && (L.idx = m.s.idx); } else guesses.push({ t: m.p, midi: L.guess() }); }
    for (const e of L.process(audio.subarray(pos, pos + CH))) if (e.type === 'hit') hits.push({ ...e, idx: L.idx });
    pos += CH;
  }
  return { hits, guesses };
}

// expected target is shown a little before each strike, after the previous strike began
function scheduleFor(events, transform = n => n) {
  return events.map((e, i) => {
    const prev = i ? events[i - 1].start : 0, at = Math.max(prev + 0.05, e.start - Math.min(0.6, (e.start - prev) * 0.6));
    return { at, notes: transform(e.notes, e), idx: i };
  });
}
function hitFor(hits, events, i) {
  const e = events[i], next = events[i + 1]?.start ?? Infinity;
  return hits.find(h => h.idx === i && h.time >= e.start - 0.03 && h.time < Math.min(next, e.start + 0.4));
}

const report = { takes: {}, perNote: {}, silence: null, octave: {} };
const conds = fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort();
for (const cond of conds) {
  for (const file of fs.readdirSync(path.join(dir, cond)).filter(f => f.endsWith('.json')).sort()) {
    const name = file.replace('.json', ''), events = JSON.parse(fs.readFileSync(path.join(dir, cond, file)));
    const audio = load(path.join(dir, cond, name + '.f32')), key = `${cond}/${name}`;
    if (events[0]?.section) { // silence: targets change every second, nothing should ever be accepted
      let r = 1; const sched = []; const pick = () => { r = (r * 1103515245 + 12345) >>> 0; return r; };
      for (let t = 0.5; t < audio.length / SR; t += 1.0) {
        const root = 48 + pick() % 37; sched.push({ at: t, notes: pick() % 3 === 0 ? [root, root + 4, root + 7] : [root] });
      }
      const { hits } = drive(audio, sched);
      report.silence = events.map(s => ({ section: s.section, falseNotes: hits.filter(h => h.time >= s.from && h.time < s.to).length, minutes: (s.to - s.from) / 60 }));
      continue;
    }
    const chord = events.some(e => e.notes.length > 1);
    const probes = chord ? [] : events.map(e => e.start + 0.08);
    const ok = drive(audio, scheduleFor(events), probes);
    const lat = [], misses = [];
    events.forEach((e, i) => { const h = hitFor(ok.hits, events, i); if (h) lat.push((h.time - e.start) * 1000); else misses.push(e.name || e.notes.map(nm).join('+')); });
    const t = { cond, take: name, total: events.length, hits: lat.length, hitRate: lat.length / events.length, misses,
      latency: lat.length ? { median: pct(lat, 50), p90: pct(lat, 90), max: Math.max(...lat) } : null, falseAccepts: {} };
    if (!chord) {
      events.forEach((e, i) => { const m = e.notes[0], k = `${cond}|${m}`; (report.perNote[k] ??= { cond, midi: m, n: 0, hit: 0 }).n++; if (hitFor(ok.hits, events, i)) report.perNote[k].hit++; });
      t.mpmAccuracy = ok.guesses.filter((g, i) => g.midi !== null && (g.midi - events[i].notes[0]) % 12 === 0).length / events.length;
      t.mpmExact = ok.guesses.filter((g, i) => g.midi === events[i].notes[0]).length / events.length;
      for (const [label, d] of [['semitone below', -1], ['semitone above', 1], ['octave below', -12], ['octave above', 12]]) {
        const r = drive(audio, scheduleFor(events, n => n.map(x => x + d)));
        t.falseAccepts[label] = events.filter((_, i) => hitFor(r.hits, events, i)).length / events.length;
      }
    } else {
      // wrong chord: move one note by a semitone, every note in turn (C major expected as C minor, etc.)
      let tried = 0, accepted = 0;
      for (let v = 0; v < 4; v++) for (const d of [-1, 1]) {
        const r = drive(audio, scheduleFor(events, ns => ns.map((x, j) => j === v ? x + d : x)));
        events.forEach((e, i) => { if (v < e.notes.length) { tried++; if (hitFor(r.hits, events, i)) accepted++; } });
      }
      t.falseAccepts['one note off'] = accepted / tried;
      const byChord = {}; events.forEach((e, i) => { (byChord[e.name] ??= [0, 0])[1]++; if (hitFor(ok.hits, events, i)) byChord[e.name][0]++; });
      t.byChord = byChord;
    }
    report.takes[key] = t;
  }
}
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

// ---- print
const f1 = x => (100 * x).toFixed(1) + '%';
console.log('\nTAKE                       HIT     LAT med/p90 ms   FALSE ACCEPTS');
for (const t of Object.values(report.takes)) {
  const fa = Object.entries(t.falseAccepts).map(([k, v]) => `${k} ${f1(v)}`).join(', ');
  console.log(`${(t.cond + '/' + t.take).padEnd(26)} ${f1(t.hitRate).padStart(6)}   ${t.latency ? `${t.latency.median.toFixed(0)}/${t.latency.p90.toFixed(0)}` : '-'}`.padEnd(52) + fa);
  if (t.misses.length) console.log('   missed:', t.misses.slice(0, 20).join(', ') + (t.misses.length > 20 ? ' ...' : ''));
  if (t.mpmAccuracy !== undefined) console.log(`   MPM (which note?): right note ${f1(t.mpmExact)}, right note name any octave ${f1(t.mpmAccuracy)}`);
}
if (report.silence) { console.log('\nSILENCE / NOISE (targets change every second; any accept is a false note)'); for (const s of report.silence) console.log(`   ${s.section.padEnd(20)} ${s.falseNotes} false notes in ${s.minutes * 60}s`); }
const weak = Object.values(report.perNote).filter(p => p.hit < p.n);
if (weak.length) console.log('\nNOTES NOT ALWAYS HEARD:', weak.map(p => `${p.cond}:${nm(p.midi)} ${p.hit}/${p.n}`).join(', '));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
