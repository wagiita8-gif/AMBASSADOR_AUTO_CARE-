
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

let db = load();
let cart = [];

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

async function loadCloudProducts() {
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
      throw new Error('Invalid products response from server.');
    }

    const localProducts = db.products;

    db.products = data.products.map(product => {
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

    save();
    toast('Cloud products loaded.');
    return true;

  } catch (error) {
    console.error('Cloud product loading failed:', error);
    toast('Could not load cloud products.');
    return false;
  }
}

// --------------------------------------------------
// LOAD CLOUD SALES
// --------------------------------------------------

async function loadCloudSales() {
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
      throw new Error('Invalid sales response from server.');
    }

    // Preserve sales previously saved only on this device.
    const localOnlySales = db.sales
      .filter(s =>
        s.localOnly === true ||
        String(s.id || '').startsWith('x')
      )
      .map(s => ({
        ...s,
        localOnly:true
      }));

    const cloudSales = data.sales.map(s => ({
      id:s.id,
      receipt:s.receipt,
      date:s.created_at,
      customerId:null,
      customerName:s.customer_name || 'Walk-in',
      payment:s.payment_method,
      subtotal:Number(s.subtotal),
      discount:Number(s.discount),
      total:Number(s.total),
      paid:Number(s.paid),
      balance:Number(s.balance),
      status:s.status,
      localOnly:false,
      items:(s.items || []).map(i => ({
        id:i.id,
        name:i.name,
        sku:i.sku,
        qty:Number(i.qty),
        price:Number(i.price),
        cost:0
      }))
    }));

    db.sales = [...cloudSales, ...localOnlySales];

    save();
    return true;

  } catch (error) {
    console.error('Cloud sales loading failed:', error);
    toast('Could not load cloud sales.');
    return false;
  }
}

// Refresh cloud data when authentication succeeds.

document.addEventListener('pos:authenticated', async () => {
  updateConnectionStatus();

  await Promise.all([
    loadCloudProducts(),
    loadCloudSales(),
    loadCloudParties()
  ]);
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


function openModal(title, fields, onSave) {
  $('modalTitle').textContent = title;

  $('modalFields').innerHTML = fields.map(f => {
    if (f.type === 'textarea') {
      return `
        <label>${f.label}</label>
        <textarea
          name="${f.name}"
          placeholder="${f.placeholder || ''}"
          ${f.required ? 'required' : ''}
        >${f.value || ''}</textarea>
      `;
    }

    return `
      <label>${f.label}</label>
      <input
        type="${f.type || 'text'}"
        name="${f.name}"
        placeholder="${f.placeholder || ''}"
        value="${f.value || ''}"
        ${f.required ? 'required' : ''}
      >
    `;
  }).join('');

  $('modal').classList.add('open');

  $('modalForm').onsubmit = async e => {
    e.preventDefault();

    const submit = $('modalForm').querySelector('[type="submit"]');

    if (submit) submit.disabled = true;

    try {
      const d = Object.fromEntries(new FormData(e.target));
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

function productForm(id) {
  const p = db.products.find(x => x.id === id) || {};

  openModal(id ? 'Edit product' : 'Add product', [
    {name:'name',label:'Product name',value:p.name,required:true},
    {name:'sku',label:'SKU (leave blank to generate)',value:p.sku},
    {name:'barcode',label:'Barcode (optional)',value:p.barcode},
    {name:'category',label:'Category',value:p.category || 'Other',required:true},
    {name:'cost',label:'Buying price (KSh)',type:'number',min:0,step:'.01',value:p.cost ?? 0,required:true},
    {name:'price',label:'Selling price (KSh)',type:'number',min:0,step:'.01',value:p.price ?? 0,required:true},
    {name:'stock',label:id ? 'Current stock' : 'Opening stock',type:'number',min:0,step:'.001',value:p.stock ?? 0,required:true},
    {name:'reorder',label:'Reorder level',type:'number',min:0,step:'.001',value:p.reorder ?? 5,required:true}
  ], d => {
    const name = d.name.trim();
    const sku = d.sku.trim() || makeSku(name);
    const vals = [+d.cost,+d.price,+d.stock,+d.reorder];

    if (!name || vals.some(v => !Number.isFinite(v) || v < 0)) {
      toast('Enter valid product details and non-negative amounts.');
      return false;
    }

    if (db.products.some(x =>
      (x.sku || '').toLowerCase() === sku.toLowerCase() && x.id !== id
    )) {
      toast('SKU already exists.');
      return false;
    }

    if (d.barcode && db.products.some(x =>
      x.barcode === d.barcode && x.id !== id
    )) {
      toast('Barcode already exists.');
      return false;
    }

    const obj = {
      ...p,
      id:p.id || uid(),
      name,
      sku,
      barcode:d.barcode.trim(),
      category:d.category.trim(),
      cost:vals[0],
      price:vals[1],
      stock:vals[2],
      reorder:vals[3],
      supplierLinks:p.supplierLinks || []
    };

    const i = db.products.findIndex(x => x.id === obj.id);

    i < 0 ? db.products.push(obj) : db.products[i] = obj;

    save();
    toast('Product saved locally.');
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

function deleteProduct(id) {
  if (!confirm('Remove this product from the local catalogue? Sale history remains.')) return;

  db.products = db.products.filter(p => p.id !== id);
  save();
  toast('Product removed locally.');
}

function adjustStock(id) {
  const p = db.products.find(x => x.id === id);
  if (!p) return;

  openModal('Physical stock count — ' + p.name, [
    {name:'counted',label:'Actual counted quantity',type:'number',min:0,step:'.001',value:p.stock,required:true},
    {name:'reason',label:'Reason',type:'select',options:['Physical count','Damaged','Expired','Missing','Found','Correction']},
    {name:'notes',label:'Notes',type:'textarea',wide:true}
  ], d => {
    const n = Number(d.counted);

    if (!Number.isFinite(n) || n < 0) {
      toast('Enter a valid count.');
      return false;
    }

    const before = p.stock;
    p.stock = n;

    (db.adjustments || (db.adjustments = [])).push({
      id:uid(),
      productId:id,
      before,
      after:n,
      difference:n-before,
      reason:d.reason,
      notes:d.notes,
      date:new Date().toISOString()
    });

    save();
    toast('Stock count saved locally.');
  });
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


async function loadCloudParties() {
  if (!getAuth()) return false;

  try {
    const [customerData, supplierData] = await Promise.all([
      cloudRequest('customers'),
      cloudRequest('suppliers')
    ]);

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
    toast('Could not load shared customers and suppliers.');
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

  if (!s || due <= 0) return toast('No outstanding supplier balance.');

  openModal('Pay supplier — ' + s.name, [
    {name:'amount',label:'Payment amount (KSh)',type:'number',min:.01,step:'.01',required:true},
    {name:'method',label:'Payment method',type:'select',options:['Cash','M-Pesa','Bank','Card','Other']},
    {name:'reference',label:'Reference'},
    {name:'notes',label:'Notes'}
  ], d => {
    const amount = Number(d.amount);

    if (!Number.isFinite(amount) || amount <= 0 || amount > due) {
      toast('Payment must not exceed outstanding balance.');
      return false;
    }

    let left = amount;

    db.purchases
      .filter(p => p.supplierId === id && p.balance > 0)
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .forEach(p => {
        if (left <= 0) return;

        const n = Math.min(left,p.balance);

        p.balance = +(p.balance - n).toFixed(2);
        p.paid = +(p.paid + n).toFixed(2);

        left = +(left - n).toFixed(2);
      });

    db.supplierPayments.push({
      id:uid(),
      supplierId:id,
      amount,
      method:d.method,
      reference:d.reference,
      date:new Date().toISOString(),
      notes:d.notes
    });

    save();
    toast('Supplier payment recorded.');
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

  const supplierOpts = db.suppliers.map(s => ({
    value:s.id,
    label:s.name
  }));

  const productOpts = db.products.map(p => ({
    value:p.id,
    label:p.name + ' (' + p.sku + ')'
  }));

  openModal('Record supplier purchase', [
    {name:'supplierId',label:'Supplier',type:'select',options:supplierOpts,required:true},
    {name:'invoice',label:'Supplier invoice number'},
    {name:'productId',label:'Product received',type:'select',options:productOpts,required:true},
    {name:'qty',label:'Quantity received',type:'number',min:.001,step:'.001',required:true},
    {name:'unitCost',label:'Buying price per unit',type:'number',min:0,step:'.01',required:true},
    {name:'paidNow',label:'Amount paid now',type:'number',min:0,step:'.01',value:0,required:true},
    {name:'method',label:'Payment method',type:'select',options:['Cash','M-Pesa','Bank','Card','Other']},
    {name:'date',label:'Purchase date',type:'date',value:new Date().toISOString().slice(0,10)}
  ], d => {
    const p = db.products.find(x => x.id === d.productId);
    const qty = Number(d.qty);
    const cost = Number(d.unitCost);
    const total = qty * cost;
    const paid = Number(d.paidNow);

    if (!p || qty <= 0 || cost < 0 || paid < 0 || paid > total ||
        ![qty,cost,paid].every(Number.isFinite)) {
      toast('Check quantity, cost and payment values.');
      return false;
    }

    p.stock = +(p.stock + qty).toFixed(3);
    p.cost = cost;

    const purchase = {
      id:uid(),
      supplierId:d.supplierId,
      invoice:d.invoice || 'PUR-' + Date.now(),
      date:d.date || new Date().toISOString().slice(0,10),
      items:[{productId:p.id,name:p.name,qty,unitCost:cost}],
      total:+total.toFixed(2),
      paid:+paid.toFixed(2),
      balance:+(total-paid).toFixed(2),
      method:d.method
    };

    db.purchases.push(purchase);

    const s = db.suppliers.find(x => x.id === d.supplierId);

    if (s) {
      p.supplierLinks = p.supplierLinks || [];

      const link = p.supplierLinks.find(l => l.supplierId === s.id);

      if (link) {
        link.price = cost;
      } else {
        p.supplierLinks.push({
          supplierId:s.id,
          price:cost,
          status:p.supplierLinks.some(l => l.status === 'preferred')
            ? 'alternative'
            : 'preferred'
        });
      }
    }

    if (paid > 0) {
      db.supplierPayments.push({
        id:uid(),
        supplierId:d.supplierId,
        amount:paid,
        method:d.method,
        reference:d.invoice,
        date:new Date().toISOString(),
        purchaseId:purchase.id
      });
    }

    save();
    toast('Purchase recorded locally.');
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

  if (!navigator.onLine) {
    return toast('Internet connection required for cloud checkout.');
  }

  const subtotal = cart.reduce((sum,item) => {
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

  if (!Number.isFinite(paid) || paid < 0 || paid > total) {
    return toast('Enter a valid payment amount.');
  }

  // Shared credit sales are not implemented on the backend yet.
  if (paid < total) {
    return toast('Cloud credit sales are not enabled yet. Receive full payment to continue.');
  }

  for (const item of cart) {
    const product = db.products.find(p => p.id === item.id);

    if (!product || product.stock < item.qty) {
      return toast('Stock changed; review your cart.');
    }
  }

  const receipt =
    'AA-' +
    Date.now().toString() +
    '-' +
    Math.random().toString(36).slice(2,6).toUpperCase();

  const payload = {
    receipt,
    customerName:customer?.name || 'Walk-in',
    paymentMethod:$('paymentMethod').value,
    discount,
    paid,
    items:cart.map(item => ({
      productId:item.id,
      qty:item.qty
    }))
  };

  const button = $('completeSale');
  button.disabled = true;

  try {
    const response = await fetch(
      `${API_BASE}/api/shops/${auth.shopId}/sales`,
      {
        method:'POST',
        headers:{
          Authorization:`Bearer ${auth.token}`,
          'Content-Type':'application/json',
          Accept:'application/json'
        },
        body:JSON.stringify(payload)
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Sale could not be saved.');
    }

    if (!data.sale?.id) {
      throw new Error('The server response did not include a sale ID.');
    }

    // The server has saved the sale and deducted stock.
    cart = [];

    $('discount').value = 0;
    $('amountPaid').value = '';
    $('saleCustomer').value = '';

    await loadCloudProducts();
    await loadCloudSales();

    toast('Sale saved to the cloud!');

    viewReceipt(data.sale.id);

  } catch (error) {
    console.error('Cloud checkout failed:', error);
    toast(error.message || 'Sale failed. Please try again.');
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

// --------------------------------------------------
// MAIN RENDER
// --------------------------------------------------

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
    ? db.sales.slice(-4).reverse().map(s => `
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

  $('saleCustomer').innerHTML =
    '<option value="">Walk-in customer</option>' +
    db.customers.map(c =>
      `<option value="${c.id}">${esc(c.name)} — ${esc(c.phone)}</option>`
    ).join('');

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
    .filter(s =>
      new Date(s.date).toDateString() ===
      (c.openedAt
        ? new Date(c.openedAt).toDateString()
        : new Date().toDateString())
    )
    .reduce((a,s) => a + (s.payment === 'Cash' ? s.paid : 0), 0);

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

function updateConnectionStatus() {
  const indicator = $('connection');

  if (!indicator) return;

  if (!navigator.onLine) {
    indicator.textContent = '● OFFLINE · CLOUD CHECKOUT UNAVAILABLE';
    return;
  }

  indicator.textContent = getAuth()
    ? '● AUTHENTICATED · CLOUD CONNECTED'
    : '● ONLINE · SIGN IN REQUIRED';
}

window.addEventListener('online',updateConnectionStatus);
window.addEventListener('offline',updateConnectionStatus);

// --------------------------------------------------
// INITIALIZE
// --------------------------------------------------

loadSettings();
render();
updateConnectionStatus();

      

    

