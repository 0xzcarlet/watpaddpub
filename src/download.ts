import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Assets, formatContent } from './content.js';
import { buildEpub, publishEpub } from './epub.js';
import { DownloadError, type Story, type Part, type Chapter, type Log } from './types.js';
import { atomicJson, exists, filename, hash } from './util.js';

export interface Source {
  resolve(link: string): Promise<Story>;
  story(id: string): Promise<Story>;
  chapter(part: Part): Promise<{ html: string; modified?: string }>;
  request(url: string): Promise<Buffer>;
}
export function fingerprint(story: Story): string {
  return hash(JSON.stringify(story));
}
export async function download(source: Source, input: string, options: { home: string; output?: string; overwrite?: boolean }, log: Log): Promise<string> {
  const story = await source.resolve(input);
  const output = resolve(options.output ?? filename(story.title, story.id));
  if (!options.overwrite && await exists(output)) throw new DownloadError('File tujuan sudah ada. Gunakan --overwrite untuk menimpanya.');
  log(`${story.title} — ${story.parts.length} chapter`);
  const cache = join(options.home, 'cache', story.id);
  const identity = fingerprint(story);
  const assets = new Assets(cache, story.modified, url => source.request(url), log);
  const chapters: Chapter[] = [];
  for (const [index, part] of story.parts.entries()) {
    log(`[${index + 1}/${story.parts.length}] ${part.title}`);
    const path = join(cache, `chapter-${part.id}.json`);
    let html: string | undefined;
    // Without modification metadata, always refetch rather than assume freshness.
    if (part.modified && story.modified) {
      try {
        const stored = JSON.parse(await readFile(path, 'utf8'));
        if (stored.version === 2 && stored.fingerprint === identity && typeof stored.html === 'string' && stored.digest === hash(stored.html)) {
          html = stored.html; log('  Menggunakan chapter lengkap dari cache.');
        }
      } catch { /* Missing/corrupt cache is fetched again. */ }
    }
    if (!html) {
      const content = await source.chapter(part);
      if (part.modified && content.modified !== part.modified) throw new DownloadError('Chapter berubah saat diunduh. Jalankan ulang.');
      html = content.html;
      await atomicJson(path, { version: 2, fingerprint: identity, digest: hash(html), html });
    }
    chapters.push({ id: part.id, title: part.title, html: await formatContent(html, part.url, assets) });
  }
  const latest = await source.story(story.id);
  if (fingerprint(latest) !== identity) throw new DownloadError('Daftar chapter atau metadata cerita berubah selama unduhan. Jalankan ulang untuk versi terbaru.');
  const epub = buildEpub(story, chapters, [...assets.files.values()]);
  await publishEpub(output, epub, !!options.overwrite);
  log(`Selesai: ${output}`);
  return output;
}
