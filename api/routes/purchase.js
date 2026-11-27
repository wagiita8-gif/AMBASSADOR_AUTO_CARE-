'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

const router = express.Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --------------------------------------------------
// DATABASE INITIALIZATION
// Uses the EXISTING Neon schema.
// --------------------------------------------------

async function initializePurchaseTables(pool) {
  await pool.query(`
    ALTER TABLE purchases
      ADD COLUMN IF NOT EXISTS request_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_purchases_shop_request
      ON purchases(shop_id, request_id)
      WHERE request_id IS NOT NULL;

    ALTER TABLE supplier_payments
      ADD COLUMN IF NOT EXISTS request_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_supplier_payments_shop_request
      ON supplier_payments(shop_id, request_id)
      WHERE request_id IS NOT NULL;

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
         p.id,
         p.shop_id,
         p.supplier_id,
         p.invoice_number,
         p.subtotal,
         p.total,
         p.amount_paid AS paid,
         p.balance,
         p.status,
         p.notes,
         p.created_by,
         p.created_at,
         p.purchase_date,
         s.name AS supplier_name,
         COALESCE(
           json_agg(
             json_build_object(
               'productId', pi.product_id,
               'name', pi.product_name,
               'quantity', pi.quantity,
               'unitCost', pi.unit_cost,
               'total', pi.line_total
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

    res.status(500).json({
      error: 'Could not load purchases'
    });
  }
});

// --------------------------------------------------
// RECORD PURCHASE
// --------------------------------------------------

router.post('/purchases', async (req, res) => {
  const {
    requestId,
    supplierId,
    invoiceNumber = '',
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

  if (
    typeof requestId !== 'string' ||
    !UUID_PATTERN.test(requestId) ||
    typeof supplierId !== 'string' ||
    !UUID_PATTERN.test(supplierId) ||
    typeof productId !== 'string' ||
    !UUID_PATTERN.test(productId) ||
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
    typeof invoiceNumber !== 'string' ||
    typeof paymentMethod !== 'string' ||
    !paymentMethod.trim() ||
    typeof notes !== 'string' ||
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

    // Prevent concurrent duplicate submissions.
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1),
         hashtext($2)
       )`,
      [req.shopId, requestId]
    );

    const existing = await client.query(
      `SELECT id
       FROM purchases
       WHERE shop_id = $1
         AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (existing.rows.length) {
      await client.query('COMMIT');
      transactionStarted = false;

      return res.status(200).json({
        message: 'Purchase was already recorded',
        purchaseId: existing.rows[0].id,
        duplicate: true
      });
    }

    const supplier = await client.query(
      `SELECT id, name
       FROM suppliers
       WHERE id = $1
         AND shop_id = $2
       FOR UPDATE`,
      [supplierId, req.shopId]
    );

    if (!supplier.rows.length) {
      const error = new Error('Supplier not found');
      error.status = 404;
      throw error;
    }

    const product = await client.query(
      `SELECT id, name
       FROM products
       WHERE id = $1
         AND shop_id = $2
       FOR UPDATE`,
      [productId, req.shopId]
    );

    if (!product.rows.length) {
      const error = new Error('Product not found');
      error.status = 404;
      throw error;
    }

    const purchaseId = randomUUID();
    const balanceCents = totalCents - paidCents;

    const invoice = invoiceNumber.trim() ||
      `PUR-${purchaseId.slice(0, 8).toUpperCase()}`;

    // Actual schema:
    // subtotal, total, amount_paid, balance,
    // notes, created_by, purchase_date.
    const purchaseResult = await client.query(
      `INSERT INTO purchases (
         id,
         shop_id,
         supplier_id,
         invoice_number,
         subtotal,
         total,
         amount_paid,
         balance,
         notes,
         created_by,
         purchase_date,
         request_id
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       )
       RETURNING *`,
      [
        purchaseId,
        req.shopId,
        supplierId,
        invoice,
        totalCents / 100,
        totalCents / 100,
        paidCents / 100,
        balanceCents / 100,
        notes.trim() || null,
        req.user.userId,
        purchaseDate,
        requestId
      ]
    );

    // Actual purchase_items column is line_total,
    // NOT total.
    await client.query(
      `INSERT INTO purchase_items (
         id,
         purchase_id,
         product_id,
         product_name,
         quantity,
         unit_cost,
         line_total
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

    // Increase stock in the same transaction.
    await client.query(
      `UPDATE products
       SET quantity = quantity + $1,
           updated_at = NOW()
       WHERE id = $2
         AND shop_id = $3`,
      [qty, productId, req.shopId]
    );

    // Record the stock movement.
    await client.query(
      `INSERT INTO stock_movements (
         shop_id,
         product_id,
         user_id,
         movement_type,
         quantity,
         unit_cost,
         supplier_name,
         notes
       )
       VALUES (
         $1,$2,$3,'purchase',$4,$5,$6,$7
       )`,
      [
        req.shopId,
        productId,
        req.user.userId,
        qty,
        cost,
        supplier.rows[0].name,
        notes.trim() || invoice
      ]
    );

    // Record the initial supplier payment, if any.
    if (paidCents > 0) {
      const paymentId = randomUUID();

      await client.query(
        `INSERT INTO supplier_payments (
           id,
           shop_id,
           supplier_id,
           amount,
           payment_method,
           reference,
           paid_by,
           request_id
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          paymentId,
          req.shopId,
          supplierId,
          paidCents / 100,
          paymentMethod.trim().toLowerCase(),
          invoice,
          req.user.userId,
          randomUUID()
        ]
      );

      await client.query(
        `INSERT INTO supplier_payment_allocations (
           payment_id,
           purchase_id,
           amount
         )
         VALUES ($1,$2,$3)`,
        [
          paymentId,
          purchaseId,
          paidCents / 100
        ]
      );
    }

    await client.query('COMMIT');
    transactionStarted = false;

    res.status(201).json({
      message: 'Purchase recorded successfully',
      purchase: {
        ...purchaseResult.rows[0],
        paid: purchaseResult.rows[0].amount_paid
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error(
      'Purchase recording failed:',
      error.message
    );

    res.status(error.status || 500).json({
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
         sp.id,
         sp.shop_id,
         sp.supplier_id,
         sp.amount,
         sp.payment_method AS method,
         sp.reference,
         sp.paid_by,
         sp.created_at,
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
    console.error(
      'Supplier payment history error:',
      error.message
    );

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
    reference = ''
  } = req.body;

  const paymentCents = Math.round(Number(amount) * 100);

  if (
    typeof requestId !== 'string' ||
    !UUID_PATTERN.test(requestId) ||
    typeof supplierId !== 'string' ||
    !UUID_PATTERN.test(supplierId) ||
    !Number.isSafeInteger(paymentCents) ||
    paymentCents <= 0 ||
    Number(amount) * 100 !== paymentCents ||
    typeof method !== 'string' ||
    !method.trim() ||
    typeof reference !== 'string'
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

    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1),
         hashtext($2)
       )`,
      [req.shopId, requestId]
    );

    const duplicate = await client.query(
      `SELECT id, supplier_id, amount,
              payment_method, reference
       FROM supplier_payments
       WHERE shop_id = $1
         AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (duplicate.rows.length) {
      const old = duplicate.rows[0];

      const matches =
        old.supplier_id === supplierId &&
        Math.round(Number(old.amount) * 100) === paymentCents &&
        old.payment_method === method.trim().toLowerCase() &&
        (old.reference || '') === reference.trim();

      if (!matches) {
        const error = new Error(
          'This payment request ID was already used for different details.'
        );
        error.status = 409;
        throw error;
      }

      await client.query('COMMIT');
      transactionStarted = false;

      return res.status(200).json({
        message: 'Payment was already recorded',
        paymentId: old.id,
        duplicate: true
      });
    }

    const supplier = await client.query(
      `SELECT id
       FROM suppliers
       WHERE id = $1
         AND shop_id = $2
       FOR UPDATE`,
      [supplierId, req.shopId]
    );

    if (!supplier.rows.length) {
      const error = new Error('Supplier not found');
      error.status = 404;
      throw error;
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
      const error = new Error(
        'Payment exceeds supplier outstanding balance'
      );
      error.status = 400;
      throw error;
    }

    const paymentId = randomUUID();

    await client.query(
      `INSERT INTO supplier_payments (
         id,
         shop_id,
         supplier_id,
         amount,
         payment_method,
         reference,
         paid_by,
         request_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        paymentId,
        req.shopId,
        supplierId,
        paymentCents / 100,
        method.trim().toLowerCase(),
        reference.trim() || null,
        req.user.userId,
        requestId
      ]
    );

    let remaining = paymentCents;

    for (const invoice of invoices.rows) {
      if (remaining <= 0) break;

      const balance = Math.round(
        Number(invoice.balance) * 100
      );

      const allocated = Math.min(remaining, balance);
      const newBalance = balance - allocated;

      await client.query(
        `INSERT INTO supplier_payment_allocations (
           payment_id,
           purchase_id,
           amount
         )
         VALUES ($1,$2,$3)`,
        [
          paymentId,
          invoice.id,
          allocated / 100
        ]
      );

      await client.query(
        `UPDATE purchases
         SET amount_paid = amount_paid + $1,
             balance = $2
         WHERE id = $3
           AND shop_id = $4`,
        [
          allocated / 100,
          newBalance / 100,
          invoice.id,
          req.shopId
        ]
      );

      remaining -= allocated;
    }

    if (remaining !== 0) {
      throw new Error(
        'Payment allocation was incomplete. Payment rolled back.'
      );
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

    console.error(
      'Supplier payment failed:',
      error.message
    );

    res.status(error.status || 500).json({
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
