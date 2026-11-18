// GraphQL v4: a small parser and executor over the same store REST serves, covering the
// queries and mutations `gh` and `github-mcp-server` send — viewer, repository fields, issue
// and pull-request reads and connections with cursor pagination, the create/close/merge
// mutations, Relay `node(id:)`, batched operations, and the introspection probes (`__type`
// field lists and enum values). Global ids are opaque and stable, and round-trip through
// `node(id:)`; an unknown field is a 200 with an `errors` array naming the field.

import { diffFlats, flattenTree, mergeBase, treeOfCommit } from './git.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN, isoOf } from './store.ts';
import type { Store } from './store.ts';
import { createPull, globalId, mergePull, parseGlobalId, pullMergeability, resolveCommit } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
  /** The type condition of an inline fragment, when this node is one (`name` is ''). */
  fragmentType?: string;
  /** A fragment spread's name, resolved against the document's fragments. */
  spread?: string;
}

interface Operation {
  type: 'query' | 'mutation';
  selection: FieldNode[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (char === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
      continue;
    }
    if (char === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') {
          const escape = input[i + 1] as string;
          value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : escape;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (i >= input.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      tokens.push({ kind: 'number', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
      if (match === null) throw new Error(`bad name at ${i}`);
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('unexpected end of document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', got '${token.value}'`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { type: string; selection: FieldNode[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token '${token.value}'`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        if (this.peek()?.kind === 'name') this.next(); // the operation name
        if (this.atPunct('(')) this.skipBalanced('(', ')'); // variable definitions
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.next();
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected `on` in a fragment definition');
        const type = this.next();
        this.skipDirectives();
        fragments.set(name.value, { type: type.value, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${token.value}'`);
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // the directive name
      if (this.atPunct('(')) this.skipBalanced('(', ')');
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) fields.push(this.parseField());
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.next();
    if (token.kind === 'spread') {
      const next = this.next();
      if (next.kind === 'name' && next.value === 'on') {
        const type = this.next();
        this.skipDirectives();
        return { name: '', args: new Map(), selection: this.parseSelectionSet(), fragmentType: type.value };
      }
      return { name: '', args: new Map(), selection: null, spread: next.value };
    }
    if (token.kind !== 'name') throw new Error(`expected a field, got '${token.value}'`);
    let name = token.value;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

/** Resolve a parsed value against the operation's variables into plain JavaScript data. */
function resolveValue(value: Value | undefined, variables: Record<string, unknown>): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables (introspection answers from these; execution implements the same fields)

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'isArchived', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'url', 'author', 'labels',
    'comments', 'createdAt', 'updatedAt', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'mergeCommit', 'files',
    'additions', 'deletions', 'changedFiles', 'isDraft', 'url', 'author', 'createdAt', 'updatedAt', 'repository',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'url', 'authoredDate', 'committedDate'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives', 'description'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------------------------
// execution

const TYPE = Symbol('graphql-type');

/** A typed source value for the executor. */
type Src = { [key: string]: unknown } & { [TYPE]: string };

function src(type: string, props: Record<string, unknown>): Src {
  return { [TYPE]: type, ...props } as Src;
}

class FieldError extends Error {}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { type: string; selection: FieldNode[] }>;
  errors: { message: string }[];
}

function userSrc(): Src {
  return src('User', {});
}

function repoSrc(repo: Repo): Src {
  return src('Repository', { repo });
}

function issueSrc(repo: Repo, issue: Issue): Src {
  return src('Issue', { repo, issue });
}

function pullSrc(repo: Repo, pull: PullRequest): Src {
  return src('PullRequest', { repo, pull });
}

function commentSrc(repo: Repo, comment: Issue['comments'][number]): Src {
  return src('IssueComment', { repo, comment });
}

/** An opaque cursor: the index just past the last item of the page it ends. */
function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? 0 : Number.parseInt(match[1] as string, 10);
  } catch {
    return 0;
  }
}

/** Slice a full list into a connection page by `first`/`after`. */
function pageOf<T>(items: readonly T[], args: Map<string, Value>, variables: Record<string, unknown>): { page: T[]; hasNext: boolean; endCursor: string | null; startIndex: number } {
  const firstRaw = resolveValue(args.get('first'), variables);
  const first = typeof firstRaw === 'number' ? firstRaw : items.length;
  const start = indexOfCursor(resolveValue(args.get('after'), variables));
  const page = items.slice(start, start + Math.max(0, first));
  return { page, hasNext: start + page.length < items.length, endCursor: page.length > 0 ? cursorOf(start + page.length) : null, startIndex: start };
}

function connectionSrc(type: string, items: readonly Src[], args: Map<string, Value>, variables: Record<string, unknown>): Src {
  const { page, hasNext, endCursor, startIndex } = pageOf(items, args, variables);
  return src(type, {
    nodesValue: page,
    edgesValue: page.map((node, i) => ({ node, cursor: cursorOf(startIndex + i + 1) })),
    pageInfoValue: { hasNextPage: hasNext, hasPreviousPage: startIndex > 0, startCursor: page.length > 0 ? cursorOf(startIndex + 1) : null, endCursor },
    totalCount: items.length,
  });
}

/** The file changes of a pull request, base-merge-base to head. */
function pullFiles(repo: Repo, pull: PullRequest): { path: string; additions: number; deletions: number; changeType: string }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, baseTip, headTip);
  return diffFlats(repo, flattenTree(repo, treeOfCommit(repo, base)), flattenTree(repo, treeOfCommit(repo, headTip))).map((change) => ({
    path: change.filename,
    additions: change.additions,
    deletions: change.deletions,
    changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
}

function typeSrc(name: string): Src | null {
  if (OBJECT_FIELDS[name] !== undefined) return src('__Type', { name, kind: 'OBJECT', fieldNames: OBJECT_FIELDS[name], enumValues: null });
  if (ENUM_VALUES[name] !== undefined) return src('__Type', { name, kind: 'ENUM', fieldNames: null, enumValues: ENUM_VALUES[name] });
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'Float') {
    return src('__Type', { name, kind: 'SCALAR', fieldNames: null, enumValues: null });
  }
  return null;
}

/** The object a global id names, or null. */
function nodeSrc(store: Store, id: unknown): Src | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = store.repoById(Number.parseInt(parsed.key, 10));
    return repo === undefined ? null : repoSrc(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId === undefined ? undefined : store.repoById(repoId);
    if (repo === undefined || number === undefined) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueSrc(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullSrc(repo, pull);
  }
  if (parsed.type === 'IssueComment') {
    const [repoId, commentId] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId === undefined ? undefined : store.repoById(repoId);
    if (repo === undefined || commentId === undefined) return null;
    for (const issue of repo.issues.values()) {
      const comment = issue.comments.find((entry) => entry.id === commentId);
      if (comment !== undefined) return commentSrc(repo, comment);
    }
    for (const pull of repo.pulls.values()) {
      const comment = pull.comments.find((entry) => entry.id === commentId);
      if (comment !== undefined) return commentSrc(repo, comment);
    }
    return null;
  }
  if (parsed.type === 'User') return userSrc();
  if (parsed.type === 'Commit') return src('Commit', { oid: parsed.key });
  return null;
}

function argString(field: FieldNode, name: string, ctx: ExecContext): string | undefined {
  const value = resolveValue(field.args.get(name), ctx.variables);
  return typeof value === 'string' ? value : undefined;
}

function inputOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const value = resolveValue(field.args.get('input'), ctx.variables);
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Resolve one field on one source; throws FieldError for an unknown field or a bad mutation. */
function resolveField(typeName: string, source: Src, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  const { store } = ctx;
  const repo = source.repo as Repo | undefined;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return userSrc();
      if (name === 'repository') {
        const owner = argString(field, 'owner', ctx);
        const repoName = argString(field, 'name', ctx);
        if (owner === undefined || repoName === undefined) return null;
        const found = store.repo(owner, repoName);
        return found === undefined ? null : repoSrc(found);
      }
      if (name === 'node') return nodeSrc(store, resolveValue(field.args.get('id'), ctx.variables));
      if (name === 'rateLimit') return src('RateLimit', { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2026-01-01T00:00:00Z', nodeCount: 0 });
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = inputOf(field, ctx);
        const target = nodeSrc(store, input.repositoryId);
        if (target === null || target[TYPE] !== 'Repository') throw new FieldError('repositoryId does not name a repository');
        const targetRepo = target.repo as Repo;
        const names = Array.isArray(input.labelNames) ? (input.labelNames as string[]) : [];
        for (const labelName of names) if (!targetRepo.labels.has(labelName)) throw new FieldError(`Label '${labelName}' does not exist`);
        const stamp = store.now();
        const issue: Issue = {
          id: store.newIssueId(),
          number: targetRepo.nextNumber,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: names,
          createdAt: stamp,
          updatedAt: stamp,
          comments: [],
        };
        targetRepo.nextNumber += 1;
        targetRepo.issues.set(issue.number, issue);
        return src('CreateIssuePayload', { issue: issueSrc(targetRepo, issue), clientMutationId: input.clientMutationId ?? null });
      }
      if (name === 'closeIssue') {
        const input = inputOf(field, ctx);
        const target = nodeSrc(store, input.issueId);
        if (target === null || target[TYPE] !== 'Issue') throw new FieldError('issueId does not name an issue');
        const issue = target.issue as Issue;
        issue.state = 'closed';
        issue.updatedAt = store.now();
        return src('CloseIssuePayload', { issue: target, clientMutationId: input.clientMutationId ?? null });
      }
      if (name === 'createPullRequest') {
        const input = inputOf(field, ctx);
        const target = nodeSrc(store, input.repositoryId);
        if (target === null || target[TYPE] !== 'Repository') throw new FieldError('repositoryId does not name a repository');
        const targetRepo = target.repo as Repo;
        const result = createPull(store, targetRepo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        });
        if ('error' in result) throw new FieldError(result.error);
        return src('CreatePullRequestPayload', { pullRequest: pullSrc(targetRepo, result.pull), clientMutationId: input.clientMutationId ?? null });
      }
      if (name === 'mergePullRequest') {
        const input = inputOf(field, ctx);
        const target = nodeSrc(store, input.pullRequestId);
        if (target === null || target[TYPE] !== 'PullRequest') throw new FieldError('pullRequestId does not name a pull request');
        const targetRepo = target.repo as Repo;
        const pull = target.pull as PullRequest;
        if (pull.state !== 'open') throw new FieldError('Pull request is not open');
        if (pullMergeability(targetRepo, pull) !== 'clean') throw new FieldError('Pull request is not mergeable');
        if (mergePull(store, targetRepo, pull) === null) throw new FieldError('Pull request is not mergeable');
        return src('MergePullRequestPayload', { pullRequest: target, clientMutationId: input.clientMutationId ?? null });
      }
      if (name === 'addComment') {
        const input = inputOf(field, ctx);
        const target = nodeSrc(store, input.subjectId);
        if (target === null || (target[TYPE] !== 'Issue' && target[TYPE] !== 'PullRequest')) throw new FieldError('subjectId does not name an issue or pull request');
        const targetRepo = target.repo as Repo;
        const holder = (target[TYPE] === 'Issue' ? target.issue : target.pull) as Issue | PullRequest;
        const stamp = store.now();
        const comment = { id: store.newCommentId(), body: typeof input.body === 'string' ? input.body : '', createdAt: stamp, updatedAt: stamp };
        holder.comments.push(comment);
        holder.updatedAt = stamp;
        return src('AddCommentPayload', {
          commentEdge: src('IssueCommentEdge', { node: commentSrc(targetRepo, comment), cursor: cursorOf(holder.comments.length) }),
          subject: target,
          clientMutationId: input.clientMutationId ?? null,
        });
      }
      break;
    }
    case 'User': {
      if (name === 'login') return VIEWER_LOGIN;
      if (name === 'id') return globalId('User', VIEWER_LOGIN);
      if (name === 'databaseId') return VIEWER_ID;
      if (name === 'name') return 'ada iversen';
      if (name === 'email') return 'adaiversen@example.invalid';
      if (name === 'url' || name === 'avatarUrl') return '';
      if (name === 'createdAt' || name === 'updatedAt') return '2026-01-01T00:00:00Z';
      break;
    }
    case 'Repository': {
      const found = repo as Repo;
      switch (name) {
        case 'id': return globalId('Repository', found.id);
        case 'databaseId': return found.id;
        case 'name': return found.name;
        case 'nameWithOwner': return `${found.owner}/${found.name}`;
        case 'description': return found.description;
        case 'owner': return userSrc();
        case 'isPrivate': return found.isPrivate;
        case 'isArchived': return false;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'url': return '';
        case 'createdAt': return isoOf(found.createdAt);
        case 'updatedAt': return isoOf(found.updatedAt);
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'licenseInfo': return null;
        case 'defaultBranchRef': {
          const oid = found.refs.get(`refs/heads/${found.defaultBranch}`);
          if (oid === undefined) return null;
          return src('Ref', { name: found.defaultBranch, targetOid: oid, repo: found });
        }
        case 'issue': {
          const number = resolveValue(field.args.get('number'), ctx.variables);
          const issue = typeof number === 'number' ? found.issues.get(number) : undefined;
          return issue === undefined ? null : issueSrc(found, issue);
        }
        case 'issues': {
          let issues = [...found.issues.values()];
          const states = resolveValue(field.args.get('states'), ctx.variables);
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = resolveValue(field.args.get('orderBy'), ctx.variables) as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'DESC' ? -1 : 1;
          issues.sort((a, b) => (a.number - b.number) * direction);
          return connectionSrc('IssueConnection', issues.map((issue) => issueSrc(found, issue)), field.args, ctx.variables);
        }
        case 'pullRequest': {
          const number = resolveValue(field.args.get('number'), ctx.variables);
          const pull = typeof number === 'number' ? found.pulls.get(number) : undefined;
          return pull === undefined ? null : pullSrc(found, pull);
        }
        case 'pullRequests': {
          let pulls = [...found.pulls.values()].sort((a, b) => a.number - b.number);
          const states = resolveValue(field.args.get('states'), ctx.variables);
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state)));
            pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          return connectionSrc('PullRequestConnection', pulls.map((pull) => pullSrc(found, pull)), field.args, ctx.variables);
        }
      }
      break;
    }
    case 'Issue': {
      const issue = source.issue as Issue;
      const owner = repo as Repo;
      switch (name) {
        case 'id': return globalId('Issue', `${owner.id}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'url': return '';
        case 'author': return userSrc();
        case 'createdAt': return isoOf(issue.createdAt);
        case 'updatedAt': return isoOf(issue.updatedAt);
        case 'repository': return repoSrc(owner);
        case 'labels': {
          const items = issue.labels
            .map((labelName) => owner.labels.get(labelName))
            .filter((label) => label !== undefined)
            .map((label) => src('Label', { label }));
          return connectionSrc('LabelConnection', items, field.args, ctx.variables);
        }
        case 'comments': {
          const items = issue.comments.map((comment) => commentSrc(owner, comment));
          return connectionSrc('IssueCommentConnection', items, field.args, ctx.variables);
        }
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.pull as PullRequest;
      const owner = repo as Repo;
      switch (name) {
        case 'id': return globalId('PullRequest', `${owner.id}:${pull.number}`);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'bodyText': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt !== null ? isoOf(pull.mergedAt) : null;
        case 'mergeable': {
          const ability = pullMergeability(owner, pull);
          return ability === 'clean' ? 'MERGEABLE' : ability === 'conflict' ? 'CONFLICTING' : 'UNKNOWN';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return owner.refs.get(`refs/heads/${pull.headRef}`) ?? null;
        case 'baseRefOid': return owner.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
        case 'isDraft': return false;
        case 'url': return '';
        case 'author': return userSrc();
        case 'createdAt': return isoOf(pull.createdAt);
        case 'updatedAt': return isoOf(pull.updatedAt);
        case 'repository': return repoSrc(owner);
        case 'headRef': {
          const oid = owner.refs.get(`refs/heads/${pull.headRef}`);
          return oid === undefined ? null : src('Ref', { name: pull.headRef, targetOid: oid, repo: owner });
        }
        case 'baseRef': {
          const oid = owner.refs.get(`refs/heads/${pull.baseRef}`);
          return oid === undefined ? null : src('Ref', { name: pull.baseRef, targetOid: oid, repo: owner });
        }
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : src('Commit', { oid: pull.mergeCommitSha, repo: owner });
        case 'files': {
          const items = pullFiles(owner, pull).map((file) => src('PullRequestFile', { file }));
          return connectionSrc('PullRequestFileConnection', items, field.args, ctx.variables);
        }
        case 'additions': return pullFiles(owner, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return pullFiles(owner, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return pullFiles(owner, pull).length;
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return source.name as string;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'id') return globalId('Ref', source.name as string);
      if (name === 'target') return src('Commit', { oid: source.targetOid as string, repo: source.repo as Repo | undefined });
      break;
    }
    case 'Commit': {
      if (name === 'oid') return source.oid as string;
      if (name === 'id') return globalId('Commit', source.oid as string);
      if (name === 'url') return '';
      if (name === 'message' || name === 'messageHeadline') {
        const owner = source.repo as Repo | undefined;
        if (owner === undefined) return '';
        const message = commitMessageOf(store, owner, source.oid as string);
        return name === 'message' ? message : (message.split('\n')[0] ?? '');
      }
      if (name === 'authoredDate' || name === 'committedDate') return '';
      break;
    }
    case 'Label': {
      const label = source.label as { id: number; name: string; color: string; description: string | null };
      if (name === 'id') return globalId('Label', label.id);
      if (name === 'name') return label.name;
      if (name === 'color') return label.color;
      if (name === 'description') return label.description;
      break;
    }
    case 'IssueComment': {
      const comment = source.comment as Issue['comments'][number];
      const owner = repo as Repo;
      if (name === 'id') return globalId('IssueComment', `${owner.id}:${comment.id}`);
      if (name === 'databaseId') return comment.id;
      if (name === 'body' || name === 'bodyText') return comment.body;
      if (name === 'author') return userSrc();
      if (name === 'createdAt') return isoOf(comment.createdAt);
      if (name === 'updatedAt') return isoOf(comment.updatedAt);
      if (name === 'url') return '';
      break;
    }
    case 'PullRequestFile': {
      const file = source.file as { path: string; additions: number; deletions: number; changeType: string };
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changeType') return file.changeType;
      break;
    }
  }

  // Connections, page info, edges and payloads resolve generically from their stored values.
  if (typeName.endsWith('Connection')) {
    if (name === 'nodes') return source.nodesValue as unknown;
    if (name === 'pageInfo') return src('PageInfo', source.pageInfoValue as Record<string, unknown>);
    if (name === 'totalCount') return source.totalCount as number;
    if (name === 'edges') {
      return (source.edgesValue as { node: Src; cursor: string }[]).map((edge) =>
        src(typeName.replace('Connection', 'Edge'), { node: edge.node, cursor: edge.cursor }),
      );
    }
  }
  if (typeName === 'PageInfo') {
    if (name in source) return source[name] as unknown;
  }
  if (typeName.endsWith('Edge')) {
    if (name === 'node') return source.node as unknown;
    if (name === 'cursor') return source.cursor as unknown;
  }
  if (typeName.endsWith('Payload')) {
    if (name in source) return source[name] as unknown;
  }
  if (typeName === '__Type') {
    if (name === 'name') return source.name as string;
    if (name === 'kind') return source.kind as string;
    if (name === 'description') return null;
    if (name === 'fields') {
      const fieldNames = source.fieldNames as string[] | null;
      return fieldNames === null ? null : fieldNames.map((fieldName) => src('__Field', { name: fieldName, parentType: source.name as string }));
    }
    if (name === 'enumValues') {
      const values = source.enumValues as string[] | null;
      return values === null ? null : values.map((value) => src('__EnumValue', { name: value }));
    }
    if (name === 'possibleTypes' || name === 'inputFields' || name === 'interfaces') return [];
    if (name === 'ofType') return null;
  }
  if (typeName === '__Field') {
    if (name === 'name') return source.name as string;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'args') return [];
    if (name === 'type') return typeSrc('String');
  }
  if (typeName === '__EnumValue') {
    if (name === 'name') return source.name as string;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
  }
  if (typeName === '__Schema') {
    if (name === 'types') {
      const names = [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)];
      return names.map((typeName) => typeSrc(typeName)).filter((entry) => entry !== null);
    }
    if (name === 'queryType') return typeSrc('Query');
    if (name === 'mutationType') return typeSrc('Mutation');
    if (name === 'directives') return [];
    if (name === 'description') return null;
  }
  if (typeName === 'RateLimit') {
    if (name in source) return source[name] as unknown;
  }

  // The meta fields live on Query but are easiest answered here.
  if (name === '__type') {
    const typeName = argString(field, 'name', ctx);
    return typeName === undefined ? null : typeSrc(typeName);
  }
  if (name === '__schema') return src('__Schema', {});

  throw new FieldError(`Field '${name}' doesn't exist on type '${typeName}'`);
}

/** Execute a selection set against a typed source, collecting field errors as it goes. */
function executeSet(typeName: string, source: Src, selection: FieldNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.spread !== undefined) {
      const fragment = ctx.fragments.get(field.spread);
      if (fragment !== undefined && fragment.type === typeName) Object.assign(out, executeSet(typeName, source, fragment.selection, ctx));
      continue;
    }
    if (field.fragmentType !== undefined) {
      if (field.fragmentType === typeName && field.selection !== null) Object.assign(out, executeSet(typeName, source, field.selection, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    try {
      const value = resolveField(typeName, source, field, ctx);
      out[key] = completeValue(value, field, ctx);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
      } else {
        throw error;
      }
    }
  }
  return out;
}

/** Apply a field's selection set to its resolved value (objects, lists, nulls, scalars). */
function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && TYPE in (value as Record<PropertyKey, unknown>)) {
    const typed = value as Src;
    if (field.selection === null) return {};
    return executeSet(typed[TYPE], typed, field.selection, ctx);
  }
  return value;
}

/** Run one GraphQL operation document (or a batch of them, answered in order). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => executeOne(store, entry));
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const query = typeof input.query === 'string' ? input.query : '';
  const variables = typeof input.variables === 'object' && input.variables !== null ? (input.variables as Record<string, unknown>) : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : undefined;
  let document: { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = document.operations.find((entry) => entry.type === 'mutation') ?? document.operations[0];
  void operationName;
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSet(rootType, src(rootType, {}), operation.selection, ctx);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return payload;
}

/** Resolve a commit for the Commit type's message fields (kept out of the hot switch). */
export function commitMessageOf(store: Store, repo: Repo, oid: string): string {
  const commitOid = resolveCommit(repo, oid);
  void store;
  if (commitOid === null) return '';
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  const match = /^tree [0-9a-f]+\n(?:parent [0-9a-f]+\n)*author [^\n]*\ncommitter [^\n]*\n\n([\s\S]*)$/.exec(object.data.toString('utf8'));
  return match?.[1]?.replace(/\n+$/, '') ?? '';
}
