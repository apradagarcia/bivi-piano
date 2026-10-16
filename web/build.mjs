// Bundles dsp/listener.js + the processor into one classic script (Safari-safe: no module imports in the worklet)
import fs from 'node:fs';
const lib = fs.readFileSync(new URL('../dsp/listener.js', import.meta.url), 'utf8').replace(/^export /gm, '');
fs.writeFileSync(new URL('./piano-listener.worklet.js', import.meta.url), lib + '\n' + fs.readFileSync(new URL('./processor.src.js', import.meta.url), 'utf8'));
console.log('built web/piano-listener.worklet.js');
