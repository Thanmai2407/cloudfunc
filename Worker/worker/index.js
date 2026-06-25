const amqp = require("amqplib");
const axios = require("axios");
const express = require("express");

require("dotenv").config();

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:8080";
const CONTAINER_URL = process.env.CONTAINER_URL || "http://localhost:3000";
const WORKER_PORT = process.env.WORKER_PORT || 5002;

const QUEUE_NAME = "executions";
const DLQ_NAME = "executions_dlq";
const WORKER_COUNT = 3;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let rabbitConnected = false;

// ─────────────────────────────────────────────
// HEALTH CHECK SERVER FOR WORKER
// ─────────────────────────────────────────────
const app = express();
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});
app.get("/ready", (req, res) => {
  if (rabbitConnected) {
    res.status(200).json({ status: "ok", rabbitmq: "connected" });
  } else {
    res.status(503).json({ status: "error", error: "RabbitMQ not connected" });
  }
});
app.listen(WORKER_PORT, () => {
  console.log(`Worker Health API running on port ${WORKER_PORT}`);
});

// ─────────────────────────────────────────────
// JOB PROCESSING
// ─────────────────────────────────────────────
async function processJob(job) {
  const { jobId, functionName, payload } = job;

  // 1. Update job → running (triggers attempt_count increment & started_at in registry)
  await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
    status: "running",
  });

  // 2. Fetch the pinned handler_code and version for this job dynamically from Registry
  const jobDetailsRes = await axios.get(`${REGISTRY_URL}/jobs/${jobId}`);
  const { handler_code, version } = jobDetailsRes.data;

  if (!handler_code) {
    throw new Error(`Handler code not found for job ${jobId}`);
  }

  // 3. Call Container Manager — pass handler_code and version info
  console.log(`Calling Container Manager for job ${jobId} (fn: ${functionName}, ver: ${version})`);
  const response = await axios.post(`${CONTAINER_URL}/execute`, {
    jobId,
    functionName,
    payload,
    handlerCode: handler_code,
  });

  const result = response.data;

  // 4. Treat execution success: false as job execution failure (to trigger worker retry)
  if (result && result.success === false) {
    throw new Error(result.error || "Handler execution failed");
  }

  // 5. Update job → completed (save ONLY the actual output result of the handler)
  await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
    status: "completed",
    result: result.result,
  });
}

// ─────────────────────────────────────────────
// RETRY LOGIC & DEAD-LETTER QUEUE
// ─────────────────────────────────────────────
async function executeWithRetry(job, channel) {
  const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await processJob(job);
      console.log(`Job ${job.jobId} completed successfully`);
      return;
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message;
      console.error(`Job ${job.jobId} failed (attempt ${attempt}/${MAX_RETRIES}):`, errMsg);

      if (attempt === MAX_RETRIES) {
        // Mark job as failed permanently in the DB
        await axios.patch(`${REGISTRY_URL}/jobs/${job.jobId}`, {
          status: "failed",
          error: `Execution failed after ${MAX_RETRIES} attempts. Final error: ${errMsg}`,
        });

        // Publish to RabbitMQ Dead-Letter Queue (DLQ)
        try {
          await channel.assertQueue(DLQ_NAME, { durable: true });
          const dlqPayload = {
            jobId: job.jobId,
            functionName: job.functionName,
            payload: job.payload,
            error: errMsg,
            failedAt: new Date().toISOString(),
          };
          channel.sendToQueue(DLQ_NAME, Buffer.from(JSON.stringify(dlqPayload)), { persistent: true });
          console.log(`Job ${job.jobId} routed to DLQ (${DLQ_NAME})`);
        } catch (dlqErr) {
          console.error("Failed to write to Dead-Letter Queue:", dlqErr.message);
        }
        return;
      }

      // Exponential backoff wait (1s, 2s, 4s...)
      await sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }
}

// ─────────────────────────────────────────────
// WORKER CONSUMER
// ─────────────────────────────────────────────
async function startWorker(workerId, channel) {
  await channel.consume(
    QUEUE_NAME,
    async (msg) => {
      if (!msg) return;
      const job = JSON.parse(msg.content.toString());
      console.log(`Worker ${workerId} processing job ${job.jobId}`);
      try {
        await executeWithRetry(job, channel);
        channel.ack(msg);
      } catch (err) {
        console.error(`Worker ${workerId} unexpected error:`, err.message);
        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}

// ─────────────────────────────────────────────
// START WORKER SERVICE
// ─────────────────────────────────────────────
async function start() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    await channel.assertQueue(QUEUE_NAME, { durable: true });
    channel.prefetch(1);

    rabbitConnected = true;
    console.log("Worker connected to RabbitMQ");

    connection.on("error", (err) => {
      console.error("RabbitMQ Connection error:", err.message);
      rabbitConnected = false;
    });

    connection.on("close", () => {
      console.warn("RabbitMQ Connection closed");
      rabbitConnected = false;
    });

    for (let i = 1; i <= WORKER_COUNT; i++) {
      startWorker(i, channel);
    }
  } catch (err) {
    console.error("Failed to connect to RabbitMQ, retrying in 5s...", err.message);
    rabbitConnected = false;
    setTimeout(start, 5000);
  }
}

start();
