/**
 * runner.js — Function Runtime API Server
 *
 * This file lives inside every function's Docker container.
 * It is a generic runtime: it has NO hardcoded business logic.
 *
 * At cold start the container manager injects the user's handler.js
 * via `docker exec`. After injection, POST /run loads it dynamically
 * (clearing the require cache so re-injections are always picked up).
 *
 * Interface:
 *   GET  /health  → { status: "ok" }
 *   POST /run     → calls handler(input) and returns structured JSON
 *
 * handler.js contract:
 *   module.exports = async (input) => { ... return result; }
 */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = 4000;
const HANDLER_PATH = process.env.HANDLER_PATH || path.resolve(__dirname, "handler.js");

// ─────────────────────────────────────────────
// HEALTH CHECK
// Container Manager polls this until it gets 200,
// then injects handler.js and starts sending /run requests.
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ─────────────────────────────────────────────
// FUNCTION EXECUTION
// ─────────────────────────────────────────────
app.post("/run", async (req, res) => {
  const startTime = Date.now();

  try {
    const input = req.body;
    console.log("Executing with input:", JSON.stringify(input));

    // Always clear the module cache so that re-injected handlers
    // (from a re-registered function) are loaded fresh, not from cache.
    delete require.cache[HANDLER_PATH];
    const handler = require(HANDLER_PATH);

    if (typeof handler !== "function") {
      throw new Error(
        "handler.js must export a function via module.exports. " +
        `Got: ${typeof handler}`
      );
    }

    const result = await handler(input);
    const execTime = Date.now() - startTime;

    console.log("Result:", result, "| Time:", execTime + "ms");

    res.json({
      success: true,
      result,
      error: null,
      executionTime: execTime + "ms",
    });

  } catch (err) {
    const execTime = Date.now() - startTime;
    console.error("Execution error:", err.message);

    res.json({
      success: false,
      result: null,
      error: err.message,
      executionTime: execTime + "ms",
    });
  }
});

// ─────────────────────────────────────────────
// START RUNNER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🟢 Runner started on port ${PORT}`);
});