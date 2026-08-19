/* =========================================================
   app.js — lapisan antarmuka
   ========================================================= */

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";

import { readPage, stripRunningHeaders } from "./lib/page-content.js";
import { buildDocumentTable } from "./lib/document.js";
import { downloadCsv, downloadWorkbook } from "./lib/export.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const MAX_FILE_SIZE = 40 * 1024 * 1024;
const PREVIEW_LIMIT = 400;

const $ = id => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("fileInput");
const statusBox = $("status");
const workspace = $("workspace");
const previewWrap = $("previewWrap");
const progressBar = $("progressBar");

let currentFile = null;
let table = null;

/* ---------------------------------------------------------
   Status & progres
   --------------------------------------------------------- */

function setStatus(message, tone = "info") {
  statusBox.textContent = message || "";
  statusBox.dataset.tone = tone;
  statusBox.classList.toggle("hidden", !message);
}

function setProgress(value) {
  progressBar.parentElement.classList.toggle("hidden", value === null);
  progressBar.style.width = `${Math.round((value ?? 0) * 100)}%`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

/* ---------------------------------------------------------
   Pilih berkas
   --------------------------------------------------------- */

function selectFile(file) {
  if (!file) return;

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    setStatus("Berkas harus PDF.", "error");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    setStatus(`Ukuran ${formatBytes(file.size)} melebihi batas 40 MB.`, "error");
    return;
  }

  currentFile = file;
  table = null;

  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `· ${formatBytes(file.size)}`;

  workspace.classList.remove("hidden");
  previewWrap.classList.add("hidden");
  setStatus("");
}

fileInput.addEventListener("change", event => selectFile(event.target.files[0]));

["dragenter", "dragover"].forEach(name =>
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.add("drag");
  })
);

["dragleave", "drop"].forEach(name =>
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.remove("drag");
  })
);

dropzone.addEventListener("drop", event => selectFile(event.dataTransfer.files[0]));

dropzone.addEventListener("click", event => {
  if (event.target.closest("label")) return;
  fileInput.click();
});

dropzone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

$("removeBtn").addEventListener("click", () => {
  currentFile = null;
  table = null;
  fileInput.value = "";

  workspace.classList.add("hidden");
  previewWrap.classList.add("hidden");
  setProgress(null);
  setStatus("");
});

/* ---------------------------------------------------------
   Rentang halaman: "1-4, 9, 12-"
   --------------------------------------------------------- */

function parsePageRange(input, total) {
  const text = String(input || "").trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);

  const selected = new Set();

  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;

    const match = chunk.match(/^(\d+)?\s*-\s*(\d+)?$/);

    if (match) {
      const from = Math.max(1, Number(match[1] || 1));
      const to = Math.min(total, Number(match[2] || total));
      for (let page = from; page <= to; page++) selected.add(page);
      continue;
    }

    const single = Number(chunk);
    if (Number.isInteger(single) && single >= 1 && single <= total) selected.add(single);
  }

  return [...selected].sort((a, b) => a - b);
}

function readOptions() {
  return {
    mode: $("tableMode").value,
    headerMode: $("headerMode").value,
    mergeMode: $("mergeMode").value,
    numberLocale: $("numberLocale").value,
    joinWrapped: $("joinWrapped").value === "on",
    joinAcrossPages: $("joinWrapped").value === "on"
  };
}

/* ---------------------------------------------------------
   Ekstraksi
   --------------------------------------------------------- */

$("extractBtn").addEventListener("click", async () => {
  if (!currentFile) return;

  const button = $("extractBtn");
  button.disabled = true;
  button.textContent = "Membaca…";

  previewWrap.classList.add("hidden");
  setProgress(0);

  let document_ = null;

  try {
    const buffer = await currentFile.arrayBuffer();
    document_ = await pdfjsLib.getDocument({ data: buffer }).promise;

    const pageNumbers = parsePageRange($("pageRange").value, document_.numPages);

    if (!pageNumbers.length) {
      throw new Error(`Rentang halaman kosong. Dokumen ini punya ${document_.numPages} halaman.`);
    }

    const options = readOptions();
    const pages = [];

    for (let i = 0; i < pageNumbers.length; i++) {
      const pageNumber = pageNumbers[i];
      setStatus(`Membaca halaman ${pageNumber} (${i + 1} dari ${pageNumbers.length})…`);
      setProgress(i / pageNumbers.length);

      const page = await document_.getPage(pageNumber);
      const content = await readPage(page, pdfjsLib, {
        readRulings: options.mode !== "stream"
      });

      pages.push({ ...content, pageNumber });
      page.cleanup();

      await yieldToUi();
    }

    setProgress(0.95);
    setStatus("Menyusun tabel…");

    stripRunningHeaders(pages);

    table = buildDocumentTable(pages, options);

    renderPreview(table);
    previewWrap.classList.remove("hidden");

    const modeLabel = {
      lattice: "garis border",
      hybrid: "garis baris + celah spasi",
      stream: "celah spasi",
      grouped: "price list bertingkat"
    };

    const detected = table.modes.map(mode => modeLabel[mode] || mode).join(", ");

    setStatus(
      `Selesai. ${table.rows.length} baris × ${table.columnCount} kolom dari ${table.pageCount} halaman. Struktur dibaca lewat ${detected}.`,
      "ok"
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Gagal membaca tabel dari PDF ini.", "error");
    previewWrap.classList.add("hidden");
    table = null;
  } finally {
    if (document_) document_.destroy();
    setProgress(null);
    button.disabled = false;
    button.textContent = "Preview";
  }
});

/* ---------------------------------------------------------
   Preview
   --------------------------------------------------------- */

function renderPreview(result) {
  const element = $("previewTable");
  element.innerHTML = "";

  if (result.header) {
    const head = document.createElement("thead");
    head.appendChild(buildRowElement(result.header, "th"));
    element.appendChild(head);
  }

  const body = document.createElement("tbody");

  for (const row of result.rows.slice(0, PREVIEW_LIMIT)) {
    body.appendChild(buildRowElement(row, "td"));
  }

  element.appendChild(body);

  const shown = Math.min(result.rows.length, PREVIEW_LIMIT);
  $("rowCount").textContent =
    result.rows.length > shown
      ? `${result.rows.length} baris · menampilkan ${shown} pertama`
      : `${result.rows.length} baris`;
}

function buildRowElement(row, tag) {
  const tr = document.createElement("tr");
  const useMerges = $("mergeMode").value === "merge";
  const skip = new Set();

  row.cells.forEach((cell, index) => {
    if (!cell || skip.has(index)) return;

    const element = document.createElement(tag);
    element.textContent = cell.text || "";

    if (useMerges) {
      if (cell.colspan > 1) {
        element.colSpan = cell.colspan;
        for (let k = 1; k < cell.colspan; k++) skip.add(index + k);
      }
      if (cell.rowspan > 1) element.rowSpan = cell.rowspan;
    }

    if (cell.filledDown) element.classList.add("derived");

    tr.appendChild(element);
  });

  return tr;
}

/* ---------------------------------------------------------
   Unduh
   --------------------------------------------------------- */

function baseName() {
  return currentFile.name.replace(/\.pdf$/i, "");
}

$("downloadBtn").addEventListener("click", () => {
  if (!table) return;
  downloadWorkbook(table, `${baseName()}.xlsx`, readOptions());
});

$("downloadCsvBtn").addEventListener("click", () => {
  if (!table) return;
  downloadCsv(table, `${baseName()}.csv`, readOptions());
});
