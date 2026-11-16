# 🚀 FinanceFlow — Sistem Akuntansi & Manajemen Keuangan Otomatis Perusahaan

> **Sistem Manajemen Keuangan & Akuntansi Otomatis Berbasis Natural Language Input**  
> Disesuaikan khusus untuk **Akun Umum Perusahaan (Non-Dagang & Non-Manufaktur)** dengan pengenalan tanggal dan deteksi nama akun akuntansi berakurasi tinggi.

---

## 🌟 Fitur Utama Terbaru

1. **79 Akun Standar Perusahaan Umum (SAK EMKM)**
   - **20 Akun Aset**: Kas, Kas Kecil, Kas di Bank, Piutang Usaha, Piutang Wesel, Piutang Karyawan, Perlengkapan, Sewa Dibayar di Muka, Asuransi Dibayar di Muka, Iklan Dibayar di Muka, Tanah, Bangunan, Kendaraan, Peralatan, Inventaris Kantor, Mesin, Akumulasi Penyusutan, Investasi Jangka Panjang, Aset Tak Berwujud, Goodwill.
   - **15 Akun Liabilitas (Utang)**: Utang Usaha, Utang Wesel, Utang Bank, Utang Gaji, Utang Listrik, Utang Air, Utang Telepon, Utang Pajak, Utang Bunga, Utang Sewa, Pendapatan Diterima di Muka, Uang Muka Pelanggan, Utang Hipotek, Utang Obligasi, Liabilitas Imbalan Kerja.
   - **11 Akun Ekuitas (Modal)**: Modal Pemilik, Modal Saham, Tambahan Modal Disetor, Prive, Laba Ditahan, Saldo Laba, Cadangan Modal, Laba Tahun Berjalan, Rugi Tahun Berjalan, Agio Saham, Disagio Saham.
   - **9 Akun Pendapatan**: Pendapatan Jasa, Pendapatan Sewa, Pendapatan Bunga, Pendapatan Komisi, Pendapatan Royalti, Pendapatan Dividen, Pendapatan Administrasi, Pendapatan Lain-lain, Keuntungan Penjualan Aset.
   - **24 Akun Beban**: Beban Gaji, Beban Upah, Beban Sewa, Beban Listrik, Beban Air, Beban Telepon, Beban Internet, Beban Transportasi, Beban Bensin, Beban Perlengkapan, Beban Penyusutan, Beban Asuransi, Beban Iklan, Beban ATK, Beban Pemeliharaan, Beban Perbaikan, Beban Bunga, Beban Pajak, Beban Administrasi, Beban Konsumsi, Beban Perjalanan Dinas, Beban Pengiriman, Beban Kerugian Piutang, Beban Lain-lain.

2. **Deteksi Tanggal Transaksi Otomatis & Akurat**
   - Mendeteksi tanggal teks bahasa Indonesia: `pada tanggal 10 November 2026`, `tgl 15-10-2026`, `12/03/2026`, `tgl 25`.
   - Mendeteksi tanggal relatif: `hari ini`, `kemarin`, `kemarin lusa`, `2 hari lalu`, `3 hari lalu`.
   - Tanggal otomatis terisi di kolom konfirmasi dan dapat diedit sebelum disimpan.

3. **Deteksi Nama Akun Otomatis & Akurat**
   - Beban Bensin, Beban Internet, Beban Listrik, Beban Air, Beban ATK, Beban Gaji, Beban Konsumsi, Beban Iklan, Beban Perbaikan, dll.
   - Pendapatan Jasa, Pendapatan Sewa, Pendapatan Komisi, Pendapatan Bunga, dll.
   - Modal Pemilik, Prive, Pelunasan Piutang Usaha, Pembayaran Utang Usaha.

4. **Siklus Laporan Keuangan Lengkap**
   - Persamaan Dasar Akuntansi: $\text{Aset} = \text{Liabilitas} + \text{Ekuitas}$
   - Rumus Laba Bersih: $\text{Laba Bersih} = \text{Pendapatan} - \text{Beban}$
   - Jurnal Umum, Buku Besar, Neraca Saldo, Laba Rugi, Posisi Keuangan, Arus Kas, Perubahan Ekuitas.

---

## ⚡ Cara Menjalankan

1. Di terminal VS Code (folder `financeflow`):
   ```bash
   node --watch server.js
   ```
2. Buka browser: **http://localhost:3000**
