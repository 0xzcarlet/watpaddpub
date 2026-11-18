#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { acquireLock } from './lock.js';
import { WattpadBrowser } from './browser.js';
import { download } from './download.js';
import { DownloadError } from './types.js';
import { exists, parseLink } from './util.js';

const cli = new Command().name('wattpad-epub').version('0.1.0')
  .description('Satu link story/chapter Wattpad → seluruh cerita dalam satu EPUB offline.')
  .argument('[link]', 'URL story atau chapter; login / logout juga didukung')
  .option('-o, --output <file>', 'Lokasi EPUB hasil')
  .option('--overwrite', 'Izinkan mengganti file tujuan')
  .option('--data-dir <directory>', 'Lokasi profil browser dan cache', process.env.WATTPAD_EPUB_HOME || join(homedir(), '.wattpad-epub'))
  .addHelpText('after', '\nContoh:\n  wattpad-epub login\n  wattpad-epub "https://www.wattpad.com/story/123456" -o buku.epub\n  wattpad-epub logout');

async function main() {
  cli.parse();
  const input = cli.args[0];
  if (!input) { cli.help(); return; }
  const options = cli.opts();
  if (!['login', 'logout'].includes(input)) parseLink(input);
  if (options.output && !options.overwrite && await exists(resolve(options.output))) throw new DownloadError('File tujuan sudah ada. Gunakan --overwrite untuk menimpanya.');
  const home = resolve(options.dataDir);
  await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700);
  const lockPath = join(home, 'process.lock');
  const releaseLock = await acquireLock(lockPath);
  let browser: WattpadBrowser | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    try { await browser?.close(); } finally { await releaseLock(); }
  })();
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    if (input === 'logout') { await WattpadBrowser.logout(home); console.log('Sesi lokal dihapus. Cache buku tetap tersedia.'); return; }
    browser = new WattpadBrowser(home, console.log);
    await browser.open();
    if (input === 'login') await browser.login();
    else await download(browser, input, { home, output: options.output, overwrite: options.overwrite }, console.log);
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}
main().catch(error => {
  // Avoid leaking browser internals, signed URLs, or session state in diagnostics.
  console.error(`Gagal: ${error instanceof DownloadError ? error.message : 'Operasi lokal gagal. Periksa izin folder, ruang disk, dan instalasi dependensi.'}`);
  process.exitCode = 1;
});
