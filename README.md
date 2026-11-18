# Wattpad → EPUB

CLI untuk menggabungkan **seluruh chapter satu cerita Wattpad menjadi satu EPUB**, termasuk gambar di dalam isi chapter, format teks, dan daftar isi. Cover cerita dan gambar header chapter tidak disertakan. Link chapter otomatis diarahkan ke cerita induknya.

## Instalasi

Butuh **Node.js 24+** dan Google Chrome atau Chromium Playwright.

```bash
npm install
npm run build
npm link
```

`npm link` memasang perintah `wattpad-epub` di lingkungan npm lokal kamu. Tanpa pemasangan global, gunakan `npm start -- ...` atau `node dist/cli.js ...`.

Jika Google Chrome sudah terpasang, CLI otomatis memakainya ketika Chromium bawaan belum tersedia. Profil Chrome pribadi tidak digunakan. Untuk memasang Chromium pada OS yang didukung:

```bash
npm run browser:install
```

macOS lama yang tidak didukung Chromium Playwright terbaru dapat menggunakan Google Chrome yang sudah terpasang. Browser tetap terlihat selama proses agar login manual mudah dilakukan.

## Pemakaian

```bash
# Opsional: login terlebih dahulu
wattpad-epub login

# Link story ATAU link chapter → seluruh cerita
wattpad-epub "https://www.wattpad.com/story/123456-judul"
wattpad-epub "https://www.wattpad.com/123456789-judul-chapter" -o ./buku.epub

# Menimpa output secara eksplisit
wattpad-epub "https://www.wattpad.com/story/123456-judul" -o ./buku.epub --overwrite

# Hapus sesi lokal; cache cerita tetap ada
wattpad-epub logout
```

Angka pada contoh adalah placeholder; ganti dengan link cerita asli. Tanpa `--output`, nama hasil adalah `<judul>-<story-id>.epub` di direktori saat ini. Satu perintah menerima satu link. Profil pengguna, reading list, serta beberapa buku terpisah bukan satu story dan tidak didukung.

Jika belum login atau sesi kedaluwarsa, browser membuka halaman login Wattpad. Login seperti biasa; CLI mendeteksi akun dan melanjutkan otomatis, tanpa menyalin cookie atau password ke terminal. Batas waktu login 10 menit. Menutup browser atau menekan Ctrl+C menghentikan pekerjaan; progres lengkap yang sudah tersimpan bisa digunakan lagi.

## Isi EPUB dan kelengkapan

- Judul, penulis, deskripsi, bahasa, tautan sumber, dan daftar isi yang bisa diklik. Gambar hanya diambil dari isi chapter, bukan cover atau header.
- Paragraf, heading, bold/italic, underline, daftar, kutipan, pemisah adegan, alignment teks, dan posisi gambar dipertahankan. Navigasi situs, iklan, dan komentar dibuang.
- Semua gambar disimpan di EPUB. JPEG/PNG/GIF dipertahankan; format lain yang dapat didekode dikonversi ke PNG. Aset identik disimpan satu kali.
- Video/audio menjadi tautan sumber. Font, pagination, dan ukuran teks mengikuti pembaca EPUB; hasil bukan salinan tampilan website pixel demi pixel.
- Setiap halaman chapter harus memiliki metadata jumlah halaman, nomor halaman, serta penanda halaman terakhir yang konsisten. Halaman kosong, login, preview yang terdeteksi, atau struktur tidak dikenal menyebabkan kegagalan.
- Chapter terkunci atau gambar gagal **menghentikan penerbitan EPUB final**. Hanya konten yang tersedia bagi akun yang digunakan; tool tidak membuka kunci konten.
- Error jaringan, HTTP 429, dan HTTP 5xx dicoba ulang maksimal tiga kali setelah percobaan awal, dengan jeda bertambah dan mengikuti `Retry-After`.
- File baru diterbitkan secara atomik setelah struktur ZIP, XML, referensi aset, serta urutan chapter diperiksa. EPUB lama tidak berubah jika proses penggantian gagal sebelum publikasi.

## Sesi dan resume

Default penyimpanan: `~/.wattpad-epub/`.

```text
browser/          profil browser khusus (mengandung sesi login)
cache/<story-id>/  chapter lengkap dan aset gambar
process.lock      mencegah dua proses memakai profil bersamaan
```

Folder sesi memakai izin privat. Jangan membagikan folder `browser/`. Cache berisi konten buku yang telah diunduh, sehingga juga sebaiknya tetap privat.

Untuk lokasi lain:

```bash
wattpad-epub --data-dir ./data "https://www.wattpad.com/story/123456"
# Atau atur WATTPAD_EPUB_HOME
```

Jalankan ulang perintah yang sama untuk melanjutkan. Cache chapter digunakan hanya jika daftar chapter dan metadata cerita masih cocok serta timestamp perubahan tersedia. Cache yang rusak diunduh ulang. Metadata diperiksa kembali sebelum EPUB diterbitkan. Situs tidak selalu memberi versi perubahan gambar terpisah; gambar direvalidasi melalui versi cerita dan URL aset, bukan permintaan kondisional per gambar.

`logout` hanya menghapus sesi di mesin ini, bukan mencabut semua sesi akun di perangkat lain. Untuk menghapus cache juga, hapus folder `cache/` ketika CLI tidak berjalan.

## Troubleshooting

| Pesan | Tindakan |
| --- | --- |
| Browser gagal dibuka | Pasang Chrome atau jalankan `npm run browser:install`; tutup proses lain yang memakai profil tool. |
| File tujuan sudah ada | Pilih `-o` lain atau tambahkan `--overwrite`. |
| Chapter terkunci / akses ditolak | Periksa akses cerita melalui akun Wattpad. EPUB parsial tidak dibuat. |
| Human checking terdeteksi | Browser tetap terbuka tanpa batas waktu. Selesaikan verifikasi manual; CLI lanjut setelah halaman chapter yang benar muncul. Ctrl+C untuk membatalkan. |
| Metadata/pagination tidak ditemukan | Struktur halaman mungkin berubah atau ada pembatasan yang tidak dikenali. Tool berhenti agar tidak menghasilkan buku terpotong. |
| Gambar gagal | Coba ulang; chapter lengkap sebelumnya tetap berada di cache. |
| Cerita berubah saat diunduh | Jalankan ulang untuk mengambil versi metadata terbaru. |
| Profil sedang dipakai | Hentikan proses sebelumnya. Lock dengan PID proses yang sudah mati otomatis dipulihkan saat menjalankan ulang CLI; cache chapter lengkap tetap digunakan. |

## Pengujian

```bash
npm run check
npm test
# Tes Chrome dengan situs fixture terisolasi; tidak login ke akun asli
RUN_BROWSER_TESTS=1 npm test

# Buat buku sintetis untuk pemeriksaan EPUB/reader
node --import tsx scripts/make-validation-book.ts /tmp/wattpad-epub-validation
java -jar /lokasi/epubcheck.jar /tmp/wattpad-epub-validation/validation.epub
```

EPUBCheck tersedia dari [rilis resmi W3C](https://github.com/w3c/epubcheck/releases). Pemeriksaan runtime CLI menggunakan validasi internal; Java/EPUBCheck tidak wajib untuk pengguna CLI.

Tes mencakup normalisasi URL, resolusi chapter ke story, urutan chapter, pagination, login/sesi kedaluwarsa, format teks, gambar lazy-loaded, konversi/deduplikasi gambar, retry, resume/invalidation cache, chapter terkunci, kegagalan gambar, perubahan cerita, dan perlindungan file tujuan.

Verifikasi implementasi: selector dan metadata reader dicek terhadap halaman publik Wattpad, termasuk chapter multi-halaman; EPUB sintetis lolos EPUBCheck 5.4.0 dengan nol error/warning. EPUB sintetis juga dibuka dengan EPUB.js di Chrome dalam mode offline: gambar berhasil dimuat dan navigasi kedua chapter berfungsi. Pengunduhan cerita lengkap menggunakan akun asli perlu diuji dengan login dan link cerita pengguna. Tes fixture tidak membuktikan akses akun atau dukungan seluruh variasi halaman berbayar.

## Struktur implementasi

`src/browser.ts` menangani browser dan sesi; `src/extract.ts` mengisolasi adapter struktur Wattpad; `src/content.ts` menangani format dan gambar; `src/download.ts` mengatur cache serta kelengkapan; `src/epub.ts` membangun dan mempublikasikan EPUB. Metadata story memakai endpoint web Wattpad `/api/v3/stories/{id}`; isi chapter diambil dari halaman reader browser. Endpoint/struktur ini bukan kontrak publik yang stabil dan mungkin perlu diperbarui jika Wattpad berubah.
