// gitcore.ts — git object model, pkt-line codec, packfile read/write.
// Pure functions over Buffers. Node built-ins only (node:crypto, node:zlib).
// No git binary anywhere. Objects are immutable once stored, so callers may
// cache parse results per oid without invalidation.
//
// Layout of this file, top to bottom:
//   1. object identity (hashing, oid validation)
//   2. pkt-line codec (framing for the smart-HTTP protocol)
//   3. tree / commit / tag parsing and building
//   4. reachability (graph walks over the object store)
//   5. delta application (the packfile delta instruction set)
//   6. packfile read/write (v2/v3, OFS/REF deltas, trailer checksum)
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { readonly type: GitObjectType; readonly data: Buffer; }

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

// ------------------------------------------------------------- 1. identity

export function isObjectId(v: string): boolean { return HEX40.test(v); }

/** The git object id: sha1 over "<type> <size>\0" + payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  // Feed the "<type> <len>\0" header as a string: createHash accepts a
  // string + encoding, so no Buffer allocation for the header is needed.
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

// ------------------------------------------------------------- 2. pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** One 4-byte pkt-line header, decoded. `null` means the bytes at `off` are
 *  not a pkt-line header at all — raw pack data starts here. */
function readPktHead(buf: Buffer, off: number): { kind: Pkt['kind']; length: number } | null {
  const head = buf.subarray(off, off + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
  const len = parseInt(head, 16);
  if (len === 0) return { kind: 'flush', length: 0 };
  if (len === 1) return { kind: 'delim', length: 0 };
  if (len === 2) return { kind: 'response-end', length: 0 };
  if (len < 4 || len > 65520 || off + len > buf.length) throw new Error('malformed pkt-line');
  return { kind: 'data', length: len };
}

/** Decode pkt-lines from the front of `buf`. Returns packets plus the offset of
 *  the first unparsed byte (raw pack data follows a flush in receive-pack).
 *  Throws on malformed input. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = readPktHead(buf, off);
    if (head === null) break; // raw data starts here
    if (head.kind === 'data') {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + head.length) });
      off += head.length;
    } else {
      packets.push({ kind: head.kind });
      off += 4;
    }
  }
  return { packets, offset: off };
}

// ------------------------------------------------------------- 3. tree / commit / tag

export interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string; }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort order: directories sort as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  const name = entry.mode === '40000' ? `${entry.name}/` : entry.name;
  return Buffer.from(name, 'utf8');
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(treeSortKey(a), treeSortKey(b));
}

/** Serialize one tree entry: "<mode> <name>\0" + 20 raw oid bytes. */
function encodeTreeEntry(entry: TreeEntry): Buffer[] {
  return [
    Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
    Buffer.from(entry.oid, 'hex'),
  ];
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) parts.push(...encodeTreeEntry(e));
  return Buffer.concat(parts);
}

/**
 * Split a commit/tag body into its header block and its message.
 * Returns the header lines (everything before the first blank line) and the
 * message (everything after it, or '' when there is no blank line).
 */
function splitHeaderBlock(data: Buffer): { headerLines: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headerLines = data.subarray(0, headEnd).toString('utf8').split('\n');
  return { headerLines, message };
}

/** Split one "key value" header line into its key and its value. */
function splitHeaderLine(line: string): { key: string; value: string } {
  const sp = line.indexOf(' ');
  if (sp < 0) return { key: line, value: '' };
  return { key: line.slice(0, sp), value: line.slice(sp + 1) };
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const { headerLines, message } = splitHeaderBlock(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerLines) {
    if (!line) continue;
    const { key, value } = splitHeaderLine(line);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string; parents?: readonly string[]; message: string;
  author: string; committer: string; timestamp: number; timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`, `committer ${fields.committer} ${fields.timestamp} ${tz}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string; readonly type: GitObjectType; readonly tag: string;
  readonly tagger: string; readonly message: string;
}

/** Parse a tag body's header block into a key -> value map. */
function parseTagHeaders(headerLines: string[]): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) throw new Error('bad tag header');
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return headers;
}

export function parseTag(data: Buffer): TagView {
  const { headerLines, message } = splitHeaderBlock(data);
  const headers = parseTagHeaders(headerLines);
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag has bad type');
  return {
    object, type, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '',
    message,
  };
}

/** Peel an object id to the commit it ultimately points at (through tags). */
export function peelToCommit(lookup: (oid: string) => GitObject | undefined, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = lookup(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// ------------------------------------------------------------- 4. reachability

export type Lookup = (oid: string) => GitObject | undefined;

/** The oids a single object points at: a commit's tree + parents, a tag's
 *  target, a tree's non-gitlink entries. Blobs point at nothing. */
function objectChildren(obj: GitObject): string[] {
  if (obj.type === 'commit') {
    const c = parseCommit(obj.data);
    return [c.tree, ...c.parents];
  }
  if (obj.type === 'tag') return [parseTag(obj.data).object];
  if (obj.type === 'tree') {
    return parseTree(obj.data).filter((e) => e.mode !== '160000').map((e) => e.oid);
  }
  return [];
}

/** Every object reachable from `roots`. Throws on a missing object. */
export function collectReachable(roots: Iterable<string>, lookup: Lookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    queue.push(...objectChildren(obj));
  }
  return seen;
}

/** The parent oids of a commit object, or [] when it is not a commit. */
function commitParents(obj: GitObject | undefined): string[] {
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(lookup: Lookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    queue.push(...commitParents(lookup(oid)));
  }
  return false;
}

// ------------------------------------------------------------- 5. delta application

/** A read cursor into a delta stream: just the offset, passed by reference. */
interface DeltaCursor { off: number; }

/** Read one variable-length integer from the delta stream (7 bits per byte,
 *  little-endian groups, high bit set means "more bytes follow"). */
function readDeltaVarint(delta: Buffer, cursor: DeltaCursor): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = delta[cursor.off++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return value;
}

interface CopyParams { copyOff: number; copySize: number; }

/**
 * Decode a delta COPY opcode (high bit set): bits 0-3 select which offset
 * bytes follow, bits 4-6 select which size bytes follow. A size of 0 means
 * 0x10000. Byte positions track the bit index, so the shift advances 8 per
 * bit slot whether or not that byte is present.
 */
function decodeDeltaCopy(op: number, delta: Buffer, cursor: DeltaCursor): CopyParams {
  let copyOff = 0;
  let copySize = 0;
  let shift = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (op & (1 << bit)) copyOff += delta[cursor.off++] * 2 ** shift;
    shift += 8;
  }
  shift = 0;
  for (let bit = 4; bit < 7; bit++) {
    if (op & (1 << bit)) copySize += delta[cursor.off++] * 2 ** shift;
    shift += 8;
  }
  if (copySize === 0) copySize = 0x10000;
  return { copyOff, copySize };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const cursor: DeltaCursor = { off: 0 };
  const srcSize = readDeltaVarint(delta, cursor);
  const tgtSize = readDeltaVarint(delta, cursor);
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (cursor.off < delta.length) {
    const op = delta[cursor.off++];
    if (op & 0x80) {
      const { copyOff, copySize } = decodeDeltaCopy(op, delta, cursor);
      if (copyOff + copySize > base.length || written + copySize > tgtSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      if (cursor.off + lit > delta.length || written + lit > tgtSize) throw new Error('delta insert out of range');
      delta.copy(out, written, cursor.off, cursor.off + lit);
      cursor.off += lit;
      written += lit;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

// ------------------------------------------------------------- 6. packfile

/** A pack entry header: the type/size varint at the front of every entry. */
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

/** An OFS-delta base offset: big-endian-ish varint where each continuation
 *  byte adds one before multiplying by 128. */
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

interface PackEntryRaw {
  offset: number; typeCode: number; size: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
}

interface ResolvedEntry { type: GitObjectType; data: Buffer; oid: string; }

/** Validate the pack header and trailer; return the entry count and where
 *  the 20-byte sha1 trailer starts. */
function readPackHeader(pack: Buffer): { count: number; trailerStart: number } {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  return { count, trailerStart };
}

/** Read one raw pack entry starting at `off`: its type/size header, any
 *  delta-base reference, and its inflated payload. Returns the entry and the
 *  offset of the next entry. */
function readPackEntry(pack: Buffer, off: number, trailerStart: number): { entry: PackEntryRaw; next: number } {
  const entryOffset = off;
  const h = readVarintSize(pack, off);
  off = h.next;
  const typeCode = (h.first >> 4) & 0x07;
  const entry: PackEntryRaw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
  if (typeCode === 6) {
    const b = readOfsBase(pack, off);
    off = b.next;
    entry.baseOffset = entryOffset - b.baseOffset;
  } else if (typeCode === 7) {
    entry.baseOid = pack.subarray(off, off + 20).toString('hex');
    off += 20;
  } else if (!CODE_TYPE[typeCode]) throw new Error(`pack entry has unknown type ${typeCode}`);
  const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
  entry.data = inflated.buffer;
  off += inflated.engine.bytesWritten;
  return { entry, next: off };
}

/**
 * Resolves a pack's entries (plain objects and OFS/REF deltas) into objects.
 * Deltas resolve recursively with cycle detection; resolved entries are
 * memoized by their pack offset and by their computed oid, so a REF delta
 * can find a base that was resolved earlier in the same pack.
 */
class PackResolver {
  private readonly byOffset = new Map<number, PackEntryRaw>();
  private readonly byOid = new Map<string, PackEntryRaw>();
  private readonly resolved = new Map<number, ResolvedEntry>();
  private readonly resolving = new Set<number>();
  private readonly entries: PackEntryRaw[];
  private readonly resolveBase?: Lookup;

  constructor(entries: PackEntryRaw[], resolveBase?: Lookup) {
    this.entries = entries;
    this.resolveBase = resolveBase;
    for (const e of entries) this.byOffset.set(e.offset, e);
  }

  resolveAll(): Map<string, GitObject> {
    const objects = new Map<string, GitObject>();
    for (const entry of this.entries) {
      const r = this.resolve(entry);
      if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
    }
    return objects;
  }

  private resolve(entry: PackEntryRaw): ResolvedEntry {
    const cached = this.resolved.get(entry.offset);
    if (cached) return cached;
    if (this.resolving.has(entry.offset)) throw new Error('delta cycle');
    this.resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = this.resolveOfsBase(entry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = this.resolveRefBase(entry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out: ResolvedEntry = { type, data, oid };
    this.resolved.set(entry.offset, out);
    this.byOid.set(oid, entry);
    this.resolving.delete(entry.offset);
    return out;
  }

  private resolveOfsBase(entry: PackEntryRaw): ResolvedEntry {
    const baseEntry = this.byOffset.get(entry.baseOffset!);
    if (!baseEntry) throw new Error('ofs-delta base not in pack');
    return this.resolve(baseEntry);
  }

  private resolveRefBase(entry: PackEntryRaw): ResolvedEntry {
    const baseEntry = this.byOid.get(entry.baseOid!);
    if (baseEntry) return this.resolve(baseEntry);
    const ext = this.resolveBase?.(entry.baseOid!);
    if (!ext) throw new Error(`ref-delta base ${entry.baseOid} not available`);
    return { type: ext.type, data: ext.data, oid: entry.baseOid! };
  }
}

/**
 * Read a packfile (v2/v3), resolving OFS/REF deltas. Returns oid -> object.
 * Throws on any structural problem, bad trailer, or bad object SHA.
 */
export function readPack(pack: Buffer, resolveBase?: Lookup): Map<string, GitObject> {
  const { count, trailerStart } = readPackHeader(pack);
  const raw: PackEntryRaw[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const { entry, next } = readPackEntry(pack, off, trailerStart);
    raw.push(entry);
    off = next;
  }
  if (off !== trailerStart) throw new Error('pack has trailing bytes');
  return new PackResolver(raw, resolveBase).resolveAll();
}

/** The type/size varint at the front of a pack entry's zlib stream. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
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

/** The 12-byte pack header: magic, version 2, entry count. */
function packHeader(count: number): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  return header;
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [packHeader(list.length)];
  for (const o of list) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Objects reachable from `newTips` minus those reachable from `serverTips`, in BFS order. */
export function objectsToSend(lookup: Lookup, serverTips: Iterable<string>, newTips: Iterable<string>): GitObject[] {
  let onServer: Set<string>;
  try { onServer = collectReachable(serverTips, lookup); } catch { onServer = new Set(); }
  const wanted = collectReachable(newTips, lookup);
  const out: GitObject[] = [];
  for (const oid of wanted) {
    if (onServer.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) out.push(obj);
  }
  return out;
}
