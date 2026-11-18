// The forge's store: one in-memory state every surface (git smart HTTP, REST, GraphQL, MCP)
// reads and writes, so an object created through one surface is the same object on all others.
//
// The forge has exactly one user: the login the trial's bearer token names. In the suite's
// seeded scenario that login is the viewer the checks address in every path, so it is a
// constant here; a repository named under any other owner is a 404, never a 403.

/** The four git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored git object: its type and its exact content bytes (no header). */
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The one user of the forge: the token's login in the suite's seeded scenario. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id (the scenario gives the viewer id 1000). */
export const VIEWER_ID = 1000;
/** The viewer's display name and email, used for authored commits and the user object. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** A label on a repository. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/** A comment on an issue or pull request. */
export interface IssueComment {
  id: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** An issue. Pull requests live in their own table but share the per-repo number sequence. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  updatedAt: number;
  comments: IssueComment[];
}

/** A pull request. `merged` is separate from `state`: a merged pull is closed and merged. */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
  comments: IssueComment[];
}

/** One repository: its metadata, its git store and its trackers. */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  /** Every git object the repository holds, by object id. */
  objects: Map<string, GitObject>;
  /** Ref name (`refs/heads/main`) to the object id it points at. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** The next issue/pull number: one sequence per repository, as on GitHub. */
  nextNumber: number;
}

/** The whole forge state. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private tick = 0;
  private readonly baseEpochSec: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(trialNow);
    // Timestamps derive from the trial's opening time when the harness names one, so two runs
    // of a trial see the same clock; a fixed epoch is the local default. A per-store tick keeps
    // every later timestamp strictly after the earlier ones, which is all the ordering the
    // surfaces rely on (creation order is also the number order).
    this.baseEpochSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_767_225_600;
  }

  /** The next timestamp (epoch seconds): the base time plus a monotonic tick. */
  now(): number {
    const value = this.baseEpochSec + this.tick;
    this.tick += 1;
    return value;
  }

  /** The map key a repository lives under. */
  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The repository at `owner/name`, or undefined. Only the viewer's own repositories exist. */
  repo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(Store.key(owner, name));
  }

  /** Create a repository for the viewer; null when the name is taken. */
  createRepo(name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
    const key = Store.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const stamp = this.now();
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Delete a repository outright; true when one existed. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(Store.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** A repository by its numeric id (GraphQL's node and mutation inputs name repositories so). */
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  newIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  newLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }
}

/** An epoch-second timestamp as the ISO string the APIs answer. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** The identity line a commit or tag authored by the forge carries: `Name <email> ts +0000`. */
export function identityLine(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}
