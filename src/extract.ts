import { load } from 'cheerio';
import { DownloadError, type Part, type Story } from './types.js';
import { parseLink } from './util.js';

export function partMetadata(html: string, id: string): Record<string, any> {
  const $ = load(html);
  for (const script of $('script').toArray()) {
    const match = /^\s*window\.prefetched\s*=\s*([\s\S]*?);?\s*$/.exec($(script).html() ?? '');
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]!.replace(/;\s*$/, ''))[`part.${id}.metadata`]?.data;
      if (data && String(data.id) === id) return data;
    } catch { /* Never evaluate script text from the site. */ }
  }
  throw new DownloadError('Metadata chapter tidak ditemukan. Halaman dibatasi atau struktur Wattpad berubah.');
}

export function normalizeStory(raw: any, expectedId: string): Story {
  if (!raw || String(raw.id) !== expectedId || !raw.title || !Array.isArray(raw.parts) || raw.deleted)
    throw new DownloadError('Metadata cerita tidak valid atau cerita sudah dihapus.');
  if (raw.parts.length === 0 || raw.parts.length !== raw.numParts)
    throw new DownloadError('Daftar chapter tidak lengkap; EPUB tidak dibuat.');
  const ids = new Set<string>();
  const parts: Part[] = raw.parts.map((part: any) => {
    const id = String(part.id);
    if (!/^\d+$/.test(id) || ids.has(id) || part.deleted || part.draft || !part.title)
      throw new DownloadError('Daftar chapter mengandung bagian tidak tersedia atau duplikat.');
    ids.add(id);
    return { id, title: String(part.title), url: `https://www.wattpad.com/${id}`, modified: part.modifyDate };
  });
  const languages: Record<string, string> = { English:'en', Indonesian:'id', 'Bahasa Indonesia':'id', Spanish:'es', French:'fr', German:'de', Portuguese:'pt', Italian:'it', Filipino:'fil', Tagalog:'tl', Vietnamese:'vi', Turkish:'tr', Polish:'pl', Russian:'ru', Arabic:'ar', Hindi:'hi', Thai:'th', Chinese:'zh', Japanese:'ja', Korean:'ko' };
  return { id: expectedId, title: String(raw.title), author: String(raw.user?.fullname || raw.user?.name || 'Unknown'),
    description: String(raw.description ?? ''), language: languages[raw.language?.name] ?? 'und',
    url: `https://www.wattpad.com/story/${expectedId}`, cover: raw.cover || undefined, modified: raw.modifyDate, parts };
}

export function extractPage(html: string, id: string, expectedPage: number) {
  const metadata = partMetadata(html, id);
  if (metadata.anonymousUser !== false)
    throw new DownloadError('Sesi login tidak valid. Jalankan login kembali.');
  if (metadata.blockLoggedinReader || metadata.isPaywalled === true || metadata.isLocked === true || metadata.isPreview === true || metadata.isWriterPreview || metadata.draft || metadata.deleted)
    throw new DownloadError(`Chapter ${id} terkunci, preview, atau tidak dapat diakses akun ini.`);
  if (!Number.isInteger(metadata.pages) || metadata.pages < 1 || metadata.pages > 10000 || metadata.pageNumber !== expectedPage || expectedPage > metadata.pages || metadata.lastPage !== (expectedPage === metadata.pages))
    throw new DownloadError(`Pagination chapter ${id} tidak dapat diverifikasi; unduhan dihentikan.`);
  // Wattpad supplies the current page's content in its reader metadata. Unlike
  // the live DOM, this is not replaced/duplicated by hydration or ad rendering.
  const source = metadataContent(metadata);
  const $ = load(source ?? html);
  const body = source === undefined ? $('#story-reading .panel-reading pre') : $('body');
  if (body.length !== 1) throw new DownloadError(`Isi chapter ${id} tidak ditemukan atau struktur halaman berubah.`);
  body.find('.trinityAudioPlaceholder, script, style, button, [role="button"], .inline-comments, .comment-marker, .advertisement, [data-ad]').remove();
  if (!body.text().trim() && !body.find('img, video, audio, iframe').length)
    throw new DownloadError(`Isi chapter ${id} kosong; tidak dianggap selesai.`);
  const next = metadata.nextPage;
  if (!metadata.lastPage) {
    if (typeof next !== 'string' || !next) throw new DownloadError('Tautan halaman berikutnya hilang.');
    const nextUrl = new URL(next, `https://www.wattpad.com/${id}`);
    const parsed = parseLink(nextUrl.href);
    if (parsed.kind !== 'part' || parsed.id !== id || !nextUrl.pathname.endsWith(`/page/${expectedPage + 1}`))
      throw new DownloadError('Pagination mengarah ke chapter atau halaman yang salah.');
  }
  return { metadata, html: body.html()!, next: next ? new URL(next, `https://www.wattpad.com/${id}`).href : undefined };
}

export function metadataContent(metadata: Record<string, any>): string | undefined {
  const text = metadata.storyText;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const decoded = /^\s*&lt;/i.test(text) ? load(text, null, false).text() : text;
  if (/<\s*(?:html|head|body|script)\b/i.test(decoded)) return undefined;
  return /<(?:p|div|img|br|h[1-6]|blockquote|ul|ol)\b/i.test(decoded) ? decoded : undefined;
}
