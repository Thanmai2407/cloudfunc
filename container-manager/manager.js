const express = require("express");
const axios = require("axios");
const Docker = require("dockerode");

const app = express();
const docker = new Docker();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:8080";
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || "5000");
const MAX_WARM_CONTAINERS = parseInt(process.env.MAX_WARM_CONTAINERS || "5");
const RUNNER_HOST = process.env.RUNNER_HOST || "localhost";

function getRunnerURL(hostPort, path = "") {
  return `http://${RUNNER_HOST}:${hostPort}${path}`;
}

// ─────────────────────────────────────────────
// WARM CONTAINER POOL
// poolKey (name:versionId) → { containerId, hostPort, lastUsed, handlerHash, inFlightCount, stats }
// ─────────────────────────────────────────────
const containerPool = new Map();

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function clearEvictionTimer(entry) {
  if (entry?.evictionTimer) {
    clearTimeout(entry.evictionTimer);
    entry.evictionTimer = null;
  }
}

async function evictContainer(poolKey, entry, reason) {
  clearEvictionTimer(entry);
  if (containerPool.get(poolKey) === entry) {
    containerPool.delete(poolKey);
  }

  try {
    const container = docker.getContainer(entry.containerId);
    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
    console.log(`Evicted container for "${poolKey}" (${reason})`);
  } catch (err) {
    console.error(`Failed to evict container for "${poolKey}":`, err.message);
  }
}

function scheduleEviction(poolKey, entry) {
  clearEvictionTimer(entry);

  if (entry.inFlightCount > 0) return;

  const ttl = entry.stats.ttlMs || 300000;
  entry.evictionTimer = setTimeout(async () => {
    const current = containerPool.get(poolKey);
    if (!current || current !== entry) return;

    if (current.inFlightCount > 0) {
      scheduleEviction(poolKey, current);
      return;
    }

    const idleFor = Date.now() - current.lastUsed;
    if (idleFor < ttl) {
      scheduleEviction(poolKey, current);
      return;
    }

    await evictContainer(poolKey, current, `idle TTL ${Math.round(ttl)}ms`);
  }, ttl);

  if (entry.evictionTimer.unref) entry.evictionTimer.unref();
}

// ─────────────────────────────────────────────
// HEALTH & READINESS ENDPOINTS
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/ready", async (req, res) => {
  try {
    await docker.ping();
    res.status(200).json({ status: "ok", docker: "connected" });
  } catch (err) {
    console.error("Docker ping failed:", err.message);
    res.status(503).json({ status: "error", error: "Docker unreachable" });
  }
});

// ─────────────────────────────────────────────
// INJECT HANDLER: write handler.js into /tmp/handler.js in container
// ─────────────────────────────────────────────
async function injectHandler(containerId, handlerCode) {
  const container = docker.getContainer(containerId);

  const escaped = handlerCode
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  const exec = await container.exec({
    Cmd: ["node", "-e", `require('fs').writeFileSync('/tmp/handler.js', \`${escaped}\`)`],
    AttachStdout: true,
    AttachStderr: true,
  });

  await new Promise((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err) return reject(err);
      stream.resume();
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  });

  console.log(`Handler injected into container ${containerId.slice(0, 12)} at /tmp/handler.js`);
}

// ─────────────────────────────────────────────
// GET OR CREATE CONTAINER (LRU & VERSION-AWARE)
// ─────────────────────────────────────────────
async function getOrCreateContainer(functionName, versionId, image, handlerCode) {
  const poolKey = `${functionName}:${versionId || "latest"}`;
  const newHash = hashCode(handlerCode);
  let cached = containerPool.get(poolKey);

  if (cached) {
    try {
      const container = docker.getContainer(cached.containerId);
      const state = await container.inspect();

      if (state.State.Running) {
        console.log(`Reusing warm container for function: ${poolKey}`);
        clearEvictionTimer(cached);
        cached.lastUsed = Date.now();
        cached.stats.warmHits++;
        return cached;
      } else {
        console.log(`Warm container for "${poolKey}" is stopped — removing from pool`);
        clearEvictionTimer(cached);
        await container.remove({ force: true }).catch(() => {});
        containerPool.delete(poolKey);
      }
    } catch {
      clearEvictionTimer(cached);
      containerPool.delete(poolKey);
    }
  }

  // ── LRU Cache Eviction Policy ──
  if (containerPool.size >= MAX_WARM_CONTAINERS) {
    const candidates = [];
    for (const [key, entry] of containerPool.entries()) {
      if (entry.inFlightCount === 0) {
        candidates.push({ key, entry });
      }
    }

    if (candidates.length > 0) {
      // Evict oldest (least recently used) first
      candidates.sort((a, b) => a.entry.lastUsed - b.entry.lastUsed);
      const lru = candidates[0];

      console.log(`LRU Eviction: Cache capacity reached (${containerPool.size}/${MAX_WARM_CONTAINERS}). Evicting idle container for ${lru.key}`);
      await evictContainer(lru.key, lru.entry, "LRU capacity pressure");
    } else {
      console.warn(`LRU Cache is full, but all ${containerPool.size} warm containers have in-flight executions. Skipping eviction.`);
    }
  }

  // ── Cold start ──
  console.log(`Cold start for function version: "${poolKey}" using image: ${image}`);

  const container = await docker.createContainer({
    Image: image,
    ExposedPorts: { "4000/tcp": {} },
    HostConfig: {
      PortBindings: {
        "4000/tcp": [{ HostPort: "0" }]
      },
      Memory: 128 * 1024 * 1024, // 128 MB limit
      NanoCpus: 500000000,       // 0.5 CPU limit
      Privileged: false,
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=65536k"
      }
    }
  });

  await container.start();

  const info = await container.inspect();
  const hostPort = info.NetworkSettings.Ports["4000/tcp"][0].HostPort;
  const runnerURL = getRunnerURL(hostPort);

  // Poll /health until the runner is ready
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      await axios.get(`${runnerURL}/health`, { timeout: 300 });
      healthy = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!healthy) {
    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
    throw new Error(`Runner container for "${poolKey}" failed health check`);
  }

  // Inject the user's handler code into the /tmp/ directory
  await injectHandler(container.id, handlerCode);

  const entry = {
    containerId: container.id,
    hostPort,
    lastUsed: Date.now(),
    handlerHash: newHash,
    inFlightCount: 0,
    stats: {
      invocationCount: 0,
      lastInvokeAt: 0,
      avgInterArrivalMs: 0,
      coldStarts: 1,
      warmHits: 0,
      ttlMs: 300000 // default 5 minutes
    },
    evictionTimer: null
  };

  containerPool.set(poolKey, entry);
  console.log(`Container ${container.id.slice(0, 12)} ready on port ${hostPort} for "${poolKey}"`);
  return entry;
}

// ─────────────────────────────────────────────
// POST /execute
// ─────────────────────────────────────────────
app.post("/execute", async (req, res) => {
  const { functionName, versionId, payload, handlerCode } = req.body;

  if (!functionName) {
    return res.status(400).json({ error: "functionName is required" });
  }
  if (!handlerCode) {
    return res.status(400).json({ error: "handlerCode is required — register the function with handler_code first" });
  }

  let cached = null;
  const poolKey = `${functionName}:${versionId || "latest"}`;

  try {
    const registryRes = await axios.get(`${REGISTRY_URL}/function/${functionName}`);
    const { image } = registryRes.data;

    cached = await getOrCreateContainer(functionName, versionId, image, handlerCode);
    const runnerURL = getRunnerURL(cached.hostPort, "/run");

    // 1. Update telemetry metrics and increment inFlightCount
    const now = Date.now();
    clearEvictionTimer(cached);
    cached.inFlightCount++;
    cached.stats.invocationCount++;

    if (cached.stats.lastInvokeAt > 0) {
      const gap = now - cached.stats.lastInvokeAt;
      if (cached.stats.avgInterArrivalMs === 0) {
        cached.stats.avgInterArrivalMs = gap;
      } else {
        // Exponential moving average (EMA)
        cached.stats.avgInterArrivalMs = (cached.stats.avgInterArrivalMs * 0.7) + (gap * 0.3);
      }

      // Compute Adaptive TTL: 2x the average gap, clamped between 30s and 10m
      let computedTtl = cached.stats.avgInterArrivalMs * 2;
      computedTtl = Math.max(30000, Math.min(600000, computedTtl));

      // Fine-tune: if cold starts exceed hits, increase TTL; if hits exceed cold starts by a lot, reduce it
      if (cached.stats.coldStarts > cached.stats.warmHits && cached.stats.coldStarts > 2) {
        computedTtl = Math.min(600000, computedTtl * 1.5);
      } else if (cached.stats.warmHits > cached.stats.coldStarts * 3) {
        computedTtl = Math.max(30000, computedTtl * 0.8);
      }

      cached.stats.ttlMs = computedTtl;
      console.log(`Adaptive TTL for "${poolKey}" is ${Math.round(cached.stats.ttlMs)}ms (avg gap: ${Math.round(cached.stats.avgInterArrivalMs)}ms)`);
    }
    cached.stats.lastInvokeAt = now;

    console.log(`Executing "${poolKey}" (in-flight: ${cached.inFlightCount}) → ${runnerURL}`);

    const response = await axios.post(runnerURL, payload || {}, {
      timeout: EXECUTION_TIMEOUT,
    });

    res.json(response.data);

  } catch (err) {
    console.error(`Execution error for "${poolKey}":`, err.message);
    res.status(500).json({
      success: false,
      result: null,
      error: err.message,
    });
  } finally {
    if (cached) {
      cached.inFlightCount = Math.max(0, cached.inFlightCount - 1);
      cached.lastUsed = Date.now();
      scheduleEviction(poolKey, cached);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Container Manager running on port ${PORT}`);
});
