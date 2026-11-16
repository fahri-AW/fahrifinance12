/**
 * FinanceFlow Enterprise Frontend Application Controller
 */

const API = '/api';
let trendChart = null;
let categoryChart = null;
let cachedAccounts = [];
let pendingDeleteTrxId = null;
let currentRPType = 'receivable';

// ── Currency & Format Utilities ──
const money = val =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(val || 0));

const formatDate = dateStr => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' });
};

const escapeHTML = str =>
  String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// ── Centralized Fetch Helper ──
async function request(endpoint, options = {}) {
  try {
    const res = await fetch(API + endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan pada server.');
    return data;
  } catch (err) {
    throw err;
  }
}

// ── Toast Notification ──
let toastTimer;
function notify(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = type === 'error' ? '#ef4444' : '#0f172a';
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
}

// ── Navigation & Page Routing ──
const PAGE_TITLES = {
  dashboard: 'Dashboard Keuangan',
  transactions: 'Riwayat Transaksi',
  'receivables-payables': 'Utang & Piutang Usaha',
  journal: 'Jurnal Umum (Double-Entry)',
  ledger: 'Buku Besar Akun',
  trial: 'Neraca Saldo',
  income: 'Laporan Laba Rugi',
  'balance-sheet': 'Laporan Posisi Keuangan (Neraca)',
  cashflow: 'Laporan Arus Kas',
  equity: 'Laporan Perubahan Ekuitas',
  accounts: 'Bagan Akun (Chart of Accounts)',
  settings: 'Pengaturan Profil Usaha',
};

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.add('hidden');
    p.classList.remove('active');
  });

  const target = document.getElementById(pageId);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('active');
  }

  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageId);
  });

  document.getElementById('page-title').textContent = PAGE_TITLES[pageId] || 'FinanceFlow';

  // Lazy load data for specific page
  if (pageId === 'dashboard') loadDashboard();
  else if (pageId === 'transactions') loadTransactions();
  else if (pageId === 'receivables-payables') loadReceivablesPayables();
  else if (pageId === 'journal') loadJournal();
  else if (pageId === 'ledger') loadLedgerDropdown();
  else if (pageId === 'trial') loadTrialBalance();
  else if (pageId === 'income') loadIncomeStatement();
  else if (pageId === 'balance-sheet') loadBalanceSheet();
  else if (pageId === 'cashflow') loadCashFlow();
  else if (pageId === 'equity') loadEquity();
  else if (pageId === 'accounts') loadAccounts();
  else if (pageId === 'settings') loadSettings();
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// ════════════════════════════════════════════════════════════════
// 1. DASHBOARD & CHARTS
// ════════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const [summary, charts, recent] = await Promise.all([
      request('/dashboard/summary'),
      request('/dashboard/charts'),
      request('/transactions?limit=6'),
    ]);

    // KPI Cards
    document.getElementById('stat-income').textContent = money(summary.income);
    document.getElementById('stat-expense').textContent = money(summary.expense);
    document.getElementById('stat-net').textContent = money(summary.net);
    document.getElementById('stat-cash').textContent = money(summary.cashBalance);
    document.getElementById('stat-bank').textContent = money(summary.bankBalance);
    document.getElementById('stat-stock').textContent = money(summary.inventoryBalance);
    document.getElementById('stat-ar').textContent = money(summary.receivableBalance);
    document.getElementById('stat-ap').textContent = money(summary.payableBalance);

    // Render Recent Table
    const tbody = document.getElementById('dashboard-recent-tbody');
    if (!recent.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">Belum ada transaksi. Gunakan input cepat di atas!</td></tr>`;
    } else {
      tbody.innerHTML = recent.map(r => `
        <tr>
          <td><strong>${escapeHTML(r.invoice_number || '-')}</strong></td>
          <td>${formatDate(r.transaction_date)}</td>
          <td>${escapeHTML(r.description)}</td>
          <td><span class="chip">${escapeHTML(r.category)}</span></td>
          <td>${escapeHTML(r.contact_name || '-')}</td>
          <td>${escapeHTML(r.payment_method.toUpperCase())}</td>
          <td class="${r.transaction_type === 'sale' ? 'amount-pos' : 'amount-neg'}">
            ${r.transaction_type === 'sale' ? '+' : '-'}${money(r.amount)}
          </td>
          <td><span class="status-badge status-${r.payment_status}">${r.payment_status.toUpperCase()}</span></td>
        </tr>
      `).join('');
    }

    renderCharts(charts);
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderCharts(data) {
  // 1. Trends Bar Chart
  const ctxTrend = document.getElementById('chart-trends')?.getContext('2d');
  if (ctxTrend) {
    if (trendChart) trendChart.destroy();
    const labels = data.trends.map(t => t.month_label);
    const incomes = data.trends.map(t => Number(t.income));
    const expenses = data.trends.map(t => Number(t.expense));

    trendChart = new Chart(ctxTrend, {
      type: 'bar',
      data: {
        labels: labels.length ? labels : ['Bulan Ini'],
        datasets: [
          { label: 'Pemasukan', data: incomes.length ? incomes : [0], backgroundColor: '#10b981', borderRadius: 6 },
          { label: 'Pengeluaran', data: expenses.length ? expenses : [0], backgroundColor: '#ef4444', borderRadius: 6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { ticks: { callback: v => 'Rp' + (v / 1000).toLocaleString() + 'k' } },
        },
      },
    });
  }

  // 2. Categories Doughnut Chart
  const ctxCat = document.getElementById('chart-categories')?.getContext('2d');
  if (ctxCat) {
    if (categoryChart) categoryChart.destroy();
    const catLabels = data.categories.map(c => c.category);
    const catData = data.categories.map(c => Number(c.total));

    categoryChart = new Chart(ctxCat, {
      type: 'doughnut',
      data: {
        labels: catLabels.length ? catLabels : ['Belum Ada Data'],
        datasets: [{
          data: catData.length ? catData : [1],
          backgroundColor: ['#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#64748b'],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
      },
    });
  }
}

// ════════════════════════════════════════════════════════════════
// 2. NATURAL LANGUAGE INPUT ENGINE
// ════════════════════════════════════════════════════════════════

function focusSmartInput() {
  showPage('dashboard');
  const area = document.getElementById('nlp-input');
  area.focus();
  area.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showManualTransactionModal() {
  showPage('dashboard');
  document.getElementById('prev-desc').value = '';
  document.getElementById('prev-amount').value = '';
  document.getElementById('prev-type').value = 'sale';
  document.getElementById('prev-payment').value = 'cash';
  document.getElementById('prev-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('prev-contact').value = '';
  if (document.getElementById('prev-product')) document.getElementById('prev-product').value = '';
  if (document.getElementById('prev-qty')) document.getElementById('prev-qty').value = 1;
  ensureAccountsLoaded().then(() => {
    populateAccountDropdown('prev-debit-acc', '1001');
    populateAccountDropdown('prev-credit-acc', '4001');
    document.getElementById('nlp-preview-card').classList.remove('hidden');
    document.getElementById('nlp-preview-card').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('prev-desc').focus();
  });
}

function fillExample(text) {
  const area = document.getElementById('nlp-input');
  area.value = text;
  parseNaturalLanguage();
}

async function parseNaturalLanguage() {
  const text = document.getElementById('nlp-input').value.trim();
  if (!text) {
    notify('Ketik transaksi terlebih dahulu.', 'error');
    return;
  }

  try {
    await ensureAccountsLoaded();
    const result = await request('/transactions/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });

    // Populate Confirmation Form
    document.getElementById('prev-desc').value = result.description;
    document.getElementById('prev-amount').value = result.amount;
    document.getElementById('prev-type').value = result.type;
    document.getElementById('prev-payment').value = result.paymentMethod;
    document.getElementById('prev-date').value = result.transactionDate || new Date().toISOString().slice(0, 10);
    document.getElementById('prev-contact').value = result.contactName || '';
    if (document.getElementById('prev-product')) document.getElementById('prev-product').value = result.productName || '';
    if (document.getElementById('prev-qty')) document.getElementById('prev-qty').value = result.quantity || 1;

    // Populate and select debit/credit accounts
    populateAccountDropdown('prev-debit-acc', result.debitAccountCode);
    populateAccountDropdown('prev-credit-acc', result.creditAccountCode);

    const tagText = `${result.debitAccountName || result.debitAccountCode} ⇄ ${result.creditAccountName || result.creditAccountCode}`;
    document.getElementById('preview-type-tag').textContent = tagText;
    document.getElementById('nlp-preview-card').classList.remove('hidden');
    notify(`Transaksi berhasil dianalisis: Akun [${result.debitAccountName}] & Tanggal [${result.transactionDate}]`);
  } catch (err) {
    notify(err.message, 'error');
  }
}

document.getElementById('btn-parse-nlp').addEventListener('click', parseNaturalLanguage);

document.getElementById('btn-cancel-preview').addEventListener('click', () => {
  document.getElementById('nlp-preview-card').classList.add('hidden');
});

document.getElementById('btn-save-confirmed').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-confirmed');
  btn.disabled = true;

  try {
    const payload = {
      description: document.getElementById('prev-desc').value.trim(),
      amount: Number(document.getElementById('prev-amount').value),
      type: document.getElementById('prev-type').value,
      paymentMethod: document.getElementById('prev-payment').value,
      transactionDate: document.getElementById('prev-date').value,
      contactName: document.getElementById('prev-contact').value.trim(),
      productName: document.getElementById('prev-product') ? document.getElementById('prev-product').value.trim() : '',
      quantity: document.getElementById('prev-qty') ? Number(document.getElementById('prev-qty').value) || 1 : 1,
      debitAccountCode: document.getElementById('prev-debit-acc').value,
      creditAccountCode: document.getElementById('prev-credit-acc').value,
    };

    await request('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    notify('Transaksi berhasil disimpan dan jurnal umum telah diposting!');
    document.getElementById('nlp-input').value = '';
    document.getElementById('nlp-preview-card').classList.add('hidden');
    await loadDashboard();
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ════════════════════════════════════════════════════════════════
// 3. CHART OF ACCOUNTS (COA) HELPERS
// ════════════════════════════════════════════════════════════════

async function ensureAccountsLoaded() {
  if (!cachedAccounts.length) {
    cachedAccounts = await request('/accounts');
  }
}

function populateAccountDropdown(selectId, defaultCode) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = cachedAccounts.map(a => `
    <option value="${a.code}" ${a.code === defaultCode ? 'selected' : ''}>
      ${a.code} - ${escapeHTML(a.name)} (${a.type})
    </option>
  `).join('');
}

async function loadAccounts() {
  try {
    cachedAccounts = await request('/accounts');
    const tbody = document.getElementById('accounts-tbody');
    tbody.innerHTML = cachedAccounts.map(a => `
      <tr>
        <td><strong>${escapeHTML(a.code)}</strong></td>
        <td>${escapeHTML(a.name)}</td>
        <td><span class="chip">${escapeHTML(a.type.toUpperCase())}</span></td>
        <td><strong>${a.normal_balance.toUpperCase()}</strong></td>
        <td>${escapeHTML(a.description || '-')}</td>
      </tr>
    `).join('');
  } catch (err) {
    notify(err.message, 'error');
  }
}

function showAddAccountModal() {
  document.getElementById('modal-account').classList.remove('hidden');
}

async function saveAccount(e) {
  e.preventDefault();
  try {
    const payload = {
      code: document.getElementById('acc-code').value.trim(),
      name: document.getElementById('acc-name').value.trim(),
      type: document.getElementById('acc-type').value,
      normal_balance: document.getElementById('acc-normal').value,
    };
    await request('/accounts', { method: 'POST', body: JSON.stringify(payload) });
    notify('Akun akuntansi berhasil ditambahkan.');
    closeModal('modal-account');
    cachedAccounts = [];
    loadAccounts();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 4. TRANSACTIONS MANAGEMENT
// ════════════════════════════════════════════════════════════════

let currentTrxList = [];

async function loadTransactions() {
  try {
    const search = document.getElementById('filter-trx-search')?.value.trim();
    const type = document.getElementById('filter-trx-type')?.value;
    const payment = document.getElementById('filter-trx-payment')?.value;
    const start = document.getElementById('filter-trx-start')?.value;
    const end = document.getElementById('filter-trx-end')?.value;

    let url = `/transactions?limit=100`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (type) url += `&type=${encodeURIComponent(type)}`;
    if (payment) url += `&paymentMethod=${encodeURIComponent(payment)}`;
    if (start) url += `&startDate=${encodeURIComponent(start)}`;
    if (end) url += `&endDate=${encodeURIComponent(end)}`;

    currentTrxList = await request(url);
    renderTransactionsTable(currentTrxList);
  } catch (err) {
    notify(err.message, 'error');
  }
}

function filterTransactions() {
  loadTransactions();
}

function renderTransactionsTable(list) {
  const tbody = document.getElementById('trx-table-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);">Tidak ada transaksi yang cocok.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(r => `
    <tr>
      <td><strong>${escapeHTML(r.invoice_number || '-')}</strong></td>
      <td>${formatDate(r.transaction_date)}</td>
      <td>${escapeHTML(r.description)}</td>
      <td><span class="chip">${escapeHTML(r.category)}</span></td>
      <td>${escapeHTML(r.contact_name || '-')}</td>
      <td>${escapeHTML(r.payment_method.toUpperCase())}</td>
      <td class="${r.transaction_type === 'sale' ? 'amount-pos' : 'amount-neg'}">
        ${r.transaction_type === 'sale' ? '+' : '-'}${money(r.amount)}
      </td>
      <td><span class="status-badge status-${r.payment_status}">${r.payment_status.toUpperCase()}</span></td>
      <td>
        <button class="danger-btn" style="padding:4px 8px;font-size:11px;" onclick="confirmDeleteTrx(${r.id})">Hapus</button>
      </td>
    </tr>
  `).join('');
}

function confirmDeleteTrx(id) {
  pendingDeleteTrxId = id;
  document.getElementById('modal-confirm-delete').classList.remove('hidden');
}

document.getElementById('btn-do-delete').addEventListener('click', async () => {
  if (!pendingDeleteTrxId) return;
  try {
    await request(`/transactions/${pendingDeleteTrxId}`, { method: 'DELETE' });
    notify('Transaksi berhasil dihapus dan jurnal dibatalkan.');
    closeModal('modal-confirm-delete');
    loadTransactions();
    loadDashboard();
  } catch (err) {
    notify(err.message, 'error');
  }
});

let currentRPList = [];
let currentJournalData = null;
let currentLedgerData = null;
let currentTrialData = null;
let currentIncomeData = null;
let currentBalanceSheetData = null;
let currentCashFlowData = null;
let currentEquityData = null;

function downloadCSV(filename, headers, rows) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '""';
    const s = String(val).replace(/"/g, '""');
    return `"${s}"`;
  };

  const csvContent = '\uFEFF' + [
    headers.map(escapeCell).join(','),
    ...rows.map(row => row.map(escapeCell).join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportTransactionsCSV() {
  if (!currentTrxList || !currentTrxList.length) {
    notify('Tidak ada data transaksi untuk diexport.', 'error');
    return;
  }
  const headers = ['No. Invoice', 'Tanggal', 'Keterangan', 'Kategori', 'Kontak', 'Metode Pembayaran', 'Nominal (Rp)', 'Status'];
  const rows = currentTrxList.map(r => [
    r.invoice_number || '',
    formatDate(r.transaction_date),
    r.description,
    r.category,
    r.contact_name || '',
    r.payment_method.toUpperCase(),
    r.amount,
    r.payment_status.toUpperCase(),
  ]);
  downloadCSV(`FinanceFlow_Transaksi_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File transaksi berhasil didownload!');
}

function exportRPCSV() {
  if (!currentRPList || !currentRPList.length) {
    notify('Tidak ada data utang/piutang untuk diexport.', 'error');
    return;
  }
  const isAR = currentRPType === 'receivable';
  const headers = ['No. Ref', 'Pihak Terkait', 'Keterangan', 'Total Tagihan (Rp)', 'Telah Dibayar (Rp)', 'Sisa Tagihan (Rp)', 'Status'];
  const rows = currentRPList.map(r => [
    r.invoice_number || '#' + r.id,
    r.contact_name || 'Umum',
    r.description || '-',
    r.total_amount,
    r.paid_amount,
    r.remaining_amount,
    r.status.toUpperCase(),
  ]);
  downloadCSV(`FinanceFlow_${isAR ? 'Piutang_Usaha' : 'Utang_Usaha'}_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify(`File ${isAR ? 'Piutang' : 'Utang'} berhasil didownload!`);
}

// ════════════════════════════════════════════════════════════════
// 5. UTANG & PIUTANG (AR / AP)
// ════════════════════════════════════════════════════════════════

function switchRPView(type) {
  currentRPType = type;
  document.querySelectorAll('.tabs-header .tab-btn').forEach((b, idx) => {
    b.classList.toggle('active', (type === 'receivable' && idx === 0) || (type === 'payable' && idx === 1));
  });

  document.getElementById('rp-panel-title').textContent = type === 'receivable' ? 'Daftar Piutang Usaha (AR)' : 'Daftar Utang Usaha (AP)';
  document.getElementById('rp-panel-subtitle').textContent = type === 'receivable' ? 'Tagihan yang belum dilunasi pelanggan.' : 'Kewajiban pembelian tempo yang belum dibayarkan ke pemasok.';
  loadReceivablesPayables();
}

async function loadReceivablesPayables() {
  try {
    const endpoint = currentRPType === 'receivable' ? '/receivables' : '/payables';
    const list = await request(endpoint);
    currentRPList = list;
    const tbody = document.getElementById('rp-tbody');

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">Tidak ada tagihan yang belum lunas.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${escapeHTML(item.invoice_number || '#' + item.id)}</strong></td>
        <td><strong>${escapeHTML(item.contact_name || 'Umum')}</strong></td>
        <td>${escapeHTML(item.description || '-')}</td>
        <td>${money(item.total_amount)}</td>
        <td class="amount-pos">${money(item.paid_amount)}</td>
        <td class="amount-neg"><strong>${money(item.remaining_amount)}</strong></td>
        <td><span class="status-badge status-${item.status}">${item.status.toUpperCase()}</span></td>
        <td>
          ${item.remaining_amount > 0 ? `
            <button class="primary-btn" style="padding:4px 10px;font-size:11px;" onclick="openRPPayModal(${item.id}, ${item.remaining_amount}, '${escapeHTML(item.contact_name || '')}')">
              ${currentRPType === 'receivable' ? 'Terima Pelunasan' : 'Bayar Utang'}
            </button>
          ` : '<span style="color:var(--success);font-weight:700;">LUNAS</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    notify(err.message, 'error');
  }
}

function openRPPayModal(id, remaining, contact) {
  document.getElementById('pay-rp-id').value = id;
  document.getElementById('pay-rp-remaining').value = money(remaining);
  document.getElementById('pay-rp-amount').value = remaining;
  document.getElementById('pay-rp-title').textContent = currentRPType === 'receivable' ? `Penerimaan Piutang: ${contact}` : `Pembayaran Utang: ${contact}`;
  document.getElementById('modal-pay-rp').classList.remove('hidden');
}

async function submitRPPayment(e) {
  e.preventDefault();
  try {
    const id = document.getElementById('pay-rp-id').value;
    const amount = Number(document.getElementById('pay-rp-amount').value);
    const paymentMethod = document.getElementById('pay-rp-method').value;

    await request('/receivables_payables/pay', {
      method: 'POST',
      body: JSON.stringify({ id, amount, paymentMethod }),
    });

    notify('Pembayaran berhasil diproses dan jurnal akuntansi telah dicatat!');
    closeModal('modal-pay-rp');
    loadReceivablesPayables();
    loadDashboard();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 7. JURNAL UMUM (DOUBLE ENTRY GENERAL JOURNAL)
// ════════════════════════════════════════════════════════════════

async function loadJournal() {
  try {
    const data = await request('/journals');
    currentJournalData = data;
    const tbody = document.getElementById('journal-tbody');
    const tfoot = document.getElementById('journal-tfoot');
    const badge = document.getElementById('journal-balance-badge');

    if (!data.entries.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Belum ada entri jurnal.</td></tr>`;
      tfoot.innerHTML = '';
      return;
    }

    tbody.innerHTML = data.entries.map(e => `
      <tr>
        <td>${formatDate(e.transaction_date)}</td>
        <td><strong>${escapeHTML(e.entry_number || '-')}</strong></td>
        <td>${escapeHTML(e.description)}</td>
        <td><code>${escapeHTML(e.account_code)}</code></td>
        <td>${escapeHTML(e.account_name)}</td>
        <td style="text-align:right;">${Number(e.debit) > 0 ? money(e.debit) : '–'}</td>
        <td style="text-align:right;">${Number(e.credit) > 0 ? money(e.credit) : '–'}</td>
      </tr>
    `).join('');

    tfoot.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:right;"><strong>TOTAL</strong></td>
        <td style="text-align:right;"><strong>${money(data.summary.totalDebit)}</strong></td>
        <td style="text-align:right;"><strong>${money(data.summary.totalCredit)}</strong></td>
      </tr>
    `;

    if (data.summary.isBalanced) {
      badge.className = 'badge-balanced';
      badge.textContent = 'DEBIT = KREDIT (SEIMBANG)';
    } else {
      badge.className = 'badge-unbalanced';
      badge.textContent = `TIDAK SEIMBANG (SELISIH ${money(Math.abs(data.summary.totalDebit - data.summary.totalCredit))})`;
    }
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 8. BUKU BESAR (GENERAL LEDGER)
// ════════════════════════════════════════════════════════════════

async function loadLedgerDropdown() {
  await ensureAccountsLoaded();
  const sel = document.getElementById('ledger-account-select');
  sel.innerHTML = cachedAccounts.map(a => `
    <option value="${a.id}">${a.code} - ${escapeHTML(a.name)}</option>
  `).join('');
  loadLedger();
}

async function loadLedger() {
  const accountId = document.getElementById('ledger-account-select').value;
  if (!accountId) return;

  try {
    const data = await request(`/ledger?accountId=${accountId}`);
    currentLedgerData = data;
    const tbody = document.getElementById('ledger-tbody');

    if (!data.lines.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">Belum ada mutasi untuk akun ini.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.lines.map(l => `
      <tr>
        <td>${formatDate(l.transaction_date)}</td>
        <td><strong>${escapeHTML(l.invoice_number || '-')}</strong></td>
        <td>${escapeHTML(l.description)}</td>
        <td style="text-align:right;">${Number(l.debit) > 0 ? money(l.debit) : '–'}</td>
        <td style="text-align:right;">${Number(l.credit) > 0 ? money(l.credit) : '–'}</td>
        <td style="text-align:right;"><strong>${money(l.balance)}</strong></td>
      </tr>
    `).join('');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 9. NERACA SALDO (TRIAL BALANCE)
// ════════════════════════════════════════════════════════════════

async function loadTrialBalance() {
  try {
    const data = await request('/reports/trial-balance');
    currentTrialData = data;
    const tbody = document.getElementById('trial-tbody');
    const tfoot = document.getElementById('trial-tfoot');
    const badge = document.getElementById('trial-balance-badge');

    tbody.innerHTML = data.rows.map(r => `
      <tr>
        <td><code>${escapeHTML(r.code)}</code></td>
        <td>${escapeHTML(r.name)}</td>
        <td><span class="chip">${escapeHTML(r.type)}</span></td>
        <td style="text-align:right;">${Number(r.debit_balance) > 0 ? money(r.debit_balance) : '–'}</td>
        <td style="text-align:right;">${Number(r.credit_balance) > 0 ? money(r.credit_balance) : '–'}</td>
      </tr>
    `).join('');

    tfoot.innerHTML = `
      <tr>
        <td colspan="3" style="text-align:right;"><strong>TOTAL</strong></td>
        <td style="text-align:right;"><strong>${money(data.summary.totalDebit)}</strong></td>
        <td style="text-align:right;"><strong>${money(data.summary.totalCredit)}</strong></td>
      </tr>
    `;

    badge.className = data.summary.isBalanced ? 'badge-balanced' : 'badge-unbalanced';
    badge.textContent = data.summary.isBalanced ? 'SEIMBANG' : 'TIDAK SEIMBANG';
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 10. LABA RUGI & FINANCIAL STATEMENTS
// ════════════════════════════════════════════════════════════════

async function loadIncomeStatement() {
  try {
    const data = await request('/reports/income-statement');
    currentIncomeData = data;
    const container = document.getElementById('income-statement-card');

    container.innerHTML = `
      <div class="fs-row fs-header">
        <span>PENDAPATAN USAHA</span>
        <span></span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Pendapatan Penjualan Jasa &amp; Layanan</span>
        <span>${money(data.revenue)}</span>
      </div>
      ${data.contraRevenue > 0 ? `
        <div class="fs-row fs-subitem">
          <span>Retur &amp; Potongan Penjualan</span>
          <span>(${money(data.contraRevenue)})</span>
        </div>
      ` : ''}
      <div class="fs-row fs-subtotal">
        <span>PENJUALAN BERSIH</span>
        <span>${money(data.netSales)}</span>
      </div>

      <div class="fs-row fs-header" style="margin-top:16px;">
        <span>HARGA POKOK PENJUALAN (HPP)</span>
        <span></span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Beban Pokok Penjualan / Modal Barang Terjual</span>
        <span>(${money(data.cogs)})</span>
      </div>
      <div class="fs-row fs-subtotal">
        <span>LABA KOTOR (GROSS PROFIT)</span>
        <span class="${data.grossProfit >= 0 ? 'amount-pos' : 'amount-neg'}">${money(data.grossProfit)}</span>
      </div>

      <div class="fs-row fs-header" style="margin-top:16px;">
        <span>BEBAN OPERASIONAL</span>
        <span></span>
      </div>
      ${data.expenses.length ? data.expenses.map(e => `
        <div class="fs-row fs-subitem">
          <span>${escapeHTML(e.code)} - ${escapeHTML(e.name)}</span>
          <span>${money(e.amount)}</span>
        </div>
      `).join('') : '<div class="fs-row fs-subitem"><span>Tidak ada beban operasional</span><span>Rp0</span></div>'}

      <div class="fs-row fs-subtotal">
        <span>TOTAL BEBAN OPERASIONAL</span>
        <span>(${money(data.totalExpense)})</span>
      </div>

      <div class="fs-row fs-total">
        <span>${data.netProfit >= 0 ? '🟢 LABA BERSIH TAHUN/PERIODE BERJALAN' : '🔴 RUGI BERSIH TAHUN/PERIODE BERJALAN'}</span>
        <span>${money(data.netProfit)}</span>
      </div>
    `;
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function loadBalanceSheet() {
  try {
    const data = await request('/reports/balance-sheet');
    currentBalanceSheetData = data;
    const container = document.getElementById('balance-sheet-card');
    const badge = document.getElementById('bs-balanced-badge');

    badge.className = data.isBalanced ? 'badge-balanced' : 'badge-unbalanced';
    badge.textContent = data.isBalanced ? 'ASET = LIABILITAS + EKUITAS (SEIMBANG)' : `SELISIH: ${money(data.difference)}`;

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
        <!-- Left Side: Assets -->
        <div>
          <div class="fs-row fs-header">
            <span>ASET LANCAR</span>
            <span></span>
          </div>
          ${data.assets.currentAssets.map(a => `
            <div class="fs-row fs-subitem">
              <span>${escapeHTML(a.name)}</span>
              <span>${money(a.amount)}</span>
            </div>
          `).join('')}
          <div class="fs-row fs-subtotal">
            <span>TOTAL ASET LANCAR</span>
            <span>${money(data.assets.totalCurrentAsset)}</span>
          </div>

          <div class="fs-row fs-header" style="margin-top:16px;">
            <span>ASET TETAP</span>
            <span></span>
          </div>
          ${data.assets.fixedAssets.length ? data.assets.fixedAssets.map(a => `
            <div class="fs-row fs-subitem">
              <span>${escapeHTML(a.name)}</span>
              <span>${money(a.amount)}</span>
            </div>
          `).join('') : '<div class="fs-row fs-subitem"><span>Tidak ada aset tetap</span><span>Rp0</span></div>'}
          <div class="fs-row fs-subtotal">
            <span>TOTAL ASET TETAP</span>
            <span>${money(data.assets.totalFixedAsset)}</span>
          </div>

          <div class="fs-row fs-total" style="margin-top:20px;">
            <span>TOTAL ASET</span>
            <span>${money(data.assets.totalAssets)}</span>
          </div>
        </div>

        <!-- Right Side: Liabilities & Equity -->
        <div>
          <div class="fs-row fs-header">
            <span>LIABILITAS / KEWAJIBAN</span>
            <span></span>
          </div>
          ${data.liabilities.items.length ? data.liabilities.items.map(l => `
            <div class="fs-row fs-subitem">
              <span>${escapeHTML(l.name)}</span>
              <span>${money(l.amount)}</span>
            </div>
          `).join('') : '<div class="fs-row fs-subitem"><span>Tidak ada utang tercatat</span><span>Rp0</span></div>'}
          <div class="fs-row fs-subtotal">
            <span>TOTAL LIABILITAS</span>
            <span>${money(data.liabilities.totalLiability)}</span>
          </div>

          <div class="fs-row fs-header" style="margin-top:16px;">
            <span>EKUITAS / MODAL</span>
            <span></span>
          </div>
          ${data.equity.items.map(e => `
            <div class="fs-row fs-subitem">
              <span>${escapeHTML(e.name)}</span>
              <span>${money(e.amount)}</span>
            </div>
          `).join('')}
          <div class="fs-row fs-subtotal">
            <span>TOTAL EKUITAS</span>
            <span>${money(data.equity.totalEquity)}</span>
          </div>

          <div class="fs-row fs-total" style="margin-top:20px;">
            <span>TOTAL LIABILITAS &amp; EKUITAS</span>
            <span>${money(data.totalLiabilitiesAndEquity)}</span>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function loadCashFlow() {
  try {
    const data = await request('/reports/cash-flow');
    currentCashFlowData = data;
    const container = document.getElementById('cashflow-card');

    container.innerHTML = `
      <div class="fs-row fs-header">
        <span>ARUS KAS DARI AKTIVITAS OPERASI</span>
        <span></span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Penerimaan Kas dari Pelanggan &amp; Penjualan</span>
        <span class="amount-pos">${money(data.operating.in)}</span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Pengeluaran Kas untuk Operasional &amp; Beban</span>
        <span class="amount-neg">(${money(data.operating.out)})</span>
      </div>
      <div class="fs-row fs-subtotal">
        <span>Arus Kas Bersih dari Aktivitas Operasi</span>
        <strong>${money(data.operating.net)}</strong>
      </div>

      <div class="fs-row fs-header" style="margin-top:16px;">
        <span>ARUS KAS DARI AKTIVITAS INVESTASI</span>
        <span></span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Perolehan / Penjualan Aset Tetap</span>
        <span>${money(data.investing.net)}</span>
      </div>
      <div class="fs-row fs-subtotal">
        <span>Arus Kas Bersih dari Aktivitas Investasi</span>
        <strong>${money(data.investing.net)}</strong>
      </div>

      <div class="fs-row fs-header" style="margin-top:16px;">
        <span>ARUS KAS DARI AKTIVITAS PENDANAAN</span>
        <span></span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Setoran Modal Usaha Pemilik</span>
        <span class="amount-pos">${money(data.financing.in)}</span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Penarikan Modal Pribadi (Prive)</span>
        <span class="amount-neg">(${money(data.financing.out)})</span>
      </div>
      <div class="fs-row fs-subtotal">
        <span>Arus Kas Bersih dari Aktivitas Pendanaan</span>
        <strong>${money(data.financing.net)}</strong>
      </div>

      <div class="fs-row fs-total" style="margin-top:20px;">
        <span>KENAIKAN / (PENURUNAN) BERSIH KAS &amp; BANK</span>
        <span>${money(data.netCashChange)}</span>
      </div>
    `;
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function loadEquity() {
  try {
    const data = await request('/reports/equity');
    currentEquityData = data;
    const container = document.getElementById('equity-card');

    container.innerHTML = `
      <div class="fs-row fs-subitem">
        <span>Modal Awal &amp; Setoran Pemilik</span>
        <span>${money(data.modalAwal)}</span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Laba / (Rugi) Bersih Periode Berjalan</span>
        <span class="${data.netProfit >= 0 ? 'amount-pos' : 'amount-neg'}">${money(data.netProfit)}</span>
      </div>
      <div class="fs-row fs-subitem">
        <span>Prive / Penarikan Modal Pemilik</span>
        <span class="amount-neg">(${money(data.prive)})</span>
      </div>
      <div class="fs-row fs-total" style="margin-top:20px;">
        <span>MODAL AKHIR USAHA</span>
        <span>${money(data.modalAkhir)}</span>
      </div>
    `;
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 11. SETTINGS & PROFILE
// ════════════════════════════════════════════════════════════════

async function loadSettings() {
  try {
    const biz = await request('/settings');
    document.getElementById('set-biz-name').value = biz.name || '';
    document.getElementById('set-owner-name').value = biz.owner_name || '';
    document.getElementById('set-biz-address').value = biz.address || '';
    document.getElementById('set-biz-phone').value = biz.phone || '';

    // Update headers
    updateBrandHeadings(biz);
  } catch (err) {
    notify(err.message, 'error');
  }
}

function updateBrandHeadings(biz) {
  if (biz.name) {
    document.getElementById('sidebar-biz-name').textContent = biz.name;
    document.getElementById('print-biz-name').textContent = biz.name;
    document.getElementById('print-biz-address').textContent = `${biz.address || ''} | Telp: ${biz.phone || ''}`;
  }
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    const payload = {
      name: document.getElementById('set-biz-name').value.trim(),
      owner_name: document.getElementById('set-owner-name').value.trim(),
      address: document.getElementById('set-biz-address').value.trim(),
      phone: document.getElementById('set-biz-phone').value.trim(),
    };
    const res = await request('/settings', { method: 'POST', body: JSON.stringify(payload) });
    notify('Profil usaha berhasil diperbarui.');
    updateBrandHeadings(res.business);
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// 12. PRINT & EXPORT UTILITIES
// ════════════════════════════════════════════════════════════════

function exportJournalCSV() {
  if (!currentJournalData || !currentJournalData.entries || !currentJournalData.entries.length) {
    notify('Tidak ada data jurnal untuk diexport.', 'error');
    return;
  }
  const headers = ['Tanggal', 'No. Bukti', 'Keterangan', 'Kode Akun', 'Nama Akun', 'Debit (Rp)', 'Kredit (Rp)'];
  const rows = currentJournalData.entries.map(e => [
    formatDate(e.transaction_date),
    e.entry_number || '-',
    e.description,
    e.account_code,
    e.account_name,
    e.debit,
    e.credit,
  ]);
  rows.push(['', '', 'TOTAL', '', '', currentJournalData.summary.totalDebit, currentJournalData.summary.totalCredit]);
  downloadCSV(`FinanceFlow_Jurnal_Umum_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Jurnal Umum berhasil didownload!');
}

function exportLedgerCSV() {
  if (!currentLedgerData || !currentLedgerData.lines || !currentLedgerData.lines.length) {
    notify('Tidak ada mutasi buku besar untuk diexport.', 'error');
    return;
  }
  const accText = document.getElementById('ledger-account-select')?.selectedOptions[0]?.text || 'Akun';
  const headers = ['Tanggal', 'No. Bukti', 'Keterangan', 'Debit (Rp)', 'Kredit (Rp)', 'Saldo Berjalan (Rp)'];
  const rows = currentLedgerData.lines.map(l => [
    formatDate(l.transaction_date),
    l.invoice_number || '-',
    l.description,
    l.debit,
    l.credit,
    l.balance,
  ]);
  downloadCSV(`FinanceFlow_Buku_Besar_${accText.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Buku Besar berhasil didownload!');
}

function exportTrialBalanceCSV() {
  if (!currentTrialData || !currentTrialData.rows || !currentTrialData.rows.length) {
    notify('Tidak ada data neraca saldo untuk diexport.', 'error');
    return;
  }
  const headers = ['Kode Akun', 'Nama Akun', 'Kelompok', 'Debit (Rp)', 'Kredit (Rp)'];
  const rows = currentTrialData.rows.map(r => [
    r.code,
    r.name,
    r.type,
    r.debit_balance,
    r.credit_balance,
  ]);
  rows.push(['', 'TOTAL', '', currentTrialData.summary.totalDebit, currentTrialData.summary.totalCredit]);
  downloadCSV(`FinanceFlow_Neraca_Saldo_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Neraca Saldo berhasil didownload!');
}

function exportIncomeStatementCSV() {
  if (!currentIncomeData) {
    notify('Laporan Laba Rugi belum dimuat.', 'error');
    return;
  }
  const headers = ['Komponen Laba Rugi', 'Nominal (Rp)'];
  const rows = [
    ['PENDAPATAN USAHA', ''],
    ['Pendapatan Penjualan Jasa & Layanan', currentIncomeData.revenue],
    ['Retur & Potongan Penjualan', -currentIncomeData.contraRevenue],
    ['PENJUALAN BERSIH', currentIncomeData.netSales],
    ['', ''],
    ['HARGA POKOK PENJUALAN (HPP)', ''],
    ['Beban Pokok Penjualan', -currentIncomeData.cogs],
    ['LABA KOTOR (GROSS PROFIT)', currentIncomeData.grossProfit],
    ['', ''],
    ['BEBAN OPERASIONAL', ''],
    ...currentIncomeData.expenses.map(e => [`${e.code} - ${e.name}`, e.amount]),
    ['TOTAL BEBAN OPERASIONAL', -currentIncomeData.totalExpense],
    ['', ''],
    ['LABA / (RUGI) BERSIH TAHUN BERJALAN', currentIncomeData.netProfit],
  ];
  downloadCSV(`FinanceFlow_Laporan_Laba_Rugi_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Laporan Laba Rugi berhasil didownload!');
}

function exportBalanceSheetCSV() {
  if (!currentBalanceSheetData) {
    notify('Laporan Posisi Keuangan belum dimuat.', 'error');
    return;
  }
  const headers = ['Kelompok Akun', 'Nama Akun', 'Nominal (Rp)'];
  const rows = [
    ['ASET LANCAR', '', ''],
    ...currentBalanceSheetData.assets.currentAssets.map(a => ['Aset Lancar', a.name, a.amount]),
    ['TOTAL ASET LANCAR', '', currentBalanceSheetData.assets.totalCurrentAsset],
    ['', '', ''],
    ['ASET TETAP', '', ''],
    ...currentBalanceSheetData.assets.fixedAssets.map(a => ['Aset Tetap', a.name, a.amount]),
    ['TOTAL ASET TETAP', '', currentBalanceSheetData.assets.totalFixedAsset],
    ['TOTAL ASET', '', currentBalanceSheetData.assets.totalAssets],
    ['', '', ''],
    ['LIABILITAS / KEWAJIBAN', '', ''],
    ...currentBalanceSheetData.liabilities.items.map(l => ['Liabilitas', l.name, l.amount]),
    ['TOTAL LIABILITAS', '', currentBalanceSheetData.liabilities.totalLiability],
    ['', '', ''],
    ['EKUITAS / MODAL', '', ''],
    ...currentBalanceSheetData.equity.items.map(e => ['Ekuitas', e.name, e.amount]),
    ['TOTAL EKUITAS', '', currentBalanceSheetData.equity.totalEquity],
    ['TOTAL LIABILITAS & EKUITAS', '', currentBalanceSheetData.totalLiabilitiesAndEquity],
  ];
  downloadCSV(`FinanceFlow_Posisi_Keuangan_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Laporan Posisi Keuangan berhasil didownload!');
}

function exportCashFlowCSV() {
  if (!currentCashFlowData) {
    notify('Laporan Arus Kas belum dimuat.', 'error');
    return;
  }
  const headers = ['Aktivitas Arus Kas', 'Nominal (Rp)'];
  const rows = [
    ['AKTIVITAS OPERASI', ''],
    ['Penerimaan Kas dari Pelanggan & Penjualan', currentCashFlowData.operating.in],
    ['Pengeluaran Kas untuk Operasional & Beban', -currentCashFlowData.operating.out],
    ['Arus Kas Bersih dari Aktivitas Operasi', currentCashFlowData.operating.net],
    ['', ''],
    ['AKTIVITAS INVESTASI', ''],
    ['Perolehan / Penjualan Aset Tetap', currentCashFlowData.investing.net],
    ['Arus Kas Bersih dari Aktivitas Investasi', currentCashFlowData.investing.net],
    ['', ''],
    ['AKTIVITAS PENDANAAN', ''],
    ['Setoran Modal Usaha Pemilik', currentCashFlowData.financing.in],
    ['Penarikan Modal Pribadi (Prive)', -currentCashFlowData.financing.out],
    ['Arus Kas Bersih dari Aktivitas Pendanaan', currentCashFlowData.financing.net],
    ['', ''],
    ['KENAIKAN / (PENURUNAN) BERSIH KAS & BANK', currentCashFlowData.netCashChange],
  ];
  downloadCSV(`FinanceFlow_Arus_Kas_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Laporan Arus Kas berhasil didownload!');
}

function exportEquityCSV() {
  if (!currentEquityData) {
    notify('Laporan Perubahan Ekuitas belum dimuat.', 'error');
    return;
  }
  const headers = ['Komponen Ekuitas', 'Nominal (Rp)'];
  const rows = [
    ['Modal Awal & Setoran Pemilik', currentEquityData.modalAwal],
    ['Laba / (Rugi) Bersih Periode Berjalan', currentEquityData.netProfit],
    ['Prive / Penarikan Modal Pemilik', -currentEquityData.prive],
    ['MODAL AKHIR USAHA', currentEquityData.modalAkhir],
  ];
  downloadCSV(`FinanceFlow_Perubahan_Ekuitas_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Laporan Perubahan Ekuitas berhasil didownload!');
}

function exportAccountsCSV() {
  if (!cachedAccounts || !cachedAccounts.length) {
    notify('Bagan Akun belum dimuat.', 'error');
    return;
  }
  const headers = ['Kode Akun', 'Nama Akun', 'Kelompok Akun', 'Saldo Normal', 'Keterangan'];
  const rows = cachedAccounts.map(a => [
    a.code,
    a.name,
    a.type,
    a.normal_balance,
    a.description || '',
  ]);
  downloadCSV(`FinanceFlow_Bagan_Akun_COA_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  notify('File Bagan Akun (COA) berhasil didownload!');
}

function printReport(title) {
  document.getElementById('print-report-title').textContent = title || 'Laporan Keuangan';
  document.getElementById('print-report-period').textContent = `Dicetak pada: ${new Date().toLocaleString('id-ID')}`;
  window.print();
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ── Startup & Initialization ──
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('today-date').textContent = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'full',
  }).format(new Date());

  try {
    const me = await request('/auth/me');
    document.getElementById('user-name').textContent = me.full_name;
    document.getElementById('user-role').textContent = me.role.toUpperCase();
    document.getElementById('user-initial').textContent = (me.full_name || 'A').charAt(0).toUpperCase();
    if (me.business_name) {
      updateBrandHeadings({ name: me.business_name, address: me.address, phone: me.phone });
    }
  } catch (err) {
    // Demo fallback is handled by server
  }

  loadDashboard();
});
