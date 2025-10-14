const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Uncomment if you use SSL in prod:
  // ssl: { rejectUnauthorized: false }
});

module.exports = pool;
