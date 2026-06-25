# ☁️ CloudFunc — Async Serverless Execution Platform (Phase 3)

CloudFunc is a developer-centric **FaaS (Function-as-a-Service)** platform. In Phase 3, it allows users to register custom functions with their own **JavaScript handler code**. Invocations are queued asynchronously via RabbitMQ, processed by workers, executed in isolated Docker containers, and updated dynamically.

---

## Architecture Overview

```
Client / UI
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│                         GATEWAY  (:5001)                         │
│   • Validates request + auth                                     │
│   • Looks up function metadata + handler_code in Registry        │
│   • Creates job (status: queued)                                 │
│   • Publishes job with handler_code to RabbitMQ                  │
│   • Returns 202 Accepted + jobId immediately                     │
└──────────────────────────┬───────────────────────────────────────┘
                           │ publish
                           ▼
                   ┌──────────────┐
                   │   RabbitMQ   │   executions queue
                   └───────┬──────┘
                           │ consume
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   WORKER  (3 concurrent)                         │
│   • Picks job from queue                                         │
│   • Updates job → running                                        │
│   • Passes payload and handler_code to Container Manager         │
│   • Retries on failure (3x, exponential backoff)                 │
│   • Updates job → completed / failed                             │
└──────────────────────────┬───────────────────────────────────────┘
                           │ POST /run
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│               CONTAINER MANAGER  (:3000)                         │
│   • Checks warm container pool for function                      │
│   • Evicts warm container if handler code hash changed           │
│   • Cold start: docker run <image>, health-check                 │
│   • Injects handler.js dynamically via `docker exec`             │
│   • Forwards payload → Function Runner with timeout              │
│   • Idle TTL: cleans up containers idle > 5 min                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │ POST /run
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│        FUNCTION RUNNER  (Docker container, Port 4000)            │
│   • Generic Node.js HTTP server inside Docker                    │
│   • GET /health  — health check                                  │
│   • POST /run    — dynamically executes require('./handler.js')  │
└──────────────────────────────────────────────────────────────────┘
                           │ result
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              REGISTRY / DATABASE  (:8080 + PostgreSQL)           │
│   • Stores function name, owner, image, and handler_code         │
│   • Stores job records (id, status, result, error, timestamps)   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
cloudfunc/
├── gateway/
│   ├── gateway.js        # API Gateway: ingests requests, queries Registry, queues jobs
│   └── package.json
├── registry/
│   ├── registry.js       # Registry API: stores function schema, handler code, job statuses
│   ├── db.js             # PostgreSQL pool + auto schema initialization
│   └── package.json
├── container-manager/
│   ├── manager.js        # Container pool manager, cold/warm start, exec injection, eviction
│   └── package.json
├── function-runner/
│   ├── runner.js         # Generic function runtime: requires handler.js on POST /run
│   ├── Dockerfile        # Exposes port 4000 (NO hardcoded handlers inside)
│   └── package.json
├── Worker/
│   └── worker/
│       ├── index.js      # RabbitMQ consumer, calls Container Manager, manages DB state
│       └── package.json
├── ui/
│   ├── index.html        # Modern dashboard with code editor, template pills & live feed
│   ├── style.css         # Premium aesthetics, animations, responsive layout
│   └── app.js            # Front-end logic, service checking, quick templates, polling
├── test.js               # End-to-end integration tests (warm, cold, eviction, timeouts)
└── README.md
```

> All commands below should be run from inside the `cloudfunc/` directory.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js >= 18 | |
| Docker Desktop | Must be running |
| PostgreSQL 16 | Running on port `5433` |
| RabbitMQ 3 | Running on port `5672` (and management UI on `15672`) |

---

## Step 1: Start Infrastructure (Docker)

```bash
docker start cloudfunc-postgres cloudfunc-rabbitmq
```

> **First time setup?** Create the containers:
> ```bash
> docker run -d --name cloudfunc-postgres \
>   -e POSTGRES_USER=postgres \
>   -e POSTGRES_PASSWORD=postgres \
>   -e POSTGRES_DB=cloudfunc \
>   -p 5433:5432 postgres:16
>
> docker run -d --name cloudfunc-rabbitmq \
>   -p 5672:5672 -p 15672:15672 rabbitmq:3-management
> ```

---


## Step 2: Build the Function Runner Image

```bash
docker build -t function-runner:latest function-runner/
```

---

## Step 3: Install Dependencies

```bash
npm install --prefix registry
npm install --prefix gateway
npm install --prefix container-manager
npm install --prefix function-runner
npm install --prefix Worker/worker
npm install   # For integration tests
```

---

## Step 4: Start All Services

Open **4 separate terminal windows/tabs** inside `cloudfunc/`:

**Terminal 1 — Registry**
```bash
node registry/registry.js
```

**Terminal 2 — Gateway**
```bash
node gateway/gateway.js
```

**Terminal 3 — Container Manager**
```bash
node container-manager/manager.js
```

**Terminal 4 — Worker**
```bash
node Worker/worker/index.js
```

---

## Step 5: Register a Function (cURL Example)

Submit function details along with your custom JavaScript `handler_code`:

```bash
curl -s -X POST http://localhost:8080/registerFunction \
  -H "Content-Type: application/json" \
  -d '{
    "name": "add",
    "owner": "alice",
    "image": "function-runner:latest",
    "handler_code": "module.exports = async (input) => { const { a = 0, b = 0 } = input; return { result: a + b }; };"
  }' | jq
```

---

## Step 6: Invoke a Function (cURL Example)

Invocations are asynchronous; the API Gateway returns a `jobId` immediately:

```bash
curl -s -X POST http://localhost:5001/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-token" \
  -d '{
    "functionName": "add",
    "input": { "a": 15, "b": 35 }
  }' | jq
```

**Response (202 Accepted):**
```json
{
  "jobId": "f8f23cd9-3e86-4bc0-a936-8acc8f05a36a",
  "status": "queued"
}
```

---

## Step 7: Poll for Job Status & Result

```bash
curl -s http://localhost:5001/jobs/f8f23cd9-3e86-4bc0-a936-8acc8f05a36a | jq
```

**On Success:**
```json
{
  "id": "f8f23cd9-3e86-4bc0-a936-8acc8f05a36a",
  "function_name": "add",
  "status": "completed",
  "result": {
    "result": 50
  },
  "error": null
}
```

---

## Running the Automated Integration Test

To verify the cold starts, warm starts, handler updates (container eviction), and timeout retries:

```bash
node test.js
```

---

## Accessing the Dashboard UI

Simply open [ui/index.html](file:///Users/bhavyathota/PROJECTS/MY_CLOUDFUNC/cloudfunc/ui/index.html) directly in any modern web browser:
```
file:///Users/bhavyathota/PROJECTS/MY_CLOUDFUNC/cloudfunc/ui/index.html
```
The dashboard provides template pills (Math, Greet, Fetch, Timeout) for quickly loading and registering custom handler scripts.
