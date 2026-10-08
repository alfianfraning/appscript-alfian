# FSOP Overview — export Google Sheets langsung (tanpa UI dashboard)

`Export.gs` ditambahkan sebagai **file baru** di project Apps Script FS Overview LOreal Group (di samping `Code.gs` dan `Dashboard.html`). Tidak ada file lama yang diubah.

## Cara kerja
`exportFsopFromSettings()` → `refreshData()` → payload cache yang baru dipakai langsung → membangun 3 tab (`Per Period per Store`, `Per Period per Warehouse`, `Per Period per Marketplace`) → file `"<tahun> - FSOP - <label> Version N"` di `EXPORT_FOLDER_ID` (penamaan & versi sama dengan `createExportSpreadsheet`).

## Pemakaian
| Fungsi | Kegunaan |
|---|---|
| `exportFsopLOrealGroup()` | Run manual dari editor: refresh + export "LOreal Group" |
| `exportFsop('LOreal CPD')` | Store / group mana pun; opsi kedua `{refresh:false}` untuk melewati refreshData |
| `exportFsopFromSettings()` | Refresh sekali, lalu export semua nama di Script Property `FSOP_SELECTIONS` (pisah koma / baris baru; default `LOreal Group`) |
| `installFsopDailyTrigger()` | Pasang trigger harian 06:00 yang **menggantikan** trigger `refreshData` (karena sudah dipanggil di dalamnya) |
| `removeFsopDailyTrigger()` | Kembalikan trigger `refreshData` biasa |

## Verifikasi
Dibandingkan sel-demi-sel dengan "2026 - FSOP - LOreal Group Version 13" (rumus, nilai, format angka, bold, warna highlight, freeze, grup baris/kolom), dengan fungsi writer asli dari `Code.gs` dan stub Apps Script:
- Tab Store & Warehouse: 0 selisih.
- Tab Marketplace: 5 sel highlight pada baris *Consumables per order* yang berbeda (nilai antar-marketplace identik hingga ~1e-13, sehingga penentu tertinggi/terendah hanya noise pembulatan).

## Asumsi yang belum bisa dibuktikan (hanya ada 1 contoh export)
- Daftar `FSOP_VIRTUAL_GROUPS` disalin dari definisi grup LOreal; samakan bila `Dashboard.html` berubah.
- Untuk **store tunggal** tab "per Store" dilewati (tidak ada pecahan anggota); untuk **group** yang dipecah adalah anggota langsung group tsb.
- Highlight antar Quarter dikelompokkan per semester, antar Half per tahun (contoh hanya memuat H1).
