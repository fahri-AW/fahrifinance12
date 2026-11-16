import pg from 'pg';
import 'dotenv/config';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Businesses / Tenants
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        owner_name VARCHAR(100),
        address TEXT,
        phone VARCHAR(30),
        currency VARCHAR(10) DEFAULT 'IDR',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'staff', 'viewer')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Accounts (Chart of Accounts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        code VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(30) NOT NULL,
        normal_balance VARCHAR(10) NOT NULL DEFAULT 'debit' CHECK (normal_balance IN ('debit', 'credit')),
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    // Upgrade accounts table if columns missing
    await client.query(`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS normal_balance VARCHAR(10) DEFAULT 'debit';
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    `);

    // 4. Contacts (Customers & Suppliers)
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        type VARCHAR(20) NOT NULL CHECK (type IN ('customer', 'supplier', 'both')),
        phone VARCHAR(30),
        email VARCHAR(100),
        address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 5. Products / Jasa (Katalog Layanan/Aset)
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        category VARCHAR(80) DEFAULT 'Jasa',
        buy_price NUMERIC(15,2) NOT NULL DEFAULT 0,
        sell_price NUMERIC(15,2) NOT NULL DEFAULT 0,
        stock_quantity INTEGER NOT NULL DEFAULT 0,
        min_stock INTEGER NOT NULL DEFAULT 0,
        unit VARCHAR(20) NOT NULL DEFAULT 'layanan',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 6. Transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        invoice_number VARCHAR(50),
        description TEXT NOT NULL,
        category VARCHAR(100) NOT NULL,
        transaction_type VARCHAR(30) NOT NULL,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_method VARCHAR(20) NOT NULL,
        payment_status VARCHAR(20) NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid', 'unpaid', 'partial')),
        transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Upgrade transactions table if columns missing
    await client.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50);
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'paid';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    // 7. Transaction Items
    await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_items (
        id BIGSERIAL PRIMARY KEY,
        transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        description VARCHAR(200) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
        subtotal NUMERIC(15,2) NOT NULL DEFAULT 0
      );
    `);

    // 8. Journal Entries
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id BIGSERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        entry_number VARCHAR(50),
        debit NUMERIC(15,2) NOT NULL DEFAULT 0,
        credit NUMERIC(15,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'draft', 'reversed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (debit >= 0 AND credit >= 0),
        CHECK (NOT (debit > 0 AND credit > 0))
      );
    `);

    // Upgrade journal_entries table if columns missing
    await client.query(`
      ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
      ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS entry_number VARCHAR(50);
      ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'posted';
    `);

    // 9. Receivables and Payables (Piutang & Utang)
    await client.query(`
      CREATE TABLE IF NOT EXISTS receivables_payables (
        id BIGSERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        transaction_id BIGINT REFERENCES transactions(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        type VARCHAR(20) NOT NULL CHECK (type IN ('receivable', 'payable')),
        total_amount NUMERIC(15,2) NOT NULL CHECK (total_amount > 0),
        paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
        remaining_amount NUMERIC(15,2) NOT NULL CHECK (remaining_amount >= 0),
        due_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partial', 'paid')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 10. Audit Logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(50) NOT NULL,
        entity VARCHAR(50) NOT NULL,
        entity_id BIGINT,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
      CREATE INDEX IF NOT EXISTS idx_journal_transaction ON journal_entries(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_entries(account_id);
      CREATE INDEX IF NOT EXISTS idx_rp_type ON receivables_payables(type);
    `);

    // ── Seed Default Business ──
    const bizRes = await client.query(`
      INSERT INTO businesses (id, name, owner_name, address, phone, currency)
      VALUES (1, 'FinanceFlow General Company', 'Owner Usaha', 'Jl. Jenderal Sudirman No. 10, Jakarta', '0812-3456-7890', 'IDR')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id;
    `);
    const defaultBizId = bizRes.rows[0].id;

    // ── Seed Default Owner & Admin User ──
    const hash = await bcrypt.hash('admin123', 10);
    await client.query(`
      INSERT INTO users (business_id, email, password_hash, full_name, role)
      VALUES ($1, 'admin@financeflow.local', $2, 'Administrator', 'owner')
      ON CONFLICT (email) DO NOTHING;
    `, [defaultBizId, hash]);

    // ── DAFTAR AKUN STANDAR UMUM PERUSAHAAN (79 AKUN RESMI) ──
    const accounts = [
      // 1. Akun Aset (Harta) (1xxx)
      ["1001", "Kas", "asset", "debit", "Uang tunai yang dimiliki perusahaan."],
      ["1002", "Kas Kecil", "asset", "debit", "Dana untuk pengeluaran operasional dalam jumlah kecil."],
      ["1003", "Kas di Bank", "asset", "debit", "Uang perusahaan yang disimpan di bank."],
      ["1004", "Piutang Usaha", "asset", "debit", "Tagihan kepada pelanggan."],
      ["1005", "Piutang Wesel", "asset", "debit", "Tagihan yang disertai surat perjanjian tertulis."],
      ["1006", "Piutang Karyawan", "asset", "debit", "Pinjaman yang diberikan kepada karyawan."],
      ["1007", "Perlengkapan", "asset", "debit", "Barang habis pakai untuk kegiatan perusahaan."],
      ["1008", "Sewa Dibayar di Muka", "asset", "debit", "Pembayaran sewa untuk periode mendatang."],
      ["1009", "Asuransi Dibayar di Muka", "asset", "debit", "Premi asuransi yang telah dibayar untuk periode mendatang."],
      ["1010", "Iklan Dibayar di Muka", "asset", "debit", "Biaya iklan yang telah dibayar sebelum iklan digunakan."],
      ["1101", "Tanah", "asset_fixed", "debit", "Tanah yang dimiliki perusahaan."],
      ["1102", "Bangunan", "asset_fixed", "debit", "Gedung atau bangunan milik perusahaan."],
      ["1103", "Kendaraan", "asset_fixed", "debit", "Kendaraan untuk kegiatan operasional."],
      ["1104", "Peralatan", "asset_fixed", "debit", "Alat yang digunakan untuk kegiatan perusahaan."],
      ["1105", "Inventaris Kantor", "asset_fixed", "debit", "Meja, kursi, lemari, dan perlengkapan kantor lainnya."],
      ["1106", "Mesin", "asset_fixed", "debit", "Mesin yang digunakan untuk kegiatan operasional."],
      ["1107", "Akumulasi Penyusutan", "contra_asset", "credit", "Total penyusutan aset tetap selama masa penggunaannya."],
      ["1201", "Investasi Jangka Panjang", "asset", "debit", "Penanaman dana untuk memperoleh keuntungan jangka panjang."],
      ["1202", "Aset Tak Berwujud", "asset", "debit", "Aset nonfisik seperti hak paten dan merek dagang."],
      ["1203", "Goodwill", "asset", "debit", "Nilai lebih yang timbul dari akuisisi perusahaan."],

      // 2. Akun Liabilitas (Utang) (2xxx)
      ["2001", "Utang Usaha", "liability", "credit", "Utang kepada pemasok atau pihak lain."],
      ["2002", "Utang Wesel", "liability", "credit", "Utang yang disertai surat perjanjian tertulis."],
      ["2003", "Utang Bank", "liability", "credit", "Pinjaman perusahaan dari bank."],
      ["2004", "Utang Gaji", "liability", "credit", "Gaji karyawan yang belum dibayarkan."],
      ["2005", "Utang Listrik", "liability", "credit", "Tagihan listrik yang belum dibayar."],
      ["2006", "Utang Air", "liability", "credit", "Tagihan air yang belum dibayar."],
      ["2007", "Utang Telepon", "liability", "credit", "Tagihan telepon yang belum dibayar."],
      ["2008", "Utang Pajak", "liability", "credit", "Kewajiban pajak yang belum dibayarkan."],
      ["2009", "Utang Bunga", "liability", "credit", "Bunga pinjaman yang belum dibayar."],
      ["2010", "Utang Sewa", "liability", "credit", "Kewajiban pembayaran sewa."],
      ["2011", "Pendapatan Diterima di Muka", "liability", "credit", "Uang yang diterima sebelum jasa diberikan."],
      ["2012", "Uang Muka Pelanggan", "liability", "credit", "Pembayaran awal yang diterima dari pelanggan."],
      ["2101", "Utang Hipotek", "liability", "credit", "Pinjaman jangka panjang dengan jaminan aset."],
      ["2102", "Utang Obligasi", "liability", "credit", "Utang perusahaan kepada pemegang obligasi."],
      ["2103", "Liabilitas Imbalan Kerja", "liability", "credit", "Kewajiban perusahaan atas manfaat karyawan."],

      // 3. Akun Ekuitas (Modal) (3xxx)
      ["3001", "Modal Pemilik", "equity", "credit", "Dana yang ditanamkan pemilik ke perusahaan."],
      ["3002", "Modal Saham", "equity", "credit", "Modal yang diperoleh dari penerbitan saham."],
      ["3003", "Tambahan Modal Disetor", "equity", "credit", "Setoran pemegang saham di luar nilai nominal saham."],
      ["3004", "Prive", "equity", "debit", "Pengambilan uang atau aset perusahaan untuk kepentingan pribadi pemilik."],
      ["3005", "Laba Ditahan", "equity", "credit", "Laba yang tidak dibagikan kepada pemegang saham."],
      ["3006", "Saldo Laba", "equity", "credit", "Akumulasi laba atau rugi perusahaan."],
      ["3007", "Cadangan Modal", "equity", "credit", "Bagian modal yang disisihkan untuk tujuan tertentu."],
      ["3008", "Laba Tahun Berjalan", "equity", "credit", "Keuntungan yang diperoleh selama periode berjalan."],
      ["3009", "Rugi Tahun Berjalan", "equity", "debit", "Kerugian yang dialami selama periode berjalan."],
      ["3010", "Agio Saham", "equity", "credit", "Kelebihan harga jual saham di atas nilai nominal."],
      ["3011", "Disagio Saham", "equity", "debit", "Kekurangan harga jual saham di bawah nilai nominal."],

      // 4. Akun Pendapatan (4xxx)
      ["4001", "Pendapatan Jasa", "revenue", "credit", "Penghasilan dari pemberian jasa kepada pelanggan."],
      ["4002", "Pendapatan Sewa", "revenue", "credit", "Penghasilan dari penyewaan aset."],
      ["4003", "Pendapatan Bunga", "revenue", "credit", "Penghasilan yang diperoleh dari bunga."],
      ["4004", "Pendapatan Komisi", "revenue", "credit", "Penghasilan dari pemberian jasa perantara."],
      ["4005", "Pendapatan Royalti", "revenue", "credit", "Penghasilan dari penggunaan hak kekayaan intelektual."],
      ["4006", "Pendapatan Dividen", "revenue", "credit", "Penghasilan dari investasi saham."],
      ["4007", "Pendapatan Administrasi", "revenue", "credit", "Penghasilan dari biaya administrasi."],
      ["4008", "Pendapatan Lain-lain", "revenue", "credit", "Penghasilan di luar kegiatan utama perusahaan."],
      ["4009", "Keuntungan Penjualan Aset", "revenue", "credit", "Keuntungan dari penjualan aset perusahaan."],

      // 5. Akun Beban (6xxx)
      ["6001", "Beban Gaji", "expense", "debit", "Biaya pembayaran gaji karyawan."],
      ["6002", "Beban Upah", "expense", "debit", "Biaya tenaga kerja berdasarkan pekerjaan atau waktu."],
      ["6003", "Beban Sewa", "expense", "debit", "Biaya penggunaan tempat atau bangunan."],
      ["6004", "Beban Listrik", "expense", "debit", "Biaya penggunaan listrik."],
      ["6005", "Beban Air", "expense", "debit", "Biaya penggunaan air."],
      ["6006", "Beban Telepon", "expense", "debit", "Biaya penggunaan layanan telepon."],
      ["6007", "Beban Internet", "expense", "debit", "Biaya penggunaan internet."],
      ["6008", "Beban Transportasi", "expense", "debit", "Biaya perjalanan dan transportasi operasional."],
      ["6009", "Beban Bensin", "expense", "debit", "Biaya bahan bakar kendaraan."],
      ["6010", "Beban Perlengkapan", "expense", "debit", "Biaya perlengkapan yang telah digunakan."],
      ["6011", "Beban Penyusutan", "expense", "debit", "Biaya penyusutan aset tetap."],
      ["6012", "Beban Asuransi", "expense", "debit", "Biaya asuransi yang telah menjadi beban."],
      ["6013", "Beban Iklan", "expense", "debit", "Biaya promosi dan pemasaran."],
      ["6014", "Beban ATK", "expense", "debit", "Biaya alat tulis kantor."],
      ["6015", "Beban Pemeliharaan", "expense", "debit", "Biaya perawatan aset perusahaan."],
      ["6016", "Beban Perbaikan", "expense", "debit", "Biaya memperbaiki aset perusahaan."],
      ["6017", "Beban Bunga", "expense", "debit", "Biaya bunga atas pinjaman."],
      ["6018", "Beban Pajak", "expense", "debit", "Pajak yang menjadi beban perusahaan."],
      ["6019", "Beban Administrasi", "expense", "debit", "Biaya administrasi perusahaan."],
      ["6020", "Beban Konsumsi", "expense", "debit", "Biaya makanan dan minuman untuk kegiatan perusahaan."],
      ["6021", "Beban Perjalanan Dinas", "expense", "debit", "Biaya perjalanan untuk kepentingan pekerjaan."],
      ["6022", "Beban Pengiriman", "expense", "debit", "Biaya pengiriman barang atau dokumen."],
      ["6023", "Beban Kerugian Piutang", "expense", "debit", "Kerugian akibat piutang yang tidak tertagih."],
      ["6024", "Beban Lain-lain", "expense", "debit", "Biaya lain yang tidak termasuk kategori khusus."]
    ];

    for (const [code, name, type, normal_balance, description] of accounts) {
      await client.query(`
        INSERT INTO accounts (business_id, code, name, type, normal_balance, description)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name,
            type = EXCLUDED.type,
            normal_balance = EXCLUDED.normal_balance,
            description = EXCLUDED.description;
      `, [defaultBizId, code, name, type, normal_balance, description]);
    }

    await client.query('COMMIT');
    console.log('✅ Database FinanceFlow Enterprise siap: 79 akun standar umum perusahaan terverifikasi.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Inisialisasi Database Gagal:', error);
    throw error;
  } finally {
    client.release();
  }
}
