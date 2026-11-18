// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It answers the modern `server/discover`
// handshake (protocol revision 2026-07-28) as well as the legacy `initialize` one, and its six
// tools act on the same store as REST — a repository or issue made through one surface is the
// same object, with the same stable id, on the other. Tool definitions are static, so two
// `tools/list` answers are byte-identical.

import type { Store } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, pullMergeability, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
});

const STRING = { type: 'string' } as const;

/** The tool list. Static on purpose: the conformance suite compares two listings byte for byte. */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      { name: STRING, description: STRING, private: { type: 'boolean' }, owner: STRING },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository, including its stable numeric id.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING, body: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'integer' } },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

/** One MCP HTTP reply: a status and a JSON body, or an empty body (notifications). */
export interface McpReply {
  status: number;
  body: unknown;
  empty: boolean;
}

const reply = (status: number, body: unknown): McpReply => ({ status, body, empty: false });
const emptyReply = (status: number): McpReply => ({ status, body: null, empty: true });

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** A tool result in the shape MCP clients read: text content plus the same object structured. */
function toolOk(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolFail(message: string): Record<string, unknown> {
  const value = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

type Args = Record<string, unknown>;

function argString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The owner/repo pair of a call, honoring a `full_name` argument when one is given. */
function ownerRepo(args: Args): { owner: string; repo: string } | null {
  let owner = argString(args, 'owner');
  let repo = argString(args, 'repo');
  const fullName = argString(args, 'full_name');
  if ((owner === undefined || repo === undefined) && fullName !== undefined && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Args): Record<string, unknown> | null {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === undefined) return toolFail('name is required');
      const repo = store.createRepo(repoName, {
        description: argString(args, 'description') ?? '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) return toolFail(`a repository named '${repoName}' already exists`);
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const target = ownerRepo(args);
      if (target === null) return toolFail('owner and repo are required');
      const repo = store.repo(target.owner, target.repo);
      if (repo === undefined) return toolFail('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const target = ownerRepo(args);
      if (target === null) return toolFail('owner and repo are required');
      const title = argString(args, 'title');
      if (title === undefined) return toolFail('title is required');
      const repo = store.repo(target.owner, target.repo);
      if (repo === undefined) return toolFail('repository not found');
      const result = createIssue(store, repo, { title, body: argString(args, 'body') ?? '' });
      if ('error' in result) return toolFail(result.error);
      return toolOk(issueJson(repo, result.issue));
    }
    case 'list_issues': {
      const target = ownerRepo(args);
      if (target === null) return toolFail('owner and repo are required');
      const repo = store.repo(target.owner, target.repo);
      if (repo === undefined) return toolFail('repository not found');
      const state = argString(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolOk({ total_count: issues.length, issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const target = ownerRepo(args);
      if (target === null) return toolFail('owner and repo are required');
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (title === undefined || head === undefined || base === undefined) return toolFail('title, head and base are required');
      const repo = store.repo(target.owner, target.repo);
      if (repo === undefined) return toolFail('repository not found');
      const result = createPull(store, repo, { title, body: argString(args, 'body') ?? '', head, base });
      if ('error' in result) return toolFail(result.error);
      return toolOk(pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const target = ownerRepo(args);
      if (target === null) return toolFail('owner and repo are required');
      const rawNumber = args.pull_number;
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number.parseInt(rawNumber, 10) : Number.NaN;
      if (!Number.isFinite(number)) return toolFail('pull_number is required');
      const repo = store.repo(target.owner, target.repo);
      if (repo === undefined) return toolFail('repository not found');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFail('pull request not found');
      if (pull.state !== 'open') return toolFail('pull request is not open');
      if (pullMergeability(repo, pull) !== 'clean' || mergePull(store, repo, pull) === null) return toolFail('pull request is not mergeable');
      return toolOk(pullJson(repo, pull));
    }
    default:
      return null;
  }
}

/** Handle one parsed JSON-RPC message; null when it is a notification (no reply is sent). */
function handleMessage(store: Store, message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32601, 'Method not found');
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in request && request.id !== undefined;
  const id = hasId ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};

  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Args) : {};
      const result = callTool(store, toolName, args);
      if (result === null) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one MCP HTTP request body (the raw text, so a non-JSON body is a -32700). */
export function handleMcp(store: Store, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return reply(400, rpcError(null, -32700, 'Parse error: the body is not valid JSON'));
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleMessage(store, entry)).filter((entry) => entry !== null);
    if (results.length === 0) return emptyReply(202);
    return reply(200, results);
  }
  const result = handleMessage(store, parsed);
  if (result === null) return emptyReply(202);
  return reply(200, result);
}
