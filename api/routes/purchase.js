
'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

const router = express.Router();

async function initializePurchaseTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id UUID PRIMARY KEY,
      shop_id UUID NOT NULL REFERENCES shops(id),
      supplier_id UUID NOT NULL REFERENCES suppliers(id),
      user_id UUID NOT NULL REFERENCES users(id),
      request_id UUID NOT NULL,
      invoice_number TEXT NOT NULL,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total NUMERIC(12,2) NOT NULL CHECK (total > 0),
      paid NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance NUMERIC(12,2) NOT NULL,
      payment_method TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id UUID PRIMARY KEY,
      purchase_id UUID NOT NULL
        REFERENCES purchases(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
      unit_cost NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
      total NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id UUID PRIMARY KEY,
      shop_id UUID NOT NULL REFERENCES shops(id),
      supplier_id UUID NOT NULL REFERENCES suppliers(id),
      user_id UUID NOT NULL REFERENCES users(id),
      request_id UUID NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
      payment_id UUID NOT NULL
        REFERENCES supplier_payments(id) ON DELETE CASCADE,
      purchase_id UUID NOT NULL
        REFERENCES purchases(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      PRIMARY KEY(payment_id, purchase_id)
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_shop_date
      ON purchases(shop_id, purchase_date DESC);

    CREATE INDEX IF NOT EXISTS idx_purchases_supplier
      ON purchases(shop_id, supplier_id);

    CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
      ON purchase_items(purchase_id);

    CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier
      ON supplier_payments(shop_id, supplier_id);
  `);
}

// --------------------------------------------------
// GET PURCHASE HISTORY
// --------------------------------------------------

router.get('/purchases', async (req, res) => {
  try {
    const result = await req.app.locals.pool.query(
      `SELECT
         p.*,
         s.name AS supplier_name,
         COALESCE(
           json_agg(
             json_build_object(
               'productId', pi.product_id,
               'name', pi.product_name,
               'quantity', pi.quantity,
               'unitCost', pi.unit_cost,
               'total', pi.total
             )
           ) FILTER (WHERE pi.id IS NOT NULL),
           '[]'
         ) AS items
       FROM purchases p
       JOIN suppliers s
         ON s.id = p.supplier_id
        AND s.shop_id = p.shop_id
       LEFT JOIN purchase_items pi
         ON pi.purchase_id = p.id
       WHERE p.shop_id = $1
       GROUP BY p.id, s.name
       ORDER BY p.purchase_date DESC, p.created_at DESC`,
      [req.shopId]
    );

    res.json({ purchases: result.rows });
  } catch (error) {
    console.error('Purchase history error:', error.message);
    res.status(500).json({ error: 'Could not load purchases' });
  }
});

// --------------------------------------------------
// RECORD PURCHASE
// --------------------------------------------------

router.post('/purchases', async (req, res) => {
  const {
    requestId,
    supplierId,
    invoiceNumber,
    productId,
    quantity,
    unitCost,
    paid,
    paymentMethod,
    purchaseDate,
    notes = ''
  } = req.body;

  const qty = Number(quantity);
  const cost = Number(unitCost);
  const paidAmount = Number(paid);
  const totalCents = Math.round(qty * cost * 100);
  const paidCents = Math.round(paidAmount * 100);

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof requestId !== 'string' ||
    !uuidPattern.test(requestId) ||
    typeof supplierId !== 'string' ||
    !uuidPattern.test(supplierId) ||
    typeof productId !== 'string' ||
    !uuidPattern.test(productId) ||
    !Number.isFinite(qty) ||
    qty <= 0 ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    !Number.isFinite(paidAmount) ||
    paidAmount < 0 ||
    Math.round(qty * 1000) !== qty * 1000 ||
    Math.round(cost * 100) !== cost * 100 ||
    Math.round(paidAmount * 100) !== paidAmount * 100 ||
    totalCents <= 0 ||
    paidCents > totalCents ||
    typeof notes !== 'string' ||
    typeof invoiceNumber !== 'string' ||
    typeof paymentMethod !== 'string' ||
    !paymentMethod.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate || '')
  ) {
    return res.status(400).json({
      error: 'Invalid purchase details'
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await req.app.locals.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const existing = await client.query(
      `SELECT id
       FROM purchases
       WHERE shop_id = $1 AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (existing.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(200).json({
        message: 'Purchase was already recorded',
        purchaseId: existing.rows[0].id,
        duplicate: true
      });
    }

    const supplier = await client.query(
      `SELECT id FROM suppliers
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [supplierId, req.shopId]
    );

    if (!supplier.rows.length) {
      throw new Error('Supplier not found');
    }

    const product = await client.query(
      `SELECT id, name
       FROM products
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [productId, req.shopId]
    );

    if (!product.rows.length) {
      throw new Error('Product not found');
    }

    const purchaseId = randomUUID();
    const balanceCents = totalCents - paidCents;
    const invoice = invoiceNumber.trim() ||
      `PUR-${purchaseId.slice(0, 8).toUpperCase()}`;

    const purchaseResult = await client.query(
      `INSERT INTO purchases (
        id, shop_id, supplier_id, user_id,
        request_id, invoice_number, purchase_date,
        total, paid, balance, payment_method, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        purchaseId,
        req.shopId,
        supplierId,
        req.user.userId,
        requestId,
        invoice,
        purchaseDate,
        totalCents / 100,
        paidCents / 100,
        balanceCents / 100,
        paymentMethod.trim(),
        notes.trim() || null
      ]
    );

    await client.query(
      `INSERT INTO purchase_items (
        id, purchase_id, product_id,
        product_name, quantity, unit_cost, total
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        purchaseId,
        productId,
        product.rows[0].name,
        qty,
        cost,
        totalCents / 100
      ]
    );

    await client.query(
      `UPDATE products
       SET quantity = quantity + $1
       WHERE id = $2 AND shop_id = $3`,
      [qty, productId, req.shopId]
    );

    await client.query(
      `INSERT INTO stock_movements (
        shop_id, product_id, user_id,
        movement_type, quantity, unit_cost,
        supplier_name, notes
      )
      VALUES (
        $1, $2, $3, 'purchase', $4, $5,
        (SELECT name FROM suppliers WHERE id = $6),
        $7
      )`,
      [
        req.shopId,
        productId,
        req.user.userId,
        qty,
        cost,
        supplierId,
        notes.trim() || invoice
      ]
    );

    if (paidCents > 0) {
      const paymentId = randomUUID();

      await client.query(
        `INSERT INTO supplier_payments (
          id, shop_id, supplier_id, user_id,
          request_id, amount, method, reference, notes
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          paymentId,
          req.shopId,
          supplierId,
          req.user.userId,
          requestId,
          paidCents / 100,
          paymentMethod.trim(),
          invoice,
          notes.trim() || null
        ]
      );

      await client.query(
        `INSERT INTO supplier_payment_allocations (
          payment_id, purchase_id, amount
        )
        VALUES ($1,$2,$3)`,
        [paymentId, purchaseId, paidCents / 100]
      );
    }

    await client.query('COMMIT');
    transactionStarted = false;

    res.status(201).json({
      message: 'Purchase recorded successfully',
      purchase: purchaseResult.rows[0]
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Purchase recording failed:', error.message);

    res.status(
      error.message.includes('not found') ? 404 : 500
    ).json({
      error: error.message || 'Could not record purchase'
    });

  } finally {
    if (client) client.release();
  }
});

// --------------------------------------------------
// GET SUPPLIER PAYMENT HISTORY
// --------------------------------------------------

router.get('/supplier-payments', async (req, res) => {
  try {
    const result = await req.app.locals.pool.query(
      `SELECT
         sp.*,
         s.name AS supplier_name,
         COALESCE(
           json_agg(
             json_build_object(
               'purchaseId', a.purchase_id,
               'amount', a.amount
             )
           ) FILTER (WHERE a.purchase_id IS NOT NULL),
           '[]'
         ) AS allocations
       FROM supplier_payments sp
       JOIN suppliers s
         ON s.id = sp.supplier_id
        AND s.shop_id = sp.shop_id
       LEFT JOIN supplier_payment_allocations a
         ON a.payment_id = sp.id
       WHERE sp.shop_id = $1
       GROUP BY sp.id, s.name
       ORDER BY sp.created_at DESC`,
      [req.shopId]
    );

    res.json({ payments: result.rows });
  } catch (error) {
    console.error('Supplier payment history error:', error.message);
    res.status(500).json({
      error: 'Could not load supplier payments'
    });
  }
});

// --------------------------------------------------
// RECORD SUPPLIER PAYMENT
// --------------------------------------------------

router.post('/supplier-payments', async (req, res) => {
  const {
    requestId,
    supplierId,
    amount,
    method,
    reference = '',
    notes = ''
  } = req.body;

  const paymentCents = Math.round(Number(amount) * 100);

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof requestId !== 'string' ||
    !uuidPattern.test(requestId) ||
    typeof supplierId !== 'string' ||
    !uuidPattern.test(supplierId) ||
    !Number.isSafeInteger(paymentCents) ||
    paymentCents <= 0 ||
    Number(amount) * 100 !== paymentCents ||
    typeof method !== 'string' ||
    !method.trim() ||
    typeof reference !== 'string' ||
    typeof notes !== 'string'
  ) {
    return res.status(400).json({
      error: 'Invalid supplier payment details'
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await req.app.locals.pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const duplicate = await client.query(
      `SELECT id FROM supplier_payments
       WHERE shop_id = $1 AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(200).json({
        message: 'Payment was already recorded',
        paymentId: duplicate.rows[0].id,
        duplicate: true
      });
    }

    const supplier = await client.query(
      `SELECT id FROM suppliers
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [supplierId, req.shopId]
    );

    if (!supplier.rows.length) {
      throw new Error('Supplier not found');
    }

    const invoices = await client.query(
      `SELECT id, balance
       FROM purchases
       WHERE shop_id = $1
         AND supplier_id = $2
         AND balance > 0
       ORDER BY purchase_date ASC, created_at ASC
       FOR UPDATE`,
      [req.shopId, supplierId]
    );

    const outstandingCents = invoices.rows.reduce(
      (sum, invoice) =>
        sum + Math.round(Number(invoice.balance) * 100),
      0
    );

    if (paymentCents > outstandingCents) {
      throw new Error('Payment exceeds supplier outstanding balance');
    }

    const paymentId = randomUUID();

    await client.query(
      `INSERT INTO supplier_payments (
        id, shop_id, supplier_id, user_id,
        request_id, amount, method, reference, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        paymentId,
        req.shopId,
        supplierId,
        req.user.userId,
        requestId,
        paymentCents / 100,
        method.trim(),
        reference.trim() || null,
        notes.trim() || null
      ]
    );

    let remaining = paymentCents;

    for (const invoice of invoices.rows) {
      if (remaining <= 0) break;

      const balance = Math.round(Number(invoice.balance) * 100);
      const allocated = Math.min(remaining, balance);
      const newBalance = balance - allocated;

      await client.query(
        `INSERT INTO supplier_payment_allocations (
          payment_id, purchase_id, amount
        )
        VALUES ($1,$2,$3)`,
        [paymentId, invoice.id, allocated / 100]
      );

      await client.query(
        `UPDATE purchases
         SET paid = paid + $1,
             balance = $2
         WHERE id = $3 AND shop_id = $4`,
        [
          allocated / 100,
          newBalance / 100,
          invoice.id,
          req.shopId
        ]
      );

      remaining -= allocated;
    }

    await client.query('COMMIT');
    transactionStarted = false;

    res.status(201).json({
      message: 'Supplier payment recorded successfully',
      paymentId
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Supplier payment failed:', error.message);

    res.status(
      error.message.includes('not found') ||
      error.message.includes('exceeds supplier')
        ? 400 : 500
    ).json({
      error: error.message || 'Could not record supplier payment'
    });

  } finally {
    if (client) client.release();
  }
});

module.exports = {
  router,
  initializePurchaseTables
};
