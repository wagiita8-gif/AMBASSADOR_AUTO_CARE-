

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

    CREATE TABLE IF NOT EXISTS sale_items (
      id UUID PRIMARY KEY,
      sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity NUMERIC(12,3) NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sales_shop_date
      ON sales(shop_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_sale_items_sale
      ON sale_items(sale_id);
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

router.post("/sales", async (req, res) => {
  const pool = req.app.locals.pool;
  const {
    receipt,
    customerName,
    paymentMethod,
    discount = 0,
    paid,
    items
  } = req.body;

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

    const saleId = randomUUID();
    const status =
      balance === 0 ? "Paid" :
      paidAmount === 0 ? "Credit" : "Part paid";

    await client.query(
      `INSERT INTO sales (
        id, shop_id, user_id, receipt, customer_name,
        payment_method, subtotal, discount, total,
        paid, balance, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        saleId,
        req.shopId,
        req.user.userId,
        receipt.trim(),
        typeof customerName === "string" && customerName.trim()
          ? customerName.trim()
          : "Walk-in",
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
          sku, quantity, unit_price
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          saleId,
          item.productId,
          item.product.name,
          item.product.sku,
          item.quantity,
          item.price
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

    console.error("Cloud sale failed:", error.message);

    res.status(
      error.message.includes("not found") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("Discount") ||
      error.message.includes("Payment")
        ? 400 : 500
    ).json({ error: error.message || "Could not record sale" });

  } finally {
    if (client) client.release();
  }
});

module.exports = { router, initializeSalesTables };
