// The REST v3 surface. Every reply is JSON (errors are `{message}`), pagination is the `Link`
// header with absolute same-origin URLs, and a repository named under any owner but the
// viewer's is a 404 — the forge has one user and never confirms another owner's names exist.

import {
  buildCommit,
  buildTreeFromFlat,
  diffFlats,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeFlats,
  parseCommit,
  putObject,
  treeOfCommit,
} from './git.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, identityLine, isoOf } from './store.ts';
import type { Store } from './store.ts';

/** One REST reply: status, JSON value (or null for an empty body) and extra headers. */
export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): RestReply => ({ status: 200, body });
const created = (body: unknown): RestReply => ({ status: 201, body });
const noContent = (): RestReply => ({ status: 204, body: null });
const fail = (status: number, message: string): RestReply => ({ status, body: { message } });
const notFound = (): RestReply => fail(404, 'Not Found');

/** The request context the REST handlers need beyond the store. */
export interface RestContext {
  store: Store;
  /** The absolute base the request arrived on (`http://127.0.0.1:<port>`), for Link URLs. */
  baseUrl: string;
}

// ---------------------------------------------------------------------------------------------
// object shapes

/** The user object every surface answers for the viewer. */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_LOGIN),
    type: 'User',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    avatar_url: '',
    html_url: '',
    url: '',
  };
}

/** An opaque, stable global id: never the database id or the number itself. */
export function globalId(type: string, key: string | number): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its type and key; null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.+)$/.exec(decoded);
    if (match === null) return null;
    return { type: match[1] as string, key: match[2] as string };
  } catch {
    return null;
  }
}

/** The repository object (the field set REST and MCP both answer, with stable ids). */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: isoOf(repo.updatedAt),
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** The label object. */
export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

/** The issue object; labels are the full label objects, as REST answers them. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedAt) : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** The comment object. */
export function commentJson(repo: Repo, comment: { id: number; body: string; createdAt: number; updatedAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${comment.id}`),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.updatedAt),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

/** The branch object. */
export function branchJson(repo: Repo, name: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${name}`);
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

/** The commit object (list entries and single reads share this shape). */
export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.createdAt) },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.createdAt) },
      message: commit.message.replace(/\n+$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

/** The pull request object, with head/base in GitHub's shape. */
export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt !== null ? isoOf(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    comments: pull.comments.length,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedAt) : null,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers

/** A JSON request body as an object ({} when it is not one). */
function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function bodyString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBool(object: Record<string, unknown>, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Resolve a ref-ish name (branch, tag, ref or sha) to a commit id in a repository. */
export function resolveCommit(repo: Repo, name: string): string | null {
  const candidates = [
    repo.refs.get(name),
    repo.refs.get(`refs/heads/${name}`),
    repo.refs.get(`refs/tags/${name}`),
    repo.refs.get(`refs/${name}`),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const object = repo.objects.get(candidate);
    if (object === undefined) continue;
    if (object.type === 'commit') return candidate;
    if (object.type === 'tag') {
      let current = candidate;
      for (let hops = 0; hops < 16; hops += 1) {
        const tagObject = repo.objects.get(current);
        if (tagObject === undefined || tagObject.type !== 'tag') break;
        const next = (tagObject.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m) ?? [])[1];
        if (next === undefined) break;
        current = next;
        if (repo.objects.get(current)?.type === 'commit') return current;
      }
    }
  }
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.get(name)?.type === 'commit') return name;
  return null;
}

/** Commits reachable from a tip, newest first (breadth by generation). */
export function listCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = [tip];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.push(oid);
      next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
  }
  return order;
}

/** Paginate a list the way the checks read it: per_page/page plus a `next` Link when more remain. */
function paginate<T>(ctx: RestContext, path: string, query: URLSearchParams, items: readonly T[]): RestReply {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.Link = `<${ctx.baseUrl}${path}?${next.toString()}>; rel="next"`;
  }
  return { status: 200, body: slice, headers };
}

/** Author a commit in a repository on a branch and move the branch to it. */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
  extraParents: readonly string[] = [],
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parents = [...(tip !== undefined ? [tip] : []), ...extraParents.filter((parent) => parent !== tip)];
  const stamp = store.now();
  const identity = identityLine(stamp);
  const commitOid = putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message }));
  repo.refs.set(ref, commitOid);
  repo.updatedAt = stamp;
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// the router

/** Route one authenticated REST request. `segments` is the path after `/api/v3`. */
export function routeRest(ctx: RestContext, method: string, segments: string[], query: URLSearchParams, body: unknown): RestReply {
  const { store } = ctx;
  const [first, second] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }
  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ verifiable_password_authentication: false, installed_version: 'forge-1.0.0', api: ['v3'] });
  }
  if (first === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(userJson());
  }
  if (first === 'user' && second === 'repos') {
    if (method === 'GET' && segments.length === 2) {
      return paginate(ctx, '/api/v3/user/repos', query, store.viewerRepos().map(repoJson));
    }
    if (method === 'POST' && segments.length === 2) {
      const input = bodyObject(body);
      const name = bodyString(input, 'name');
      if (name === undefined || name === '') return fail(422, 'Repository creation failed: name is required');
      const repo = store.createRepo(name, {
        description: bodyString(input, 'description') ?? '',
        isPrivate: bodyBool(input, 'private') ?? false,
        defaultBranch: bodyString(input, 'default_branch') ?? 'main',
      });
      if (repo === null) return fail(422, 'Repository creation failed: name already exists on this account');
      return created(repoJson(repo));
    }
    return notFound();
  }
  if (first === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.repo(owner, name);
    if (repo === undefined) return notFound();
    return routeRepo(ctx, method, repo, segments.slice(3), query, body);
  }
  return notFound();
}

function routeRepo(ctx: RestContext, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: unknown): RestReply {
  const { store } = ctx;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  const head = rest[0];

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const input = bodyObject(body);
      const description = bodyString(input, 'description');
      if (description !== undefined) repo.description = description;
      const name = bodyString(input, 'name');
      if (name !== undefined && name !== '' && name !== repo.name) {
        store.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = name;
        store.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      const defaultBranch = bodyString(input, 'default_branch');
      if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
      const isPrivate = bodyBool(input, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      repo.updatedAt = store.now();
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return noContent();
    }
    return notFound();
  }

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const names = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      return ok(names.map((name) => branchJson(repo, name)));
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      if (!repo.refs.has(`refs/heads/${branch}`)) return notFound();
      return ok(branchJson(repo, branch));
    }
    return notFound();
  }

  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const refName = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommit(repo, refName);
      if (tip === null) return ok([]);
      return paginate(ctx, `${base}/commits`, query, listCommits(repo, tip).map((sha) => commitJson(repo, sha)));
    }
    if (method === 'GET' && rest.length === 2) {
      const commit = commitJson(repo, rest[1] as string);
      return commit === null ? notFound() : ok(commit);
    }
    return notFound();
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const input = bodyObject(body);
      const ref = bodyString(input, 'ref');
      const sha = bodyString(input, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return fail(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return fail(422, 'Validation Failed: sha does not name an object');
      repo.refs.set(ref, sha);
      return created({ ref, node_id: globalId('Ref', ref), url: `${base}/git/refs/${ref.slice('refs/'.length)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return ok({ ref, node_id: globalId('Ref', ref), url: `${base}/git/refs/${ref.slice('refs/'.length)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    return notFound();
  }

  if (head === 'contents') return routeContents(ctx, method, repo, rest.slice(1).join('/'), query, body);
  if (head === 'labels') return routeLabels(ctx, method, repo, rest.slice(1), body);
  if (head === 'issues') return routeIssues(ctx, method, repo, rest.slice(1), query, body);
  if (head === 'pulls') return routePulls(ctx, method, repo, rest.slice(1), query, body);
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents

function routeContents(ctx: RestContext, method: string, repo: Repo, path: string, query: URLSearchParams, body: unknown): RestReply {
  const { store } = ctx;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  if (method === 'GET') {
    const refName = query.get('ref') ?? repo.defaultBranch;
    const commitOid = resolveCommit(repo, refName);
    const flat = flattenTree(repo, treeOfCommit(repo, commitOid));
    const entry = path === '' ? undefined : flat.get(path);
    if (entry !== undefined) {
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return notFound();
      return ok({
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        content: blob.data.toString('base64'),
        url: `${base}/contents/${path}`,
        html_url: '',
        git_url: '',
        download_url: '',
        _links: {},
      });
    }
    // A directory (or the root): list the entries directly under the path.
    const prefix = path === '' ? '' : `${path}/`;
    const dirs = new Map<string, string>();
    const files: { name: string; path: string; sha: string; size: number }[] = [];
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash < 0) {
        files.push({ name: remainder, path: filePath, sha: fileEntry.oid, size: repo.objects.get(fileEntry.oid)?.data.length ?? 0 });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!dirs.has(dirName)) {
          // The directory's own tree id: recompute from the flattened map.
          const sub = new Map<string, { mode: string; oid: string }>();
          for (const [p, e] of flat) if (p.startsWith(`${prefix}${dirName}/`)) sub.set(p.slice(prefix.length + dirName.length + 1), e);
          dirs.set(dirName, buildTreeFromFlat(repo, sub));
        }
      }
    }
    if (path !== '' && files.length === 0 && dirs.size === 0) return notFound();
    const listing = [
      ...[...dirs.entries()].map(([name, sha]) => ({ type: 'dir', name, path: `${prefix}${name}`, sha, size: 0, url: '', html_url: '', git_url: '', download_url: null, _links: {} })),
      ...files.map((file) => ({ type: 'file', name: file.name, path: file.path, sha: file.sha, size: file.size, url: '', html_url: '', git_url: '', download_url: '', _links: {} })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    return ok(listing);
  }

  if (method === 'PUT') {
    const input = bodyObject(body);
    const message = bodyString(input, 'message') ?? 'Update file';
    const contentBase64 = bodyString(input, 'content');
    if (contentBase64 === undefined) return fail(422, 'Validation Failed: content is required');
    const branch = bodyString(input, 'branch') ?? repo.defaultBranch;
    const commitOid = resolveCommit(repo, branch);
    const flat = flattenTree(repo, treeOfCommit(repo, commitOid));
    const existing = flat.get(path);
    const givenSha = bodyString(input, 'sha');
    if (existing !== undefined) {
      if (givenSha === undefined || givenSha !== existing.oid) return fail(409, 'Conflict: the file changed since the given sha');
    }
    const data = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const blobOid = putObject(repo, 'blob', data);
    flat.set(path, { mode: '100644', oid: blobOid });
    const treeOid = buildTreeFromFlat(repo, flat);
    const commitSha = commitOnBranch(store, repo, branch, treeOid, message);
    return {
      status: existing !== undefined ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') },
        commit: { sha: commitSha },
      },
    };
  }

  if (method === 'DELETE') {
    const input = bodyObject(body);
    const message = bodyString(input, 'message') ?? 'Delete file';
    const branch = bodyString(input, 'branch') ?? repo.defaultBranch;
    const commitOid = resolveCommit(repo, branch);
    const flat = flattenTree(repo, treeOfCommit(repo, commitOid));
    const existing = flat.get(path);
    if (existing === undefined) return notFound();
    const givenSha = bodyString(input, 'sha');
    if (givenSha === undefined || givenSha !== existing.oid) return fail(409, 'Conflict: the file changed since the given sha');
    flat.delete(path);
    const treeOid = buildTreeFromFlat(repo, flat);
    const commitSha = commitOnBranch(store, repo, branch, treeOid, message);
    return ok({ content: null, commit: { sha: commitSha } });
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// labels

function routeLabels(ctx: RestContext, method: string, repo: Repo, rest: string[], body: unknown): RestReply {
  const { store } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return ok([...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(labelJson));
    if (method === 'POST') {
      const input = bodyObject(body);
      const name = bodyString(input, 'name');
      if (name === undefined || name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: name has already been taken');
      const label: Label = {
        id: store.newLabelId(),
        name,
        color: (bodyString(input, 'color') ?? 'ededed').replace(/^#/, ''),
        description: bodyString(input, 'description') ?? null,
      };
      repo.labels.set(name, label);
      return created(labelJson(label));
    }
    return notFound();
  }
  const label = repo.labels.get(decodeURIComponent(rest.join('/')));
  if (label === undefined) return notFound();
  if (method === 'GET') return ok(labelJson(label));
  if (method === 'DELETE') {
    repo.labels.delete(label.name);
    return noContent();
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// issues

/** The label names an issue body names (strings or {name} objects); null when malformed. */
function labelNamesOf(input: Record<string, unknown>): string[] {
  const raw = input.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') names.push((item as { name: string }).name);
  }
  return names;
}

/** Create an issue in a repository (REST and MCP share this); null + reason on a bad label. */
export function createIssue(store: Store, repo: Repo, input: { title: string; body?: string; labels?: string[] }): { issue: Issue } | { error: string } {
  const labels = input.labels ?? [];
  for (const name of labels) if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist in this repository` };
  const stamp = store.now();
  const issue: Issue = {
    id: store.newIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    createdAt: stamp,
    updatedAt: stamp,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.updatedAt = stamp;
  return { issue };
}

function routeIssues(ctx: RestContext, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: unknown): RestReply {
  const { store } = ctx;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = bodyObject(body);
      const title = bodyString(input, 'title');
      if (title === undefined || title === '') return fail(422, 'Validation Failed: title is required');
      const result = createIssue(store, repo, { title, body: bodyString(input, 'body') ?? '', labels: labelNamesOf(input) });
      if ('error' in result) return fail(422, `Validation Failed: ${result.error}`);
      return created(issueJson(repo, result.issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (sort === 'created' ? a.number - b.number : a.updatedAt - b.updatedAt) * (direction === 'asc' ? 1 : -1));
      return paginate(ctx, `${base}/issues`, query, issues.map((issue) => issueJson(repo, issue)));
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return ok(issueJson(repo, issue));
    if (method === 'PATCH') {
      const input = bodyObject(body);
      const title = bodyString(input, 'title');
      if (title !== undefined) issue.title = title;
      const text = bodyString(input, 'body');
      if (text !== undefined) issue.body = text;
      const state = bodyString(input, 'state');
      if (state === 'closed' || state === 'open') issue.state = state;
      if (Array.isArray(input.labels)) {
        const names = labelNamesOf(input);
        for (const name of names) if (!repo.labels.has(name)) return fail(422, `Validation Failed: Label '${name}' does not exist in this repository`);
        issue.labels = names;
      }
      issue.updatedAt = store.now();
      return ok(issueJson(repo, issue));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') return paginate(ctx, `${base}/issues/${number}/comments`, query, issue.comments.map((comment) => commentJson(repo, comment)));
    if (method === 'POST') {
      const input = bodyObject(body);
      const text = bodyString(input, 'body');
      if (text === undefined) return fail(422, 'Validation Failed: body is required');
      const stamp = store.now();
      const comment = { id: store.newCommentId(), body: text, createdAt: stamp, updatedAt: stamp };
      issue.comments.push(comment);
      issue.updatedAt = stamp;
      return created(commentJson(repo, comment));
    }
    return notFound();
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests

/** Create a pull request (REST, GraphQL and MCP share this). */
export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: PullRequest } | { error: string } {
  if (!repo.refs.has(`refs/heads/${input.head}`)) return { error: `Head branch '${input.head}' does not exist` };
  if (!repo.refs.has(`refs/heads/${input.base}`)) return { error: `Base branch '${input.base}' does not exist` };
  const stamp = store.now();
  const pull: PullRequest = {
    id: store.newIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: stamp,
    updatedAt: stamp,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = stamp;
  return { pull };
}

/** The merge outcome for a pull request: 'clean', 'conflict', or 'gone' (a branch vanished). */
export function pullMergeability(repo: Repo, pull: PullRequest): 'clean' | 'conflict' | 'gone' {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'gone';
  if (isAncestor(repo, headTip, baseTip)) return 'clean';
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = flattenTree(repo, treeOfCommit(repo, base));
  const oursFlat = flattenTree(repo, treeOfCommit(repo, baseTip));
  const theirsFlat = flattenTree(repo, treeOfCommit(repo, headTip));
  return mergeFlats(baseFlat, oursFlat, theirsFlat) === null ? 'conflict' : 'clean';
}

/** Squash-merge a pull request into its base branch; null when the merge conflicts. */
export function mergePull(store: Store, repo: Repo, pull: PullRequest): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) as string;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
  const base = mergeBase(repo, baseTip, headTip);
  const mergedFlat = mergeFlats(
    flattenTree(repo, treeOfCommit(repo, base)),
    flattenTree(repo, treeOfCommit(repo, baseTip)),
    flattenTree(repo, treeOfCommit(repo, headTip)),
  );
  if (mergedFlat === null) return null;
  const treeOid = buildTreeFromFlat(repo, mergedFlat);
  const message = pull.body === '' ? `${pull.title}\n` : `${pull.title}\n\n${pull.body}\n`;
  const sha = commitOnBranch(store, repo, pull.baseRef, treeOid, message);
  const stamp = store.now();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp;
  return sha;
}

function routePulls(ctx: RestContext, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: unknown): RestReply {
  const { store } = ctx;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const input = bodyObject(body);
      const title = bodyString(input, 'title');
      const head = bodyString(input, 'head');
      const baseRef = bodyString(input, 'base');
      if (title === undefined || head === undefined || baseRef === undefined) return fail(422, 'Validation Failed: title, head and base are required');
      const result = createPull(store, repo, { title, body: bodyString(input, 'body') ?? '', head, base: baseRef });
      if ('error' in result) return fail(422, `Validation Failed: ${result.error}`);
      return created(pullJson(repo, result.pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      return paginate(ctx, `${base}/pulls`, query, pulls.map((pull) => pullJson(repo, pull)));
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return ok(pullJson(repo, pull));
    if (method === 'PATCH') {
      const input = bodyObject(body);
      const title = bodyString(input, 'title');
      if (title !== undefined) pull.title = title;
      const text = bodyString(input, 'body');
      if (text !== undefined) pull.body = text;
      const state = bodyString(input, 'state');
      if (state === 'closed' || state === 'open') pull.state = state;
      pull.updatedAt = store.now();
      return ok(pullJson(repo, pull));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return ok([]);
    const base = mergeBase(repo, baseTip, headTip);
    const changes = diffFlats(repo, flattenTree(repo, treeOfCommit(repo, base)), flattenTree(repo, treeOfCommit(repo, headTip)));
    return paginate(
      ctx,
      `${base}/pulls/${number}/files`,
      query,
      changes.map((change) => ({
        sha: flattenTree(repo, treeOfCommit(repo, headTip)).get(change.filename)?.oid ?? '',
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        patch: '',
      })),
    );
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') return fail(405, 'Pull Request is not open');
    if (pullMergeability(repo, pull) !== 'clean') return fail(405, 'Pull Request is not mergeable');
    const input = bodyObject(body);
    const sha = mergePull(store, repo, pull);
    if (sha === null) return fail(405, 'Pull Request is not mergeable');
    void input;
    return ok({ sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') return paginate(ctx, `${base}/pulls/${number}/comments`, query, pull.comments.map((comment) => commentJson(repo, comment)));
    if (method === 'POST') {
      const input = bodyObject(body);
      const text = bodyString(input, 'body');
      if (text === undefined) return fail(422, 'Validation Failed: body is required');
      const stamp = store.now();
      const comment = { id: store.newCommentId(), body: text, createdAt: stamp, updatedAt: stamp };
      pull.comments.push(comment);
      pull.updatedAt = stamp;
      return created(commentJson(repo, comment));
    }
    return notFound();
  }
  return notFound();
}
