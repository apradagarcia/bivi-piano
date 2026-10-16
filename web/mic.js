// Main-thread side: opens the mic with iOS voice processing OFF and connects it to the worklet.
export async function startListening(onHit) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('piano-listener.worklet.js');
  const node = new AudioWorkletNode(ctx, 'piano-listener', { numberOfInputs: 1, numberOfOutputs: 0 });
  ctx.createMediaStreamSource(stream).connect(node);
  node.port.onmessage = e => e.data.type === 'hit' && onHit(e.data);
  let id = 0;
  return {
    expect(notes) { node.port.postMessage({ type: 'expect', notes, id: ++id }); return id; },
    ctx, stream, stop() { stream.getTracks().forEach(t => t.stop()); ctx.close(); },
  };
}
