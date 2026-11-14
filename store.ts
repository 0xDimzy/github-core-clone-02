// store.ts — the forge's in-memory store: repositories, git objects, issues, PRs.
// Everything is deterministic: ids and timestamps come from counters seeded at
// process start, never from the wall clock or Math.random, so a replay sees
// identical state.
//
// Memoization: git objects are immutable once stored, so parse results are
// cached per oid forever. Each repo carries a generation counter bumped on any
// mutation; response-level caches (fetch packs, serialized JSON, ref ads) are
// keyed by that generation and never go stale.
//
// Layout of this file:
//   1. Record types — Issue, Pull, Comment, Label, Repo
//   2. Global ids — gid / decodeGid
//   3. Forge — repos, refs, objects, issues, pulls, diff/merge
//   4. Module helpers — line diffs, changed paths, record factories
import {
  buildCommit, buildTree, collectReachable, hashObject, isAncestor, isObjectId,
  parseCommit, parseTag, parseTree, peelToCommit,
} from './gitcore.ts';
import type { CommitView, GitObject, GitObjectType, Lookup, TreeEntry } from './gitcore.ts';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------- 1. Records

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  user: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  user: string;
}

export interface Pull {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  baseShaAtCreate: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  user: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  /** Bumped on any mutation to this repo (refs, objects, issues, pulls, labels). */
  gen: number;
  /** Parsed commit/tree views, cached per oid (objects are immutable). */
  parsedCommits: Map<string, CommitView>;
  parsedTrees: Map<string, TreeEntry[]>;
  /** Serialized REST issue JSON per issue number (invalidated on issue mutation). */
  issueJsonCache: Map<number, Buffer>;
  /** Serialized REST repo JSON (invalidated on repo mutation). */
  repoJsonCache: Buffer | null;
  /** Cached fetch computations: plan signature -> {gen, result}. */
  fetchCache: Map<string, { gen: number; acks: string[]; shallow: string[]; unshallow: string[]; pack: Buffer }>;
  /** Cached v0 ref-advertisement bodies (invalidated when gen changes). */
  refsCache: { gen: number; upload: Buffer; receive: Buffer } | null;
}

// ---------------------------------------------------------------- 2. Global ids

/** Encode a global node id: base64url of `Kind:part:part`. */
export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

/** Decode a global node id back to its kind and parts, or null. */
export function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 3. Forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextCommentId = 1;
  private seq = 0;
  private clock = 1700000000;

  /** Monotonic deterministic timestamp: one second per call from a fixed epoch. */
  stamp(): { epoch: number; iso: string } {
    const epoch = this.clock++;
    return { epoch, iso: new Date(epoch * 1000).toISOString() };
  }

  nextSeq(): number {
    return ++this.seq;
  }

  // -- repo registry ----------------------------------------------

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const r of this.repos.values()) if (r.id === id) return r;
    return undefined;
  }

  /** Bump a repo's generation and drop its generation-keyed caches. */
  touch(repo: Repo): void {
    repo.gen++;
    repo.repoJsonCache = null;
    repo.refsCache = null;
  }

  /** Drop one issue's serialized cache (its content changed). */
  touchIssue(repo: Repo, number: number): void {
    repo.issueJsonCache.delete(number);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const stamp = this.stamp();
    const repo = newRepoRecord(this.nextRepoId++, owner, name, description, isPrivate, stamp, this.nextSeq());
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** All of an owner's repos, oldest first. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -- objects -----------------------------------------------------

  lookup(repo: Repo): Lookup {
    return (oid) => repo.objects.get(oid);
  }

  /** Cached commit parse (objects are immutable). */
  commitOf(repo: Repo, oid: string): CommitView | null {
    const cached = repo.parsedCommits.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    repo.parsedCommits.set(oid, parsed);
    return parsed;
  }

  /** Cached tree parse (objects are immutable). */
  treeOf(repo: Repo, oid: string): TreeEntry[] | null {
    const cached = repo.parsedTrees.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const parsed = parseTree(obj.data);
    repo.parsedTrees.set(oid, parsed);
    return parsed;
  }

  /** The entries of a tree as a name -> {mode, oid} map (empty when missing). */
  treeMap(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const entries = new Map<string, { mode: string; oid: string }>();
    if (!treeOid) return entries;
    const parsed = this.treeOf(repo, treeOid);
    if (parsed) {
      for (const e of parsed) entries.set(e.name, { mode: e.mode, oid: e.oid });
    }
    return entries;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  // -- refs --------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All refs sorted by name. */
  sortedRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  // -- trees -------------------------------------------------------

  /** Follow `dirPath` down from `treeOid`, returning the child tree oid, or null. */
  descendToDir(repo: Repo, treeOid: string, dirPath: string): string | null {
    let current = treeOid;
    for (const part of dirPath.split('/').filter((p) => p !== '')) {
      const entries = this.treeOf(repo, current);
      if (!entries) return null;
      const entry = findTreeEntry(entries, part, '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** All files under a tree, as path -> {oid, mode}, recursing into subdirs. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.treeOf(repo, treeOid);
    if (!entries) return out;
    for (const e of entries) {
      const path = joinChildPath(prefix, e.name);
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** The blob oid at `path` in the tree, or null. */
  readPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) return null;
    const parentOid = this.descendToDir(repo, treeOid, parts.slice(0, -1).join('/'));
    if (parentOid === null) return null;
    const entries = this.treeOf(repo, parentOid);
    if (!entries) return null;
    const entry = findTreeEntry(entries, parts[parts.length - 1]);
    if (!entry || entry.mode === '40000') return null;
    return { oid: entry.oid, mode: entry.mode };
  }

  /** New root tree oid with `path` set to `blobOid` (creating dirs), from `baseTreeOid`. */
  writePath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (treeOid: string | null, depth: number): string => {
      const entries = this.treeMap(repo, treeOid);
      const name = parts[depth];
      if (depth === parts.length - 1) {
        entries.set(name, { mode: '100644', oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = rec(child && child.mode === '40000' ? child.oid : null, depth + 1);
        entries.set(name, { mode: '40000', oid: childTree });
      }
      return this.putObject(repo, 'tree', buildTree([...entries.entries()].map(([n, v]) => ({ mode: v.mode, name: n, oid: v.oid }))));
    };
    return rec(baseTreeOid, 0);
  }

  /** New root tree oid with `path` removed (pruning dirs left empty). */
  deletePath(repo: Repo, baseTreeOid: string, path: string): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (treeOid: string, depth: number): string | null => {
      const entries = this.treeMap(repo, treeOid);
      const name = parts[depth];
      if (depth === parts.length - 1) {
        entries.delete(name);
      } else {
        const child = entries.get(name);
        if (!child || child.mode !== '40000') return treeOid;
        const next = rec(child.oid, depth + 1);
        if (next === null) entries.delete(name);
        else entries.set(name, { mode: '40000', oid: next });
      }
      if (entries.size === 0) return null;
      return this.putObject(repo, 'tree', buildTree([...entries.entries()].map(([n, v]) => ({ mode: v.mode, name: n, oid: v.oid }))));
    };
    return rec(baseTreeOid, 0) ?? EMPTY_TREE_OID;
  }

  /** Direct children of a directory tree: files and subdirectories. */
  listDir(repo: Repo, treeOid: string, dirPath: string): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; mode: string }> | null {
    const target = dirPath === '' ? treeOid : this.descendToDir(repo, treeOid, dirPath);
    if (target === null) return null;
    const entries = this.treeOf(repo, target);
    if (!entries) return null;
    return entries.map((e) => ({
      name: e.name,
      path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
      type: e.mode === '40000' ? 'dir' as const : 'file' as const,
      oid: e.oid,
      mode: e.mode,
    }));
  }

  /** Create a commit object on top of `parentOid` (or root) with `treeOid` and store it. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const stamp = this.stamp();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message, author: who, committer: who, timestamp: stamp.epoch });
    return this.putObject(repo, 'commit', data);
  }

  /** Walk commits from `tip`, newest first (parent order), visiting each once. */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid) || !isObjectId(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(repo, oid);
      if (!view) continue;
      out.push(oid);
      for (const p of view.parents) queue.push(p);
    }
    return out;
  }

  // -- issues / pulls ----------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const stamp = this.stamp();
    const issue = newIssueRecord(repo, number, title, body, labels, stamp, this.nextSeq());
    repo.issues.set(number, issue);
    this.touch(repo);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const stamp = this.stamp();
    const pull = newPullRecord(repo, number, title, body, headRef, baseRef, headSha, baseSha, stamp, this.nextSeq());
    repo.pulls.set(number, pull);
    this.touch(repo);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const stamp = this.stamp();
    const comment = newCommentRecord(repo, issue, this.nextCommentId++, body, stamp);
    issue.comments.push(comment);
    this.touchIssue(repo, issue.number);
    return comment;
  }

  // -- diff / merge -------------------------------------------------

  /** Line-level diff between two trees, one entry per changed path. */
  diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        const additions = linesOfObject(repo, h.oid).length;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && !h) {
        const deletions = linesOfObject(repo, b.oid).length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b && h) {
        const { additions, deletions } = countLineChanges(linesOfObject(repo, b.oid), linesOfObject(repo, h.oid));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** The files a PR changes: base tip at creation vs current head tip. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const headView = headTip ? this.commitOf(repo, headTip) : null;
    const baseView = this.commitOf(repo, pull.baseSha);
    if (!headView || !baseView) return [];
    return this.diffFiles(repo, baseView.tree, headView.tree);
  }

  /** True when merging `pull` would conflict with the current base tip. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return false;
    const baseView = this.commitOf(repo, baseTip);
    const headView = this.commitOf(repo, headTip);
    const mergeBaseView = this.commitOf(repo, pull.baseShaAtCreate);
    if (!baseView || !headView || !mergeBaseView) return false;
    const baseTree = this.flattenTree(repo, baseView.tree);
    const headTree = this.flattenTree(repo, headView.tree);
    const mergeBaseTree = this.flattenTree(repo, mergeBaseView.tree);
    const headChanged = changedPaths(mergeBaseTree, headTree);
    const baseChanged = changedPaths(mergeBaseTree, baseTree);
    for (const p of headChanged) {
      if (baseChanged.has(p) && headTree.get(p)?.oid !== baseTree.get(p)?.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null when conflicted. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return null;
    const headView = this.commitOf(repo, headTip);
    if (!headView) return null;
    const stamp = this.stamp();
    const sha = this.makeCommit(repo, headView.tree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp.iso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = stamp.iso;
    this.touch(repo);
    return sha;
  }

  // -- git helpers --------------------------------------------------

  reachableFrom(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo));
  }

  peel(repo: Repo, oid: string): string | null {
    return peelToCommit(this.lookup(repo), oid);
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(this.lookup(repo), ancestor, tip);
  }
}

// ---------------------------------------------------------------- 4. Helpers

/** Join a child name onto a tree path prefix. */
function joinChildPath(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** Find a tree entry by name, optionally requiring a mode (e.g. '40000' for dirs). */
function findTreeEntry(entries: TreeEntry[], name: string, mode?: string): TreeEntry | undefined {
  return entries.find((e) => e.name === name && (mode === undefined || e.mode === mode));
}

/** A fresh, empty repo record with all caches initialized. */
function newRepoRecord(
  id: number,
  owner: string,
  name: string,
  description: string,
  isPrivate: boolean,
  stamp: { epoch: number; iso: string },
  seq: number,
): Repo {
  return {
    id,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdSeq: seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    gen: 0,
    parsedCommits: new Map(),
    parsedTrees: new Map(),
    issueJsonCache: new Map(),
    repoJsonCache: null,
    fetchCache: new Map(),
    refsCache: null,
  };
}

/** A fresh issue record. The id is derived deterministically from number + repo. */
function newIssueRecord(
  repo: Repo,
  number: number,
  title: string,
  body: string,
  labels: string[],
  stamp: { iso: string },
  seq: number,
): Issue {
  return {
    number,
    id: 100000 + number * 7 + (repo.id % 1000),
    nodeId: gid('I', repo.id, number),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    user: VIEWER.login,
  };
}

/** A fresh pull-request record. */
function newPullRecord(
  repo: Repo,
  number: number,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
  headSha: string,
  baseSha: string,
  stamp: { iso: string },
  seq: number,
): Pull {
  return {
    number,
    id: 200000 + number * 7 + (repo.id % 1000),
    nodeId: gid('P', repo.id, number),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    baseShaAtCreate: baseSha,
    createdSeq: seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    user: VIEWER.login,
  };
}

/** A fresh comment record on an issue. */
function newCommentRecord(
  repo: Repo,
  issue: Issue,
  id: number,
  body: string,
  stamp: { iso: string },
): Comment {
  return {
    id,
    nodeId: gid('C', repo.id, issue.number, id),
    body,
    createdAt: stamp.iso,
    user: VIEWER.login,
  };
}

/** The lines of a blob object (trailing empty line dropped), or [] when missing. */
function linesOfObject(repo: Repo, oid: string | undefined): string[] {
  if (!oid) return [];
  const obj = repo.objects.get(oid);
  if (!obj) return [];
  const lines = obj.data.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Count added/deleted lines between two versions, matching identical lines. */
function countLineChanges(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions++;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

/** Paths whose content differs between two flattened trees (either side). */
function changedPaths(before: Map<string, { oid: string }>, after: Map<string, { oid: string }>): Set<string> {
  const changed = new Set<string>();
  for (const [path, entry] of before) {
    if (after.get(path)?.oid !== entry.oid) changed.add(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed.add(path);
  }
  return changed;
}

/** The message of a commit, from the parse cache when available. */
export function commitMessageOf(repo: Repo, oid: string): string {
  const view = repo.parsedCommits.get(oid);
  if (view) return view.message;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

/** The tag object a tag oid points at, or null. */
export function parseTagOf(repo: Repo, oid: string): { object: string; type: GitObjectType; tag: string } | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const t = parseTag(obj.data);
  return { object: t.object, type: t.type, tag: t.tag };
}
