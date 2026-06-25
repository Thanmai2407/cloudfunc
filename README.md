# CloudFunc - Async Serverless Execution Platform

CloudFunc is a local Function-as-a-Service platform. Users register JavaScript handler code, invoke functions asynchronously, and poll job results. The platform stores function versions and jobs in PostgreSQL, queues executions in RabbitMQ, and runs user code inside isolated Docker runner containers.

## Architecture

```text
UI / curl
  -> Gateway (:5001)
  -> Registry (:8080) + PostgreSQL (:5433)
  -> RabbitMQ (:5672)
  -> Worker (:5002 health API)
  -> Container Manager (:3000)
  -> Function Runner containers (:4000 inside each dynamic container)
  -> DLQ Consumer (:5003 health API)
```

The important runtime flow is:

```text
1. Client registers a function through Gateway.
2. Gateway authenticates the user and forwards registration to Registry.
3. Registry stores function metadata and creates a new function version.
4. Client invokes a function through Gateway.
5. Gateway creates a job in Registry and stores the input payload there.
6. Gateway publishes only lightweight job metadata to RabbitMQ.
7. Worker consumes the job, fetches the pinned function version and input payload from Registry, then calls Container Manager.
8. Container Manager starts or reuses a version-aware warm Docker container, injects handler code, and calls the Function Runner.
9. Worker updates the job as completed or failed.
10. Permanently failed jobs are sent to `executions_dlq`; DLQ Consumer stores them in Registry's `failed_jobs` table for search.
```

## Services

| Service | Port | Purpose |
|---|---:|---|
| Gateway | 5001 | Public API, auth, ownership checks, job enqueueing |
| Registry | 8080 | Function metadata, versions, jobs, failed-job records |
| PostgreSQL | 5433 | Durable database |
| RabbitMQ | 5672 | Execution queue |
| RabbitMQ UI | 15672 | Queue management UI |
| Container Manager | 3000 | Docker lifecycle, warm pool, code injection |
| Worker | 5002 | Background job consumer health API |
| DLQ Consumer | 5003 | Failed-job queue consumer health API |

## Prerequisites

- Docker Desktop running
- Node.js 18+ if you want to run tests or services manually
- `jq` is optional but useful for formatting curl output

All commands below assume you are in the project root:

```bash
cd /Users/bhavyathota/PROJECTS/MY_CLOUDFUNC/cloudfunc
```

## Recommended Startup: Docker Compose

Docker Compose starts the platform services together: PostgreSQL, RabbitMQ, Registry, Gateway, Container Manager, Worker, and DLQ Consumer.

The Function Runner image is different: it is not a long-running Compose service. Container Manager creates Function Runner containers dynamically when jobs execute, so the Docker daemon must already have the `function-runner:latest` image.

### 1. Build the Function Runner image

```bash
docker build -t function-runner:latest ./function-runner
```

### 2. Start the platform

Foreground mode:

```bash
docker compose up --build
```

Detached mode:

```bash
docker compose up --build -d
```

### 3. Check service readiness

```bash
curl -s http://localhost:5001/ready | jq
curl -s http://localhost:8080/ready | jq
curl -s http://localhost:3000/ready | jq
curl -s http://localhost:5002/ready | jq
curl -s http://localhost:5003/ready | jq
```

RabbitMQ management UI:

```text
http://localhost:15672
```

Default RabbitMQ login:

```text
guest / guest
```

### 4. Open the UI

The UI is still compatible with the current project. It now talks only to Gateway at:

```text
http://localhost:5001
```

Open this file in your browser:

```text
/Users/bhavyathota/PROJECTS/MY_CLOUDFUNC/cloudfunc/ui/index.html
```

The default UI token is:

```text
my-token
```

That means Gateway treats the owner as:

```text
my
```

You can also use tokens like:

```text
alice-token
bob-token
```

## Test With curl

The Gateway auth format is:

```text
Authorization: Bearer <username>-token
```

For example, `Bearer alice-token` means the owner is `alice`.

### Register a function

```bash
curl -s -X POST http://localhost:5001/registerFunction \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer alice-token" \
  -d '{
    "name": "add",
    "image": "function-runner:latest",
    "handler_code": "module.exports = async (input) => { const { a = 0, b = 0 } = input; return a + b; };"
  }' | jq
```

### List your functions

```bash
curl -s http://localhost:5001/functions \
  -H "Authorization: Bearer alice-token" | jq
```

### Invoke a function

```bash
curl -s -X POST http://localhost:5001/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer alice-token" \
  -d '{
    "functionName": "add",
    "input": { "a": 15, "b": 35 }
  }' | jq
```

You should receive:

```json
{
  "jobId": "...",
  "status": "queued"
}
```

### Poll the job

Replace `JOB_ID_HERE` with the returned job ID:

```bash
curl -s http://localhost:5001/jobs/JOB_ID_HERE \
  -H "Authorization: Bearer alice-token" | jq
```

Successful result example:

```json
{
  "id": "...",
  "function_name": "add",
  "status": "completed",
  "result": 50,
  "error": null
}
```

## Failed Job Search

If a job fails after all retries, Worker publishes it to:

```text
executions_dlq
```

DLQ Consumer stores those messages in Registry's `failed_jobs` table.

Search failed jobs:

```bash
curl -s "http://localhost:8080/failed-jobs?functionName=add" | jq
```

Or by job ID:

```bash
curl -s "http://localhost:8080/failed-jobs?jobId=JOB_ID_HERE" | jq
```

## What Docker Compose Is For

`docker-compose.yml` defines the local multi-service environment. Instead of opening separate terminals for PostgreSQL, RabbitMQ, Registry, Gateway, Container Manager, Worker, and DLQ Consumer, Compose builds and starts them as one connected system.

Compose handles:

- Starting PostgreSQL and RabbitMQ
- Building service images from their Dockerfiles
- Wiring service URLs like `http://registry:8080`
- Exposing useful localhost ports
- Mounting the Docker socket into Container Manager so it can create Function Runner containers
- Setting `RUNNER_HOST=host.docker.internal` so Container Manager can call dynamically-created runner containers from inside Docker

Compose does not replace the Function Runner image build. You still need:

```bash
docker build -t function-runner:latest ./function-runner
```

because Function Runner containers are created dynamically at execution time.

## Useful Docker Commands

Show running services:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs -f
```

View one service's logs:

```bash
docker compose logs -f gateway
docker compose logs -f worker
docker compose logs -f container-manager
```

Stop services:

```bash
docker compose down
```

Stop services and remove database state:

```bash
docker compose down -v
```

Rebuild after code changes:

```bash
docker compose up --build
```

## Optional: Run Services Manually

Manual mode is useful for debugging, but Compose is easier.

Start PostgreSQL and RabbitMQ yourself, then install dependencies:

```bash
npm install --prefix registry
npm install --prefix gateway
npm install --prefix container-manager
npm install --prefix function-runner
npm install --prefix Worker/worker
npm install
```

Build the runner image:

```bash
docker build -t function-runner:latest ./function-runner
```

Start services in separate terminals:

```bash
node registry/registry.js
node gateway/gateway.js
node container-manager/manager.js
node Worker/worker/index.js
node Worker/worker/dlq-consumer.js
```

In manual mode, the default service URLs use `localhost`, so no extra environment variables are usually needed.

## Integration Test

The integration test starts services locally with Node and expects PostgreSQL, RabbitMQ, Docker, and the `function-runner:latest` image to be available.

```bash
npm test
```

If Docker or infrastructure is not running, the integration test will fail.
