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
ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2)
  NOT NULL DEFAULT 0;
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
CREATE TABLE IF NOT EXISTS sale_edit_audit (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id),
  sale_id UUID NOT NULL REFERENCES sales(id),
  edited_by UUID NOT NULL REFERENCES users(id),
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  before_data JSONB NOT NULL,
  after_data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sale_edit_audit_sale
  ON sale_edit_audit(shop_id, sale_id, edited_at DESC);
      CREATE TABLE IF NOT EXISTS sale_returns (
      id UUID PRIMARY KEY,
      shop_id UUID NOT NULL REFERENCES shops(id),
      sale_id UUID NOT NULL REFERENCES sales(id),
      receipt TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES users(id),
      request_id UUID NOT NULL,
      reason TEXT NOT NULL,
      refund_method TEXT NOT NULL,
      refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      credit_reduction NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS sale_return_items (
      id UUID PRIMARY KEY,
      return_id UUID NOT NULL REFERENCES sale_returns(id),
      sale_item_id UUID NOT NULL REFERENCES sale_items(id),
      product_id UUID NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
      item_condition TEXT NOT NULL,
      unit_refund NUMERIC(12,2) NOT NULL,
      line_total NUMERIC(12,2) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sale_returns_sale
      ON sale_returns(shop_id, sale_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sale_return_items_return
      ON sale_return_items(return_id);
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
router.post("/sales/:saleId/returns", async (req, res) => {
  if (!["owner", "manager"].includes(req.shopRole)) {
    return res.status(403).json({
      error: "Only the owner or manager can process returns."
    });
  }

  const pool = req.app.locals.pool;
  const { saleId } = req.params;
  const {
    requestId,
    reason,
    refundMethod,
    items
  } = req.body || {};

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const allowedMethods = [
    "cash", "mpesa", "card", "bank", "other"
  ];

  if (
    !uuidPattern.test(saleId) ||
    !uuidPattern.test(requestId || "") ||
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.trim().length > 500 ||
    !allowedMethods.includes(refundMethod) ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 100
  ) {
    return res.status(400).json({
      error: "Invalid return details."
    });
  }

  const seenItems = new Set();

  for (const item of items) {
    if (
      !uuidPattern.test(item.saleItemId || "") ||
      seenItems.has(item.saleItemId) ||
      !Number.isFinite(Number(item.quantity)) ||
      Number(item.quantity) <= 0 ||
      !["resalable", "damaged", "non_resalable"].includes(item.condition)
    ) {
      return res.status(400).json({
        error: "Invalid returned item details."
      });
    }

    seenItems.add(item.saleItemId);
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const existing = await client.query(
      `SELECT id, receipt
       FROM sale_returns
       WHERE shop_id = $1 AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (existing.rows.length) {
      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        message: "Return already processed.",
        return: existing.rows[0]
      });
    }

    const saleResult = await client.query(
      `SELECT *
       FROM sales
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [saleId, req.shopId]
    );

    if (!saleResult.rows.length) {
      throw new Error("Sale not found.");
    }

    const sale = saleResult.rows[0];

    if (Number(sale.total) <= 0) {
      throw new Error("This sale has no remaining value to return.");
    }

    const returnId = randomUUID();
    const returnReceipt =
      `RET-${randomUUID().slice(0, 8).toUpperCase()}`;

    let returnTotalCents = 0;
    const processedItems = [];

    for (const requested of items) {
      const itemResult = await client.query(
        `SELECT *
         FROM sale_items
         WHERE id = $1 AND sale_id = $2
         FOR UPDATE`,
        [requested.saleItemId, saleId]
      );

      if (!itemResult.rows.length) {
        throw new Error("A returned item does not belong to this sale.");
      }

      const soldItem = itemResult.rows[0];
      const soldQuantity = Number(soldItem.quantity);
      const returnQuantity = Number(requested.quantity);

      const previousResult = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) AS returned
         FROM sale_return_items
         WHERE sale_item_id = $1`,
        [soldItem.id]
      );

      const previouslyReturned =
        Number(previousResult.rows[0].returned);

      if (
        previouslyReturned + returnQuantity >
        soldQuantity + 0.000001
      ) {
        throw new Error(
          `Return quantity exceeds the quantity sold for ${soldItem.product_name}.`
        );
      }

      const subtotal = Number(sale.subtotal);

      if (subtotal <= 0) {
        throw new Error("Sale subtotal is invalid.");
      }

      const effectiveUnitPrice =
        Number(soldItem.line_total) *
        (Number(sale.total) / subtotal) /
        soldQuantity;

      const lineRefundCents = Math.round(
        effectiveUnitPrice * returnQuantity * 100
      );

      returnTotalCents += lineRefundCents;

      const productResult = await client.query(
        `SELECT id
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [soldItem.product_id, req.shopId]
      );

      if (!productResult.rows.length) {
        throw new Error("A returned product could not be found.");
      }

      if (requested.condition === "resalable") {
        await client.query(
          `UPDATE products
           SET quantity = quantity + $1,
               updated_at = NOW()
           WHERE id = $2 AND shop_id = $3`,
          [returnQuantity, soldItem.product_id, req.shopId]
        );

        await client.query(
          `INSERT INTO stock_movements (
            shop_id, product_id, user_id,
            movement_type, quantity, unit_price, notes
          )
          VALUES ($1, $2, $3, 'sale_return', $4, $5, $6)`,
          [
            req.shopId,
            soldItem.product_id,
            req.user.userId,
            returnQuantity,
            Number(soldItem.unit_price),
            `Return ${returnReceipt}: ${requested.condition}`
          ]
        );
      }

      processedItems.push({
        id: randomUUID(),
        saleItemId: soldItem.id,
        productId: soldItem.product_id,
        productName: soldItem.product_name,
        sku: soldItem.sku,
        quantity: returnQuantity,
        condition: requested.condition,
        unitRefund: Number(
          (effectiveUnitPrice).toFixed(2)
        ),
        lineTotal: lineRefundCents / 100
      });
    }

    const oldTotalCents = Math.round(Number(sale.total) * 100);
    const oldBalanceCents = Math.round(Number(sale.balance) * 100);

    if (
      returnTotalCents <= 0 ||
      returnTotalCents > oldTotalCents
    ) {
      throw new Error("Calculated refund amount is invalid.");
    }

    const creditReductionCents = Math.min(
      returnTotalCents,
      oldBalanceCents
    );

    const refundCents =
      returnTotalCents - creditReductionCents;

    const newTotalCents =
      oldTotalCents - returnTotalCents;

    const newBalanceCents =
      oldBalanceCents - creditReductionCents;

    const newPaidCents =
      Math.max(0, newTotalCents - newBalanceCents);

    const newStatus =
      newBalanceCents === 0
        ? newPaidCents === 0
          ? "refunded"
          : "completed"
        : newPaidCents === 0
          ? "credit"
          : "partial";

    await client.query(
      `INSERT INTO sale_returns (
        id, shop_id, sale_id, receipt,
        created_by, request_id, reason,
        refund_method, refund_amount, credit_reduction
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        returnId,
        req.shopId,
        saleId,
        returnReceipt,
        req.user.userId,
        requestId,
        reason.trim(),
        refundMethod,
        refundCents / 100,
        creditReductionCents / 100
      ]
    );

    for (const item of processedItems) {
      await client.query(
        `INSERT INTO sale_return_items (
          id, return_id, sale_item_id, product_id,
          product_name, sku, quantity, item_condition,
          unit_refund, line_total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          item.id,
          returnId,
          item.saleItemId,
          item.productId,
          item.productName,
          item.sku,
          item.quantity,
          item.condition,
          item.unitRefund,
          item.lineTotal
        ]
      );
    }

    await client.query(
      `UPDATE sales
       SET total = $1,
           paid = $2,
           balance = $3,
           status = $4
       WHERE id = $5 AND shop_id = $6`,
      [
        newTotalCents / 100,
        newPaidCents / 100,
        newBalanceCents / 100,
        newStatus,
        saleId,
        req.shopId
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Return processed successfully.",
      return: {
        id: returnId,
        receipt: returnReceipt,
        saleId,
        refundMethod,
        refundAmount: refundCents / 100,
        creditReduction: creditReductionCents / 100,
        items: processedItems
      },
      sale: {
        total: newTotalCents / 100,
        paid: newPaidCents / 100,
        balance: newBalanceCents / 100,
        status: newStatus
      }
    });

  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Sale return failed:", error.message);

    return res.status(
      error.message.includes("not found") ||
      error.message.includes("exceeds") ||
      error.message.includes("invalid") ||
      error.message.includes("belong") ||
      error.message.includes("no remaining") ||
      error.message.includes("quantity") 
        ? 400 : 500
    ).json({
      error: error.message || "Could not process return."
    });

  } finally {
    client.release();
  }
});
// --------------------------------------------------
// SALE RETURN HISTORY
// --------------------------------------------------

router.get("/sales/:saleId/returns", async (req, res) => {
  const pool = req.app.locals.pool;
  const { saleId } = req.params;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(saleId)) {
    return res.status(400).json({
      error: "Invalid sale ID."
    });
  }

  try {
    const sale = await pool.query(
      `SELECT id, receipt
       FROM sales
       WHERE id = $1 AND shop_id = $2`,
      [saleId, req.shopId]
    );

    if (!sale.rows.length) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    const result = await pool.query(
      `SELECT
         r.id,
         r.receipt,
         r.reason,
         r.refund_method,
         r.refund_amount,
         r.credit_reduction,
         r.created_at,
         json_agg(
           json_build_object(
             'productName', ri.product_name,
             'sku', ri.sku,
             'quantity', ri.quantity,
             'condition', ri.item_condition,
             'unitRefund', ri.unit_refund,
             'lineTotal', ri.line_total
           )
           ORDER BY ri.product_name
         ) AS items
       FROM sale_returns r
       LEFT JOIN sale_return_items ri
         ON ri.return_id = r.id
       WHERE r.shop_id = $1
         AND r.sale_id = $2
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [req.shopId, saleId]
    );

    return res.json({
      sale: sale.rows[0],
      returns: result.rows
    });

  } catch (error) {
    console.error("Return history failed:", error.message);

    return res.status(500).json({
      error: "Could not load return history."
    });
  }
});
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
               'price', si.unit_price,
'cost', si.unit_cost
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

router.patch("/sales/:saleId", async (req, res) => {
  if (!["owner", "manager"].includes(req.shopRole)) {
    return res.status(403).json({
      error: "Only the owner or manager can edit sales."
    });
  }

  const pool = req.app.locals.pool;
  const { saleId } = req.params;

  const {
    receipt,
    customerId = null,
    paymentMethod,
    discount = 0,
    items,
    reason = ""
  } = req.body || {};

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    !uuidPattern.test(saleId) ||
    typeof receipt !== "string" ||
    !receipt.trim() ||
    receipt.trim().length > 80 ||
    typeof paymentMethod !== "string" ||
    !paymentMethod.trim() ||
    paymentMethod.trim().length > 40 ||
    !Number.isFinite(Number(discount)) ||
    Number(discount) < 0 ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 100 ||
    (customerId !== null &&
      (typeof customerId !== "string" || !uuidPattern.test(customerId))) ||
    typeof reason !== "string" ||
    reason.length > 500
  ) {
    return res.status(400).json({
      error: "Invalid sale correction details."
    });
  }

  const normalizedItems = [];

  for (const item of items) {
    const quantity = Number(item.qty);
const price = Number(item.price);
const cost = Number(item.cost ?? 0);
    if (
  typeof item.productId !== "string" ||
  !uuidPattern.test(item.productId) ||
  !Number.isFinite(quantity) ||
  quantity <= 0 ||
  !Number.isFinite(price) ||
  price <= 0 ||
  !Number.isFinite(cost) ||
  cost < 0
)
    {
      return res.status(400).json({
        error: "Every sale item needs a valid product, quantity and price."
      });
    }

    normalizedItems.push({
  productId: item.productId,
  quantity,
  price,
  cost
});
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Lock the sale so two people cannot edit it simultaneously.
    const saleResult = await client.query(
      `SELECT *
       FROM sales
       WHERE id = $1 AND shop_id = $2
       FOR UPDATE`,
      [saleId, req.shopId]
    );

    if (!saleResult.rows.length) {
      const error = new Error("Sale not found.");
      error.status = 404;
      throw error;
    }

    const oldSale = saleResult.rows[0];

    // Preserve all existing customer-payment allocations.
    const allocationResult = await client.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(amount), 0) AS allocated
       FROM customer_payment_allocations
       WHERE sale_id = $1`,
      [saleId]
    );

    const allocationCount = Number(allocationResult.rows[0].count);
    const allocatedAmount = Number(allocationResult.rows[0].allocated);

    if (
      allocationCount > 0 &&
      customerId !== oldSale.customer_id
    ) {
      const error = new Error(
        "This sale has customer payments allocated to it. Its customer cannot be changed."
      );
      error.status = 409;
      throw error;
    }

    const paidCents = Math.round(Number(oldSale.paid) * 100);
    const allocatedCents = Math.round(allocatedAmount * 100);

    if (paidCents < allocatedCents) {
      const error = new Error(
        "The recorded paid amount is inconsistent with its payment allocations. Resolve this before editing."
      );
      error.status = 409;
      throw error;
    }

    // Verify the replacement customer belongs to this shop.
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
        const error = new Error("Selected customer was not found.");
        error.status = 404;
        throw error;
      }

      verifiedCustomer = customerResult.rows[0];
    }

    // Load the original sale items.
    const oldItemsResult = await client.query(
      `SELECT product_id, product_name, sku,
              quantity, unit_price, line_total
       FROM sale_items
       WHERE sale_id = $1`,
      [saleId]
    );

    const oldItems = oldItemsResult.rows;

    const oldQuantities = new Map();
    const newQuantities = new Map();

    for (const item of oldItems) {
      const id = item.product_id;

      oldQuantities.set(
        id,
        (oldQuantities.get(id) || 0) + Number(item.quantity)
      );
    }

    for (const item of normalizedItems) {
      const id = item.productId;

      newQuantities.set(
        id,
        (newQuantities.get(id) || 0) + item.quantity
      );
    }

    // Lock every affected product in a consistent order.
    const productIds = [
      ...new Set([
        ...oldQuantities.keys(),
        ...newQuantities.keys()
      ])
    ].sort();

    const products = new Map();

    for (const productId of productIds) {
      const result = await client.query(
        `SELECT id, name, sku, quantity, selling_price
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, req.shopId]
      );

      if (!result.rows.length) {
        const error = new Error(
          "A product in the original or corrected sale no longer exists."
        );
        error.status = 409;
        throw error;
      }

      products.set(productId, result.rows[0]);
    }

    // Calculate the corrected sale total using integer cents.
    let subtotalCents = 0;

    for (const item of normalizedItems) {
      subtotalCents += Math.round(
        item.quantity * Math.round(item.price * 100)
      );
    }

    subtotalCents = Math.round(subtotalCents);

    const discountCents = Math.round(Number(discount) * 100);

    if (discountCents > subtotalCents) {
      const error = new Error("Discount cannot exceed subtotal.");
      error.status = 400;
      throw error;
    }

    const totalCents = subtotalCents - discountCents;

    // Recorded payments are not rewritten by this editor.
    if (totalCents < paidCents) {
      const error = new Error(
        "The corrected total cannot be lower than the amount already recorded as paid."
      );
      error.status = 409;
      throw error;
    }

    const balanceCents = totalCents - paidCents;

    if (balanceCents > 0 && !verifiedCustomer) {
      const error = new Error(
        "A sale with an outstanding balance must have a registered customer."
      );
      error.status = 400;
      throw error;
    }


    // Restore removed quantities and deduct additional quantities.
    // Every stock change is recorded in stock_movements.
    for (const productId of productIds) {
      const oldQty = oldQuantities.get(productId) || 0;
      const newQty = newQuantities.get(productId) || 0;
      const difference = Number((newQty - oldQty).toFixed(3));

      if (difference === 0) continue;

      const oldProductItems = oldItems.filter(
        item => item.product_id === productId
      );

      const newProductItems = normalizedItems.filter(
        item => item.productId === productId
      );

      const oldValue = oldProductItems.reduce(
        (sum, item) =>
          sum + Number(item.quantity) * Number(item.unit_price),
        0
      );

      const newValue = newProductItems.reduce(
        (sum, item) => sum + item.quantity * item.price,
        0
      );

      const movementQuantity = Math.abs(difference);

      let movementType;
      let movementPrice;

      if (difference > 0) {
        // More units are now included in the sale.
        const result = await client.query(
          `UPDATE products
           SET quantity = quantity - $1
           WHERE id = $2
             AND shop_id = $3
             AND quantity >= $1
           RETURNING id`,
          [movementQuantity, productId, req.shopId]
        );

        if (result.rowCount !== 1) {
          const product = products.get(productId);
          const error = new Error(
            `Insufficient stock for ${product.name}. The sale was not changed.`
          );
          error.status = 409;
          throw error;
        }

        movementType = "sale";
        movementPrice = newQty > 0 ? newValue / newQty : 0;

      } else {
        // Units removed from the sale are returned to stock.
        await client.query(
          `UPDATE products
           SET quantity = quantity + $1
           WHERE id = $2 AND shop_id = $3`,
          [movementQuantity, productId, req.shopId]
        );

        movementType = "sale_return";
        movementPrice = oldQty > 0 ? oldValue / oldQty : 0;
      }

      await client.query(
        `INSERT INTO stock_movements (
          shop_id,
          product_id,
          user_id,
          movement_type,
          quantity,
          unit_price,
          notes
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          req.shopId,
          productId,
          req.user.userId,
          movementType,
          movementQuantity,
          Number(movementPrice.toFixed(2)),
          `Sale edit: ${oldSale.receipt} → ${receipt.trim()}`
        ]
      );
    }
    const subtotal = subtotalCents / 100;
    const discountAmount = discountCents / 100;
    const total = totalCents / 100;
    const paid = paidCents / 100;
    const balance = balanceCents / 100;

    const status =
      balanceCents === 0
        ? "completed"
        : paidCents === 0
          ? "credit"
          : "partial";

    const customerName = verifiedCustomer
      ? verifiedCustomer.name
      : (
          typeof oldSale.customer_name === "string" &&
          oldSale.customer_name !== "Walk-in"
            ? oldSale.customer_name
            : "Walk-in"
        );

    // Capture the complete before-state.
    const beforeData = {
      sale: oldSale,
      items: oldItems
    };

    // Update the sale itself.
    await client.query(
      `UPDATE sales
       SET receipt = $1,
           invoice_number = $1,
           customer_id = $2,
           customer_name = $3,
           payment_method = $4,
           subtotal = $5,
           discount = $6,
           total = $7,
           balance = $8,
           status = $9
       WHERE id = $10 AND shop_id = $11`,
      [
        receipt.trim(),
        verifiedCustomer ? verifiedCustomer.id : null,
        verifiedCustomer ? verifiedCustomer.name : "Walk-in",
        paymentMethod.trim(),
        subtotal,
        discountAmount,
        total,
        balance,
        status,
        saleId,
        req.shopId
      ]
    );

    // Replace the sale item rows.
    await client.query(
      "DELETE FROM sale_items WHERE sale_id = $1",
      [saleId]
    );
for (const item of normalizedItems) {
  const product = products.get(item.productId);

  const lineTotal = Number(
    (item.quantity * item.price).toFixed(2)
  );

  // Update the current inventory selling price.
  await client.query(
    `UPDATE products
     SET selling_price = $1,
         updated_at = NOW()
     WHERE id = $2 AND shop_id = $3`,
    [item.price, item.productId, req.shopId]
  );

  // Save the corrected historical sale price and buying cost.
  await client.query(
    `INSERT INTO sale_items (
      id, sale_id, product_id, product_name,
      sku, quantity, unit_price, unit_cost, line_total
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      saleId,
      item.productId,
      product.name,
      product.sku,
      item.quantity,
      item.price,
      item.cost,
      lineTotal
    ]
  );
}
    const afterData = {
      sale: {
        receipt: receipt.trim(),
        customerId: verifiedCustomer ? verifiedCustomer.id : null,
        customerName,
        paymentMethod: paymentMethod.trim(),
        subtotal,
        discount: discountAmount,
        total,
        paid,
        balance,
        status
      },
      items: normalizedItems.map(item => ({
        productId: item.productId,
        productName: products.get(item.productId).name,
        sku: products.get(item.productId).sku,
        quantity: item.quantity,
        price: item.price
      }))
    };

    // Permanent edit history.
    await client.query(
      `INSERT INTO sale_edit_audit (
        id, shop_id, sale_id, edited_by,
        reason, before_data, after_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        req.shopId,
        saleId,
        req.user.userId,
        reason.trim() || null,
        beforeData,
        afterData
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      message: "Sale updated successfully.",
      sale: {
        id: saleId,
        receipt: receipt.trim(),
        subtotal,
        discount: discountAmount,
        total,
        paid,
        balance,
        status
      }
    });

    } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Sale edit failed:", error.message, error.code);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "That receipt or invoice number is already in use."
      });
    }

    return res.status(error.status || 500).json({
      error: error.message || "Could not update sale."
    });

  } finally {
    if (client) client.release();
  }

});
          
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
    notes = "",
    requestId
  } = req.body || {};

  const paymentAmount = Number(amount);
  const normalizedMethod =
    typeof method === "string" ? method.trim() : "";
  const normalizedReference =
    typeof reference === "string" ? reference.trim() || null : null;
  const normalizedNotes =
    typeof notes === "string" ? notes.trim() || null : null;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof requestId !== "string" ||
    !uuidPattern.test(requestId) ||
    typeof customerId !== "string" ||
    !uuidPattern.test(customerId) ||
    !Number.isFinite(paymentAmount) ||
    paymentAmount <= 0 ||
    Math.round(paymentAmount * 100) !== paymentAmount * 100 ||
    !normalizedMethod ||
    typeof reference !== "string" ||
    typeof notes !== "string"
  ) {
    return res.status(400).json({
      error: "Invalid customer payment details"
    });
  }

  const paymentCents = Math.round(paymentAmount * 100);

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Serialize requests using the same request ID.
    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )`,
      [`${req.shopId}:${requestId}`]
    );

    // Check whether this exact request was already processed.
    const existingPaymentResult = await client.query(
      `SELECT
         id,
         customer_id,
         amount,
         method,
         reference,
         notes
       FROM customer_payments
       WHERE shop_id = $1
         AND request_id = $2`,
      [req.shopId, requestId]
    );

    if (existingPaymentResult.rows.length) {
      const existing = existingPaymentResult.rows[0];

      const matches =
        existing.customer_id === customerId &&
        Math.round(Number(existing.amount) * 100) === paymentCents &&
        existing.method === normalizedMethod &&
        (existing.reference || null) === normalizedReference &&
        (existing.notes || null) === normalizedNotes;

      if (!matches) {
        const error = new Error(
          "This request ID was already used for different payment details."
        );
        error.status = 409;
        throw error;
      }

      const allocationResult = await client.query(
        `SELECT
           a.sale_id AS "saleId",
           s.receipt,
           a.amount
         FROM customer_payment_allocations a
         JOIN sales s ON s.id = a.sale_id
         WHERE a.payment_id = $1`,
        [existing.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        message: "Customer payment was already recorded",
        alreadyProcessed: true,
        payment: {
          id: existing.id,
          customerId: existing.customer_id,
          amount: Number(existing.amount),
          method: existing.method,
          allocations: allocationResult.rows
        }
      });
    }

    // Lock the customer while processing a new payment.
    const customerResult = await client.query(
      `SELECT id
       FROM customers
       WHERE id = $1
         AND shop_id = $2
       FOR UPDATE`,
      [customerId, req.shopId]
    );

    if (!customerResult.rows.length) {
      const error = new Error("Customer not found.");
      error.status = 404;
      throw error;
    }

    // Get outstanding invoices, oldest first.
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

    if (paymentCents > outstandingCents) {
      const error = new Error(
        `Payment exceeds outstanding balance of ${
          (outstandingCents / 100).toFixed(2)
        }.`
      );
      error.status = 400;
      throw error;
    }

    if (paymentCents <= 0) {
      const error = new Error("Payment amount must be greater than zero.");
      error.status = 400;
      throw error;
    }

    const paymentId = randomUUID();

    await client.query(
      `INSERT INTO customer_payments (
        id,
        shop_id,
        customer_id,
        user_id,
        amount,
        method,
        reference,
        notes,
        request_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        paymentId,
        req.shopId,
        customerId,
        req.user.userId,
        paymentCents / 100,
        normalizedMethod,
        normalizedReference,
        normalizedNotes,
        requestId
      ]
    );

    let remainingCents = paymentCents;
    const allocations = [];

    // Allocate payment to oldest outstanding invoices first.
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
          payment_id,
          sale_id,
          amount
        )
        VALUES ($1,$2,$3)`,
        [
          paymentId,
          invoice.id,
          allocatedCents / 100
        ]
      );

      const updateResult = await client.query(
        `UPDATE sales
         SET paid = $1,
             balance = $2,
             status = $3
         WHERE id = $4
           AND shop_id = $5
           AND customer_id = $6
           AND balance > 0`,
        [
          newPaidCents / 100,
          newBalanceCents / 100,
          newStatus,
          invoice.id,
          req.shopId,
          customerId
        ]
      );

      if (updateResult.rowCount !== 1) {
        throw new Error(
          "Invoice update failed. Payment was rolled back."
        );
      }

      allocations.push({
        receipt: invoice.receipt,
        amount: allocatedCents / 100,
        balance: newBalanceCents / 100
      });

      remainingCents -= allocatedCents;
    }

    if (remainingCents !== 0) {
      throw new Error(
        "Payment allocation was incomplete. Payment was rolled back."
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Customer payment recorded successfully",
      payment: {
        id: paymentId,
        customerId,
        amount: paymentCents / 100,
        method: normalizedMethod,
        allocations
      }
    });

  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error(
      "Customer payment failed:",
      error.message
    );

    return res.status(error.status || 500).json({
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
       `SELECT id, name, sku, selling_price, cost, quantity
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
        price,
        cost: Number(product.cost || 0)
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
          sku, quantity, unit_price, unit_cost, line_total
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          saleId,
          item.productId,
          item.product.name,
          item.product.sku,
          item.quantity,
          item.price,
          item.cost,
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
