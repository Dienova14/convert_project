# PDF ke Excel

Aplikasi browser untuk mengubah tabel PDF menjadi Excel/CSV.

## Mode tabel

- **Deteksi otomatis** — untuk tabel umum.
- **Ikuti garis border** — untuk tabel dengan grid/border yang jelas.
- **Ikuti celah spasi** — untuk tabel tanpa border.
- **Price list bertingkat** — untuk price list yang memakai struktur `No. / Size / Spec (atau Grit) / Rp.` dengan beberapa baris harga untuk satu No/Size dan continuation antar halaman, seperti layout Norton.

Mode Price list bertingkat melakukan forward-fill `No.` dan `Size` berdasarkan struktur baris, bukan berdasarkan nama file atau merek, sehingga tidak memengaruhi mode tabel umum.

## Menjalankan

Jalankan dari web server lokal, misalnya:

```bash
python -m http.server 8000
```

Lalu buka `http://localhost:8000`.
