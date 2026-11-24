
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

app.use(express.json());

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || false
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Check API
app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Ambassadors Auto Care API"
  });
});

// Check database
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "healthy",
      database: "connected"
    });
  } catch (error) {
    console.error("Database connection failed");

    res.status(503).json({
      status: "unavailable",
      database: "disconnected"
    });
  }
});

// Verify authentication token
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "Access token required"
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        error: "Invalid or expired token"
      });
    }

    req.user = user;
    next();
  });
}
// Verify shop membership
async function requireShopRole(req, res, next) {
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
        error: "You do not have access to this shop"
      });
    }

    req.shopRole = result.rows[0].role;
    next();

  } catch (error) {
    console.error("Shop authorization failed");

    res.status(500).json({
      error: "Authorization failed"
    });
  }
  }

// One-time shop owner setup
app.post("/api/auth/setup-owner", async (req, res) => {
  const client = await pool.connect();

  try {
    const { email, password, setupSecret } = req.body;

    if (
      !email ||
      !password ||
      password.length < 12 ||
      !setupSecret
    ) {
      return res.status(400).json({
        error: "Valid email, password and setup secret required"
      });
    }

    if (!process.env.OWNER_SETUP_SECRET) {
      return res.status(500).json({
        error: "Owner setup is not configured"
      });
    }

    if (setupSecret !== process.env.OWNER_SETUP_SECRET) {
      return res.status(403).json({
        error: "Invalid setup secret"
      });
    }

    await client.query("BEGIN");

    // Lock shop row so simultaneous setup requests cannot both succeed
    const shop = await client.query(
      `SELECT id FROM shops
       WHERE id = $1
       FOR UPDATE`,
      ["fe94ff4e-e3a8-4fb4-88a1-3a1f0eeef824"]
    );

    if (shop.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Shop not found"
      });
    }

    const existingOwner = await client.query(
      `SELECT id FROM shop_users
       WHERE shop_id = $1 AND role = 'owner'`,
      [shop.rows[0].id]
    );

    if (existingOwner.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Owner setup has already been completed"
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

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
      [shop.rows[0].id, user.rows[0].id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Shop owner created successfully",
      user: user.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Owner setup failed");

    res.status(500).json({
      error: "Owner setup failed"
    });

  } finally {
    client.release();
  }
});

// Register user
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password || password.length < 12) {
      return res.status(400).json({
        error: "Valid email and password of at least 12 characters required"
      });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        error: "Server configuration error"
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "Email already registered"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [normalizedEmail, passwordHash]
    );

    res.status(201).json({
      message: "User registered successfully",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Registration failed");

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

// Login user
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password required"
      });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });

  } catch (error) {
    console.error("Login failed");

    res.status(500).json({
      error: "Login failed"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
      
