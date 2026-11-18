import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Assets, formatContent } from '../src/content.js';
import { buildEpub } from '../src/epub.js';
import type { Story } from '../src/types.js';

const directory = resolve(process.argv[2] ?? '/tmp/wattpad-epub-validation');
await mkdir(directory, { recursive: true });
const story: Story = { id: '123', title: 'Uji EPUB — 星 & Cerita', author: 'Penulis Uji', language: 'id', description: 'Buku sintetis untuk validasi.\nTidak berisi teks cerita pengguna.', url: 'https://www.wattpad.com/story/123', modified: 'fixture', cover: 'https://example.com/cover.png', parts: [{ id: '1', title: 'Bab Satu', url: 'https://www.wattpad.com/1' }, { id: '2', title: 'Bab Dua', url: 'https://www.wattpad.com/2' }] };
const picture = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#4b5580' } }).png().toBuffer();
const assets = new Assets(directory, undefined, async () => picture, console.log);
const cover = await assets.add(story.cover!, story.url);
const bodies = ['<p style="text-align:center"><b>Teks tebal</b> dan <i>miring</i>.</p><p>Paragraf baru dengan Unicode: café, 星, 🌙.</p><img src="https://example.com/cover.png" alt="Ilustrasi uji"><blockquote>Kutipan</blockquote><hr><ul><li>Satu</li><li>Dua</li></ul>', '<h2>Bagian berikutnya</h2><p>Seluruh gambar tersedia offline.</p><a href="https://www.wattpad.com/story/123">Tautan sumber</a><iframe src="https://www.youtube.com/embed/example"></iframe>'];
const chapters = [];
for (const [i, part] of story.parts.entries()) chapters.push({ id: part.id, title: part.title, html: await formatContent(bodies[i]!, part.url, assets) });
await writeFile(`${directory}/validation.epub`, buildEpub(story, chapters, [...assets.files.values()], cover));
console.log(`${directory}/validation.epub`);
