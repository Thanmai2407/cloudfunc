const amqp = require("amqplib");
const axios = require("axios");
const express = require("express");

require("dotenv").config();

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:8080";
const DLQ_PORT = process.env.DLQ_PORT || 5003;

const DLQ_NAME = "executions_dlq";

let rabbitConnected = false;

// ─────────────────────────────────────────────
// HEALTH CHECK SERVER FOR DLQ CONSUMER
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
app.listen(DLQ_PORT, () => {
  console.log(`DLQ Consumer Health API running on port ${DLQ_PORT}`);
});

// ─────────────────────────────────────────────
// PROCESS FAILED JOB FROM DLQ
// ─────────────────────────────────────────────
async function handleFailedJob(dlqMessage) {
  const { jobId, functionName, payload, error, failedAt } = dlqMessage;

  console.log(`DLQ Consumer: Indexing failed job ${jobId} (fn: ${functionName})`);

  try {
    // Send to Registry to store in the failed_jobs search index table
    await axios.post(`${REGISTRY_URL}/failed-jobs`, {
      jobId,
      functionName,
      payload,
      error,
      failedAt
    });
    console.log(`DLQ Consumer: Successfully logged failed job ${jobId} to Registry database`);
  } catch (err) {
    console.error(`DLQ Consumer: Failed to log job ${jobId} to Registry:`, err.message);
    throw err; // Re-throw to prevent ack, triggering RabbitMQ requeue
  }
}

// ─────────────────────────────────────────────
// START CONSUMING
// ─────────────────────────────────────────────
async function start() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    await channel.assertQueue(DLQ_NAME, { durable: true });
    channel.prefetch(1);

    rabbitConnected = true;
    console.log("DLQ Consumer connected to RabbitMQ");

    connection.on("error", (err) => {
      console.error("RabbitMQ Connection error (DLQ):", err.message);
      rabbitConnected = false;
    });

    connection.on("close", () => {
      console.warn("RabbitMQ Connection closed (DLQ)");
      rabbitConnected = false;
    });

    await channel.consume(
      DLQ_NAME,
      async (msg) => {
        if (!msg) return;
        try {
          const dlqMessage = JSON.parse(msg.content.toString());
          await handleFailedJob(dlqMessage);
          channel.ack(msg);
        } catch (err) {
          console.error("Error processing DLQ message:", err.message);
          // Re-queue the message after a delay to prevent spinning in a tight loop on persistent failures
          setTimeout(() => {
            channel.nack(msg, false, true);
          }, 5000);
        }
      },
      { noAck: false }
    );
  } catch (err) {
    console.error("DLQ Consumer failed to connect to RabbitMQ, retrying in 5s...", err.message);
    rabbitConnected = false;
    setTimeout(start, 5000);
  }
}

start();
