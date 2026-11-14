// store.ts — the forge's in-memory store: repositories, git objects, issues, PRs.
// Everything is deterministic: ids and timestamps come from counters seeded at
// process start, never from the wall clock or Math.random, so a replay sees
// identical state.
//
// Memoization: git objects are immutable once stored, so parse results are
// cached per oid forever. Each repo carries a generation counter bumped on any
// mutation; response-level caches (fetch packs, serialized JSON, ref ads) are
// keyed by that generation and never go stale.
import {
  buildCommit, buildTree, collectReachable, hashObject, isAncestor, isObjectId,
  parseCommit, parseTag, parseTree, peelToCommit,
} from './gitcore.ts';
import type { CommitView, GitObject, GitObjectType, Lookup, TreeEntry } from './gitcore.ts';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label { name: string; color: string; description: string; }
export interface Comment { id: number; nodeId: string; body: string; createdAt: string; user: string; }
export interface Issue {
  number: number; id: number; nodeId: string; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; comments: Comment[];
  createdSeq: number; createdAt: string; updatedAt: string; user: string;
}
export interface Pull {
  number: number; id: number; nodeId: string; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; baseShaAtCreate: string;
  createdSeq: number; createdAt: string; updatedAt: string; user: string;
}
export interface Repo {
  id: number; owner: string; name: string; description: string; isPrivate: boolean;
  defaultBranch: string; createdSeq: number; createdAt: string; updatedAt: string;
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

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}

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
  nextSeq(): number { return ++this.seq; }

  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
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
    const s = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId++, owner, name, description, isPrivate,
      defaultBranch: 'main', createdSeq: this.nextSeq(), createdAt: s.iso, updatedAt: s.iso,
      refs: new Map(), objects: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(), nextNumber: 1,
      gen: 0, parsedCommits: new Map(), parsedTrees: new Map(),
      issueJsonCache: new Map(), repoJsonCache: null, fetchCache: new Map(), refsCache: null,
    };
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  lookup(repo: Repo): Lookup { return (oid) => repo.objects.get(oid); }

  /** Cached commit parse (objects are immutable). */
  commitOf(repo: Repo, oid: string): CommitView | null {
    let v = repo.parsedCommits.get(oid);
    if (v) return v;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    v = parseCommit(obj.data);
    repo.parsedCommits.set(oid, v);
    return v;
  }

  /** Cached tree parse (objects are immutable). */
  treeOf(repo: Repo, oid: string): TreeEntry[] | null {
    let v = repo.parsedTrees.get(oid);
    if (v) return v;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    v = parseTree(obj.data);
    repo.parsedTrees.set(oid, v);
    return v;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }

  /** All refs sorted by name. */
  sortedRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  defaultTip(repo: Repo): string | undefined { return repo.refs.get(`refs/heads/${repo.defaultBranch}`); }

  // ------------------------------------------------------------ trees
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.treeOf(repo, treeOid);
    if (!entries) return out;
    for (const e of entries) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** The blob oid at `path` in the tree, or null. */
  readPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const entries = this.treeOf(repo, cur);
      if (!entries) return null;
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry.mode === '40000' ? null : { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      cur = entry.oid;
    }
    return null;
  }

  /** New root tree oid with `path` set to `blobOid` (creating dirs), from `baseTreeOid`. */
  writePath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, { mode: string; oid: string }>();
      if (treeOid) {
        const cur = this.treeOf(repo, treeOid);
        if (cur) for (const e of cur) entries.set(e.name, { mode: e.mode, oid: e.oid });
      }
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
      const cur = this.treeOf(repo, treeOid);
      const entries = new Map<string, { mode: string; oid: string }>();
      if (cur) for (const e of cur) entries.set(e.name, { mode: e.mode, oid: e.oid });
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
    let cur = treeOid;
    if (dirPath !== '') {
      for (const part of dirPath.split('/').filter((p) => p !== '')) {
        const entries = this.treeOf(repo, cur);
        if (!entries) return null;
        const entry = entries.find((e) => e.name === part && e.mode === '40000');
        if (!entry) return null;
        cur = entry.oid;
      }
    }
    const entries = this.treeOf(repo, cur);
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
    const s = this.stamp();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message, author: who, committer: who, timestamp: s.epoch });
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

  // ------------------------------------------------------------ issues / pulls
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const s = this.stamp();
    const issue: Issue = {
      number, id: 100000 + number * 7 + (repo.id % 1000), nodeId: gid('I', repo.id, number),
      title, body, state: 'open', labels: [...labels], comments: [],
      createdSeq: this.nextSeq(), createdAt: s.iso, updatedAt: s.iso, user: VIEWER.login,
    };
    repo.issues.set(number, issue);
    this.touch(repo);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const s = this.stamp();
    const pull: Pull = {
      number, id: 200000 + number * 7 + (repo.id % 1000), nodeId: gid('P', repo.id, number),
      title, body, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef, baseRef, headSha, baseSha, baseShaAtCreate: baseSha,
      createdSeq: this.nextSeq(), createdAt: s.iso, updatedAt: s.iso, user: VIEWER.login,
    };
    repo.pulls.set(number, pull);
    this.touch(repo);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const s = this.stamp();
    const id = this.nextCommentId++;
    const comment: Comment = { id, nodeId: gid('C', repo.id, issue.number, id), body, createdAt: s.iso, user: VIEWER.login };
    issue.comments.push(comment);
    this.touchIssue(repo, issue.number);
    return comment;
  }

  // ------------------------------------------------------------ diff / merge
  diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      let additions = 0;
      let deletions = 0;
      const linesOf = (oid: string | undefined): string[] => {
        if (!oid) return [];
        const obj = repo.objects.get(oid);
        if (!obj) return [];
        const text = obj.data.toString('utf8');
        const lines = text.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines;
      };
      if (!b && h) {
        additions = linesOf(h.oid).length;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && !h) {
        deletions = linesOf(b.oid).length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b && h) {
        const oldLines = linesOf(b.oid);
        const newLines = linesOf(h.oid);
        const oldCount = new Map<string, number>();
        for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
        for (const l of newLines) {
          const c = oldCount.get(l) ?? 0;
          if (c > 0) oldCount.set(l, c - 1);
          else additions++;
        }
        for (const c of oldCount.values()) deletions += c;
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
    const changedIn = (a: Map<string, { oid: string }>, b: Map<string, { oid: string }>): Set<string> => {
      const out = new Set<string>();
      for (const [p, v] of a) if (b.get(p)?.oid !== v.oid) out.add(p);
      for (const p of b.keys()) if (!a.has(p)) out.add(p);
      return out;
    };
    const headChanged = changedIn(mergeBaseTree, headTree);
    const baseChanged = changedIn(mergeBaseTree, baseTree);
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
    const s = this.stamp();
    const sha = this.makeCommit(repo, headView.tree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = s.iso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = s.iso;
    this.touch(repo);
    return sha;
  }

  // ------------------------------------------------------------ git helpers
  reachableFrom(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo));
  }

  peel(repo: Repo, oid: string): string | null { return peelToCommit(this.lookup(repo), oid); }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(this.lookup(repo), ancestor, tip);
  }
}

export function commitMessageOf(repo: Repo, oid: string): string {
  const view = repo.parsedCommits.get(oid);
  if (view) return view.message;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

export function parseTagOf(repo: Repo, oid: string): { object: string; type: GitObjectType; tag: string } | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const t = parseTag(obj.data);
  return { object: t.object, type: t.type, tag: t.tag };
}
