import { buildDocumentTable } from "../assets/lib/document.js";

const XS = [50, 150, 330, 430, 530]; // 4 kolom
const YS = [50, 72, 92, 112, 132];   // 4 baris

function word(text, x, top, bold = false) {
  return {
    text,
    x0: x,
    x1: x + text.length * 5,
    top,
    bottom: top + 10,
    fontSize: 10,
    fontFamily: bold ? "Arial-Bold" : "Arial",
    vertical: false
  };
}

/**
 * Baris 0 : header
 * Baris 1 : normal
 * Baris 2 : kolom 0 di-merge ke bawah (rowspan 2), kolom 1-2 di-merge kesamping
 * Baris 3 : lanjutan rowspan
 */
function makePage(pageNumber, { withHeader = true } = {}) {
  const words = [];

  const vertical = [];
  const horizontal = [];

  const top = YS[0];
  const bottom = YS[YS.length - 1];

  // garis vertikal penuh, kecuali x=330 di baris ke-2 (merge kesamping)
  for (const x of XS) {
    if (x === 330) {
      vertical.push({ x, y0: YS[0], y1: YS[2] });
      vertical.push({ x, y0: YS[3], y1: YS[4] });
    } else {
      vertical.push({ x, y0: top, y1: bottom });
    }
  }

  // garis horizontal penuh, kecuali y=112 di kolom 0 (merge ke bawah)
  for (const y of YS) {
    if (y === 112) {
      horizontal.push({ y, x0: XS[1], x1: XS[4] });
    } else {
      horizontal.push({ y, x0: XS[0], x1: XS[4] });
    }
  }

  if (withHeader) {
    words.push(word("Wilayah", 55, 56, true));
    words.push(word("Produk", 155, 56, true));
    words.push(word("Unit", 335, 56, true));
    words.push(word("Nilai", 435, 56, true));
  } else {
    words.push(word("Jawa Barat", 55, 56));
    words.push(word("Kopi", 155, 56));
    words.push(word("10", 335, 56));
    words.push(word("500", 435, 56));
  }

  words.push(word("Bali", 55, 78));
  words.push(word("Teh", 155, 78));
  words.push(word("5", 335, 78));
  words.push(word("250", 435, 78));

  // baris merge kesamping (kolom 1 dan 2 jadi satu)
  words.push(word("Papua", 55, 98));
  words.push(word("Sagu dan turunannya", 155, 98));
  words.push(word("900", 435, 98));

  // baris lanjutan rowspan: kolom 0 kosong karena di-merge
  words.push(word("Gula", 155, 118));
  words.push(word("3", 335, 118));
  words.push(word("120", 435, 118));

  return {
    pageNumber,
    width: 595,
    height: 842,
    hasText: true,
    words,
    rulings: { horizontal, vertical }
  };
}

const pages = [makePage(1), makePage(2)]; // halaman 2 juga mencetak header

for (const mergeMode of ["fill", "merge"]) {
  const result = buildDocumentTable(pages, {
    mode: "auto",
    headerMode: "auto",
    mergeMode,
    joinWrapped: true,
    joinAcrossPages: true
  });

  console.log(`\n=== mergeMode: ${mergeMode} | mode: ${result.modes.join(",")} ===`);
  console.log("header:", result.header?.cells.map(c => c?.text));

  for (const row of result.rows) {
    console.log(
      " ",
      row.page,
      JSON.stringify(
        row.cells.map(c => (c ? `${c.text}${c.colspan > 1 ? `[cs${c.colspan}]` : ""}${c.rowspan > 1 ? `[rs${c.rowspan}]` : ""}` : "·"))
      )
    );
  }
}
