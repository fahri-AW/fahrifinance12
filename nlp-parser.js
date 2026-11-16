/**
 * nlp-parser.js
 * Enhanced Natural Language Transaction & Date Parser for FinanceFlow
 * Accurate matching for 79 general company accounts and comprehensive Indonesian date formats.
 */

// ── Clean & Normalize Numbers ──
export function cleanNumber(str) {
  if (!str) return 0;
  let s = str.trim();

  // Indonesian thousands with dot e.g. "2.000.000", "250.000", "2.500"
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
    return parseInt(s.replace(/\./g, ''), 10);
  }

  // Comma thousands e.g. "2,000,000"
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) {
    return parseInt(s.replace(/,/g, ''), 10);
  }

  // Decimal with comma e.g. "1,5"
  if (/^\d+,\d+$/.test(s)) {
    return parseFloat(s.replace(',', '.'));
  }

  // Decimal with dot e.g. "1.5"
  if (/^\d+\.\d+$/.test(s)) {
    return parseFloat(s);
  }

  return parseFloat(s) || 0;
}

// ── Parse Nominal Amount ──
export function parseAmount(text) {
  if (!text) return null;

  // Multiplier pattern e.g. "5 produk dengan harga masing-masing 10 ribu" or "3 jam @ 100k"
  const multiPattern = /(\d+)\s*(?:pcs|item|produk|buah|barang|porsi|jam|orang|hari|bulan)?\s*(?:dengan\s+harga\s+)?(?:masing-masing|@|seharga|harga|satuan)\s*(?:rp\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?/i;
  const multiMatch = text.match(multiPattern);
  if (multiMatch) {
    const qty = parseInt(multiMatch[1], 10);
    let unitPrice = cleanNumber(multiMatch[2]);
    const unit = (multiMatch[3] || '').toLowerCase();
    if (['rb', 'ribu', 'k'].includes(unit)) unitPrice *= 1000;
    if (['jt', 'juta'].includes(unit)) unitPrice *= 1000000;

    const total = qty * unitPrice;
    if (total > 0) {
      return {
        amount: Math.round(total),
        quantity: qty,
        unitPrice: Math.round(unitPrice),
        matchedStr: multiMatch[0],
      };
    }
  }

  // Standard nominal pattern e.g. "Rp2.000.000", "50k", "10 ribu", "sebesar 5 ribu", "2.500"
  const regex = /(?:sebesar|nominal|seharga|rp\.?|rp\s*)?\s*(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?\b/gi;
  let match;
  let best = null;

  while ((match = regex.exec(text)) !== null) {
    if (!match[1]) continue;
    let val = cleanNumber(match[1]);
    const unit = (match[2] || '').toLowerCase();

    if (['rb', 'ribu', 'k'].includes(unit)) val *= 1000;
    if (['jt', 'juta'].includes(unit)) val *= 1000000;

    if (val > 0) {
      const isExplicit = match[0].toLowerCase().includes('sebesar') ||
                         match[0].toLowerCase().includes('rp') ||
                         Boolean(unit);
      best = {
        amount: Math.round(val),
        quantity: 1,
        unitPrice: Math.round(val),
        matchedStr: match[0],
      };
      if (isExplicit) break;
    }
  }

  return best;
}

// ── Comprehensive Indonesian Date Parser ──
export function parseIndonesianDate(text) {
  if (!text) return { date: new Date().toISOString().slice(0, 10), matchedStr: null };
  const lower = text.toLowerCase();
  const now = new Date();

  // 1. Relative keywords
  if (/\b(kemarin\s+lusa|2\s+hari\s+(?:yang\s+)?lalu)\b/i.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    return { date: d.toISOString().slice(0, 10), matchedStr: lower.match(/\b(kemarin\s+lusa|2\s+hari\s+(?:yang\s+)?lalu)\b/i)[0] };
  }
  if (/\b(3\s+hari\s+(?:yang\s+)?lalu)\b/i.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 3);
    return { date: d.toISOString().slice(0, 10), matchedStr: lower.match(/\b(3\s+hari\s+(?:yang\s+)?lalu)\b/i)[0] };
  }
  if (/\bkemarin\b/i.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { date: d.toISOString().slice(0, 10), matchedStr: 'kemarin' };
  }
  if (/\b(hari\s+ini)\b/i.test(lower)) {
    return { date: now.toISOString().slice(0, 10), matchedStr: 'hari ini' };
  }

  // 2. Standard ISO YYYY-MM-DD (e.g. 2026-11-10)
  const isoMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return { date: `${y}-${m}-${d}`, matchedStr: isoMatch[0] };
  }

  // 3. DD/MM/YYYY or DD-MM-YYYY (e.g. 10/11/2026 or 15-10-2026)
  const dmyMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return { date: `${y}-${m}-${d}`, matchedStr: dmyMatch[0] };
  }

  // 4. Text Date with Indonesian month name (e.g. "tanggal 15 November 2026" or "10 Okt" or "tgl 5 Maret")
  const monthMap = {
    jan: 1, januari: 1,
    feb: 2, februari: 2, pebruari: 2,
    mar: 3, maret: 3,
    apr: 4, april: 4,
    mei: 5,
    jun: 6, juni: 6,
    jul: 7, juli: 7,
    agu: 8, ags: 8, agustus: 8,
    sep: 9, sept: 9, september: 9,
    okt: 10, oktober: 10,
    nov: 11, nop: 11, november: 11, nopember: 11,
    des: 12, desember: 12,
  };

  const textDateRegex = /(?:pada\s+tanggal|tanggal|tgl)?\s*(\d{1,2})\s+(januari|februari|pebruari|maret|april|mei|juni|juli|agustus|september|oktober|november|nopember|desember|jan|feb|mar|apr|jun|jul|agu|ags|sep|okt|nov|des)\s*(\d{4})?/i;
  const textDateMatch = text.match(textDateRegex);
  if (textDateMatch) {
    const day = parseInt(textDateMatch[1], 10);
    const monthKey = textDateMatch[2].toLowerCase();
    const month = monthMap[monthKey];
    const year = textDateMatch[3] ? parseInt(textDateMatch[3], 10) : now.getFullYear();

    if (month && day >= 1 && day <= 31) {
      const yStr = String(year);
      const mStr = String(month).padStart(2, '0');
      const dStr = String(day).padStart(2, '0');
      return { date: `${yStr}-${mStr}-${dStr}`, matchedStr: textDateMatch[0] };
    }
  }

  // 5. Short "tanggal 15" or "tgl 8" without month (assumes current month and year)
  const shortDayRegex = /\b(?:pada\s+tanggal|tanggal|tgl)\s+(\d{1,2})\b/i;
  const shortDayMatch = text.match(shortDayRegex);
  if (shortDayMatch) {
    const day = parseInt(shortDayMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const yStr = String(now.getFullYear());
      const mStr = String(now.getMonth() + 1).padStart(2, '0');
      const dStr = String(day).padStart(2, '0');
      return { date: `${yStr}-${mStr}-${dStr}`, matchedStr: shortDayMatch[0] };
    }
  }

  // Default to today
  return { date: now.toISOString().slice(0, 10), matchedStr: null };
}

// ── Accurate Account & Transaction Classifier ──
export function parseTransactionNL(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Kalimat transaksi tidak boleh kosong.');
  }

  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 1. Amount & Quantity Extraction
  const parsedAmt = parseAmount(text);
  if (!parsedAmt || parsedAmt.amount <= 0) {
    throw new Error('Nominal transaksi tidak ditemukan. Contoh: 5k, 10rb, Rp50.000, atau 5 item @ 10rb.');
  }

  const amount = parsedAmt.amount;
  const quantity = parsedAmt.quantity || 1;
  const unitPrice = parsedAmt.unitPrice || amount;

  // 2. Date Extraction
  const { date: transactionDate, matchedStr: matchedDateStr } = parseIndonesianDate(text);

  // 3. Payment Method Determination
  let paymentMethod = 'cash';
  if (/\b(qris)\b/.test(lower)) {
    paymentMethod = 'qris';
  } else if (/\b(transfer|bank|bca|bri|mandiri|bni|rekening)\b/.test(lower)) {
    paymentMethod = 'bank';
  } else if (/\b(kredit|tempo|bon|utang|ngutang|belum lunas|termin)\b/.test(lower)) {
    paymentMethod = 'credit';
  } else if (/\b(ewallet|e-wallet|gopay|ovo|dana|shopeepay)\b/.test(lower)) {
    paymentMethod = 'bank';
  } else if (/\b(kas\s*kecil|petty\s*cash)\b/.test(lower)) {
    paymentMethod = 'cash';
  }

  // Select Money Account: 1001 (Kas), 1002 (Kas Kecil), 1003 (Kas di Bank)
  let moneyAccountCode = (paymentMethod === 'bank' || paymentMethod === 'qris') ? '1003' : '1001';
  let moneyAccountName = (paymentMethod === 'bank' || paymentMethod === 'qris') ? 'Kas di Bank' : 'Kas';

  if (/\b(kas\s*kecil|petty\s*cash)\b/.test(lower)) {
    moneyAccountCode = '1002';
    moneyAccountName = 'Kas Kecil';
  }

  // 4. Accurate Classification for 79 General Company Accounts
  let type = 'expense';
  let category = 'Beban Operasional';
  let debitAccountCode = '6024';
  let debitAccountName = 'Beban Lain-lain';
  let creditAccountCode = moneyAccountCode;
  let creditAccountName = moneyAccountName;

  // ── A. EKUITAS / MODAL ──
  if (/\b(prive|keperluan pribadi|ambil uang pribadi|tarik pribadi)\b/.test(lower)) {
    type = 'drawing';
    category = 'Ekuitas / Prive';
    debitAccountCode = '3004';
    debitAccountName = 'Prive';
    creditAccountCode = moneyAccountCode;
    creditAccountName = moneyAccountName;
  } else if (/\b(modal saham|setoran saham|saham)\b/.test(lower)) {
    type = 'capital';
    category = 'Ekuitas / Modal Saham';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '3002';
    creditAccountName = 'Modal Saham';
  } else if (/\b(modal|setor modal|suntikan dana|investasi pemilik|terima modal|menerima.*modal|tambah modal)\b/.test(lower)) {
    type = 'capital';
    category = 'Ekuitas / Modal Pemilik';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '3001';
    creditAccountName = 'Modal Pemilik';
  }

  // ── B. UTANG & PIUTANG ──
  else if (/\b(terima piutang|bayar piutang|pembayaran piutang|pelunasan piutang|cicil piutang|tagihan pelanggan)\b/.test(lower)) {
    type = 'receivable_payment';
    category = 'Penerimaan Piutang Usaha';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '1004';
    creditAccountName = 'Piutang Usaha';
  } else if (/\b(kasbon|pinjaman karyawan|kasbon karyawan|piutang karyawan)\b/.test(lower)) {
    type = 'receivable_payment';
    category = 'Piutang Karyawan';
    debitAccountCode = '1006';
    debitAccountName = 'Piutang Karyawan';
    creditAccountCode = moneyAccountCode;
    creditAccountName = moneyAccountName;
  } else if (/\b(bayar utang|bayar hutang|cicil utang|pelunasan utang|bayar tagihan pemasok)\b/.test(lower)) {
    type = 'payable_payment';
    category = 'Pembayaran Utang Usaha';
    debitAccountCode = '2001';
    debitAccountName = 'Utang Usaha';
    creditAccountCode = moneyAccountCode;
    creditAccountName = moneyAccountName;
  } else if (/\b(pinjam bank|pinjaman bank|utang bank|kredit bank)\b/.test(lower)) {
    type = 'capital';
    category = 'Utang Bank';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '2003';
    creditAccountName = 'Utang Bank';
  }

  // ── C. PENDAPATAN (9 Akun Pendapatan) ──
  else if (/\b(terima sewa|pendapatan sewa|penyewaan aset|sewa gedung diterima)\b/.test(lower)) {
    type = 'sale';
    category = 'Pendapatan Sewa';
    debitAccountCode = paymentMethod === 'credit' ? '1004' : moneyAccountCode;
    debitAccountName = paymentMethod === 'credit' ? 'Piutang Usaha' : moneyAccountName;
    creditAccountCode = '4002';
    creditAccountName = 'Pendapatan Sewa';
  } else if (/\b(bunga bank|pendapatan bunga|bunga tabungan|jasa giro)\b/.test(lower)) {
    type = 'sale';
    category = 'Pendapatan Bunga';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '4003';
    creditAccountName = 'Pendapatan Bunga';
  } else if (/\b(komisi|fee perantara|pendapatan komisi|makelar)\b/.test(lower)) {
    type = 'sale';
    category = 'Pendapatan Komisi';
    debitAccountCode = paymentMethod === 'credit' ? '1004' : moneyAccountCode;
    debitAccountName = paymentMethod === 'credit' ? 'Piutang Usaha' : moneyAccountName;
    creditAccountCode = '4004';
    creditAccountName = 'Pendapatan Komisi';
  } else if (/\b(royalti|pendapatan royalti|hak cipta)\b/.test(lower)) {
    type = 'sale';
    category = 'Pendapatan Royalti';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '4005';
    creditAccountName = 'Pendapatan Royalti';
  } else if (/\b(dividen|pendapatan dividen|bagi hasil saham)\b/.test(lower)) {
    type = 'sale';
    category = 'Pendapatan Dividen';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '4006';
    creditAccountName = 'Pendapatan Dividen';
  } else if (/\b(untung jual aset|keuntungan penjualan aset|jual aset lama)\b/.test(lower)) {
    type = 'sale';
    category = 'Keuntungan Penjualan Aset';
    debitAccountCode = moneyAccountCode;
    debitAccountName = moneyAccountName;
    creditAccountCode = '4009';
    creditAccountName = 'Keuntungan Penjualan Aset';
  } else if (
    /\b(jual|menjual|pendapatan jasa|orderan|pembayaran dari pelanggan|terima dari pelanggan|honor|fee jasa|fee konsultasi)\b/.test(lower) ||
    (/\b(jasa|servis|konsultasi|desain)\b/.test(lower) && !/\b(bayar|biaya|beban|perbaikan|reparasi|bengkel|servis ac|servis mobil|servis motor|servis laptop)\b/.test(lower))
  ) {
    type = 'sale';
    category = 'Pendapatan Jasa';
    debitAccountCode = paymentMethod === 'credit' ? '1004' : moneyAccountCode;
    debitAccountName = paymentMethod === 'credit' ? 'Piutang Usaha' : moneyAccountName;
    creditAccountCode = '4001';
    creditAccountName = 'Pendapatan Jasa';
  }

  // ── D. PEMBELIAN ASET TETAP & ASET LAINNYA ──
  else if (/\b(beli tanah|tanah kavling)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1101';
    debitAccountName = 'Tanah';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  } else if (/\b(beli bangunan|beli gedung|bangun gedung|renovasi gedung)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1102';
    debitAccountName = 'Bangunan';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  } else if (/\b(beli mobil|beli motor|beli kendaraan|kendaraan operasional)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1103';
    debitAccountName = 'Kendaraan';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  } else if (/\b(beli laptop|beli komputer|beli printer|beli peralatan|peralatan kantor)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1104';
    debitAccountName = 'Peralatan';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  } else if (/\b(beli meja|beli kursi|beli lemari|inventaris kantor)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1105';
    debitAccountName = 'Inventaris Kantor';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  } else if (/\b(beli mesin|mesin fotocopy|genset)\b/.test(lower)) {
    type = 'purchase';
    category = 'Aset Tetap';
    debitAccountCode = '1106';
    debitAccountName = 'Mesin';
    creditAccountCode = paymentMethod === 'credit' ? '2001' : moneyAccountCode;
    creditAccountName = paymentMethod === 'credit' ? 'Utang Usaha' : moneyAccountName;
  }

  // ── E. BEBAN OPERASIONAL (24 Akun Beban) ──
  else {
    type = 'expense';
    creditAccountCode = moneyAccountCode;
    creditAccountName = moneyAccountName;

    if (/\b(gaji|payroll|gaji staf|gaji pegawai|bayar karyawan)\b/.test(lower)) {
      category = 'Beban Gaji';
      debitAccountCode = '6001';
      debitAccountName = 'Beban Gaji';
    } else if (/\b(upah|tukang|lembur|harian|borongan)\b/.test(lower)) {
      category = 'Beban Upah';
      debitAccountCode = '6002';
      debitAccountName = 'Beban Upah';
    } else if (/\b(sewa|kontrak|sewa kantor|sewa ruko|sewa gedung|sewa tempat)\b/.test(lower)) {
      category = 'Beban Sewa';
      debitAccountCode = '6003';
      debitAccountName = 'Beban Sewa';
    } else if (/\b(listrik|token|pln|tagihan listrik)\b/.test(lower)) {
      category = 'Beban Listrik';
      debitAccountCode = '6004';
      debitAccountName = 'Beban Listrik';
    } else if (/\b(air|pdam|tagihan air|galon)\b/.test(lower)) {
      category = 'Beban Air';
      debitAccountCode = '6005';
      debitAccountName = 'Beban Air';
    } else if (/\b(telepon|pulsa telp|tagihan telkom)\b/.test(lower)) {
      category = 'Beban Telepon';
      debitAccountCode = '6006';
      debitAccountName = 'Beban Telepon';
    } else if (/\b(internet|wifi|indihome|biznet|kuota|paket data)\b/.test(lower)) {
      category = 'Beban Internet';
      debitAccountCode = '6007';
      debitAccountName = 'Beban Internet';
    } else if (/\b(bensin|bbm|pertalite|pertamax|solar|spbu)\b/.test(lower)) {
      category = 'Beban Bensin';
      debitAccountCode = '6009';
      debitAccountName = 'Beban Bensin';
    } else if (/\b(transport|transportasi|ojol|grab|gojek|taksi|tiket|tol|parkir)\b/.test(lower)) {
      category = 'Beban Transportasi';
      debitAccountCode = '6008';
      debitAccountName = 'Beban Transportasi';
    } else if (/\b(atk|kertas|hvs|pulpen|spidol|tinta|alat tulis|buku nota|stapler)\b/.test(lower)) {
      category = 'Beban ATK';
      debitAccountCode = '6014';
      debitAccountName = 'Beban ATK';
    } else if (/\b(perlengkapan|plastik|kresek|lakban|solasi|sapu|pel|sabun cuci|tisu)\b/.test(lower)) {
      category = 'Beban Perlengkapan';
      debitAccountCode = '6010';
      debitAccountName = 'Beban Perlengkapan';
    } else if (/\b(asuransi|premi asuransi|bpjs)\b/.test(lower)) {
      category = 'Beban Asuransi';
      debitAccountCode = '6012';
      debitAccountName = 'Beban Asuransi';
    } else if (/\b(iklan|promosi|ads|facebook ads|fb ads|google ads|instagram ads|ig ads|tiktok ads|endorse|brosur|spanduk|banner)\b/.test(lower)) {
      category = 'Beban Iklan';
      debitAccountCode = '6013';
      debitAccountName = 'Beban Iklan';
    } else if (/\b(pemeliharaan|maintenance|perawatan|cuci ac|cuci mobil)\b/.test(lower)) {
      category = 'Beban Pemeliharaan';
      debitAccountCode = '6015';
      debitAccountName = 'Beban Pemeliharaan';
    } else if (/\b(perbaikan|servis|reparasi|renovasi|bengkel|ganti sparepart|tambal ban)\b/.test(lower)) {
      category = 'Beban Perbaikan';
      debitAccountCode = '6016';
      debitAccountName = 'Beban Perbaikan';
    } else if (/\b(bunga bank|bunga pinjaman|bunga kredit)\b/.test(lower)) {
      category = 'Beban Bunga';
      debitAccountCode = '6017';
      debitAccountName = 'Beban Bunga';
    } else if (/\b(pajak|pph|ppn|pbb|pkb)\b/.test(lower)) {
      category = 'Beban Pajak';
      debitAccountCode = '6018';
      debitAccountName = 'Beban Pajak';
    } else if (/\b(admin bank|biaya admin|biaya transfer|materai|administrasi)\b/.test(lower)) {
      category = 'Beban Administrasi';
      debitAccountCode = '6019';
      debitAccountName = 'Beban Administrasi';
    } else if (/\b(konsumsi|makan|minum|snack|kopi|catering|makan siang|nasi kotak)\b/.test(lower)) {
      category = 'Beban Konsumsi';
      debitAccountCode = '6020';
      debitAccountName = 'Beban Konsumsi';
    } else if (/\b(perjalanan dinas|dinas luar|hotel dinas|sppd)\b/.test(lower)) {
      category = 'Beban Perjalanan Dinas';
      debitAccountCode = '6021';
      debitAccountName = 'Beban Perjalanan Dinas';
    } else if (/\b(pengiriman|ekspedisi|jne|jnt|j&t|sicepat|pos|ongkir dokumen)\b/.test(lower)) {
      category = 'Beban Pengiriman';
      debitAccountCode = '6022';
      debitAccountName = 'Beban Pengiriman';
    } else if (/\b(kerugian piutang|piutang macet|piutang tak tertagih)\b/.test(lower)) {
      category = 'Beban Kerugian Piutang';
      debitAccountCode = '6023';
      debitAccountName = 'Beban Kerugian Piutang';
    } else if (/\b(penyusutan|depresiasi)\b/.test(lower)) {
      category = 'Beban Penyusutan';
      debitAccountCode = '6011';
      debitAccountName = 'Beban Penyusutan';
    } else {
      category = 'Beban Lain-lain';
      debitAccountCode = '6024';
      debitAccountName = 'Beban Lain-lain';
    }
  }

  // 5. Contact Detection
  let contactName = null;
  let contactType = type === 'sale' ? 'customer' : 'supplier';

  const contactMatch = text.match(/(?:dari|kepada|ke|oleh|pelanggan|pemasok)\s+([A-Za-z0-9_]{2,25})(?=\s+(?:sebesar|seharga|nominal|menggunakan|melalui|pembayaran|secara|dengan|cash|qris|transfer|tunai|bank|\d|$))/i);
  if (contactMatch) {
    const rawContact = contactMatch[1].trim();
    const blacklist = ['pelanggan', 'pemasok', 'toko', 'bank', 'kas', 'rekening', 'saya', 'membeli', 'bahan', 'uang', 'karyawan'];
    if (!blacklist.includes(rawContact.toLowerCase())) {
      contactName = rawContact.charAt(0).toUpperCase() + rawContact.slice(1);
    }
  }

  // 6. Clean Meaningful Description
  let cleanDesc = text
    .replace(/(?:sebesar|nominal|seharga|rp\.?)\s*\d{1,3}(?:\.\d{3})+/gi, '')
    .replace(/(?:sebesar|nominal|seharga|rp\.?)\s*\d+(?:[.,]\d+)?\s*(rb|ribu|k|jt|juta)?/gi, '')
    .replace(/\b(cash|tunai|qris|transfer bank|transfer|rekening|kredit|tempo)\b/gi, '')
    .replace(/\b(menggunakan|melalui|secara|dengan pembayaran|pembayaran)\b/gi, '');

  if (matchedDateStr) {
    cleanDesc = cleanDesc.replace(new RegExp(matchedDateStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  cleanDesc = cleanDesc.replace(/\s+/g, ' ').trim();

  if (!cleanDesc || cleanDesc.length < 4) {
    cleanDesc = category;
  }

  return {
    rawText: text,
    description: cleanDesc,
    category,
    type,
    amount,
    quantity,
    unitPrice,
    paymentMethod,
    contactName,
    contactType,
    productName: null,
    debitAccountCode,
    debitAccountName,
    creditAccountCode,
    creditAccountName,
    transactionDate,
    status: paymentMethod === 'credit' ? 'unpaid' : 'paid',
  };
}
