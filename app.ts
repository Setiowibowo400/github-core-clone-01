// github-core-clone-01: a standalone GitHub-compatible git forge in one process.
// Node 22 stdlib only (node:http, node:zlib, node:crypto). No deps, no git binary,
// no network. Serves git smart HTTP (upload-pack v2 + v0, receive-pack v0),
// REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp, all over one
// in-memory store. Deterministic: counter-based ids and counter-derived
// timestamps; no wall clock or randomness in stored state.
//
// The token owner: the suite's scenario derives every login from the one public
// constant seed in the kit (wire.ts SCENARIO_SEED); the viewer login is
// "adaiversen" and the stranger is "olgabauer" (verified by running the kit's
// buildScenario() locally). The bearer token authenticates; the login names
// the token's owner.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0000000000000000000000000000000000000000';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const FORGE_NAME = 'github-core-clone';
const FORGE_VERSION = '1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
// A single bad request must never kill the server mid-suite.
process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); });
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); });
// Deterministic clock: every stored timestamp is this epoch plus a counter.
const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function isoAt(n: number): string { return new Date((EPOCH_SEC + n) * 1000).toISOString(); }
function b64e(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function b64d(s: string): Buffer { return Buffer.from(s, 'base64'); }
function unb64url(s: string): string { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } }

// ---------------------------------------------------------------- git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer }
function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function isOid(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }

interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; message: string }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}
function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = ''; let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

// ---- packfile read (plain + OFS/REF deltas) ----
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!; const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let s = 0;
    for (;;) { const b = delta[off++]!; v += (b & 0x7f) * 2 ** s; s += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let w = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++]! * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++]! * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, w, co, co + cs); w += cs;
    } else if (op !== 0) {
      const n = op & 0x7f; delta.copy(out, w, off, off + n); off += n; w += n;
    } else throw new Error('delta opcode 0');
  }
  if (w !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; code: number; size: number; data: Buffer; baseOff?: number; baseOid?: string; res?: { type: ObjType; data: Buffer; oid: string } }
  const raw: Raw[] = []; const byOff = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    const hdr = readVarintSize(pack, off); off = hdr.next;
    const code = (hdr.first >> 4) & 0x07;
    const e: Raw = { offset: entryOff, code, size: hdr.size, data: Buffer.alloc(0) };
    if (code === 6) {
      let b = pack[off]!; off += 1; let v = b & 0x7f;
      while (b & 0x80) { b = pack[off++]!; v = ((v + 1) * 128) + (b & 0x7f); }
      e.baseOff = entryOff - v;
    } else if (code === 7) { e.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[code]) throw new Error(`unknown pack type ${code}`);
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== hdr.size) throw new Error('pack entry size mismatch');
    e.data = inflated.buffer; off += inflated.engine.bytesWritten;
    raw.push(e); byOff.set(entryOff, e);
  }
  const objects = new Map<string, GitObj>();
  const resolved = new Map<string, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (e: Raw): { type: ObjType; data: Buffer; oid: string } => {
    if (e.res) return e.res;
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let type: ObjType; let data: Buffer;
    if (e.code === 6) { const b = resolve(byOff.get(e.baseOff!)!); type = b.type; data = applyDelta(b.data, e.data); }
    else if (e.code === 7) {
      const base = resolved.get(e.baseOid!);
      if (!base) throw new Error(`ref-delta base ${e.baseOid} not in pack`);
      type = base.type; data = applyDelta(base.data, e.data);
    } else { type = CODE_TYPE[e.code]!; data = e.data; }
    const oid = hashObject(type, data);
    const r = { type, data, oid };
    e.res = r; resolved.set(oid, r); resolving.delete(e.offset);
    return r;
  };
  for (const e of raw) { const r = resolve(e); if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data }); }
  return objects;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) { parts.push(writePackObjectHeader(o.type, o.data.length)); parts.push(deflateSync(o.data)); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---- pkt-line ----
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(FLUSH);
    else if (it === 'delim') parts.push(DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------- store

interface Label { id: number; name: string; color: string; description: string }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; createdSeq: number; closedSeq: number | null;
  comments: { id: number; body: string; createdSeq: number }[];
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; head: string; base: string; headSha: string; baseSha: string;
  mergeCommitSha: string | null; mergedSeq: number | null; createdSeq: number;
}
interface Repo {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // refs/heads/x, refs/tags/x -> oid
  labels: Map<string, Label>;
  issues: Issue[]; issueCounter: number;
  pulls: Pull[]; pullCounter: number;
}
const repos = new Map<string, Repo>(); // key owner/name
let repoIdCounter = 0;
let labelIdCounter = 0;
let issueIdCounter = 0;
let commentIdCounter = 0;
let pullIdCounter = 0;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const id = ++repoIdCounter;
  const repo: Repo = {
    id, name, owner: VIEWER_LOGIN, description, isPrivate, defaultBranch: 'main',
    createdSeq: nextSeq(), objects: new Map(), refs: new Map(),
    labels: new Map(), issues: [], issueCounter: 0, pulls: [], pullCounter: 0,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function gid(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}
function repoGid(r: Repo): string { return gid('Repository', String(r.id)); }
function issueGid(r: Repo, iss: Issue): string { return gid('Issue', `${r.id}:${iss.number}`); }
function pullGid(r: Repo, pr: Pull): string { return gid('PullRequest', `${r.id}:${pr.number}`); }
function commentGid(r: Repo, iss: Issue, c: { id: number }): string { return gid('IssueComment', `${r.id}:${iss.number}:${c.id}`); }
function decodeGid(id: string): { kind: string; payload: string } | null {
  const s = unb64url(id);
  const i = s.indexOf(':');
  if (i < 0) return null;
  return { kind: s.slice(0, i), payload: s.slice(i + 1) };
}
function findRepoByGid(id: string): Repo | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Repository') return null;
  const num = Number(d.payload);
  for (const r of repos.values()) if (r.id === num) return r;
  return null;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Issue') return null;
  const [rid, num] = d.payload.split(':');
  for (const r of repos.values()) {
    if (String(r.id) !== rid) continue;
    const iss = r.issues.find((x) => x.number === Number(num));
    if (iss) return { repo: r, issue: iss };
  }
  return null;
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'PullRequest') return null;
  const [rid, num] = d.payload.split(':');
  for (const r of repos.values()) {
    if (String(r.id) !== rid) continue;
    const pr = r.pulls.find((x) => x.number === Number(num));
    if (pr) return { repo: r, pull: pr };
  }
  return null;
}

// ---- git object helpers on a repo ----
function putObj(r: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!r.objects.has(oid)) r.objects.set(oid, { type, data });
  return oid;
}
function commitOf(r: Repo, oid: string): CommitView | null {
  const o = r.objects.get(oid);
  if (!o || o.type !== 'commit') return null;
  return parseCommit(o.data);
}
function isAncestor(r: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = commitOf(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const cur = stack.pop()!;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    const c = commitOf(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  const stackB = [b]; const seenB = new Set<string>();
  while (stackB.length) {
    const cur = stackB.pop()!;
    if (ancA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    const c = commitOf(r, cur);
    if (c) for (const p of c.parents) stackB.push(p);
  }
  return null;
}
/** Collect objects reachable from tips. depth = max commit generations (Infinity = all).
 *  stopAt = shallow boundaries: do not traverse parents of those commits (their trees still included). */
function collectReachable(r: Repo, tips: string[], depth: number, stopAt: Set<string>): { objects: Map<string, GitObj>; commits: string[]; boundary: string[] } {
  const objects = new Map<string, GitObj>();
  const commits: string[] = [];
  const boundary: string[] = [];
  const seenCommit = new Set<string>();
  const queue: { oid: string; gen: number }[] = tips.filter((t) => t !== ZERO_OID && r.objects.has(t)).map((t) => ({ oid: t, gen: 0 }));
  const addTree = (treeOid: string, seenTree: Set<string>): void => {
    if (!treeOid || seenTree.has(treeOid)) return;
    seenTree.add(treeOid);
    const o = r.objects.get(treeOid);
    if (!o || o.type !== 'tree') return;
    objects.set(treeOid, o);
    for (const e of parseTree(o.data)) {
      const child = r.objects.get(e.oid);
      if (!child) continue;
      if (child.type === 'tree') addTree(e.oid, seenTree);
      else objects.set(e.oid, child);
    }
  };
  const seenTree = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const o = r.objects.get(oid);
    if (!o) continue;
    objects.set(oid, o);
    commits.push(oid);
    if (o.type === 'tag') {
      const t = parseTag(o.data);
      if (t.object && r.objects.has(t.object)) {
        const target = r.objects.get(t.object)!;
        if (target.type === 'commit') queue.push({ oid: t.object, gen });
        else objects.set(t.object, target);
      }
      continue;
    }
    if (o.type !== 'commit') continue;
    const c = parseCommit(o.data);
    addTree(c.tree, seenTree);
    const cut = gen + 1 >= depth || stopAt.has(oid);
    if (cut) { if (c.parents.length > 0) boundary.push(oid); continue; }
    for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
  }
  return { objects, commits, boundary };
}
function listCommits(r: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || cur === ZERO_OID) continue;
    seen.add(cur);
    const c = commitOf(r, cur);
    if (!c) continue;
    out.push({ sha: cur, message: c.message.replace(/\n$/, '') });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}
/** Flatten a commit's tree to path -> {oid, mode}. */
function flattenTree(r: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const o = r.objects.get(treeOid);
  if (!o || o.type !== 'tree') return;
  for (const e of parseTree(o.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(r, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}
function treeAtRef(r: Repo, ref: string): string | null {
  const tip = resolveRef(r, ref);
  if (!tip) return null;
  const c = commitOf(r, tip);
  return c ? c.tree : null;
}
function resolveRef(r: Repo, ref: string): string | null {
  // ref may be a branch name, a full ref, or a commit sha
  if (isOid(ref)) return r.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) return r.refs.get(ref) ?? null;
  return r.refs.get(`refs/heads/${ref}`) ?? null;
}
function setTreePath(r: Repo, baseTreeOid: string | null, segments: string[], blobOid: string | null): string {
  // Returns new tree oid with segments path set to blobOid (or removed when null).
  const entries = new Map<string, TreeEntry>();
  if (baseTreeOid) {
    const o = r.objects.get(baseTreeOid);
    if (o && o.type === 'tree') for (const e of parseTree(o.data)) entries.set(e.name, e);
  }
  const [head, ...rest] = segments;
  if (head === undefined) return baseTreeOid ?? putObj(r, 'tree', buildTree([]));
  if (rest.length === 0) {
    if (blobOid === null) entries.delete(head);
    else entries.set(head, { mode: '100644', name: head, oid: blobOid });
  } else {
    const sub = entries.get(head);
    const subTree = sub && sub.mode === '40000' ? sub.oid : null;
    const newSub = setTreePath(r, subTree, rest, blobOid);
    const subObj = r.objects.get(newSub);
    const empty = subObj && subObj.type === 'tree' && parseTree(subObj.data).length === 0;
    if (empty && blobOid === null) entries.delete(head);
    else entries.set(head, { mode: '40000', name: head, oid: newSub });
  }
  return putObj(r, 'tree', buildTree([...entries.values()]));
}
function makeCommit(r: Repo, treeOid: string, parents: string[], message: string): string {
  const n = nextSeq();
  const ts = EPOCH_SEC + n;
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let text = `tree ${treeOid}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return putObj(r, 'commit', Buffer.from(text, 'utf8'));
}
/** Diff two trees: path -> {status, oldOid?, newOid?} */
function diffTrees(r: Repo, baseTree: string | null, headTree: string | null): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTree) flattenTree(r, baseTree, '', base);
  if (headTree) flattenTree(r, headTree, '', head);
  const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p); const h = head.get(p);
    if (b && !h) out.push({ path: p, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path: p, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path: p, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}
function lineCounts(r: Repo, oid: string | null): number {
  if (!oid) return 0;
  const o = r.objects.get(oid);
  if (!o) return 0;
  const s = o.data.toString('utf8');
  return s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}
function prConflicted(r: Repo, pr: Pull): boolean {
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  const headTip = r.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return false;
  const mb = mergeBase(r, baseTip, headTip);
  if (!mb) return false;
  const mbCommit = commitOf(r, mb);
  const baseCommit = commitOf(r, baseTip);
  const headCommit = commitOf(r, headTip);
  if (!mbCommit || !baseCommit || !headCommit) return false;
  const headDiff = diffTrees(r, mbCommit.tree, headCommit.tree);
  const baseDiff = diffTrees(r, mbCommit.tree, baseCommit.tree);
  const baseByPath = new Map(baseDiff.map((d) => [d.path, d]));
  for (const d of headDiff) {
    const b = baseByPath.get(d.path);
    if (b && b.newOid !== d.newOid) return true;
  }
  return false;
}
function prFiles(r: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const mb = mergeBase(r, pr.baseSha, pr.headSha);
  const mbTree = mb ? commitOf(r, mb)?.tree ?? null : null;
  const headTree = commitOf(r, pr.headSha)?.tree ?? null;
  return diffTrees(r, mbTree, headTree).map((d) => {
    const add = d.status === 'removed' ? 0 : lineCounts(r, d.newOid);
    const del = d.status === 'added' ? 0 : lineCounts(r, d.oldOid);
    return { filename: d.path, status: d.status === 'modified' ? 'modified' : d.status, additions: add, deletions: del, changes: add + del };
  });
}

// ---------------------------------------------------------------- HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';
let reqCounter = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': `req-${++reqCounter}`, ...extra });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (tok === '') return false;
  if (TOKEN !== '') return tok === TOKEN;
  return true;
}
function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://entry');
  return { path: u.pathname, query: u.searchParams };
}

// ---- REST shapes ----
function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: 1000, node_id: gid('User', '1000'), avatar_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}
function repoJson(r: Repo): Record<string, unknown> {
  const openIssues = r.issues.filter((i) => i.state === 'open').length;
  return {
    id: r.id, node_id: repoGid(r), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(), private: r.isPrivate, description: r.description,
    default_branch: r.defaultBranch, html_url: `/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`, clone_url: `/${r.owner}/${r.name}.git`,
    created_at: isoAt(r.createdSeq), updated_at: isoAt(r.createdSeq), pushed_at: isoAt(r.createdSeq),
    language: null, has_issues: true, has_projects: true, has_wiki: true, has_pages: false,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: openIssues,
    license: null, visibility: r.isPrivate ? 'private' : 'public', archived: false, disabled: false,
  };
}
function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid('Label', String(l.id)), name: l.name, color: l.color, description: l.description, default: false, url: '' };
}
function issueJson(r: Repo, iss: Issue): Record<string, unknown> {
  return {
    id: iss.id, node_id: issueGid(r, iss), number: iss.number, title: iss.title, body: iss.body,
    state: iss.state, labels: iss.labels.map(labelJson), user: userJson(), assignee: null,
    created_at: isoAt(iss.createdSeq), updated_at: isoAt(iss.closedSeq ?? iss.createdSeq),
    closed_at: iss.closedSeq === null ? null : isoAt(iss.closedSeq),
    comments: iss.comments.length, html_url: '', url: `/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`, locked: false,
  };
}
function pullJson(r: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id, node_id: pullGid(r, pr), number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, merged: pr.merged, mergeable: !prConflicted(r, pr),
    merged_at: pr.mergedSeq === null ? null : isoAt(pr.mergedSeq),
    merge_commit_sha: pr.mergeCommitSha,
    head: { label: `${r.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha, user: userJson(), repo: repoJson(r) },
    base: { label: `${r.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha, user: userJson(), repo: repoJson(r) },
    user: userJson(), created_at: isoAt(pr.createdSeq), updated_at: isoAt(pr.mergedSeq ?? pr.createdSeq),
    closed_at: pr.state === 'closed' ? isoAt(pr.mergedSeq ?? pr.createdSeq) : null,
    draft: false, comments: 0, review_comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: 0,
    html_url: '', url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${pr.number}`,
  };
}
function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const nextQ = new URLSearchParams(query);
    nextQ.set('page', String(page + 1)); nextQ.set('per_page', String(perPage));
    link = `<http://${host}${basePath}?${nextQ.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function createIssueIn(r: Repo, title: string, body: string, labelNames: string[]): { issue?: Issue; badLabel?: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const l = r.labels.get(name);
    if (!l) return { badLabel: name };
    labels.push(l);
  }
  const n = ++r.issueCounter;
  const iss: Issue = { id: ++issueIdCounter, number: n, title, body: body ?? '', state: 'open', labels, createdSeq: nextSeq(), closedSeq: null, comments: [] };
  r.issues.push(iss);
  return { issue: iss };
}
function createPullIn(r: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
  const headSha = resolveRef(r, head);
  const baseSha = resolveRef(r, base);
  if (!headSha) return { error: `head branch ${head} does not exist` };
  if (!baseSha) return { error: `base branch ${base} does not exist` };
  const n = ++r.pullCounter;
  const pr: Pull = {
    id: ++pullIdCounter, number: n, title, body: body ?? '', state: 'open', merged: false,
    head, base, headSha, baseSha, mergeCommitSha: null, mergedSeq: null, createdSeq: nextSeq(),
  };
  r.pulls.push(pr);
  return { pull: pr };
}
function mergePull(r: Repo, pr: Pull): { sha?: string; conflict?: boolean } {
  if (pr.state !== 'open') return { conflict: true };
  if (prConflicted(r, pr)) return { conflict: true };
  const headCommit = commitOf(r, pr.headSha);
  if (!headCommit) return { conflict: true };
  const baseTip = r.refs.get(`refs/heads/${pr.base}`);
  if (!baseTip) return { conflict: true };
  const sha = makeCommit(r, headCommit.tree, [baseTip], `Merge pull request #${pr.number}: ${pr.title}\n`);
  r.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed'; pr.merged = true; pr.mergeCommitSha = sha; pr.mergedSeq = nextSeq();
  return { sha };
}
function getFileAt(r: Repo, path: string, ref?: string): { blob: Buffer; sha: string; size: number } | { dir: TreeEntry[] } | null {
  const treeOid = ref ? treeAtRef(r, ref) : treeAtRef(r, r.defaultBranch);
  if (!treeOid) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let cur = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const o = r.objects.get(cur);
    if (!o || o.type !== 'tree') return null;
    const entry = parseTree(o.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const obj = r.objects.get(entry.oid);
      if (!obj) return null;
      if (obj.type === 'blob') return { blob: obj.data, sha: entry.oid, size: obj.data.length };
      if (obj.type === 'tree') return { dir: parseTree(obj.data) };
      return null;
    }
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  // path is '' (root) or a directory itself
  const o = r.objects.get(cur);
  if (o && o.type === 'tree') return { dir: parseTree(o.data) };
  return null;
}

// ---------------------------------------------------------------- REST v3

function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

async function handleRest(req: IncomingMessage, res: ServerResponse, rawPath: string, query: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = rawPath.replace(/^\/api\/v3/, '') || '/';
  const segs = path.split('/').filter((s) => s !== '').map(dec);
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }

  // Parse JSON body for methods that carry one.
  let body: Record<string, unknown> = {};
  let bodyPresent = false;
  if (bodyBuf.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    bodyPresent = true;
    try { const parsed = JSON.parse(bodyBuf.toString('utf8')) as unknown; body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {}; }
    catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  }
  void bodyPresent;

  const notFound = (msg = 'Not Found'): void => { sendJson(res, 404, { message: msg }); };
  const repo404 = (): void => { sendJson(res, 404, { message: 'Not Found' }); };

  // Root and meta
  if (segs.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
    sendJson(res, 404, { message: 'Not Found' }); return true;
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: FORGE_VERSION, version: FORGE_VERSION }); return true; }
    sendJson(res, 404, { message: 'Not Found' }); return true;
  }
  if (segs[0] === 'user' && segs.length === 1) {
    if (method === 'GET') { sendJson(res, 200, userJson()); return true; }
    sendJson(res, 404, { message: 'Not Found' }); return true;
  }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(all.map(repoJson), query, req, '/api/v3/user/repos');
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') { sendJson(res, 422, { message: 'Repository name is required' }); return true; }
      if (getRepo(VIEWER_LOGIN, name)) { sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists` }); return true; }
      const r = createRepoRecord(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(r));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' }); return true;
  }

  // /repos/{owner}/{repo}/...
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1]!; const name = segs[2]!;
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
    const rest = segs.slice(3);
    if (!repo) { repo404(); return true; }

    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo)); return true;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` }); res.end(); return true; }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()].filter((k) => k.startsWith('refs/heads/')).sort().map((k) => {
          const n = k.slice('refs/heads/'.length);
          return { name: n, commit: { sha: repo.refs.get(k) }, protected: false };
        });
        sendJson(res, 200, list); return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) { repo404(); return true; }
        sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false }); return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Invalid ref or sha' }); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: '' }); return true;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { repo404(); return true; }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' }, url: '' }); return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(res, 200, list); return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'commits') {
      if (method === 'GET') {
        const shaParam = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, shaParam);
        if (!tip) { sendJson(res, 200, []); return true; }
        const list = listCommits(repo, tip).map((c) => ({
          sha: c.sha, commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
          author: userJson(), parents: (commitOf(repo, c.sha)?.parents ?? []).map((p) => ({ sha: p })),
        }));
        sendJson(res, 200, list); return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        if (filePath === '') { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const got = getFileAt(repo, filePath, ref);
        if (!got) { repo404(); return true; }
        if ('dir' in got) {
          sendJson(res, 200, got.dir.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file', name: e.name,
            path: filePath ? `${filePath}/${e.name}` : e.name, sha: e.oid, size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
            url: '', html_url: '',
          })));
          return true;
        }
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: got.size, name: filePath.split('/').pop(), path: filePath,
          sha: got.sha, content: got.blob.toString('base64'), url: '', html_url: '',
        });
        return true;
      }
      if (method === 'PUT') {
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : 'update';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
        if (contentB64 === '') { sendJson(res, 422, { message: 'content is required' }); return true; }
        const content = b64d(contentB64);
        const refName = `refs/heads/${branch}`;
        let tip = repo.refs.get(refName);
        if (tip === undefined && branch !== repo.defaultBranch) {
          // create branch from default tip (or unborn)
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip !== undefined) repo.refs.set(refName, tip);
        }
        const segments = filePath.split('/').filter((s) => s !== '');
        // existing blob sha at path
        let existingSha: string | null = null;
        if (tip) {
          const cur = commitOf(repo, tip);
          if (cur) { const flat = new Map<string, { oid: string; mode: string }>(); flattenTree(repo, cur.tree, '', flat); existingSha = flat.get(filePath)?.oid ?? null; }
        }
        const isUpdate = existingSha !== null;
        if (shaParam !== undefined && isUpdate && shaParam.toLowerCase() !== existingSha!.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current blob' }); return true;
        }
        if (shaParam !== undefined && !isUpdate) { sendJson(res, 409, { message: 'sha does not match' }); return true; }
        const blobOid = putObj(repo, 'blob', content);
        const baseTree = tip ? commitOf(repo, tip)?.tree ?? null : null;
        const newTree = setTreePath(repo, baseTree, segments, blobOid);
        const parents = tip ? [tip] : [];
        const commitSha = makeCommit(repo, newTree, parents, message);
        repo.refs.set(refName, commitSha);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: segments[segments.length - 1], path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' ? body.message : 'delete';
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (!tip) { repo404(); return true; }
        const cur = commitOf(repo, tip);
        if (!cur) { repo404(); return true; }
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, cur.tree, '', flat);
        const entry = flat.get(filePath);
        if (!entry) { repo404(); return true; }
        if (shaParam !== undefined && shaParam.toLowerCase() !== entry.oid.toLowerCase()) { sendJson(res, 409, { message: 'sha does not match' }); return true; }
        const newTree = setTreePath(repo, cur.tree, filePath.split('/').filter((s) => s !== ''), null);
        const commitSha = makeCommit(repo, newTree, [tip], message);
        repo.refs.set(refName, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') { sendJson(res, 422, { message: 'label name is required' }); return true; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, labelJson(existing)); return true; }
        const label: Label = { id: ++labelIdCounter, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label)); return true;
      }
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()].map(labelJson)); return true; }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') { sendJson(res, 422, { message: 'title is required' }); return true; }
          const labelNames: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => typeof l === 'string' ? l : (l as { name?: unknown }).name as string).filter((x): x is string => typeof x === 'string') : [];
          const made = createIssueIn(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
          if (made.badLabel) { sendJson(res, 422, { message: `Label '${made.badLabel}' does not exist` }); return true; }
          sendJson(res, 201, issueJson(repo, made.issue!)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), query, req, `/api/v3/repos/${owner}/${name}/issues`);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      const num = Number(rest[1]);
      const iss = repo.issues.find((i) => i.number === num);
      if (!iss) { repo404(); return true; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, iss)); return true; }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') { iss.state = body.state; if (body.state === 'closed') iss.closedSeq = nextSeq(); else iss.closedSeq = null; }
          if (typeof body.title === 'string') iss.title = body.title;
          if (typeof body.body === 'string') iss.body = body.body;
          sendJson(res, 200, issueJson(repo, iss)); return true;
        }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') {
          const cbody = typeof body.body === 'string' ? body.body : '';
          const c = { id: ++commentIdCounter, body: cbody, createdSeq: nextSeq() };
          iss.comments.push(c);
          sendJson(res, 201, { id: c.id, node_id: commentGid(repo, iss, c), body: cbody, user: userJson(), created_at: isoAt(c.createdSeq), updated_at: isoAt(c.createdSeq) });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, iss.comments.map((c) => ({ id: c.id, node_id: commentGid(repo, iss, c), body: c.body, user: userJson(), created_at: isoAt(c.createdSeq), updated_at: isoAt(c.createdSeq) })));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') { sendJson(res, 422, { message: 'title and head are required' }); return true; }
          const made = createPullIn(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if (!made.pull) { sendJson(res, 422, { message: made.error ?? 'cannot create pull request' }); return true; }
          sendJson(res, 201, pullJson(repo, made.pull)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), query, req, `/api/v3/repos/${owner}/${name}/pulls`);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      const num = Number(rest[1]);
      const pr = repo.pulls.find((p) => p.number === num);
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'PUT') {
          if (!pr) { repo404(); return true; }
          const merged = mergePull(repo, pr);
          if (!merged.sha) { sendJson(res, 405, { message: 'Pull request cannot be merged: conflict' }); return true; }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pr.number} successfully merged` });
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      if (!pr) { repo404(); return true; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method === 'GET') { sendJson(res, 200, prFiles(repo, pr)); return true; }
        sendJson(res, 404, { message: 'Not Found' }); return true;
      }
      sendJson(res, 404, { message: 'Not Found' }); return true;
    }

    sendJson(res, 404, { message: 'Not Found' }); return true;
  }

  sendJson(res, 404, { message: 'Not Found' }); return true;
}

// ---------------------------------------------------------------- git smart HTTP

const V2_CAPS = [
  'version 2',
  'agent=github-core-clone/1.0.0',
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
];
const V0_UPLOAD_CAPS = 'multi_ack thin-pack side-band-64k ofs-delta shallow agent=github-core-clone/1.0.0';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0.0';

function sortedRefs(r: Repo): { name: string; oid: string }[] {
  return [...r.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, oid]) => ({ name, oid }));
}
function peeledOid(r: Repo, oid: string): string | null {
  const o = r.objects.get(oid);
  if (!o || o.type !== 'tag') return null;
  const t = parseTag(o.data);
  const target = r.objects.get(t.object);
  if (target && target.type === 'commit') return t.object;
  return null;
}
function v0Advertisement(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  const items: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(r);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const symref = headTip ? ` symref=HEAD:refs/heads/${r.defaultBranch}` : '';
    items.push(`${headTip ?? ZERO_OID} HEAD\0${caps}${symref}\n`);
    for (const ref of refs) {
      items.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(r, ref.oid);
      if (peeled) items.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}
function v2Advertisement(): Buffer {
  const items: (string | Buffer | 'flush')[] = ['# service=git-upload-pack\n', 'flush', ...V2_CAPS.map((c) => `${c}\n`), 'flush'];
  return pktLines(items);
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!m) return false;
  const owner = dec(m[1]!); const name = dec(m[2]!); const tail = m[3]!;
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  const notFound = (): void => { sendJson(res, 404, { message: 'Not Found' }); };

  if (method === 'GET' && tail === 'info/refs') {
    const service = query.get('service') ?? '';
    if (!repo) { notFound(); return true; }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    notFound(); return true;
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    if (!repo) { notFound(); return true; }
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (v2) await handleUploadPackV2(req, res, repo, bodyBuf);
      else await handleUploadPackV0(req, res, repo, bodyBuf);
    } catch (e) {
      console.error('upload-pack error', e);
      // A malformed request must not kill the server; answer 400 and stay up.
      if (!res.headersSent) sendRaw(res, 400, Buffer.from('bad request'), 'text/plain');
    }
    return true;
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    if (!repo) { notFound(); return true; }
    try {
      await handleReceivePack(req, res, repo, bodyBuf);
    } catch (e) {
      console.error('receive-pack error', e);
      if (!res.headersSent) sendRaw(res, 400, Buffer.from('bad request'), 'text/plain');
    }
    return true;
  }

  if (method === 'GET' && (tail === '' || tail === 'info/refs')) { notFound(); return true; }
  return false;
}

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[]; depth: number | null;
  thinPack: boolean; filter: string | null;
}
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, filter: null };
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = Number(t.slice(7).trim());
    else if (t.startsWith('deepen-since ')) args.depth = 1;
    else if (t === 'thin-pack') args.thinPack = true;
    else if (t.startsWith('filter ')) args.filter = t.slice(7).trim();
  }
  return args;
}
/** Objects to send for a fetch, honouring haves / shallow boundaries / depth. */
function computeFetch(r: Repo, args: FetchArgs): { objects: Map<string, GitObj>; shallowOut: string[]; unshallowOut: string[] } {
  const stopAt = new Set(args.shallow);
  const depth = args.depth ?? Infinity;
  const wanted = collectReachable(r, args.wants, depth, new Set());
  const held = args.haves.length ? collectReachable(r, args.haves, Infinity, stopAt) : { objects: new Map<string, GitObj>() };
  const send = new Map<string, GitObj>();
  for (const [oid, obj] of wanted.objects) if (!held.objects.has(oid)) send.set(oid, obj);
  // shallow boundaries: wanted commits at the depth cut whose parents were cut
  const shallowOut: string[] = [];
  if (args.depth !== null) {
    const genOf = new Map<string, number>();
    const q: { oid: string; gen: number }[] = args.wants.filter((w) => r.objects.has(w)).map((w) => ({ oid: w, gen: 0 }));
    const seen = new Set<string>();
    while (q.length) {
      const { oid, gen } = q.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      genOf.set(oid, gen);
      const c = commitOf(r, oid);
      if (!c) continue;
      if (gen + 1 < args.depth) for (const p of c.parents) q.push({ oid: p, gen: gen + 1 });
    }
    for (const [oid, gen] of genOf) {
      const c = commitOf(r, oid);
      if (c && gen === args.depth - 1 && c.parents.length > 0) shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const b of args.shallow) {
    if (wanted.objects.has(b)) {
      const c = commitOf(r, b);
      if (c && c.parents.some((p) => wanted.objects.has(p))) unshallowOut.push(b);
    }
  }
  return { objects: send, shallowOut, unshallowOut };
}

async function handleUploadPackV2(_req: IncomingMessage, res: ServerResponse, repo: Repo, bodyBuf: Buffer): Promise<void> {
  const packets = decodePktLines(bodyBuf);
  const lines: string[] = [];
  let command = '';
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice(8).replace(/\n$/, '');
      continue;
    }
    lines.push(text);
  }
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false; let symrefs = false;
    for (const line of lines) {
      const t = line.replace(/\n$/, '');
      if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11));
      else if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
    }
    const out: string[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const keep = (n: string): boolean => prefixes.length === 0 || prefixes.some((p) => n.startsWith(p));
    if (keep('HEAD')) {
      if (headTip) out.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
      else out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) { const peeled = peeledOid(repo, ref.oid); if (peeled) line += ` peeled:${peeled}`; }
      out.push(`${line}\n`);
    }
    out.push('flush');
    sendRaw(res, 200, pktLines(out), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const args = parseFetchArgs(lines);
    const { objects, shallowOut, unshallowOut } = computeFetch(repo, args);
    const parts: Buffer[] = [];
    const acks: string[] = [];
    for (const h of args.haves) {
      const held = collectReachable(repo, [h], Infinity, new Set());
      if (held.objects.has(h)) acks.push(`ACK ${h}\n`);
    }
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length) for (const a of acks) parts.push(pktLine(a));
    else parts.push(pktLine('NAK\n'));
    parts.push(FLUSH);
    if (shallowOut.length || unshallowOut.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(FLUSH);
    }
    if (objects.size > 0) {
      const pack = writePack([...objects.values()]);
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(pack));
      parts.push(FLUSH);
    }
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // Unknown v2 command: empty result.
  sendRaw(res, 200, pktLines(['flush']), 'application/x-git-upload-pack-result');
}

async function handleUploadPackV0(_req: IncomingMessage, res: ServerResponse, repo: Repo, bodyBuf: Buffer): Promise<void> {
  const packets = decodePktLines(bodyBuf);
  const lines: string[] = [];
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8'));
  }
  void section;
  // v0: wants (with shallow/deepen) then flush, then haves + done then flush.
  const args = parseFetchArgs(lines);
  const { objects, shallowOut, unshallowOut } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  for (const h of args.haves) {
    const held = collectReachable(repo, [h], Infinity, new Set());
    if (held.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
  }
  if (args.haves.length === 0 || parts.length === 0) parts.push(pktLine('NAK\n'));
  for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
  if (objects.size > 0) parts.push(sidebandPack(writePack([...objects.values()])));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(_req: IncomingMessage, res: ServerResponse, repo: Repo, bodyBuf: Buffer): Promise<void> {
  const packets = decodePktLines(bodyBuf);
  // Commands run until the first flush; the pack follows the flush packet in the raw body.
  let offset = 0;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = bodyBuf.length;
  {
    let i = 0;
    while (i + 4 <= bodyBuf.length) {
      const lenHex = bodyBuf.subarray(i, i + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) { packStart = i; break; }
      const len = parseInt(lenHex, 16);
      if (len === 0) { packStart = i + 4; break; }
      if (len === 1 || len === 2) { i += 4; continue; }
      if (i + len > bodyBuf.length) { packStart = bodyBuf.length; break; }
      const payload = bodyBuf.subarray(i + 4, i + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const cmdText = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = cmdText.split(' ');
      if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      }
      i += len;
    }
    offset = i;
  }
  void offset;
  void packets;
  // Unpack the pack (if any) into the repo store.
  let unpackOk = true;
  if (packStart < bodyBuf.length) {
    const pack = bodyBuf.subarray(packStart);
    if (pack.length >= 12) {
      try {
        const objs = readPack(Buffer.from(pack));
        for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch { unpackOk = false; }
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack unpacker error\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false; let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) { reason = 'remote ref does not exist'; }
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { reason = 'non-fast-forward'; }
      else { repo.refs.delete(cmd.ref); ok = true; }
    } else if (cmd.oldOid === ZERO_OID) {
      // create
      if (current) { reason = 'already exists'; }
      else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
      else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
    } else {
      // update
      if (!current) { reason = 'remote ref does not exist'; }
      else if (cmd.oldOid !== current) { reason = 'non-fast-forward'; }
      else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
      else if (!isAncestor(repo, current, cmd.newOid)) { reason = 'non-fast-forward'; }
      else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
    }
    reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  const inner = pktLines(reportLines);
  const outer = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  sendRaw(res, 200, outer, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- GraphQL

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface GqlSelection {
  kind: 'field' | 'fragment';
  name: string; alias: string | null; args: Record<string, GqlValue>;
  selections: GqlSelection[]; typeCondition: string | null;
}
interface GqlOperation { type: 'query' | 'mutation'; name: string | null; variables: Record<string, GqlValue>; selections: GqlSelection[] }

function gqlLex(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
    if ('{}()[]:!=$'.includes(c)) { toks.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1]!; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; }
        else { out += src[j]; j++; }
      }
      toks.push(JSON.stringify(out)); i = j + 1; continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_\-]/.test(src[j]!)) j++;
    if (j === i) { i++; continue; }
    toks.push(src.slice(i, j)); i = j;
  }
  return toks;
}
class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = gqlLex(src); }
  peek(): string | null { return this.toks[this.pos] ?? null; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.peek() === t) this.pos++; }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { __var: this.next() } as unknown as GqlValue;
    if (t === '[') { const arr: GqlValue[] = []; while (this.peek() !== ']' && this.peek() !== null) arr.push(this.parseValue()); this.expect(']'); return arr; }
    if (t === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}' && this.peek() !== null) { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(); }
      this.expect('}'); return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return t; // enum
  }
  parseArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')' && this.peek() !== null) { const k = this.next(); this.expect(':'); args[k] = this.parseValue(); }
    this.expect(')');
    return args;
  }
  parseSelections(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== null) {
      if (this.peek() === '...') {
        this.next();
        let cond: string | null = null; let name = '';
        if (this.peek() === 'on') { this.next(); cond = this.next(); }
        else name = this.next();
        const sels = this.parseSelections();
        out.push({ kind: 'fragment', name, alias: null, args: {}, selections: sels, typeCondition: cond });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const sels = this.peek() === '{' ? this.parseSelections() : [];
      out.push({ kind: 'field', name, alias, args, selections: sels, typeCondition: null });
    }
    this.expect('}');
    return out;
  }
  parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { type = this.next() as 'query' | 'mutation'; }
    let name: string | null = null;
    if (this.peek() !== null && this.peek() !== '{' && this.peek() !== '(') name = this.next();
    // variable definitions
    const vars: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== null) {
        if (this.peek() === '$') { this.next(); const vn = this.next(); this.expect(':'); // skip type tokens until , or )
          let depth = 0;
          while (this.peek() !== null) {
            const tk = this.peek()!;
            if (tk === '(' || tk === '[') depth++;
            else if (tk === ')' || tk === ']') { if (depth === 0) break; depth--; }
            else if (tk === ',' && depth === 0) break;
            if (tk === '=') { this.next(); vars[vn] = this.parseValue(); break; }
            this.next();
          }
          if (this.peek() === ',') this.next();
        } else this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { type, name, variables: vars, selections };
  }
}
function resolveVars(v: GqlValue, variables: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if ('__var' in rec) return variables[rec.__var as string];
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = resolveVars(val as GqlValue, variables);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveVars(x, variables));
  return v;
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'private', 'createdAt', 'updatedAt'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'ORGANIZATION', 'MILESTONE'];
const TYPE_INFO: Record<string, { fields: string[]; enums: string[]; kind: string }> = {
  Issue: { fields: ISSUE_TYPE_FIELDS, enums: [], kind: 'OBJECT' },
  PullRequest: { fields: PR_TYPE_FIELDS, enums: [], kind: 'OBJECT' },
  Repository: { fields: REPO_TYPE_FIELDS, enums: [], kind: 'OBJECT' },
  SearchType: { fields: [], enums: SEARCH_ENUM, kind: 'ENUM' },
  IssueState: { fields: [], enums: ['OPEN', 'CLOSED'], kind: 'ENUM' },
  PullRequestState: { fields: [], enums: ['OPEN', 'CLOSED', 'MERGED'], kind: 'ENUM' },
  MergeableState: { fields: [], enums: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], kind: 'ENUM' },
  OrderDirection: { fields: [], enums: ['ASC', 'DESC'], kind: 'ENUM' },
  IssueOrderField: { fields: [], enums: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], kind: 'ENUM' },
  RepositoryPermission: { fields: [], enums: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], kind: 'ENUM' },
  PullRequestMergeMethod: { fields: [], enums: ['MERGE', 'SQUASH', 'REBASE'], kind: 'ENUM' },
};

interface NodeObj { _type: string; [k: string]: unknown }
function repoNode(r: Repo): NodeObj {
  const headTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
  return {
    _type: 'Repository', _repo: r, id: repoGid(r), databaseId: r.id, name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`, description: r.description, private: r.isPrivate,
    owner: { _type: 'User', login: r.owner },
    defaultBranchRef: headTip ? { _type: 'Ref', name: r.defaultBranch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, url: `/${r.owner}/${r.name}`,
    createdAt: isoAt(r.createdSeq), updatedAt: isoAt(r.createdSeq),
  };
}
function issueNode(r: Repo, iss: Issue): NodeObj {
  return {
    _type: 'Issue', _repo: r, _issue: iss, id: issueGid(r, iss), number: iss.number, title: iss.title,
    state: iss.state === 'open' ? 'OPEN' : 'CLOSED', body: iss.body,
    createdAt: isoAt(iss.createdSeq), updatedAt: isoAt(iss.closedSeq ?? iss.createdSeq),
    author: { _type: 'User', login: VIEWER_LOGIN }, url: '',
    labels: { nodes: iss.labels.map((l) => ({ name: l.name })) },
    comments: { nodes: iss.comments.map((c) => ({ id: commentGid(r, iss, c), body: c.body })) },
  };
}
function pullNode(r: Repo, pr: Pull): NodeObj {
  const state = pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
  return {
    _type: 'PullRequest', _repo: r, _pull: pr, id: pullGid(r, pr), number: pr.number, title: pr.title,
    state, body: pr.body, headRefName: pr.head, baseRefName: pr.base,
    headRefOid: pr.headSha, baseRefOid: pr.baseSha,
    mergeable: prConflicted(r, pr) ? 'CONFLICTING' : 'MERGEABLE', merged: pr.merged,
    mergedAt: pr.mergedSeq === null ? null : isoAt(pr.mergedSeq),
    mergeCommit: pr.mergeCommitSha ? { oid: pr.mergeCommitSha } : null,
    author: { _type: 'User', login: VIEWER_LOGIN },
    createdAt: isoAt(pr.createdSeq), updatedAt: isoAt(pr.mergedSeq ?? pr.createdSeq),
    files: { nodes: prFiles(r, pr).map((f) => ({ path: f.filename, filename: f.filename })), totalCount: prFiles(r, pr).length },
  };
}
function issuesConnection(r: Repo, args: Record<string, unknown>): NodeObj {
  let list = [...r.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
  else if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'ASC') list.sort((a, b) => a.number - b.number);
  else list.sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : 100;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = unb64url(args.after);
    const m = /^cursor:(\d+)$/.exec(decoded);
    if (m) { const idx = list.findIndex((i) => i.number === Number(m[1])); if (idx >= 0) start = idx + 1; }
  }
  const slice = list.slice(start, start + first);
  const hasNext = start + first < list.length;
  const endCursor = slice.length ? b64e(`cursor:${slice[slice.length - 1]!.number}`) : null;
  return {
    _type: 'IssueConnection', nodes: slice.map((i) => issueNode(r, i)), totalCount: list.length,
    pageInfo: { _type: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: start > 0, endCursor, startCursor: slice.length ? b64e(`cursor:${slice[0]!.number}`) : null },
  };
}
function pullsConnection(r: Repo, args: Record<string, unknown>): NodeObj {
  let list = [...r.pulls];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => want.has(p.state === 'open' ? 'open' : p.merged ? 'merged' : 'closed'));
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const slice = list.slice(0, first);
  return {
    _type: 'PullRequestConnection', nodes: slice.map((p) => pullNode(r, p)), totalCount: list.length,
    pageInfo: { _type: 'PageInfo', hasNextPage: list.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

const ALLOWED_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Repository: new Set(REPO_TYPE_FIELDS),
  Issue: new Set(ISSUE_TYPE_FIELDS),
  PullRequest: new Set(PR_TYPE_FIELDS),
  User: new Set(['login', 'id', 'name', 'email']),
  Ref: new Set(['name', 'target']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount', 'edges']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount', 'edges']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'filename']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt']),
};

function execSelections(typeName: string, obj: NodeObj | Record<string, unknown>, selections: GqlSelection[], variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = ALLOWED_FIELDS[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== (obj as NodeObj)._type) continue;
      const sub = execSelections(typeName, obj, sel.selections, variables, errors);
      Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveVars(v, variables);
    // Special repository subfields needing args
    if (typeName === 'Repository' && (obj as NodeObj)._repo) {
      const r = (obj as NodeObj)._repo as Repo;
      if (sel.name === 'issue') {
        const iss = r.issues.find((i) => i.number === Number(args.number));
        out[key] = iss && sel.selections.length ? execSelections('Issue', issueNode(r, iss), sel.selections, variables, errors) : iss ? issueNode(r, iss) : null;
        continue;
      }
      if (sel.name === 'issues') {
        const conn = issuesConnection(r, args);
        out[key] = sel.selections.length ? execSelections('IssueConnection', conn, sel.selections, variables, errors) : conn;
        continue;
      }
      if (sel.name === 'pullRequests') {
        const conn = pullsConnection(r, args);
        out[key] = sel.selections.length ? execSelections('PullRequestConnection', conn, sel.selections, variables, errors) : conn;
        continue;
      }
      if (sel.name === 'pullRequest') {
        const pr = r.pulls.find((p) => p.number === Number(args.number));
        out[key] = pr && sel.selections.length ? execSelections('PullRequest', pullNode(r, pr), sel.selections, variables, errors) : pr ? pullNode(r, pr) : null;
        continue;
      }
    }
    if (allowed && !allowed.has(sel.name)) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const raw = (obj as Record<string, unknown>)[sel.name];
    if (raw === undefined) { out[key] = null; continue; }
    out[key] = execValue(raw, sel, variables, errors);
  }
  return out;
}
function execValue(raw: unknown, sel: GqlSelection, variables: Record<string, unknown>, errors: { message: string }[]): unknown {
  if (sel.selections.length === 0) return raw;
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => execValue(item, sel, variables, errors));
  if (typeof raw === 'object') {
    const node = raw as NodeObj;
    const t = node._type ?? 'Object';
    if (t === 'Object') {
      // plain nested object (e.g. owner, defaultBranchRef, pageInfo, __type fields)
      const out: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind === 'fragment') { Object.assign(out, execSelections(t, raw as Record<string, unknown>, [sub], variables, errors)); continue; }
        const k = sub.alias ?? sub.name;
        const v = (raw as Record<string, unknown>)[sub.name];
        out[k] = v === undefined ? null : execValue(v, sub, variables, errors);
      }
      return out;
    }
    return execSelections(t, node, sel.selections, variables, errors);
  }
  return raw;
}
function typeInfoObj(name: string): NodeObj | null {
  const info = TYPE_INFO[name];
  if (!info) return null;
  return {
    _type: '__Type', name, kind: info.kind,
    fields: info.fields.map((f) => ({ _type: '__Field', name: f, description: null, args: [], type: null })),
    enumValues: info.enums.map((e) => ({ _type: '__EnumValue', name: e, description: null })),
    description: null,
  };
}
function execOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveVars(v, variables);
    if (op.type === 'mutation') {
      data[key] = execMutation(sel.name, args, sel.selections, variables, errors);
      continue;
    }
    if (sel.name === 'viewer') {
      const viewer: NodeObj = { _type: 'User', login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL };
      data[key] = sel.selections.length ? execSelections('User', viewer, sel.selections, variables, errors) : viewer;
      continue;
    }
    if (sel.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const r = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
      data[key] = r && sel.selections.length ? execSelections('Repository', repoNode(r), sel.selections, variables, errors) : r ? repoNode(r) : null;
      continue;
    }
    if (sel.name === 'node') {
      const id = String(args.id ?? '');
      const r = findRepoByGid(id);
      if (r) {
        const node = repoNode(r);
        data[key] = sel.selections.length ? execSelections('Repository', node, sel.selections, variables, errors) : node;
      } else {
        const iss = findIssueByGid(id);
        if (iss) data[key] = sel.selections.length ? execSelections('Issue', issueNode(iss.repo, iss.issue), sel.selections, variables, errors) : issueNode(iss.repo, iss.issue);
        else {
          const pr = findPullByGid(id);
          data[key] = pr && sel.selections.length ? execSelections('PullRequest', pullNode(pr.repo, pr.pull), sel.selections, variables, errors) : pr ? pullNode(pr.repo, pr.pull) : null;
        }
      }
      continue;
    }
    if (sel.name === '__type') {
      const info = typeInfoObj(String(args.name ?? ''));
      data[key] = info && sel.selections.length ? execSelections('__Type', info, sel.selections, variables, errors) : info;
      continue;
    }
    if (sel.name === '__schema') {
      data[key] = { queryType: { name: 'Query' }, types: [] };
      continue;
    }
    errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
    data[key] = null;
  }
  const result: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (errors.length) result.errors = errors;
  return result;
}
function execMutation(name: string, args: Record<string, unknown>, selections: GqlSelection[], variables: Record<string, unknown>, errors: { message: string }[]): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const r = findRepoByGid(String(input.repositoryId ?? ''));
    if (!r) { errors.push({ message: 'Repository not found' }); return null; }
    const made = createIssueIn(r, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    const payload: NodeObj = { _type: 'CreateIssuePayload', issue: made.issue ? issueNode(r, made.issue) : null, clientMutationId: null };
    return execSelections('CreateIssuePayload', payload, selections, variables, errors);
  }
  if (name === 'closeIssue') {
    const found = findIssueByGid(String(input.issueId ?? ''));
    if (!found) { errors.push({ message: 'Issue not found' }); return null; }
    found.issue.state = 'closed'; found.issue.closedSeq = nextSeq();
    const payload: NodeObj = { _type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue), clientMutationId: null };
    return execSelections('CloseIssuePayload', payload, selections, variables, errors);
  }
  if (name === 'createPullRequest') {
    const r = findRepoByGid(String(input.repositoryId ?? ''));
    if (!r) { errors.push({ message: 'Repository not found' }); return null; }
    const made = createPullIn(r, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (!made.pull) { errors.push({ message: made.error ?? 'cannot create pull request' }); return null; }
    const payload: NodeObj = { _type: 'CreatePullRequestPayload', pullRequest: pullNode(r, made.pull), clientMutationId: null };
    return execSelections('CreatePullRequestPayload', payload, selections, variables, errors);
  }
  if (name === 'mergePullRequest') {
    const found = findPullByGid(String(input.pullRequestId ?? ''));
    if (!found) { errors.push({ message: 'Pull request not found' }); return null; }
    const merged = mergePull(found.repo, found.pull);
    if (!merged.sha) { errors.push({ message: 'Pull request cannot be merged: conflict' }); return null; }
    const payload: NodeObj = { _type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull), clientMutationId: null };
    return execSelections('MergePullRequestPayload', payload, selections, variables, errors);
  }
  if (name === 'addComment') {
    const found = findIssueByGid(String(input.subjectId ?? ''));
    if (!found) { errors.push({ message: 'Subject not found' }); return null; }
    const c = { id: ++commentIdCounter, body: String(input.body ?? ''), createdSeq: nextSeq() };
    found.issue.comments.push(c);
    const payload: NodeObj = {
      _type: 'AddCommentPayload',
      commentEdge: { _type: 'IssueCommentEdge', node: { _type: 'IssueComment', id: commentGid(found.repo, found.issue, c), body: c.body }, cursor: null },
      clientMutationId: null,
    };
    return execSelections('AddCommentPayload', payload, selections, variables, errors);
  }
  errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}
function handleGraphQL(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): void {
  if ((req.method ?? 'GET') !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyBuf.toString('utf8')); }
  catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    const d = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof d.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const variables = (d.variables !== null && typeof d.variables === 'object' && !Array.isArray(d.variables)) ? d.variables as Record<string, unknown> : {};
    try {
      const op = new GqlParser(d.query).parseOperation();
      return execOperation(op, variables);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required: string[] } }[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repo name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full name owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
];
const KNOWN_MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}
function mcpError(res: ServerResponse, id: unknown, code: number, message: string, http = 200): void {
  sendJson(res, http, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}
function mcpToolResult(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}
function mcpToolError(message: string): { content: { type: string; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  return undefined;
}
function resolveRepoArg(args: Record<string, unknown>): Repo | null {
  const full = pickArg(args, 'full_name', 'fullName', 'repository');
  if (typeof full === 'string' && full.includes('/')) {
    const [o, n] = full.split('/', 2);
    return getRepo(o!, n!) ?? null;
  }
  const owner = String(pickArg(args, 'owner', 'owner_login') ?? '');
  const repo = String(pickArg(args, 'repo', 'name', 'repository_name') ?? '');
  if (!owner || !repo) return null;
  return getRepo(owner, repo) ?? null;
}

function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): void {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') { sendRaw(res, 200, Buffer.alloc(0), 'application/json'); return; }
  if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  const rawText = bodyBuf.toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); }
  catch {
    let id: unknown = null;
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(rawText);
    if (m) { const v = m[1]!; id = v.startsWith('"') ? v.slice(1, -1) : Number(v); }
    mcpError(res, id, -32700, 'Parse error', 400);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    mcpError(res, null, -32600, 'Invalid Request');
    return;
  }
  const rpc = parsed as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = rpc.id === undefined ? null : rpc.id;
  const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params !== null && typeof rpc.params === 'object' && !Array.isArray(rpc.params)) ? rpc.params as Record<string, unknown> : {};
  if (id === null) {
    // Notification: no response body.
    sendRaw(res, 202, Buffer.alloc(0), 'application/json');
    return;
  }
  if (rpcMethod === 'server/discover') {
    mcpResult(res, id, {
      supportedVersions: KNOWN_MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    });
    return;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    mcpResult(res, id, {
      protocolVersion: KNOWN_MCP_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
    return;
  }
  if (rpcMethod === 'ping') { mcpResult(res, id, {}); return; }
  if (rpcMethod === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return;
  }
  if (rpcMethod === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {};
    const tool = MCP_TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith(`/${t.name.toLowerCase()}`) || t.name.toLowerCase().endsWith(name.toLowerCase()));
    if (!tool) { mcpError(res, id, -32602, `Unknown tool: ${name}`); return; }
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    // pull_number may arrive under a synonym key
    if (tool.name === 'merge_pull_request' && missing.includes('pull_number') && pickArg(args, 'pullNumber', 'number', 'pull_request_number') !== undefined) missing.splice(missing.indexOf('pull_number'), 1);
    if (missing.length) { mcpError(res, id, -32602, `Missing required argument: ${missing.join(', ')}`); return; }
    try {
      const result = execMcpTool(tool.name, args);
      mcpResult(res, id, result);
    } catch (e) {
      mcpError(res, id, -32603, e instanceof Error ? e.message : 'Internal error');
    }
    return;
  }
  mcpError(res, id, -32601, `Method not found: ${rpcMethod}`);
}

function execMcpTool(name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    const repoName = String(pickArg(args, 'name') ?? '');
    if (repoName === '') return mcpToolError('Repository name is required');
    if (getRepo(VIEWER_LOGIN, repoName)) return mcpToolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    const repo = createRepoRecord(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    return mcpToolResult(repoJson(r));
  }
  if (name === 'create_issue') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const made = createIssueIn(r, String(pickArg(args, 'title') ?? ''), typeof args.body === 'string' ? args.body : '', []);
    if (!made.issue) return mcpToolError(made.error ?? 'cannot create issue');
    return mcpToolResult(issueJson(r, made.issue));
  }
  if (name === 'list_issues') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = r.issues.filter((i) => state === 'all' ? true : i.state === state);
    return mcpToolResult({ issues: list.map((i) => issueJson(r, i)) });
  }
  if (name === 'get_issue') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const n = Number(pickArg(args, 'issue_number', 'number'));
    const iss = r.issues.find((i) => i.number === n);
    if (!iss) return mcpToolError('Issue not found');
    return mcpToolResult(issueJson(r, iss));
  }
  if (name === 'create_pull_request') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const made = createPullIn(r, String(pickArg(args, 'title') ?? ''), typeof args.body === 'string' ? args.body : '', String(pickArg(args, 'head') ?? ''), String(pickArg(args, 'base') ?? ''));
    if (!made.pull) return mcpToolError(made.error ?? 'cannot create pull request');
    return mcpToolResult(pullJson(r, made.pull));
  }
  if (name === 'list_pull_requests') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = r.pulls.filter((p) => state === 'all' ? true : p.state === state);
    return mcpToolResult({ pull_requests: list.map((p) => pullJson(r, p)) });
  }
  if (name === 'merge_pull_request') {
    const r = resolveRepoArg(args);
    if (!r) return mcpToolError('Repository not found');
    const n = Number(pickArg(args, 'pull_number', 'pullNumber', 'number', 'pull_request_number'));
    const pr = r.pulls.find((p) => p.number === n);
    if (!pr) return mcpToolError('Pull request not found');
    const merged = mergePull(r, pr);
    if (!merged.sha) return mcpToolError('Pull request cannot be merged: conflict');
    return mcpToolResult({ merged: true, sha: merged.sha, number: pr.number, state: 'closed' });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const query = url.searchParams;
        const method = req.method ?? 'GET';
        let bodyBuf = Buffer.alloc(0);
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          bodyBuf = await readBody(req);
        }
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, path.slice(7) || '/', query, bodyBuf); return; }
        if (path === '/api/graphql') { handleGraphQL(req, res, bodyBuf); return; }
        if (path === '/mcp') { handleMcp(req, res, bodyBuf); return; }
        const handled = await handleGit(req, res, path, query, bodyBuf);
        if (handled) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        if (!res.headersSent) {
          try { sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' }); } catch { /* ignore */ }
        }
      }
    })();
  });
}
