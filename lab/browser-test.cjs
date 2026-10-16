// Opens the lab in Chromium, runs each demo, prints the scorecard and the log.
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path');
(async () => {
  const dir = __dirname, types = { html: 'text/html', json: 'application/json', wav: 'audio/wav' };
  const srv = http.createServer((q, r) => { const f = path.join(dir, q.url === '/' ? 'index.html' : q.url.slice(1)); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': (types[f.split('.').pop()] || 'text/plain') + '; charset=utf-8' }); r.end(fs.readFileSync(f)); }).listen(8766);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.goto('http://localhost:8766/'); await page.waitForSelector('.demo');
  const n = await page.locator('.demo').count();
  for (let i = 0; i < n; i++) {
    await page.locator('.demo').nth(i).click();
    await page.waitForFunction(() => document.getElementById('scorecard').hidden, null, { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById('scorecard').hidden, null, { timeout: 60000 });
    const res = await page.evaluate(() => { const sc = id => document.getElementById(id).textContent; return ({ title: document.querySelectorAll('.demo')[0] && null, done: sc('sc-done'), wrong: sc('sc-wrong'), fa: sc('sc-false'), delay: sc('sc-delay'), verdict: document.getElementById('verdict').textContent, log: [...document.querySelectorAll('#log li')].slice(0, 6).map(l => l.textContent).reverse() }); });
    const title = await page.locator('.demo b').nth(i).textContent();
    console.log(`\n${title}: done ${res.done} | mistakes ignored ${res.wrong} | wrong accepted ${res.fa} | delay ${res.delay}\n  ${res.verdict}\n  last log: ${res.log.join(' / ')}`);
    if (i === 1) await page.screenshot({ path: path.join(dir, 'shot.png'), fullPage: true });
  }
  await browser.close(); srv.close();
})();
