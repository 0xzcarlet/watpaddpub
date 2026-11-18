import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WattpadBrowser } from '../src/browser.js';

test('browser: manual-login detection, session reuse/expiry, and full pagination', { skip: process.env.RUN_BROWSER_TESTS !== '1' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'wp-browser-test-'));
  const context = await chromium.launchPersistentContext(join(home, 'profile'), { channel: 'chrome', headless: true });
  let logins = 0;
  let challenge = false;
  await context.route('https://www.wattpad.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/login') {
      logins++;
      await route.fulfill({ contentType: 'text/html', body: '<script>document.cookie="test-session=yes; path=/";window.wattpad={currentUser:{username:"fixture"}}</script>' });
      return;
    }
    const index = url.pathname.endsWith('/page/2') ? 2 : 1;
    if (challenge && index === 2) {
      await route.fulfill({ status: 405, headers: { 'x-amzn-waf-action': 'captcha' }, contentType: 'text/html', body: '<h1>Human checking fixture</h1>' });
      return;
    }
    const loggedIn = (route.request().headers().cookie ?? '').includes('test-session=yes');
    const data = { id: 200, group: { id: 100 }, anonymousUser: !loggedIn, pages: 2, pageNumber: index, lastPage: index === 2, nextPage: index === 1 ? '/200/page/2' : '', modifyDate: 'revision' };
    await route.fulfill({ contentType: 'text/html', body: `<script>window.prefetched=${JSON.stringify({ 'part.200.metadata': { data } })};</script><div id="story-reading"><div class="panel-reading"><pre><p>Page ${index}</p></pre></div></div>` });
  });
  const browser = new WattpadBrowser(home, () => {});
  // Inject an isolated routed browser; production still uses the dedicated visible profile.
  (browser as any).context = context;
  (browser as any).page = context.pages()[0];
  try {
    const part = { id: '200', title: 'Chapter', url: 'https://www.wattpad.com/200', modified: 'revision' };
    const first = await browser.chapter(part);
    assert.match(first.html, /Page 1[\s\S]*Page 2/); assert.equal(logins, 1);
    await browser.chapter(part); assert.equal(logins, 1);
    challenge = true;
    const pending = browser.chapter(part);
    const page = context.pages()[0]!;
    await page.getByText('Human checking fixture').waitFor();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(page.isClosed(), false);
    // Simulate the user completing the challenge, not an automated CAPTCHA solver.
    challenge = false;
    await page.reload();
    assert.match((await pending).html, /Page 1[\s\S]*Page 2/);
    await context.clearCookies();
    await browser.chapter(part); assert.equal(logins, 2);
    const actualStory = { id: '100' };
    browser.story = async id => { assert.equal(id, '100'); return actualStory as any; };
    assert.equal(await browser.resolve(part.url), actualStory);
    assert.equal(await browser.resolve('https://www.wattpad.com/story/100'), actualStory);
  } finally { await browser.close(); await rm(home, { recursive: true, force: true }); }
});
