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

  unifyColumns(layouts);

  const pageTables = pages.map((page, index) => ({
    pageNumber: page.pageNumber,
    mode: layouts[index].mode,
    columns: layouts[index].columns,
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

  return {
    header,
    rows: body,
    columnCount,
    modes: [...new Set(usable.map(table => table.mode))],
    pageCount: usable.length
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
  return Boolean(text) && NUMERIC.test(text) && /\d/.test(text);
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

  const candidate = first.rows[0];
  const body = first.rows.slice(1, 12);
  if (!body.length) return null;

  let score = 0;

  const cells = candidate.cells.map(cell => normalizeText(cell?.text));
  const filled = cells.filter(Boolean).length;
  if (!filled) return null;

  if (filled / cells.length >= 0.7) score += 2;
  if (!cells.some(looksNumeric)) score += 2;
  if (candidate.bold) score += 2;
  if (cells.every(cell => cell.length <= 40)) score += 1;

  // Header biasanya berdiri di atas kolom yang isinya angka.
  const numericColumns = cells.filter((_, index) =>
    body.filter(row => looksNumeric(row.cells[index]?.text)).length >= body.length * 0.6
  ).length;

  if (numericColumns > 0) score += 2;
  if (candidate.fontSize && median(body.map(r => r.fontSize)) > candidate.fontSize + 0.5) score -= 2;

  if (score < 4) return null;

  return first.rows.shift();
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

      const isSpillover =
        joinAcrossPages &&
        i === 0 &&
        previous &&
        previous.page !== table.pageNumber &&
        !row.cells[0]?.text &&
        row.cells.some(cell => cell?.text);

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
