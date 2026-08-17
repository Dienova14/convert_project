# PDF to Excel — Generic Table Extractor

A simple browser-based PDF → Excel converter for **text-based PDFs that contain tables**.

## What this version is designed for

This is intentionally **not hard-coded to one price list**.

The extractor tries to:

1. Detect a table header automatically.
2. Detect the table's columns from the header positions.
3. Ignore text above the table.
4. Detect product/data rows below the header.
5. Ignore repeated headers on later pages.
6. Preserve the detected column names in Excel.
7. Handle vertically merged cells with an automatic fill-down heuristic.
8. Process the PDF locally in the browser.

### Example

If the PDF contains:

```text
PRICE LIST 2026

No | Category | Code | Description | Price
1  | Group A  | A001 | Product 1   | 10000
2  |          | A002 | Product 2   | 12000
3  |          | A003 | Product 3   | 15000
4  | Group B  | B001 | Product 4   | 20000
```

the converter aims to produce:

```text
No | Category | Code | Description | Price
1  | Group A  | A001 | Product 1   | 10000
2  | Group A  | A002 | Product 2   | 12000
3  | Group A  | A003 | Product 3   | 15000
4  | Group B  | B001 | Product 4   | 20000
```

The title `PRICE LIST 2026` is ignored because it is outside the detected table.

## Supported PDF type

Best results:

- selectable text PDF
- regular table layout
- visible table header
- consistent column positions

Less reliable:

- scanned/image-only PDFs
- tables without headers
- heavily rotated tables
- very complex nested tables
- tables where columns change position on every row

OCR can be added later for scanned PDFs.

## Run locally

You need a local web server because browser modules may be blocked when opening `index.html` directly with `file://`.

For example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## GitHub Pages

The project is static and can be hosted on GitHub Pages. No backend is required for the current version.


## v4.1 merged-cell fix

The extractor now keeps non-numbered lines inside the table area instead of
discarding them immediately. This matters for vertically merged cells because
the text of a merged Category/Group/Brand cell may be printed once in the
middle of several product rows.

The algorithm:

1. Detects real data rows using the No column when available.
2. Keeps orphan lines below the header.
3. Checks orphan text against semantic table columns such as Category, Group,
   Brand, Unit and Note.
4. Uses the orphan line's vertical coordinate to assign the merged value to
   the correct row range.
5. Uses generic fill-down only as a final fallback.

This is intentionally generic and does not contain product names from any
specific PDF.
