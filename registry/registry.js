const express = require("express");
const pool = require("./db");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ─────────────────────────────────────────────
// HELPER: Basic JS syntax validation
// ─────────────────────────────────────────────
function validateHandlerCode(code) {
  try {
    new Function("module", "exports", "require", code);
    return null;
  } catch (err) {
    return err.message;
  }
}

// ─────────────────────────────────────────────
// HEALTH & READINESS ENDPOINTS
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ready", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", postgres: "connected" });
  } catch (err) {
    console.error("Readiness check failed:", err.message);
    res.status(503).json({ status: "error", error: "Database unreachable" });
  }
});

// ─────────────────────────────────────────────
// REGISTER FUNCTION (VERSIONED)
// ─────────────────────────────────────────────
app.post("/registerFunction", async (req, res) => {
  const { name, owner, handler_code, image } = req.body;
  const resolvedImage = image || "function-runner:latest";

  if (!name || !owner || !handler_code) {
    return res.status(400).json({
      error: "name, owner, and handler_code are required"
    });
  }

  const syntaxError = validateHandlerCode(handler_code);
  if (syntaxError) {
    return res.status(400).json({
      error: `handler_code syntax error: ${syntaxError}`
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Insert or update function metadata
    const funcResult = await client.query(
      `INSERT INTO functions (name, owner, image)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE
         SET owner = EXCLUDED.owner,
             image = EXCLUDED.image
       RETURNING name, owner, image, created_at`,
      [name, owner, resolvedImage]
    );

    // 2. Find latest version number
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0) as max_version
       FROM function_versions
       WHERE function_name = $1`,
      [name]
    );
    const nextVersion = versionResult.rows[0].max_version + 1;

    // 3. Create new version entry
    const newVersionResult = await client.query(
      `INSERT INTO function_versions (function_name, version, handler_code)
       VALUES ($1, $2, $3)
       RETURNING id, version, handler_code, created_at`,
      [name, nextVersion, handler_code]
    );

    await client.query("COMMIT");

    const func = funcResult.rows[0];
    const ver = newVersionResult.rows[0];

    res.status(201).json({
      name: func.name,
      owner: func.owner,
      image: func.image,
      version: ver.version,
      version_id: ver.id,
      created_at: func.created_at,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to register function:", err.message);
    res.status(500).json({ error: "Failed to register function" });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// LIST FUNCTIONS (FILTERED BY OWNER)
// ─────────────────────────────────────────────
app.get("/functions", async (req, res) => {
  const { owner } = req.query;

  try {
    let result;
    if (owner) {
      result = await pool.query(
        "SELECT name, owner, image, created_at FROM functions WHERE owner = $1 ORDER BY created_at DESC",
        [owner]
      );
    } else {
      result = await pool.query(
        "SELECT name, owner, image, created_at FROM functions ORDER BY created_at DESC"
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch functions:", err.message);
    res.status(500).json({ error: "Failed to fetch functions" });
  }
});

// ─────────────────────────────────────────────
// GET FUNCTION DETAILS (WITH LATEST VERSION CODE)
// ─────────────────────────────────────────────
app.get("/function/:name", async (req, res) => {
  const { name } = req.params;

  try {
    const result = await pool.query(
      `SELECT f.name, f.owner, f.image, f.created_at, fv.id as version_id, fv.version, fv.handler_code
       FROM functions f
       LEFT JOIN function_versions fv ON f.name = fv.function_name
       WHERE f.name = $1
       ORDER BY fv.version DESC
       LIMIT 1`,
      [name]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Function not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Database error during lookup:", err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// ─────────────────────────────────────────────
// CREATE JOB (QUEUED)
// ─────────────────────────────────────────────
app.post("/jobs", async (req, res) => {
  const { id, functionName } = req.body;

  if (!id || !functionName) {
    return res.status(400).json({ error: "id and functionName are required" });
  }

  try {
    const versionRes = await pool.query(
      `SELECT id FROM function_versions WHERE function_name = $1 ORDER BY version DESC LIMIT 1`,
      [functionName]
    );

    if (versionRes.rows.length === 0) {
      return res.status(404).json({ error: `No registered versions found for function '${functionName}'` });
    }

    const versionId = versionRes.rows[0].id;

    const result = await pool.query(
      `INSERT INTO jobs (id, function_name, function_version_id, status)
       VALUES ($1, $2, $3, 'queued')
       RETURNING *`,
      [id, functionName, versionId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Failed to create job:", err.message);
    res.status(500).json({ error: "Failed to create job" });
  }
});

// ─────────────────────────────────────────────
// PATCH JOB (STRICT STATE MACHINE TRANSITIONS)
// ─────────────────────────────────────────────
app.patch("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  const { status, result, error } = req.body;

  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  try {
    // Get current job state
    const currentRes = await pool.query(
      `SELECT status, attempt_count FROM jobs WHERE id = $1`,
      [id]
    );

    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const currentStatus = currentRes.rows[0].status;

    // Strict transitions verification
    const transitions = {
      queued: ["running", "cancelled"],
      running: ["running", "completed", "failed", "timed_out"],
      completed: [],
      failed: [],
      timed_out: [],
      cancelled: []
    };

    if (status !== currentStatus && !transitions[currentStatus]?.includes(status)) {
      return res.status(400).json({
        error: `Invalid transition: cannot move job from status '${currentStatus}' to '${status}'`
      });
    }

    let dbResult;
    if (status === "running") {
      dbResult = await pool.query(
        `UPDATE jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      );
    } else {
      // Transitioning to terminal state (completed, failed, timed_out, cancelled)
      const isError = ["failed", "timed_out"].includes(status);
      const isTerminal = ["completed", "failed", "timed_out", "cancelled"].includes(status);

      dbResult = await pool.query(
        `UPDATE jobs
         SET status = $1,
             result = $2,
             error = $3,
             finished_at = CASE WHEN $4 = true THEN NOW() ELSE finished_at END,
             duration_ms = CASE WHEN $4 = true AND started_at IS NOT NULL 
                                THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 
                                ELSE duration_ms END,
             failure_reason = CASE WHEN $5 = true THEN $3 ELSE failure_reason END,
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          status,
          result ? JSON.stringify(result) : null,
          error || null,
          isTerminal,
          isError,
          id
        ]
      );
    }

    res.json(dbResult.rows[0]);
  } catch (err) {
    console.error("Failed to update job status:", err.message);
    res.status(500).json({ error: "Failed to update job" });
  }
});

// ─────────────────────────────────────────────
// GET JOB DETAILS (WITH PINNED VERSION HANDLER)
// ─────────────────────────────────────────────
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT j.*, fv.handler_code, fv.version, f.owner
       FROM jobs j
       LEFT JOIN function_versions fv ON j.function_version_id = fv.id
       LEFT JOIN functions f ON j.function_name = f.name
       WHERE j.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to retrieve job details:", err.message);
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

// ─────────────────────────────────────────────
// STALE JOB REAPER (RUNS EVERY 30S)
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    // Reap jobs stuck in 'running' status for > 2 minutes
    const result = await pool.query(
      `UPDATE jobs
       SET status = 'failed',
           error = 'Reaped: worker execution timeout/heartbeat lost',
           failure_reason = 'Worker heartbeat timeout (job stuck in running state for >2m)',
           finished_at = NOW(),
           duration_ms = CASE WHEN started_at IS NOT NULL THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 ELSE 120000 END,
           updated_at = NOW()
       WHERE status = 'running' AND updated_at < NOW() - INTERVAL '2 minutes'
       RETURNING id`
    );

    if (result.rows.length > 0) {
      console.log(`Reaper: marked ${result.rows.length} stale jobs as failed:`, result.rows.map(r => r.id));
    }
  } catch (err) {
    console.error("Reaper failure:", err.message);
  }
}, 30000);

app.listen(PORT, () => {
  console.log(`Function Registry Service running on port ${PORT}`);
});
