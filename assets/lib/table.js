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
      const glue = sameLine && gap < previous.fontSize * 0.08 ? "" : " ";
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


/* ---------------------------------------------------------
   Adaptive column detection v1

   Stream lama hanya mencari koridor kosong yang konsisten. Itu cepat,
   tetapi mudah gagal ketika posisi X antarbaris bergeser atau beberapa
   kolom hanya muncul pada sebagian baris.

   Adaptive v1 membuat beberapa kandidat batas kolom dari:
   - gap antar text object,
   - batas kiri/kanan text object yang berulang,
   - hasil stream lama,
   lalu memilih kombinasi batas dengan skor struktur terbaik.

   Tidak memakai AI / server. Semua dihitung lokal di browser.
   --------------------------------------------------------- */

const ADAPTIVE_MAX_COLUMNS = 12;
const ADAPTIVE_MAX_CANDIDATES = 12;

function adaptiveNumericLike(value) {
  const text = normalizeText(value);
  if (!text || /^[+-]?0\d+$/.test(text)) return false;
  return /^(?:rp\.?\s*|idr\s*|usd\s*|\$\s*)?[+-]?[\d.,]+\s*%?$/i.test(text);
}

function clusterPositions(values, tolerance = 4) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];

  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.max <= tolerance) {
      last.values.push(value);
      last.max = value;
    } else {
      clusters.push({ values: [value], min: value, max: value });
    }
  }

  return clusters.map(cluster => ({
    value: median(cluster.values),
    count: cluster.values.length,
    min: cluster.min,
    max: cluster.max
  }));
}

function adaptiveCandidates(lines, left, right, fontSize) {
  const byLine = [];
  const gapPositions = [];
  const gapWidths = [];
  const edgePositions = [];

  for (const line of lines) {
    const words = [...line.words].sort((a, b) => a.x0 - b.x0);
    const gaps = [];

    for (let i = 1; i < words.length; i++) {
      const previous = words[i - 1];
      const current = words[i];
      const gap = current.x0 - previous.x1;
      if (gap < Math.max(2, fontSize * 0.35)) continue;

      const center = (previous.x1 + current.x0) / 2;
      if (center <= left + 2 || center >= right - 2) continue;

      gaps.push({ center, gap });
      gapPositions.push(center);
      gapWidths.push(gap);
    }

    byLine.push(gaps);
    for (const word of words) {
      if (word.x0 > left + 2 && word.x0 < right - 2) edgePositions.push(word.x0);
      if (word.x1 > left + 2 && word.x1 < right - 2) edgePositions.push(word.x1);
    }
  }

  const candidates = [];
  const clusters = clusterPositions(gapPositions, Math.max(3, fontSize * 0.35));

  for (const cluster of clusters) {
    const support = byLine.filter(gaps =>
      gaps.some(gap => Math.abs(gap.center - cluster.value) <= Math.max(3, fontSize * 0.35))
    ).length / Math.max(1, lines.length);

    const nearbyGaps = gapPositions
      .map((position, index) => ({ position, width: gapWidths[index] }))
      .filter(item => Math.abs(item.position - cluster.value) <= Math.max(3, fontSize * 0.35));

    const averageGap = nearbyGaps.length
      ? nearbyGaps.reduce((sum, item) => sum + item.width, 0) / nearbyGaps.length
      : 0;

    candidates.push({
      x: cluster.value,
      support,
      gap: averageGap,
      source: "gap"
    });
  }

  // Bila sebuah kolom rata-kiri/rata-kanan tetapi gap-nya tidak konsisten,
  // edge X yang berulang tetap memberi kandidat boundary yang berguna.
  for (const cluster of clusterPositions(edgePositions, Math.max(3, fontSize * 0.45))) {
    const support = Math.min(1, cluster.count / Math.max(2, lines.length));
    if (support < 0.12) continue;
    candidates.push({
      x: cluster.value,
      support: support * 0.65,
      gap: 0,
      source: "edge"
    });
  }

  const merged = clusterPositions(candidates.map(item => item.x), Math.max(4, fontSize * 0.45));
  const normalized = merged.map(cluster => {
    const nearby = candidates.filter(item => Math.abs(item.x - cluster.value) <= Math.max(4, fontSize * 0.45));
    const best = nearby.sort((a, b) =>
      (b.support + Math.min(0.25, b.gap / Math.max(1, fontSize * 8))) -
      (a.support + Math.min(0.25, a.gap / Math.max(1, fontSize * 8)))
    )[0];
    return {
      x: cluster.value,
      support: Math.max(...nearby.map(item => item.support), best?.support || 0),
      gap: Math.max(...nearby.map(item => item.gap), best?.gap || 0),
      source: best?.source || "edge"
    };
  });

  return normalized
    .filter(item => item.x > left + Math.max(3, fontSize) && item.x < right - Math.max(3, fontSize))
    .sort((a, b) => (b.support - a.support) || (b.gap - a.gap))
    .slice(0, ADAPTIVE_MAX_CANDIDATES);
}

function adaptiveBoundaryPenalty(lines, boundaries) {
  let cuts = 0;
  let opportunities = 0;

  for (const line of lines) {
    for (const boundary of boundaries) {
      const word = line.words.find(item => item.x0 + 1 < boundary && item.x1 - 1 > boundary);
      if (word) cuts++;
      opportunities++;
    }
  }

  return opportunities ? cuts / opportunities : 0;
}

function scoreAdaptiveColumns(lines, columns, candidateMap) {
  if (columns.length < 2 || columns.length > ADAPTIVE_MAX_COLUMNS) return -Infinity;

  const firstLine = lines[0];
  const firstLineWords = firstLine?.words?.length || 0;
  const headerColumnHint = firstLineWords >= 2 && firstLineWords <= 6 ? firstLineWords : null;

  const rows = lines.map(line => {
    const cells = columns.map(() => []);
    for (const word of line.words) {
      const center = (word.x0 + word.x1) / 2;
      let index = columns.findIndex(column => center >= column.x0 && center < column.x1);
      if (index < 0) index = center >= columns[columns.length - 1].x0 ? columns.length - 1 : 0;
      cells[index].push(word);
    }
    return cells;
  });

  const nonEmptyByColumn = columns.map((_, index) =>
    rows.filter(cells => cells[index].length > 0).length / Math.max(1, rows.length)
  );

  const occupiedRatio = nonEmptyByColumn.filter(value => value >= 0.15).length / columns.length;
  if (occupiedRatio < 0.5) return -Infinity;

  const widths = columns.map(column => column.x1 - column.x0);
  if (widths.some(width => width < 6)) return -Infinity;

  const emptyPenalty = nonEmptyByColumn.filter(value => value < 0.15).length / columns.length;
  const widePenalty = Math.min(1, Math.max(...widths) / Math.max(1, Math.min(...widths)) / 12);

  let numericConsistency = 0;
  for (let c = 0; c < columns.length; c++) {
    const values = rows
      .map(cells => normalizeText(cells[c].map(word => word.text).join(" ")))
      .filter(Boolean);
    if (values.length < 2) continue;
    const numericRatio = values.filter(adaptiveNumericLike).length / values.length;
    if (numericRatio >= 0.65 || numericRatio <= 0.15) numericConsistency += 1;
  }
  numericConsistency /= columns.length;

  // Boundary support: boundary yang sering muncul tepat di whitespace
  // lebih dipercaya daripada boundary yang hanya muncul sekali.
  const boundarySupport = candidateMap.reduce((sum, candidate) => sum + candidate.support, 0) /
    Math.max(1, candidateMap.length);

  const cutPenalty = adaptiveBoundaryPenalty(lines, columns.slice(0, -1).map(column => column.x1));

  // Terlalu banyak kolom biasanya berarti kita memotong nama/deskripsi menjadi
  // beberapa kolom palsu. Penalti ringan menjaga 4-6 kolom tetap stabil.
  const columnCountPenalty = columns.length > 6 ? (columns.length - 6) * 0.08 : 0;
  const columnCountFit = headerColumnHint
    ? Math.max(0, 1 - Math.abs(columns.length - headerColumnHint) / Math.max(2, headerColumnHint))
    : Math.min(1, columns.length / 4);

  return (
    occupiedRatio * 0.24 +
    numericConsistency * 0.22 +
    boundarySupport * 0.20 +
    columnCountFit * 0.18 +
    (1 - emptyPenalty) * 0.10 -
    widePenalty * 0.04 -
    cutPenalty * 0.45 -
    columnCountPenalty
  );
}

function chooseAdaptiveColumns(lines, candidates, left, right, fontSize) {
  if (!candidates.length) return null;

  const top = candidates.slice(0, Math.min(10, candidates.length));
  const minDistance = Math.max(10, fontSize * 1.8);
  let best = null;
  const limit = 1 << top.length;

  for (let mask = 1; mask < limit; mask++) {
    const selected = [];
    for (let i = 0; i < top.length; i++) {
      if (mask & (1 << i)) selected.push(top[i]);
    }

    if (selected.length > ADAPTIVE_MAX_COLUMNS - 1) continue;
    selected.sort((a, b) => a.x - b.x);

    let valid = true;
    for (let i = 1; i < selected.length; i++) {
      if (selected[i].x - selected[i - 1].x < minDistance) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    const boundaries = selected.map(item => item.x);
    const columns = boundariesToRanges([left - 1, ...boundaries, right + 1]);
    const score = scoreAdaptiveColumns(lines, columns, selected);
    if (!Number.isFinite(score)) continue;

    const candidate = { columns, boundaries, score, candidates: selected };
    if (!best || score > best.score) best = candidate;
  }

  if (!best) return null;

  // Normalisasi confidence ke 0..1. Score internal berada kira-kira di
  // rentang 0..1 setelah seluruh komponen digabung.
  const confidence = Math.max(0, Math.min(1, best.score));
  return { ...best, confidence };
}

export function detectAdaptiveColumns(lines, options = {}) {
  const usable = lines.filter(line => line.words.length);
  if (usable.length < 2) return null;

  const words = usable.flatMap(line => line.words);
  if (words.length < 4) return null;

  const left = Math.min(...words.map(word => word.x0));
  const right = Math.max(...words.map(word => word.x1));
  if (!(right > left)) return null;

  const fontSize = typicalFontSize(words);
  const candidates = adaptiveCandidates(usable, left, right, fontSize);
  const result = chooseAdaptiveColumns(usable, candidates, left, right, fontSize);

  if (!result) return null;

  const minimumConfidence = options.adaptiveMinConfidence ?? 0.42;
  if (result.confidence < minimumConfidence) return null;

  return result;
}



/* ---------------------------------------------------------
   Adaptive V1.3 — header + first-data-row gap recovery

   Ada PDF yang border-nya sebenarnya ada, tetapi operator vector-nya
   tidak selalu berhasil dibaca konsisten oleh pdf.js. Untuk kasus itu,
   jangan kembali ke satu kolom. Gunakan struktur header + gap terbesar
   pada baris data pertama sebagai recovery geometry.
*/

const HEADER_TOKENS = new Set([
  "NO", "NO.", "BOSCH", "PN", "PRODUCT", "PRODUCTS", "DESCRIPTION",
  "DESKRIPSI", "PACK", "HET", "ECERAN", "QTY", "SIZE", "KEMASAN",
  "APPLICATION", "APLIKASI", "TYPE", "ITEM", "STATUS", "DEBIT",
  "VOLT", "PIN", "AMPERE", "NEW", "REPLACE", "BOSCH PN",
  "<=10", "10-49", "11-49", "50-99", ">=30", ">=50", ">=75",
  ">=100", ">=150", ">=1", ">=5", ">=1 DUS", ">=5 DUS",
  "100", "200"
]);

function headerTokenScore(text) {
  const t = String(text || "").trim().toUpperCase();
  if (!t) return 0;
  if (HEADER_TOKENS.has(t)) return 3;
  if (/^(?:<=|>=)\d+(?:-\d+)?(?:\s*DUS)?$/.test(t)) return 3;
  if (/^\d+(?:-\d+)?$/.test(t)) return 2;
  if (/^(NO|PN|HET|QTY|ITEM|TYPE|STATUS|APPLICATION|DESCRIPTION|PRODUCT)/.test(t)) return 2;
  return 0;
}

function groupHeaderWords(words, gap = 8) {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const word of sorted) {
    if (!groups.length || word.x0 - groups[groups.length - 1].x1 > gap) {
      groups.push({ x0: word.x0, x1: word.x1, words: [word] });
    } else {
      const g = groups[groups.length - 1];
      g.x1 = Math.max(g.x1, word.x1);
      g.words.push(word);
    }
  }
  return groups;
}

function detectHeaderGroups(pageContent) {
  const words = pageContent.words || [];
  if (words.length < 6) return null;

  const height = pageContent.height || 842;
  const topWords = words.filter(w => w.top < height * 0.38);
  let best = null;

  for (const seed of topWords) {
    const cy = (seed.top + seed.bottom) / 2;
    const band = topWords.filter(w => {
      const wy = (w.top + w.bottom) / 2;
      return Math.abs(wy - cy) <= 14;
    });
    if (band.length < 4) continue;

    const tokenScore = band.reduce((sum, w) => sum + headerTokenScore(w.text), 0);
    if (tokenScore < 8) continue;

    // Gunakan token header untuk membentuk group. Word data yang kebetulan
    // berada dekat header (mis. EC12C pada tabel Horn) jangan ikut menggeser
    // boundary header. Token lanjutan seperti "Europe / EV / Car" boleh tidak
    // ikut; group tetap ditentukan oleh token inti di cell tersebut.
    const headerWords = band.filter(w => headerTokenScore(w.text) > 0);
    const groupingWords = headerWords.length >= 4 ? headerWords : band;
    const groups = groupHeaderWords(groupingWords, 8);
    if (groups.length < 3 || groups.length > 14) continue;

    const span = Math.max(...groupingWords.map(w => w.x1)) - Math.min(...groupingWords.map(w => w.x0));
    if (span < (pageContent.width || 595) * 0.45) continue;

    // Penalize title/notes bands and reward compact table-header structure.
    const text = band.map(w => String(w.text || "").toUpperCase()).join(" ");
    const titlePenalty = /PRICE\s+LIST|HARGA\s+INCLUDE|PERIODE/.test(text) ? 8 : 0;
    const score = tokenScore + groups.length * 3 + Math.min(span / (pageContent.width || 595), 1) * 5 - titlePenalty;

    if (!best || score > best.score) {
      best = { groups, score, y0: Math.min(...band.map(w => w.top)), y1: Math.max(...band.map(w => w.bottom)) };
    }
  }

  return best;
}

function numericLikeForLayout(text) {
  const t = String(text || "").trim().replace(/\s+/g, "");
  if (!t) return false;
  return /^(?:[A-Za-z]?\d+(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)$/.test(t);
}

function detectFirstDataBand(pageContent, header) {
  const words = pageContent.words || [];
  if (!header) return null;

  const after = words.filter(w => w.top > header.y1 + 3 && w.top < (pageContent.height || 842) * 0.85);
  if (after.length < 4) return null;

  const rows = new Map();
  for (const w of after) {
    const cy = Math.round(((w.top + w.bottom) / 2) * 2) / 2;
    if (!rows.has(cy)) rows.set(cy, []);
    rows.get(cy).push(w);
  }

  const candidates = [...rows.entries()]
    .filter(([, row]) => row.filter(w => numericLikeForLayout(w.text)).length >= 3)
    .filter(([, row]) => Math.max(...row.map(w => w.x1)) > pageContent.width * 0.62)
    .sort((a, b) => a[0] - b[0]);

  if (!candidates.length) return null;

  const firstY = candidates[0][0];
  const nextY = candidates.find(([y]) => y > firstY + 4)?.[0] ?? (firstY + 40);
  const top = Math.max(header.y1 - 2, firstY - 24);
  const bottom = nextY - 3;
  const rowWords = words.filter(w => {
    const cy = (w.top + w.bottom) / 2;
    return cy >= top && cy <= bottom;
  });

  if (rowWords.length < 4) return null;
  return { top, bottom, words: rowWords, y: firstY };
}

function detectRowGapRecovery(pageContent, options = {}) {
  const header = detectHeaderGroups(pageContent);
  if (!header) return null;

  const expectedColumns = header.groups.length;
  if (expectedColumns < 3 || expectedColumns > 14) return null;

  const first = detectFirstDataBand(pageContent, header);
  if (!first) return null;

  const spans = first.words
    .map(w => ({ x0: w.x0, x1: w.x1, text: w.text }))
    .sort((a, b) => a.x0 - b.x0);

  const merged = [];
  for (const span of spans) {
    if (!merged.length || span.x0 > merged[merged.length - 1].x1 + 1.5) {
      merged.push({ x0: span.x0, x1: span.x1 });
    } else {
      merged[merged.length - 1].x1 = Math.max(merged[merged.length - 1].x1, span.x1);
    }
  }

  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].x0 - merged[i - 1].x1;
    if (gap >= 6) gaps.push({ gap, x: (merged[i - 1].x1 + merged[i].x0) / 2 });
  }

  if (gaps.length < expectedColumns - 1) return null;

  const selected = gaps
    .sort((a, b) => b.gap - a.gap)
    .slice(0, expectedColumns - 1)
    .sort((a, b) => a.x - b.x);

  const left = Math.min(...header.groups.map(g => g.x0), ...first.words.map(w => w.x0));
  const right = Math.max(...header.groups.map(g => g.x1), ...first.words.map(w => w.x1));
  const columnLines = [left, ...selected.map(g => g.x), right];

  // Header groups provide a second check: each internal boundary should
  // lie between the corresponding header groups, not inside a header cell.
  const headerCenters = header.groups.map(g => (g.x0 + g.x1) / 2);
  let headerFit = 0;
  for (let i = 1; i < columnLines.length - 1; i++) {
    const boundary = columnLines[i];
    const a = headerCenters[i - 1];
    const b = headerCenters[i];
    if (boundary > a && boundary < b) headerFit++;
  }

  const fitRatio = headerFit / Math.max(1, columnLines.length - 2);
  if (fitRatio < 0.75) return null;

  const columns = boundariesToRanges(columnLines);
  const confidence = Math.min(0.97, 0.68 + fitRatio * 0.18 + Math.min(0.12, (selected.reduce((s, g) => s + g.gap, 0) / selected.length) / 120));

  return {
    columns,
    columnLines,
    rowSeparators: null,
    firstDataBand: first,
    header,
    confidence
  };
}

export function analyzePage(pageContent, options = {}) {
  const lines = clusterTextLines(pageContent.words);

  if (!lines.length) {
    return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
  }

  const forced = options.mode && options.mode !== "auto" ? options.mode : null;
  const fontSize = typicalFontSize(pageContent.words);

  const grid = forced === "stream" ? null : findGrid(pageContent, fontSize);
  const rulingGrid = forced === "stream" ? null : findVerticalGrid(pageContent, fontSize);

  // Jika dua detektor menemukan grid, pilih struktur yang lebih informatif.
  // Fallback vertikal sering menemukan satu boundary yang terputus yang
  // terlewat oleh findGrid, sehingga jumlah kolomnya bisa lebih lengkap.
  let verticalGrid = grid || rulingGrid;
  if (grid && rulingGrid) {
    const moreColumns = rulingGrid.columnLines.length > grid.columnLines.length;
    const similarConfidence = rulingGrid.confidence >= (grid.confidence || 0) - 0.12;
    if (moreColumns && similarConfidence) verticalGrid = rulingGrid;
  }

  if (verticalGrid && (forced === "lattice" || !forced) && verticalGrid.columnLines.length >= 3 && verticalGrid.rowLines.length >= 3) {
    return {
      mode: "lattice",
      lines,
      columns: boundariesToRanges(verticalGrid.columnLines),
      rowSeparators: verticalGrid.rowLines,
      grid: verticalGrid,
      confidence: verticalGrid.confidence
    };
  }

  const boundaries = detectColumnBoundaries(lines, options);
  const adaptive = detectAdaptiveColumns(lines, options);
  const rowGap = detectRowGapRecovery(pageContent, options);

  // Bila adaptive berbasis whitespace menghasilkan jumlah kolom yang jauh
  // lebih sedikit daripada struktur header + first-row gap, pilih recovery
  // tersebut. Ini adalah kasus khas PDF Bosch: teks masih punya X/Y yang
  // benar, tetapi border/operator vector tidak terbaca konsisten.
  const rowGapPreferred = rowGap && (
    !adaptive ||
    rowGap.columns.length > adaptive.columns.length + 1 ||
    rowGap.confidence > adaptive.confidence + 0.05
  );

  // Auto: pakai stream lama bila cukup baik. Bila gagal atau adaptive jauh
  // lebih yakin, adaptive mengambil alih. Ini menjaga kompatibilitas layout
  // lama sambil memperbaiki PDF yang koordinatnya tidak konsisten.
  if (forced === "adaptive") {
    // Adaptive harus tetap memanfaatkan informasi paling kuat yang tersedia.
    // Jika PDF memiliki grid/border yang valid, gunakan grid tersebut sebagai
    // kandidat struktur utama. Ini mencegah tabel 8 kolom seperti
    // "No | Pelumas | Qty | X | Size | Kemasan | Harga Botol | Harga Dos/End User"
    // runtuh menjadi 3-4 kolom hanya karena gap teks tidak konsisten.
    if (verticalGrid && verticalGrid.columnLines.length >= 3 && verticalGrid.rowLines.length >= 3 && verticalGrid.confidence >= 0.55) {
      return {
        mode: "adaptive-lattice",
        lines,
        columns: boundariesToRanges(verticalGrid.columnLines),
        rowSeparators: verticalGrid.rowLines,
        grid: verticalGrid,
        confidence: verticalGrid.confidence,
        adaptive: adaptive || null
      };
    }

    // Garis vertikal kuat tetapi horizontal tidak cukup: kolom tetap valid,
    // baris dibangun dari text lines + anchor column. Ini menangani tabel
    // dengan description multi-line seperti Horn/Oil Filter/Solar Filter.
    if (verticalGrid && verticalGrid.columnLines.length >= 3 && verticalGrid.confidence >= 0.55) {
      return {
        mode: "ruling-stream",
        lines,
        columns: verticalGrid.columns,
        rowSeparators: null,
        grid: verticalGrid,
        confidence: verticalGrid.confidence,
        adaptive: adaptive || null
      };
    }

    if (rowGapPreferred) {
      return {
        mode: "adaptive-rowgap",
        lines,
        columns: rowGap.columns,
        rowSeparators: null,
        confidence: rowGap.confidence,
        adaptive: rowGap
      };
    }

    if (adaptive) {
      return {
        mode: "adaptive",
        lines,
        columns: adaptive.columns,
        rowSeparators: null,
        confidence: adaptive.confidence,
        adaptive
      };
    }

    return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
  }

  if (verticalGrid && verticalGrid.rowLines.length >= 3 && forced !== "stream") {
    const hybridColumns = verticalGrid.columns?.length
      ? verticalGrid.columns
      : (boundaries ? boundariesToRanges(boundaries) : adaptive?.columns);

    if (hybridColumns?.length) {
      return {
        mode: "hybrid",
        lines,
        columns: hybridColumns,
        rowSeparators: grid.rowLines,
        grid: verticalGrid,
        confidence: Math.max(verticalGrid.confidence || 0, adaptive?.confidence || 0)
      };
    }
  }

  if (boundaries) {
    if (rowGapPreferred) {
      return {
        mode: "adaptive-rowgap",
        lines,
        columns: rowGap.columns,
        rowSeparators: null,
        confidence: rowGap.confidence,
        adaptive: rowGap
      };
    }

    const streamColumns = boundariesToRanges(boundaries);
    const streamConfidence = scoreAdaptiveColumns(lines, streamColumns, []);

    if (adaptive && adaptive.confidence > streamConfidence + 0.08) {
      return {
        mode: "adaptive",
        lines,
        columns: adaptive.columns,
        rowSeparators: null,
        confidence: adaptive.confidence,
        adaptive
      };
    }

    return {
      mode: "stream",
      lines,
      columns: streamColumns,
      rowSeparators: null,
      confidence: Math.max(0, Math.min(1, streamConfidence)),
      adaptive: adaptive || null
    };
  }

  if (rowGapPreferred) {
    return {
      mode: "adaptive-rowgap",
      lines,
      columns: rowGap.columns,
      rowSeparators: null,
      confidence: rowGap.confidence,
      adaptive: rowGap
    };
  }

  return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
}


/**
 * Fallback grid berbasis garis vertikal.
 *
 * Beberapa PDF mempunyai border vertikal yang sangat jelas, tetapi garis
 * horizontalnya sedikit/terputus (mis. tabel dengan cell description tinggi).
 * Dalam kondisi itu, kolom sebenarnya masih bisa diketahui dari coverage
 * garis vertikal. Baris kemudian dibangun dari text lines.
 */
function findVerticalGrid(pageContent, fontSize) {
  const { rulings, words } = pageContent;
  const vertical = rulings?.vertical || [];
  if (vertical.length < 3 || words.length < 6) return null;

  const textLeft = Math.min(...words.map(w => w.x0));
  const textRight = Math.max(...words.map(w => w.x1));
  if (!(textRight > textLeft)) return null;

  const horizontal = (rulings?.horizontal || [])
    .filter(line => line.x1 - line.x0 >= Math.max(20, fontSize * 1.5));

  let left = textLeft - 2;
  let right = textRight + 2;
  let top = Math.min(...words.map(w => w.top));
  let bottom = Math.max(...words.map(w => w.bottom));

  if (horizontal.length >= 2) {
    left = Math.min(...horizontal.map(l => l.x0));
    right = Math.max(...horizontal.map(l => l.x1));
    top = Math.min(...horizontal.map(l => l.y));
    bottom = Math.max(...horizontal.map(l => l.y));
  }

  const height = Math.max(1, bottom - top);
  const levels = cluster1D(vertical.map(line => line.x), Math.max(3, fontSize * 0.28));
  const candidates = [];

  for (const x of levels) {
    const segments = vertical
      .filter(line => Math.abs(line.x - x) <= Math.max(3, fontSize * 0.28))
      .map(line => ({
        y0: Math.max(top, Math.min(bottom, line.y0)),
        y1: Math.min(bottom, Math.max(top, line.y1))
      }))
      .filter(seg => seg.y1 > seg.y0)
      .sort((a, b) => a.y0 - b.y0);

    let covered = 0;
    let current = null;
    for (const seg of segments) {
      if (!current) {
        current = { ...seg };
        continue;
      }
      if (seg.y0 <= current.y1 + 5) {
        current.y1 = Math.max(current.y1, seg.y1);
      } else {
        covered += current.y1 - current.y0;
        current = { ...seg };
      }
    }
    if (current) covered += current.y1 - current.y0;

    const coverage = covered / height;
    if (coverage >= 0.28) candidates.push({ x, coverage });
  }

  if (candidates.length < 3) return null;

  const columnLines = cluster1D(candidates.map(c => c.x), Math.max(3, fontSize * 0.28));
  if (columnLines.length < 3) return null;

  // Buang garis dekoratif yang berada jauh di luar text/table body.
  const bounded = columnLines.filter(x => x >= left - 6 && x <= right + 6);
  if (bounded.length < 3) return null;

  const columns = boundariesToRanges(bounded);
  const hits = columns.map(() => 0);
  let inside = 0;
  for (const word of words) {
    const cx = (word.x0 + word.x1) / 2;
    const cy = (word.top + word.bottom) / 2;
    if (cx < bounded[0] - 3 || cx > bounded[bounded.length - 1] + 3 || cy < top - 3 || cy > bottom + 3) continue;
    inside++;
    const index = columns.findIndex(c => cx >= c.x0 - 1 && cx <= c.x1 + 1);
    if (index >= 0) hits[index]++;
  }

  const occupancy = hits.filter(Boolean).length / columns.length;
  if (inside / Math.max(1, words.length) < 0.35 || occupancy < 0.55) return null;

  return {
    columnLines: bounded,
    columns,
    rowLines: horizontal.length >= 3 ? cluster1D(horizontal.map(l => l.y), 3) : [],
    bbox: { left: bounded[0], right: bounded[bounded.length - 1], top, bottom },
    confidence: Math.min(1, occupancy * 0.7 + candidates.reduce((s, c) => s + c.coverage, 0) / candidates.length * 0.3)
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

  // Garis vertikal pada PDF nyata sering terpecah menjadi beberapa
  // segment karena ada merge/header/section. Jangan menilai setiap segment
  // secara terpisah. Gabungkan coverage pada X yang sama terlebih dahulu.
  // Contoh Prabawa: garis pemisah NO | PELUMAS terputus di beberapa
  // section, tetapi secara keseluruhan tetap merupakan boundary kolom.
  const rawVertical = rulings.vertical.filter(line =>
    line.y1 - line.y0 >= minVertical &&
    line.x >= left - 4 &&
    line.x <= right + 4
  );

  const verticalLevels = cluster1D(rawVertical.map(line => line.x), 3);
  const verticalCandidates = [];

  for (const x of verticalLevels) {
    const segments = rawVertical
      .filter(line => Math.abs(line.x - x) <= 3)
      .map(line => ({
        y0: Math.max(top, Math.min(bottom, line.y0)),
        y1: Math.min(bottom, Math.max(top, line.y1))
      }))
      .filter(segment => segment.y1 > segment.y0)
      .sort((a, b) => a.y0 - b.y0);

    let covered = 0;
    let current = null;

    for (const segment of segments) {
      if (!current) {
        current = { ...segment };
        continue;
      }

      if (segment.y0 <= current.y1 + 4) {
        current.y1 = Math.max(current.y1, segment.y1);
      } else {
        covered += current.y1 - current.y0;
        current = { ...segment };
      }
    }

    if (current) covered += current.y1 - current.y0;

    const coverage = covered / tableHeight;
    if (coverage >= 0.45) {
      verticalCandidates.push({ x, coverage });
    }
  }

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


function detectNumericRowAnchors(pageContent) {
  const words = pageContent.words || [];
  const width = pageContent.width || 595;
  const rows = new Map();

  for (const word of words) {
    const cy = Math.round(((word.top + word.bottom) / 2) * 2) / 2;
    if (!rows.has(cy)) rows.set(cy, []);
    rows.get(cy).push(word);
  }

  const anchors = [];
  for (const [y, row] of rows) {
    const numeric = row.filter(w => numericLikeForLayout(w.text));
    const right = Math.max(...row.map(w => w.x1));
    if (numeric.length >= 3 && right >= width * 0.62) {
      anchors.push({ y, words: row, numericCount: numeric.length });
    }
  }

  // Satukan anchor yang sangat dekat (mis. beberapa angka pada satu row
  // tetapi PDF membaginya ke baseline yang berbeda).
  anchors.sort((a, b) => a.y - b.y);
  const merged = [];
  for (const a of anchors) {
    const prev = merged[merged.length - 1];
    if (prev && a.y - prev.y <= 3) {
      prev.y = (prev.y + a.y) / 2;
      prev.numericCount = Math.max(prev.numericCount, a.numericCount);
    } else {
      merged.push({ ...a });
    }
  }
  return merged;
}

function buildAdaptiveRowGapRows(pageContent, layout) {
  const anchors = detectNumericRowAnchors(pageContent);
  if (anchors.length < 1) return buildStreamRows(pageContent, layout, { joinWrapped: true });

  const headerBottom = layout.adaptive?.header?.y1 ?? Math.max(0, anchors[0].y - 25);
  const rows = [];

  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i].y;
    const previous = i > 0 ? anchors[i - 1].y : null;
    const next = i + 1 < anchors.length ? anchors[i + 1].y : null;

    let top;
    if (previous == null) {
      top = Math.max(0, Math.min(headerBottom + 1, current - 24));
    } else {
      top = (previous + current) / 2;
    }

    let bottom;
    if (next == null) {
      bottom = Math.min(pageContent.height, current + 24);
    } else {
      bottom = (current + next) / 2;
    }

    const words = pageContent.words.filter(word => {
      const cy = (word.top + word.bottom) / 2;
      return cy >= top && cy < bottom;
    });

    if (!words.length) continue;

    const cells = assignToColumns(words, layout.columns);
    if (!cells.some(cell => cell.text)) continue;

    rows.push(makeRow(cells, top, bottom, words));
  }

  return rows;
}

export function buildRows(pageContent, layout, options = {}) {
  if (layout.mode === "none" || !layout.columns) return [];

  if (layout.mode === "lattice" || layout.mode === "adaptive-lattice") {
    return buildLatticeRows(pageContent, layout);
  }

  if (layout.mode === "hybrid") {
    return buildBandedRows(pageContent, layout);
  }

  if (layout.mode === "adaptive-rowgap") {
    return buildAdaptiveRowGapRows(pageContent, layout);
  }

  if (layout.mode === "ruling-stream") {
    return buildStreamRows(pageContent, layout, options);
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
