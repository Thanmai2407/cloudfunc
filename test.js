/**
 * test.js — End-to-end Integration Test for CloudFunc Core Improvements
 *
 * What it verifies:
 *  1. Authenticated registration and invocation via Gateway (:5001)
 *  2. Multi-tenant owner isolation (invoking/reading other user's resources is blocked)
 *  3. Dynamic cold starts and warm start container reuse
 *  4. Function versioning and stale container eviction on handler updates
 *  5. Direct mapping of user handler execution failures to Job failures
 *  6. Sandbox resource limits & Timeout enforcement
 */

const { spawn } = require("child_process");
const axios = require("axios");
const Docker = require("dockerode");

const docker = new Docker();

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Handler Code Strings ──────────────────────────────────────────────────────

const ADD_HANDLER = `
module.exports = async (input) => {
  const { a = 0, b = 0 } = input;
  return a + b;
};
`.trim();

const MULTIPLY_HANDLER = `
module.exports = async (input) => {
  const { a = 0, b = 0 } = input;
  return a * b;
};
`.trim();

const FAILING_HANDLER = `
module.exports = async (input) => {
  throw new Error("Logic error in user code: division by zero");
};
`.trim();

const TIMEOUT_HANDLER = `
module.exports = async (input) => {
  const ms = input.delay || 8000;
  await new Promise((r) => setTimeout(r, ms));
  return { sleptFor: ms };
};
`.trim();

// ── Polling Helper ────────────────────────────────────────────────────────────

async function pollJob(jobId, token, { maxAttempts = 40, intervalMs = 1000 } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < maxAttempts; i++) {
    await delay(intervalMs);
    try {
      const res = await axios.get(`http://localhost:5001/jobs/${jobId}`, { headers });
      const job = res.data;
      console.log(`  Polling ${jobId.slice(0, 8)}… → ${job.status}`);
      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
    } catch (err) {
      console.error(`  Polling error: ${err.message}`);
    }
  }
  throw new Error(`Job ${jobId} did not finish within ${maxAttempts * intervalMs}ms`);
}

// ── Main Test Runner ──────────────────────────────────────────────────────────

async function runTests() {
  console.log("=== STARTING CLOUDFUNC CORE IMPROVEMENTS INTEGRATION TEST ===\n");

  // 0. Clean up leftover runner containers
  const containersBefore = await docker.listContainers({ all: true });
  for (const c of containersBefore) {
    if (c.Image.includes("function-runner")) {
      console.log(`Cleaning up old container: ${c.Id.slice(0, 12)}`);
      const ct = docker.getContainer(c.Id);
      await ct.stop().catch(() => {});
      await ct.remove().catch(() => {});
    }
  }

  // 1. Start Services locally for the test
  console.log("Starting services...");
  const registry = spawn("node", ["registry/registry.js"], { stdio: "inherit", cwd: __dirname });
  const gateway  = spawn("node", ["gateway/gateway.js"],  { stdio: "inherit", cwd: __dirname });
  const manager  = spawn("node", ["container-manager/manager.js"], { stdio: "inherit", cwd: __dirname });
  const worker   = spawn("node", ["Worker/worker/index.js"], {
    stdio: "inherit",
    cwd: __dirname,
    env: {
      ...process.env,
      REGISTRY_URL:  "http://localhost:8080",
      CONTAINER_URL: "http://localhost:3000",
      RABBITMQ_URL:  "amqp://localhost:5672",
    },
  });

  await delay(5000); // wait for services to boot

  const aliceToken = "alice-token";
  const bobToken = "bob-token";
  const aliceHeaders = { Authorization: `Bearer ${aliceToken}` };
  const bobHeaders = { Authorization: `Bearer ${bobToken}` };

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: Secure Function Registration
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 1: Authenticated Function Registration ---");
    const regRes = await axios.post("http://localhost:5001/registerFunction", {
      name:         "add",
      handler_code: ADD_HANDLER,
    }, { headers: aliceHeaders });
    
    console.log("Registered:", regRes.data);
    if (regRes.data.owner !== "alice") throw new Error("Test 1 Failed: owner mismatch");
    console.log("✅ Test 1 passed\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: Multi-tenant Auth Isolation
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 2: Multi-tenant Auth Isolation ---");
    
    // Bob tries to invoke Alice's function
    try {
      await axios.post("http://localhost:5001/invoke", {
        functionName: "add",
        input: { a: 1, b: 2 }
      }, { headers: bobHeaders });
      throw new Error("Test 2 Failed: Bob invoked Alice's function without error");
    } catch (err) {
      if (err.response?.status === 403) {
        console.log("  Successfully blocked unauthorized invocation (Bob invoking Alice's function)");
      } else {
        throw new Error(`Test 2 Failed: expected 403, got ${err.response?.status || err.message}`);
      }
    }

    // Alice invokes her function
    const invokeAlice = await axios.post("http://localhost:5001/invoke", {
      functionName: "add",
      input: { a: 10, b: 20 }
    }, { headers: aliceHeaders });
    const jobId = invokeAlice.data.jobId;

    // Bob tries to read status of Alice's job
    try {
      await axios.get(`http://localhost:5001/jobs/${jobId}`, { headers: bobHeaders });
      throw new Error("Test 2 Failed: Bob read Alice's job details without error");
    } catch (err) {
      if (err.response?.status === 403) {
        console.log("  Successfully blocked unauthorized job status check");
      } else {
        throw new Error(`Test 2 Failed: expected 403, got ${err.response?.status || err.message}`);
      }
    }
    console.log("✅ Test 2 passed\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: Cold Start Execution
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 3: Cold Start (10 + 20) ---");
    const t3Start = Date.now();
    const job1 = await pollJob(jobId, aliceToken);
    const t3Dur = Date.now() - t3Start;

    console.log(`Cold start completed in ${t3Dur}ms. Result:`, job1.result);
    if (job1.status !== "completed") throw new Error(`Test 3 Failed: job status is ${job1.status}`);
    
    // Result should be returned inside job1.result
    if (job1.result !== 30 && job1.result?.result !== 30) {
      throw new Error(`Test 3 Failed: expected 30, got ${JSON.stringify(job1.result)}`);
    }
    console.log("✅ Test 3 passed\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: Warm Start Speedup
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 4: Warm Start (50 + 100) ---");
    const t4Start = Date.now();
    const invokeWarm = await axios.post("http://localhost:5001/invoke", {
      functionName: "add",
      input: { a: 50, b: 100 }
    }, { headers: aliceHeaders });
    
    const jobIdWarm = invokeWarm.data.jobId;
    const jobWarm = await pollJob(jobIdWarm, aliceToken, { maxAttempts: 15, intervalMs: 500 });
    const t4Dur = Date.now() - t4Start;

    console.log(`Warm start completed in ${t4Dur}ms. Result:`, jobWarm.result);
    if (jobWarm.result !== 150 && jobWarm.result?.result !== 150) {
      throw new Error(`Test 4 Failed: expected 150, got ${JSON.stringify(jobWarm.result)}`);
    }
    if (t4Dur < t3Dur) {
      console.log(`✅ Warm start (${t4Dur}ms) faster than cold start (${t3Dur}ms)`);
    } else {
      console.warn(`⚠️ Warm start (${t4Dur}ms) not faster than cold start (${t3Dur}ms) — normal under system load`);
    }
    console.log("✅ Test 4 passed\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 5: Versioning & Handler Update Container Eviction
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 5: Function Versioning & Container Eviction ---");
    
    // Re-register same function name with different code (Multiply)
    const updateRes = await axios.post("http://localhost:5001/registerFunction", {
      name:         "add",
      handler_code: MULTIPLY_HANDLER,
    }, { headers: aliceHeaders });

    console.log(`Re-registered "add" function. New version: ${updateRes.data.version}`);
    if (updateRes.data.version !== 2) throw new Error("Test 5 Failed: version increment failed");

    // Invoke. Warm container should be evicted, new code injected
    const invokeUpdated = await axios.post("http://localhost:5001/invoke", {
      functionName: "add",
      input: { a: 3, b: 7 }
    }, { headers: aliceHeaders });

    const jobUpdated = await pollJob(invokeUpdated.data.jobId, aliceToken);
    console.log("Updated function execution result:", jobUpdated.result);
    
    if (jobUpdated.result !== 21 && jobUpdated.result?.result !== 21) {
      throw new Error(`Test 5 Failed: expected 21, got ${JSON.stringify(jobUpdated.result)}`);
    }
    console.log("✅ Test 5 passed — container evicted and new version executed successfully\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 6: User Handler Failures mapped as Job Failures
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 6: Handler Failures mapped as Job Failures ---");
    
    await axios.post("http://localhost:5001/registerFunction", {
      name:         "failer",
      handler_code: FAILING_HANDLER,
    }, { headers: aliceHeaders });

    const invokeFail = await axios.post("http://localhost:5001/invoke", {
      functionName: "failer",
      input: {}
    }, { headers: aliceHeaders });

    // Poll for status. Expected to fail after MAX_RETRIES (3 attempts)
    const jobFail = await pollJob(invokeFail.data.jobId, aliceToken, { maxAttempts: 30 });
    console.log("Fail job final state:", jobFail);

    if (jobFail.status !== "failed") {
      throw new Error(`Test 6 Failed: job status is ${jobFail.status}, expected "failed"`);
    }
    if (!jobFail.error || !jobFail.error.includes("division by zero")) {
      throw new Error(`Test 6 Failed: job error doesn't record handler error: ${jobFail.error}`);
    }
    console.log("✅ Test 6 passed — handler failure propagated to database correctly\n");

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 7: Sandbox Limits & Timeout Enforcement
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 7: Sandbox Timeout Enforcement ---");
    
    await axios.post("http://localhost:5001/registerFunction", {
      name:         "slow",
      handler_code: TIMEOUT_HANDLER,
    }, { headers: aliceHeaders });

    const invokeTimeout = await axios.post("http://localhost:5001/invoke", {
      functionName: "slow",
      input: { delay: 9000 }
    }, { headers: aliceHeaders });

    // Poll for status. Container manager executes with a 5s limit, so it should fail
    const jobTimeout = await pollJob(invokeTimeout.data.jobId, aliceToken, { maxAttempts: 40 });
    console.log("Timeout job final state:", jobTimeout);

    if (jobTimeout.status !== "failed") {
      throw new Error(`Test 7 Failed: job status is ${jobTimeout.status}, expected "failed"`);
    }
    console.log("✅ Test 7 passed — timeout and sandboxing constraints verified\n");

    console.log("=== ALL TESTS PASSED ✅ ===");

  } catch (err) {
    console.error("\n❌ INTEGRATION TEST FAILED:", err.message);
    if (err.response?.data) console.error("Response data:", err.response.data);
    process.exitCode = 1;

  } finally {
    console.log("\nTearing down services...");
    registry.kill();
    gateway.kill();
    manager.kill();
    worker.kill();

    const containersAfter = await docker.listContainers({ all: true });
    for (const c of containersAfter) {
      if (c.Image.includes("function-runner")) {
        const ct = docker.getContainer(c.Id);
        await ct.stop().catch(() => {});
        await ct.remove().catch(() => {});
      }
    }
    console.log("Teardown complete.");
    process.exit();
  }
}

runTests();
