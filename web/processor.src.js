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
