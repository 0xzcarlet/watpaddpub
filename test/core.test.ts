import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import sharp from 'sharp';
import { parseLink, filename, retry, navigationError, httpError } from '../src/util.js';
import { DownloadError, type Story } from '../src/types.js';
import { extractPage, normalizeStory, partMetadata } from '../src/extract.js';
import { Assets, formatContent } from '../src/content.js';
import { buildEpub, publishEpub } from '../src/epub.js';
import { download, type Source } from '../src/download.js';

const log = () => {};
test('browser GET 405 retries with cooldown; API 405 and WAF challenges do not', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retry(async () => {
    if (++attempts === 1) throw navigationError(405, {});
    return 'reader';
  }, log, async ms => { waits.push(ms); });
  assert.equal(result, 'reader');
  assert.deepEqual(waits, [10000]);
  assert.equal(navigationError(405, { 'retry-after': '60' }).retryAfter, 60000);
  assert.equal(navigationError(405, { 'x-amzn-waf-action': 'captcha' }).retryable, false);
  assert.equal(navigationError(403, {}).retryable, false);
  assert.equal(httpError(405).retryable, false);
});
const story: Story = { id: '100', title: 'Buku: 星 / é', author: 'A & B', description: 'Baris satu\nBaris dua', language: 'id', url: 'https://www.wattpad.com/story/100', modified: '2026-01-01', parts: [{ id: '200', title: 'Satu', url: 'https://www.wattpad.com/200', modified: '2026-01-01' }, { id: '201', title: 'Dua', url: 'https://www.wattpad.com/201', modified: '2026-01-01' }] };
function page(overrides: Record<string, unknown> = {}, body = '<p data-p-id="a">Cerita <i>miring</i>.</p>') {
  const data = { id: 200, group: { id: 100 }, anonymousUser: false, pages: 2, pageNumber: 1, lastPage: false, nextPage: '/200-title/page/2', ...overrides };
  return `<html><script>window.prefetched = ${JSON.stringify({ 'part.200.metadata': { data } })};</script><div id="story-reading"><div class="panel-reading"><pre>${body}</pre></div></div></html>`;
}
async function temporary(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'wattpad-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('story/chapter URLs normalize; hostile and unrelated URLs rejected', () => {
  assert.equal(parseLink('https://wattpad.com/story/100-judul?x=y').url, story.url);
  assert.equal(parseLink('https://www.wattpad.com/200-name/page/2').kind, 'part');
  for (const input of ['file:///tmp/book', 'https://wattpad.com.evil/story/100', 'https://www.wattpad.com/user/alex', 'https://u:p@wattpad.com/200']) assert.throws(() => parseLink(input));
  assert.equal(filename(story.title, story.id), 'Buku- 星 - é-100.epub');
});
test('metadata requires complete ordered chapter list', () => {
  const raw = { id: 100, title: 'Story', numParts: 2, parts: [{ id: 201, title: 'First' }, { id: 200, title: 'Second' }] };
  assert.deepEqual(normalizeStory(raw, '100').parts.map(p => p.id), ['201', '200']);
  assert.throws(() => normalizeStory({ ...raw, numParts: 3 }, '100'));
  assert.throws(() => normalizeStory({ ...raw, parts: [raw.parts[0], raw.parts[0]] }, '100'));
});
test('reader metadata verifies page boundaries and excludes login, lock and preview', () => {
  assert.equal(partMetadata(page(), '200').group.id, 100);
  assert.equal(extractPage(page(), '200', 1).next, 'https://www.wattpad.com/200-title/page/2');
  assert.match(extractPage(page(), '200', 1).html, /<i>miring<\/i>/);
  for (const overrides of [{ anonymousUser: true }, { blockLoggedinReader: true }, { isPreview: true }, { isWriterPreview: true }, { pages: undefined }, { pageNumber: 2 }, { lastPage: true }, { nextPage: '/201/page/2' }]) assert.throws(() => extractPage(page(overrides), '200', 1));
  assert.throws(() => extractPage(page({}, ''), '200', 1));
  assert.throws(() => extractPage('<html>Login</html>', '200', 1));
  assert.equal(extractPage(page({ pageNumber: 2, lastPage: true, nextPage: '' }), '200', 2).next, undefined);
});
test('metadata page content survives missing or duplicated reader DOM without including headers', () => {
  const storyText = '&lt;p&gt;Teks &lt;b&gt;tebal&lt;/b&gt; &amp;amp; utuh.&lt;img src="https://img.wattpad.com/inline.jpg"&gt;&lt;/p&gt;';
  const html = page({ storyText, photoUrl: 'https://img.wattpad.com/header.jpg' });
  for (const document of [html.replace('id="story-reading"', 'id="replaced"'), html.replace('</pre>', '</pre><pre>Duplicate reader</pre>')]) {
    const result = extractPage(document, '200', 1);
    assert.match(result.html, /<b>tebal<\/b>/);
    assert.match(result.html, /&amp; utuh/);
    assert.match(result.html, /inline.jpg/);
    assert.doesNotMatch(result.html, /header.jpg|Duplicate reader/);
  }
  assert.throws(() => extractPage(page({ storyText, anonymousUser: true }), '200', 1), /Sesi login/);
  assert.throws(() => extractPage(page({ storyText, pageNumber: 2 }), '200', 1), /Pagination/);
});
test('retry has three retries, honors server delay and does not retry denied access', async () => {
  let attempts = 0; const waits: number[] = [];
  await assert.rejects(retry(async () => { attempts++; throw new DownloadError('temporary', true, 9000); }, log, async ms => { waits.push(ms); }));
  assert.equal(attempts, 4); assert.deepEqual(waits, [9000, 9000, 9000]);
  attempts = 0;
  await assert.rejects(retry(async () => { attempts++; throw new DownloadError('locked'); }, log));
  assert.equal(attempts, 1);
});
test('formatting, lazy images, deduplication, media links and image conversion', () => temporary(async dir => {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).webp().toBuffer();
  let requests = 0;
  const assets = new Assets(dir, 'revision', async () => { requests++; return bytes; }, log);
  const html = await formatContent('<p style="text-align:center;position:fixed" onclick="bad()"><b>Bold</b> &amp; <i>italic</i><br><img data-src="/image.webp" src="/placeholder.png"></p><blockquote>Quote</blockquote><ul><li>Item</li></ul><hr><img src="/image.webp"><iframe src="https://www.youtube.com/embed/abc"></iframe><script>bad()</script><a href="javascript:bad()">safe</a>', story.url, assets);
  assert.equal(requests, 1); assert.equal(assets.files.size, 1);
  assert.equal([...assets.files.values()][0]!.mime, 'image/png');
  assert.match(html, /text-align:center/); assert.match(html, /<b>Bold<\/b>/); assert.match(html, /<blockquote>Quote<\/blockquote>/);
  assert.match(html, /youtube.com/); assert.doesNotMatch(html, /onclick|position:|javascript:|<script|<iframe|src="https/);
  const cached = new Assets(dir, 'revision', async () => { throw new Error('should use cache'); }, log);
  await cached.add('/image.webp', story.url);
  await assert.rejects(formatContent('<img>', story.url, assets), /tanpa sumber/);
  await assert.rejects(new Assets(dir, undefined, async () => Buffer.from('<html>login</html>'), log).add('/bad', story.url), /Gambar tidak valid/);
}));
test('EPUB is a complete offline ZIP; existing files remain untouched and temp files are cleaned', () => temporary(async dir => {
  const chapters = story.parts.map(p => ({ id: p.id, title: p.title, html: '<p>Isi &amp; format <em>miring</em>.</p>' }));
  const data = buildEpub(story, chapters, []);
  const files = unzipSync(data);
  assert.equal(Object.keys(files)[0], 'mimetype');
  assert.equal(new DataView(data.buffer, data.byteOffset).getUint16(8, true), 0);
  assert.equal(strFromU8(files.mimetype!), 'application/epub+zip');
  assert.match(strFromU8(files['OEBPS/nav.xhtml']!), /chapter-1.xhtml.*chapter-2.xhtml/);
  assert.match(strFromU8(files['OEBPS/package.opf']!), /A &amp; B/);
  assert.throws(() => buildEpub(story, chapters.slice(0, 1), []));
  assert.throws(() => buildEpub(story, [{ ...chapters[0]!, html: '<img src="missing.png" />' }, chapters[1]!], []));
  const output = join(dir, 'book.epub');
  await writeFile(output, 'old');
  await assert.rejects(publishEpub(output, data, false), /sudah ada/);
  assert.equal(await readFile(output, 'utf8'), 'old');
  await publishEpub(output, data, true);
  assert.deepEqual(await readdir(dir), ['book.epub']);
}));
test('failed chapter publishes nothing; rerun resumes; a changed story invalidates cache', () => temporary(async dir => {
  const counts = new Map<string, number>(); let fail = true;
  const current = structuredClone(story);
  const source: Source = {
    resolve: async () => current, story: async () => current,
    chapter: async part => { counts.set(part.id, (counts.get(part.id) ?? 0) + 1); if (fail && part.id === '201') throw new DownloadError('locked'); return { html: '<p>Complete chapter</p>', modified: part.modified }; },
    request: async () => { throw new Error('not expected'); },
  };
  const output = join(dir, 'book.epub');
  await assert.rejects(download(source, story.url, { home: dir, output }, log), /locked/);
  await assert.rejects(readFile(output));
  fail = false;
  await download(source, 'https://www.wattpad.com/200', { home: dir, output }, log);
  assert.equal(counts.get('200'), 1); assert.equal(counts.get('201'), 2);
  current.modified = 'new';
  await download(source, story.url, { home: dir, output, overwrite: true }, log);
  assert.equal(counts.get('200'), 2);
}));
test('missing image and mid-download story change prevent final publication', () => temporary(async dir => {
  const output = join(dir, 'book.epub');
  const source: Source = { resolve: async () => story, story: async () => ({ ...story, modified: 'changed' }), chapter: async part => ({ html: '<p>Complete</p>', modified: part.modified }), request: async () => { throw new DownloadError('image failed'); } };
  await assert.rejects(download(source, story.url, { home: dir, output }, log), /berubah/);
  source.resolve = async () => ({ ...story, modified: 'new-revision' });
  source.chapter = async part => ({ html: '<p><img src="https://img.wattpad.com/test.jpg" /></p>', modified: part.modified });
  await assert.rejects(download(source, story.url, { home: dir, output }, log), /image failed/);
  await assert.rejects(readFile(output));
}));
