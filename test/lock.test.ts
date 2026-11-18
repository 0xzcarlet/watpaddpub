import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../src/lock.js';

test('dead legacy PID lock is recovered; active owner stays protected; release is repeatable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-lock-'));
  const path = join(dir, 'process.lock');
  try {
    await writeFile(path, '92215');
    const release = await acquireLock(path, pid => pid !== 92215);
    assert.match(await readFile(path, 'utf8'), new RegExp(`^${process.pid}\\n`));
    await assert.rejects(acquireLock(path), /Profil sedang dipakai/);
    await release(); await release();
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    const nextRelease = await acquireLock(path);
    await nextRelease();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
