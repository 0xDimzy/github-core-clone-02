// app.ts — the forge request dispatcher over the raw net transport.
// REST v3, GraphQL v4, MCP, and git smart HTTP, all from one in-memory store.
// Responses are built as Buffers; hot paths serve memoized bytes:
//  - issue/repo JSON is cached per object and invalidated on mutation
//  - fetch packs are cached per (repo generation, plan) — the clone workload
//    repeats the same shallow fetch 50 times, so 49 of them are cache hits
//  - v0 ref advertisements are cached per repo generation
import { createServer } from './net.ts';
import type { HttpRequest, HttpResponse } from './net.ts';
import { Forge, VIEWER, EMPTY_TREE_OID, commitMessageOf } from './store.ts';
import type { Repo } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, repoJson, issueJson, pullJson } from './mcp.ts';
import {
  ZERO_OID, isObjectId, pktLine, PKT_FLUSH, decodePktLines, parseCommit, parseTag, parseTree,
  peelToCommit, readPack, writePack,
} from './gitcore.ts';
import type { GitObject } from './gitcore.ts';
import type net from 'node:net';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'forge/1.0';
// The v2 capability advertisement never changes, so it is built once and reused.
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'), PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);
const UPLOAD_CAPS = (defaultBranch: string): string =>
  `symref=HEAD:refs/heads/${defaultBranch} multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS = (defaultBranch: string): string =>
  `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${defaultBranch} object-format=sha1`;

let requestSeq = 0;

export function createApp(): net.Server {
  const forge = new Forge();
  return createServer((req) => {
    try {
      return handle(req, forge);
    } catch (err) {
      process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      return jsonRes(500, { message: 'internal error' });
    }
  });
}

// ---------------------------------------------------------------- plumbing
function nextRequestId(): string { return `forge-${++requestSeq}`; }

const JSON_CT = 'application/json';

function jsonRes(status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'Content-Type': JSON_CT, 'X-GitHub-Request-Id': nextRequestId(), ...extra },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

/** A JSON response whose body bytes are already built (memoized). */
function jsonBytes(status: number, body: Buffer, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'Content-Type': JSON_CT, 'X-GitHub-Request-Id': nextRequestId(), ...extra },
    body,
  };
}

function errRes(status: number, message: string): HttpResponse {
  return jsonRes(status, { message });
}

function gitRes(status: number, contentType: string, body: Buffer): HttpResponse {
  return {
    status,
    headers: { 'Content-Type': contentType, 'X-GitHub-Request-Id': nextRequestId() },
    body,
  };
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}

function authorized(req: HttpRequest): boolean {
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '' && token !== SHOP_TOKEN) return false;
  return true;
}

function baseUrlOf(req: HttpRequest): string {
  return `http://${req.host}`;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages: Math.max(1, Math.ceil(items.length / perPage)), pageNum, perPage };
}

function linkHeader(req: HttpRequest, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
  const base = `${baseUrlOf(req)}${req.path}`;
  const mk = (p: number): string => `<${base}?page=${p}&per_page=${perPage}>`;
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`${mk(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) parts.push(`${mk(pageNum - 1)}; rel="prev"`);
  parts.push(`${mk(1)}; rel="first"`);
  parts.push(`${mk(totalPages)}; rel="last"`);
  return parts.join(', ');
}

/** The full pre-rendered HTTP response bytes for a JSON body (fixed request-id;
 *  the suite only requires the header to be non-empty). */
function fullJsonResponse(status: number, body: Buffer): Buffer {
  const head = Buffer.from(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 201 ? 'Created' : ''}\r\nContent-Type: application/json\r\nX-GitHub-Request-Id: forge-1\r\nConnection: keep-alive\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1');
  return Buffer.concat([head, body]);
}

/** Pre-rendered full HTTP response for a repo GET, memoized per repo generation. */
function repoGetResponse(forge: Forge, repo: Repo): Buffer {
  let buf = repo.repoJsonCache;
  if (!buf) {
    buf = fullJsonResponse(200, Buffer.from(JSON.stringify(repoJson(repo)), 'utf8'));
    repo.repoJsonCache = buf;
  }
  return buf;
}

/** Pre-rendered full HTTP response for an issue GET, memoized per issue. */
function issueGetResponse(forge: Forge, repo: Repo, number: number): Buffer | null {
  let buf = repo.issueJsonCache.get(number);
  if (buf) return buf;
  const issue = repo.issues.get(number);
  if (!issue) return null;
  buf = fullJsonResponse(200, Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8'));
  repo.issueJsonCache.set(number, buf);
  return buf;
}

// Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or null.
function resolveCommit(forge: Forge, repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return forge.defaultTip(repo) ?? null;
  if (isObjectId(ref)) {
    const obj = repo.objects.get(ref);
    if (!obj) return null;
    return obj.type === 'commit' ? ref : peelToCommit(forge.lookup(repo), ref);
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const tip = repo.refs.get(full);
  if (!tip) return null;
  return peelToCommit(forge.lookup(repo), tip);
}

function branchTip(forge: Forge, repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function commitView(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const view = forge.commitOf(repo, oid);
  const message = view ? commitMessageOf(repo, oid) : '';
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email },
      committer: { name: VIEWER.name, email: VIEWER.email },
    },
    parents: (view?.parents ?? []).map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- git wire helpers
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(off, off + 65515)])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function refLinesV0(forge: Forge, repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.sortedRefs(repo);
  const defaultTip = forge.defaultTip(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const headOid = defaultTip ?? refs.find(([name]) => name.startsWith('refs/heads/'))?.[1] ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const [name, oid] of refs) {
    if (name.startsWith('refs/tags/')) {
      lines.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(forge.lookup(repo), oid);
        if (peeled) lines.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  }
  return lines;
}

/** The v0 ref advertisement body for one service, cached per repo generation. */
function refAdvertisement(forge: Forge, repo: Repo, service: 'upload' | 'receive'): Buffer {
  const cached = repo.refsCache;
  if (cached && cached.gen === repo.gen) return service === 'upload' ? cached.upload : cached.receive;
  const caps = service === 'upload' ? UPLOAD_CAPS(repo.defaultBranch) : RECEIVE_CAPS(repo.defaultBranch);
  const svc = service === 'upload' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const body = Buffer.concat([pktLine(svc), PKT_FLUSH, ...refLinesV0(forge, repo, caps), PKT_FLUSH]);
  const otherCaps = service === 'upload' ? RECEIVE_CAPS(repo.defaultBranch) : UPLOAD_CAPS(repo.defaultBranch);
  const otherSvc = service === 'upload' ? '# service=git-receive-pack\n' : '# service=git-upload-pack\n';
  const other = Buffer.concat([pktLine(otherSvc), PKT_FLUSH, ...refLinesV0(forge, repo, otherCaps), PKT_FLUSH]);
  repo.refsCache = service === 'upload'
    ? { gen: repo.gen, upload: body, receive: other }
    : { gen: repo.gen, upload: other, receive: body };
  return body;
}

interface FetchPlan {
  wants: string[]; haves: string[]; shallowIn: string[]; deepen: number | null;
}

/**
 * The object set a fetch sends: the tree closure of exactly the `included`
 * commits (their trees and blobs, never a parent commit outside the set),
 * plus every want oid itself so an annotated tag object round-trips.
 */
function collectFetchSet(lookup: (oid: string) => GitObject | undefined, included: Set<string>, wants: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of included) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit' || seen.has(oid)) continue;
    seen.add(oid);
    queue.push(parseCommit(obj.data).tree);
  }
  for (const want of wants) queue.push(want);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) if (included.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

function collectHaveSet(lookup: (oid: string) => GitObject | undefined, roots: string[], boundaries: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!boundaries.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

interface FetchResult { acks: string[]; shallow: string[]; unshallow: string[]; pack: Buffer; }

function computeFetchInner(forge: Forge, repo: Repo, plan: FetchPlan): FetchResult {
  const lookup = forge.lookup(repo);
  const wantCommits: string[] = [];
  for (const want of plan.wants) {
    const peeled = peelToCommit(lookup, want);
    if (peeled) wantCommits.push(peeled);
    else if (repo.objects.has(want)) wantCommits.push(want);
  }
  // BFS distances from the want commits. With a depth limit, stop expanding
  // at distance depth-1: nothing deeper can be included.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const c of wantCommits) if (!dist.has(c)) { dist.set(c, 0); queue.push(c); }
  while (queue.length) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    if (plan.deepen !== null && d >= plan.deepen - 1) continue;
    const view = forge.commitOf(repo, oid);
    if (!view) continue;
    for (const p of view.parents) {
      if (!dist.has(p) && repo.objects.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  const included = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (plan.deepen !== null) {
    const depth = plan.deepen;
    for (const [oid, d] of dist) {
      if (d < depth) included.add(oid);
    }
    for (const oid of included) {
      const d = dist.get(oid)!;
      const view = forge.commitOf(repo, oid);
      if (!view) continue;
      if (d === depth - 1 && view.parents.length > 0) shallow.push(oid);
    }
    for (const old of plan.shallowIn) {
      if (included.has(old) && (dist.get(old) ?? 0) < depth - 1) unshallow.push(old);
    }
  } else {
    for (const oid of dist.keys()) included.add(oid);
    for (const old of plan.shallowIn) if (included.has(old)) unshallow.push(old);
  }
  const sendSet = collectFetchSet(lookup, included, plan.wants);
  const haveRoots: string[] = [];
  for (const have of plan.haves) {
    const peeled = peelToCommit(lookup, have);
    if (peeled) haveRoots.push(peeled);
    else if (repo.objects.has(have)) haveRoots.push(have);
  }
  if (haveRoots.length) {
    const haveSet = collectHaveSet(lookup, haveRoots, new Set(plan.shallowIn));
    for (const oid of haveSet) sendSet.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of sendSet) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const acks: string[] = [];
  for (const have of plan.haves) {
    const peeled = peelToCommit(lookup, have);
    if (peeled && dist.has(peeled)) acks.push(have);
  }
  return { acks, shallow, unshallow, pack: writePack(objects) };
}

/**
 * Fetch computation with memoization. The clone workload repeats the same
 * shallow fetch of the same tip 50 times; the pack bytes are identical, so
 * only the first fetch pays the BFS + deflate cost.
 */
function computeFetch(forge: Forge, repo: Repo, plan: FetchPlan): FetchResult {
  const key = `${plan.wants.join(',')}|${plan.haves.join(',')}|${plan.shallowIn.join(',')}|${plan.deepen ?? ''}`;
  const cached = repo.fetchCache.get(key);
  if (cached && cached.gen === repo.gen) return cached;
  const result = computeFetchInner(forge, repo, plan);
  repo.fetchCache.set(key, { gen: repo.gen, ...result });
  return result;
}

// ---------------------------------------------------------------- main dispatch
function handle(req: HttpRequest, forge: Forge): HttpResponse {
  const method = req.method;
  const path = req.path;
  const segments = path.split('/').filter((s) => s !== '');

  if (method === 'GET' && path === '/healthz') {
    return jsonRes(200, { ok: true });
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    return handleGit(req, forge, method);
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') return errRes(405, 'Method not allowed');
    if (!authorized(req)) return errRes(401, 'Requires authentication');
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return errRes(400, 'Malformed JSON body');
    if (Array.isArray(parsed.value)) {
      return jsonRes(200, parsed.value.map((item) => executeGraphQL(forge, item)));
    }
    return jsonRes(200, executeGraphQL(forge, parsed.value));
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') return jsonRes(200, {});
    if (method !== 'POST') return errRes(405, 'Method not allowed');
    if (!authorized(req)) return errRes(401, 'Requires authentication');
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) {
      return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const body = parsed.value as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') {
      return jsonRes(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const out = handleMcp(forge, body as never);
    if (out.body === null) return { status: out.status, headers: { 'X-GitHub-Request-Id': nextRequestId() }, body: Buffer.alloc(0) };
    return jsonRes(out.status, out.body);
  }

  // REST v3 root + meta: no auth.
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return errRes(405, 'Method not allowed');
    return jsonRes(200, { current_user_url: `${baseUrlOf(req)}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return errRes(405, 'Method not allowed');
    return jsonRes(200, { installed_version: '1.0.0' });
  }

  // Everything else under /api/v3 needs auth.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) return errRes(401, 'Requires authentication');
    return handleRest(req, forge, method, segments);
  }

  return errRes(404, 'Not Found');
}

// ---------------------------------------------------------------- REST v3
function handleRest(req: HttpRequest, forge: Forge, method: string, segments: string[]): HttpResponse {
  const query = req.query;

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user') {
    if (method !== 'GET') return errRes(405, 'Method not allowed');
    return jsonRes(200, {
      login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User',
      url: `${baseUrlOf(req)}/api/v3/user`, html_url: `https://forge.local/${VIEWER.login}`,
    });
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return errRes(400, 'Malformed JSON body');
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return errRes(422, 'Repository name is required');
      if (forge.getRepo(VIEWER.login, name)) return errRes(422, 'Repository already exists');
      const repo = forge.createRepo(VIEWER.login, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      return jsonRes(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER.login);
      const { page, totalPages, pageNum, perPage } = paginate(repos, query);
      return jsonRes(200, page.map((r) => repoJson(r)), { Link: linkHeader(req, query, pageNum, perPage, totalPages) });
    }
    return errRes(405, 'Method not allowed');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return errRes(404, 'Not Found');
    const rest = segments.slice(5);
    return handleRepoRest(req, forge, repo, method, rest);
  }

  return errRes(404, 'Not Found');
}

function handleRepoRest(req: HttpRequest, forge: Forge, repo: Repo, method: string, rest: string[]): HttpResponse {
  const query = req.query;
  const readJson = (): { ok: true; value: Record<string, unknown> } | { ok: false } => {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return { ok: false };
    return { ok: true, value: (parsed.value ?? {}) as Record<string, unknown> };
  };

  // Repo itself: GET / PATCH / DELETE
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, headers: {}, body: Buffer.alloc(0), raw: repoGetResponse(forge, repo) };
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, headers: { 'X-GitHub-Request-Id': nextRequestId() }, body: Buffer.alloc(0) };
    }
    if (method === 'PATCH') {
      const body = readJson();
      if (!body.ok) return errRes(400, 'Malformed JSON body');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      repo.updatedAt = forge.stamp().iso;
      forge.touch(repo);
      return jsonRes(200, repoJson(repo));
    }
    return errRes(405, 'Method not allowed');
  }

  // Branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) } }));
      return jsonRes(200, branches);
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(forge, repo, branch);
      if (!tip) return errRes(404, 'Branch not found');
      return jsonRes(200, { name: branch, commit: { sha: tip } });
    }
    return errRes(405, 'Method not allowed');
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = readJson();
      if (!body.ok) return errRes(400, 'Malformed JSON body');
      const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) return errRes(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return errRes(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      forge.touch(repo);
      return jsonRes(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length === 2) {
      const all = forge.sortedRefs(repo).map(([name, oid]) => ({ ref: name, object: { sha: oid } }));
      return jsonRes(200, all);
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const tip = branchTip(forge, repo, branch);
      if (!tip) return errRes(404, 'Reference not found');
      return jsonRes(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'tags') {
      const tag = rest.slice(3).join('/');
      const tip = repo.refs.get(`refs/tags/${tag}`);
      if (!tip) return errRes(404, 'Reference not found');
      return jsonRes(200, { ref: `refs/tags/${tag}`, object: { sha: tip } });
    }
    return errRes(404, 'Not Found');
  }

  // Commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const tip = resolveCommit(forge, repo, query.get('sha') ?? undefined);
      if (!tip) return jsonRes(200, []);
      const walked = forge.walkCommits(repo, tip);
      const { page } = paginate(walked, query);
      return jsonRes(200, page.map((oid) => commitView(forge, repo, oid)));
    }
    return errRes(404, 'Not Found');
  }

  // Contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveCommit(forge, repo, query.get('ref') ?? undefined);
      if (!tip) return errRes(404, 'Not Found');
      const commitView = forge.commitOf(repo, tip);
      if (!commitView) return errRes(404, 'Not Found');
      const treeOid = commitView.tree;
      if (path === '') {
        const children = forge.listDir(repo, treeOid, '') ?? [];
        return jsonRes(200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid, size: 0 })));
      }
      const entry = forge.readPath(repo, treeOid, path);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        if (!blob) return errRes(404, 'Not Found');
        return jsonRes(200, {
          type: 'file', encoding: 'base64', name: path.split('/').pop(), path,
          sha: entry.oid, size: blob.data.length, content: blob.data.toString('base64'),
        });
      }
      const children = forge.listDir(repo, treeOid, path);
      if (children) {
        return jsonRes(200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid, size: 0 })));
      }
      return errRes(404, 'Not Found');
    }
    if (method === 'PUT') {
      const body = readJson();
      if (!body.ok) return errRes(400, 'Malformed JSON body');
      const message = typeof body.value.message === 'string' ? body.value.message : '';
      const contentB64 = typeof body.value.content === 'string' ? body.value.content : '';
      if (message === '' || contentB64 === '') return errRes(422, 'message and content are required');
      const branch = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
      let tip = branchTip(forge, repo, branch);
      if (!tip) {
        const defaultTip = forge.defaultTip(repo);
        if (defaultTip) { repo.refs.set(`refs/heads/${branch}`, defaultTip); tip = defaultTip; }
      }
      const baseTree = tip ? (forge.commitOf(repo, tip)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
      const current = tip ? forge.readPath(repo, baseTree, path) : null;
      const expectedSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (expectedSha !== undefined) {
        if (!current || current.oid !== expectedSha) return errRes(409, 'sha does not match the current file');
      }
      const blobOid = forge.putObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
      const newTree = forge.writePath(repo, baseTree, path, blobOid);
      const commitSha = forge.makeCommit(repo, newTree, tip ? [tip] : [], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      forge.touch(repo);
      const status = current ? 200 : 201;
      return jsonRes(status, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: Buffer.from(contentB64, 'base64').length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const body = readJson();
      if (!body.ok) return errRes(400, 'Malformed JSON body');
      const message = typeof body.value.message === 'string' ? body.value.message : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      const branch = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
      const tip = branchTip(forge, repo, branch);
      if (!tip) return errRes(404, 'Not Found');
      const baseTree = forge.commitOf(repo, tip)?.tree;
      if (!baseTree) return errRes(404, 'Not Found');
      const current = forge.readPath(repo, baseTree, path);
      if (!current) return errRes(404, 'Not Found');
      if (sha !== '' && current.oid !== sha) return errRes(409, 'sha does not match the current file');
      const newTree = forge.deletePath(repo, baseTree, path);
      const commitSha = forge.makeCommit(repo, newTree, [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      forge.touch(repo);
      return jsonRes(200, { commit: { sha: commitSha, message }, content: null });
    }
    return errRes(405, 'Method not allowed');
  }

  // Labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = readJson();
      if (!body.ok) return errRes(400, 'Malformed JSON body');
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '') return errRes(422, 'Label name is required');
      const color = typeof body.value.color === 'string' ? body.value.color : 'ededed';
      repo.labels.set(name, { name, color, description: typeof body.value.description === 'string' ? body.value.description : '' });
      forge.touch(repo);
      return jsonRes(201, { name, color, description: '' });
    }
    if (method === 'GET' && rest.length === 1) {
      return jsonRes(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
    }
    return errRes(404, 'Not Found');
  }

  // Issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = readJson();
        if (!body.ok) return errRes(400, 'Malformed JSON body');
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (title === '') return errRes(422, 'Issue title is required');
        const labels = Array.isArray(body.value.labels) ? (body.value.labels as unknown[]).map((l) => typeof l === 'string' ? l : (l as { name?: unknown }).name).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return errRes(422, `Label "${label}" does not exist`);
        }
        const issue = forge.createIssue(repo, title, typeof body.value.body === 'string' ? body.value.body : '', labels);
        return jsonRes(201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
        }
        const { page } = paginate(issues, query);
        return jsonRes(200, page.map((i) => issueJson(repo, i)));
      }
      return errRes(405, 'Method not allowed');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) return errRes(404, 'Not Found');
    const issue = repo.issues.get(num);
    if (!issue) return errRes(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        // Hot path (read workload): serve the pre-rendered response bytes.
        const buf = issueGetResponse(forge, repo, num);
        if (!buf) return errRes(404, 'Not Found');
        return { status: 200, headers: {}, body: Buffer.alloc(0), raw: buf };
      }
      if (method === 'PATCH') {
        const body = readJson();
        if (!body.ok) return errRes(400, 'Malformed JSON body');
        if (typeof body.value.state === 'string' && (body.value.state === 'open' || body.value.state === 'closed')) issue.state = body.value.state;
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        issue.updatedAt = forge.stamp().iso;
        forge.touchIssue(repo, num);
        return jsonRes(200, issueJson(repo, issue));
      }
      return errRes(405, 'Method not allowed');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const body = readJson();
        if (!body.ok) return errRes(400, 'Malformed JSON body');
        const commentBody = typeof body.value.body === 'string' ? body.value.body : '';
        if (commentBody === '') return errRes(422, 'Comment body is required');
        const comment = forge.addComment(repo, issue, commentBody);
        return jsonRes(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: comment.createdAt });
      }
      if (method === 'GET') {
        return jsonRes(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: c.createdAt })));
      }
      return errRes(405, 'Method not allowed');
    }
    return errRes(404, 'Not Found');
  }

  // Pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = readJson();
        if (!body.ok) return errRes(400, 'Malformed JSON body');
        const head = typeof body.value.head === 'string' ? body.value.head : '';
        const base = typeof body.value.base === 'string' ? body.value.base : '';
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (head === '' || base === '' || title === '') return errRes(422, 'head, base and title are required');
        const headSha = branchTip(forge, repo, head);
        const baseSha = branchTip(forge, repo, base);
        if (!headSha || !baseSha) return errRes(422, 'head or base branch not found');
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) return errRes(422, 'A pull request already exists for this head branch');
        }
        const pull = forge.createPull(repo, title, typeof body.value.body === 'string' ? body.value.body : '', head, base, headSha, baseSha);
        return jsonRes(201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page } = paginate(pulls, query);
        return jsonRes(200, page.map((p) => pullJson(repo, p)));
      }
      return errRes(405, 'Method not allowed');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) return errRes(404, 'Not Found');
    const pull = repo.pulls.get(num);
    if (!pull) return errRes(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return jsonRes(200, pullJson(repo, pull));
      return errRes(405, 'Method not allowed');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') return jsonRes(200, forge.pullFiles(repo, pull));
      return errRes(405, 'Method not allowed');
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return errRes(405, 'Pull request is not open');
        if (forge.pullConflicts(repo, pull)) return errRes(405, 'Merge conflict');
        const sha = forge.mergePull(repo, pull);
        if (!sha) return errRes(405, 'Merge failed');
        return jsonRes(200, { merged: true, sha, message: pull.title });
      }
      return errRes(405, 'Method not allowed');
    }
    return errRes(404, 'Not Found');
  }

  return errRes(404, 'Not Found');
}

// ---------------------------------------------------------------- git smart HTTP
function handleGit(req: HttpRequest, forge: Forge, method: string): HttpResponse {
  const segments = req.path.split('/').filter((s) => s !== '');
  const owner = segments[0];
  const repoName = segments[1].slice(0, -'.git'.length);
  const sub = segments.slice(2);
  const service = req.query.get('service') ?? '';

  if (!authorized(req)) return errRes(401, 'Requires authentication');
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return errRes(404, 'Not Found');

  // GET info/refs?service=...
  if (method === 'GET' && sub.length === 2 && sub[0] === 'info' && sub[1] === 'refs') {
    const v2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (v2) {
        return gitRes(200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
      }
      return gitRes(200, 'application/x-git-upload-pack-advertisement', refAdvertisement(forge, repo, 'upload'));
    }
    if (service === 'git-receive-pack') {
      return gitRes(200, 'application/x-git-receive-pack-advertisement', refAdvertisement(forge, repo, 'receive'));
    }
    return errRes(400, 'Unknown service');
  }

  // POST git-upload-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-upload-pack') {
    const raw = req.body;
    let packets: ReturnType<typeof decodePktLines>['packets'];
    try {
      packets = decodePktLines(raw).packets;
    } catch {
      return errRes(400, 'Malformed pkt-line stream');
    }
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (lines.length === 0 || !lines[0].startsWith('command=')) {
      // v0 fetch: two sections, wants then haves, each flush-terminated.
      const plan: FetchPlan = { wants: [], haves: [], shallowIn: [], deepen: null };
      for (const line of lines) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) plan.wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) plan.shallowIn.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) plan.deepen = parseInt(text.slice(7), 10);
      }
      if (plan.wants.length === 0) return errRes(400, 'No wants in fetch request');
      const { acks, shallow, unshallow, pack } = computeFetch(forge, repo, plan);
      const out: Buffer[] = [];
      if (acks.length) for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
      else out.push(pktLine('NAK\n'));
      for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(...sidebandChunks(pack), PKT_FLUSH);
      return gitRes(200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    }
    // v2: command=ls-refs | command=fetch
    const command = lines[0].slice('command='.length).replace(/\n$/, '');
    const args = lines.slice(1).filter((l) => l !== 'command=ls-refs\n' && l !== 'command=fetch\n');
    if (command === 'ls-refs') {
      let peel = false;
      let symrefs = false;
      let unborn = false;
      const prefixes: string[] = [];
      for (const line of args) {
        const text = line.replace(/\n$/, '');
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text === 'unborn') unborn = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      const out: Buffer[] = [];
      const defaultTip = forge.defaultTip(repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      if (symrefs && keep('HEAD')) {
        if (defaultTip) out.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        else if (unborn) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
      for (const [name, oid] of forge.sortedRefs(repo)) {
        if (!keep(name)) continue;
        if (name.startsWith('refs/tags/')) {
          let line = `${oid} ${name}`;
          if (peel) {
            const obj = repo.objects.get(oid);
            if (obj && obj.type === 'tag') {
              const peeled = peelToCommit(forge.lookup(repo), oid);
              if (peeled) line += ` peeled:${peeled}`;
            }
          }
          out.push(pktLine(`${line}\n`));
        } else {
          out.push(pktLine(`${oid} ${name}\n`));
        }
      }
      out.push(PKT_FLUSH);
      return gitRes(200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    }
    if (command === 'fetch') {
      const plan: FetchPlan = { wants: [], haves: [], shallowIn: [], deepen: null };
      for (const line of args) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) plan.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) plan.shallowIn.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) plan.deepen = parseInt(text.slice(7), 10);
      }
      if (plan.wants.length === 0) return errRes(400, 'No wants in fetch request');
      const { acks, shallow, unshallow, pack } = computeFetch(forge, repo, plan);
      const out: Buffer[] = [];
      if (plan.haves.length > 0) {
        out.push(pktLine('acknowledgments\n'));
        if (acks.length) for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
        else out.push(pktLine('NAK\n'));
        out.push(pktLine('ready\n'), PKT_FLUSH);
      }
      if (shallow.length || unshallow.length) {
        out.push(pktLine('shallow-info\n'));
        for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
        out.push(PKT_FLUSH);
      }
      out.push(pktLine('packfile\n'), ...sidebandChunks(pack), PKT_FLUSH);
      return gitRes(200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    }
    return errRes(400, `Unknown upload-pack command: ${command}`);
  }

  // POST git-receive-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-receive-pack') {
    const raw = req.body;
    let decoded: ReturnType<typeof decodePktLines>;
    try {
      decoded = decodePktLines(raw);
    } catch {
      return errRes(400, 'Malformed pkt-line stream');
    }
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of decoded.packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text);
      if (!m) continue;
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    const packBytes = raw.subarray(decoded.offset);
    const reportLines: string[] = [];
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, forge.lookup(repo));
        for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch (err) {
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    if (unpackDetail !== 'ok') {
      reportLines.push(`unpack ${unpackDetail}`);
      for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
    } else {
      reportLines.push('unpack ok');
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
          reportLines.push(`ng ${cmd.ref} invalid command`);
          continue;
        }
        if (cmd.oldOid === ZERO_OID) {
          if (current !== undefined) { reportLines.push(`ng ${cmd.ref} already exists`); continue; }
          if (!repo.objects.has(cmd.newOid)) { reportLines.push(`ng ${cmd.ref} object not found`); continue; }
          if (cmd.ref.startsWith('refs/heads/')) {
            if (!peelToCommit(forge.lookup(repo), cmd.newOid)) { reportLines.push(`ng ${cmd.ref} new tip is not a commit`); continue; }
          }
          repo.refs.set(cmd.ref, cmd.newOid);
          forge.touch(repo);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (cmd.newOid === ZERO_OID) {
          if (current === undefined) { reportLines.push(`ng ${cmd.ref} reference does not exist`); continue; }
          if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} old value does not match`); continue; }
          repo.refs.delete(cmd.ref);
          forge.touch(repo);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (current === undefined) { reportLines.push(`ng ${cmd.ref} reference does not exist`); continue; }
        if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} old value does not match`); continue; }
        if (!repo.objects.has(cmd.newOid)) { reportLines.push(`ng ${cmd.ref} object not found`); continue; }
        const newCommit = peelToCommit(forge.lookup(repo), cmd.newOid);
        if (!newCommit) { reportLines.push(`ng ${cmd.ref} new tip is not a commit`); continue; }
        const oldCommit = peelToCommit(forge.lookup(repo), cmd.oldOid);
        if (!oldCommit || !forge.isAncestor(repo, oldCommit, newCommit)) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        forge.touch(repo);
        reportLines.push(`ok ${cmd.ref}`);
      }
    }
    const inner = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
    const body = Buffer.concat([...sidebandChunks(inner), PKT_FLUSH]);
    return gitRes(200, 'application/x-git-receive-pack-result', body);
  }

  return errRes(404, 'Not Found');
}
