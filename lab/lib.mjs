// Shared primitives for the lab. Node stdlib only — no dependencies, so a run
// is reproducible from a clean checkout and nothing in the harness can drift
// underneath a result.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * An observing origin. Records everything a server can see about a request —
 * ordered headers, method, path, HTTP version, remote address — and serves
 * fixture pages. This is the handbook's "first-party origin capture" reduced to
 * what a laptop can observe: no TLS inspection, because the browser talks
 * cleartext to us. Protocol-layer fingerprinting needs a TLS-terminating origin
 * and is deliberately out of scope here.
 */
export async function startOrigin({ onRequest } = {}) {
  const requests = [];
  const collected = [];
  const server = createServer((req, res) => {
    const record = {
      at: Date.now(),
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      // rawHeaders preserves order and case, which req.headers destroys.
      rawHeaders: [...req.rawHeaders],
      headers: { ...req.headers },
    };
    requests.push(record);
    onRequest?.(record);

    const path = req.url.split('?')[0];

    if (path === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests, null, 2));
      return;
    }

    if (path === '/__collect' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // Populate AFTER the body is read — onRequest fires before this, so
        // callers must read `origin.collected`, never the request record.
        record.collected = safeJson(body);
        if (record.collected) collected.push(record.collected);
        res.writeHead(204).end();
      });
      return;
    }

    // Vendored, digest-pinned third-party assets (React et al.) live outside
    // fixtures/ so it stays obvious which bytes are ours.
    if (path.startsWith('/vendor/')) {
      const v = join(LAB_DIR, 'vendor', path.slice('/vendor/'.length));
      if (existsSync(v) && v.startsWith(join(LAB_DIR, 'vendor'))) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(readFileSync(v));
        return;
      }
    }

    const fixture = path === '/' ? 'blank.html' : path.replace(/^\//, '');
    const file = join(LAB_DIR, 'fixtures', fixture);
    if (existsSync(file) && file.startsWith(join(LAB_DIR, 'fixtures'))) {
      res.writeHead(200, { 'content-type': contentType(file) });
      res.end(readFileSync(file));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>lab</title><body>ok</body>');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    requests,
    collected,
    // Only navigations, not subresources — the thing most assertions care about.
    documents: () => requests.filter((r) => isDocument(r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A mock browser-provider control plane. Captures the session-creation request
 * body so provider defaults can be observed without an account or network
 * egress. Returns a websocket URL that will fail to connect — by then the
 * request we care about has already been recorded.
 */
export async function startMockProvider() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: safeJson(body),
        raw: body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      // Shapes that satisfy both providers' response parsers.
      res.end(
        JSON.stringify({
          id: randomUUID(),
          session_id: randomUUID(),
          connect: `ws://127.0.0.1:1/devtools/browser/${randomUUID()}`,
          browser_ws_endpoint: `ws://127.0.0.1:1/devtools/browser/${randomUUID()}`,
          cdp_ws_url: `ws://127.0.0.1:1/devtools/browser/${randomUUID()}`,
          websocket_url: `ws://127.0.0.1:1/devtools/browser/${randomUUID()}`,
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Run the agent-browser CLI. Never throws on non-zero exit — several
 *  experiments expect failure after the observation has already been made. */
export function ab(args, { env = {}, unsetEnv = [], timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const merged = { ...process.env, ...env };
    // An UNSET variable and an empty one are different inputs. Several defaults
    // read `.unwrap_or(true)`, which an empty string would silently defeat.
    for (const k of unsetEnv) delete merged[k];
    const child = spawn('agent-browser', args, {
      env: merged,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, json: safeJson(stdout) });
    });
  });
}

/** A session name unique per run, so a stale daemon can never colour a result. */
export const sessionName = (tag) => `lab-${tag}-${randomUUID().slice(0, 8)}`;

export async function withSession(tag, fn) {
  const session = sessionName(tag);
  try {
    return await fn(session);
  } finally {
    await ab(['--session', session, 'close'], { timeoutMs: 30_000 });
  }
}

function isDocument(r) {
  const a = r.headers['sec-fetch-dest'];
  if (a) return a === 'document';
  return !/\.(js|css|png|jpg|svg|ico|woff2?)$/.test(r.url.split('?')[0]);
}

function contentType(f) {
  if (f.endsWith('.js')) return 'text/javascript';
  if (f.endsWith('.css')) return 'text/css';
  return 'text/html';
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Minimal assertion vocabulary. A result is a claim plus what was observed —
 *  never a bare boolean, because a passing test that records nothing cannot be
 *  audited later. */
export function check(claim, passed, observed) {
  return { claim, passed, observed };
}

export function report(name, results) {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}`);
  for (const r of results) {
    console.log(`\n${r.passed ? 'CONFIRMED' : 'REFUTED  '}  ${r.claim}`);
    console.log(`           observed: ${format(r.observed)}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} claims confirmed\n`,
  );
  return failed.length === 0;
}

function format(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 400 ? s.slice(0, 400) + '…' : s;
}
