// Piano note listener. Pure JS, no dependencies, runs inside an AudioWorklet and in Node.
//
// Two jobs:
//  1. Expected-note matching (gameplay): the app always knows which note or chord comes next,
//     so instead of guessing "what is playing", we ask "are THESE notes being struck right now?"
//     Each expected note is scored by how far its harmonics rise above the room noise and above
//     the leakage of louder nearby partials, checked against its semitone neighbours and octaves.
//     A note only counts when its own harmonics jump (a fresh key strike), so ringing notes,
//     fans and voices do not.
//  2. McLeod Pitch Method (MPM) for single notes: used to say which wrong note was played.

const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

// ---------- FFT (in place, radix 2) ----------
function makeFFT(n) {
  const levels = Math.log2(n) | 0, rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half, tr = re[b] * cos[k] + im[b] * sin[k], ti = -re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
}

// ---------- McLeod Pitch Method ----------
function mpm(buf, sr, minHz = 60, maxHz = 2200) {
  const n = buf.length, maxLag = Math.min(n >> 1, Math.ceil(sr / minHz)), minLag = Math.floor(sr / maxHz);
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0, m = 0;
    for (let i = 0; i < n - tau; i++) { acf += buf[i] * buf[i + tau]; m += buf[i] * buf[i] + buf[i + tau] * buf[i + tau]; }
    nsdf[tau] = m > 0 ? 2 * acf / m : 0;
  }
  const peaks = []; let pos = false, best = -1, bestV = -1;
  for (let t = Math.max(1, minLag); t < maxLag; t++) {
    if (nsdf[t] > 0 && nsdf[t - 1] <= 0) { pos = true; best = -1; bestV = -1; }
    if (pos && nsdf[t] > bestV) { bestV = nsdf[t]; best = t; }
    if (pos && nsdf[t] <= 0 && nsdf[t - 1] > 0) { if (best > 0) peaks.push([best, bestV]); pos = false; }
  }
  if (!peaks.length) return { hz: -1, clarity: 0 };
  const top = Math.max(...peaks.map(p => p[1])), pick = peaks.find(p => p[1] >= 0.9 * top);
  const t = pick[0], a = nsdf[t - 1], b = nsdf[t], c = nsdf[t + 1] ?? b, d = a - 2 * b + c, shift = d ? 0.5 * (a - c) / d : 0;
  return { hz: sr / (t + shift), clarity: pick[1] };
}

// Hann window leakage envelope, dB below a peak, at a distance of d bins
const hannLeak = d => d < 1.5 ? 0 : 20 * Math.log10(1 / (Math.PI * d * (d * d - 1)));

// ---------- Listener ----------
const DEFAULTS = {
  n: 2048,            // analysis window (43 ms at 48 kHz)
  hop: 256,           // 5.3 ms between analyses
  harmonics: 8,
  maxHz: 7000,
  cents: 30,          // tolerance around each harmonic (widened for upper partials)
  topK: 3,            // a note is scored on its strongest harmonics
  // thresholds below were set from measured score distributions (eval/diag.mjs), not guessed
  onThr: 12,          // dB, single note (right notes measured 15-40, room noise under 10)
  chordThr: 9,        // dB, each note of a chord
  neighbourMargin: 6, // dB the expected note must beat its semitone neighbours by
  oddThr: 30,         // dB at f, 3f or 5f (right notes ~40, octave-above-played under 25)
  lowerOctThr: 8,     // dB at 1.5f, 2.5f, 3.5f (right notes ~0, octave-below-played median 23)
  jumpDb: 8,          // a strike = the note's score rises this much within jumpMs
  jumpMs: 45,
  confirmHops: 3,
  driftCents: 12,     // single notes: the strongest partial must hold its pitch (voices glide, strings do not)
  freshMs: 150,       // after the jump, the note must be confirmed within this long
  chordWindowMs: 200, // all chord notes must be struck within this long of each other
  leakMargin: 6,      // dB above the estimated leakage of louder partials
  range: 40,          // dB: partials further below the loudest one are ignored
};

class NoteListener {
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate; this.o = { ...DEFAULTS, ...opts };
    const { n } = this.o;
    this.fft = makeFFT(n); this.re = new Float64Array(n); this.im = new Float64Array(n);
    this.win = new Float64Array(n).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    this.ring = new Float32Array(n); this.w = 0; this.filled = 0; this.sinceHop = 0;
    this.db = new Float64Array(n / 2); this.floor = new Float64Array(n / 2).fill(NaN);
    this.leak = []; for (let d = 0; d <= 24; d++) this.leak.push(hannLeak(d));
    this.t = 0; this.frames = 0; this.frameMax = -1e9; this.expected = []; this.st = null;
  }
  setExpected(midis) {
    this.expected = [...midis].sort((a, b) => a - b);
    this.st = { notes: new Map(this.expected.map(m => [m, { hist: [], fresh: -1e9, confirm: 0, hit: null }])), done: false };
  }
  get time() { return this.t / this.sr; }

  process(samples) {
    const out = [], { n, hop } = this.o;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.w] = samples[i]; this.w = (this.w + 1) % n; this.t++;
      if (this.filled < n) this.filled++;
      if (++this.sinceHop >= hop && this.filled === n) { this.sinceHop = 0; this.analyse(out); }
    }
    return out;
  }

  analyse(out) {
    const { n } = this.o, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[i] = this.ring[(this.w + i) % n] * this.win[i]; im[i] = 0; }
    this.fft(re, im);
    let frameMax = -1e9;
    for (let k = 0; k < n / 2; k++) {
      const d = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-14), f = this.floor[k];
      this.db[k] = d;
      // noise floor = running average level of each bin while it is quiet. While a note sounds
      // there (well above the average) it barely moves, so held notes do not erase themselves.
      this.floor[k] = Number.isNaN(f) ? d : d < f + 10 ? f + (this.frames < 60 ? 0.15 : 0.02) * (d - f) : f + 0.003;
      if (d > frameMax) frameMax = d;
    }
    this.frames++; this.frameMax = frameMax;
    const s = this.st;
    if (!s || s.done) return;
    const now = this.time * 1000, chord = this.expected.length > 1, o = this.o;
    for (const [m, ns] of s.notes) {
      if (ns.hit !== null) continue;
      const { score } = this.noteScore(m), pos = this.lastF0;
      ns.hist.push([now, score]); while (ns.hist.length && now - ns.hist[0][0] > o.jumpMs) ns.hist.shift();
      const low = Math.min(...ns.hist.map(h => h[1]));
      if (score - low >= o.jumpDb) ns.fresh = now;
      let ok = now - ns.fresh <= o.freshMs && this.notePresent(m, chord);
      if (ok && !chord && ns.confirm > 0 && Math.abs(1200 * Math.log2(pos / ns.pos0)) > o.driftCents) ok = false;
      if (ok && ns.confirm === 0) ns.pos0 = pos;
      ns.confirm = ok ? ns.confirm + 1 : 0;
      if (ns.confirm >= o.confirmHops) ns.hit = now;
    }
    // a chord note heard too long before the others is stale: let it be struck again
    if (chord) for (const ns of s.notes.values()) if (ns.hit !== null && now - ns.hit > o.chordWindowMs) { ns.hit = null; ns.confirm = 0; }
    const hits = [...s.notes.values()].map(x => x.hit);
    if (hits.every(h => h !== null)) {
      s.done = true;
      out.push({ type: 'hit', notes: this.expected.slice(), time: now / 1000, onset: Math.min(...hits) / 1000 });
    }
  }

  // SNR (dB) of a spectral PEAK whose interpolated centre lies within +-cents of hz, measured
  // against the louder of: the room noise floor, or leakage from stronger peaks nearby.
  snrAt(hz, cents = this.o.cents) {
    const { n, leakMargin } = this.o, b = hz * n / this.sr, db = this.db;
    if (b >= n / 2 - 2 || b < 1) return 0;
    const tol = Math.max(b * (Math.pow(2, cents / 1200) - 1), 0.22);
    const lo = Math.max(1, Math.floor(b - tol - 1)), hi = Math.min(n / 2 - 2, Math.ceil(b + tol + 1));
    let best = 0;
    for (let k = lo; k <= hi; k++) {
      const a = db[k - 1], c = db[k], d = db[k + 1];
      if (c < a || c < d) continue;
      const den = a - 2 * c + d, off = den ? 0.5 * (a - d) / den : 0;
      if (Math.abs(k + off - b) > tol) continue;
      const peak = c - 0.25 * (a - d) * off;
      // reference: room noise (+3 dB), or 40 dB under the loudest partial, or leakage of louder peaks
      let ref = Math.max(this.floor[k] + 3, this.frameMax - this.o.range);
      for (let j = Math.max(1, k - 24); j <= Math.min(n / 2 - 1, k + 24); j++) {
        const dist = Math.abs(j - k); if (dist < 2 || db[j] <= peak) continue;
        const l = db[j] + this.leak[dist] + leakMargin; if (l > ref) ref = l;
      }
      const v = peak - ref; if (v > best) { best = v; this.lastPos = k + off; }
    }
    return Math.min(60, best);
  }

  noteScore(m) {
    const f0 = midiToHz(m), { harmonics, maxHz, cents, topK } = this.o, v = [];
    // piano strings are stiff, so upper partials run sharp: widen the window as h grows
    let top = -1;
    for (let h = 1; h <= harmonics && f0 * h < maxHz; h++) {
      this.lastPos = 0; const x = this.snrAt(f0 * h, cents + 3 * h); v.push(x);
      if (x > top && this.lastPos) { top = x; this.lastF0 = this.lastPos * this.sr / this.o.n / h; } // pitch implied by the strongest partial
    }
    v.sort((a, b) => b - a);
    const k = Math.min(topK, v.length);
    let sum = 0; for (let i = 0; i < k; i++) sum += v[i];
    return { score: k ? sum / k : 0, strong: v.filter(x => x > 6).length, nh: v.length };
  }

  notePresent(m, chord) { return this.why(m, chord) === ''; }

  // '' if note m is being played, otherwise the name of the first check that failed
  why(m, chord) {
    const o = this.o, { score, strong, nh } = this.noteScore(m), f0 = midiToHz(m);
    if (score < (chord ? o.chordThr : o.onThr)) return 'weak';
    if (strong < Math.min(2, nh)) return 'few-partials';
    // played an octave above? then f, 3f and 5f are silent. Right notes measured odd >= score.
    const odd = Math.max(this.snrAt(f0), this.snrAt(3 * f0, o.cents + 9), this.snrAt(5 * f0, o.cents + 15));
    if (odd < (chord ? 0.6 * score : Math.min(o.oddThr, 0.9 * score)) && !(chord && this.expected.includes(m + 12))) return 'octave-above';
    for (const nb of [m - 1, m + 1]) {
      if (chord && this.expected.includes(nb)) continue;
      if (score - this.noteScore(nb).score < (chord ? o.neighbourMargin / 2 : o.neighbourMargin)) return 'neighbour';
    }
    // played an octave below? then 1.5f, 2.5f and 3.5f (its 3rd, 5th and 7th partials) ring too.
    // Not usable inside chords: a triad's own fifth and third sit exactly there.
    // Measured: right notes almost never show 2 of these 3, the octave below shows all 3 (eval/diag_oct.mjs).
    if (!chord && [1.5, 2.5, 3.5].filter((r, i) => this.snrAt(r * f0, o.cents + 9 + 6 * i) > o.lowerOctThr).length >= 2) return 'octave-below';
    return '';
  }

  // which single note is sounding (for "you played X" hints)
  guess() {
    const { n } = this.o, buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = this.ring[(this.w + i) % n];
    const r = mpm(buf, this.sr);
    return r.hz > 0 && r.clarity > 0.8 ? Math.round(12 * Math.log2(r.hz / 440) + 69) : null;
  }
}

// AudioWorklet processor: runs the NoteListener on the audio thread, 128 samples at a time.
// Messages in:  {type:'expect', notes:[midi...], id}   Messages out: {type:'hit', id, notes, latencyMs}
class PianoListenerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = new NoteListener(sampleRate); // sampleRate is a worklet global (48000 on iPhone)
    this.id = null;
    this.port.onmessage = e => { if (e.data.type === 'expect') { this.id = e.data.id; this.L.setExpected(e.data.notes); } };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (const ev of this.L.process(ch)) if (ev.type === 'hit')
      this.port.postMessage({ type: 'hit', id: this.id, notes: ev.notes, time: ev.time, chordSpreadMs: (ev.time - ev.onset) * 1000 });
    return true;
  }
}
registerProcessor('piano-listener', PianoListenerProcessor);
