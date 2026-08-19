import { buildDocumentTable, parseNumber } from "../assets/lib/document.js";

const FONT = 10;

function word(text, x, top, { width = null, bold = false } = {}) {
  const w = width ?? text.length * 5.2;
  return {
    text,
    x0: x,
    x1: x + w,
    top,
    bottom: top + FONT,
    fontSize: FONT,
    fontFamily: bold ? "Helvetica-Bold" : "Helvetica",
    vertical: false
  };
}

// Kolom di x = 50, 150, 330, 430 (rata kiri kecuali angka rata kanan-ish)
function makePage(pageNumber, rows, { withHeader = true } = {}) {
  const words = [];
  let y = 60;

  if (withHeader) {
    words.push(
      word("Kode", 50, y, { bold: true }),
      word("Nama Barang", 150, y, { bold: true }),
      word("Qty", 330, y, { bold: true }),
      word("Harga", 430, y, { bold: true })
    );
    y += 22;
  }

  for (const row of rows) {
    if (row.kode) words.push(word(row.kode, 50, y));
    if (row.nama) words.push(word(row.nama, 150, y));
    if (row.qty) words.push(word(row.qty, 330, y));
    if (row.harga) words.push(word(row.harga, 430, y));
    y += row.wrap ? 14 : 20;

    if (row.wrap) {
      words.push(word(row.wrap, 150, y));
      y += 20;
    }
  }

  return {
    pageNumber,
    width: 595,
    height: 842,
    hasText: true,
    words,
    rulings: { horizontal: [], vertical: [] }
  };
}

const page1 = makePage(1, [
  { kode: "A-001", nama: "Kabel HDMI", qty: "12", harga: "150.000" },
  { kode: "A-002", nama: "Adaptor 65W merek", qty: "4", harga: "1.250.000", wrap: "generik tipe C" },
  { kode: "A-003", nama: "Mouse", qty: "20", harga: "95.500" }
]);

// Halaman 2: header TIDAK dicetak ulang (kasus yang diminta)
const page2 = makePage(
  2,
  [
    { kode: "A-004", nama: "Keyboard", qty: "7", harga: "320.000" },
    { kode: "A-005", nama: "Monitor", qty: "2", harga: "2.100.000" }
  ],
  { withHeader: false }
);

const result = buildDocumentTable([page1, page2], {
  mode: "auto",
  headerMode: "auto",
  mergeMode: "fill",
  joinWrapped: true,
  joinAcrossPages: true
});

console.log("mode      :", result.modes.join(", "));
console.log("kolom     :", result.columnCount);
console.log("header    :", result.header ? result.header.cells.map(c => c.text) : "(tidak terdeteksi)");
console.log("baris     :", result.rows.length);
for (const row of result.rows) {
  console.log("  ", row.page, JSON.stringify(row.cells.map(c => c.text)));
}

console.log("\nparseNumber:");
for (const sample of ["150.000", "1.250.000", "1.234,56", "1,234.56", "(2.500)", "12,5%", "A-001", "3.14"]) {
  console.log(`  ${sample.padEnd(12)} -> ${parseNumber(sample, "auto")}`);
}
