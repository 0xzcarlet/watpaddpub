import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DownloadError, type Log } from './types.js';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function parseLink(input: string): { kind: 'story' | 'part'; id: string; url: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new DownloadError('Masukkan URL Wattpad yang valid.'); }
  if (!['www.wattpad.com', 'wattpad.com'].includes(url.hostname) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new DownloadError('Link harus berasal dari wattpad.com.');
  const match = /^\/(story\/)?([1-9]\d*)(?:-[^/]*|\/?)(?:\/page\/\d+)?\/?$/.exec(url.pathname);
  if (!match) throw new DownloadError('Gunakan link story atau chapter Wattpad, bukan profil/reading list.');
  return { kind: match[1] ? 'story' : 'part', id: match[2]!, url: `https://www.wattpad.com/${match[1] ?? ''}${match[2]}` };
}
export function filename(title: string, id: string): string {
  const clean = Array.from(title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '')).slice(0, 80).join('');
  return `${clean || 'Wattpad'}-${id}.epub`;
}
export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function atomicJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try { await writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
export async function retry<T>(operation: () => Promise<T>, log: Log, wait = sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof DownloadError) || !error.retryable || attempt >= 3) throw error;
      const delay = Math.max(1000 * 2 ** attempt, error.retryAfter);
      log(`Gangguan sementara; retry ${attempt + 1}/3 dalam ${Math.ceil(delay / 1000)} detik.`);
      await wait(delay);
    }
  }
}
export function httpError(status: number, retryAfter?: string): DownloadError {
  const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
  return new DownloadError(`Permintaan gagal (HTTP ${status}).${status === 403 ? ' Akses ditolak atau situs meminta verifikasi tambahan.' : ''}`, status === 429 || status >= 500, Number.isFinite(delay) ? delay : 0);
}
export function navigationError(status: number, headers: Record<string, string>): DownloadError {
  if (headers['x-amzn-waf-action'])
    return new DownloadError('Wattpad meminta verifikasi situs. Progres tersimpan; coba lagi setelah memeriksa akses melalui browser.');
  const error = httpError(status, headers['retry-after']);
  // Only retry a failed browser GET, not arbitrary API methods returning 405.
  if (status === 405) {
    error.retryable = true;
    error.retryAfter = Math.max(error.retryAfter, 10000);
    error.message += ' Navigasi halaman ditolak sementara; progres lengkap tersimpan.';
  }
  return error;
}
