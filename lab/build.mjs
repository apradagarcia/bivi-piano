// Inlines dsp/listener.js into the lab page (one file: works as an artifact and opened locally)
import fs from 'node:fs';
const lib = fs.readFileSync(new URL('../dsp/listener.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const src = fs.readFileSync(new URL('./lab.src.html', import.meta.url), 'utf8');
fs.writeFileSync(new URL('./index.html', import.meta.url), src.replace('/*LISTENER*/', () => lib));
console.log('built lab/index.html');
