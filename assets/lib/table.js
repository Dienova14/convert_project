/* =========================================================
   table.js — menentukan struktur tabel dari satu halaman

   Tiga strategi, dipilih otomatis:

   1. lattice  — border vertikal & horizontal terbaca.
                 Paling akurat. Merge cell terdeteksi asli
                 dari ada/tidaknya garis pemisah.

   2. hybrid   — hanya ada garis horizontal (tabel bergaris
                 baris saja). Baris dari garis, kolom dari
                 celah spasi.

   3. stream   — tidak ada border sama sekali. Kolom dicari
                 dari "koridor kosong" vertikal yang bertahan
                 di sebagian besar baris.
   ========================================================= */

import {
  boundariesToRanges,
  cluster1D,
  median,
  normalizeText,
  overlap
} from "./geometry.js";

import { hasHorizontalLine, hasVerticalLine } from "./rulings.js";
import { typicalFontSize } from "./page-content.js";

/* ---------------------------------------------------------
   Pengelompokan kata menjadi baris teks
   --------------------------------------------------------- */

export function clusterTextLines(words) {
  const sorted = [...words]
    .filter(w => !w.vertical)
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);

  const lines = [];

  for (const word of sorted) {
    const height = Math.max(1, word.bottom - word.top);
    let target = null;

    // cukup cek beberapa baris terakhir; input sudah terurut
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
      const line = lines[i];
      const shared = overlap(line.top, line.bottom, word.top, word.bottom);
      const minHeight = Math.min(line.bottom - line.top, height) || 1;

      if (shared / minHeight >= 0.4) {
        target = line;
        break;
      }
    }

    if (target) {
      target.words.push(word);
      target.top = Math.min(target.top, word.top);
      target.bottom = Math.max(target.bottom, word.bottom);
    } else {
      lines.push({ top: word.top, bottom: word.bottom, words: [word] });
    }
  }

  for (const line of lines) line.words.sort((a, b) => a.x0 - b.x0);
  lines.sort((a, b) => a.top - b.top);

  return lines;
}

/* ---------------------------------------------------------
   Deteksi kolom dari celah kosong (tanpa border)
   --------------------------------------------------------- */

/**
 * Proyeksikan semua kata ke sumbu X. Posisi X yang tidak pernah
 * (atau hampir tidak pernah) tertutup teks adalah pemisah kolom.
 *
 * Ini jauh lebih tahan banting dibanding klaster tepi kiri:
 * kolom rata kanan (angka) dan rata tengah ikut terdeteksi benar.
 */
export function detectColumnBoundaries(lines, options = {}) {
  const usable = lines.filter(line => line.words.length);
  if (usable.length < 2) return null;

  const words = usable.flatMap(line => line.words);
  if (words.length < 4) return null;

  const left = Math.min(...words.map(w => w.x0));
  const right = Math.max(...words.map(w => w.x1));
  const width = right - left;
  if (width <= 0) return null;

  const fontSize = typicalFontSize(words);
  const minGutter = options.minGutter ?? Math.max(3.5, fontSize * 0.55);

  // Baris "judul" yang membentang penuh akan menutup semua celah.
  // Baris seperti itu dikeluarkan dari perhitungan koridor.
  const bodyLines = usable.filter(line => {
    if (line.words.length > 1) return true;
    const span = line.words[0].x1 - line.words[0].x0;
    return span < width * 0.8;
  });

  const reference = bodyLines.length >= 2 ? bodyLines : usable;

  const bins = Math.max(8, Math.ceil(width));
  const counts = new Float32Array(bins + 1);
  const scale = bins / width;

  for (const line of reference) {
    const marked = new Uint8Array(bins + 1);

    for (const word of line.words) {
      const pad = Math.min(1.5, fontSize * 0.12);
      const a = Math.max(0, Math.floor((word.x0 - pad - left) * scale));
      const b = Math.min(bins, Math.ceil((word.x1 + pad - left) * scale));
      for (let i = a; i <= b; i++) marked[i] = 1;
    }

    for (let i = 0; i <= bins; i++) counts[i] += marked[i];
  }

  const tolerance = options.gutterTolerance ?? 0.03;
  const maxCrossing = Math.floor(reference.length * tolerance);

  const gutters = [];
  let start = null;

  for (let i = 0; i <= bins; i++) {
    const isGap = counts[i] <= maxCrossing;

    if (isGap && start === null) start = i;

    if (!isGap && start !== null) {
      gutters.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) gutters.push([start, bins]);

  const boundaries = [];

  for (const [a, b] of gutters) {
    const x0 = left + a / scale;
    const x1 = left + b / scale;

    if (x0 <= left + 0.5 || x1 >= right - 0.5) continue; // margin kiri/kanan
    if (x1 - x0 < minGutter) continue;

    boundaries.push((x0 + x1) / 2);
  }

  if (!boundaries.length) return null;

  return [left - 1, ...boundaries, right + 1];
}

/* ---------------------------------------------------------
   Penempatan kata ke dalam sel
   --------------------------------------------------------- */

function joinParts(parts) {
  const sorted = [...parts].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  let text = "";
  let previous = null;

  for (const part of sorted) {
    if (!previous) {
      text = part.text;
    } else {
      const sameLine = overlap(previous.top, previous.bottom, part.top, part.bottom) > 0;
      const gap = part.x0 - previous.x1;
      const glue = sameLine && gap < previous.fontSize * 0.22 ? "" : " ";
      text += glue + part.text;
    }
    previous = part;
  }

  return normalizeText(text);
}

/**
 * Bagikan kata-kata satu baris ke kolom.
 * Kata yang tumpang tindih ≥2 kolom dianggap merge kesamping (colspan).
 */
export function assignToColumns(words, columns) {
  const cells = columns.map(() => ({ parts: [], colspan: 1 }));

  for (const word of words) {
    const wordWidth = Math.max(0.5, word.x1 - word.x0);

    const hits = columns
      .map((column, index) => ({ index, shared: overlap(column.x0, column.x1, word.x0, word.x1) }))
      .filter(hit => hit.shared >= wordWidth * 0.25);

    if (!hits.length) {
      const center = (word.x0 + word.x1) / 2;
      let nearest = 0;
      let best = Infinity;

      columns.forEach((column, index) => {
        const distance = Math.abs((column.x0 + column.x1) / 2 - center);
        if (distance < best) {
          best = distance;
          nearest = index;
        }
      });

      cells[nearest].parts.push(word);
      continue;
    }

    const first = hits[0].index;
    const last = hits[hits.length - 1].index;

    cells[first].parts.push(word);
    cells[first].colspan = Math.max(cells[first].colspan, last - first + 1);
  }

  return cells.map(cell => ({
    text: joinParts(cell.parts),
    colspan: cell.colspan,
    rowspan: 1
  }));
}

/* ---------------------------------------------------------
   Analisis layout satu halaman
   --------------------------------------------------------- */

export function analyzePage(pageContent, options = {}) {
  const lines = clusterTextLines(pageContent.words);

  if (!lines.length) {
    return { mode: "none", lines, columns: null, rowSeparators: null };
  }

  const forced = options.mode && options.mode !== "auto" ? options.mode : null;
  const fontSize = typicalFontSize(pageContent.words);

  const grid = forced === "stream" ? null : findGrid(pageContent, fontSize);

  if (grid && (forced === "lattice" || !forced) && grid.columnLines.length >= 3) {
    return {
      mode: "lattice",
      lines,
      columns: boundariesToRanges(grid.columnLines),
      rowSeparators: grid.rowLines,
      grid
    };
  }

  const boundaries = detectColumnBoundaries(lines, options);

  if (!boundaries) {
    return { mode: "none", lines, columns: null, rowSeparators: null };
  }

  if (grid && grid.rowLines.length >= 3 && forced !== "stream") {
    return {
      mode: "hybrid",
      lines,
      columns: boundariesToRanges(boundaries),
      rowSeparators: grid.rowLines,
      grid
    };
  }

  return {
    mode: "stream",
    lines,
    columns: boundariesToRanges(boundaries),
    rowSeparators: null
  };
}

function findGrid(pageContent, fontSize) {
  const { rulings, words } = pageContent;
  if (!rulings.horizontal.length && !rulings.vertical.length) return null;

  const minVertical = fontSize * 1.2;
  const minHorizontal = fontSize * 2;

  // Cari dulu garis horizontal yang benar-benar membentuk badan tabel.
  // Garis dari header/footer atau elemen dekoratif lain tidak boleh ikut
  // menentukan kolom.
  const horizontalCandidates = rulings.horizontal.filter(
    line => line.x1 - line.x0 >= minHorizontal
  );
  if (horizontalCandidates.length < 3) return null;

  const rowLines = cluster1D(horizontalCandidates.map(l => l.y), 3);
  if (rowLines.length < 3) return null;

  const top = rowLines[0];
  const bottom = rowLines[rowLines.length - 1];
  const tableHeight = Math.max(1, bottom - top);

  // Ambil batas kiri/kanan dari garis horizontal terluar. Ini membuat
  // filter vertical tidak bergantung pada teks, sehingga tabel yang
  // kolomnya kosong sebagian tetap bisa dikenali.
  const left = Math.min(...horizontalCandidates.map(l => l.x0));
  const right = Math.max(...horizontalCandidates.map(l => l.x1));
  const tableWidth = Math.max(1, right - left);

  // Garis vertikal yang benar-benar menjadi border tabel biasanya
  // menutupi sebagian besar tinggi tabel. Garis pendek/dekorasi di dalam
  // halaman tidak boleh berubah menjadi batas kolom.
  const verticalCandidates = rulings.vertical.filter(line => {
    const overlapY = Math.max(0, Math.min(line.y1, bottom) - Math.max(line.y0, top));
    return (
      line.y1 - line.y0 >= minVertical &&
      overlapY / tableHeight >= 0.5 &&
      line.x >= left - 4 &&
      line.x <= right + 4
    );
  });

  const columnLines = cluster1D(verticalCandidates.map(l => l.x), 3);

  // Bila border vertikal tidak cukup lengkap, biarkan mode hybrid/stream
  // mengambil alih. Jangan memaksakan lattice pada layout yang ambigu.
  if (columnLines.length < 3) return null;

  const finalLeft = columnLines[0];
  const finalRight = columnLines[columnLines.length - 1];
  if (finalRight - finalLeft < Math.max(20, fontSize * 5)) return null;

  // Validasi isi grid. Layout yang salah sering menghasilkan satu kolom
  // raksasa atau batas-batas yang tidak berhubungan dengan teks. Setiap
  // kolom yang benar tidak harus terisi di setiap baris (merge/blank cell
  // sah), tetapi mayoritas kolom harus mendapat teks.
  const columns = boundariesToRanges(columnLines);
  const columnHits = new Array(columns.length).fill(0);
  let inside = 0;

  for (const word of words) {
    const cx = (word.x0 + word.x1) / 2;
    const cy = (word.top + word.bottom) / 2;
    if (
      cx < finalLeft - 2 ||
      cx > finalRight + 2 ||
      cy < top - 2 ||
      cy > bottom + 2
    ) {
      continue;
    }

    inside++;
    const index = columns.findIndex(
      column => cx >= column.x0 - 1 && cx <= column.x1 + 1
    );
    if (index >= 0) columnHits[index]++;
  }

  if (words.length && inside / words.length < 0.45) return null;

  const occupiedColumns = columnHits.filter(count => count > 0).length;
  const occupancyRatio = occupiedColumns / columns.length;

  // Tabel dengan merge vertikal/horizontal masih biasanya menyentuh
  // sebagian besar kolom. Threshold rendah menjaga tabel sparse tetap
  // lolos, tetapi mencegah border dekoratif dipilih sebagai lattice.
  if (columns.length >= 3 && occupancyRatio < 0.5) return null;

  // Pastikan garis horizontal juga berada di rentang tabel yang sama.
  const relevantRows = rowLines.filter(y => y >= top - 3 && y <= bottom + 3);
  if (relevantRows.length < 3) return null;

  return {
    columnLines,
    rowLines: relevantRows,
    bbox: { left: finalLeft, right: finalRight, top, bottom },
    confidence: occupancyRatio
  };
}

/* ---------------------------------------------------------
   Membangun baris tabel
   --------------------------------------------------------- */

export function buildRows(pageContent, layout, options = {}) {
  if (layout.mode === "none" || !layout.columns) return [];

  if (layout.mode === "lattice") {
    return buildLatticeRows(pageContent, layout);
  }

  if (layout.mode === "hybrid") {
    return buildBandedRows(pageContent, layout);
  }

  return buildStreamRows(pageContent, layout, options);
}

/** Grid penuh: baris & kolom dari garis, merge cell dari garis yang hilang. */
function buildLatticeRows(pageContent, layout) {
  const { grid, columns } = layout;
  const { rulings } = pageContent;

  const rowLines = grid.rowLines;
  const columnLines = grid.columnLines;

  const bands = [];
  for (let i = 0; i < rowLines.length - 1; i++) {
    bands.push({ top: rowLines[i], bottom: rowLines[i + 1] });
  }

  const taken = bands.map(() => new Array(columns.length).fill(false));
  const rows = [];

  for (let r = 0; r < bands.length; r++) {
    const band = bands[r];
    const cells = new Array(columns.length).fill(null);

    for (let c = 0; c < columns.length; c++) {
      if (taken[r][c]) continue;

      // Merge kesamping: tidak ada garis vertikal pemisah di band ini.
      let colspan = 1;
      while (
        c + colspan < columns.length &&
        !hasVerticalLine(rulings, columnLines[c + colspan], band.top + 1, band.bottom - 1)
      ) {
        colspan++;
      }

      const spanLeft = columns[c].x0;
      const spanRight = columns[c + colspan - 1].x1;

      // Merge ke bawah: tidak ada garis horizontal pemisah di bawah sel.
      let rowspan = 1;
      while (
        r + rowspan < bands.length &&
        !hasHorizontalLine(rulings, rowLines[r + rowspan], spanLeft + 1, spanRight - 1)
      ) {
        rowspan++;
      }

      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          taken[r + dr][c + dc] = true;
        }
      }

      const spanTop = band.top;
      const spanBottom = bands[r + rowspan - 1].bottom;

      const parts = pageContent.words.filter(word => {
        const cx = (word.x0 + word.x1) / 2;
        const cy = (word.top + word.bottom) / 2;
        return cx >= spanLeft && cx <= spanRight && cy >= spanTop && cy <= spanBottom;
      });

      cells[c] = { text: joinParts(parts), colspan, rowspan, parts };
    }

    rows.push(makeRow(cells, band.top, band.bottom));
  }

  return rows.filter(row => row.cells.some(cell => cell && cell.text));
}

/** Hanya garis horizontal: baris dari garis, kolom dari celah spasi. */
function buildBandedRows(pageContent, layout) {
  const separators = layout.rowSeparators;
  const rows = [];

  for (let i = 0; i < separators.length - 1; i++) {
    const top = separators[i];
    const bottom = separators[i + 1];

    const words = pageContent.words.filter(word => {
      const cy = (word.top + word.bottom) / 2;
      return cy > top && cy < bottom;
    });

    if (!words.length) continue;

    rows.push(makeRow(assignToColumns(words, layout.columns), top, bottom, words));
  }

  return rows;
}

/** Tanpa border: baris dari jarak vertikal + kolom jangkar. */
function buildStreamRows(pageContent, layout, options) {
  const { columns, lines } = layout;

  const drafts = lines
    .map(line => ({
      top: line.top,
      bottom: line.bottom,
      words: line.words,
      cells: assignToColumns(line.words, columns)
    }))
    .filter(draft => draft.cells.some(cell => cell.text));

  if (!drafts.length) return [];

  // Kolom jangkar = kolom yang hampir selalu terisi (mis. nomor / kode).
  // Baris lanjutan (teks yang wrap) pasti kosong di kolom ini.
  const fillRatio = columns.map(
    (_, index) => drafts.filter(d => d.cells[index].text).length / drafts.length
  );

  const anchors = fillRatio
    .map((ratio, index) => ({ ratio, index }))
    .filter(item => item.ratio >= 0.8)
    .map(item => item.index);

  const gaps = [];
  for (let i = 1; i < drafts.length; i++) {
    gaps.push(drafts[i].top - drafts[i - 1].bottom);
  }

  const typicalGap = median(gaps.filter(g => g >= 0));
  const joinWrapped = options.joinWrapped !== false;

  const rows = [];

  for (const draft of drafts) {
    const previous = rows[rows.length - 1];
    const gap = previous ? draft.top - previous.bottom : Infinity;

    // Dua tanda bahwa sebuah baris teks sebenarnya lanjutan sel di atasnya:
    //
    // 1. jaraknya lebih rapat dari jarak antar baris tabel (leading di dalam sel)
    // 2. kolom penanda baris (kolom kiri yang hampir selalu terisi) kosong
    const emptyAnchors = anchors.filter(index => !draft.cells[index].text).length;

    const tighter = Number.isFinite(gap) && typicalGap > 0 && gap <= typicalGap * 0.7;

    const sparse =
      anchors.length > 0 &&
      !draft.cells[anchors[0]].text &&
      emptyAnchors / anchors.length >= 0.6;

    const isContinuation =
      joinWrapped &&
      previous &&
      anchors.length > 0 &&
      gap <= Math.max(typicalGap * 1.8, 3) &&
      (tighter || sparse) &&
      emptyAnchors > 0;

    if (isContinuation) {
      draft.cells.forEach((cell, index) => {
        if (!cell.text) return;
        const target = previous.cells[index];
        target.text = target.text ? `${target.text} ${cell.text}` : cell.text;
        target.colspan = Math.max(target.colspan, cell.colspan);
      });
      previous.bottom = draft.bottom;
      previous.words.push(...draft.words);
      continue;
    }

    rows.push(makeRow(draft.cells, draft.top, draft.bottom, draft.words));
  }

  return rows;
}

function makeRow(cells, top, bottom, words = []) {
  const source = words.length ? words : cells.flatMap(cell => cell?.parts || []);
  const bold = isBoldRow(source);

  return {
    cells: cells.map(cell => (cell ? { ...cell, parts: undefined } : null)),
    top,
    bottom,
    bold,
    words: [...source],
    fontSize: median(source.map(w => w.fontSize))
  };
}

function isBoldRow(words) {
  if (!words.length) return false;
  const bold = words.filter(w => /bold|black|heavy|semib/i.test(w.fontFamily || "")).length;
  return bold / words.length >= 0.5;
}
