/* =========================================================
   page-content.js — baca isi satu halaman

   Semua koordinat dinormalisasi ke ruang viewport:
   - sumbu Y menghadap ke BAWAH (seperti layar)
   - rotasi halaman sudah diterapkan, jadi PDF landscape
     tidak perlu penanganan khusus lagi
   ========================================================= */

import { extractRulings } from "./rulings.js";
import { maskDigits, median, normalizeText } from "./geometry.js";

export async function readPage(page, pdfjs, { readRulings = true } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const words = [];

  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    const box = toBox(item, viewport, pdfjs);
    if (!box) continue;

    const style = textContent.styles?.[item.fontName];
    const fontFamily = style?.fontFamily || "";

    for (const piece of splitWideGaps({ ...box, text: item.str, fontFamily })) {
      words.push(piece);
    }
  }

  let rulings = { horizontal: [], vertical: [] };

  if (readRulings) {
    try {
      const opList = await page.getOperatorList();
      rulings = extractRulings(opList, viewport.transform, pdfjs);
    } catch (error) {
      // PDF dengan konten vector aneh tidak boleh menggagalkan seluruh proses.
      console.warn("Gagal membaca garis tabel, lanjut pakai deteksi spasi.", error);
    }
  }

  // Beberapa PDF menaruh nomor halaman / footer di bawah tabel.
  // Jangan membuang footer hanya berdasarkan teks ("1", "2", dst.),
  // karena angka tersebut bisa saja merupakan data yang sah.
  // Jika garis tabel terbaca, gunakan garis horizontal bawah tabel
  // sebagai batas geometris. Dengan begitu PDF tanpa border tetap
  // memakai perilaku lama.
  const cleanedWords = stripBelowTableFooter(words, rulings, viewport);

  return {
    width: viewport.width,
    height: viewport.height,
    words: cleanedWords,
    rulings,
    hasText: cleanedWords.length > 0
  };
}

/**
 * Ubah item teks pdf.js menjadi kotak (bounding box) di ruang viewport.
 * Menghitung empat sudut supaya teks miring/berputar tetap dapat kotak benar.
 */
function toBox(item, viewport, pdfjs) {
  const m = pdfjs.Util.transform(viewport.transform, item.transform);

  const advance = Math.hypot(m[0], m[1]) || 1;
  const rise = Math.hypot(m[2], m[3]) || 1;

  const ux = m[0] / advance;
  const uy = m[1] / advance;
  const vx = m[2] / rise;
  const vy = m[3] / rise;

  const w = item.width || 0;
  const h = item.height || rise;

  const ox = m[4];
  const oy = m[5];

  const corners = [
    [ox, oy],
    [ox + ux * w, oy + uy * w],
    [ox + vx * h, oy + vy * h],
    [ox + ux * w + vx * h, oy + uy * w + vy * h]
  ];

  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);

  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  if (!Number.isFinite(x0) || !Number.isFinite(top)) return null;

  return {
    x0,
    x1,
    top,
    bottom,
    fontSize: h,
    vertical: Math.abs(uy) > Math.abs(ux) // teks diputar 90°, mis. header sempit
  };
}

/**
 * Sebagian PDF memancarkan satu baris penuh sebagai satu item teks,
 * dengan kolom dipisah spasi berulang. Kalau dibiarkan, seluruh baris
 * masuk ke satu kolom. Pecah di spasi ganda, lebar diperkirakan
 * proporsional terhadap jumlah karakter.
 */

/**
 * Buang text object yang berada di bawah batas bawah tabel yang
 * benar-benar terlihat dari ruling horizontal.
 *
 * Ini sengaja hanya aktif jika:
 * - ada beberapa garis vertikal (indikasi tabel bergaris),
 * - ada garis horizontal panjang di bagian bawah halaman,
 * - dan ada text di bawah garis tersebut.
 *
 * Dengan demikian angka footer seperti "1"/"2" pada PDF Sandvik
 * tidak menjadi baris Excel, tetapi angka valid pada PDF tanpa
 * border tidak ikut terhapus.
 */
function stripBelowTableFooter(words, rulings, viewport) {
  const horizontal = (rulings?.horizontal || [])
    .filter(line => Number.isFinite(line.y) && Number.isFinite(line.x0) && Number.isFinite(line.x1))
    .filter(line => line.x1 - line.x0 >= viewport.width * 0.70);

  const vertical = (rulings?.vertical || [])
    .filter(line => Number.isFinite(line.x) && Number.isFinite(line.y0) && Number.isFinite(line.y1));

  if (horizontal.length < 2 || vertical.length < 3) return words;

  const tableBottom = Math.max(...horizontal.map(line => line.y));
  const lowerBand = viewport.height * 0.78;

  // Hanya perlakukan garis yang benar-benar berada di area bawah
  // sebagai kandidat batas tabel. Ini menghindari garis header/section
  // di tengah halaman menjadi batas footer.
  if (tableBottom < lowerBand || tableBottom >= viewport.height - 12) {
    return words;
  }

  const below = words.filter(word => word.top > tableBottom + 4);
  if (!below.length) return words;

  // Footer/page number biasanya berdiri sendiri atau hanya beberapa
  // item kecil. Jangan menghapus blok teks besar di bawah tabel.
  const footerLike = below.every(word => {
    const width = Math.max(0, word.x1 - word.x0);
    const height = Math.max(0, word.bottom - word.top);
    return width <= viewport.width * 0.25 && height <= 24;
  });

  if (!footerLike) return words;

  const removed = new Set(below);

  // Pastikan kandidat footer benar-benar berada di luar rentang
  // horizontal tabel. Jika ada teks besar yang menyentuh area tabel,
  // pertahankan seluruhnya.
  const tableX0 = Math.min(...horizontal.map(line => line.x0));
  const tableX1 = Math.max(...horizontal.map(line => line.x1));

  const outsideOrTiny = below.every(word => {
    const overlap = Math.max(0, Math.min(word.x1, tableX1) - Math.max(word.x0, tableX0));
    const width = Math.max(0.1, word.x1 - word.x0);
    return overlap / width >= 0.0;
  });

  if (!outsideOrTiny) return words;

  return words.filter(word => !removed.has(word));
}

function splitWideGaps(word) {
  const raw = word.text;

  if (!/ {2,}/.test(raw) || word.vertical) {
    return [{ ...word, text: normalizeText(raw) }].filter(w => w.text);
  }

  const span = word.x1 - word.x0;
  const total = raw.length || 1;
  const parts = [];

  let cursor = 0;

  for (const chunk of raw.split(/( {2,})/)) {
    const start = cursor;
    cursor += chunk.length;

    const text = normalizeText(chunk);
    if (!text) continue;

    parts.push({
      ...word,
      text,
      x0: word.x0 + (span * start) / total,
      x1: word.x0 + (span * cursor) / total
    });
  }

  return parts.length ? parts : [{ ...word, text: normalizeText(raw) }];
}

/**
 * Buang kop/footer yang berulang di banyak halaman
 * (judul laporan, "Halaman 3 dari 12", tanggal cetak).
 * Deteksi berbasis pengulangan, bukan daftar kata kunci.
 */
export function stripRunningHeaders(pages, { threshold = 0.6, bandRatio = 0.12 } = {}) {
  if (pages.length < 3) return { removed: 0 };

  const counter = new Map();

  const bandOf = (page, word) => {
    const band = page.height * bandRatio;
    if (word.top <= band) return "top";
    if (word.bottom >= page.height - band) return "bottom";
    return null;
  };

  for (const page of pages) {
    const seen = new Set();

    for (const word of page.words) {
      const band = bandOf(page, word);
      if (!band) continue;

      const key = `${band}|${Math.round(word.top / 6)}|${maskDigits(word.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }

  const repeated = new Set(
    [...counter.entries()]
      .filter(([, count]) => count >= Math.ceil(pages.length * threshold))
      .map(([key]) => key)
  );

  if (!repeated.size) return { removed: 0 };

  let removed = 0;

  for (const page of pages) {
    page.words = page.words.filter(word => {
      const band = bandOf(page, word);
      if (!band) return true;

      const key = `${band}|${Math.round(word.top / 6)}|${maskDigits(word.text)}`;
      if (repeated.has(key)) {
        removed++;
        return false;
      }
      return true;
    });
  }

  return { removed };
}

/** Tinggi baris tipikal, dipakai sebagai satuan toleransi adaptif. */
export function typicalFontSize(words) {
  return median(words.map(w => w.fontSize)) || 10;
}
