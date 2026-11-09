// recommendations-node: suggests other products for a product page.
//
// There is no OpenTelemetry code here. The Dash0 operator injects its Node.js distribution through
// NODE_OPTIONS (--require), which instruments express, mysql2 and pino, and sets the OTLP endpoint.
// CommonJS on purpose: --require hooks patch require()d modules, not ES module imports.
const express = require("express");
const mysql = require("mysql2/promise");
const pino = require("pino");

const log = pino({
  base: { service: "recommendations-node" },
  messageKey: "message",
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  // Level names the shared log transform recognises: INFO, WARN, ERROR.
  formatters: { level: (label) => ({ level: label === "warn" ? "WARN" : label.toUpperCase() }) },
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
  connectTimeout: 3000,
});

const app = express();

app.get("/recommendations", async (req, res) => {
  const product = Number.parseInt(req.query.product, 10);
  const limit = Math.min(Number.parseInt(req.query.limit ?? "3", 10) || 3, 6);
  if (!Number.isInteger(product)) {
    log.warn({ query: req.query }, "invalid product parameter");
    return res.status(400).json({ error: "product must be an integer" });
  }
  try {
    const [rows] = await pool.query(
      "SELECT id, name, price_cents FROM products WHERE id <> ? AND stock > 0 ORDER BY RAND() LIMIT ?",
      [product, limit],
    );
    log.info({ "product.id": product, "recommendations.count": rows.length }, "recommended products");
    res.json({ product, recommendations: rows });
  } catch (error) {
    log.error({ err: error, "product.id": product }, "recommendation query failed");
    res.status(500).json({ error: "recommendations unavailable" });
  }
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = app.listen(port, () => log.info({ port }, "listening"));

process.on("SIGTERM", () => server.close(() => pool.end().then(() => process.exit(0))));
