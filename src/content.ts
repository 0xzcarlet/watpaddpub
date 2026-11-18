import { load } from 'cheerio';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DownloadError, type Asset, type Log } from './types.js';
import { atomicJson, hash, xml } from './util.js';

export class Assets {
  readonly files = new Map<string, Asset>();
  private urls = new Map<string, string>();
  constructor(private cache: string, private revision: string | undefined, private fetch: (url: string) => Promise<Buffer>, private log: Log) {}
  async add(input: string, base: string): Promise<string> {
    let url: URL;
    try { url = new URL(input, base); } catch { throw new DownloadError('URL gambar tidak valid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new DownloadError('Gambar memakai protokol yang tidak didukung.');
    const previous = this.urls.get(url.href);
    if (previous) return previous;
    const path = join(this.cache, 'images', `${hash(url.href + (this.revision ?? ''))}.json`);
    let data: Buffer | undefined;
    let mime = '';
    let extension = '';
    if (this.revision) {
      try {
        const stored = JSON.parse(await readFile(path, 'utf8'));
        const bytes = Buffer.from(stored.data, 'base64');
        if (stored.version === 1 && stored.digest === hash(bytes) && ['image/jpeg', 'image/png', 'image/gif'].includes(stored.mime)) {
          data = bytes; mime = stored.mime; extension = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
        }
      } catch { /* Missing/corrupt cache is downloaded again. */ }
    }
    if (!data) {
      this.log(`  Gambar ${this.urls.size + 1}`);
      const original = await this.fetch(url.href);
      try {
        const image = sharp(original, { limitInputPixels: 100_000_000, failOn: 'error' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height) throw new Error('No dimensions');
        // Decode to detect truncated/error documents, even for retained formats.
        await image.clone().png().toBuffer();
        if (['jpeg', 'png', 'gif'].includes(metadata.format!)) {
          data = original; extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format!;
          mime = `image/${metadata.format}`;
        } else { data = await image.rotate().png().toBuffer(); extension = 'png'; mime = 'image/png'; }
      } catch { throw new DownloadError('Gambar tidak valid atau tidak dapat dikonversi; EPUB tidak dibuat.'); }
      await atomicJson(path, { version: 1, digest: hash(data), mime, data: data.toString('base64') });
    }
    const name = `images/${hash(data)}.${extension}`;
    this.files.set(name, { name, mime, data }); this.urls.set(url.href, name);
    return name;
  }
}

const allowed = new Set('p div span h1 h2 h3 h4 h5 h6 strong b em i u s del blockquote ul ol li hr br a img figure figcaption sub sup pre code'.split(' '));
const voidTags = new Set(['img', 'br', 'hr']);
export async function formatContent(html: string, base: string, assets: Assets): Promise<string> {
  const $ = load(html, null, false);
  $('script, style, button, form, input, noscript, .trinityAudioPlaceholder, .inline-comments, .comment-marker, .advertisement, [data-ad]').remove();
  const render = async (node: any): Promise<string> => {
    if (node.type === 'text') return xml(node.data);
    if (node.type !== 'tag') return '';
    let tag: string = node.name.toLowerCase();
    const el = $(node);
    if (['video', 'audio', 'iframe'].includes(tag)) {
      const source = el.attr('src') || el.find('source').first().attr('src');
      if (!source) return `<p><a href="${xml(base)}">Media di halaman sumber</a></p>`;
      const href = safeLink(source, base);
      return `<p><a href="${xml(href ?? base)}">${tag === 'audio' ? 'Audio' : 'Video'} di sumber</a></p>`;
    }
    if (tag === 'source') return '';
    if (tag === 'picture') tag = 'span';
    if (tag === 'img') {
      const srcset = el.attr('data-srcset') || el.attr('srcset');
      const src = el.attr('data-original') || el.attr('data-src') || srcset?.split(',').at(-1)?.trim().split(/\s+/)[0] || el.attr('src');
      if (!src) throw new DownloadError('Gambar tanpa sumber ditemukan; EPUB tidak dibuat.');
      const name = await assets.add(src, base);
      return `<img src="${xml(name)}" alt="${xml(el.attr('alt') ?? '')}" />`;
    }
    let children = '';
    for (const child of node.children ?? []) children += await render(child);
    if (!allowed.has(tag)) return children;
    let attrs = '';
    if (tag === 'a') {
      const href = safeLink(el.attr('href') ?? '', base);
      if (!href) return children;
      attrs += ` href="${xml(href)}"`;
    }
    const style = (el.attr('style') ?? '').split(';').map(rule => rule.trim()).filter(rule => /^(text-align:\s*(left|right|center|justify)|font-style:\s*(italic|normal)|font-weight:\s*(bold|normal|[1-9]00)|text-decoration:\s*(underline|line-through))$/i.test(rule)).join('; ');
    if (style) attrs += ` style="${xml(style)}"`;
    if (['rtl', 'ltr'].includes(el.attr('dir') ?? '')) attrs += ` dir="${el.attr('dir')}"`;
    return voidTags.has(tag) ? `<${tag}${attrs} />` : `<${tag}${attrs}>${children}</${tag}>`;
  };
  let result = '';
  for (const node of $.root().contents().toArray()) result += await render(node);
  return result;
}
function safeLink(input: string, base: string): string | undefined {
  try { const url = new URL(input, base); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
