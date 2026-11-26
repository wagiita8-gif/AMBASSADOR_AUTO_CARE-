
'use strict';

const KEY = 'ambassadors_auto_care_pos_v2';
const API_BASE = 'https://ambassador-auto-care.onrender.com';

const seed = {
  products: [
    {id:'p1',name:'Engine Oil 5W-30',sku:'OIL-530',barcode:'',category:'Lubricants',cost:750,price:1200,stock:12,reorder:4,supplierLinks:[]},
    {id:'p2',name:'Brake Pads — Front',sku:'BRK-102',barcode:'',category:'Brakes',cost:2200,price:3500,stock:3,reorder:5,supplierLinks:[]},
    {id:'p3',name:'Car Battery 45Ah',sku:'BAT-045',barcode:'',category:'Batteries',cost:7200,price:9800,stock:8,reorder:2,supplierLinks:[]},
    {id:'p4',name:'Tyre 195/65 R15',sku:'TYR-195',barcode:'',category:'Tyres',cost:6500,price:8500,stock:14,reorder:4,supplierLinks:[]},
    {id:'p5',name:'Oil Filter',sku:'FLT-008',barcode:'',category:'Filters',cost:500,price:850,stock:26,reorder:6,supplierLinks:[]}
  ],
  suppliers: [
    {id:'s1',name:'Nakuru Auto Supplies',phone:'0712 000 000',email:'sales@example.com'}
  ],
  customers: [],
  sales: [],
  expenses: [],
  purchases: [],
  supplierPayments: [],
  creditPayments: [],
  cash: {open:false,opening:0,openedAt:null,movements:[]},
  settings: {
    shopName:'Ambassadors Auto Care',
    phone:'',
    address:'Nakuru, Kenya',
    receiptFooter:'Thank you for shopping with us.'
  }
};

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function load() {
  try {
    const x = JSON.parse(localStorage.getItem(KEY));

    if (x && Array.isArray(x.products) && Array.isArray(x.sales)) {
      return {
        ...clone(seed),
        ...x,
        customers: x.customers || [],
        purchases: x.purchases || [],
        supplierPayments: x.supplierPayments || [],
        creditPayments: x.creditPayments || [],
        expenses: x.expenses || [],
        cash: x.cash || clone(seed.cash),
        settings: {...seed.settings, ...(x.settings || {})}
      };
    }
  } catch (e) {}

  return clone(seed);
}



const OFFLINE_DB_NAME = 'ambassadors_auto_care_queue_v1';
const OFFLINE_STORE_NAME = 'transactions';

let offlineQueueDatabase = null;

function openOfflineQueueDB() {
  if (offlineQueueDatabase) return Promise.resolve(offlineQueueDatabase);

  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('This browser does not support offline storage.'));
      return;
    }

    const request = indexedDB.open(OFFLINE_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        database.createObjectStore(OFFLINE_STORE_NAME, {
          keyPath: 'requestId'
        });
      }
    };

    request.onsuccess = () => {
      offlineQueueDatabase = request.result;

      offlineQueueDatabase.onversionchange = () => {
        offlineQueueDatabase.close();
        offlineQueueDatabase = null;
      };

      resolve(offlineQueueDatabase);
    };

    request.onerror = () => reject(request.error);
  });
}

async function saveQueuedTransaction(record) {
  const database = await openOfflineQueueDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      OFFLINE_STORE_NAME,
      'readwrite'
    );

    transaction.objectStore(OFFLINE_STORE_NAME).put(record);

    transaction.oncomplete = () => resolve(record);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function getQueuedTransactions(shopId) {
  const database = await openOfflineQueueDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      OFFLINE_STORE_NAME,
      'readonly'
    );

    const request = transaction
      .objectStore(OFFLINE_STORE_NAME)
      .getAll();

    request.onsuccess = () => {
      resolve(
        request.result.filter(item => item.shopId === shopId)
      );
    };

    request.onerror = () => reject(request.error);
  });
}

async function updateQueuedTransaction(requestId, changes) {
  const database = await openOfflineQueueDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      OFFLINE_STORE_NAME,
      'readwrite'
    );

    const store = transaction.objectStore(OFFLINE_STORE_NAME);
    const request = store.get(requestId);

    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        return;
      }

      store.put({
        ...request.result,
        ...changes,
        requestId
      });
    };

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function deleteQueuedTransaction(requestId) {
  const database = await openOfflineQueueDB();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      OFFLINE_STORE_NAME,
      'readwrite'
    );

    transaction.objectStore(OFFLINE_STORE_NAME).delete(requestId);

    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}


let saleQueueSyncRunning = false;

async function sendQueuedSale(record) {
  const auth = getAuth();

  if (!auth || auth.shopId !== record.shopId || !navigator.onLine) {
    return false;
  }

  try {
    const attempts = Number(record.attempts || 0) + 1;

    await updateQueuedTransaction(record.requestId, {
      status: 'syncing',
      attempts,
      lastAttemptAt: new Date().toISOString()
    });

    const response = await fetch(
      `${API_BASE}/api/shops/${record.shopId}/sales`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(record.payload)
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.sale?.id) {
      const status =
        response.status === 401 || response.status === 403
          ? 'blocked'
          : response.status >= 400 && response.status < 500
            ? 'failed'
            : 'pending';

      await updateQueuedTransaction(record.requestId, {
        status,
        lastError: data.error || 'The server could not confirm this sale.'
      });

      return false;
    }

    await updateQueuedTransaction(record.requestId, {
      status: 'synced',
      serverSaleId: data.sale.id,
      syncedAt: new Date().toISOString(),
      lastError: null
    });

    return true;

  } catch (error) {
    try {
      await updateQueuedTransaction(record.requestId, {
        status: 'pending',
        lastError: error.message || 'Network connection failed.'
      });
    } catch (queueError) {
      console.error('Could not update queued sale:', queueError);
    }

    return false;
  }
}

async function syncPendingSales() {
  if (
    saleQueueSyncRunning ||
    !navigator.onLine ||
    !getAuth()
  ) {
    return;
  }

  saleQueueSyncRunning = true;

  try {
    const auth = getAuth();
    const records = await getQueuedTransactions(auth.shopId);

    const pendingSales = records
      .filter(record =>
        record.type === 'sale' &&
        (record.status === 'pending' || record.status === 'syncing')
      )
      .sort((a, b) =>
        new Date(a.createdAt) - new Date(b.createdAt)
      );

    for (const record of pendingSales) {
      if (!navigator.onLine) break;

      const currentAuth = getAuth();

      if (!currentAuth || currentAuth.shopId !== record.shopId) {
        break;
      }

      await sendQueuedSale(record);
    }

    await updateConnectionStatus();

  } catch (error) {
    console.error('Sale queue sync failed:', error);
  } finally {
    saleQueueSyncRunning = false;
  }
}

let db = load();
let cart = [];
let activeSaleRequestId = null;

const titles = {
  home:'Dashboard',
  products:'Products',
  sales:'Sales & Checkout',
  inventory:'Inventory',
  suppliers:'Suppliers',
  purchases:'Purchases',
  customers:'Customers & Credit',
  expenses:'Expenses & Charges',
  cash:'Cash Register',
  reports:'Reports',
  settings:'Settings'
};

const $ = id => document.getElementById(id);

const money = n =>
  'KSh ' + Number(n || 0).toLocaleString('en-KE', {
    minimumFractionDigits:2,
    maximumFractionDigits:2
  });

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));

const uid = () =>
  'x' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);

const toast = s => {
  const t = $('toast');
  if (!t) return;

  t.textContent = s;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2300);
};

function save() {
  localStorage.setItem(KEY, JSON.stringify(db));
  render();
}

function emptyRow(n, msg) {
  return `<tr><td colspan="${n}" class="empty">${esc(msg)}</td></tr>`;
}

// --------------------------------------------------
// CLOUD AUTHENTICATION
// --------------------------------------------------

function getAuth() {
  const auth = window.POS_AUTH;

  if (!auth?.authenticated || !auth.token || !auth.shopId) {
    return null;
  }

  return auth;
}

// --------------------------------------------------
// LOAD CLOUD PRODUCTS
// --------------------------------------------------

async function loadCloudProducts(silent = false) {
  const auth = getAuth();
  if (!auth) return false;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/products`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load products.');
    }

    if (!Array.isArray(data.products)) {
      throw new Error('Invalid products response.');
    }

    const localProducts = db.products;

    const updatedProducts = data.products.map(product => {
      const existing = localProducts.find(
        item => item.sku === product.sku
      );

      return {
        ...existing,
        id: product.id,
        name: product.name,
        sku: product.sku,
        price: Number(product.selling_price),
        stock: Number(product.quantity),
        category: existing?.category || 'Other',
        cost: existing?.cost || 0,
        reorder: existing?.reorder || 5,
        barcode: existing?.barcode || '',
        supplierLinks: existing?.supplierLinks || []
      };
    });

    const changed =
      JSON.stringify(db.products) !== JSON.stringify(updatedProducts);

    db.products = updatedProducts;

    if (changed) save();

    if (!silent) toast('Cloud products loaded.');

    return true;

  } catch (error) {
    console.error('Cloud product loading failed:', error);

    if (!silent) {
      toast('Could not load cloud products.');
    }

    return false;
  }
}

async function loadCloudSales(silent = false) {
  const auth = getAuth();
  if (!auth) return false;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/sales`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load sales.');
    }

    if (!Array.isArray(data.sales)) {
      throw new Error('Invalid sales response.');
    }

    const localOnlySales = db.sales
      .filter(s =>
        s.localOnly === true ||
        String(s.id || '').startsWith('x')
      )
      .map(s => ({
        ...s,
        localOnly: true
      }));

    const cloudSales = data.sales.map(s => ({
      id: s.id,
      receipt: s.receipt,
      date: s.created_at,
      customerId: s.customer_id || null,
      customerName: s.customer_name || 'Walk-in',
      payment: s.payment_method,
      subtotal: Number(s.subtotal),
      discount: Number(s.discount),
      total: Number(s.total),
      paid: Number(s.paid),
      balance: Number(s.balance),
      status: s.status,
      localOnly: false,
      items: (s.items || []).map(i => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        qty: Number(i.qty),
        price: Number(i.price),
        cost: 0
      }))
    }));

    const updatedSales = [...cloudSales, ...localOnlySales];

    const changed =
      JSON.stringify(db.sales) !== JSON.stringify(updatedSales);

    db.sales = updatedSales;

    if (changed) save();

    return true;

  } catch (error) {
    console.error('Cloud sales loading failed:', error);

    if (!silent) {
      toast('Could not load cloud sales.');
    }

    return false;
  }
}

async function loadCloudPurchases(silent = false) {
  const auth = getAuth();
  if (!auth) return false;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/purchases`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load purchases.');
    }

    if (!Array.isArray(data.purchases)) {
      throw new Error('Invalid purchases response.');
    }

    const localOnly = db.purchases
      .filter(p =>
        p.localOnly === true ||
        String(p.id || '').startsWith('x')
      )
      .map(p => ({ ...p, localOnly: true }));

    const cloudPurchases = data.purchases.map(p => ({
      id: p.id,
      supplierId: p.supplier_id,
      supplierName: p.supplier_name || '',
      invoice: p.invoice_number || '',
      date: p.purchase_date,
      items: (p.items || []).map(i => ({
        productId: i.productId,
        name: i.name,
        qty: Number(i.quantity),
        unitCost: Number(i.unitCost)
      })),
      total: Number(p.total),
      paid: Number(p.paid),
      balance: Number(p.balance),
      method: p.payment_method,
      localOnly: false
    }));

    db.purchases = [...cloudPurchases, ...localOnly];
    save();

    if (!silent) toast('Cloud purchases loaded.');

    return true;
  } catch (error) {
    console.error('Cloud purchase loading failed:', error);

    if (!silent) toast('Could not load cloud purchases.');

    return false;
  }
}

async function loadCloudSupplierPayments(silent = false) {
  const auth = getAuth();
  if (!auth) return false;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/supplier-payments`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load supplier payments.');
    }

    if (!Array.isArray(data.payments)) {
      throw new Error('Invalid supplier payments response.');
    }

    const localOnly = db.supplierPayments
      .filter(p =>
        p.localOnly === true ||
        String(p.id || '').startsWith('x')
      )
      .map(p => ({ ...p, localOnly: true }));

    const cloudPayments = data.payments.map(p => ({
      id: p.id,
      supplierId: p.supplier_id,
      supplierName: p.supplier_name || '',
      amount: Number(p.amount),
      method: p.method,
      reference: p.reference || '',
      notes: p.notes || '',
      date: p.created_at,
      allocations: p.allocations || [],
      localOnly: false
    }));

    db.supplierPayments = [...cloudPayments, ...localOnly];
    save();

    if (!silent) toast('Cloud supplier payments loaded.');

    return true;
  } catch (error) {
    console.error('Cloud supplier payment loading failed:', error);

    if (!silent) toast('Could not load cloud supplier payments.');

    return false;
  }
}

async function loadCloudCustomerPayments(silent = false) {
  const auth = getAuth();
  if (!auth) return false;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/customer-payments`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Could not load customer payments.');
    }

    if (!Array.isArray(data.payments)) {
      throw new Error('Invalid customer payments response.');
    }

    db.creditPayments = data.payments.map(p => ({
      id: p.id,
      customerId: p.customer_id,
      amount: Number(p.amount),
      method: p.method,
      reference: p.reference || '',
      notes: p.notes || '',
      date: p.created_at
    }));

    save();
    return true;

  } catch (error) {
    console.error('Cloud customer payments loading failed:', error);

    if (!silent) {
      toast('Could not load cloud customer payments.');
    }

    return false;
  }
}

let cloudSyncTimer = null;
let cloudSyncRunning = false;


function startCloudSync() {
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);

  const runSync = async () => {
    if (
      !getAuth() ||
      !navigator.onLine ||
      document.hidden ||
      cloudSyncRunning
    ) return;

    cloudSyncRunning = true;

    try {
      // Send saved offline sales first.
      await syncPendingSales();

      // Then refresh shared cloud records.
      await Promise.all([
        loadCloudPurchases(true),
        loadCloudSupplierPayments(true),
        loadCloudProducts(true),
        loadCloudSales(true),
        loadCloudCustomerPayments(true),
        loadCloudParties(true)
      ]);

      if (document.querySelector('#page-sales')?.classList.contains('active')) {
        renderSaleProducts();
      }

    } catch (error) {
      console.error('Automatic cloud sync failed:', error);
    } finally {
      cloudSyncRunning = false;
    }
  };

  // Try immediately after login, then every five seconds.
  runSync();
  cloudSyncTimer = setInterval(runSync, 5000);
}

document.addEventListener('pos:authenticated', async () => {
  updateConnectionStatus();

    await Promise.all([
    loadCloudPurchases(),
    loadCloudSupplierPayments(),
    loadCloudProducts(),
    loadCloudSales(),
    loadCloudParties(),
    loadCloudCustomerPayments()
  ]);

  startCloudSync();
});



// --------------------------------------------------
// NAVIGATION
// --------------------------------------------------

function go(p) {
  if (p !== 'sales') stopCameraScanner();

  document.querySelectorAll('.page').forEach(x =>
    x.classList.toggle('active', x.id === 'page-' + p)
  );

  document.querySelectorAll('[data-page]').forEach(x =>
    x.classList.toggle('active', x.dataset.page === p)
  );

  $('crumb').textContent = titles[p] || p;

  window.scrollTo(0, 0);

  if (p === 'sales') renderSaleProducts();
}

document.querySelectorAll('[data-page]').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.page))
);

document.querySelectorAll('[data-go]').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.go))
);

document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b) return;

  const a = b.dataset.action;

  ({
    'add-product': () => productForm(),
    'add-supplier': () => supplierForm(),
    'add-expense': () => expenseForm(),
    'add-customer': () => customerForm(),
    'add-purchase': () => purchaseForm()
  }[a] || (() => {}))();
});

// --------------------------------------------------
// MODALS
// --------------------------------------------------
function closeModal() {
  $('modalBack').classList.remove('open');
}
$('modalClose').onclick = closeModal;
$('modalCancel').onclick = closeModal;

$('modalBack').onclick = e => {
  if (e.target === $('modalBack')) {
    closeModal();
  }
};
function openModal(title, fields, onSave) {
  $('modalTitle').textContent = title;

  $('modalFields').innerHTML = fields.map(f => {
    let control;

    if (f.type === 'select') {
      control = `
        <select name="${f.name}" ${f.required ? 'required' : ''}>
          ${(f.options || []).map(o => {
            const value = typeof o === 'object' ? o.value : o;
            const label = typeof o === 'object' ? o.label : o;

            return `
              <option
                value="${esc(value)}"
                ${String(value) === String(f.value ?? '') ? 'selected' : ''}
              >
                ${esc(label)}
              </option>
            `;
          }).join('')}
        </select>
      `;
    } else if (f.type === 'textarea') {
      control = `
        <textarea
          name="${f.name}"
          rows="3"
          placeholder="${esc(f.placeholder || '')}"
          ${f.required ? 'required' : ''}
        >${esc(f.value ?? '')}</textarea>
      `;
    } else {
      control = `
        <input
          name="${f.name}"
          type="${f.type || 'text'}"
          ${f.min !== undefined ? `min="${f.min}"` : ''}
          ${f.step ? `step="${f.step}"` : ''}
          value="${esc(f.value ?? '')}"
          placeholder="${esc(f.placeholder || '')}"
          ${f.required ? 'required' : ''}
        >
      `;
    }

    return `
      <label class="${f.wide ? 'wide' : ''}">
        ${esc(f.label)}
        ${control}
      </label>
    `;
  }).join('');

  $('modalBack').classList.add('open');

  $('modalForm').onsubmit = async e => {
    e.preventDefault();

    const form = e.target;
    const submit = form.querySelector('[type="submit"]');

    if (submit) submit.disabled = true;

    try {
      const d = Object.fromEntries(new FormData(form));
      const result = await onSave(d);

      if (result !== false) {
        closeModal();
      }
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not save.');
    } finally {
      if (submit) submit.disabled = false;
    }
  };
}

// --------------------------------------------------
// PRODUCTS
// --------------------------------------------------

async function productForm(id) {
  const p = db.products.find(x => x.id === id) || {};

  openModal(id ? 'Edit product' : 'Add product', [
    {name:'name',label:'Product name',value:p.name,required:true},
    {name:'sku',label:'SKU',value:p.sku},
    {name:'barcode',label:'Barcode (optional)',value:p.barcode},
    {name:'category',label:'Category',value:p.category || 'Other',required:true},
    {name:'cost',label:'Buying price (KSh)',type:'number',min:0,step:'.01',value:p.cost ?? 0,required:true},
    {name:'price',label:'Selling price (KSh)',type:'number',min:0,step:'.01',value:p.price ?? 0,required:true},
    {name:'stock',label:'Stock quantity',type:'number',min:0,step:'1',value:p.stock ?? 0,required:true},
    {name:'reorder',label:'Reorder level',type:'number',min:0,step:'1',value:p.reorder ?? 5,required:true}
  ], async d => {
    const auth = getAuth();
    if (!auth) throw new Error('Please sign in first.');

    const name = d.name.trim();
    const sku = d.sku.trim() || makeSku(name);
    const price = Number(d.price);
    const stock = Number(d.stock);

    if (!name || !sku || !Number.isFinite(price) || price <= 0) {
      throw new Error('Enter a valid name, SKU and selling price.');
    }

    if (!Number.isSafeInteger(stock) || stock < 0) {
      throw new Error('Stock must be a whole number.');
    }

    if (db.products.some(x =>
      (x.sku || '').toLowerCase() === sku.toLowerCase() && x.id !== id
    )) {
      throw new Error('SKU already exists.');
    }

    const url = `${API_BASE}/api/shops/${auth.shopId}/products`;
    const headers = {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    let productId = id;

    if (id) {
      const response = await fetch(`${url}/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name,
          sku,
          sellingPrice: price
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Product update failed.');

      if (stock !== Number(p.stock)) {
        const stockResponse = await fetch(`${url}/${id}/stock-count`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            physicalQuantity: stock,
            reason: 'Physical count'
          })
        });

        const stockData = await stockResponse.json();
        if (!stockResponse.ok) {
          throw new Error(stockData.error || 'Details updated, but stock update failed. Refresh before retrying.');
        }
      }
    } else {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          sku,
          sellingPrice: price,
          quantity: stock
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Product creation failed.');

      productId = data.product.id;
    }

    const local = {
      ...p,
      id: productId,
      name,
      sku,
      barcode: d.barcode.trim(),
      category: d.category.trim(),
      cost: Number(d.cost),
      price,
      stock,
      reorder: Number(d.reorder),
      supplierLinks: p.supplierLinks || []
    };

    const index = db.products.findIndex(x => x.id === productId);
    if (index < 0) db.products.push(local);
    else db.products[index] = local;

    save();

    await loadCloudProducts(true);
    render();
    toast(id ? 'Product updated in cloud.' : 'Product saved to cloud.');
  });
}



function makeSku(name) {
  const prefix = name.toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0,3) || 'PRD';

  return prefix + '-' + Math.random().toString(36).slice(2,7).toUpperCase();
}
async function deleteProduct(id) {
  const p = db.products.find(x => x.id === id);
  if (!p) return;

  if (!confirm(`Remove "${p.name}" from the product catalogue?`)) return;

  // Older local-only products have non-UUID IDs.
  const isCloudId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (!isCloudId) {
    db.products = db.products.filter(x => x.id !== id);
    save();
    render();
    toast('Local product removed.');
    return;
  }

  try {
    const auth = getAuth();
    if (!auth) throw new Error('Please sign in first.');

    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/products/${id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Product deletion failed.');
    }

    db.products = db.products.filter(x => x.id !== id);
    save();

    await loadCloudProducts(true);
    render();
    toast('Product deleted from cloud.');
  } catch (error) {
    toast(error.message || 'Could not delete product.');
  }
}



// --------------------------------------------------
// PRODUCT SUPPLIERS
// --------------------------------------------------

function manageProductSuppliers(pid) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;

  const rows = (p.supplierLinks || []).map(l => {
    const s = db.suppliers.find(x => x.id === l.supplierId);

    return s ? `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${money(l.price)}</td>
        <td>
          <select class="field" onchange="setSupplierPreference('${pid}','${s.id}',this.value)">
            <option value="preferred" ${l.status === 'preferred' ? 'selected' : ''}>Preferred</option>
            <option value="alternative" ${l.status === 'alternative' ? 'selected' : ''}>Alternative</option>
            <option value="rarely_used" ${l.status === 'rarely_used' ? 'selected' : ''}>Rarely used</option>
          </select>
        </td>
        <td><button type="button" class="mini danger" onclick="unlinkSupplier('${pid}','${s.id}')">Remove</button></td>
      </tr>
    ` : '';
  }).join('');

  const opts = db.suppliers.filter(s =>
    !(p.supplierLinks || []).some(l => l.supplierId === s.id)
  );

  $('modalTitle').textContent = 'Product suppliers — ' + p.name;

  $('modalFields').innerHTML = `
    <div class="wide">
      <p class="notice">A product can have several suppliers but only one preferred supplier.</p>
      <div class="tablewrap">
        <table>
          <thead><tr><th>SUPPLIER</th><th>BUYING PRICE</th><th>PREFERENCE</th><th></th></tr></thead>
          <tbody>${rows || emptyRow(4,'No supplier linked yet.')}</tbody>
        </table>
      </div>
    </div>
    <label>
      Supplier
      <select class="field" id="linkSupplier">
        ${opts.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
      </select>
    </label>
    <label>Buying price<input class="field" id="linkPrice" type="number" min="0" step=".01"></label>
    <label>
      Preference
      <select class="field" id="linkStatus">
        <option value="alternative">Alternative</option>
        <option value="preferred">Preferred</option>
        <option value="rarely_used">Rarely used</option>
      </select>
    </label>
    <p class="notice wide">${opts.length ? 'Add a supplier link below.' : 'All suppliers already linked.'}</p>
  `;

  $('modalBack').classList.add('open');

  $('modalForm').onsubmit = e => {
    e.preventDefault();

    const sid = $('linkSupplier')?.value;
    const price = Number($('linkPrice')?.value);
    const status = $('linkStatus')?.value;

    if (!sid || !Number.isFinite(price) || price < 0) {
      toast('Choose a supplier and enter a valid price.');
      return;
    }

    if (status === 'preferred') {
      p.supplierLinks.forEach(x => x.status = 'alternative');
    }

    p.supplierLinks.push({supplierId:sid,price,status});

    save();
    manageProductSuppliers(pid);
  };
}

function setSupplierPreference(pid,sid,status) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;

  if (status === 'preferred') {
    p.supplierLinks.forEach(l => l.status = 'alternative');
  }

  const l = p.supplierLinks.find(x => x.supplierId === sid);

  if (l) l.status = status;

  save();
  manageProductSuppliers(pid);
}

function unlinkSupplier(pid,sid) {
  const p = db.products.find(x => x.id === pid);
  if (!p) return;

  p.supplierLinks = p.supplierLinks.filter(l => l.supplierId !== sid);

  save();
  manageProductSuppliers(pid);
}
// --------------------------------------------------
// CLOUD CUSTOMERS AND SUPPLIERS
// --------------------------------------------------

async function cloudRequest(path, options = {}) {
  const auth = getAuth();

  if (!auth) {
    throw new Error('Please sign in first.');
  }

  const response = await fetch(
    `${API_BASE}/api/shops/${auth.shopId}/${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Cloud request failed.');
  }

  return data;
}

async function loadCloudParties(silent = false) {
  if (!getAuth()) return false;

  try {
    const [customerData, supplierData] = await Promise.all([
      cloudRequest('customers'),
      cloudRequest('suppliers')
    ]);


    const selectedCustomerId = $('saleCustomer')?.value || '';

const selectedCustomer = db.customers.find(
  c => c.id === selectedCustomerId
);

const localCustomers = db.customers.filter(
  c => c.localOnly === true || String(c.id).startsWith('x')
);

const localSuppliers = db.suppliers.filter(
  s => s.localOnly === true || String(s.id).startsWith('x')
);
    const cloudCustomers = (customerData.customers || []).map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone || '',
      email: c.email || '',
      address: c.address || '',
      notes: c.notes || '',
      localOnly: false
    }));
if (
  selectedCustomer &&
  !cloudCustomers.some(c => c.id === selectedCustomerId)
) {
  cloudCustomers.push(selectedCustomer);
}
    const cloudSuppliers = (supplierData.suppliers || []).map(s => ({
      id: s.id,
      name: s.name,
      phone: s.phone || '',
      email: s.email || '',
      address: s.address || '',
      notes: s.notes || '',
      localOnly: false
    }));

    db.customers = [...cloudCustomers, ...localCustomers];
    db.suppliers = [...cloudSuppliers, ...localSuppliers];

    save();
    return true;

  } catch (error) {
    console.error('Cloud parties loading failed:', error);

    if (!silent) {
      toast('Could not load shared customers and suppliers.');
    }

    return false;
  }
}
// ADD SUPPLIER
function supplierForm() {
  openModal('Add supplier', [
    {name:'name',label:'Supplier / business name',required:true},
    {name:'phone',label:'Phone number'},
    {name:'email',label:'Email'},
    {name:'address',label:'Address'}
  ], async d => {
    const name = d.name.trim();

    if (!name) {
      toast('Supplier name is required.');
      return false;
    }

    try {
      const result = await cloudRequest('suppliers', {
        method: 'POST',
        body: JSON.stringify({
          name,
          phone: d.phone,
          email: d.email,
          address: d.address
        })
      });

      const s = result.supplier;

      db.suppliers.push({
        id: s.id,
        name: s.name,
        phone: s.phone || '',
        email: s.email || '',
        address: s.address || '',
        notes: s.notes || '',
        localOnly: false
      });

      save();
      toast('Supplier saved to shared cloud.');

    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not save supplier.');
      return false;
    }
  });
}

// DELETE SUPPLIER
async function deleteSupplier(id) {
  const supplier = db.suppliers.find(s => s.id === id);

  if (!supplier) return;

  if (!confirm('Delete this supplier from the shared shop records?')) {
    return;
  }

  try {
    await cloudRequest(`suppliers/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });

    db.suppliers = db.suppliers.filter(s => s.id !== id);

    db.products.forEach(p => {
      p.supplierLinks = (p.supplierLinks || [])
        .filter(l => l.supplierId !== id);
    });

    save();
    toast('Supplier deleted from shared records.');

  } catch (error) {
    console.error(error);
    toast(error.message || 'Could not delete supplier.');
  }
}

// ADD CUSTOMER
function customerForm() {
  openModal('Add customer', [
    {name:'name',label:'Full name',required:true},
    {name:'phone',label:'Phone number',required:true},
    {name:'email',label:'Email'},
    {name:'notes',label:'Notes',type:'textarea',wide:true}
  ], async d => {
    const name = d.name.trim();
    const phone = d.phone.trim();

    if (!name || !phone) {
      toast('Customer name and phone are required.');
      return false;
    }

    try {
      const result = await cloudRequest('customers', {
        method: 'POST',
        body: JSON.stringify({
          name,
          phone,
          email: d.email,
          notes: d.notes
        })
      });

      const c = result.customer;

      db.customers.push({
        id: c.id,
        name: c.name,
        phone: c.phone || '',
        email: c.email || '',
        address: c.address || '',
        notes: c.notes || '',
        localOnly: false
      });

      save();
      toast('Customer saved to shared cloud.');

    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not save customer.');
      return false;
    }
  });
}

// CUSTOMER BALANCE
function customerBalance(id) {
  return db.sales
    .filter(s => s.customerId === id)
    .reduce((a, s) => a + Number(s.balance || 0), 0);
}
async function payCustomer(id) {
  const customer = db.customers.find(c => c.id === id);
  const due = customerBalance(id);
  const auth = getAuth();

  if (!customer) {
    return toast('Customer not found.');
  }

  if (!auth) {
    return toast('Please log in first.');
  }

  if (!navigator.onLine) {
    return toast('Internet connection required to record customer payments.');
  }

  if (due <= 0) {
    return toast('No outstanding customer balance.');
  }

  openModal('Receive payment — ' + customer.name, [
    {
      name: 'amount',
      label: 'Payment amount (KSh)',
      type: 'number',
      min: 0.01,
      max: due,
      step: '0.01',
      required: true
    },
    {
      name: 'method',
      label: 'Payment method',
      type: 'select',
      options: ['Cash', 'M-Pesa', 'Bank', 'Card', 'Other']
    },
    {
      name: 'reference',
      label: 'Reference'
    },
    {
      name: 'notes',
      label: 'Notes',
      type: 'textarea'
    }
  ], async d => {
    const amount = Number(d.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > due ||
      Math.round(amount * 100) !== amount * 100
    ) {
      toast('Enter a valid amount not exceeding the outstanding balance.');
      return false;
    }

    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/customer-payments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          customerId: id,
          amount,
          method: d.method,
          reference: d.reference,
          notes: d.notes
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Customer payment failed.');
    }

    await Promise.all([
      loadCloudSales(),
      loadCloudCustomerPayments()
    ]);

    render();
    toast('Customer payment recorded successfully.');
  });
}
    

// --------------------------------------------------
// SUPPLIER PAYMENTS
// --------------------------------------------------

function supplierBalance(id) {
  return db.purchases
    .filter(p => p.supplierId === id)
    .reduce((a,p) => a + p.balance, 0);
}


function paySupplier(id) {
  const s = db.suppliers.find(x => x.id === id);
  const due = supplierBalance(id);
  const auth = getAuth();

  if (!s || due <= 0) {
    return toast('No outstanding supplier balance.');
  }

  if (!auth || !navigator.onLine) {
    return toast('Connect to the internet to record this payment.');
  }

  if (!crypto.randomUUID) {
    return toast('This browser cannot create a secure payment ID.');
  }

  const requestId = crypto.randomUUID();

  openModal('Pay supplier — ' + s.name, [
    {
      name:'amount',
      label:'Payment amount (KSh)',
      type:'number',
      min:.01,
      step:'.01',
      required:true
    },
    {
      name:'method',
      label:'Payment method',
      type:'select',
      options:['Cash','M-Pesa','Bank','Card','Other']
    },
    {name:'reference',label:'Reference'},
    {name:'notes',label:'Notes'}
  ], async d => {
    const amount = Number(d.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > due ||
      Math.round(amount * 100) !== amount * 100
    ) {
      toast('Enter a valid payment not exceeding the balance.');
      return false;
    }

    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/supplier-payments`,
      {
        method:'POST',
        headers:{
          Authorization:`Bearer ${auth.token}`,
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify({
          requestId,
          supplierId:id,
          amount,
          method:d.method,
          reference:d.reference || '',
          notes:d.notes || ''
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Could not record supplier payment.');
    }

    await Promise.all([
      loadCloudPurchases(true),
      loadCloudSupplierPayments(true)
    ]);

    toast('Supplier payment recorded in the cloud.');
  });
}


// --------------------------------------------------
// EXPENSES
// --------------------------------------------------

function expenseForm() {
  openModal('Record expense or charge', [
    {name:'type',label:'Entry type',type:'select',options:['Expense','Charge']},
    {name:'category',label:'Category',type:'select',options:['WiFi','Airtime','Rent','E-Bill','Parcel','Bike','Stock purchase','Transport','Utilities','Repairs','Wages','Other']},
    {name:'description',label:'Description',wide:true},
    {name:'amount',label:'Amount (KSh)',type:'number',min:.01,step:'.01',required:true},
    {name:'method',label:'Payment method',type:'select',options:['Cash','M-Pesa','Bank','Card','Other']},
    {name:'date',label:'Date',type:'date',value:new Date().toISOString().slice(0,10)}
  ], d => {
    const amount = Number(d.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a positive amount.');
      return false;
    }

    db.expenses.push({
      id:uid(),
      ...d,
      amount,
      date:d.date || new Date().toISOString().slice(0,10),
      status:'active'
    });

    save();
    toast('Expense recorded locally.');
  });
}

function deleteExpense(id) {
  if (!confirm('Void this expense? It will be retained in the local records as voided.')) return;

  const x = db.expenses.find(e => e.id === id);

  if (x) {
    x.status = 'voided';
    x.voidedAt = new Date().toISOString();
  }

  save();
}

// --------------------------------------------------
// PURCHASES
// --------------------------------------------------



function purchaseForm() {
  if (!db.suppliers.length) {
    toast('Add a supplier first.');
    return;
  }

  if (!db.products.length) {
    toast('Add a product first.');
    return;
  }

  const auth = getAuth();

  if (!auth || !navigator.onLine) {
    toast('Connect to the internet to record a cloud purchase.');
    return;
  }

  if (!crypto.randomUUID) {
    toast('This browser cannot create a secure purchase ID.');
    return;
  }

  const requestId = crypto.randomUUID();

  const supplierOpts = db.suppliers
    .filter(s => !s.localOnly)
    .map(s => ({
      value:s.id,
      label:s.name
    }));

  const productOpts = db.products
    .filter(p => !p.localOnly)
    .map(p => ({
      value:p.id,
      label:p.name + ' (' + p.sku + ')'
    }));

  if (!supplierOpts.length || !productOpts.length) {
    toast('Cloud suppliers and products must be loaded first.');
    return;
  }

  openModal('Record supplier purchase', [
    {
      name:'supplierId',
      label:'Supplier',
      type:'select',
      options:supplierOpts,
      required:true
    },
    {name:'invoice',label:'Supplier invoice number'},
    {
      name:'productId',
      label:'Product received',
      type:'select',
      options:productOpts,
      required:true
    },
    {
      name:'qty',
      label:'Quantity received',
      type:'number',
      min:.001,
      step:'.001',
      required:true
    },
    {
      name:'unitCost',
      label:'Buying price per unit',
      type:'number',
      min:0,
      step:'.01',
      required:true
    },
    {
      name:'paidNow',
      label:'Amount paid now',
      type:'number',
      min:0,
      step:'.01',
      value:0,
      required:true
    },
    {
      name:'method',
      label:'Payment method',
      type:'select',
      options:['Cash','M-Pesa','Bank','Card','Other']
    },
    {
      name:'date',
      label:'Purchase date',
      type:'date',
      value:new Date().toISOString().slice(0,10)
    }
  ], async d => {
    const p = db.products.find(x => x.id === d.productId);
    const supplier = db.suppliers.find(x => x.id === d.supplierId);

    const qty = Number(d.qty);
    const cost = Number(d.unitCost);
    const paid = Number(d.paidNow);
    const total = Math.round(qty * cost * 100) / 100;

    if (
      !p ||
      !supplier ||
      qty <= 0 ||
      cost < 0 ||
      paid < 0 ||
      paid > total ||
      ![qty,cost,paid].every(Number.isFinite) ||
      Math.round(qty * 1000) !== qty * 1000 ||
      Math.round(cost * 100) !== cost * 100 ||
      Math.round(paid * 100) !== paid * 100 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')
    ) {
      toast('Check supplier, product, date, quantity and payment.');
      return false;
    }

    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/purchases`,
      {
        method:'POST',
        headers:{
          Authorization:`Bearer ${auth.token}`,
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify({
          requestId,
          supplierId:d.supplierId,
          invoiceNumber:d.invoice || '',
          productId:d.productId,
          quantity:qty,
          unitCost:cost,
          paid,
          paymentMethod:d.method,
          purchaseDate:d.date,
          notes:''
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Could not record purchase.');
    }

    p.cost = cost;

    p.supplierLinks = p.supplierLinks || [];

    const link = p.supplierLinks.find(
      item => item.supplierId === supplier.id
    );

    if (link) {
      link.price = cost;
    } else {
      p.supplierLinks.push({
        supplierId:supplier.id,
        price:cost,
        status:p.supplierLinks.some(
          item => item.status === 'preferred'
        ) ? 'alternative' : 'preferred'
      });
    }

    save();

    await Promise.all([
      loadCloudProducts(true),
      loadCloudPurchases(true),
      loadCloudSupplierPayments(true)
    ]);

    toast('Purchase recorded in the cloud.');
  });
}

// --------------------------------------------------
// CAMERA BARCODE SCANNER
// --------------------------------------------------

let cameraStream = null;
let cameraTimer = null;
let cameraDetector = null;
let cameraBusy = false;

async function startCameraScanner() {
  const panel = $('cameraPanel');
  const video = $('cameraVideo');
  const status = $('cameraStatus');

  panel.style.display = 'block';

  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'Camera access is unavailable in this browser or page context. Use the barcode / SKU field instead.';
    return;
  }

  if (!('BarcodeDetector' in window)) {
    status.textContent = 'This browser does not provide the built-in barcode scanner. Try a current Chrome browser on HTTPS, or enter the barcode manually.';
    return;
  }

  try {
    const supported = await BarcodeDetector.getSupportedFormats();

    const wanted = [
      'code_128','ean_13','ean_8','upc_a','upc_e',
      'qr_code','code_39','itf','codabar'
    ];

    const formats = wanted.filter(x => supported.includes(x));

    cameraDetector = new BarcodeDetector({
      formats:formats.length ? formats : undefined
    });

    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{
        facingMode:{ideal:'environment'},
        width:{ideal:1280},
        height:{ideal:720}
      }
    });

    video.srcObject = cameraStream;
    await video.play();

    status.textContent = 'Camera active. Point it at a product barcode; scanning will add a match to your cart.';

    scanCameraFrame();

  } catch (err) {
    stopCameraScanner();

    status.textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in browser settings, or enter the barcode manually.'
        : err?.name === 'NotFoundError'
          ? 'No camera was found on this device. Use manual barcode entry.'
          : 'Could not start the camera. Check browser permissions and use HTTPS or localhost.';
  }
}

async function scanCameraFrame() {
  if (!cameraStream || !cameraDetector || cameraBusy) return;

  const video = $('cameraVideo');

  if (video.readyState >= 2) {
    cameraBusy = true;

    try {
      const codes = await cameraDetector.detect(video);

      if (codes.length) {
        const code = String(codes[0].rawValue || '').trim();

        if (code) {
          handleScannedCode(code);
          return;
        }
      }
    } catch (e) {}

    cameraBusy = false;
  }

  cameraTimer = requestAnimationFrame(scanCameraFrame);
}

function handleScannedCode(code) {
  stopCameraScanner();

  const p = db.products.find(x =>
    (x.barcode || '').trim().toLowerCase() === code.toLowerCase() ||
    (x.sku || '').trim().toLowerCase() === code.toLowerCase()
  );

  if (p) {
    addToCart(p.id);
    $('saleSearch').value = '';
    renderSaleProducts();
    toast('Scanned ' + p.name + ' and added to cart.');
  } else {
    $('saleSearch').value = code;
    renderSaleProducts();
    toast('Barcode not found. Add/assign it to a product first.');
  }
}

function stopCameraScanner() {
  if (cameraTimer) cancelAnimationFrame(cameraTimer);

  cameraTimer = null;
  cameraBusy = false;

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }

  const video = $('cameraVideo');

  if (video) {
    video.pause();
    video.srcObject = null;
  }
}

$('openCamera').onclick = startCameraScanner;

$('closeCamera').onclick = () => {
  stopCameraScanner();
  $('cameraPanel').style.display = 'none';
};

window.addEventListener('pagehide', stopCameraScanner);

// --------------------------------------------------
// CLOUD CHECKOUT
// --------------------------------------------------
async function completeSale() {
  if (!cart.length) {
    return toast('Add products to the cart first.');
  }

  const auth = getAuth();

  if (!auth) {
    return toast('Please log in before recording a sale.');
  }

  if (!crypto.randomUUID) {
    return toast('This browser cannot create a secure sale ID.');
  }

  const subtotal = cart.reduce((sum, item) => {
    const product = db.products.find(p => p.id === item.id);
    return sum + (product ? product.price * item.qty : 0);
  }, 0);

  const discount = Math.max(0, Number($('discount').value) || 0);
  const total = +(subtotal - discount).toFixed(2);

  const raw = $('amountPaid').value;
  const paid = raw === '' ? total : Number(raw);

  const customerId = $('saleCustomer').value || null;
  const customer = db.customers.find(c => c.id === customerId);

  if (discount > subtotal) {
    return toast('Discount cannot exceed subtotal.');
  }

  if (
    !Number.isFinite(paid) ||
    paid < 0 ||
    paid > total ||
    Math.round(paid * 100) !== paid * 100
  ) {
    return toast('Enter a valid payment amount.');
  }

  if (paid < total && !customerId) {
    return toast('Select a customer before recording a credit sale.');
  }

  for (const item of cart) {
    const product = db.products.find(p => p.id === item.id);

    if (!product || product.stock < item.qty) {
      return toast('Stock changed; review your cart.');
    }
  }

  const requestId = crypto.randomUUID();

  const receipt =
    'AA-' +
    Date.now().toString() +
    '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase();

  const payload = {
    requestId,
    receipt,
    customerId,
    customerName: customer?.name || 'Walk-in',
    paymentMethod: paid === 0 ? 'Credit' : $('paymentMethod').value,
    discount,
    paid,
    items: cart.map(item => ({
      productId: item.id,
      qty: item.qty
    }))
  };

  const record = {
    requestId,
    shopId: auth.shopId,
    type: 'sale',
    payload,
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastError: null
  };

  const button = $('completeSale');
  button.disabled = true;

  try {
    // Save the complete transaction before attempting cloud delivery.
    await saveQueuedTransaction(record);

    // The saved transaction can now survive a page reload.
    cart = [];
    activeSaleRequestId = null;

    $('discount').value = 0;
    $('amountPaid').value = '';
    $('saleCustomer').value = '';

    renderCart();

    if (!navigator.onLine) {
      toast('Sale saved on this device. Waiting for internet sync.');
      return;
    }

    const synced = await sendQueuedSale(record);

    if (synced) {
      await Promise.all([
        loadCloudProducts(true),
        loadCloudSales(true)
      ]);

      toast('Sale saved to the cloud!');
      return;
    }

    toast('Sale saved locally. Cloud sync is still pending.');

  } catch (error) {
    console.error('Sale queue error:', error);
    toast('Sale was not queued. Your cart has been kept.');
  } finally {
    button.disabled = false;
  }
}

function viewReceipt(id) {
  const s = db.sales.find(x => x.id === id);

  if (!s) {
    toast('Receipt not found in the loaded sales.');
    return;
  }

  const lines = s.items.map(i =>
    `${i.name} × ${i.qty}  ${money(i.price * i.qty)}`
  ).join('\n');

  const settings = db.settings;

  const receipt = `
${settings.shopName}
${settings.address || ''}
${settings.phone || ''}
--------------------------------
Receipt: ${s.receipt}
Date: ${new Date(s.date).toLocaleString()}
Customer: ${s.customerName}
--------------------------------
${lines}
--------------------------------
Subtotal: ${money(s.subtotal)}
Discount: ${money(s.discount)}
TOTAL: ${money(s.total)}
Paid (${s.payment}): ${money(s.paid)}
Balance: ${money(s.balance)}
${s.balance > 0 ? 'CREDIT SALE — PLEASE PAY BALANCE' : ''}
--------------------------------
${settings.receiptFooter || 'Thank you.'}
DEMO RECEIPT — NOT A TAX INVOICE
`;

  const w = window.open('', '_blank', 'width=420,height=650');

  if (!w) {
    alert(receipt);
    return;
  }

  w.document.write(`
    <html>
      <head>
        <title>${esc(s.receipt)}</title>
        <style>
          body {
            font:13px monospace;
            padding:20px;
            white-space:pre-wrap;
          }
          button { padding:8px 15px; }
          @media print {
            button { display:none; }
          }
        </style>
      </head>
      <body>
        ${esc(receipt)}
        <p><button onclick="window.print()">Print receipt</button></p>
      </body>
    </html>
  `);

  w.document.close();
}

// --------------------------------------------------
// CART AND SALE PRODUCTS
// --------------------------------------------------

function renderSaleProducts() {
  const q = ($('saleSearch')?.value || '').toLowerCase().trim();

  const list = db.products.filter(p =>
    (p.name + ' ' + p.sku + ' ' + p.barcode + ' ' + p.category)
      .toLowerCase()
      .includes(q)
  );

  $('saleProducts').innerHTML = list.map(p => `
    <div class="productpick">
      <div>
        <b>${esc(p.name)}</b>
        <small>${esc(p.sku)} ${p.barcode ? '· ' + esc(p.barcode) : ''} · ${p.stock} available · ${money(p.price)}</small>
      </div>
      <button class="btn secondary" ${p.stock <= 0 ? 'disabled' : ''} onclick="addToCart('${p.id}')">Add</button>
    </div>
  `).join('') || '<div class="empty">No matching products.</div>';
}

function addToCart(id) {
  const p = db.products.find(x => x.id === id);
  const line = cart.find(x => x.id === id);

  if (!p || p.stock <= 0) return toast('This product is out of stock.');

  if (line && line.qty + 1 > p.stock) {
    return toast('Not enough stock.');
  }

  line ? line.qty++ : cart.push({id,qty:1});

  renderCart();
}

function changeQty(id,n) {
  const i = cart.find(x => x.id === id);
  const p = db.products.find(x => x.id === id);

  if (!i || !p) return;

  if (i.qty + n <= 0) {
    cart = cart.filter(x => x.id !== id);
  } else if (i.qty + n > p.stock) {
    return toast('Not enough stock.');
  } else {
    i.qty += n;
  }

  renderCart();
}

function renderCart() {
  if (!$('cartItems')) return;

  $('cartItems').innerHTML = cart.length
    ? cart.map(i => {
        const p = db.products.find(x => x.id === i.id);

        return `
          <div class="cartline">
            <div>
              <b>${esc(p?.name || 'Removed product')}</b>
              <small>${money(p?.price)} each</small>
              <button class="mini" onclick="changeQty('${i.id}',-1)">−</button>
              <b>${i.qty}</b>
              <button class="mini" onclick="changeQty('${i.id}',1)">＋</button>
            </div>
            <b>${money((p?.price || 0) * i.qty)}</b>
          </div>
        `;
      }).join('')
    : '<div class="empty">Your cart is empty. Add a product.</div>';

  const sub = cart.reduce((a,i) =>
    a + (db.products.find(p => p.id === i.id)?.price || 0) * i.qty, 0
  );

  const disc = Math.max(0, Number($('discount').value) || 0);
  const total = Math.max(0,sub-disc);

  $('cartSubtotal').textContent = money(sub);
  $('cartDiscount').textContent = money(disc);
  $('cartTotal').textContent = money(total);
}

$('saleSearch').addEventListener('input', renderSaleProducts);

$('saleSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const code = e.target.value.trim().toLowerCase();

    const p = db.products.find(x =>
      (x.barcode || '').toLowerCase() === code ||
      (x.sku || '').toLowerCase() === code
    );

    if (p) {
      addToCart(p.id);
      e.target.value = '';
      renderSaleProducts();
    } else {
      toast('No product found for that barcode / SKU.');
    }
  }
});

$('discount').oninput = renderCart;

$('clearCart').onclick = () => {
  cart = [];
  renderCart();
};

$('completeSale').onclick = completeSale;
async function adjustStock(id) {
  const product = db.products.find(p => p.id === id);
  if (!product) return toast('Product not found.');

  const input = prompt(
    `Physical quantity counted for ${product.name}:`,
    String(product.stock)
  );

  if (input === null) return;

  const quantity = Number(input);

  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    return toast('Enter a valid non-negative whole number.');
  }

  const auth = getAuth();
  if (!auth) return toast('Please log in first.');

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/products/${id}/stock-count`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          physicalQuantity: quantity,
          reason: 'Physical stock count'
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Stock count failed.');
    }

    await loadCloudProducts(true);
    render();
    toast('Physical stock count recorded.');
  } catch (error) {
    toast(error.message || 'Could not update stock.');
  }
}
// --------------------------------------------------
// MAIN RENDER
// --------------------------------------------------

function renderSaleCustomerOptions() {
  const select = $('saleCustomer');
  if (!select) return;

  const selectedId = select.value;
  const selectedOption = select.selectedOptions[0];

  // Keep a selected customer even if a refresh temporarily omits it.
  if (
    selectedId &&
    selectedOption &&
    !db.customers.some(c => String(c.id) === selectedId)
  ) {
    const label = selectedOption.textContent || '';
    const separator = label.lastIndexOf(' — ');

    db.customers.unshift({
      id: selectedId,
      name: separator >= 0 ? label.slice(0, separator) : label,
      phone: separator >= 0 ? label.slice(separator + 3) : '',
      email: '',
      address: '',
      notes: '',
      localOnly: false
    });
  }

  select.innerHTML =
    '<option value="">Walk-in customer</option>' +
    db.customers.map(c =>
      `<option value="${c.id}">${esc(c.name)} — ${esc(c.phone)}</option>`
    ).join('');

  if (selectedId) select.value = selectedId;
}

function render() {
  const today = new Date().toDateString();

  const todaySales = db.sales.filter(s =>
    new Date(s.date).toDateString() === today
  );

  const total = db.sales.reduce((a,s) => a + Number(s.total || 0), 0);

  const expenses = db.expenses
    .filter(x => x.status !== 'voided')
    .reduce((a,x) => a + Number(x.amount || 0), 0);

  $('today').textContent = new Date().toLocaleDateString('en-KE', {
    weekday:'long',
    day:'numeric',
    month:'long',
    year:'numeric'
  });

  $('dashSales').textContent = money(
    todaySales.reduce((a,s) => a + Number(s.total || 0), 0)
  );

  $('dashCount').textContent = todaySales.length;
  $('dashProducts').textContent = db.products.length;

  $('dashLow').textContent = db.products.filter(
    p => p.stock <= p.reorder
  ).length;

  $('productRows').innerHTML = db.products.map(p => {
    const pref = (p.supplierLinks || []).find(
      l => l.status === 'preferred'
    );

    const s = db.suppliers.find(x => x.id === pref?.supplierId);

    return `
      <tr>
        <td><b>${esc(p.name)}</b><span class="sub">${esc(p.category)}</span></td>
        <td>${esc(p.sku)}</td>
        <td>${esc(p.barcode || '—')}</td>
        <td>${esc(p.category)}</td>
        <td>${money(p.cost)}</td>
        <td>${money(p.price)}</td>
        <td>${p.stock}</td>
        <td>
          ${s ? `<b>${esc(s.name)}</b><span class="sub">${money(pref.price)} buying</span>` : 'Not set'}
          <br>
          <button class="mini" style="margin-top:4px" onclick="manageProductSuppliers('${p.id}')">Manage</button>
        </td>
        <td>
          <div class="actions">
            <button class="mini" onclick="productForm('${p.id}')">Edit</button>
            <button class="mini" onclick="deleteProduct('${p.id}')">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('') || emptyRow(9,'No products yet.');

  $('inventoryRows').innerHTML = db.products.map(p => `
    <tr>
      <td><b>${esc(p.name)}</b></td>
      <td>${esc(p.sku)}</td>
      <td>${p.stock}</td>
      <td>${p.reorder}</td>
      <td>
        <span class="pill ${p.stock <= p.reorder ? 'low' : ''}">
          ${p.stock <= p.reorder ? 'Low stock' : 'In stock'}
        </span>
      </td>
      <td><button class="mini" onclick="adjustStock('${p.id}')">Physical count</button></td>
    </tr>
  `).join('') || emptyRow(6,'No products.');

  $('supplierRows').innerHTML = db.suppliers.map(s => `
    <tr>
      <td><b>${esc(s.name)}</b></td>
      <td>${esc(s.phone)}</td>
      <td>${esc(s.email)}</td>
      <td>${money(supplierBalance(s.id))}</td>
      <td>
        <div class="actions">
          <button class="mini" onclick="paySupplier('${s.id}')">Pay</button>
          <button class="mini" onclick="deleteSupplier('${s.id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('') || emptyRow(5,'No suppliers.');

  $('supplierPaymentRows').innerHTML = db.supplierPayments
    .slice().reverse().map(x => `
      <tr>
        <td>${new Date(x.date).toLocaleString()}</td>
        <td>${esc(db.suppliers.find(s => s.id === x.supplierId)?.name || 'Removed supplier')}</td>
        <td>${money(x.amount)}</td>
        <td>${esc(x.method)}</td>
        <td>${esc(x.reference || '—')}</td>
      </tr>
    `).join('') || emptyRow(5,'No supplier payments.');

  $('customerRows').innerHTML = db.customers.map(c => {
    const sales = db.sales.filter(s => s.customerId === c.id);

    const original = sales.reduce((a,s) => a + Number(s.total || 0), 0);
    const paid = sales.reduce((a,s) => a + Number(s.paid || 0), 0);
    const bal = customerBalance(c.id);

    return `
      <tr>
        <td><b>${esc(c.name)}</b><span class="sub">${esc(c.email || '')}</span></td>
        <td>${esc(c.phone)}</td>
        <td>${money(original)}</td>
        <td>${money(paid)}</td>
        <td><b>${money(bal)}</b></td>
        <td>
          <div class="actions">
            <button class="mini" onclick="payCustomer('${c.id}')">Receive payment</button>
            <button class="mini" onclick="customerStatement('${c.id}')">Statement</button>
          </div>
        </td>
      </tr>
    `;
  }).join('') || emptyRow(6,'No customers yet.');

  $('creditPaymentRows').innerHTML = db.creditPayments
    .slice().reverse().map(x => `
      <tr>
        <td>${new Date(x.date).toLocaleString()}</td>
        <td>${esc(db.customers.find(c => c.id === x.customerId)?.name || 'Removed customer')}</td>
        <td>${money(x.amount)}</td>
        <td>${esc(x.method)}</td>
        <td>${esc(x.reference || '—')}</td>
      </tr>
    `).join('') || emptyRow(5,'No credit payments recorded.');

  const credit = db.sales.reduce((a,s) => a + Number(s.balance || 0), 0);

  $('creditTotal').textContent = money(credit);

  $('creditCustomers').textContent = db.customers.filter(
    c => customerBalance(c.id) > 0
  ).length;

  $('purchaseRows').innerHTML = db.purchases
    .slice().reverse().map(p => `
      <tr>
        <td>${esc(p.date)}</td>
        <td>${esc(p.invoice)}</td>
        <td>${esc(db.suppliers.find(s => s.id === p.supplierId)?.name || 'Removed supplier')}</td>
        <td>${p.items.map(i => esc(i.name) + ' × ' + i.qty).join(', ')}</td>
        <td>${money(p.total)}</td>
        <td>${money(p.paid)}</td>
        <td>${money(p.balance)}</td>
        <td><button class="mini" onclick="purchaseDetails('${p.id}')">Details</button></td>
      </tr>
    `).join('') || emptyRow(8,'No purchases recorded.');

  $('purchaseTotal').textContent = money(
    db.purchases.reduce((a,p) => a + Number(p.total || 0), 0)
  );

  $('supplierDue').textContent = money(
    db.suppliers.reduce((a,s) => a + supplierBalance(s.id), 0)
  );

  $('expenseRows').innerHTML = db.expenses
    .slice().reverse().map(x => `
      <tr>
        <td>${esc(x.date)}</td>
        <td>${esc(x.type)}</td>
        <td>${esc(x.category)}</td>
        <td>${esc(x.description)}</td>
        <td>
          ${money(x.amount)}
          ${x.status === 'voided' ? '<span class="pill red">Voided</span>' : ''}
        </td>
        <td>
          ${x.status === 'voided' ? '—' : `<button class="mini" onclick="deleteExpense('${x.id}')">Void</button>`}
        </td>
      </tr>
    `).join('') || emptyRow(6,'No expenses.');

  $('expenseTotal').textContent = money(expenses);

  $('expenseCount').textContent = db.expenses.filter(
    x => x.status !== 'voided'
  ).length;

  $('salesRows').innerHTML = db.sales
    .slice().reverse().map(s => `
      <tr>
        <td>
          <b>${esc(s.receipt)}</b>
          ${s.localOnly ? '<span class="sub">Local only</span>' : ''}
        </td>
        <td>${new Date(s.date).toLocaleString()}</td>
        <td>${esc(s.customerName)}</td>
        <td>${esc(s.payment)}</td>
        <td><span class="pill ${s.balance > 0 ? 'low' : ''}">${esc(s.status)}</span></td>
        <td><b>${money(s.total)}</b></td>
        <td><button class="mini" onclick="viewReceipt('${s.id}')">Receipt</button></td>
      </tr>
    `).join('') || emptyRow(7,'No sales yet.');

    $('recentSales').innerHTML = db.sales.length
    ? db.sales
        .slice()
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 4)
        .map(s => `
          <div class="productpick">
            <div>
              <b>${esc(s.receipt)}</b>
              <small>${esc(s.customerName)} · ${new Date(s.date).toLocaleString()}</small>
            </div>
            <b>${money(s.total)}</b>
          </div>
        `).join('')
    : '<div class="empty">No transactions yet.</div>';

  const low = db.products.filter(p => p.stock <= p.reorder);

  $('lowList').innerHTML = low.length
    ? low.map(p => `
        <div class="productpick">
          <div>
            <b>${esc(p.name)}</b>
            <small>${esc(p.category)}</small>
          </div>
          <span class="pill low">${p.stock} left</span>
        </div>
      `).join('')
    : '<div class="empty">No low-stock products.</div>';

  $('reportSales').textContent = money(total);
  $('reportExpenses').textContent = money(expenses);

  $('reportProfit').textContent = money(
    db.sales.reduce((a,s) =>
      a + s.items.reduce((b,i) =>
        b + ((i.price - (i.cost || 0)) * i.qty), 0
      ), 0
    ) - expenses
  );

  const best = {};

  db.sales.forEach(s =>
    s.items.forEach(i =>
      best[i.name] = (best[i.name] || 0) + i.qty
    )
  );

  const sorted = Object.entries(best).sort((a,b) => b[1] - a[1]);

  $('bestSellers').innerHTML = sorted.length
    ? sorted.map(([n,q]) => `
        <div class="productpick">
          <b>${esc(n)}</b>
          <span>${q} units</span>
        </div>
      `).join('')
    : '<div class="empty">Complete sales to see best sellers.</div>';

const saleCustomerSelect = $('saleCustomer');
const selectedCustomerId = saleCustomerSelect.value;
const selectedCustomerOption =
  saleCustomerSelect.selectedOptions[0];

if (
  selectedCustomerId &&
  selectedCustomerOption &&
  !db.customers.some(c => String(c.id) === selectedCustomerId)
) {
  const label = selectedCustomerOption.textContent || '';
  const separator = label.lastIndexOf(' — ');

  db.customers.unshift({
    id: selectedCustomerId,
    name: separator >= 0
      ? label.slice(0, separator)
      : label,
    phone: separator >= 0
      ? label.slice(separator + 3)
      : '',
    email: '',
    address: '',
    notes: '',
    localOnly: false
  });
}

saleCustomerSelect.innerHTML =
  '<option value="">Walk-in customer</option>' +
  db.customers.map(c =>
    `<option value="${c.id}">${esc(c.name)} — ${esc(c.phone)}</option>`
  ).join('');

if (
  selectedCustomerId &&
  db.customers.some(c => String(c.id) === selectedCustomerId)
) {
  saleCustomerSelect.value = selectedCustomerId;
}

  
  renderSaleProducts();
  renderCart();
  renderCash();
}

// --------------------------------------------------
// CUSTOMER STATEMENT AND PURCHASE DETAILS
// --------------------------------------------------

function customerStatement(id) {
  const c = db.customers.find(x => x.id === id);
  if (!c) return;

  const sales = db.sales.filter(s => s.customerId === id);

  const txt =
    `CUSTOMER STATEMENT\n${c.name}\n${c.phone}\n\n` +
    sales.map(s =>
      `${s.receipt} | ${new Date(s.date).toLocaleDateString()} | Total ${money(s.total)} | Paid ${money(s.paid)} | Due ${money(s.balance)}`
    ).join('\n') +
    `\n\nOUTSTANDING: ${money(customerBalance(id))}`;

  alert(txt);
}

function purchaseDetails(id) {
  const p = db.purchases.find(x => x.id === id);

  if (p) {
    alert(
      `PURCHASE ${p.invoice}\nDate: ${p.date}\nItems: ${p.items.map(i => i.name + ' × ' + i.qty).join(', ')}\nTotal: ${money(p.total)}\nPaid: ${money(p.paid)}\nBalance: ${money(p.balance)}`
    );
  }
}

// --------------------------------------------------
// SEARCH
// --------------------------------------------------

$('productSearch').oninput = e => {
  const q = e.target.value.toLowerCase();

  document.querySelectorAll('#productRows tr').forEach(r =>
    r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none'
  );
};

// --------------------------------------------------
// CASH REGISTER
// --------------------------------------------------

function renderCash() {
  const c = db.cash;

    const cashSales = db.sales
    .filter(s => {
      const saleDate = new Date(s.date);

      return (
        s.payment === 'Cash' &&
        !Number.isNaN(saleDate.getTime()) &&
        (c.openedAt
          ? saleDate >= new Date(c.openedAt)
          : saleDate.toDateString() === new Date().toDateString())
      );
    })
    .reduce((a, s) => a + Number(s.paid || 0), 0);

  const cashExpenses = db.expenses
    .filter(e =>
      e.status !== 'voided' &&
      e.method === 'Cash' &&
      (!c.openedAt || new Date(e.date) >= new Date(c.openedAt))
    )
    .reduce((a,e) => a + e.amount, 0);

  const inflow = c.movements
    .filter(m => m.type === 'Cash in')
    .reduce((a,m) => a + m.amount, 0);

  const outflow = c.movements
    .filter(m => m.type === 'Cash out')
    .reduce((a,m) => a + m.amount, 0);

  const expected = c.opening + cashSales + inflow - outflow - cashExpenses;

  $('cashStatus').textContent = c.open ? 'Open' : 'Closed';
  $('cashOpening').textContent = money(c.opening);
  $('cashExpected').textContent = money(expected);

  $('openCash').disabled = c.open;
  $('closeCash').disabled = !c.open;
  $('cashIn').disabled = !c.open;
  $('cashOut').disabled = !c.open;

  $('cashRows').innerHTML = c.movements
    .slice().reverse().map(m => `
      <tr>
        <td>${new Date(m.date).toLocaleString()}</td>
        <td>${esc(m.type)}</td>
        <td>${money(m.amount)}</td>
        <td>${esc(m.note)}</td>
      </tr>
    `).join('') || emptyRow(4,'No cash movements.');

  return expected;
}

$('openCash').onclick = () => {
  if (db.cash.open) return;

  openModal('Open cash register', [
    {name:'opening',label:'Opening float (KSh)',type:'number',min:0,step:'.01',value:0,required:true},
    {name:'note',label:'Notes'}
  ], d => {
    db.cash.open = true;
    db.cash.opening = Number(d.opening);
    db.cash.openedAt = new Date().toISOString();

    db.cash.movements.push({
      id:uid(),
      type:'Opening float',
      amount:db.cash.opening,
      note:d.note,
      date:new Date().toISOString()
    });

    save();
    toast('Cash register opened locally.');
  });
};

function cashMovement(type) {
  if (!db.cash.open) return toast('Open the register first.');

  openModal(type, [
    {name:'amount',label:'Amount (KSh)',type:'number',min:.01,step:'.01',required:true},
    {name:'note',label:'Reason / note',required:true}
  ], d => {
    const amount = Number(d.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a valid amount.');
      return false;
    }

    db.cash.movements.push({
      id:uid(),
      type,
      amount,
      note:d.note,
      date:new Date().toISOString()
    });

    save();
    toast(type + ' recorded locally.');
  });
}

$('cashIn').onclick = () => cashMovement('Cash in');
$('cashOut').onclick = () => cashMovement('Cash out');

$('closeCash').onclick = () => {
  if (!db.cash.open) return;

  const expected = renderCash();

  openModal('Close cash register', [
    {name:'actual',label:'Actual cash counted (KSh)',type:'number',min:0,step:'.01',value:expected,required:true},
    {name:'note',label:'Closing notes'}
  ], d => {
    const actual = Number(d.actual);

    if (!Number.isFinite(actual) || actual < 0) {
      toast('Enter a valid counted amount.');
      return false;
    }

    db.cash.movements.push({
      id:uid(),
      type:'Closing count',
      amount:actual,
      note:'Expected ' + money(expected) +
        '; difference ' + money(actual - expected) +
        '; ' + d.note,
      date:new Date().toISOString()
    });

    db.cash.open = false;

    db.cash.lastClosing = {
      actual,
      expected,
      difference:actual - expected,
      date:new Date().toISOString()
    };

    save();
    toast('Register closed locally.');
  });
};

// --------------------------------------------------
// EXPORT AND BACKUP
// --------------------------------------------------

function download(name,content,type) {
  const a = document.createElement('a');

  const url = URL.createObjectURL(
    new Blob([content],{type})
  );

  a.href = url;
  a.download = name;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url),1000);
}

$('exportCsv').onclick = () => {
  const rows = [
    ['Receipt','Date','Customer','Payment','Status','Subtotal','Discount','Total','Paid','Balance'],
    ...db.sales.map(s => [
      s.receipt,s.date,s.customerName,s.payment,s.status,
      s.subtotal,s.discount,s.total,s.paid,s.balance
    ])
  ];

  download(
    'ambassadors-sales.csv',
    '\ufeff' + rows.map(r =>
      r.map(v => '"' + String(v ?? '').replace(/"/g,'""') + '"').join(',')
    ).join('\n'),
    'text/csv'
  );

  toast('Sales CSV exported.');
};

$('exportBackup').onclick = () =>
  download(
    'ambassadors-auto-care-backup.json',
    JSON.stringify(db,null,2),
    'application/json'
  );

$('importBackup').onchange = async e => {
  const f = e.target.files[0];

  if (!f) return;

  try {
    const x = JSON.parse(await f.text());

    if (!x || !Array.isArray(x.products) ||
        !Array.isArray(x.sales) ||
        !Array.isArray(x.suppliers)) {
      throw Error('Invalid backup');
    }

    db = {...clone(seed),...x};

    save();
    toast('Backup imported.');
  } catch (err) {
    toast('Could not import this backup file.');
  }

  e.target.value = '';
};

// --------------------------------------------------
// LOCAL DATA RESET
// --------------------------------------------------

$('restoreSample').onclick = () => {
  if (!confirm('Restore sample products and clear transaction history?')) return;

  db = clone(seed);
  cart = [];

  save();
  toast('Sample data restored locally.');
};

$('clearAll').onclick = () => {
  if (!confirm('Permanently delete all local records from this browser? Export a backup first if needed.')) return;

  db = {
    ...clone(seed),
    products:[],
    suppliers:[],
    customers:[],
    sales:[],
    expenses:[],
    purchases:[],
    supplierPayments:[],
    creditPayments:[],
    cash:{
      open:false,
      opening:0,
      openedAt:null,
      movements:[]
    }
  };

  cart = [];

  save();
  toast('Local records cleared.');
};

// --------------------------------------------------
// SETTINGS
// --------------------------------------------------

function loadSettings() {
  const s = db.settings;

  $('settingsFields').innerHTML = [
    ['shopName','Shop name'],
    ['phone','Phone'],
    ['address','Address'],
    ['receiptFooter','Receipt footer']
  ].map(([k,l]) => `
    <label>
      ${l}
      <input class="field" data-setting="${k}" value="${esc(s[k] || '')}">
    </label>
  `).join('');
}

$('saveSettings').onclick = () => {
  document.querySelectorAll('[data-setting]').forEach(i =>
    db.settings[i.dataset.setting] = i.value
  );

  save();
  toast('Shop settings saved locally.');
};

// --------------------------------------------------
// THEME
// --------------------------------------------------

$('themeToggle').onclick = () => {
  document.documentElement.classList.toggle('dark');

  localStorage.setItem(
    'ambassadors_theme',
    document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  );

  $('themeToggle').textContent =
    document.documentElement.classList.contains('dark') ? '☀️' : '🌙';
};

if (localStorage.getItem('ambassadors_theme') === 'dark') {
  document.documentElement.classList.add('dark');
  $('themeToggle').textContent = '☀️';
}

// --------------------------------------------------
// CONNECTION STATUS
// --------------------------------------------------




async function updateConnectionStatus() {
  const indicator = $('connection');
  if (!indicator) return;

  const auth = getAuth();

  let pendingCount = 0;
  let failedCount = 0;

  if (auth) {
    try {
      const records = await getQueuedTransactions(auth.shopId);

      pendingCount = records.filter(record =>
        record.type === 'sale' &&
        ['pending', 'syncing'].includes(record.status)
      ).length;

      failedCount = records.filter(record =>
        record.type === 'sale' &&
        ['failed', 'blocked'].includes(record.status)
      ).length;

    } catch (error) {
      console.error('Could not read offline queue status:', error);
    }
  }

  const queueLabel =
    `${pendingCount} PENDING` +
    (failedCount ? ` · ${failedCount} NEEDS ATTENTION` : '');

  if (!navigator.onLine) {
    indicator.textContent = auth
      ? `● OFFLINE · ${queueLabel}`
      : '● OFFLINE · CLOUD UNAVAILABLE';
    return;
  }

  if (!auth) {
    indicator.textContent = '● ONLINE · SIGN IN REQUIRED';
    return;
  }

  indicator.textContent = `● CHECKING CLOUD · ${queueLabel}`;

  try {
    const response = await fetch(
      'https://ambassador-auto-care.onrender.com/api/health',
      { cache: 'no-store' }
    );

    const data = await response.json();

    const cloudStatus =
      response.ok && data.status === 'healthy'
        ? '● CLOUD CONNECTED'
        : '● CLOUD UNAVAILABLE';

    indicator.textContent = `${cloudStatus} · ${queueLabel}`;

  } catch {
    indicator.textContent = `● CLOUD UNAVAILABLE · ${queueLabel}`;
  }
}

window.addEventListener('online',updateConnectionStatus);
window.addEventListener('offline',updateConnectionStatus);

// --------------------------------------------------
// INITIALIZE
// --------------------------------------------------

loadSettings();
render();
updateConnectionStatus();

      
if (getAuth()) {
  startCloudSync();
}
    

