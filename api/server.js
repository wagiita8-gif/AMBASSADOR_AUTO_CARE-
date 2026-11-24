const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

// Keep browser access disabled until our frontend
// domain is configured on the hosting service.
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || false
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Basic server check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "Ambassadors Auto Care API"
  });
});

// Database connection check
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

    
