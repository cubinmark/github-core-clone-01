// The git layer: object model, packfiles, pkt-lines and the smart-HTTP protocol, implemented
// in-process on node:crypto and node:zlib. The forge never shells out to a git binary: objects
// are hashed, stored, packed and served by this module, and pushes are unpacked and validated
// here (every branch update must fast-forward, refused per ref as `ng <ref> non-fast-forward`).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// object model

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repository (idempotent) and answer its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of [...entries].sort(compareTreeNames)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  let object = '';
  let type = '';
  let tag = '';
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
  }
  return { object, type, tag };
}

/** The commit a tag (chain) points at, or null when the chain does not end at a stored commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Every object reachable from `tips` (commits walk to trees and parents, tags to targets). */
export function collectClosure(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** A common ancestor of two commits (nearest by breadth), or null when there is none. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Map<string, number>();
  let frontier = [a];
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestors.has(oid)) continue;
      ancestors.set(oid, depth);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
    depth += 1;
  }
  const seen = new Set<string>();
  frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const known = ancestors.get(oid);
      if (known !== undefined && known < bestDepth) {
        best = oid;
        bestDepth = known;
      }
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    if (best !== null) return best;
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// trees as flat path maps

/** A tree flattened to `path -> {mode, oid}`; directories appear only through their files. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** The tree at the tip of a commit id, or null when the commit is unknown. */
export function treeOfCommit(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Build (and store) the tree objects for a flat path map; answers the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The lines of a blob's text (a trailing newline does not add an empty line). */
export function textLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a change from one blob to another (a simple LCS diff; files here are small). */
function diffCounts(repo: Repo, beforeOid: string | null, afterOid: string | null): { additions: number; deletions: number } {
  const before = beforeOid === null ? [] : textLines(repo.objects.get(beforeOid)?.data ?? Buffer.alloc(0));
  const after = afterOid === null ? [] : textLines(repo.objects.get(afterOid)?.data ?? Buffer.alloc(0));
  const m = before.length;
  const n = after.length;
  // LCS lengths, one row at a time.
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = new Array<number>(n + 1).fill(0);
    for (let j = n - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? (prev[j + 1] as number) + 1 : Math.max(prev[j] as number, row[j + 1] as number);
    }
    prev = row;
  }
  const common = prev[0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The file changes between two flat tree maps, sorted by path. */
export function diffFlats(
  repo: Repo,
  before: ReadonlyMap<string, { mode: string; oid: string }>,
  after: ReadonlyMap<string, { mode: string; oid: string }>,
): FileChange[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = before.get(path);
    const to = after.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid && from.mode === to.mode) continue;
    const counts = diffCounts(repo, from?.oid ?? null, to?.oid ?? null);
    changes.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

/**
 * A file-level three-way merge of two flat trees against their base. A path changed on only
 * one side takes that side; changed identically on both takes it; changed differently on
 * both is a conflict. Answers the merged flat map, or null on a conflict.
 */
export function mergeFlats(
  base: ReadonlyMap<string, { mode: string; oid: string }>,
  ours: ReadonlyMap<string, { mode: string; oid: string }>,
  theirs: ReadonlyMap<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
    x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const out = new Map<string, { mode: string; oid: string }>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let winner: { mode: string; oid: string } | undefined;
    if (same(o, t)) winner = o;
    else if (same(b, o)) winner = t;
    else if (same(b, t)) winner = o;
    else return null;
    if (winner !== undefined) out.set(path, winner);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles

/** Encode one object's pack header (the type/size varint). */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries; a
 * REF_DELTA base the pack leaves out (a thin pack) is taken from `external` (the store).
 * Throws on any structural problem or checksum mismatch.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    // Inflate exactly one zlib stream starting at `offset`: inflateSync with `info` reports
    // how many input bytes the stream consumed.
    const result = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = result.buffer;
    offset += result.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved !== undefined && entry.oid !== undefined) return entry.resolved;
    let resolved: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid as string);
      const base = baseEntry !== undefined ? resolve(baseEntry) : external?.(entry.baseOid as string);
      if (base === undefined) throw new Error('ref-delta base is not available');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    entry.resolved = resolved;
    entry.oid = hashObject(resolved.type, resolved.data);
    byOid.set(entry.oid, entry);
    return resolved;
  };
  // A delta's base usually precedes it in the pack, but nothing requires that order: resolve
  // in passes until every entry is done (each pass resolves at least the plain objects).
  const objects = new Map<string, GitObject>();
  const pending = new Set(raw);
  while (pending.size > 0) {
    let progressed = false;
    for (const entry of [...pending]) {
      try {
        const resolved = resolve(entry);
        objects.set(entry.oid as string, resolved);
        pending.delete(entry);
        progressed = true;
      } catch {
        // The base is not resolved yet; a later pass retries this entry.
      }
    }
    if (!progressed) throw new Error('pack has an unresolvable delta');
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines

/** Encode one data pkt-line. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = Buffer | 'flush' | 'delim';

/** Decode the pkt-lines at the start of `body`; `rest` is what follows the first flush. */
export function decodePackets(body: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      return { packets, rest: body.subarray(offset) };
    }
    if (length === 1) {
      packets.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      return { packets, rest: body.subarray(offset) };
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { packets, rest: body.subarray(offset) };
}

/** Split a byte stream into sideband pkt-lines (band byte + chunk), for fetch/push answers. */
export function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32_768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// smart HTTP

/** The result of one git HTTP call: status, content type and the exact body bytes. */
export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'agent=forge/1.0.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not ${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta ${AGENT}`;

/** Every ref of a repository, sorted by name (tags included, HEAD is not a stored ref). */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The object id a ref's target peels to when it is an annotated tag, else undefined. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = repo.objects.get(current);
    if (next === undefined || next.type !== 'tag') break;
    current = parseTag(next.data).object;
  }
  return current === oid ? undefined : current;
}

/** `GET /info/refs`: the v2 capability list, or the v0 ref advertisement. */
export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): GitHttpResult {
  const contentType = `application/x-${service}-advertisement`;
  if (version2 && service === 'git-upload-pack') {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType, body };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refLine = (oid: string, name: string, withCaps: boolean): void => {
    lines.push(pktLine(withCaps ? `${oid} ${name}\0${caps}${service === 'git-upload-pack' && headOid !== undefined ? ` symref=HEAD:${headRef}` : ''}\n` : `${oid} ${name}\n`));
    const peeled = peeledOf(repo, oid);
    if (peeled !== undefined) lines.push(pktLine(`${peeled} ${name}^{}\n`));
  };
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else if (headOid !== undefined) {
    lines.push(pktLine(`${headOid} HEAD\0${caps} symref=HEAD:${headRef}\n`));
    for (const [name, oid] of refs) refLine(oid, name, false);
  } else {
    refs.forEach(([name, oid], index) => refLine(oid, name, index === 0));
  }
  lines.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(lines) };
}

/** Split a protocol request into its command section (before the delim) and its arguments. */
function splitSections(packets: Packet[]): { head: string[]; args: string[] } {
  const head: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet === 'flush') break;
    (inArgs ? args : head).push(packet.toString('utf8').replace(/\n$/, ''));
  }
  return { head, args };
}

/** The objects a client already has: full closure of its haves, stopping at its shallow edge. */
function clientHasClosure(repo: Repo, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const has = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      for (const oid of collectClosure(repo, [have])) has.add(oid);
      continue;
    }
    const seen = new Set<string>();
    const queue = [have];
    while (queue.length > 0) {
      const commitOid = queue.pop() as string;
      if (seen.has(commitOid)) continue;
      seen.add(commitOid);
      const commitObject = repo.objects.get(commitOid);
      if (commitObject === undefined || commitObject.type !== 'commit') continue;
      const commit = parseCommit(commitObject.data);
      has.add(commitOid);
      for (const oid of collectClosure(repo, [commit.tree])) has.add(oid);
      if (!shallow.has(commitOid)) queue.push(...commit.parents);
    }
  }
  return has;
}

interface FetchPlan {
  /** The pack to send (possibly an empty, valid pack). */
  pack: Buffer;
  /** Commits to report as the client's new shallow boundary. */
  shallow: string[];
  /** Previously shallow commits whose parents are now included. */
  unshallow: string[];
}

/** Compute the pack and the shallow report for one fetch. */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  const has = clientHasClosure(repo, haves, clientShallow);
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  if (depth === null) {
    for (const oid of collectClosure(repo, wants)) included.add(oid);
    for (const oid of included) if (repo.objects.get(oid)?.type === 'commit') includedCommits.add(oid);
  } else {
    const generation = new Map<string, number>();
    let frontier: string[] = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object === undefined) continue;
      included.add(want);
      const commitOid = object.type === 'commit' ? want : peelToCommit(repo, want);
      if (commitOid !== null) frontier.push(commitOid);
    }
    let gen = 1;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const commitOid of frontier) {
        const known = generation.get(commitOid);
        if (known !== undefined && known <= gen) continue;
        generation.set(commitOid, gen);
        includedCommits.add(commitOid);
        const commitObject = repo.objects.get(commitOid);
        if (commitObject === undefined || commitObject.type !== 'commit') continue;
        const commit = parseCommit(commitObject.data);
        included.add(commitOid);
        for (const oid of collectClosure(repo, [commit.tree])) included.add(oid);
        if (gen < depth) next.push(...commit.parents);
      }
      frontier = next;
      gen += 1;
    }
  }
  const boundary = new Set<string>();
  if (depth !== null) {
    for (const commitOid of includedCommits) {
      const commitObject = repo.objects.get(commitOid);
      if (commitObject === undefined || commitObject.type !== 'commit') continue;
      const commit = parseCommit(commitObject.data);
      if (commit.parents.some((parent) => repo.objects.has(parent) && !includedCommits.has(parent))) boundary.add(commitOid);
    }
  }
  const unshallow = [...clientShallow].filter((oid) => includedCommits.has(oid) && !boundary.has(oid));
  const send = [...included].filter((oid) => !has.has(oid));
  const rank: Record<GitObjectType, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  send.sort((a, b) => {
    const left = repo.objects.get(a) as GitObject;
    const right = repo.objects.get(b) as GitObject;
    return rank[left.type] - rank[right.type] || (a < b ? -1 : 1);
  });
  const pack = writePack(send.map((oid) => repo.objects.get(oid) as GitObject));
  return { pack, shallow: [...boundary], unshallow };
}

/** `POST /git-upload-pack`: protocol v2 (`ls-refs`, `fetch`) and the v0 fetch fallback. */
export function uploadPack(repo: Repo, body: Buffer, version2: boolean): GitHttpResult {
  const contentType = 'application/x-git-upload-pack-result';
  if (version2) {
    const { packets } = decodePackets(body);
    const { head, args } = splitSections(packets);
    const commandLine = head.find((line) => line.startsWith('command='));
    const command = commandLine?.slice('command='.length);
    if (command === 'ls-refs') return { status: 200, contentType, body: lsRefs(repo, args) };
    if (command === 'fetch') return { status: 200, contentType, body: fetchV2(repo, args) };
    throw new Error(`unsupported protocol v2 command ${command ?? '(none)'}`);
  }
  return { status: 200, contentType, body: fetchV0(repo, body) };
}

function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  sideband: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, sideband: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'side-band-all' || arg.startsWith('side-band')) parsed.sideband = true;
  }
  return parsed;
}

function fetchV2(repo: Repo, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const done = args.includes('done');
  const common = parsed.haves.find((have) => repo.objects.get(have)?.type === 'commit');
  // Negotiation shape, as git's own client drives it: a request with `done` is answered by the
  // pack sections alone. A request without `done` first gets an acknowledgments section — and
  // when the server is ready (a common base is known, or there was nothing to negotiate) the
  // `ready` line in it means the pack sections follow in the SAME response. Only a round with
  // haves but no common base stands alone (NAK), inviting more haves or a `done`.
  if (!done && parsed.haves.length > 0 && common === undefined) {
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM, PKT_FLUSH]);
  }
  const plan = planFetch(repo, parsed.wants, parsed.haves, new Set(parsed.shallow), parsed.depth);
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, body: Buffer): Buffer {
  const first = decodePackets(body);
  const wantLines: string[] = [];
  const shallow: string[] = [];
  let sideband = false;
  for (const packet of first.packets) {
    if (packet === 'flush' || packet === 'delim') continue;
    const text = packet.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const space = rest.indexOf(' ');
      wantLines.push((space < 0 ? rest : rest.slice(0, space)).trim());
      if (space >= 0 && rest.slice(space + 1).includes('side-band-64k')) sideband = true;
    } else if (text.startsWith('shallow ')) {
      shallow.push(text.slice(8).trim());
    }
  }
  const haves: string[] = [];
  if (first.rest.length > 0) {
    const second = decodePackets(first.rest);
    for (const packet of second.packets) {
      if (packet === 'flush' || packet === 'delim') continue;
      const text = packet.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const plan = planFetch(repo, wantLines, haves, new Set(shallow), null);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = haves.find((have) => repo.objects.get(have)?.type === 'commit');
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  if (sideband) parts.push(...sidebandPackets(plan.pack, 1));
  else parts.push(plan.pack);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** `POST /git-receive-pack`: unpack, validate each ref update on its own, report per ref. */
export function receivePack(repo: Repo, body: Buffer): GitHttpResult {
  const contentType = 'application/x-git-receive-pack-result';
  const { packets, rest } = decodePackets(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  packets.forEach((packet, index) => {
    if (packet === 'flush' || packet === 'delim') return;
    let text = packet.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const fields = text.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
  });

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }

  const report: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const command of commands) {
    const refuse = (reason: string): void => {
      report.push(pktLine(`ng ${command.ref} ${reason}\n`));
    };
    const accept = (): void => {
      report.push(pktLine(`ok ${command.ref}\n`));
    };
    if (unpackError !== null) {
      refuse('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      refuse('funny refname');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // A delete: the ref must exist at the named old value.
      if (current === ZERO_OID) refuse('reference does not exist');
      else if (current !== command.oldOid) refuse('stale info');
      else {
        repo.refs.delete(command.ref);
        accept();
      }
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      refuse('nonexistent object');
      continue;
    }
    if (current !== command.oldOid) {
      refuse(command.oldOid === ZERO_OID ? 'already exists' : 'stale info');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        refuse('not a commit');
        continue;
      }
      if (current !== ZERO_OID && command.newOid !== current && !isAncestor(repo, current, command.newOid)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    accept();
  }
  report.push(PKT_FLUSH);
  const inner = Buffer.concat(report);
  const framed = capabilities.includes('side-band-64k')
    ? Buffer.concat([...sidebandPackets(inner, 1), PKT_FLUSH])
    : inner;
  return { status: 200, contentType, body: framed };
}
