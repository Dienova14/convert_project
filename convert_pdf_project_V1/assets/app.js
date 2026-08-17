import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);

const dropzone = $("dropzone");
const input = $("fileInput");
const status = $("status");
const workspace = $("workspace");
const previewWrap = $("previewWrap");

let currentFile = null;
let extracted = { headers: [], rows: [] };

const HEADER_ALIASES = {
  no: ["no", "no.", "number", "#", "item no", "item"],
  category: ["category", "group", "product group", "classification", "type"],
  code: ["code", "item code", "product code", "sku", "part no", "part number", "catalog no"],
  description: ["description", "product", "product name", "item name", "name", "details", "specification"],
  brand: ["brand", "maker", "manufacturer"],
  price: ["price", "unit price", "selling price", "amount", "rate", "price 2026"],
  qty: ["qty", "quantity", "quantity/unit"],
  unit: ["unit", "uom", "unit of measure"],
  note: ["note", "notes", "remark", "remarks"],
  date: ["date", "effective date"],
  total: ["total", "total price", "subtotal"]
};

const COMMON_HEADER_WORDS = new Set(
  Object.values(HEADER_ALIASES).flat().map(normalizeHeader)
);

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()[\]{},:;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setStatus(message, visible = true) {
  status.textContent = message;
  status.classList.toggle("hidden", !visible);
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function selectFile(file) {
  if (!file) return;

  const isPdf =
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    setStatus("Please select a PDF file.");
    return;
  }

  if (file.size > 20 * 1024 * 1024) {
    setStatus("File is larger than 20 MB.");
    return;
  }

  currentFile = file;
  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `· ${formatBytes(file.size)}`;
  workspace.classList.remove("hidden");
  previewWrap.classList.add("hidden");
  setStatus("", false);
}

input.addEventListener("change", e => selectFile(e.target.files[0]));

["dragenter", "dragover"].forEach(name => {
  dropzone.addEventListener(name, e => {
    e.preventDefault();
    dropzone.classList.add("drag");
  });
});

["dragleave", "drop"].forEach(name => {
  dropzone.addEventListener(name, e => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  });
});

dropzone.addEventListener("drop", e => selectFile(e.dataTransfer.files[0]));

dropzone.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    input.click();
  }
});

$("removeBtn").addEventListener("click", () => {
  currentFile = null;
  input.value = "";
  workspace.classList.add("hidden");
  previewWrap.classList.add("hidden");
  setStatus("", false);
});

function groupIntoLines(items, tolerance = 3) {
  const lines = [];

  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) > tolerance) return b.y - a.y;
    return a.x - b.x;
  });

  for (const item of sorted) {
    let line = lines.find(l => Math.abs(l.y - item.y) <= tolerance);

    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }

    line.items.push(item);
  }

  lines.forEach(line => line.items.sort((a, b) => a.x - b.x));
  lines.sort((a, b) => b.y - a.y);

  return lines;
}

function headerScore(line) {
  const texts = line.items.map(item => normalizeHeader(item.text));
  let score = 0;

  for (const text of texts) {
    if (COMMON_HEADER_WORDS.has(text)) score += 4;

    if (
      Object.values(HEADER_ALIASES).some(
        aliases => aliases.includes(text)
      )
    ) {
      score += 2;
    }
  }

  if (line.items.length >= 3) score += 2;
  if (line.items.length >= 5) score += 2;

  return score;
}

function detectHeaderLine(lines) {
  let best = null;
  let bestScore = 0;

  for (const line of lines) {
    const score = headerScore(line);

    // Headers normally appear in the upper half of a page.
    const maxY = Math.max(...lines.map(l => l.y), 1);

    if (line.y < maxY * 0.35) continue;

    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }

  return bestScore >= 6 ? best : null;
}

function headerLabel(item) {
  const raw = normalizeText(item.text);
  const normalized = normalizeHeader(raw);

  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return raw;
  }

  return raw;
}

function buildColumns(headerLine) {
  /*
   * Each header item becomes a column anchor.
   * If a PDF has a multi-word header, PDF.js commonly returns it as one
   * text item; if it returns several adjacent items, they remain separate
   * columns only when their X positions indicate separate cells.
   */
  const anchors = [];

  for (const item of headerLine.items) {
    const text = normalizeText(item.text);
    if (!text) continue;

    const center = item.x + item.width / 2;

    // Ignore tiny duplicate fragments that overlap an existing anchor.
    const existing = anchors.find(
      a => Math.abs(a.x - center) < Math.max(5, item.width * 0.25)
    );

    if (existing) {
      existing.label = `${existing.label} ${text}`.trim();
    } else {
      anchors.push({
        x: center,
        label: headerLabel(item)
      });
    }
  }

  anchors.sort((a, b) => a.x - b.x);

  if (anchors.length < 2) return null;

  const boundaries = [0];

  for (let i = 0; i < anchors.length - 1; i++) {
    boundaries.push((anchors[i].x + anchors[i + 1].x) / 2);
  }

  boundaries.push(Infinity);

  return { anchors, boundaries };
}

function columnIndex(x, columns) {
  for (let i = 0; i < columns.boundaries.length - 1; i++) {
    if (x >= columns.boundaries[i] && x < columns.boundaries[i + 1]) {
      return i;
    }
  }

  return columns.anchors.length - 1;
}

function lineToRow(line, columns) {
  const cells = Array.from(
    { length: columns.anchors.length },
    () => []
  );

  for (const item of line.items) {
    const center = item.x + item.width / 2;
    const index = columnIndex(center, columns);

    if (index >= 0 && index < cells.length) {
      cells[index].push(item.text);
    }
  }

  return cells.map(cell => normalizeText(cell.join(" ")));
}

function isNumeric(value) {
  return /^\s*\d+(?:[.,]\d+)?\s*$/.test(value || "");
}

function looksLikeFooter(text) {
  const value = normalizeHeader(text);

  return (
    value.includes("page ") ||
    value.includes("printed ") ||
    value.includes("generated ") ||
    value.includes("terms and conditions") ||
    value.includes("prices are subject")
  );
}

function detectDataRows(lines, headerLine, columns) {
  const rows = [];
  const orphanLines = [];

  for (const line of lines) {
    // Everything above/at the header is outside the table.
    if (line.y >= headerLine.y - 2) continue;

    if (looksLikeFooter(line.items.map(i => i.text).join(" "))) continue;

    const cells = lineToRow(line, columns);
    const nonEmpty = cells.filter(Boolean).length;

    if (nonEmpty < 1) continue;

    const firstHeader = normalizeHeader(columns.anchors[0].label);
    const hasNumberColumn =
      ["no", "no.", "number", "#", "item no", "item"].includes(firstHeader);

    if (hasNumberColumn) {
      /*
       * A real data row has a numeric value in the first column.
       * Lines without a number are kept separately because they can be
       * vertically-merged cell labels.
       */
      if (isNumeric(cells[0])) {
        rows.push({
          y: line.y,
          cells,
          sourceLine: line
        });
      } else {
        orphanLines.push({
          y: line.y,
          cells,
          sourceLine: line
        });
      }
    } else {
      /*
       * For tables without a No column, accept populated lines as rows.
       * A later cleanup step can remove repeated headers.
       */
      if (nonEmpty >= 2) {
        rows.push({
          y: line.y,
          cells,
          sourceLine: line
        });
      } else {
        orphanLines.push({
          y: line.y,
          cells,
          sourceLine: line
        });
      }
    }
  }

  return { rows, orphanLines };
}

function findHeaderColumnIndex(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const value = normalizeHeader(headers[i]);

    if (aliases.some(alias => normalizeHeader(alias) === value)) {
      return i;
    }
  }

  return -1;
}

function getMergedCellCandidates(orphanLines, columns, headers) {
  /*
   * Generic merged-cell detection:
   *
   * A merged cell often does not share the same Y coordinate as a product
   * row. Therefore the old algorithm discarded it because it had no "No".
   *
   * Here we retain those orphan lines and inspect which table column they
   * belong to. We can then use their Y position to determine which rows
   * belong to the merged value.
   */
  const candidates = [];

  const semanticColumns = [
    {
      index: findHeaderColumnIndex(headers, HEADER_ALIASES.category),
      kind: "category"
    },
    {
      index: findHeaderColumnIndex(headers, HEADER_ALIASES.brand),
      kind: "brand"
    },
    {
      index: findHeaderColumnIndex(headers, HEADER_ALIASES.unit),
      kind: "unit"
    },
    {
      index: findHeaderColumnIndex(headers, HEADER_ALIASES.note),
      kind: "note"
    }
  ].filter(x => x.index >= 0);

  for (const orphan of orphanLines) {
    for (const semantic of semanticColumns) {
      const value = orphan.cells[semantic.index];

      if (!value) continue;

      /*
       * Ignore tiny fragments that are likely page/table noise.
       * Do not impose product-specific keywords here.
       */
      if (value.length < 2) continue;

      candidates.push({
        y: orphan.y,
        column: semantic.index,
        kind: semantic.kind,
        value
      });
    }
  }

  return candidates;
}

function assignMergedCells(rows, orphanLines, headers) {
  if (!rows.length || !orphanLines.length) return rows;

  const candidates = getMergedCellCandidates(
    orphanLines,
    null,
    headers
  );

  if (!candidates.length) return rows;

  /*
   * Rows are kept in PDF reading order: highest Y first.
   * For every candidate, find the nearest data row in the same page.
   * This is particularly important for a vertically centered merged cell.
   */
  const used = new Set();

  for (const candidate of candidates) {
    const possible = rows
      .map((row, index) => ({
        row,
        index,
        distance: Math.abs(row.y - candidate.y)
      }))
      .sort((a, b) => a.distance - b.distance);

    const nearest = possible[0];

    if (!nearest) continue;

    /*
     * Do not overwrite a value that is already present.
     * This means normal table cells always win over merged-cell inference.
     */
    if (!nearest.row.cells[candidate.column]) {
      nearest.row.cells[candidate.column] = candidate.value;
      used.add(`${candidate.column}:${candidate.y}`);
    }
  }

  /*
   * Now propagate the inferred merged value both upward and downward.
   *
   * Example:
   *
   * row 1: [1, "", ...]
   * row 2: [2, "", ...]
   * row 3: [3, "Ashless Filter Paper no. 388", ...]
   * row 4: [4, "", ...]
   *
   * becomes:
   *
   * row 1: Group A
   * row 2: Group A
   * row 3: Group A
   * row 4: Group A
   *
   * This is based on the vertical position of the next merged-cell
   * candidate, not on a hard-coded product name.
   */
  const candidateColumns = [
    ...new Set(candidates.map(c => c.column))
  ];

  for (const column of candidateColumns) {
    const columnCandidates = candidates
      .filter(c => c.column === column)
      .sort((a, b) => b.y - a.y);

    if (!columnCandidates.length) continue;

    for (let i = 0; i < columnCandidates.length; i++) {
      const current = columnCandidates[i];
      const previous = columnCandidates[i - 1];
      const next = columnCandidates[i + 1];

      const upperBoundary = previous
        ? (previous.y + current.y) / 2
        : Infinity;

      const lowerBoundary = next
        ? (current.y + next.y) / 2
        : -Infinity;

      for (const row of rows) {
        if (
          row.y <= upperBoundary &&
          row.y >= lowerBoundary &&
          !row.cells[column]
        ) {
          row.cells[column] = current.value;
        }
      }
    }
  }

  return rows;
}

function applyGenericFillDown(rows, headers) {
  /*
   * Last fallback for ordinary vertical merged cells.
   *
   * Only sparse text columns are considered. Numeric columns are excluded.
   * This makes the behavior useful across different table types without
   * hard-coding "Category".
   */
  if (rows.length < 2) return rows;

  const width = headers.length;

  for (let col = 0; col < width; col++) {
    const values = rows.map(row => row.cells[col] || "");
    const nonEmpty = values.filter(Boolean);

    if (!nonEmpty.length || nonEmpty.length === values.length) continue;

    const numericRatio =
      nonEmpty.filter(isNumeric).length / nonEmpty.length;

    if (numericRatio > 0.7) continue;

    /*
     * A column is considered merge-like when:
     * - it contains repeated values, or
     * - it has enough blanks between populated cells.
     */
    const unique = new Set(nonEmpty.map(normalizeHeader));
    const repeatedValue = unique.size < nonEmpty.length;
    const blankRatio = (values.length - nonEmpty.length) / values.length;

    if (!repeatedValue && blankRatio < 0.15) continue;

    let previous = "";

    for (const row of rows) {
      if (row.cells[col]) {
        previous = row.cells[col];
      } else if (previous) {
        row.cells[col] = previous;
      }
    }
  }

  return rows;
}

function applyMergedCellHeuristic(rows) {
  if (!rows || rows.length < 2) return rows;

  const width = rows[0].cells.length;

  /*
   * Generic merged-cell handling:
   *
   * A vertical merged cell often appears in PDF text extraction as:
   *
   *   row 1: Category = "Group A"
   *   row 2: Category = ""
   *   row 3: Category = ""
   *   row 4: Category = "Group B"
   *
   * Fill blank cells with the previous non-empty value, but only for
   * columns where this pattern actually occurs.
   */
  for (let col = 0; col < width; col++) {
    let nonEmpty = 0;
    let blanks = 0;

    for (const row of rows) {
      if (normalizeText(row.cells[col])) {
        nonEmpty++;
      } else {
        blanks++;
      }
    }

    if (nonEmpty === 0 || blanks === 0) continue;

    const sample = rows
      .map(row => normalizeText(row.cells[col]))
      .filter(Boolean)
      .slice(0, 30);

    if (!sample.length) continue;

    // Don't fill columns that are predominantly numeric.
    const numericRatio =
      sample.filter(isNumeric).length / sample.length;

    if (numericRatio > 0.7) continue;

    let previous = "";

    for (const row of rows) {
      const value = normalizeText(row.cells[col]);

      if (value) {
        previous = value;
      } else if (previous) {
        row.cells[col] = previous;
      }
    }
  }

  return rows;
}

async function extractPage(page, pageNumber) {
  const content = await page.getTextContent({
    disableCombineTextItems: true
  });

  const items = content.items
    .filter(item => item.str && item.str.trim())
    .map(item => ({
      text: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: item.height || 0
    }));

  const lines = groupIntoLines(items);
  const headerLine = detectHeaderLine(lines);

  if (!headerLine) {
    return {
      page: pageNumber,
      headers: [],
      rows: [],
      detected: false
    };
  }

  const columns = buildColumns(headerLine);

  if (!columns) {
    return {
      page: pageNumber,
      headers: [],
      rows: [],
      detected: false
    };
  }

  const detected = detectDataRows(lines, headerLine, columns);
  const headers = columns.anchors.map(a => a.label);

  // Recover vertically merged cells that have no "No" value of their own.
  assignMergedCells(detected.rows, detected.orphanLines, headers);

  return {
    page: pageNumber,
    headers,
    rows: detected.rows,
    detected: true
  };
}

function looksLikeRepeatedHeader(row, headers) {
  const normalized = row.map(normalizeHeader);

  let matches = 0;

  for (let i = 0; i < headers.length; i++) {
    const a = normalized[i];
    const b = normalizeHeader(headers[i]);

    if (a && b && (a === b || a.includes(b) || b.includes(a))) {
      matches++;
    }
  }

  // Repeated headers normally contain at least half of the detected
  // column names. Requiring two matches avoids false positives.
  return matches >= Math.max(2, Math.ceil(headers.length / 2));
}

function combinePages(pageResults) {
  const valid = pageResults.filter(p => p.detected && p.rows.length);

  if (!valid.length) {
    throw new Error(
      "No table was detected. Make sure the PDF contains selectable text and a visible table header."
    );
  }

  /*
   * Use the first detected header as the common schema.
   * For repeated headers on later pages, data rows are kept and headers are
   * ignored.
   */
  const headers = valid[0].headers;
  const rows = [];

  for (const page of valid) {
    for (const row of page.rows) {
      const cells = Array.from(
        { length: headers.length },
        (_, i) => row.cells[i] || ""
      );

      if (looksLikeRepeatedHeader(cells, headers)) continue;

      rows.push({
        page: page.page,
        y: row.y,
        cells
      });
    }
  }

  // Preserve PDF reading order.
  rows.sort((a, b) => a.page - b.page || b.y - a.y);

  return {
    headers,
    rows
  };
}

function renderPreview(headers, rows) {
  const table = $("previewTable");
  table.innerHTML = "";

  const head = document.createElement("tr");

  headers.forEach(header => {
    const th = document.createElement("th");
    th.textContent = header;
    head.appendChild(th);
  });

  table.appendChild(head);

  rows.slice(0, 300).forEach(row => {
    const tr = document.createElement("tr");

    headers.forEach((_, index) => {
      const td = document.createElement("td");
      td.textContent = row.cells[index] || "";
      tr.appendChild(td);
    });

    table.appendChild(tr);
  });

  $("rowCount").textContent =
    `${rows.length} rows · previewing up to 300`;
}

$("extractBtn").addEventListener("click", async () => {
  if (!currentFile) return;

  const button = $("extractBtn");
  button.disabled = true;
  button.textContent = "Extracting...";
  previewWrap.classList.add("hidden");

  try {
    const buffer = await currentFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    const total =
      $("pageMode").value === "first" ? 1 : pdf.numPages;

    const pageResults = [];

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      setStatus(`Reading page ${pageNumber} of ${total}...`);

      const page = await pdf.getPage(pageNumber);
      pageResults.push(await extractPage(page, pageNumber));
    }

    extracted = combinePages(pageResults);

    if ($("mergeMode").value === "auto") {
      applyMergedCellHeuristic(extracted.rows);
    }

    renderPreview(extracted.headers, extracted.rows);

    previewWrap.classList.remove("hidden");
    setStatus(
      `Completed. ${extracted.rows.length} table rows detected from ${pageResults.filter(p => p.detected).length} page(s).`
    );
  } catch (error) {
    console.error(error);
    setStatus(
      error.message ||
      "Could not detect a table in this PDF."
    );
    previewWrap.classList.add("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Extract & Preview";
  }
});

$("downloadBtn").addEventListener("click", () => {
  if (!extracted.rows.length) return;

  const data = [
    extracted.headers,
    ...extracted.rows.map(row => row.cells)
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(data);

  worksheet["!cols"] = extracted.headers.map((header, index) => {
    let max = String(header || "").length;

    for (const row of extracted.rows.slice(0, 500)) {
      max = Math.max(
        max,
        String(row.cells[index] || "").length
      );
    }

    return {
      wch: Math.min(Math.max(max + 2, 10), 50)
    };
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Table");

  const baseName = currentFile.name.replace(/\.pdf$/i, "");
  XLSX.writeFile(workbook, `${baseName}.xlsx`);
});
