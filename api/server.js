
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(express.json());

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || false
  })
);

// --------------------------------------------------
// DATABASE CONNECTION
// --------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true
  }
});

app.locals.pool = pool;

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createToken(userId) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }

  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
}

// --------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// --------------------------------------------------

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication token required"
    });
  }

  const token = authHeader.split(" ")[1];

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      error: "Authentication is not configured"
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (error, decoded) => {
    if (
      error ||
      !decoded ||
      typeof decoded.userId !== "string"
    ) {
      return res.status(403).json({
        error: "Invalid or expired token"
      });
    }

    req.user = decoded;
    next();
  });
}

// --------------------------------------------------
// SHOP ROLE MIDDLEWARE
// --------------------------------------------------

function requireShopRole(allowedRoles = []) {
  return async (req, res, next) => {
    try {
      const { shopId } = req.params;

      const result = await pool.query(
        `SELECT role
         FROM shop_users
         WHERE user_id = $1
         AND shop_id = $2`,
        [req.user.userId, shopId]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({
          error: "You do not belong to this shop"
        });
      }

      const userRole = result.rows[0].role;

      if (
        allowedRoles.length > 0 &&
        !allowedRoles.includes(userRole)
      ) {
        return res.status(403).json({
          error: "Insufficient permissions"
        });
      }

      req.shopRole = userRole;
      next();

    } catch (error) {
      console.error("Shop role check failed:", error.message);

      return res.status(500).json({
        error: "Unable to verify shop permissions"
      });
    }
  };
}

// --------------------------------------------------
// API HOME
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Ambassadors Auto Care API"
  });
});

// --------------------------------------------------
// DATABASE HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "healthy",
      database: "connected"
    });

  } catch (error) {
    console.error(
      "Health check failed:",
      error.message,
      error.code
    );

    res.status(503).json({
      status: "unavailable",
      database: "disconnected"
    });
  }
});

// --------------------------------------------------
// ONE-TIME SHOP OWNER SETUP
// --------------------------------------------------

app.post("/api/auth/setup-owner", async (req, res) => {
  let client;
  let transactionStarted = false;

  try {
    const { email, password, setupSecret } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof setupSecret !== "string" ||
      !isValidEmail(email) ||
      password.length < 12
    ) {
      return res.status(400).json({
        error: "Valid email, password (at least 12 characters), and setup secret required"
      });
    }

    if (!process.env.OWNER_SETUP_SECRET) {
      return res.status(500).json({
        error: "Owner setup is not configured"
      });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        error: "Authentication is not configured"
      });
    }

    if (setupSecret !== process.env.OWNER_SETUP_SECRET) {
      return res.status(403).json({
        error: "Invalid setup secret"
      });
    }

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const shop = await client.query(
      `SELECT id
       FROM shops
       WHERE id = $1
       FOR UPDATE`,
      ["fe94ff4e-e3a8-4fb4-88a1-3a1fc0eef824"]
    );

    if (shop.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        error: "Shop not found"
      });
    }

    const shopId = shop.rows[0].id;

    const existingOwner = await client.query(
      `SELECT id
       FROM shop_users
       WHERE shop_id = $1
       AND role = 'owner'`,
      [shopId]
    );

    if (existingOwner.rows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: "Owner setup has already been completed"
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await client.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [normalizedEmail, passwordHash]
    );

    await client.query(
      `INSERT INTO shop_users (shop_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [shopId, user.rows[0].id]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    const token = createToken(user.rows[0].id);

    return res.status(201).json({
      message: "Shop owner created successfully",
      user: user.rows[0],
      token
    });

  } catch (error) {
    console.error(
      "Owner setup failed:",
      error.message,
      error.code
    );

    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    if (error.code === "23505") {
      return res.status(409).json({
        error: "An account with this email already exists"
      });
    }

    return res.status(500).json({
      error: "Owner setup failed"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

// --------------------------------------------------
// USER LOGIN
// --------------------------------------------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !isValidEmail(email)
    ) {
      return res.status(400).json({
        error: "Valid email and password required"
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const token = createToken(user.id);

    return res.json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email
      },
      token
    });

  } catch (error) {
    console.error("Login failed:", error.message);

    return res.status(500).json({
      error: "Login failed"
    });
  }
});

// --------------------------------------------------
// CREATE SHOP STAFF
// --------------------------------------------------

app.post(
  "/api/shops/:shopId/staff",
  authenticateToken,
  requireShopRole(["owner", "manager"]),
  async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
      const { email, password, role } = req.body;

      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        !isValidEmail(email) ||
        password.length < 12 ||
        !["manager", "staff"].includes(role)
      ) {
        return res.status(400).json({
          error: "Valid email, password and role required"
        });
      }

      if (req.shopRole === "manager" && role !== "staff") {
        return res.status(403).json({
          error: "Managers can only create staff accounts"
        });
      }

      const normalizedEmail = normalizeEmail(email);

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const passwordHash = await bcrypt.hash(password, 12);

      const user = await client.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email`,
        [normalizedEmail, passwordHash]
      );

      await client.query(
        `INSERT INTO shop_users (shop_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [req.params.shopId, user.rows[0].id, role]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        message: "Staff account created successfully",
        user: user.rows[0],
        role
      });

    } catch (error) {
      console.error(
        "Staff creation failed:",
        error.message,
        error.code
      );

      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError.message);
        }
      }

      if (error.code === "23505") {
        return res.status(409).json({
          error: "This email is already registered"
        });
      }

      return res.status(500).json({
        error: "Staff account creation failed"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// --------------------------------------------------
// RECORD PURCHASED STOCK
// --------------------------------------------------

app.post(
  "/api/shops/:shopId/products/:productId/purchase",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
      const { shopId, productId } = req.params;
      const { quantity, unitCost, supplierName, notes } = req.body;

      if (
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        typeof unitCost !== "number" ||
        !Number.isFinite(unitCost) ||
        unitCost <= 0 ||
        typeof supplierName !== "string" ||
        !supplierName.trim() ||
        (
          notes !== undefined &&
          typeof notes !== "string"
        )
      ) {
        return res.status(400).json({
          error: "Valid quantity, purchase cost and supplier name required"
        });
      }

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const product = await client.query(
        `SELECT id, name, quantity
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, shopId]
      );

      if (product.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "Product not found"
        });
      }

      const updatedProduct = await client.query(
        `UPDATE products
         SET quantity = quantity + $1
         WHERE id = $2 AND shop_id = $3
         RETURNING id, name, quantity`,
        [quantity, productId, shopId]
      );

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
        VALUES ($1, $2, $3, 'purchase', $4, $5, $6, $7)`,
        [
          shopId,
          productId,
          req.user.userId,
          quantity,
          unitCost,
          supplierName.trim(),
          typeof notes === "string" ? notes.trim() || null : null
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        message: "Purchased stock recorded successfully",
        product: updatedProduct.rows[0],
        quantityAdded: quantity
      });

    } catch (error) {
      console.error("Purchase recording failed:", error.message);

      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError.message);
        }
      }

      return res.status(500).json({
        error: "Unable to record purchased stock"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// --------------------------------------------------
// RECORD PRODUCT SALE
// --------------------------------------------------

app.post(
  "/api/shops/:shopId/products/:productId/sale",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
      const { shopId, productId } = req.params;
      const { quantity, notes } = req.body;

      if (
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          error: "Quantity must be a positive integer"
        });
      }

      if (
        notes !== undefined &&
        typeof notes !== "string"
      ) {
        return res.status(400).json({
          error: "Notes must be text"
        });
      }

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const productResult = await client.query(
        `SELECT id, name, quantity, selling_price
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, shopId]
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "Product not found"
        });
      }

      const product = productResult.rows[0];

      if (Number(product.quantity) < quantity) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Insufficient stock",
          available: Number(product.quantity),
          requested: quantity
        });
      }

      const unitPrice = Number(product.selling_price);

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Invalid product selling price"
        });
      }

      const updateResult = await client.query(
        `UPDATE products
         SET quantity = quantity - $1
         WHERE id = $2 AND shop_id = $3
         RETURNING id, name, quantity, selling_price`,
        [quantity, productId, shopId]
      );

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
        VALUES ($1, $2, $3, 'sale', $4, $5, $6)`,
        [
          shopId,
          productId,
          req.user.userId,
          quantity,
          unitPrice,
          notes ? notes.trim() || null : null
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        message: "Sale recorded successfully",
        sale: {
          product: updateResult.rows[0].name,
          quantitySold: quantity,
          unitPrice,
          total: Number((unitPrice * quantity).toFixed(2)),
          remainingStock: Number(updateResult.rows[0].quantity)
        }
      });

    } catch (error) {
      console.error("Sale error:", error.message);

      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError.message);
        }
      }

      return res.status(500).json({
        error: "Failed to record sale"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// --------------------------------------------------
// RECORD PHYSICAL STOCK COUNT
// --------------------------------------------------

app.post(
  "/api/shops/:shopId/products/:productId/stock-count",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
      const { shopId, productId } = req.params;
      const { physicalQuantity, reason } = req.body;

      if (
        !Number.isSafeInteger(physicalQuantity) ||
        physicalQuantity < 0
      ) {
        return res.status(400).json({
          error: "Physical quantity must be a non-negative integer"
        });
      }

      if (
        typeof reason !== "string" ||
        reason.trim() === ""
      ) {
        return res.status(400).json({
          error: "A reason for the stock count is required"
        });
      }

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const productResult = await client.query(
        `SELECT id, name, quantity
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, shopId]
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "Product not found"
        });
      }

      const product = productResult.rows[0];
      const systemQuantity = Number(product.quantity);

      await client.query(
        `UPDATE products
         SET quantity = $1
         WHERE id = $2 AND shop_id = $3`,
        [physicalQuantity, productId, shopId]
      );

      const adjustmentResult = await client.query(
        `INSERT INTO stock_adjustments (
          shop_id,
          product_id,
          user_id,
          system_quantity,
          physical_quantity,
          reason
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, system_quantity, physical_quantity,
                  difference, reason, created_at`,
        [
          shopId,
          productId,
          req.user.userId,
          systemQuantity,
          physicalQuantity,
          reason.trim()
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        message: "Physical stock count recorded successfully",
        product: product.name,
        adjustment: adjustmentResult.rows[0]
      });

    } catch (error) {
      console.error("Stock count error:", error.message);

      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError.message);
        }
      }

      return res.status(500).json({
        error: "Failed to record physical stock count"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// --------------------------------------------------
// GET SHOP INVENTORY
// --------------------------------------------------

app.get(
  "/api/shops/:shopId/products",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  async (req, res) => {
    const { shopId } = req.params;

    try {
      const result = await pool.query(
        `SELECT
           id,
           sku,
           name,
           selling_price,
           quantity,
           created_at,
           updated_at
         FROM products
         WHERE shop_id = $1
         ORDER BY name ASC`,
        [shopId]
      );

      return res.status(200).json({
        message: "Inventory retrieved successfully",
        count: result.rows.length,
        products: result.rows
      });

    } catch (error) {
      console.error("Inventory error:", error.message);

      return res.status(500).json({
        error: "Failed to retrieve inventory"
      });
    }
  }
);

// --------------------------------------------------
// CREATE NEW PRODUCT
// --------------------------------------------------

app.post(
  "/api/shops/:shopId/products",
  authenticateToken,
  requireShopRole(["owner", "manager"]),
  async (req, res) => {
    const { shopId } = req.params;
    const { sku, name, sellingPrice, quantity } = req.body;

    if (
      typeof sku !== "string" ||
      !sku.trim() ||
      typeof name !== "string" ||
      !name.trim()
    ) {
      return res.status(400).json({
        error: "SKU and product name are required"
      });
    }

    if (
      typeof sellingPrice !== "number" ||
      !Number.isFinite(sellingPrice) ||
      sellingPrice <= 0
    ) {
      return res.status(400).json({
        error: "Selling price must be greater than zero"
      });
    }

    const initialQuantity = quantity === undefined ? 0 : quantity;

    if (
      !Number.isSafeInteger(initialQuantity) ||
      initialQuantity < 0
    ) {
      return res.status(400).json({
        error: "Quantity must be a non-negative integer"
      });
    }

    try {
      const result = await pool.query(
        `INSERT INTO products (
          shop_id,
          sku,
          name,
          selling_price,
          quantity
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, sku, name, selling_price,
                  quantity, created_at, updated_at`,
        [
          shopId,
          sku.trim(),
          name.trim(),
          sellingPrice,
          initialQuantity
        ]
      );

      return res.status(201).json({
        message: "Product created successfully",
        product: result.rows[0]
      });

    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "A product with this SKU already exists"
        });
      }

      console.error("Product creation error:", error.message);

      return res.status(500).json({
        error: "Failed to create product"
      });
    }
  }
);

// --------------------------------------------------
// UPDATE PRODUCT DETAILS
// --------------------------------------------------

app.patch(
  "/api/shops/:shopId/products/:productId",
  authenticateToken,
  requireShopRole(["owner", "manager"]),
  async (req, res) => {
    const { shopId, productId } = req.params;
    const { sku, name, sellingPrice } = req.body;

    const updates = [];
    const values = [];
    let index = 1;

    if (sku !== undefined) {
      if (typeof sku !== "string" || !sku.trim()) {
        return res.status(400).json({
          error: "SKU must be a non-empty string"
        });
      }

      updates.push(`sku = $${index++}`);
      values.push(sku.trim());
    }

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          error: "Name must be a non-empty string"
        });
      }

      updates.push(`name = $${index++}`);
      values.push(name.trim());
    }

    if (sellingPrice !== undefined) {
      if (
        typeof sellingPrice !== "number" ||
        !Number.isFinite(sellingPrice) ||
        sellingPrice <= 0
      ) {
        return res.status(400).json({
          error: "Selling price must be greater than zero"
        });
      }

      updates.push(`selling_price = $${index++}`);
      values.push(sellingPrice);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: "Provide at least one field to update"
      });
    }

    values.push(productId, shopId);

    try {
      const result = await pool.query(
        `UPDATE products
         SET ${updates.join(", ")},
             updated_at = NOW()
         WHERE id = $${index++}
           AND shop_id = $${index}
         RETURNING id, sku, name, selling_price,
                   quantity, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Product not found"
        });
      }

      return res.status(200).json({
        message: "Product updated successfully",
        product: result.rows[0]
      });

    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "A product with this SKU already exists"
        });
      }

      console.error("Product update error:", error.message);

      return res.status(500).json({
        error: "Failed to update product"
      });
    }
  }
);

// --------------------------------------------------
// DELETE PRODUCT
// --------------------------------------------------

app.delete(
  "/api/shops/:shopId/products/:productId",
  authenticateToken,
  requireShopRole(["owner", "manager"]),
  async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
      const { shopId, productId } = req.params;

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const productResult = await client.query(
        `SELECT id, sku, name, quantity
         FROM products
         WHERE id = $1 AND shop_id = $2
         FOR UPDATE`,
        [productId, shopId]
      );

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "Product not found"
        });
      }

      const movementCheck = await client.query(
        `SELECT 1
         FROM stock_movements
         WHERE product_id = $1
         LIMIT 1`,
        [productId]
      );

      const adjustmentCheck = await client.query(
        `SELECT 1
         FROM stock_adjustments
         WHERE product_id = $1
         LIMIT 1`,
        [productId]
      );

      if (
        movementCheck.rows.length > 0 ||
        adjustmentCheck.rows.length > 0
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          error: "Product has transaction history and cannot be deleted",
          suggestion: "Archive the product instead"
        });
      }

      const product = productResult.rows[0];

      await client.query(
        `DELETE FROM products
         WHERE id = $1 AND shop_id = $2`,
        [productId, shopId]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        message: "Product deleted successfully",
        product
      });

    } catch (error) {
      console.error("Product deletion error:", error.message);

      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError.message);
        }
      }

      return res.status(500).json({
        error: "Failed to delete product"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// --------------------------------------------------
// AUTHENTICATED SESSION
// --------------------------------------------------

app.get(
  "/api/auth/session",
  authenticateToken,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           su.shop_id,
           su.role,
           s.name AS shop_name
         FROM shop_users su
         INNER JOIN shops s ON s.id = su.shop_id
         WHERE su.user_id = $1
         ORDER BY su.created_at ASC`,
        [req.user.userId]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({
          error: "This account is not assigned to a shop"
        });
      }

      return res.status(200).json({
        message: "Session verified",
        user: {
          id: req.user.userId
        },
        shops: result.rows
      });

    } catch (error) {
      console.error("Session verification failed:", error.message);

      return res.status(500).json({
        error: "Unable to verify session"
      });
    }
  }
);

// --------------------------------------------------
// CUSTOMER AND SUPPLIER ROUTES
// --------------------------------------------------

const partiesRouter = require("./routes/parties");

app.use(
  "/api/shops/:shopId",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  (req, res, next) => {
    req.shopId = req.params.shopId;
    next();
  },
  partiesRouter
);

// --------------------------------------------------
// CLOUD SALES ROUTES
// --------------------------------------------------

const {
  router: salesRouter,
  initializeSalesTables
} = require("./routes/sales");

app.use(
  "/api/shops/:shopId",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  (req, res, next) => {
    req.shopId = req.params.shopId;
    next();
  },
  salesRouter
);
const {
  router: purchaseRouter,
  initializePurchaseTables
} = require("./routes/purchase");
app.use(
  "/api/shops/:shopId",
  authenticateToken,
  requireShopRole(["owner", "manager", "staff"]),
  (req, res, next) => {
    req.shopId = req.params.shopId;
    next();
  },
  purchaseRouter
);
// --------------------------------------------------
// SERVER START
// --------------------------------------------------

async function startServer() {
  try {
    await initializeSalesTables(pool);
    await initializePurchaseTables(pool);

    app.listen(PORT, () => {
      console.log(
        `Ambassadors Auto Care API running on port ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      "Failed to initialize sales tables:",
      error.message
    );

    process.exit(1);
  }
}

startServer();

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

process.on("SIGTERM", async () => {
  console.log("Shutting down API...");

  await pool.end();

  process.exit(0);
});
