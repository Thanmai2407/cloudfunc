const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "cloudfunc",
  port: parseInt(process.env.DB_PORT || "5433"),
});

// Initialize database tables on startup
async function initDb() {
  try {
    // 1. Create functions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS functions (
        name         VARCHAR(255) PRIMARY KEY,
        owner        VARCHAR(255) NOT NULL,
        image        VARCHAR(255) NOT NULL DEFAULT 'function-runner:latest',
        created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Create function_versions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS function_versions (
        id            SERIAL PRIMARY KEY,
        function_name VARCHAR(255) NOT NULL REFERENCES functions(name) ON DELETE CASCADE,
        version       INT NOT NULL,
        handler_code  TEXT NOT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(function_name, version)
      );
    `);

    // 3. Create jobs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id            VARCHAR(255) PRIMARY KEY,
        function_name VARCHAR(255) NOT NULL,
        status        VARCHAR(50)  NOT NULL,
        result        JSONB,
        error         TEXT,
        created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Alter jobs table to add audit and versioning columns if they don't exist
    await pool.query(`
      ALTER TABLE jobs
        ADD COLUMN IF NOT EXISTS function_version_id INT REFERENCES function_versions(id),
        ADD COLUMN IF NOT EXISTS input_payload JSONB,
        ADD COLUMN IF NOT EXISTS attempt_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS duration_ms INT,
        ADD COLUMN IF NOT EXISTS failure_reason TEXT;
    `);

    // 5. Store failed queue messages consumed from the DLQ for later search/debugging
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failed_jobs (
        id            SERIAL PRIMARY KEY,
        job_id        VARCHAR(255),
        function_name VARCHAR(255),
        payload       JSONB,
        error         TEXT,
        failed_at     TIMESTAMP,
        dlq_message   JSONB NOT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Database tables initialized successfully");
  } catch (err) {
    console.error("Database initialization failed:", err.message);
  }
}

initDb();

module.exports = pool;
