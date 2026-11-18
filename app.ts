// The HTTP server: one process serving the git smart-HTTP protocol, REST v3, GraphQL and MCP
// over a single in-memory store. This module is the wiring only — routing, the bearer-token
// check, body reading and the response plumbing every surface shares (JSON everywhere on the
// API surfaces, a non-empty X-GitHub-Request-Id on every REST reply, JSON errors, never HTML).

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { routeRest } from './rest.ts';
import type { RestReply } from './rest.ts';
import { Store } from './store.ts';

/** Bodies are capped well above anything the suite sends (its largest pack is ~200 KiB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body fully; rejects when it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer check: the token is the shop token; without one configured, all callers pass. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = value === null || value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function sendRest(res: ServerResponse, reply: RestReply): void {
  sendJson(res, reply.status, reply.body, { 'x-github-request-id': randomUUID(), ...(reply.headers ?? {}) });
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

/** Build the forge's HTTP server (main.ts binds it to an ephemeral port). */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void handle(store, req, res).catch((error: unknown) => {
      // A handler bug must never take the server down mid-trial or answer HTML.
      if (!res.headersSent) sendJson(res, 500, { message: `internal error: ${error instanceof Error ? error.message : String(error)}` });
      else res.end();
    });
  });
  return server;
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  const segments = pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendRest(res, { status: 401, body: { message: 'Bad credentials' } });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        sendRest(res, { status: 400, body: { message: 'Problems parsing JSON' } });
        return;
      }
    }
    const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
    sendRest(res, routeRest({ store, baseUrl }, method, segments.slice(2), url.searchParams, body));
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { errors: [{ message: 'method not allowed' }] });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(store, body));
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(store, raw.toString('utf8'));
    if (reply.empty) {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendText(res, 401, 'unauthorized');
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const rest = gitMatch[3] ?? '';
    const repo = store.repo(owner, name);
    if (repo === undefined) {
      sendText(res, 404, 'repository not found');
      return;
    }
    const protocol = req.headers['git-protocol'];
    const version2 = typeof protocol === 'string' && protocol.includes('version=2');
    try {
      if (rest === '/info/refs' && method === 'GET') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendText(res, 400, 'unknown service');
          return;
        }
        const result = infoRefs(repo, service, version2);
        res.writeHead(result.status, { 'content-type': result.contentType });
        res.end(result.body);
        return;
      }
      if (rest === '/git-upload-pack' && method === 'POST') {
        const result = uploadPack(repo, await readBody(req), version2);
        res.writeHead(result.status, { 'content-type': result.contentType });
        res.end(result.body);
        return;
      }
      if (rest === '/git-receive-pack' && method === 'POST') {
        const result = receivePack(repo, await readBody(req));
        res.writeHead(result.status, { 'content-type': result.contentType });
        res.end(result.body);
        return;
      }
    } catch (error) {
      // A malformed protocol body is a 400; the server stays up for everything after it.
      sendText(res, 400, `git protocol error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    sendText(res, 404, 'not found');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
