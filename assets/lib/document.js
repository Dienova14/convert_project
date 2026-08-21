/* =========================================================
   document.js — menyatukan hasil per halaman menjadi satu tabel

   Yang ditangani di sini:
   - menyamakan model kolom antar halaman
   - mengenali baris header sekali saja
   - membuang header yang diulang di halaman berikutnya
   - menyambung baris yang terpotong pergantian halaman
   - merge ke bawah (rowspan) → isi turun / biarkan kosong / merge asli
   ========================================================= */

import { median, normalizeText, textSimilarity } from "./geometry.js";
import { analyzePage, buildRows } from "./table.js";
import { buildGroupedPage, isNoValue, isSizeValue } from "./grouped.js";

export function buildDocumentTable(pages, options = {}) {
  if (options.mode === "grouped") {
    return buildGroupedDocumentTable(pages, options);
  }

  const layouts = pages.map(page => analyzePage(page, options));

  inheritContinuationLayouts(pages, layouts);
  // Jangan menyamakan koordinat X antar halaman secara global. Dua tabel yang
  // kebetulan sama-sama memiliki 8 kolom bisa mempunyai lebar/posisi kolom
  // yang sangat berbeda (contoh Bosch Horn vs Oil/Solar Filter). Baris sudah
  // dipetakan ke indeks kolom di masing-masing halaman, sehingga koordinat
  // hanya perlu konsisten di dalam halaman. Continuation page ditangani oleh
  // inheritContinuationLayouts() di atas.
  // unifyColumns(layouts);

  const pageTables = pages.map((page, index) => ({
    pageNumber: page.pageNumber,
    mode: layouts[index].mode,
    columns: layouts[index].columns,
    confidence: layouts[index].confidence,
    rows: buildRows(page, layouts[index], options)
  }));

  const usable = pageTables.filter(table => table.rows.length);

  if (!usable.length) {
    const anyText = pages.some(page => page.hasText);
    throw new Error(
      anyText
        ? "Tidak ada struktur tabel yang terbaca. Coba ganti mode deteksi ke Garis border atau Celah spasi."
        : "PDF ini tidak punya lapisan teks (kemungkinan hasil scan). Butuh OCR dulu."
    );
  }

  const columnCount = Math.max(
    ...usable.map(table => Math.max(...table.rows.map(row => row.cells.length), 0))
  );

  for (const table of usable) {
    for (const row of table.rows) padRow(row, columnCount);
  }

  const header = resolveHeader(usable, options);
  const body = collectBody(usable, header, options);

  const mergeMode = options.mergeMode ?? "fill";
  applyRowspan(body, mergeMode);

  if (mergeMode !== "merge") {
    for (const row of body) {
      row.cells = row.cells.map(cell =>
        cell ? { ...cell, colspan: 1, rowspan: 1 } : { text: "", colspan: 1, rowspan: 1 }
      );
    }
  }

  const layoutConfidences = usable
    .map(table => Number(table.confidence))
    .filter(Number.isFinite);

  return {
    header,
    rows: body,
    columnCount,
    modes: [...new Set(usable.map(table => table.mode))],
    pageCount: usable.length,
    confidence: layoutConfidences.length
      ? median(layoutConfidences)
      : null
  };
}

function buildGroupedDocumentTable(pages) {
  const parsed = pages.map(page => ({
    pageNumber: page.pageNumber,
    ...buildGroupedPage(page)
  }));

  const usable = parsed.filter(page => page.rows.length);
  if (!usable.length) {
    throw new Error("Mode Price list bertingkat tidak menemukan baris dengan pola harga. Gunakan mode Deteksi otomatis untuk tabel biasa.");
  }

  const header = usable.find(page => page.header)?.header || null;
  const rows = [];
  let currentNo = "";
  let currentSize = "";

  for (const page of usable) {
    for (const row of page.rows) {
      const no = normalizeText(row.cells[0]?.text || "");
      const size = normalizeText(row.cells[1]?.text || "");

      if (isNoValue(no)) currentNo = no;
      if (isSizeValue(size)) currentSize = size;

      // Jika PDF menaruh teks non-size di kolom kedua, jangan menimpa
      // ukuran terakhir yang masih berlaku.
      row.cells[0].text = currentNo;
      row.cells[1].text = currentSize;
      row.page = page.pageNumber;
      rows.push(row);
    }
  }

  return {
    header,
    rows,
    columnCount: 4,
    modes: ["grouped"],
    pageCount: usable.length
  };
}

function padRow(row, size) {
  while (row.cells.length < size) row.cells.push({ text: "", colspan: 1, rowspan: 1 });
  row.cells.length = size;
}

/* ---------------------------------------------------------
   Model kolom global

   Kolom dideteksi ulang tiap halaman, jadi batasnya bisa
   bergeser beberapa titik. Kalau dibiarkan, halaman 2 bisa
   punya jumlah kolom berbeda dan hasilnya melenceng.
   --------------------------------------------------------- */


/**
 * Halaman lanjutan kadang hanya berisi sisa baris tabel tanpa header dan
 * tanpa border sama sekali. Contoh Bosch Bulb & Halogen: halaman 10 memiliki
 * grid lengkap, halaman 11 hanya menyimpan baris nomor 42. Layout halaman
 * sebelumnya tetap merupakan sumber kolom yang paling kuat.
 */
function inheritContinuationLayouts(pages, layouts) {
  for (let i = 1; i < pages.length; i++) {
    const current = layouts[i];
    const previous = layouts[i - 1];
    if (current?.columns?.length || !previous?.columns?.length || !pages[i].hasText) continue;

    const lines = current?.lines?.length ? current.lines : [];
    const firstWords = lines[0]?.words || [];
    if (!firstWords.length) continue;

    const firstText = normalizeText(firstWords.map(w => w.text).join(" "));
    const firstToken = normalizeText(firstWords[0]?.text || "");

    // Jangan mewarisi layout untuk halaman yang jelas merupakan section/title baru.
    const looksLikeTitle = /^(bosch|price|list|total|catatan|notes|keterangan)$/i.test(firstToken) ||
      /price\s+list/i.test(firstText);
    if (looksLikeTitle) continue;

    // Data continuation biasanya dimulai dengan nomor, PN/kode, atau token
    // alfanumerik yang pendek. Ini sengaja konservatif agar layout halaman baru
    // tidak salah diwarisi hanya karena kebetulan tidak punya ruling.
    const looksLikeData =
      /^\d+$/.test(firstToken) ||
      /^[A-Z0-9][A-Z0-9._\/-]{4,}$/i.test(firstToken) ||
      firstWords.length >= Math.min(3, previous.columns.length);

    if (!looksLikeData) continue;

    layouts[i] = {
      ...current,
      mode: "continuation-stream",
      columns: previous.columns.map(column => ({ ...column })),
      rowSeparators: null,
      grid: null,
      confidence: Math.min(Number(previous.confidence) || 0.65, 0.90),
      inheritedFromPage: pages[i - 1].pageNumber
    };
  }
}

function unifyColumns(layouts) {
  const valid = layouts.filter(layout => layout.columns?.length);
  if (valid.length < 2) return;

  const counts = new Map();
  for (const layout of valid) {
    const key = layout.columns.length;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const [modal] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  const group = valid.filter(layout => layout.columns.length === modal);
  if (group.length < 2) return;

  const unified = [];

  for (let i = 0; i < modal; i++) {
    unified.push({
      x0: median(group.map(layout => layout.columns[i].x0)),
      x1: median(group.map(layout => layout.columns[i].x1))
    });
  }

  for (const layout of group) {
    layout.columns = unified.map(column => ({ ...column }));

    // Mode lattice memakai columnLines untuk mendeteksi colspan,
    // jadi keduanya harus tetap sinkron.
    if (layout.grid && layout.grid.columnLines.length === modal + 1) {
      layout.grid.columnLines = [
        ...unified.map(column => column.x0),
        unified[unified.length - 1].x1
      ];
    }
  }
}

/* ---------------------------------------------------------
   Header
   --------------------------------------------------------- */

const NUMERIC = /^[\s(]*[-+]?(?:rp|idr|usd|\$)?\s*[\d.,]+\s*%?\)?$/i;

function looksNumeric(value) {
  const text = normalizeText(value);

  if (!text || !NUMERIC.test(text) || !/\d/.test(text)) return false;

  // Angka bulat dengan leading zero biasanya merupakan kode/ID,
  // bukan nilai numerik yang boleh diubah menjadi Number.
  if (/^[+-]?0\d+$/.test(text)) return false;

  return true;
}

function rowText(row) {
  return row.cells.map(cell => cell?.text || "").join(" | ");
}

function resolveHeader(tables, options) {
  const setting = options.headerMode ?? "auto";
  if (setting === "none") return null;

  const first = tables[0];
  if (!first?.rows.length) return null;

  if (setting === "first") {
    return first.rows.shift();
  }

  // Auto tidak lagi menganggap row pertama sebagai header.
  // Cari kandidat di beberapa row teratas, karena PDF bisa mempunyai:
  // title/group row → header → data.
  const candidates = first.rows.slice(0, Math.min(15, first.rows.length));
  const bodySample = first.rows.slice(0, Math.min(20, first.rows.length));

  let best = null;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const cells = candidate.cells.map(cell => normalizeText(cell?.text));
    const filled = cells.filter(Boolean).length;
    if (!filled) continue;

    const nonEmptyRatio = filled / Math.max(1, cells.length);
    const text = cells.filter(Boolean).join(" | ");

    // Header harus lebih menyerupai label daripada nilai data.
    const numericCount = cells.filter(looksNumeric).length;
    const numericRatio = numericCount / Math.max(1, filled);

    let score = 0;

    // Posisi: header biasanya berada di bagian awal tabel, tetapi jangan
    // memaksa row pertama.
    score += Math.max(0, 2.5 - index * 0.18);

    // Kepadatan cell.
    if (nonEmptyRatio >= 0.65) score += 2.2;
    else if (nonEmptyRatio >= 0.45) score += 1.0;

    // Label header biasanya tidak dominan numeric.
    if (numericRatio === 0) score += 2.0;
    else if (numericRatio < 0.25) score += 1.0;
    else score -= 2.0;

    // Bold/font sedikit membantu, tetapi bukan syarat.
    if (candidate.bold) score += 1.5;

    // Header text biasanya pendek/moderat per cell.
    const avgLen = cells.filter(Boolean)
      .reduce((sum, value) => sum + value.length, 0) / Math.max(1, filled);
    if (avgLen <= 35) score += 1.0;
    if (avgLen > 70) score -= 1.0;

    // Cari apakah row setelah kandidat mempunyai pola data yang konsisten
    // dengan kolom kandidat. Ini menjadi sinyal utama agar group row
    // seperti "AAS01A4B00000 | 50 SQPB/FC STD/BP" tidak dianggap header.
    const below = first.rows.slice(index + 1, Math.min(index + 11, first.rows.length));
    if (below.length >= 2) {
      let usefulColumns = 0;
      let numericColumns = 0;

      for (let column = 0; column < cells.length; column++) {
        const values = below
          .map(row => normalizeText(row.cells[column]?.text))
          .filter(Boolean);

        if (values.length >= Math.max(2, Math.ceil(below.length * 0.35))) {
          usefulColumns++;
        }

        if (values.length >= 2) {
          const ratio = values.filter(looksNumeric).length / values.length;
          if (ratio >= 0.6) numericColumns++;
        }
      }

      score += Math.min(2.5, usefulColumns * 0.45);
      score += Math.min(1.5, numericColumns * 0.35);
    }

    // Group/section row biasanya sangat sedikit cell terisi dan memiliki
    // kode panjang di kolom pertama + deskripsi panjang. Penalti eksplisit.
    const firstCell = cells[0] || "";
    const codeLike = /^[A-Z0-9][A-Z0-9._\/-]{5,}$/i.test(firstCell);
    const looksSection =
      codeLike &&
      filled <= Math.max(2, Math.ceil(cells.length * 0.45)) &&
      text.length > 12;

    if (looksSection) score -= 3.5;

    // Header vocabulary hanya sebagai sinyal lemah/generic hint.
    // Tidak ada nama header yang diwajibkan.
    const labelLikeTokens = cells.filter(value =>
      /[A-Za-zÀ-ÿ]/.test(value) &&
      value.length >= 2 &&
      !/^\d/.test(value)
    ).length;

    if (labelLikeTokens >= Math.min(3, Math.max(1, cells.length - 1))) {
      score += 0.8;
    }

    // Kandidat yang sangat dekat dengan data numeric tetapi tidak punya
    // label text jangan dipilih.
    if (numericRatio > 0.5) score -= 2;

    if (!best || score > best.score) {
      best = { row: candidate, index, score };
    }
  }

  // Ambang konservatif. Jika tidak ada kandidat yang cukup kuat, jangan
  // mengarang header.
  if (!best || best.score < 5.0) return null;

  // Hapus hanya instance header yang dipilih dari halaman pertama.
  const headerIndex = first.rows.indexOf(best.row);
  if (headerIndex >= 0) first.rows.splice(headerIndex, 1);

  return best.row;
}

function collectBody(tables, header, options) {
  const rows = [];
  const joinAcrossPages = options.joinAcrossPages !== false;
  const headerText = header ? rowText(header) : null;

  for (const table of tables) {
    let pageRows = table.rows;

    // Header yang dicetak ulang di tiap halaman.
    if (headerText) {
      pageRows = pageRows.filter(row => textSimilarity(rowText(row), headerText) < 0.7);
    }

    for (let i = 0; i < pageRows.length; i++) {
      const row = pageRows[i];
      row.page = table.pageNumber;

      const previous = rows[rows.length - 1];

      const filledCount = row.cells.filter(cell => normalizeText(cell?.text)).length;
      const previousFilledCount = previous
        ? previous.cells.filter(cell => normalizeText(cell?.text)).length
        : 0;

      const isSpillover =
        joinAcrossPages &&
        i === 0 &&
        previous &&
        previous.page !== table.pageNumber &&
        !row.cells[0]?.text &&
        filledCount > 0 &&
        filledCount < row.cells.length &&
        previousFilledCount > 0;

      if (isSpillover) {
        row.cells.forEach((cell, index) => {
          if (!cell?.text) return;
          const target = previous.cells[index];
          target.text = target.text ? `${target.text} ${cell.text}` : cell.text;
        });
        continue;
      }

      rows.push(row);
    }
  }

  return rows;
}

/* ---------------------------------------------------------
   Merge ke bawah
   --------------------------------------------------------- */

function applyRowspan(rows, mode) {
  if (mode === "keep") return;

  // Mode lattice sudah tahu rowspan asli dari garis.
  const hasRealSpans = rows.some(row => row.cells.some(cell => (cell?.rowspan || 1) > 1));

  if (hasRealSpans) {
    if (mode !== "fill") return;

    rows.forEach((row, index) => {
      row.cells.forEach((cell, column) => {
        const span = cell?.rowspan || 1;
        if (span <= 1 || !cell.text) return;

        for (let k = 1; k < span && index + k < rows.length; k++) {
          const next = rows[index + k];
          if (next.page !== row.page) break; // jangan lompat halaman

          const target = next.cells[column];

          if (!target) {
            next.cells[column] = { text: cell.text, colspan: 1, rowspan: 1, filledDown: true };
          } else if (!target.text) {
            target.text = cell.text;
            target.filledDown = true;
          }
        }
      });
    });

    // Sel yang tersisa kosong karena merge tetap perlu wadah.
    for (const row of rows) {
      row.cells = row.cells.map(cell => cell || { text: "", colspan: 1, rowspan: 1 });
    }

    return;
  }

  if (mode !== "fill") return;

  // Tanpa garis: tebak merge dari pola kosong.
  const columnCount = rows[0]?.cells.length || 0;

  for (let column = 0; column < columnCount; column++) {
    const values = rows.map(row => normalizeText(row.cells[column]?.text));
    const filled = values.filter(Boolean);

    if (!filled.length) continue;

    const blankRatio = (values.length - filled.length) / values.length;
    if (blankRatio < 0.2) continue;

    // Kolom angka jangan diisi turun — nilainya memang beda tiap baris.
    const numericRatio = filled.filter(looksNumeric).length / filled.length;
    if (numericRatio > 0.6) continue;

    // Nilai yang berulang panjang = kandidat merge. Nilai yang selalu unik bukan.
    const unique = new Set(filled).size;
    if (unique / filled.length > 0.9 && blankRatio < 0.5) continue;

    let carry = "";

    for (const row of rows) {
      const cell = row.cells[column];
      if (!cell) continue;

      if (cell.text) {
        carry = cell.text;
      } else if (carry) {
        cell.text = carry;
        cell.filledDown = true;
      }
    }
  }
}

/* ---------------------------------------------------------
   Angka
   --------------------------------------------------------- */

export function parseNumber(value, locale = "auto") {
  if (locale === "off") return null;

  let text = normalizeText(value);
  if (!text || !/\d/.test(text)) return null;

  // Jangan konversi kode numerik dengan leading zero menjadi Number.
  // JavaScript akan mengubah 00123 menjadi 123 dan Excel tidak dapat
  // mengembalikan nol di depannya secara otomatis.
  if (/^[+-]?0\d+$/.test(text)) return null;

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  const percent = /%$/.test(text);

  text = text
    .replace(/%/g, "")
    .replace(/(rp|idr|usd|eur|sgd|\$|€)/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (/^-/.test(text)) {
    negative = true;
    text = text.slice(1);
  }

  if (!/^[\d.,]+$/.test(text)) return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  let decimalSeparator = null;

  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastDot > lastComma ? "." : ",";
  } else if (locale === "id") {
    decimalSeparator = lastComma >= 0 ? "," : null;
  } else if (locale === "en") {
    decimalSeparator = lastDot >= 0 ? "." : null;
  } else {
    const single = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (single) {
      const tail = text.length - text.lastIndexOf(single) - 1;
      const occurrences = text.split(single).length - 1;
      // "1.234" → pemisah ribuan. "1.5" atau "1.2345" → desimal.
      decimalSeparator = occurrences === 1 && tail !== 3 ? single : null;
    }
  }

  let normalized = text;

  if (decimalSeparator) {
    const other = decimalSeparator === "." ? "," : ".";
    normalized = normalized.split(other).join("");
    normalized = normalized.replace(decimalSeparator, ".");
  } else {
    normalized = normalized.replace(/[.,]/g, "");
  }

  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;

  const result = negative ? -number : number;
  return percent ? result / 100 : result;
}
