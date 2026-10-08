# FSOP Overview - export Google Sheets langsung (tanpa UI dashboard)

`Export.gs` ditambahkan sebagai **file baru** di project Apps Script FS Overview LOreal Group (di samping `Code.gs` dan `Dashboard.html`). Tidak ada file lama yang diubah.

## Cara kerja
`Export.gs` tidak menulis ulang logika export. Ia memuat script `Dashboard.html` di server (DOM di-stub), memilih store/group seperti mencentang kotaknya di sidebar, lalu memanggil `getExportRows_()` + `buildExportPayload_()` + `exportStoreLabel_()` milik dashboard sendiri, dan mengirim hasilnya ke `createExportSpreadsheet(payload)` di `Code.gs` tanpa diubah. Jadi isi export, nama file, nomor versi, folder, dan format selalu mengikuti `Dashboard.html` dan `Code.gs`.

Alur: `refreshData()` -> payload cache terbaru -> engine dashboard -> `createExportSpreadsheet`.

## Pemakaian
| Fungsi | Kegunaan |
|---|---|
| `exportFsopLOrealGroup()` | Run manual dari editor: refresh + export "LOreal Group" |
| `exportFsop('LOreal CPD')` | Store / group mana pun (nama persis seperti di sidebar); opsi kedua `{refresh:false}` melewati refreshData |
| `exportFsopFromSettings()` | Refresh sekali, lalu export semua nama di Script Property `FSOP_SELECTIONS` (pisah koma / baris baru; default `LOreal Group`) |
| `installFsopDailyTrigger()` | Trigger harian 06:00 yang **menggantikan** trigger `refreshData` (sudah dipanggil di dalamnya) |
| `removeFsopDailyTrigger()` | Kembalikan trigger `refreshData` biasa |

## Ketergantungan pada Dashboard.html
Script data dikenali dari blok `<script>` yang memuat `const FS_PAYLOAD = <?!= dataJson ?>` dan berakhir tepat sebelum baris `function render() {`. Harus ada: `DATA`, `state`, `getExportRows_`, `buildExportPayload_`, `exportStoreLabel_`. Kalau salah satu berubah nama/hilang, export berhenti dengan pesan error yang jelas (tidak diam-diam salah).

## Verifikasi
Dengan `Dashboard.html` live dan cache nyata, dibandingkan sel demi sel dengan "2026 - FSOP - LOreal Group Version 13" memakai fungsi writer asli dari `Code.gs` (stub Apps Script): 0 selisih di 3 tab (rumus, nilai, format, bold, warna highlight, freeze, grup baris/kolom). Semua 19 store/group menghasilkan payload tanpa error.
