
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
    if (error) {
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

    // Validate input
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

    // Check environment configuration
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

    // Verify setup secret
    if (setupSecret !== process.env.OWNER_SETUP_SECRET) {
      return res.status(403).json({
        error: "Invalid setup secret"
      });
    }

    // Connect to database
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Lock the shop row during owner setup
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

    // Check whether an owner already exists
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

    // Prepare account details
    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await client.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [normalizedEmail, passwordHash]
    );

    // Assign owner role
    await client.query(
      `INSERT INTO shop_users (shop_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [shopId, user.rows[0].id]
    );

    // Save transaction
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
        console.error(
          "Rollback failed:",
          rollbackError.message
        );
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
// USER REGISTRATION
// --------------------------------------------------

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !isValidEmail(email) ||
      password.length < 12
    ) {
      return res.status(400).json({
        error: "Valid email and password (at least 12 characters) required"
      });
    }

    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [normalizedEmail, passwordHash]
    );

    return res.status(201).json({
      message: "User registered successfully",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Registration failed:", error.message);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "Email is already registered"
      });
    }

    return res.status(500).json({
      error: "Registration failed"
    });
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

      // Validate input
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

      // Managers can only create staff
      if (req.shopRole === "manager" && role !== "staff") {
        return res.status(403).json({
          error: "Managers can only create staff accounts"
        });
      }

      const normalizedEmail = normalizeEmail(email);

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      // Create user account
      const passwordHash = await bcrypt.hash(password, 12);

      const user = await client.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email`,
        [normalizedEmail, passwordHash]
      );

      // Assign user to shop
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
      console.error("Staff creation failed:", error.message, error.code);

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
      if (client) client.release();
    }
  }
);

// --------------------------------------------------
// SERVER START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Ambassadors Auto Care API running on port ${PORT}`
  );
});

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

process.on("SIGTERM", async () => {
  console.log("Shutting down API...");

  await pool.end();

  process.exit(0);
});
    
