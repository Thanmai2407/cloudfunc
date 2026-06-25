const express = require("express");
const axios = require("axios");
const amqp = require("amqplib");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5001;

const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:8080";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const QUEUE_NAME = "executions";

app.use(cors());
app.use(express.json({ limit: "1mb" }));




// ─────────────────────────────────────────────
// AUTHENTICATION MIDDLEWARE
// Expects: Authorization: Bearer <username>-token
// ─────────────────────────────────────────────
function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Unauthorized: Missing Authorization header" });
  }

  const match = authHeader.match(/^Bearer\s+([a-zA-Z0-9_-]+)-token$/i);
  if (!match) {
    return res.status(401).json({ error: "Unauthorized: Invalid token format. Expected 'Bearer <username>-token'" });
  }

  req.owner = match[1];
  next();
}

let channel;
let connection;

// ─────────────────────────────────────────────
// CONNECT TO RABBITMQ
// ─────────────────────────────────────────────
async function connectRabbitMQ() {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue(QUEUE_NAME, { durable: true });
    console.log("Gateway connected to RabbitMQ");
  } catch (err) {
    console.error("RabbitMQ Connection Failed, retrying in 5s...", err.message);
    setTimeout(connectRabbitMQ, 5000);
  }
}

connectRabbitMQ();

// ─────────────────────────────────────────────
// HEALTH & READINESS ENDPOINTS
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ready", async (req, res) => {
  try {
    // 1. Check RabbitMQ connection
    if (!connection || !channel) {
      throw new Error("RabbitMQ connection or channel is not established");
    }

    // 2. Check Registry connection
    const registryRes = await axios.get(`${REGISTRY_URL}/health`, { timeout: 2000 });
    if (registryRes.status !== 200) {
      throw new Error("Registry returned non-200 on health check");
    }

    res.status(200).json({ status: "ok", rabbitmq: "connected", registry: "connected" });
  } catch (err) {
    console.error("Gateway readiness check failed:", err.message);
    res.status(503).json({ status: "error", error: err.message });
  }
});

// ─────────────────────────────────────────────
// PROXIED REGISTRATION ENDPOINT (AUTHENTICATED)
// ─────────────────────────────────────────────
app.post("/registerFunction", verifyAuth, async (req, res) => {
  const { name, handler_code, image } = req.body;

  try {
    // Forward to Registry injecting the authenticated owner
    const registryRes = await axios.post(`${REGISTRY_URL}/registerFunction`, {
      name,
      owner: req.owner,
      handler_code,
      image,
    });
    res.status(registryRes.status).json(registryRes.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: "Failed to forward registration" };
    res.status(status).json(data);
  }
});

// ─────────────────────────────────────────────
// PROXIED FUNCTIONS LIST ENDPOINT (OWNER ISOLATION)
// ─────────────────────────────────────────────
app.get("/functions", verifyAuth, async (req, res) => {
  try {
    // Only fetch functions belonging to the authenticated user
    const registryRes = await axios.get(`${REGISTRY_URL}/functions?owner=${req.owner}`);
    res.status(registryRes.status).json(registryRes.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: "Failed to fetch functions" };
    res.status(status).json(data);
  }
});

// ─────────────────────────────────────────────
// SECURED INVOCATION ENDPOINT
// ─────────────────────────────────────────────
app.post("/invoke", verifyAuth, async (req, res) => {
  const { functionName, input } = req.body;

  if (!functionName) {
    return res.status(400).json({ error: "functionName is required" });
  }

  try {
    // 1. Fetch function details from Registry
    const registryRes = await axios.get(`${REGISTRY_URL}/function/${functionName}`);
    const { owner } = registryRes.data;

    // 2. Prevent users from executing other users' functions
    if (owner !== req.owner) {
      return res.status(403).json({ error: "Forbidden: You do not own this function" });
    }

    // 3. Generate unique jobId
    const jobId = uuidv4();

    // 4. Create job record in DB
    await axios.post(`${REGISTRY_URL}/jobs`, {
      id: jobId,
      functionName,
      input: input || {},
    });

    // 5. Publish minimal job payload to RabbitMQ. Registry stores the input
    // payload and pinned version, so the queue only carries a reference.
    const jobPayload = {
      jobId,
      functionName,
    };

    if (!channel) {
      throw new Error("Message queue channel is not ready");
    }

    channel.sendToQueue(
      QUEUE_NAME,
      Buffer.from(JSON.stringify(jobPayload)),
      { persistent: true }
    );

    console.log(`Job ${jobId} queued for function "${functionName}" by user "${req.owner}"`);

    // 6. Return 202 Accepted
    res.status(202).json({ jobId, status: "queued" });

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `Function '${functionName}' not registered` });
    }
    console.error("Invocation enqueue failed:", err.message);
    res.status(500).json({ error: "Failed to submit execution job" });
  }
});

// ─────────────────────────────────────────────
// SECURED JOB STATUS ENDPOINT
// ─────────────────────────────────────────────
app.get("/jobs/:id", verifyAuth, async (req, res) => {
  const { id } = req.params;

  try {
    // Query job details from registry
    const registryRes = await axios.get(`${REGISTRY_URL}/jobs/${id}`);
    const job = registryRes.data;

    // Prevent users from reading other users' jobs
    if (job.owner !== req.owner) {
      return res.status(403).json({ error: "Forbidden: You do not own this job" });
    }

    // Clean up internal details (like handler_code) before responding to client
    const clientResponse = { ...job };
    delete clientResponse.handler_code;
    delete clientResponse.input_payload;

    res.json(clientResponse);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "Job not found" });
    }
    console.error("Failed to query job status:", err.message);
    res.status(500).json({ error: "Failed to query job status" });
  }
});

app.listen(PORT, () => {
  console.log(`Gateway Service running on port ${PORT}`);
});
