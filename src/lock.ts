import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DownloadError } from './types.js';

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error.code !== 'ESRCH'; }
}

export async function acquireLock(path: string, alive = processAlive): Promise<() => Promise<void>> {
  const token = `${process.pid}\n${randomUUID()}`;
  const candidate = `${path}.${randomUUID()}.tmp`;
  await writeFile(candidate, token, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Publish a fully written lock: another process never sees an empty PID.
        await link(candidate, path);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try { if (await readFile(path, 'utf8') === token) await rm(path); }
          catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
      let owner: string;
      try { owner = await readFile(path, 'utf8'); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      const pid = Number(owner.split('\n')[0]);
      if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid))
        throw new DownloadError(`Profil sedang dipakai (PID ${pid || 'tidak diketahui'}). Tutup proses CLI sebelumnya sebelum mencoba lagi.`);
      // Legacy PID-only locks are supported. Never remove a changed owner.
      try { if (await readFile(path, 'utf8') === owner) await rm(path); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new DownloadError('Profil sedang diambil proses lain. Coba lagi sebentar.');
  } finally { await rm(candidate, { force: true }); }
}
