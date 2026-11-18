import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { mkdir, writeFile, link, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DownloadError, type Asset, type Chapter, type Story } from './types.js';
import { xml } from './util.js';

const css = 'body{line-height:1.5;margin:5%;overflow-wrap:break-word}p{margin:.7em 0}img{max-width:100%;height:auto}h1,h2,h3{page-break-after:avoid}blockquote{margin:1em 1.5em}pre{white-space:pre-wrap}hr{width:35%;margin:1.5em auto}.cover{text-align:center}.description{white-space:pre-wrap}';
function document(title: string, body: string, language: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}"><head><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css" /></head><body>${body}</body></html>`;
}
export function buildEpub(story: Story, chapters: Chapter[], assets: Asset[], cover?: string): Uint8Array {
  if (chapters.length !== story.parts.length || chapters.some((c, i) => c.id !== story.parts[i]!.id || !c.html.trim()))
    throw new DownloadError('Chapter tidak lengkap atau urutannya salah.');
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>'),
    'OEBPS/style.css': strToU8(css),
  };
  const manifest = ['<item id="css" href="style.css" media-type="text/css" />', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />', '<item id="title" href="title.xhtml" media-type="application/xhtml+xml" />'];
  const spine: string[] = [];
  if (cover) {
    if (!assets.some(asset => asset.name === cover)) throw new DownloadError('Aset cover hilang.');
    files['OEBPS/cover.xhtml'] = strToU8(document('Cover', `<section epub:type="cover" class="cover"><img src="${xml(cover)}" alt="Cover ${xml(story.title)}" /></section>`, story.language));
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" />'); spine.push('<itemref idref="cover" />');
  }
  files['OEBPS/title.xhtml'] = strToU8(document(story.title, `<h1>${xml(story.title)}</h1><p>${xml(story.author)}</p><div class="description">${xml(story.description)}</div><p><a href="${xml(story.url)}">Sumber: Wattpad</a></p>`, story.language));
  spine.push('<itemref idref="title" />', '<itemref idref="nav" />');
  const toc: string[] = [];
  chapters.forEach((chapter, i) => {
    const name = `chapter-${i + 1}.xhtml`;
    files[`OEBPS/${name}`] = strToU8(document(chapter.title, `<h1>${xml(chapter.title)}</h1>${chapter.html}`, story.language));
    manifest.push(`<item id="chapter-${i + 1}" href="${name}" media-type="application/xhtml+xml" />`);
    spine.push(`<itemref idref="chapter-${i + 1}" />`);
    toc.push(`<li><a href="${name}">${xml(chapter.title)}</a></li>`);
  });
  assets.forEach((asset, i) => {
    files[`OEBPS/${asset.name}`] = asset.data;
    manifest.push(`<item id="image-${i}" href="${xml(asset.name)}" media-type="${asset.mime}"${asset.name === cover ? ' properties="cover-image"' : ''} />`);
  });
  files['OEBPS/nav.xhtml'] = strToU8(document('Daftar isi', `<nav epub:type="toc" id="toc"><h1>Daftar isi</h1><ol>${toc.join('')}</ol></nav>`, story.language));
  files['OEBPS/package.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${xml(story.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:wattpad:story:${story.id}</dc:identifier><dc:title>${xml(story.title)}</dc:title><dc:creator>${xml(story.author)}</dc:creator><dc:language>${xml(story.language)}</dc:language><dc:description>${xml(story.description)}</dc:description><dc:source>${xml(story.url)}</dc:source><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  for (const [name, value] of Object.entries(files)) {
    if (/\.(xml|opf|xhtml)$/.test(name) && XMLValidator.validate(strFromU8(value)) !== true)
      throw new DownloadError(`XML EPUB tidak valid: ${name}`);
    if (name.endsWith('.xhtml')) {
      for (const match of strFromU8(value).matchAll(/(?:src|href)="([^"]+)"/g)) {
        const target = match[1]!;
        if (!/^(https?:|mailto:|#)/.test(target) && !files[`OEBPS/${target}`]) throw new DownloadError(`Referensi EPUB hilang: ${target}`);
        if (match[0].startsWith('src=') && !files[`OEBPS/${target}`]) throw new DownloadError('Gambar EPUB belum tersimpan offline.');
      }
    }
  }
  const archive = zipSync({ mimetype: [files.mimetype!, { level: 0 }], ...Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'mimetype')) }, { level: 6 });
  if (Object.keys(unzipSync(archive)).length !== Object.keys(files).length) throw new DownloadError('Validasi ZIP EPUB gagal.');
  return archive;
}
export async function publishEpub(output: string, data: Uint8Array, overwrite: boolean) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    if (overwrite) await rename(temporary, output);
    else {
      try { await link(temporary, output); }
      catch (error: any) { if (error.code === 'EEXIST') throw new DownloadError('File tujuan sudah ada. Gunakan --overwrite untuk menimpanya.'); throw error; }
    }
  } finally { await rm(temporary, { force: true }); }
}
