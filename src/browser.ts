import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { partMetadata, extractPage, normalizeStory, metadataContent } from './extract.js';
import { DownloadError, type Part, type Story, type Log } from './types.js';
import { httpError, navigationError, parseLink, retry, sleep, hash, xml, exists } from './util.js';

export class WattpadBrowser {
  private lastNavigation = 0;
  private context!: BrowserContext;
  private page!: Page;
  constructor(private home: string, private log: Log) {}
  async open() {
    const profile = join(this.home, 'browser');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(profile, 0o700);
    try {
      const bundled = await exists(chromium.executablePath());
      this.context = await chromium.launchPersistentContext(profile, { headless: false, ...(bundled ? {} : { channel: 'chrome' }), viewport: { width: 1280, height: 900 } });
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.page.setDefaultTimeout(30000);
    } catch {
      throw new DownloadError('Browser gagal dibuka. Pasang Google Chrome atau jalankan npm run browser:install; tutup proses CLI lain yang memakai profil ini.');
    }
  }
  async close() { await this.context?.close(); }
  static async logout(home: string) { await rm(join(home, 'browser'), { recursive: true, force: true }); }
  private async navigate(url: string) {
    await retry(async () => {
      try {
        await sleep(Math.max(0, 1500 - (Date.now() - this.lastNavigation)));
        this.lastNavigation = Date.now();
        const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (response?.headers()['x-amzn-waf-action']) {
          await this.waitForVerification(url);
          return;
        }
        if (response && !response.ok()) throw navigationError(response.status(), response.headers());
      } catch (error) {
        if (error instanceof DownloadError) throw error;
        if (this.page.isClosed()) throw new DownloadError('Browser ditutup; progres tersimpan.');
        throw new DownloadError('Navigasi browser gagal atau timeout.', true);
      }
    }, this.log);
  }
  private async waitForVerification(url: string) {
    this.log('Human checking Wattpad terdeteksi. Selesaikan verifikasi MANUAL di browser yang terbuka. Jangan tutup browser; CLI menunggu tanpa batas waktu. Ctrl+C untuk membatalkan.');
    await this.page.bringToFront().catch(() => {});
    const target = new URL(url);
    let partId: string | undefined;
    try { const parsed = parseLink(url); if (parsed.kind === 'part') partId = parsed.id; } catch { /* Login page. */ }
    const pageNumber = Number(/\/page\/(\d+)/.exec(target.pathname)?.[1] ?? 1);
    // Poll only the existing page: no CAPTCHA solving, repeated GETs, or cookie manipulation.
    while (!this.page.isClosed()) {
      const ready = await this.page.evaluate(({ partId, pageNumber, path }) => {
        if (location.hostname !== 'www.wattpad.com') return false;
        if (partId) {
          const data = (window as any).prefetched?.[`part.${partId}.metadata`]?.data;
          return String(data?.id) === partId && data?.pageNumber === pageNumber && !!document.querySelector('#story-reading .panel-reading pre');
        }
        return location.pathname === path && !!document.querySelector('input[type="password"]') || !!((window as any).wattpad?.currentUser || (window as any).wattpad?.user);
      }, { partId, pageNumber, path: target.pathname }).catch(() => false);
      if (ready) { this.log('Verifikasi selesai; melanjutkan download.'); return; }
      await sleep(1000);
    }
    throw new DownloadError('Browser ditutup saat menunggu verifikasi. Progres lengkap tersimpan.');
  }
  async login() {
    await this.navigate('https://www.wattpad.com/login');
    this.log('Login manual di browser. CLI akan mendeteksi sesi dan lanjut otomatis (batas 10 menit).');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (this.page.isClosed()) throw new DownloadError('Browser login ditutup.');
      if (await this.isLoggedIn()) { this.log('Login terdeteksi.'); return; }
      await sleep(1000);
    }
    throw new DownloadError('Login belum terdeteksi dalam 10 menit. Jalankan ulang saat siap login.');
  }
  private async isLoggedIn() {
    return this.page.evaluate(() => {
      const user = (window as any).wattpad?.user || (window as any).wattpad?.currentUser;
      if (user && (user.username || user.name || user.id)) return true;
      const state = (window as any).__remixContext?.state?.loaderData;
      if (state && Object.values(state).some((entry: any) => entry?.currentUser?.username || entry?.currentUser?.name || entry?.currentUser?.id)) return true;
      return !!document.querySelector('a[href="/logout"], a[href^="/logout?"], form[action="/logout"]');
    }).catch(() => false);
  }
  async resolve(input: string): Promise<Story> {
    const link = parseLink(input);
    let id = link.id;
    if (link.kind === 'part') {
      await this.navigate(link.url);
      if (/\/login(?:[/?]|$)/.test(this.page.url())) { await this.login(); await this.navigate(link.url); }
      const meta = partMetadata(await this.page.content(), link.id);
      id = String(meta.group?.id ?? '');
      if (!/^\d+$/.test(id)) throw new DownloadError('Cerita induk chapter tidak ditemukan.');
    }
    return this.story(id);
  }
  async story(id: string): Promise<Story> {
    const response = await this.request(`https://www.wattpad.com/api/v3/stories/${id}`);
    try { return normalizeStory(JSON.parse(response.toString('utf8')), id); }
    catch (error) { if (error instanceof DownloadError) throw error; throw new DownloadError('Metadata Wattpad bukan JSON yang valid.'); }
  }
  async chapter(part: Part): Promise<{ html: string; modified?: string }> {
    let url: string | undefined = part.url;
    let index = 1;
    let total: number | undefined;
    let revision: string | undefined;
    const pages: string[] = [];
    const seen = new Set<string>();
    while (url) {
      await this.navigate(url);
      let html = await this.page.content();
      let meta: Record<string, any> | undefined;
      if (!/\/login(?:[/?]|$)/.test(this.page.url())) meta = partMetadata(html, part.id);
      if (!meta || meta.anonymousUser === true) {
        await this.login(); await this.navigate(url);
      }
      // Wait for the known reader container, then scroll it to load lazy media.
      if (!metadataContent(partMetadata(await this.page.content(), part.id))) {
        await this.page.locator('#story-reading .panel-reading pre').first().waitFor({ timeout: 15000 }).catch(() => {
          throw new DownloadError(`Chapter ${part.id} tidak tersedia; mungkin terkunci atau memerlukan verifikasi situs.`);
        });
        await this.page.evaluate(async () => {
          const reader = document.querySelector('#story-reading .panel-reading pre')!;
          for (const image of reader.querySelectorAll('img')) {
            image.scrollIntoView();
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        });
      }
      html = await this.page.content();
      const extracted = extractPage(html, part.id, index);
      const current = extracted.metadata;
      if (index === 1) {
        total = current.pages; revision = current.modifyDate;
        if (part.modified && revision !== part.modified) throw new DownloadError('Cerita berubah saat diunduh. Jalankan ulang untuk metadata terbaru.');
        if (current.videoId) pages.push(`<p><a href="https://www.youtube.com/watch?v=${encodeURIComponent(current.videoId)}">Video chapter</a></p>`);
      } else if (current.pages !== total || current.modifyDate !== revision) {
        throw new DownloadError('Chapter berubah selama pagination. Jalankan ulang.');
      }
      const signature = hash(extracted.html);
      if (seen.has(signature)) throw new DownloadError('Halaman chapter berulang; kelengkapan tidak dapat dipastikan.');
      seen.add(signature); pages.push(extracted.html);
      this.log(`  Halaman ${index}/${total}`);
      url = extracted.next; index++;
      if (url) await sleep(300);
    }
    if (index - 1 !== total) throw new DownloadError('Jumlah halaman chapter tidak lengkap.');
    return { html: pages.join('\n'), modified: revision };
  }
  async request(url: string): Promise<Buffer> {
    return retry(async () => {
      let response;
      try { response = await this.context.request.get(url, { timeout: 45000 }); }
      catch { throw new DownloadError('Unduhan jaringan gagal atau timeout.', true); }
      try {
        if (response.status() === 401) {
          await this.login();
          throw new DownloadError('Sesi diperbarui; mengulang permintaan.', true);
        }
        if (!response.ok()) throw httpError(response.status(), response.headers()['retry-after']);
        return await response.body();
      } finally { await response.dispose(); }
    }, this.log);
  }
}
