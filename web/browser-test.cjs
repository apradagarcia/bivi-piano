// Runs the real AudioWorklet in Chromium, with a take fed in as the microphone.
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path');
(async () => {
  const take = process.argv[2], dir = __dirname;
  const srv = http.createServer((q, r) => {
    const f = q.url === '/seq.json' ? `seq_${take}.json` : q.url.slice(1);
    const p = path.join(dir, f); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : 'text/html' }); r.end(fs.readFileSync(p));
  }).listen(8765);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(dir, take + '.wav')}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage(); page.on('console', m => console.log('page:', m.text())); page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://localhost:8765/harness.html');
  const n = JSON.parse(fs.readFileSync(path.join(dir, `seq_${take}.json`))).length;
  const t0 = Date.now(); while (Date.now() - t0 < 135000) { if (await page.evaluate(() => window.DONE === true)) break; await new Promise(r => setTimeout(r, 500)); }
  const log = await page.evaluate(() => window.LOG || []), sr = await page.evaluate(() => window.SR);
  console.log(`${take}: ${log.length}/${n} targets completed in wait mode inside the AudioWorklet (sampleRate ${sr})`);
  // latency: align worklet hit times to the take's true strike times (unknown start offset = best fit)
  const truth = JSON.parse(fs.readFileSync(path.join(dir, '..', 'takes_heldout', 'quiet', take + '.json'))).map(e => e.start);
  const d = log.map(l => l.audioTime - truth[l.i]).sort((a, b) => a - b), off = d[0];
  const lat = d.map(x => (x - off) * 1000);
  if (lat.length) console.log(`   relative delay spread (worst minus best strike): median ${lat[lat.length >> 1].toFixed(0)} ms, max ${lat[lat.length - 1].toFixed(0)} ms`);
  await browser.close(); srv.close();
})();
