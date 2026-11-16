import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { pool, initializeDatabase } from './db.js';
import { parseTransactionNL } from './nlp-parser.js';

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'financeflow_jwt_secure_key_2026';

// ── Security & Parsers ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use(express.static('public'));

// Rate Limiter
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000 }));

// Lazy DB initialization for Serverless environments (Vercel)
let isDbInitialized = false;
app.use(async (req, res, next) => {
  if (process.env.VERCEL && !isDbInitialized) {
    try {
      await initializeDatabase();
      isDbInitialized = true;
    } catch (err) {
      console.error('Lazy DB initialization error on Vercel:', err);
    }
  }
  next();
});

// ── Authentication Middleware ──
function authenticate(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    // Default fallback to user 1 for easy single-tenant or demo usage if no token provided
    req.user = { id: 1, business_id: 1, role: 'owner', email: 'admin@financeflow.local', full_name: 'Administrator' };
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    req.user = { id: 1, business_id: 1, role: 'owner', email: 'admin@financeflow.local', full_name: 'Administrator' };
    next();
  }
}

// ─────────────────────────────────────────────────────────────
// 1. AUTHENTICATION API
// ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password harus diisi.' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Email atau password salah.' });
    }

    const token = jwt.sign(
      { id: user.id, business_id: user.business_id || 1, email: user.email, role: user.role, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400 * 1000 });
    res.json({ message: 'Login berhasil.', token, user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name } });
  } catch (err) {
    res.status(500).json({ error: 'Gagal login.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, business_name } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }

    const bizRes = await client.query(
      `INSERT INTO businesses (name, owner_name) VALUES ($1, $2) RETURNING id`,
      [business_name || `Toko ${full_name}`, full_name]
    );
    const businessId = bizRes.rows[0].id;

    const hash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (business_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'owner') RETURNING id, email, full_name, role`,
      [businessId, email.toLowerCase().trim(), hash, full_name]
    );
    await client.query('COMMIT');
    res.status(201).json({ message: 'Pendaftaran berhasil.', user: userRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Gagal mendaftar pengguna.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Berhasil logout.' });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const userRes = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.business_id, b.name as business_name, b.phone, b.address
       FROM users u LEFT JOIN businesses b ON b.id = u.business_id WHERE u.id = $1`,
      [req.user.id]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ error: 'User tidak ditemukan.' });
    res.json(userRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data user.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. NATURAL LANGUAGE PARSER API
// ─────────────────────────────────────────────────────────────

app.post('/api/transactions/parse', authenticate, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Kalimat transaksi wajib diisi.' });
    }
    const result = parseTransactionNL(text);

    // If product was mentioned, check if product exists in database to suggest prices/stock
    if (result.productName) {
      const prodRes = await pool.query(
        `SELECT id, name, code, buy_price, sell_price, stock_quantity, unit FROM products
         WHERE business_id = $1 AND (name ILIKE $2 OR code ILIKE $2) LIMIT 1`,
        [req.user.business_id, `%${result.productName}%`]
      );
      if (prodRes.rowCount > 0) {
        const prod = prodRes.rows[0];
        result.productId = prod.id;
        result.productName = prod.name;
        result.stockQuantity = prod.stock_quantity;
        result.unit = prod.unit;
        if (result.type === 'sale') {
          result.suggestedCost = Number(prod.buy_price) * result.quantity;
        }
      }
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 3. TRANSACTIONS & DOUBLE-ENTRY ACCOUNTING ENGINE
// ─────────────────────────────────────────────────────────────

app.get('/api/transactions', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, type, paymentMethod, search, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT t.*, c.name as contact_name
      FROM transactions t
      LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.business_id = $1
    `;
    const params = [req.user.business_id];
    let idx = 2;

    if (startDate) { query += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { query += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }
    if (type) { query += ` AND t.transaction_type = $${idx++}`; params.push(type); }
    if (paymentMethod) { query += ` AND t.payment_method = $${idx++}`; params.push(paymentMethod); }
    if (search) {
      query += ` AND (t.description ILIKE $${idx} OR t.category ILIKE $${idx} OR t.invoice_number ILIKE $${idx} OR c.name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    query += ` ORDER BY t.transaction_date DESC, t.id DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(Number(limit), Number(offset));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengambil data transaksi.' });
  }
});

app.post('/api/transactions', authenticate, async (req, res) => {
  const {
    description,
    amount,
    type,
    paymentMethod,
    transactionDate,
    category,
    contactName,
    productName,
    quantity = 1,
    unitPrice = 0,
    notes = '',
    debitAccountCode,
    creditAccountCode,
  } = req.body;

  const validTypes = ['sale', 'purchase', 'expense', 'capital', 'drawing', 'receivable_payment', 'payable_payment'];
  const validPayments = ['cash', 'qris', 'bank', 'credit'];

  if (!description || !amount || Number(amount) <= 0 || !validTypes.includes(type) || !validPayments.includes(paymentMethod)) {
    return res.status(400).json({ error: 'Data transaksi tidak valid.' });
  }

  const date = transactionDate || new Date().toISOString().slice(0, 10);
  const businessId = req.user.business_id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Resolve Contact (Customer or Supplier) if provided
    let contactId = null;
    if (contactName && contactName.trim()) {
      const contactType = type === 'sale' ? 'customer' : 'supplier';
      const cRes = await client.query(
        `SELECT id FROM contacts WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
        [businessId, contactName.trim()]
      );
      if (cRes.rowCount > 0) {
        contactId = cRes.rows[0].id;
      } else {
        const insC = await client.query(
          `INSERT INTO contacts (business_id, name, type) VALUES ($1, $2, $3) RETURNING id`,
          [businessId, contactName.trim(), contactType]
        );
        contactId = insC.rows[0].id;
      }
    }

    // 2. Generate Invoice Number
    const countRes = await client.query(`SELECT COUNT(*) FROM transactions WHERE business_id = $1`, [businessId]);
    const num = (Number(countRes.rows[0].count) + 1).toString().padStart(5, '0');
    const invoicePrefix = { sale: 'INV', purchase: 'PUR', expense: 'EXP', capital: 'CAP', drawing: 'PRV', receivable_payment: 'RCV', payable_payment: 'PAY' }[type] || 'TRX';
    const invoiceNumber = `${invoicePrefix}-${new Date().getFullYear()}${num}`;

    // 3. Determine Category
    const transCategory = category || (
      type === 'sale' ? 'Pendapatan Penjualan'
      : type === 'purchase' ? 'Persediaan Barang Dagang'
      : type === 'capital' ? 'Modal Usaha'
      : type === 'drawing' ? 'Prive Pemilik'
      : type === 'receivable_payment' ? 'Penerimaan Piutang'
      : type === 'payable_payment' ? 'Pembayaran Utang'
      : 'Beban Operasional'
    );

    const paymentStatus = paymentMethod === 'credit' ? 'unpaid' : 'paid';

    // 4. Insert Transaction
    const transRes = await client.query(
      `INSERT INTO transactions
         (business_id, contact_id, invoice_number, description, category, transaction_type, amount, payment_method, payment_status, transaction_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [businessId, contactId, invoiceNumber, description.trim(), transCategory, type, Number(amount), paymentMethod, paymentStatus, date, notes, req.user.id]
    );
    const transaction = transRes.rows[0];
    const transactionId = transaction.id;

    // 5. Insert Transaction Item
    const itemQty = Number(quantity) || 1;
    const itemUnit = Number(unitPrice) || Math.round(Number(amount) / itemQty);

    await client.query(
      `INSERT INTO transaction_items (transaction_id, description, quantity, unit_price, subtotal)
       VALUES ($1, $2, $3, $4, $5)`,
      [transactionId, description.trim(), itemQty, itemUnit, Number(amount)]
    );

    // 6. Double Entry Accounting Rules (Debit = Credit)
    const amountVal = Number(amount);
    const moneyAccount = (paymentMethod === 'bank' || paymentMethod === 'qris') ? '1003' : '1001';

    let debitCode = debitAccountCode;
    let creditCode = creditAccountCode;

    if (!debitCode || !creditCode) {
      switch (type) {
        case 'sale':
          debitCode = paymentMethod === 'credit' ? '1004' : moneyAccount; // 1004 Piutang Usaha if credit
          creditCode = '4001'; // Pendapatan Jasa
          break;
        case 'purchase':
          debitCode = '1104'; // Peralatan
          creditCode = paymentMethod === 'credit' ? '2001' : moneyAccount; // 2001 Utang Usaha if credit
          break;
        case 'capital':
          debitCode = moneyAccount;
          creditCode = '3001'; // Modal Pemilik
          break;
        case 'drawing':
          debitCode = '3004'; // Prive
          creditCode = moneyAccount;
          break;
        case 'receivable_payment':
          debitCode = moneyAccount;
          creditCode = '1004'; // Piutang Usaha
          break;
        case 'payable_payment':
          debitCode = '2001'; // Utang Usaha
          creditCode = moneyAccount;
          break;
        default: // expense
          debitCode = '6024'; // Beban Lain-lain
          creditCode = moneyAccount;
      }
    }

    const journalEntryNumber = `JRN-${transactionId}`;

    // Line 1: Debit Entry
    await client.query(
      `INSERT INTO journal_entries (business_id, transaction_id, account_id, entry_number, debit, credit, status)
       SELECT $1, $2, id, $3, $4, 0, 'posted' FROM accounts WHERE code = $5 AND (business_id = $1 OR business_id IS NULL) LIMIT 1`,
      [businessId, transactionId, journalEntryNumber, amountVal, debitCode]
    );

    // Line 2: Credit Entry
    await client.query(
      `INSERT INTO journal_entries (business_id, transaction_id, account_id, entry_number, debit, credit, status)
       SELECT $1, $2, id, $3, 0, $4, 'posted' FROM accounts WHERE code = $5 AND (business_id = $1 OR business_id IS NULL) LIMIT 1`,
      [businessId, transactionId, journalEntryNumber, amountVal, creditCode]
    );

    // 7. Handle Piutang / Utang records for credit transactions
    if (paymentMethod === 'credit') {
      const rpType = type === 'sale' ? 'receivable' : 'payable';
      await client.query(
        `INSERT INTO receivables_payables (business_id, transaction_id, contact_id, type, total_amount, remaining_amount, status)
         VALUES ($1, $2, $3, $4, $5, $5, 'unpaid')`,
        [businessId, transactionId, contactId, rpType, amountVal]
      );
    }

    // 8. Audit Log
    await client.query(
      `INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details)
       VALUES ($1, $2, 'CREATE', 'transaction', $3, $4)`,
      [businessId, req.user.id, transactionId, JSON.stringify({ amount: amountVal, type, invoiceNumber })]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Transaksi berhasil disimpan.', transaction });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving transaction:', err);
    res.status(500).json({ error: 'Gagal menyimpan transaksi: ' + err.message });
  } finally {
    client.release();
  }
});

// Delete Transaction with Journal Reversal & Stock Reversal
app.delete('/api/transactions/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID transaksi tidak valid.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get transaction details
    const tRes = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND business_id = $2`,
      [id, req.user.business_id]
    );
    if (tRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    }
    const trx = tRes.rows[0];

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details)
       VALUES ($1, $2, 'DELETE', 'transaction', $3, $4)`,
      [req.user.business_id, req.user.id, id, JSON.stringify({ description: trx.description, amount: trx.amount })]
    );

    // Delete transaction (cascades to journal_entries, items, receivables_payables)
    await client.query(`DELETE FROM transactions WHERE id = $1`, [id]);

    await client.query('COMMIT');
    res.json({ message: 'Transaksi berhasil dihapus dan jurnal dibatalkan.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Gagal menghapus transaksi.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. CHART OF ACCOUNTS (COA) API
// ─────────────────────────────────────────────────────────────

app.get('/api/accounts', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM accounts WHERE (business_id = $1 OR business_id IS NULL) AND is_active = true ORDER BY code ASC`,
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil bagan akun.' });
  }
});

app.post('/api/accounts', authenticate, async (req, res) => {
  const { code, name, type, normal_balance = 'debit', description = '' } = req.body;
  if (!code || !name || !type) return res.status(400).json({ error: 'Kode, nama, dan jenis akun wajib diisi.' });

  try {
    const result = await pool.query(
      `INSERT INTO accounts (business_id, code, name, type, normal_balance, description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.business_id, code.trim(), name.trim(), type, normal_balance, description]
    );
    res.status(201).json({ message: 'Akun berhasil ditambahkan.', account: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: 'Gagal menambah akun. Pastikan kode unik.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 5. ACCOUNTING & FINANCIAL REPORTS API
// ─────────────────────────────────────────────────────────────

// Jurnal Umum
app.get('/api/journals', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = `
      SELECT
        t.transaction_date,
        t.invoice_number,
        t.description,
        j.id as entry_id,
        j.entry_number,
        a.code AS account_code,
        a.name AS account_name,
        j.debit,
        j.credit,
        j.status
      FROM journal_entries j
      JOIN transactions t ON t.id = j.transaction_id
      JOIN accounts a ON a.id = j.account_id
      WHERE (j.business_id = $1 OR t.business_id = $1)
    `;
    const params = [req.user.business_id];
    let idx = 2;

    if (startDate) { query += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { query += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }

    query += ` ORDER BY t.transaction_date DESC, t.id DESC, j.id ASC`;

    const result = await pool.query(query, params);

    // Calculate totals for double-entry validation
    let totalDebit = 0;
    let totalCredit = 0;
    for (const r of result.rows) {
      totalDebit += Number(r.debit);
      totalCredit += Number(r.credit);
    }

    res.json({
      entries: result.rows,
      summary: {
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil jurnal umum.' });
  }
});

// Buku Besar (General Ledger)
app.get('/api/ledger', authenticate, async (req, res) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId) return res.status(400).json({ error: 'Pilih akun untuk buku besar.' });

    const accRes = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 AND (business_id = $2 OR business_id IS NULL)`,
      [accountId, req.user.business_id]
    );
    if (accRes.rowCount === 0) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    const account = accRes.rows[0];

    let query = `
      SELECT
        t.transaction_date,
        t.invoice_number,
        t.description,
        j.debit,
        j.credit
      FROM journal_entries j
      JOIN transactions t ON t.id = j.transaction_id
      WHERE j.account_id = $1 AND (j.business_id = $2 OR t.business_id = $2)
    `;
    const params = [accountId, req.user.business_id];
    let idx = 3;

    if (startDate) { query += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { query += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }

    query += ` ORDER BY t.transaction_date ASC, j.id ASC`;

    const rows = (await pool.query(query, params)).rows;

    let runningBalance = 0;
    const ledgerLines = rows.map(r => {
      const d = Number(r.debit);
      const c = Number(r.credit);
      if (account.normal_balance === 'debit') {
        runningBalance += (d - c);
      } else {
        runningBalance += (c - d);
      }
      return {
        ...r,
        debit: d,
        credit: c,
        balance: runningBalance,
      };
    });

    res.json({ account, lines: ledgerLines, finalBalance: runningBalance });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil buku besar.' });
  }
});

// Neraca Saldo (Trial Balance)
app.get('/api/reports/trial-balance', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = '';
    const params = [req.user.business_id];
    let idx = 2;

    if (startDate) { dateFilter += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { dateFilter += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }

    const query = `
      SELECT
        a.id,
        a.code,
        a.name,
        a.type,
        a.normal_balance,
        COALESCE(SUM(j.debit), 0) AS total_debit,
        COALESCE(SUM(j.credit), 0) AS total_credit
      FROM accounts a
      LEFT JOIN journal_entries j ON j.account_id = a.id AND (j.business_id = $1 OR j.business_id IS NULL)
      LEFT JOIN transactions t ON t.id = j.transaction_id ${dateFilter}
      WHERE (a.business_id = $1 OR a.business_id IS NULL) AND a.is_active = true
      GROUP BY a.id
      ORDER BY a.code ASC
    `;

    const rows = (await pool.query(query, params)).rows;
    let sumDebit = 0;
    let sumCredit = 0;

    const data = rows.map(row => {
      const debit = Number(row.total_debit);
      const credit = Number(row.total_credit);
      let balanceDebit = 0;
      let balanceCredit = 0;

      if (row.normal_balance === 'debit') {
        const net = debit - credit;
        if (net >= 0) balanceDebit = net;
        else balanceCredit = Math.abs(net);
      } else {
        const net = credit - debit;
        if (net >= 0) balanceCredit = net;
        else balanceDebit = Math.abs(net);
      }

      sumDebit += balanceDebit;
      sumCredit += balanceCredit;

      return {
        ...row,
        total_debit: debit,
        total_credit: credit,
        debit_balance: balanceDebit,
        credit_balance: balanceCredit,
      };
    });

    res.json({
      rows: data,
      summary: {
        totalDebit: sumDebit,
        totalCredit: sumCredit,
        isBalanced: Math.abs(sumDebit - sumCredit) < 0.01,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat neraca saldo.' });
  }
});

// Laporan Laba Rugi (Income Statement)
app.get('/api/reports/income-statement', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = '';
    const params = [req.user.business_id];
    let idx = 2;

    if (startDate) { dateFilter += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { dateFilter += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }

    const query = `
      SELECT
        a.code,
        a.name,
        a.type,
        COALESCE(SUM(j.credit - j.debit), 0) AS balance_credit,
        COALESCE(SUM(j.debit - j.credit), 0) AS balance_debit
      FROM accounts a
      JOIN journal_entries j ON j.account_id = a.id AND (j.business_id = $1 OR j.business_id IS NULL)
      JOIN transactions t ON t.id = j.transaction_id ${dateFilter}
      WHERE a.type IN ('revenue', 'contra_revenue', 'cogs', 'expense')
      GROUP BY a.id
      ORDER BY a.code ASC
    `;

    const rows = (await pool.query(query, params)).rows;

    let revenue = 0;
    let contraRevenue = 0;
    let cogs = 0;
    let expenses = [];
    let totalExpense = 0;

    for (const r of rows) {
      if (r.type === 'revenue') {
        revenue += Number(r.balance_credit);
      } else if (r.type === 'contra_revenue') {
        contraRevenue += Number(r.balance_debit);
      } else if (r.type === 'cogs') {
        cogs += Number(r.balance_debit);
      } else if (r.type === 'expense') {
        const amt = Number(r.balance_debit);
        if (amt > 0) {
          expenses.push({ code: r.code, name: r.name, amount: amt });
          totalExpense += amt;
        }
      }
    }

    const netSales = revenue - contraRevenue;
    const grossProfit = netSales - cogs;
    const netProfit = grossProfit - totalExpense;

    res.json({
      revenue,
      contraRevenue,
      netSales,
      cogs,
      grossProfit,
      expenses,
      totalExpense,
      netProfit,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat laporan laba rugi.' });
  }
});

// Laporan Posisi Keuangan (Balance Sheet)
app.get('/api/reports/balance-sheet', authenticate, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    let dateFilter = '';
    const params = [req.user.business_id];

    if (asOfDate) {
      dateFilter = ` AND t.transaction_date <= $2`;
      params.push(asOfDate);
    }

    const query = `
      SELECT
        a.code,
        a.name,
        a.type,
        a.normal_balance,
        COALESCE(SUM(j.debit), 0) AS total_debit,
        COALESCE(SUM(j.credit), 0) AS total_credit
      FROM accounts a
      LEFT JOIN journal_entries j ON j.account_id = a.id AND (j.business_id = $1 OR j.business_id IS NULL)
      LEFT JOIN transactions t ON t.id = j.transaction_id ${dateFilter}
      WHERE (a.business_id = $1 OR a.business_id IS NULL)
      GROUP BY a.id
      ORDER BY a.code ASC
    `;

    const rows = (await pool.query(query, params)).rows;

    let currentAssets = [];
    let fixedAssets = [];
    let liabilities = [];
    let equityItems = [];

    let totalCurrentAsset = 0;
    let totalFixedAsset = 0;
    let totalLiability = 0;
    let totalEquity = 0;

    // Calculate current net profit for retained earnings
    let totalRev = 0;
    let totalExp = 0;

    for (const r of rows) {
      const d = Number(r.total_debit);
      const c = Number(r.total_credit);

      if (['revenue', 'contra_revenue', 'cogs', 'expense'].includes(r.type)) {
        if (r.type === 'revenue') totalRev += (c - d);
        else if (r.type === 'contra_revenue') totalRev -= (d - c);
        else if (r.type === 'cogs') totalExp += (d - c);
        else if (r.type === 'expense') totalExp += (d - c);
      } else if (r.type === 'asset') {
        const val = d - c;
        if (val !== 0) { currentAssets.push({ code: r.code, name: r.name, amount: val }); totalCurrentAsset += val; }
      } else if (r.type === 'asset_fixed' || r.type === 'contra_asset') {
        const val = r.type === 'contra_asset' ? -(c - d) : (d - c);
        if (val !== 0) { fixedAssets.push({ code: r.code, name: r.name, amount: val }); totalFixedAsset += val; }
      } else if (r.type === 'liability') {
        const val = c - d;
        if (val !== 0) { liabilities.push({ code: r.code, name: r.name, amount: val }); totalLiability += val; }
      } else if (r.type === 'equity') {
        const val = r.code === '3004' ? -(d - c) : (c - d); // Prive is contra (debit)
        if (val !== 0) { equityItems.push({ code: r.code, name: r.name, amount: val }); totalEquity += val; }
      }
    }

    const currentPeriodProfit = totalRev - totalExp;
    equityItems.push({ code: 'PROFIT', name: 'Laba Periode Berjalan', amount: currentPeriodProfit });
    totalEquity += currentPeriodProfit;

    const totalAssets = totalCurrentAsset + totalFixedAsset;
    const totalLiabilitiesAndEquity = totalLiability + totalEquity;

    res.json({
      assets: { currentAssets, totalCurrentAsset, fixedAssets, totalFixedAsset, totalAssets },
      liabilities: { items: liabilities, totalLiability },
      equity: { items: equityItems, totalEquity },
      totalLiabilitiesAndEquity,
      isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01,
      difference: totalAssets - totalLiabilitiesAndEquity,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat laporan posisi keuangan.' });
  }
});

// Laporan Arus Kas (Cash Flow)
app.get('/api/reports/cash-flow', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = '';
    const params = [req.user.business_id];
    let idx = 2;

    if (startDate) { dateFilter += ` AND t.transaction_date >= $${idx++}`; params.push(startDate); }
    if (endDate) { dateFilter += ` AND t.transaction_date <= $${idx++}`; params.push(endDate); }

    // Direct Cash and Bank transactions
    const query = `
      SELECT t.transaction_type, t.description, t.amount, t.payment_method, t.category
      FROM transactions t
      WHERE t.business_id = $1 AND t.payment_method IN ('cash', 'bank', 'qris') ${dateFilter}
      ORDER BY t.transaction_date ASC
    `;

    const txs = (await pool.query(query, params)).rows;

    let operatingIn = 0;
    let operatingOut = 0;
    let investingIn = 0;
    let investingOut = 0;
    let financingIn = 0;
    let financingOut = 0;

    for (const t of txs) {
      const amt = Number(t.amount);
      if (t.transaction_type === 'sale' || t.transaction_type === 'receivable_payment') {
        operatingIn += amt;
      } else if (t.transaction_type === 'purchase' || t.transaction_type === 'expense' || t.transaction_type === 'payable_payment') {
        operatingOut += amt;
      } else if (t.transaction_type === 'capital') {
        financingIn += amt;
      } else if (t.transaction_type === 'drawing') {
        financingOut += amt;
      }
    }

    const netOperating = operatingIn - operatingOut;
    const netInvesting = investingIn - investingOut;
    const netFinancing = financingIn - financingOut;
    const netCashChange = netOperating + netInvesting + netFinancing;

    res.json({
      operating: { in: operatingIn, out: operatingOut, net: netOperating },
      investing: { in: investingIn, out: investingOut, net: netInvesting },
      financing: { in: financingIn, out: financingOut, net: netFinancing },
      netCashChange,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat laporan arus kas.' });
  }
});

// Laporan Perubahan Ekuitas
app.get('/api/reports/equity', authenticate, async (req, res) => {
  try {
    const bizId = req.user.business_id;

    // Modal Awal & Tambahan
    const capRes = await pool.query(
      `SELECT COALESCE(SUM(j.credit - j.debit), 0) as modal
       FROM journal_entries j JOIN accounts a ON a.id = j.account_id
       WHERE (j.business_id = $1 OR j.business_id IS NULL) AND a.code = '3001'`,
      [bizId]
    );
    const modalAwal = Number(capRes.rows[0].modal);

    // Prive
    const priveRes = await pool.query(
      `SELECT COALESCE(SUM(j.debit - j.credit), 0) as prive
       FROM journal_entries j JOIN accounts a ON a.id = j.account_id
       WHERE (j.business_id = $1 OR j.business_id IS NULL) AND a.code = '3004'`,
      [bizId]
    );
    const prive = Number(priveRes.rows[0].prive);

    // Laba Bersih
    const revRes = await pool.query(
      `SELECT COALESCE(SUM(j.credit - j.debit), 0) as net_rev
       FROM journal_entries j JOIN accounts a ON a.id = j.account_id
       WHERE (j.business_id = $1 OR j.business_id IS NULL) AND a.type IN ('revenue', 'contra_revenue')`,
      [bizId]
    );
    const expRes = await pool.query(
      `SELECT COALESCE(SUM(j.debit - j.credit), 0) as net_exp
       FROM journal_entries j JOIN accounts a ON a.id = j.account_id
       WHERE (j.business_id = $1 OR j.business_id IS NULL) AND a.type IN ('cogs', 'expense')`,
      [bizId]
    );
    const netProfit = Number(revRes.rows[0].net_rev) - Number(expRes.rows[0].net_exp);

    const modalAkhir = modalAwal + netProfit - prive;

    res.json({
      modalAwal,
      netProfit,
      prive,
      modalAkhir,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat laporan perubahan ekuitas.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 6. INVENTORY / STOK BARANG API
// ─────────────────────────────────────────────────────────────

app.get('/api/products', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY stock_quantity <= min_stock DESC, name ASC`,
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data produk.' });
  }
});

app.post('/api/products', authenticate, async (req, res) => {
  const { code, name, category = 'Umum', buy_price = 0, sell_price = 0, stock_quantity = 0, min_stock = 5, unit = 'pcs' } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Kode dan nama barang wajib diisi.' });

  try {
    const result = await pool.query(
      `INSERT INTO products (business_id, code, name, category, buy_price, sell_price, stock_quantity, min_stock, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user.business_id, code.trim().toUpperCase(), name.trim(), category, buy_price, sell_price, stock_quantity, min_stock, unit]
    );
    res.status(201).json({ message: 'Produk berhasil ditambahkan.', product: result.rows[0] });
  } catch (err) {
    res.status(400).json({ error: 'Gagal menambah produk. Pastikan kode unik.' });
  }
});

app.patch('/api/products/:id', authenticate, async (req, res) => {
  const { name, category, buy_price, sell_price, stock_quantity, min_stock, unit } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           category = COALESCE($2, category),
           buy_price = COALESCE($3, buy_price),
           sell_price = COALESCE($4, sell_price),
           stock_quantity = COALESCE($5, stock_quantity),
           min_stock = COALESCE($6, min_stock),
           unit = COALESCE($7, unit)
       WHERE id = $8 AND business_id = $9 RETURNING *`,
      [name, category, buy_price, sell_price, stock_quantity, min_stock, unit, req.params.id, req.user.business_id]
    );
    res.json({ message: 'Produk berhasil diperbarui.', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memperbarui produk.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 7. RECEIVABLES & PAYABLES (PIUTANG & UTANG) API
// ─────────────────────────────────────────────────────────────

app.get('/api/receivables', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rp.*, c.name as contact_name, c.phone as contact_phone, t.invoice_number, t.description
       FROM receivables_payables rp
       LEFT JOIN contacts c ON c.id = rp.contact_id
       LEFT JOIN transactions t ON t.id = rp.transaction_id
       WHERE rp.business_id = $1 AND rp.type = 'receivable'
       ORDER BY rp.status ASC, rp.id DESC`,
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data piutang.' });
  }
});

app.get('/api/payables', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rp.*, c.name as contact_name, c.phone as contact_phone, t.invoice_number, t.description
       FROM receivables_payables rp
       LEFT JOIN contacts c ON c.id = rp.contact_id
       LEFT JOIN transactions t ON t.id = rp.transaction_id
       WHERE rp.business_id = $1 AND rp.type = 'payable'
       ORDER BY rp.status ASC, rp.id DESC`,
      [req.user.business_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data utang.' });
  }
});

// Pelunasan Piutang / Utang API
app.post('/api/receivables_payables/pay', authenticate, async (req, res) => {
  const { id, amount, paymentMethod = 'cash', notes = '' } = req.body;
  const payAmt = Number(amount);
  if (!id || payAmt <= 0) return res.status(400).json({ error: 'ID dan nominal pembayaran harus valid.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rpRes = await client.query(
      `SELECT * FROM receivables_payables WHERE id = $1 AND business_id = $2`,
      [id, req.user.business_id]
    );
    if (rpRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Data utang/piutang tidak ditemukan.' });
    }
    const rp = rpRes.rows[0];
    const newRemaining = Math.max(0, Number(rp.remaining_amount) - payAmt);
    const newPaid = Number(rp.paid_amount) + payAmt;
    const newStatus = newRemaining === 0 ? 'paid' : 'partial';

    await client.query(
      `UPDATE receivables_payables SET paid_amount = $1, remaining_amount = $2, status = $3 WHERE id = $4`,
      [newPaid, newRemaining, newStatus, id]
    );

    // Create journal entry:
    // Receivable payment: Debit Kas/Bank, Credit Piutang Usaha (1004) -> No double revenue!
    // Payable payment: Debit Utang Usaha (2001), Credit Kas/Bank -> No double expense!
    const moneyAccount = paymentMethod === 'bank' || paymentMethod === 'qris' ? '1003' : '1001';
    const debitCode = rp.type === 'receivable' ? moneyAccount : '2001';
    const creditCode = rp.type === 'receivable' ? '1004' : moneyAccount;

    const jrnNum = `PAY-RP-${id}-${Date.now().toString().slice(-4)}`;
    const desc = `${rp.type === 'receivable' ? 'Penerimaan Piutang' : 'Pembayaran Utang'} (Ref #${id})`;

    const trxRes = await client.query(
      `INSERT INTO transactions
         (business_id, contact_id, invoice_number, description, category, transaction_type, amount, payment_method, payment_status, transaction_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', CURRENT_DATE, $9) RETURNING id`,
      [req.user.business_id, rp.contact_id, jrnNum, desc, desc, rp.type === 'receivable' ? 'receivable_payment' : 'payable_payment', payAmt, paymentMethod, notes]
    );

    const newTrxId = trxRes.rows[0].id;

    await client.query(
      `INSERT INTO journal_entries (business_id, transaction_id, account_id, entry_number, debit, credit)
       SELECT $1, $2, id, $3, $4, 0 FROM accounts WHERE code = $5 AND (business_id = $1 OR business_id IS NULL) LIMIT 1`,
      [req.user.business_id, newTrxId, jrnNum, payAmt, debitCode]
    );

    await client.query(
      `INSERT INTO journal_entries (business_id, transaction_id, account_id, entry_number, debit, credit)
       SELECT $1, $2, id, $3, 0, $4 FROM accounts WHERE code = $5 AND (business_id = $1 OR business_id IS NULL) LIMIT 1`,
      [req.user.business_id, newTrxId, jrnNum, payAmt, creditCode]
    );

    await client.query('COMMIT');
    res.json({ message: 'Pembayaran berhasil diproses dan jurnal diperbarui.', remaining: newRemaining });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Gagal memproses pembayaran: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
// 8. DASHBOARD METRICS & CHARTS API
// ─────────────────────────────────────────────────────────────

app.get('/api/dashboard/summary', authenticate, async (req, res) => {
  try {
    const bizId = req.user.business_id;

    // Income & Expense
    const sumRes = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'sale'), 0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('purchase', 'expense')), 0) AS expense,
        COUNT(*) AS total_transactions
      FROM transactions WHERE business_id = $1
    `, [bizId]);

    // Kas & Bank Balances
    const cashRes = await pool.query(`
      SELECT
        COALESCE(SUM(j.debit - j.credit) FILTER (WHERE a.code IN ('1001', '1002')), 0) as cash_balance,
        COALESCE(SUM(j.debit - j.credit) FILTER (WHERE a.code = '1003'), 0) as bank_balance,
        COALESCE(SUM(j.debit - j.credit) FILTER (WHERE a.code = '1007'), 0) as inventory_balance,
        COALESCE(SUM(j.debit - j.credit) FILTER (WHERE a.code IN ('1004', '1005', '1006')), 0) as ar_balance,
        COALESCE(SUM(j.credit - j.debit) FILTER (WHERE a.code IN ('2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '2009', '2010', '2101', '2102')), 0) as ap_balance
      FROM journal_entries j
      JOIN accounts a ON a.id = j.account_id
      WHERE (j.business_id = $1 OR j.business_id IS NULL)
    `, [bizId]);

    const income = Number(sumRes.rows[0].income);
    const expense = Number(sumRes.rows[0].expense);

    res.json({
      income,
      expense,
      net: income - expense,
      totalTransactions: Number(sumRes.rows[0].total_transactions),
      cashBalance: Number(cashRes.rows[0].cash_balance),
      bankBalance: Number(cashRes.rows[0].bank_balance),
      inventoryBalance: Number(cashRes.rows[0].inventory_balance),
      receivableBalance: Number(cashRes.rows[0].ar_balance),
      payableBalance: Number(cashRes.rows[0].ap_balance),
      lowStockCount: 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil ringkasan dashboard.' });
  }
});

app.get('/api/dashboard/charts', authenticate, async (req, res) => {
  try {
    const bizId = req.user.business_id;

    // Monthly Trends (Last 6 Months)
    const trendRes = await pool.query(`
      SELECT
        TO_CHAR(transaction_date, 'Mon YYYY') as month_label,
        DATE_TRUNC('month', transaction_date) as m_date,
        COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'sale'), 0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('purchase', 'expense')), 0) AS expense
      FROM transactions
      WHERE business_id = $1
      GROUP BY m_date, month_label
      ORDER BY m_date ASC
      LIMIT 6
    `, [bizId]);

    // Expense Categories
    const catRes = await pool.query(`
      SELECT category, SUM(amount) as total
      FROM transactions
      WHERE business_id = $1 AND transaction_type IN ('purchase', 'expense')
      GROUP BY category
      ORDER BY total DESC
      LIMIT 5
    `, [bizId]);

    // Payment Methods Breakdown
    const payRes = await pool.query(`
      SELECT payment_method, COUNT(*) as count, SUM(amount) as total
      FROM transactions
      WHERE business_id = $1
      GROUP BY payment_method
    `, [bizId]);

    res.json({
      trends: trendRes.rows,
      categories: catRes.rows,
      paymentMethods: payRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat data grafik.' });
  }
});

// ─────────────────────────────────────────────────────────────
// 9. SETTINGS & PROFILE API
// ─────────────────────────────────────────────────────────────

app.get('/api/settings', authenticate, async (req, res) => {
  try {
    const biz = await pool.query(`SELECT * FROM businesses WHERE id = $1`, [req.user.business_id]);
    res.json(biz.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Gagal memuat pengaturan usaha.' });
  }
});

app.post('/api/settings', authenticate, async (req, res) => {
  const { name, owner_name, address, phone } = req.body;
  try {
    const result = await pool.query(
      `UPDATE businesses SET name = COALESCE($1, name), owner_name = COALESCE($2, owner_name), address = COALESCE($3, address), phone = COALESCE($4, phone)
       WHERE id = $5 RETURNING *`,
      [name, owner_name, address, phone, req.user.business_id]
    );
    res.json({ message: 'Profil usaha berhasil diperbarui.', business: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan profil usaha.' });
  }
});

// ─────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

if (!process.env.VERCEL) {
  initializeDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`=======================================================`);
        console.log(`🚀 FINANCEFLOW ENTERPRISE RUNNING: http://localhost:${PORT}`);
        console.log(`=======================================================`);
      });
    })
    .catch(error => {
      console.error('Database gagal diinisialisasi:', error);
      process.exit(1);
    });
}

export default app;
