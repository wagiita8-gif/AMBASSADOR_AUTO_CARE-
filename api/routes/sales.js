const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();



async function initializeSalesTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id UUID PRIMARY KEY,
      shop_id UUID NOT NULL REFERENCES shops(id),
      user_id UUID NOT NULL REFERENCES users(id),
      receipt TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      customer_id UUID REFERENCES customers(id),
      customer_name TEXT NOT NULL DEFAULT 'Walk-in',
      payment_method TEXT NOT NULL,
      subtotal NUMERIC(12,2) NOT NULL,
      discount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL,
      paid NUMERIC(12,2) NOT NULL,
      balance NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, receipt)
    );

    ALTER TABLE sales
      ADD COLUMN IF NOT EXISTS invoice_number TEXT;

       ALTER TABLE sales
      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
          ALTER TABLE sales
      ADD COLUMN IF NOT EXISTS request_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_sales_shop_request_id
      ON sales(shop_id, request_id)
      WHERE request_id IS NOT NULL;
    ALTER TABLE sales
      ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

    UPDATE sales
    SET invoice_number = receipt
    WHERE invoice_number IS NULL;

    ALTER TABLE sales
      ALTER COLUMN invoice_number SET NOT NULL;

        CREATE TABLE IF NOT EXISTS sale_items (
      id UUID PRIMARY KEY,
      sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      line_total NUMERIC(12,2) NOT NULL
    );

    ALTER TABLE sale_items
      ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2);

    UPDATE sale_items
    SET line_total = ROUND(quantity * unit_price, 2)
    WHERE line_total IS NULL;

    ALTER TABLE sale_items
      ALTER COLUMN line_total SET NOT NULL;

    CREATE TABLE IF NOT EXISTS customer_payments (
      id UUID PRIMARY KEY,
      shop_id UUID NOT NULL REFERENCES shops(id),
      customer_id UUID NOT NULL REFERENCES customers(id),
      user_id UUID NOT NULL REFERENCES users(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_customer_payments_shop_request_id
  ON customer_payments(shop_id, request_id)
  WHERE request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS customer_payment_allocations (
      payment_id UUID NOT NULL REFERENCES customer_payments(id)
        ON DELETE CASCADE,
      sale_id UUID NOT NULL REFERENCES sales(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      PRIMARY KEY (payment_id, sale_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sales_shop_date
      ON sales(shop_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sales_customer
      ON sales(shop_id, customer_id);

    CREATE INDEX IF NOT EXISTS idx_sale_items_sale
      ON sale_items(sale_id);

    CREATE INDEX IF NOT EXISTS idx_customer_payments_customer
      ON customer_payments(shop_id, customer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_customer_payment_allocations_sale
      ON customer_payment_allocations(sale_id);
  `);
}

router.get("/sales", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const result = await pool.query(
      `SELECT
         s.*,
         COALESCE(
           json_agg(
             json_build_object(
               'id', si.product_id,
               'name', si.product_name,
               'sku', si.sku,
               'qty', si.quantity,
               'price', si.unit_price
             )
           ) FILTER (WHERE si.id IS NOT NULL),
           '[]'
         ) AS items
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.shop_id = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [req.shopId]
    );

    res.json({ sales: result.rows });
  } catch (error) {
    console.error("Sales retrieval failed:", error.message);
    res.status(500).json({ error: "Could not load sales" });
  }
});
// --------------------------------------------------
// CUSTOMER PAYMENT HISTORY
// --------------------------------------------------

router.get("/customer-payments", async (req, res) => {
  const pool = req.app.locals.pool;

  try {
    const result = await pool.query(
      `SELECT
         cp.*,
         c.name AS customer_name,
         COALESCE(
           json_agg(
             json_build_object(
               'saleId', a.sale_id,
               'amount', a.amount
             )
           ) FILTER (WHERE a.sale_id IS NOT NULL),
           '[]'
         ) AS allocations
       FROM customer_payments cp
       JOIN customers c
         ON c.id = cp.customer_id
        AND c.shop_id = cp.shop_id
       LEFT JOIN customer_payment_allocations a
         ON a.payment_id = cp.id
       WHERE cp.shop_id = $1
       GROUP BY cp.id, c.name
       ORDER BY cp.created_at DESC`,
      [req.shopId]
    );

    res.json({ payments: result.rows });
  } catch (error) {
    console.error("Customer payment retrieval failed:", error.message);
    res.status(500).json({
      error: "Could not load customer payments"
    });
  }
});

// --------------------------------------------------
// RECORD CUSTOMER PAYMENT
// --------------------------------------------------

router.post("/customer-payments", async (req, res) => {
  const pool = req.app.locals.pool;

  const {
    customerId,
    amount,
    method,
    reference = "",
    notes = ""
  } = req.body;

  const paymentAmount = Number(amount);

  if (
    typeof customerId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId) ||
    !Number.isFinite(paymentAmount) ||
    paymentAmount <= 0 ||
    Math.round(paymentAmount * 100) !== paymentAmount * 100 ||
    typeof method !== "string" ||
    !method.trim() ||
    typeof reference !== "string" ||
    typeof notes !== "string"
  ) {
    return res.status(400).json({
      error: "Invalid customer payment details"
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const customerResult = await client.query(
      `SELECT id, name
       FROM customers
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [customerId, req.shopId]
    );

    if (!customerResult.rows.length) {
      throw new Error("Customer not found.");
    }

    const invoiceResult = await client.query(
      `SELECT id, receipt, total, paid, balance
       FROM sales
       WHERE shop_id = $1
         AND customer_id = $2
         AND balance > 0
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
      [req.shopId, customerId]
    );

    const invoices = invoiceResult.rows;

    const outstandingCents = invoices.reduce(
      (sum, invoice) =>
        sum + Math.round(Number(invoice.balance) * 100),
      0
    );

    const paymentCents = Math.round(paymentAmount * 100);

    if (paymentCents > outstandingCents) {
      throw new Error(
        `Payment exceeds outstanding balance of ${(outstandingCents / 100).toFixed(2)}.`
      );
    }

    if (paymentCents === 0) {
      throw new Error("Payment amount must be greater than zero.");
    }

    const paymentId = randomUUID();

    await client.query(
      `INSERT INTO customer_payments (
        id, shop_id, customer_id, user_id,
        amount, method, reference, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        paymentId,
        req.shopId,
        customerId,
        req.user.userId,
        paymentCents / 100,
        method.trim(),
        reference.trim() || null,
        notes.trim() || null
      ]
    );

    let remainingCents = paymentCents;
    const allocations = [];

    for (const invoice of invoices) {
      if (remainingCents <= 0) break;

      const balanceCents = Math.round(
        Number(invoice.balance) * 100
      );

      const allocatedCents = Math.min(
        remainingCents,
        balanceCents
      );

      const newPaidCents =
        Math.round(Number(invoice.paid) * 100) +
        allocatedCents;

      const newBalanceCents =
        balanceCents - allocatedCents;

      const newStatus =
        newBalanceCents === 0 ? "Paid" : "Part paid";

      await client.query(
        `INSERT INTO customer_payment_allocations (
          payment_id, sale_id, amount
        )
        VALUES ($1,$2,$3)`,
        [
          paymentId,
          invoice.id,
          allocatedCents / 100
        ]
      );

      await client.query(
        `UPDATE sales
         SET paid = $1,
             balance = $2,
             status = $3
         WHERE id = $4
           AND shop_id = $5
           AND customer_id = $6`,
        [
          newPaidCents / 100,
          newBalanceCents / 100,
          newStatus,
          invoice.id,
          req.shopId,
          customerId
        ]
      );

      allocations.push({
        receipt: invoice.receipt,
        amount: allocatedCents / 100,
        balance: newBalanceCents / 100
      });

      remainingCents -= allocatedCents;
    }

    await client.query("COMMIT");
    transactionStarted = false;

    res.status(201).json({
      message: "Customer payment recorded successfully",
      payment: {
        id: paymentId,
        customerId,
        amount: paymentCents / 100,
        method: method.trim(),
        allocations
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Customer payment failed:", error.message);

    res.status(
      error.message.includes("not found") ||
      error.message.includes("exceeds outstanding") ||
      error.message.includes("greater than zero")
        ? 400 : 500
    ).json({
      error: error.message || "Could not record customer payment"
    });

  } finally {
    if (client) client.release();
  }
});
router.post("/sales", async (req, res) => {
  const pool = req.app.locals.pool;
  const {
    requestId,
    receipt,
    customerId = null,
    customerName,
    paymentMethod,
    discount = 0,
    paid,
    items
  } = req.body;
    if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
  ) {
    return res.status(400).json({
      error: "A valid sale request ID is required"
    });
  }
    if (
    typeof receipt !== "string" ||
    !receipt.trim() ||
    typeof paymentMethod !== "string" ||
    !paymentMethod.trim() ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !Number.isFinite(Number(discount)) ||
    Number(discount) < 0 ||
    !Number.isFinite(Number(paid)) ||
    Number(paid) < 0
  ) {
    return res.status(400).json({ error: "Invalid sale details" });
  }

  if (
    customerId !== null &&
    (typeof customerId !== "string" || !customerId.trim())
  ) {
    return res.status(400).json({
      error: "Invalid customer ID"
    });
  }

  const quantities = new Map();

  for (const item of items) {
    if (
      typeof item.productId !== "string" ||
      !Number.isFinite(Number(item.qty)) ||
      Number(item.qty) <= 0
    ) {
      return res.status(400).json({ error: "Invalid sale item" });
    }

    quantities.set(
      item.productId,
      (quantities.get(item.productId) || 0) + Number(item.qty)
    );
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

        const existingSale = await client.query(
      `SELECT id, receipt, subtotal, discount, total,
              paid, balance, status
       FROM sales
       WHERE shop_id = $1 AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (existingSale.rows.length) {
      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        message: "Sale was already saved",
        sale: existingSale.rows[0],
        alreadyProcessed: true
      });
    }
        let verifiedCustomer = null;

    if (customerId) {
      const customerResult = await client.query(
        `SELECT id, name
         FROM customers
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [customerId, req.shopId]
      );

      if (!customerResult.rows.length) {
        throw new Error("Selected customer was not found.");
      }

      verifiedCustomer = customerResult.rows[0];
    }
    const saleItems = [];
    let subtotal = 0;

    for (const [productId, quantity] of [...quantities.entries()].sort()) {
      const result = await client.query(
        `SELECT id, name, sku, selling_price, quantity
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, req.shopId]
      );

      if (!result.rows.length) {
        throw new Error("A product in this sale was not found.");
      }

      const product = result.rows[0];

      if (Number(product.quantity) < quantity) {
        throw new Error(
          `Insufficient stock for ${product.name}. Available: ${product.quantity}`
        );
      }

      const price = Number(product.selling_price);
      subtotal += price * quantity;

      saleItems.push({
        productId,
        product,
        quantity,
        price
      });
    }

    subtotal = Number(subtotal.toFixed(2));

    const discountAmount = Number(discount);

    if (discountAmount > subtotal) {
      throw new Error("Discount cannot exceed subtotal.");
    }

    const total = Number((subtotal - discountAmount).toFixed(2));
    const paidAmount = Number(Number(paid).toFixed(2));

    if (paidAmount > total) {
      throw new Error("Payment cannot exceed the sale total.");
    }

    const balance = Number((total - paidAmount).toFixed(2));

        if (balance > 0 && !verifiedCustomer) {
      throw new Error(
        "Credit sales must be linked to a registered customer."
      );
    }
    const saleId = randomUUID();
    
    const status =
      balance === 0 ? "completed" :
      paidAmount === 0 ? "credit" : "partial";
         await client.query(
      `INSERT INTO sales (
        id, shop_id, user_id, created_by, request_id,
        receipt, invoice_number, customer_id, customer_name,
        payment_method, subtotal, discount, total, paid,
        balance, status
      )
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        saleId,
        req.shopId,
        req.user.userId,
        requestId,
        receipt.trim(),
        receipt.trim(),
        verifiedCustomer ? verifiedCustomer.id : null,
        verifiedCustomer ? verifiedCustomer.name :
          (typeof customerName === "string" && customerName.trim()
            ? customerName.trim()
            : "Walk-in"),
        paymentMethod.trim(),
        subtotal,
        discountAmount,
        total,
        paidAmount,
        balance,
        status
      ]
    );

    for (const item of saleItems) {
      await client.query(
        `UPDATE products
         SET quantity = quantity - $1
         WHERE id = $2 AND shop_id = $3`,
        [item.quantity, item.productId, req.shopId]
      );

      await client.query(
        `INSERT INTO stock_movements (
          shop_id, product_id, user_id,
          movement_type, quantity, unit_price, notes
        )
        VALUES ($1,$2,$3,'sale',$4,$5,$6)`,
        [
          req.shopId,
          item.productId,
          req.user.userId,
          item.quantity,
          item.price,
          `Receipt ${receipt.trim()}`
        ]
      );

          await client.query(
        `INSERT INTO sale_items (
          id, sale_id, product_id, product_name,
          sku, quantity, unit_price, line_total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          saleId,
          item.productId,
          item.product.name,
          item.product.sku,
          item.quantity,
          item.price,
          Number((item.quantity * item.price).toFixed(2))
        ]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    res.status(201).json({
      message: "Sale saved to cloud successfully",
      sale: {
        id: saleId,
        receipt,
        subtotal,
        discount: discountAmount,
        total,
        paid: paidAmount,
        balance,
        status
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

        res.status(
      error.message.includes("not found") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("Discount") ||
      error.message.includes("Payment") ||
      error.message.includes("Credit sales")
        ? 400 : 500
    ).json({ error: error.message || "Could not record sale" });

  } finally {
    if (client) client.release();
  }
});

module.exports = { router, initializeSalesTables };
