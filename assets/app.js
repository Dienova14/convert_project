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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

input.addEventListener("change", e => {
  selectFile(e.target.files[0]);
});

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

dropzone.addEventListener("drop", e => {
  selectFile(e.dataTransfer.files[0]);
});

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


/* =========================================================
   PDF TEXT / LINE EXTRACTION
   ========================================================= */

function groupIntoLines(items, tolerance = 3) {
  const lines = [];

  const sorted = [...items].sort((a, b) => {
    if (Math.abs(a.y - b.y) > tolerance) {
      return b.y - a.y;
    }

    return a.x - b.x;
  });

  for (const item of sorted) {
    let line = lines.find(
      l => Math.abs(l.y - item.y) <= tolerance
    );

    if (!line) {
      line = {
        y: item.y,
        items: []
      };

      lines.push(line);
    }

    line.items.push(item);
  }

  lines.forEach(line => {
    line.items.sort((a, b) => a.x - b.x);
  });

  lines.sort((a, b) => b.y - a.y);

  return lines;
}


/* =========================================================
   PURE TABLE DETECTION
   ========================================================= */

/*
 * Tidak ada:
 * - HEADER_ALIASES
 * - header detection
 * - semantic detection
 * - AI
 *
 * Struktur tabel ditentukan berdasarkan posisi X/Y.
 */

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}


/*
 * Cari posisi awal kolom berdasarkan X position.
 *
 * Contoh:
 *
 * 50     180        400       520
 * |       |          |         |
 * ID    Product     Qty      Price
 *
 * Kita tidak peduli nama masing-masing kolom.
 */
function detectColumnAnchors(lines) {
  const items = lines.flatMap(line =>
    line.items.map(item => ({
      ...item,
      y: line.y,
      center: item.x + item.width / 2
    }))
  );

  if (items.length < 2) {
    return [];
  }

  const xs = items
    .map(item => item.x)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (xs.length < 2) {
    return [];
  }

  const gaps = [];

  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];

    if (gap > 0) {
      gaps.push(gap);
    }
  }

  const typicalGap = median(
    gaps.filter(g => g < 120)
  );

  /*
   * Tolerance untuk menganggap dua X position
   * berada pada kolom yang sama.
   */
  const tolerance = Math.max(
    8,
    Math.min(
      25,
      typicalGap * 0.35 || 12
    )
  );

  const clusters = [];

  for (const item of items) {
    let cluster = clusters.find(
      c => Math.abs(c.x - item.x) <= tolerance
    );

    if (!cluster) {
      cluster = {
        x: item.x,
        items: [],
        frequency: 0
      };

      clusters.push(cluster);
    }

    cluster.items.push(item);
    cluster.frequency++;

    cluster.x =
      cluster.items.reduce(
        (sum, value) => sum + value.x,
        0
      ) / cluster.items.length;
  }

  /*
   * Kolom yang benar biasanya muncul berkali-kali
   * pada beberapa baris.
   */
  const lineCount = lines.length;

  const minFrequency =
    lineCount >= 5
      ? Math.max(
          2,
          Math.ceil(lineCount * 0.15)
        )
      : 1;

  return clusters
    .filter(
      c => c.frequency >= minFrequency
    )
    .sort((a, b) => a.x - b.x)
    .map(c => c.x);
}


/*
 * Setelah anchor X ditemukan,
 * buat boundary antar kolom.
 */
function buildGeometryColumns(lines) {
  const anchors = detectColumnAnchors(lines);

  if (anchors.length < 2) {
    return null;
  }

  const boundaries = [0];

  for (
    let i = 0;
    i < anchors.length - 1;
    i++
  ) {
    boundaries.push(
      (anchors[i] + anchors[i + 1]) / 2
    );
  }

  boundaries.push(Infinity);

  return {
    anchors,
    boundaries
  };
}


/*
 * Menentukan sebuah text item masuk ke kolom mana.
 */
function geometryColumnIndex(x, columns) {
  for (
    let i = 0;
    i < columns.boundaries.length - 1;
    i++
  ) {
    if (
      x >= columns.boundaries[i] &&
      x < columns.boundaries[i + 1]
    ) {
      return i;
    }
  }

  return columns.anchors.length - 1;
}


/*
 * Ubah satu baris PDF menjadi array cell.
 */
function lineToGeometryRow(line, columns) {
  const cells = Array.from(
    {
      length: columns.anchors.length
    },
    () => []
  );

  for (const item of line.items) {
    const center =
      item.x + item.width / 2;

    const index =
      geometryColumnIndex(
        center,
        columns
      );

    if (
      index >= 0 &&
      index < cells.length
    ) {
      cells[index].push(item.text);
    }
  }

  return cells.map(cell =>
    normalizeText(
      cell.join(" ")
    )
  );
}


/*
 * Signature menunjukkan pola kolom
 * yang terisi pada suatu baris.
 *
 * Contoh:
 *
 * 1111
 * 1111
 * 1111
 */
function rowSignature(cells) {
  return cells
    .map(value => value ? "1" : "0")
    .join("");
}


function rowDensity(cells) {
  return cells.filter(Boolean).length;
}


/*
 * Cari baris-baris yang kemungkinan merupakan
 * bagian dari tabel.
 */
function detectTableRows(lines, columns) {
  const candidates = [];

  for (const line of lines) {
    const cells =
      lineToGeometryRow(
        line,
        columns
      );

    const density =
      rowDensity(cells);

    if (density === 0) {
      continue;
    }

    candidates.push({
      y: line.y,
      cells,
      sourceLine: line,
      signature: rowSignature(cells),
      density
    });
  }

  if (!candidates.length) {
    return [];
  }

  /*
   * Cari pola baris yang paling sering muncul.
   */
  const signatureCounts =
    new Map();

  for (const row of candidates) {
    signatureCounts.set(
      row.signature,
      (signatureCounts.get(
        row.signature
      ) || 0) + 1
    );
  }

  const dominantSignature =
    [...signatureCounts.entries()]
      .sort(
        (a, b) => b[1] - a[1]
      )[0]?.[0];

  const dominantRows =
    dominantSignature
      ? candidates.filter(
          row =>
            row.signature ===
            dominantSignature
        )
      : candidates;

  /*
   * Jika kita menemukan pola yang cukup konsisten,
   * gunakan rentang Y tersebut sebagai area tabel.
   */
  if (dominantRows.length >= 2) {
    const ys =
      dominantRows.map(
        row => row.y
      );

    const minY =
      Math.min(...ys);

    const maxY =
      Math.max(...ys);

    return candidates.filter(
      row =>
        row.y <= maxY + 8 &&
        row.y >= minY - 8
    );
  }

  return candidates;
}


/*
 * Hilangkan beberapa baris yang jelas-jelas
 * merupakan noise PDF.
 *
 * Ini bukan header detection.
 */
function isLikelyNoiseRow(row) {
  const text =
    normalizeText(
      row.cells.join(" ")
    ).toLowerCase();

  if (!text) {
    return true;
  }

  return (
    text.startsWith("page ") ||
    text.includes(
      "terms and conditions"
    ) ||
    text.includes("printed ") ||
    text.includes("generated ")
  );
}


/*
 * Deteksi tabel dari satu halaman.
 */
function detectTableFromPage(lines) {
  if (!lines.length) {
    return {
      headers: [],
      rows: [],
      detected: false
    };
  }

  const columns =
    buildGeometryColumns(
      lines
    );

  if (!columns) {
    return {
      headers: [],
      rows: [],
      detected: false
    };
  }

  let rows =
    detectTableRows(
      lines,
      columns
    );

  rows = rows.filter(
    row => !isLikelyNoiseRow(row)
  );

  if (!rows.length) {
    return {
      headers: [],
      rows: [],
      detected: false
    };
  }

  /*
   * PENTING:
   *
   * Tidak ada header detection.
   *
   * Baris pertama hanya dianggap sebagai
   * baris pertama hasil ekstraksi.
   *
   * Jika ternyata itu header,
   * header tetap masuk Excel.
   *
   * Jika tidak ada header,
   * tidak ada header yang dibuat.
   */
  return {
    headers: [],
    rows,
    columns,
    detected: true
  };
}


/* =========================================================
   MERGED CELL
   ========================================================= */

function isNumeric(value) {
  return /^\s*\d+(?:[.,]\d+)?\s*$/.test(
    value || ""
  );
}


/*
 * Generic fill-down berdasarkan geometri hasil extraction.
 *
 * Tidak tahu apakah kolom tersebut Category,
 * Brand, Group, dll.
 */
function applyGeometryFillDown(rows) {
  if (!rows || rows.length < 2) {
    return rows;
  }

  const width =
    rows[0].cells.length;

  for (
    let col = 0;
    col < width;
    col++
  ) {
    const values =
      rows.map(
        row =>
          normalizeText(
            row.cells[col]
          )
      );

    const nonEmpty =
      values.filter(Boolean);

    if (!nonEmpty.length) {
      continue;
    }

    const blankRatio =
      (values.length -
        nonEmpty.length) /
      values.length;

    /*
     * Hanya lakukan fill-down
     * jika memang terdapat cukup banyak
     * cell kosong.
     */
    if (blankRatio < 0.20) {
      continue;
    }

    /*
     * Jangan fill-down kolom numerik.
     */
    const numericRatio =
      nonEmpty.filter(
        isNumeric
      ).length /
      nonEmpty.length;

    if (numericRatio > 0.70) {
      continue;
    }

    let previous = "";

    for (const row of rows) {
      const value =
        normalizeText(
          row.cells[col]
        );

      if (value) {
        previous = value;
      } else if (previous) {
        row.cells[col] =
          previous;
      }
    }
  }

  return rows;
}


/* =========================================================
   PAGE EXTRACTION
   ========================================================= */

async function extractPage(
  page,
  pageNumber
) {
  const content =
    await page.getTextContent({
      disableCombineTextItems: true
    });

  const items =
    content.items
      .filter(
        item =>
          item.str &&
          item.str.trim()
      )
      .map(item => ({
        text: item.str.trim(),
        x: item.transform[4],
        y: item.transform[5],
        width:
          item.width || 0,
        height:
          item.height || 0
      }));

  const lines =
    groupIntoLines(items);

  const result =
    detectTableFromPage(
      lines
    );

  return {
    page: pageNumber,
    headers: [],
    rows: result.rows || [],
    columns:
      result.columns || null,
    detected:
      result.detected
  };
}


/* =========================================================
   MULTI PAGE
   ========================================================= */

function combinePages(
  pageResults
) {
  const valid =
    pageResults.filter(
      page =>
        page.detected &&
        page.rows.length
    );

  if (!valid.length) {
    throw new Error(
      "No table was detected. Make sure the PDF contains selectable text and aligned table content."
    );
  }

  /*
   * Pure extraction:
   *
   * Tidak ada:
   * - header detection
   * - header matching
   * - alias
   * - semantic schema
   *
   * Semua baris langsung dipertahankan.
   */

  const maxColumns =
    Math.max(
      ...valid.map(page =>
        page.rows.reduce(
          (max, row) =>
            Math.max(
              max,
              row.cells.length
            ),
          0
        )
      )
    );

  const rows = [];

  for (const page of valid) {
    for (const row of page.rows) {
      const cells =
        Array.from(
          {
            length:
              maxColumns
          },
          (_, i) =>
            normalizeText(
              row.cells[i] || ""
            )
        );

      rows.push({
        page: page.page,
        y: row.y,
        cells
      });
    }
  }

  /*
   * Pertahankan urutan baca PDF.
   */
  rows.sort(
    (a, b) =>
      a.page - b.page ||
      b.y - a.y
  );

  return {
    headers: [],
    rows
  };
}


/* =========================================================
   PREVIEW
   ========================================================= */

function renderPreview(
  headers,
  rows
) {
  const table =
    $("previewTable");

  table.innerHTML = "";

  if (!rows.length) {
    return;
  }

  const width =
    Math.max(
      ...rows.map(
        row =>
          row.cells.length
      )
    );

  rows
    .slice(0, 300)
    .forEach(row => {
      const tr =
        document.createElement(
          "tr"
        );

      for (
        let index = 0;
        index < width;
        index++
      ) {
        const td =
          document.createElement(
            "td"
          );

        td.textContent =
          row.cells[index] || "";

        tr.appendChild(td);
      }

      table.appendChild(tr);
    });

  $("rowCount").textContent =
    `${rows.length} rows · previewing up to 300`;
}


/* =========================================================
   EXTRACT BUTTON
   ========================================================= */

$("extractBtn")
  .addEventListener(
    "click",
    async () => {
      if (!currentFile) {
        return;
      }

      const button =
        $("extractBtn");

      button.disabled = true;
      button.textContent =
        "Extracting...";

      previewWrap.classList.add(
        "hidden"
      );

      try {
        const buffer =
          await currentFile.arrayBuffer();

        const pdf =
          await pdfjsLib
            .getDocument({
              data: buffer
            })
            .promise;

        const total =
          $("pageMode").value ===
          "first"
            ? 1
            : pdf.numPages;

        const pageResults = [];

        for (
          let pageNumber = 1;
          pageNumber <= total;
          pageNumber++
        ) {
          setStatus(
            `Reading page ${pageNumber} of ${total}...`
          );

          const page =
            await pdf.getPage(
              pageNumber
            );

          pageResults.push(
            await extractPage(
              page,
              pageNumber
            )
          );
        }

        extracted =
          combinePages(
            pageResults
          );

        /*
         * Optional generic merged-cell
         * handling.
         */
        if (
          $("mergeMode").value ===
          "auto"
        ) {
          applyGeometryFillDown(
            extracted.rows
          );
        }

        renderPreview(
          extracted.headers,
          extracted.rows
        );

        previewWrap.classList.remove(
          "hidden"
        );

        setStatus(
          `Completed. ${extracted.rows.length} table rows detected from ${pageResults.filter(p => p.detected).length} page(s).`
        );

      } catch (error) {
        console.error(error);

        setStatus(
          error.message ||
          "Could not detect a table in this PDF."
        );

        previewWrap.classList.add(
          "hidden"
        );

      } finally {
        button.disabled = false;
        button.textContent =
          "Extract & Preview";
      }
    }
  );


/* =========================================================
   DOWNLOAD EXCEL
   ========================================================= */

$("downloadBtn")
  .addEventListener(
    "click",
    () => {
      if (
        !extracted.rows.length
      ) {
        return;
      }

      /*
       * Tidak ada header yang
       * ditambahkan secara otomatis.
       *
       * Baris PDF langsung menjadi
       * baris Excel.
       */
      const data =
        extracted.rows.map(
          row => row.cells
        );

      const worksheet =
        XLSX.utils.aoa_to_sheet(
          data
        );

      /*
       * Hitung lebar kolom
       * berdasarkan isi aktual.
       */
      const columnCount =
        Math.max(
          0,
          ...extracted.rows.map(
            row =>
              row.cells.length
          )
        );

      worksheet["!cols"] =
        Array.from(
          {
            length:
              columnCount
          },
          (_, index) => {
            let max = 0;

            for (
              const row of
                extracted.rows.slice(
                  0,
                  500
                )
            ) {
              max =
                Math.max(
                  max,
                  String(
                    row.cells[
                      index
                    ] || ""
                  ).length
                );
            }

            return {
              wch:
                Math.min(
                  Math.max(
                    max + 2,
                    10
                  ),
                  50
                )
            };
          }
        );

      const workbook =
        XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        "Table"
      );

      const baseName =
        currentFile.name.replace(
          /\.pdf$/i,
          ""
        );

      XLSX.writeFile(
        workbook,
        `${baseName}.xlsx`
      );
    }
  );