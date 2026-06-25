/* ==========================================
   CloudFunc Dashboard — app.js
   ========================================== */

const GATEWAY_URL = 'http://localhost:5001';

// ── Tracked jobs for live feed polling ────────
const trackedJobs = new Map(); // jobId → { functionName, status }

// ── DOM refs ──────────────────────────────────
const statusDot           = document.getElementById('statusDot');
const statusText          = document.getElementById('statusText');
const refreshAllBtn       = document.getElementById('refreshAllBtn');
const refreshFunctionsBtn = document.getElementById('refreshFunctionsBtn');
const functionsBody       = document.getElementById('functionsBody');
const jobFeed             = document.getElementById('jobFeed');

// ── Handler Templates ─────────────────────────
const TEMPLATES = {
  tplMath: `module.exports = async (input) => {
  const { a = 0, b = 0 } = input;
  return {
    sum:      a + b,
    diff:     a - b,
    product:  a * b,
    quotient: b !== 0 ? a / b : null,
  };
};`,

  tplGreet: `module.exports = async (input) => {
  const { name = 'World', lang = 'en' } = input;
  const greetings = {
    en: 'Hello',
    es: 'Hola',
    fr: 'Bonjour',
    jp: 'こんにちは',
  };
  const greeting = greetings[lang] || greetings['en'];
  return \`\${greeting}, \${name}! 👋\`;
};`,

  tplHttp: `// Note: node-fetch must be available in the container.
// The base function-runner:latest image does not include it by default.
// This template shows the handler shape — adapt as needed.
module.exports = async (input) => {
  const { url } = input;
  if (!url) throw new Error('input.url is required');
  const res = await fetch(url);
  const data = await res.json();
  return { status: res.status, data };
};`,

  tplTimeout: `// This handler simulates a slow function.
// The container manager will timeout and mark the job as failed
// after EXECUTION_TIMEOUT ms (default 5000ms), retrying 3 times.
module.exports = async (input) => {
  const ms = input.delay || 8000;
  await new Promise((r) => setTimeout(r, ms));
  return { done: true, sleptFor: ms };
};`,
};

// ── Helpers ────────────────────────────────────

function getAuthHeaders() {
  const token = document.getElementById('invokeToken').value.trim() || 'my-token';
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

function showToast(message, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type] || '📢'}</span><span>${message}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

function showResult(elId, content, type = 'info') {
  const el = document.getElementById(elId);
  el.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  el.className = `result-box ${type}`;
  el.classList.remove('hidden');
}

function hideResult(elId) {
  const el = document.getElementById(elId);
  el.classList.add('hidden');
  el.textContent = '';
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'info'));
}

function setButtonLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.dataset.original = btn.innerHTML;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Loading...`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.original;
  }
}

function isValidJSON(str) {
  try { JSON.parse(str); return true; } catch { return false; }
}

// ── Template Quick-fill Pills ──────────────────

Object.keys(TEMPLATES).forEach(id => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    document.getElementById('funcHandler').value = TEMPLATES[id];
    showToast(`Template loaded — edit it and register!`, 'info');
  });
});

// ── Service Health Check ───────────────────────

async function checkServices() {
  try {
    const res = await fetch(`${GATEWAY_URL}/ready`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'All services reachable';
    } else {
      statusDot.className = 'status-dot partial';
      statusText.textContent = 'Service issues detected';
    }
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Gateway offline — start compose first';
  }
}

// ── Stats ──────────────────────────────────────

async function refreshStats() {
  try {
    const res = await fetch(`${GATEWAY_URL}/functions`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error();
    const fns = await res.json();
    document.getElementById('fnCount').textContent = Array.isArray(fns) ? fns.length : '?';
  } catch {
    document.getElementById('fnCount').textContent = '—';
  }

  let active = 0, completed = 0, failed = 0;
  for (const j of trackedJobs.values()) {
    if (j.status === 'queued' || j.status === 'running') active++;
    else if (j.status === 'completed') completed++;
    else if (j.status === 'failed') failed++;
  }
  document.getElementById('jobsQueued').textContent    = active;
  document.getElementById('jobsCompleted').textContent = completed;
  document.getElementById('jobsFailed').textContent    = failed;
}

// ── Functions Table ────────────────────────────

async function loadFunctions() {
  try {
    const res = await fetch(`${GATEWAY_URL}/functions`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) {
      if (res.status === 401) {
        functionsBody.innerHTML = '<tr><td colspan="5" class="empty-state">Unauthorized. Enter valid Bearer token below.</td></tr>';
      } else {
        functionsBody.innerHTML = `<tr><td colspan="5" class="empty-state">Error: HTTP ${res.status}</td></tr>`;
      }
      return;
    }
    const fns = await res.json();

    if (!Array.isArray(fns) || fns.length === 0) {
      functionsBody.innerHTML = '<tr><td colspan="5" class="empty-state">No functions registered yet for this user.</td></tr>';
      return;
    }

    functionsBody.innerHTML = fns.map(fn => `
      <tr>
        <td><span class="fn-name">${fn.name}</span></td>
        <td>${fn.owner}</td>
        <td><span class="fn-image">${fn.image}</span></td>
        <td class="fn-date">${formatDate(fn.created_at)}</td>
        <td>
          <button class="btn-quick-invoke" onclick="quickInvoke('${fn.name}')">▶ Invoke</button>
        </td>
      </tr>
    `).join('');
  } catch {
    functionsBody.innerHTML = '<tr><td colspan="5" class="empty-state">Could not reach Gateway. Start the services first.</td></tr>';
  }
}

// Quick invoke from functions table — prefills the Invoke card
window.quickInvoke = function(name) {
  document.getElementById('invokeName').value = name;
  document.getElementById('invokeCard').scrollIntoView({ behavior: 'smooth' });
  document.getElementById('invokeName').focus();
  showToast(`Pre-filled "${name}" — set your input JSON and invoke!`, 'info');
};

// ── Register Function ──────────────────────────

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn         = document.getElementById('registerBtn');
  const name        = document.getElementById('funcName').value.trim();
  const image       = document.getElementById('funcImage').value.trim() || 'function-runner:latest';
  const handler_code = document.getElementById('funcHandler').value.trim();

  if (!name || !handler_code) {
    showToast('Name and handler code are required', 'error');
    return;
  }

  setButtonLoading(btn, true);
  hideResult('registerResult');

  try {
    const res  = await fetch(`${GATEWAY_URL}/registerFunction`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name, image, handler_code }),
    });
    const data = await res.json();

    if (res.ok) {
      showResult('registerResult', data, 'success');
      showToast(`Function "${name}" registered with custom handler!`, 'success');
      loadFunctions();
      refreshStats();
    } else {
      showResult('registerResult', data, 'error');
      showToast(data.error || 'Registration failed', 'error');
    }
  } catch (err) {
    showResult('registerResult', `Error: ${err.message}\n\nMake sure the Gateway is running:\n  node gateway/gateway.js`, 'error');
    showToast('Could not reach Gateway', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
});

// ── Invoke Function ────────────────────────────

document.getElementById('invokeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn          = document.getElementById('invokeBtn');
  const functionName = document.getElementById('invokeName').value.trim();
  const inputRaw     = document.getElementById('invokeInput').value.trim();

  if (!functionName) {
    showToast('Please enter a function name', 'error');
    return;
  }

  if (!isValidJSON(inputRaw)) {
    showToast('Input must be valid JSON, e.g. {"a": 10, "b": 20}', 'error');
    return;
  }

  const input = JSON.parse(inputRaw);

  setButtonLoading(btn, true);
  hideResult('invokeResult');

  try {
    const res  = await fetch(`${GATEWAY_URL}/invoke`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ functionName, input }),
    });
    const data = await res.json();

    if (res.status === 202) {
      showResult('invokeResult', data, 'info');
      showToast(`Job queued! ID: ${data.jobId.substring(0, 8)}…`, 'success');
      addJobToFeed(data.jobId, functionName, 'queued');
      startPolling(data.jobId);
    } else {
      showResult('invokeResult', data, 'error');
      showToast(data.error || 'Invocation failed', 'error');
    }
  } catch (err) {
    showResult('invokeResult', `Error: ${err.message}\n\nMake sure the Gateway is running:\n  node gateway/gateway.js`, 'error');
    showToast('Could not reach Gateway', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
});

// ── Poll Job ───────────────────────────────────

document.getElementById('pollBtn').addEventListener('click', async () => {
  const btn   = document.getElementById('pollBtn');
  const jobId = document.getElementById('pollJobId').value.trim();

  if (!jobId) {
    showToast('Please enter a Job ID', 'error');
    return;
  }

  setButtonLoading(btn, true);
  hideResult('pollResult');

  try {
    const data = await fetchJobStatus(jobId);
    const type = data.status === 'completed' ? 'success' : data.status === 'failed' ? 'error' : 'info';
    showResult('pollResult', data, type);
    showToast(`Job status: ${data.status}`, type);
  } catch (err) {
    showResult('pollResult', `Error: ${err.message}`, 'error');
    showToast('Could not fetch job status', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
});

// ── Job Feed ───────────────────────────────────

function clearEmptyState() {
  const empty = jobFeed.querySelector('.empty-state-center');
  if (empty) empty.remove();
}

function addJobToFeed(jobId, functionName, status) {
  clearEmptyState();

  const existing = document.getElementById(`job-${jobId}`);
  if (existing) { updateJobEl(jobId, { status }); return; }

  const shortId = jobId.substring(0, 8);
  const el = document.createElement('div');
  el.id = `job-${jobId}`;
  el.className = `job-item status-${status}`;
  el.innerHTML = `
    <div class="job-item-top">
      <span class="job-fn-name">fn: ${functionName}</span>
      <span class="job-status-badge badge-${status}">${status}</span>
    </div>
    <div class="progress-bar"><div class="progress-fill"></div></div>
    <div class="job-footer">
      <span class="job-id" title="Click to copy full ID" onclick="copyToClipboard('${jobId}')">${shortId}… ⎘</span>
      <span class="job-time">${new Date().toLocaleTimeString()}</span>
    </div>
  `;

  jobFeed.prepend(el);
  trackedJobs.set(jobId, { functionName, status });
  refreshStats();
}

function updateJobEl(jobId, data) {
  const el = document.getElementById(`job-${jobId}`);
  if (!el) return;

  const { status, result, error } = data;
  el.className = `job-item status-${status}`;

  const badge = el.querySelector('.job-status-badge');
  if (badge) {
    badge.className = `job-status-badge badge-${status}`;
    badge.textContent = status;
  }

  // When job finishes, remove progress bar and add result block
  const pb = el.querySelector('.progress-bar');
  if ((status === 'completed' || status === 'failed') && pb) {
    pb.remove();

    if (!el.querySelector('.job-result')) {
      const resultEl = document.createElement('div');
      if (status === 'completed' && result) {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        resultEl.className = 'job-result result-success';
        resultEl.textContent = JSON.stringify(parsed, null, 2);
      } else if (status === 'failed') {
        resultEl.className = 'job-result result-error';
        resultEl.textContent = `Error: ${error || 'Execution failed'}`;
      }
      const footer = el.querySelector('.job-footer');
      if (footer) el.insertBefore(resultEl, footer);
    }
  }

  const tracked = trackedJobs.get(jobId);
  if (tracked) tracked.status = status;
  refreshStats();
}

// ── Polling ────────────────────────────────────

async function fetchJobStatus(jobId) {
  const res = await fetch(`${GATEWAY_URL}/jobs/${jobId}`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function startPolling(jobId) {
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    try {
      const data = await fetchJobStatus(jobId);
      updateJobEl(jobId, data);

      if (data.status === 'completed' || data.status === 'failed') {
        clearInterval(interval);
        const type = data.status === 'completed' ? 'success' : 'error';
        showToast(`Job ${jobId.substring(0, 8)}… → ${data.status}`, type);
      }

      if (attempts >= 90) { // ~90s timeout
        clearInterval(interval);
        showToast('Polling stopped after 90s', 'error');
      }
    } catch {
      if (attempts >= 5) clearInterval(interval);
    }
  }, 1000);
}

// ── Refresh All ────────────────────────────────

async function refreshAll() {
  refreshAllBtn.classList.add('spinning');
  await Promise.all([checkServices(), loadFunctions(), refreshStats()]);
  refreshAllBtn.classList.remove('spinning');
  showToast('Refreshed!', 'info');
}

refreshAllBtn.addEventListener('click', refreshAll);
refreshFunctionsBtn.addEventListener('click', async () => {
  refreshFunctionsBtn.classList.add('spinning');
  await loadFunctions();
  refreshFunctionsBtn.classList.remove('spinning');
});

// Tab key in code editors inserts 2 spaces instead of losing focus
document.querySelectorAll('.code-editor').forEach(ta => {
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    }
  });
});

// ── Init ───────────────────────────────────────

(async function init() {
  await checkServices();
  await loadFunctions();
  await refreshStats();

  setInterval(checkServices, 15000);
  setInterval(loadFunctions, 30000);
})();
