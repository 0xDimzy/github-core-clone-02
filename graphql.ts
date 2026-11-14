// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send. No GraphQL library: a recursive-descent parser
// plus resolvers over the Forge store.
import { decodeGid, gid, VIEWER } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------- parser
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null; name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeName: string | null; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation'; name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selection: SelectionNode[];
}

class GqlParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
        if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++; }
        else this.pos++;
      } else break;
    }
  }
  private peek(): string { this.skipWs(); return this.src[this.pos] ?? ''; }
  private take(expected?: string): string {
    this.skipWs();
    const c = this.src[this.pos] ?? '';
    if (expected !== undefined && c !== expected) throw new GqlParseError(`expected ${expected} at ${this.pos}, saw ${JSON.stringify(c)}`);
    this.pos++;
    return c;
  }
  private takeName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new GqlParseError(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private takeString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new GqlParseError(`expected string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.pos++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else out += e;
      } else out += c;
    }
    throw new GqlParseError('unterminated string');
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== '') {
      if (this.peek() === '{') {
        ops.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const word = this.takeName();
      if (word === 'query' || word === 'mutation') {
        let name: string | null = null;
        if (/[A-Za-z_]/.test(this.peek())) name = this.takeName();
        const variables: Operation['variables'] = [];
        if (this.peek() === '(') {
          this.take('(');
          while (this.peek() !== ')') {
            this.take('$');
            const vname = this.takeName();
            this.take(':');
            let required = false;
            let type = '';
            if (this.peek() === '[') { this.take('['); type = `[${this.takeName()}]`; if (this.peek() === '!') { this.take('!'); } }
            else type = this.takeName();
            if (this.peek() === '!') { this.take('!'); required = true; }
            if (this.peek() === '=') { this.take('='); this.parseValue(); }
            variables.push({ name: vname, type, required });
          }
          this.take(')');
        }
        ops.push({ type: word, name, variables, selection: this.parseSelectionSet() });
      } else if (word === 'fragment') {
        this.takeName();
        if (this.peek() === 'o' || /[A-Za-z]/.test(this.peek())) { this.takeName(); this.takeName(); }
        this.parseSelectionSet();
      } else throw new GqlParseError(`unexpected ${word}`);
    }
    return ops;
  }

  parseSelectionSet(): SelectionNode[] {
    this.take('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new GqlParseError('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.take('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      if (this.src.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
        this.pos += 2;
        const typeName = this.takeName();
        return { kind: 'inline', typeName, selection: this.parseSelectionSet() };
      }
      this.takeName();
      return { kind: 'inline', typeName: null, selection: [] };
    }
    const first = this.takeName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') { this.take(':'); alias = first; name = this.takeName(); }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.take('(');
      while (this.peek() !== ')') {
        const aname = this.takeName();
        this.take(':');
        args.push({ name: aname, value: this.parseValue() });
      }
      this.take(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  parseValue(): ValueNode {
    const c = this.peek();
    if (c === '$') { this.take('$'); return { kind: 'variable', name: this.takeName() }; }
    if (c === '"') return { kind: 'string', value: this.takeString() };
    if (c === '[') {
      this.take('[');
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.take(']');
      return { kind: 'list', values };
    }
    if (c === '{') {
      this.take('{');
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.takeName();
        this.take(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.take('}');
      return { kind: 'object', fields };
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(this.src.slice(this.pos));
      if (!m) throw new GqlParseError('bad number');
      this.pos += m[0].length;
      return m[0].includes('.') ? { kind: 'float', value: parseFloat(m[0]) } : { kind: 'int', value: parseInt(m[0], 10) };
    }
    const name = this.takeName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueOf(v, variables));
    case 'object': { const o: Record<string, unknown> = {}; for (const f of node.fields) o[f.name] = valueOf(f.value, variables); return o; }
  }
}

// ---------------------------------------------------------------- schema field tables (for validation)
const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'private', 'isPrivate'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'author'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'createdAt', 'author'],
};

const TYPE_OF: Record<string, string> = {
  viewer: 'User', repository: 'Repository', node: 'Node',
  owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
  pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  author: 'User', nodes: '*', edges: '*', pageInfo: 'PageInfo', files: 'PullRequestChangedFileConnection',
  commentEdge: 'CommentEdge', comments: 'IssueConnection',
};

function typeNameOfField(parentType: string, field: string): string {
  if (parentType === 'Query' && field === '__type') return '__Type';
  return TYPE_OF[field] ?? 'Scalar';
}

// ---------------------------------------------------------------- executor
export interface GqlResult { data: Record<string, unknown> | null; errors?: Array<{ message: string }> | undefined; }

interface Ctx { forge: Forge; }

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, variables);
  return out;
}

function validateSelection(selection: SelectionNode[], parentType: string, errors: Array<{ message: string }>): void {
  const allowed = FIELDS[parentType];
  for (const sel of selection) {
    if (sel.kind === 'inline') {
      if (sel.typeName) validateSelection(sel.selection, sel.typeName, errors);
      continue;
    }
    const f = sel.field;
    if (f.name.startsWith('__')) continue;
    if (allowed && !allowed.includes(f.name)) {
      errors.push({ message: `Cannot query field "${f.name}" on type "${parentType}".` });
      continue;
    }
    if (f.selection) {
      const childType = typeNameOfField(parentType, f.name);
      if (childType === '*') {
        const elem = parentType === 'IssueConnection' ? 'Issue'
          : parentType === 'PullRequestConnection' ? 'PullRequest'
          : parentType === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile'
          : 'Issue';
        validateSelection(f.selection, elem, errors);
      } else if (childType !== 'Scalar' && childType !== 'Node') {
        validateSelection(f.selection, childType, errors);
      }
    }
  }
}

function cursorFor(seq: number): string { return Buffer.from(`c:${seq}`, 'utf8').toString('base64url'); }
function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^c:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

// Flatten a selection set into plain fields, expanding inline fragments whose
// type condition matches this object type (or has none).
function flatSelection(selection: SelectionNode[] | null, typeName: string): FieldNode[] {
  const out: FieldNode[] = [];
  for (const sel of selection ?? []) {
    if (sel.kind === 'inline') {
      if (sel.typeName === null || sel.typeName === typeName) out.push(...flatSelection(sel.selection, typeName));
    } else out.push(sel.field);
  }
  return out;
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue, selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'Issue')) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = issue.nodeId; break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'body': out[key] = issue.body; break;
      case 'state': out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'url': out[key] = `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      case 'createdAt': out[key] = issue.createdAt; break;
      case 'updatedAt': out[key] = issue.updatedAt; break;
      case 'author': out[key] = userJson(f.selection); break;
      default: out[key] = null;
    }
  }
  return out;
}

function userJson(selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'User')) {
    const key = f.alias ?? f.name;
    if (f.name === 'login') out[key] = VIEWER.login;
    else if (f.name === 'id') out[key] = gid('U', VIEWER.id);
    else if (f.name === 'name') out[key] = VIEWER.name;
    else if (f.name === 'email') out[key] = VIEWER.email;
    else out[key] = null;
  }
  return out;
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull, selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'PullRequest')) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = pull.nodeId; break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'body': out[key] = pull.body; break;
      case 'state': out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'merged': out[key] = pull.merged; break;
      case 'mergeable': out[key] = pull.state !== 'open' ? 'UNKNOWN' : ctx.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'headRefName': out[key] = pull.headRef; break;
      case 'baseRefName': out[key] = pull.baseRef; break;
      case 'headRefOid': out[key] = pull.headSha; break;
      case 'baseRefOid': out[key] = pull.baseSha; break;
      case 'url': out[key] = `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`; break;
      case 'createdAt': out[key] = pull.createdAt; break;
      case 'updatedAt': out[key] = pull.updatedAt; break;
      case 'mergedAt': out[key] = pull.mergedAt; break;
      case 'author': out[key] = userJson(f.selection); break;
      case 'files': {
        const args = argMap(f, {});
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = ctx.forge.pullFiles(repo, pull).slice(0, first);
        const nodeSel = nodeSelectionOf(f, 'nodes');
        out[key] = {
          nodes: files.map((file) => fileNode(file, nodeSel)),
          pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
          totalCount: files.length,
        };
        break;
      }
      default: out[key] = null;
    }
  }
  return out;
}

function fileNode(file: { filename: string; status: string; additions: number; deletions: number; changes: number }, selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'PullRequestChangedFile')) {
    const key = f.alias ?? f.name;
    if (f.name === 'path' || f.name === 'filename') out[key] = file.filename;
    else if (f.name === 'status') out[key] = file.status.toUpperCase();
    else if (f.name === 'additions') out[key] = file.additions;
    else if (f.name === 'deletions') out[key] = file.deletions;
    else if (f.name === 'changes') out[key] = file.changes;
    else out[key] = null;
  }
  return out;
}

function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args = argMap(field, variables);
  const first = typeof args.first === 'number' ? args.first : 10;
  const afterSeq = seqFromCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const desc = orderBy.direction === 'DESC';
  let issues = [...repo.issues.values()];
  if (states) {
    const want = new Set(states.map((s) => String(s).toUpperCase() === 'OPEN' ? 'open' : 'closed'));
    issues = issues.filter((i) => want.has(i.state));
  }
  issues.sort((a, b) => desc ? b.createdSeq - a.createdSeq || b.number - a.number : a.createdSeq - b.createdSeq || a.number - b.number);
  if (afterSeq !== null) issues = issues.filter((i) => desc ? i.createdSeq < afterSeq : i.createdSeq > afterSeq);
  const page = issues.slice(0, first);
  const hasNext = issues.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1].createdSeq) : null;
  const nodeSel = nodeSelectionOf(field, 'nodes');
  return {
    nodes: page.map((i) => issueJson(ctx, repo, i, nodeSel)),
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: afterSeq !== null, endCursor, startCursor: page.length ? cursorFor(page[0].createdSeq) : null },
    totalCount: issues.length,
  };
}

function nodeSelectionOf(field: FieldNode, name: string): SelectionNode[] | null {
  if (!field.selection) return null;
  for (const sel of field.selection) {
    if (sel.kind === 'field' && sel.field.name === name) return sel.field.selection;
  }
  return null;
}

function pullsConnection(ctx: Ctx, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args = argMap(field, variables);
  const first = typeof args.first === 'number' ? args.first : 10;
  let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pulls.slice(0, first);
  const nodeSel = nodeSelectionOf(field, 'nodes');
  return {
    nodes: page.map((p) => pullJson(ctx, repo, p, nodeSel)),
    pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
    totalCount: pulls.length,
  };
}

function repoJson(ctx: Ctx, repo: Repo, selection: SelectionNode[] | null, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'Repository')) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = gid('R', repo.id); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'owner': out[key] = userJson(f.selection); break;
      case 'defaultBranchRef': {
        const tip = ctx.forge.defaultTip(repo);
        out[key] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'url': out[key] = `https://forge.local/${repo.owner}/${repo.name}`; break;
      case 'description': out[key] = repo.description; break;
      case 'createdAt': out[key] = repo.createdAt; break;
      case 'updatedAt': out[key] = repo.updatedAt; break;
      case 'private': case 'isPrivate': out[key] = repo.isPrivate; break;
      case 'issue': {
        const args = argMap(f, variables);
        const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        out[key] = issue ? issueJson(ctx, repo, issue, f.selection) : null;
        break;
      }
      case 'issues': out[key] = issuesConnection(ctx, repo, f, variables); break;
      case 'pullRequests': out[key] = pullsConnection(ctx, repo, f, variables); break;
      case 'pullRequest': {
        const args = argMap(f, variables);
        const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        out[key] = pull ? pullJson(ctx, repo, pull, f.selection) : null;
        break;
      }
      default: out[key] = null;
    }
  }
  return out;
}

const INTROSPECTION: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'] },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'author'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'private', 'isPrivate'] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  User: { fields: ['login', 'id', 'name', 'email', 'url'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function typeJson(field: FieldNode, name: string): Record<string, unknown> {
  const info = INTROSPECTION[name];
  const out: Record<string, unknown> = {};
  for (const sel of field.selection ?? []) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    if (f.name === 'name') out[key] = info ? name : null;
    else if (f.name === 'kind') out[key] = info?.enumValues ? 'ENUM' : 'OBJECT';
    else if (f.name === 'fields') out[key] = info ? info.fields.map((n) => ({ name: n, description: null })) : null;
    else if (f.name === 'enumValues') out[key] = info?.enumValues ? info.enumValues.map((n) => ({ name: n, description: null })) : null;
    else if (f.name === 'description') out[key] = null;
    else out[key] = null;
  }
  if (!info) return { name: null, kind: null, fields: null, enumValues: null, description: null };
  return out;
}

function executeQuery(ctx: Ctx, op: Operation, variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  validateSelection(op.selection, 'Query', errors);
  const out: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    if (f.name === 'viewer') out[key] = userJson(f.selection);
    else if (f.name === '__type') {
      const args = argMap(f, variables);
      const name = typeof args.name === 'string' ? args.name : '';
      out[key] = typeJson(f, name);
    } else if (f.name === 'repository') {
      const args = argMap(f, variables);
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? ctx.forge.getRepo(args.owner, args.name) : undefined;
      out[key] = repo ? repoJson(ctx, repo, f.selection, variables) : null;
    } else if (f.name === 'node') {
      const args = argMap(f, variables);
      out[key] = nodeJson(ctx, args.id, f.selection, variables);
    } else out[key] = null;
  }
  return out;
}

function nodeJson(ctx: Ctx, id: unknown, selection: SelectionNode[] | null, variables: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded) return null;
  if (decoded.kind === 'R') {
    const repo = ctx.forge.getRepoById(Number(decoded.parts[0]));
    if (!repo) return null;
    return repoJson(ctx, repo, selection, variables);
  }
  if (decoded.kind === 'I') {
    const repo = ctx.forge.getRepoById(Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    if (!repo || !issue) return null;
    return issueJson(ctx, repo, issue, selection);
  }
  if (decoded.kind === 'P') {
    const repo = ctx.forge.getRepoById(Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    if (!repo || !pull) return null;
    return pullJson(ctx, repo, pull, selection);
  }
  return null;
}

function executeMutation(ctx: Ctx, op: Operation, variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  validateSelection(op.selection, 'Mutation', errors);
  const out: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    const args = argMap(f, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (f.name === 'createIssue') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      const repo = decoded?.kind === 'R' ? ctx.forge.getRepoById(Number(decoded.parts[0])) : undefined;
      if (!repo || typeof input.title !== 'string') { errors.push({ message: 'createIssue: repository not found' }); out[key] = null; continue; }
      const issue = ctx.forge.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
      out[key] = { issue: issueJson(ctx, repo, issue, nodeSelectionOf(f, 'issue')) };
    } else if (f.name === 'closeIssue') {
      const decoded = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
      const repo = decoded?.kind === 'I' ? ctx.forge.getRepoById(Number(decoded.parts[0])) : undefined;
      const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !issue) { errors.push({ message: 'closeIssue: issue not found' }); out[key] = null; continue; }
      issue.state = 'closed';
      issue.updatedAt = ctx.forge.stamp().iso;
      ctx.forge.touchIssue(repo, issue.number);
      out[key] = { issue: issueJson(ctx, repo, issue, nodeSelectionOf(f, 'issue')) };
    } else if (f.name === 'createPullRequest') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      const repo = decoded?.kind === 'R' ? ctx.forge.getRepoById(Number(decoded.parts[0])) : undefined;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = repo?.refs.get(`refs/heads/${head}`);
      const baseSha = repo?.refs.get(`refs/heads/${base}`);
      if (!repo || !headSha || !baseSha || typeof input.title !== 'string') { errors.push({ message: 'createPullRequest: repository or branch not found' }); out[key] = null; continue; }
      const pull = ctx.forge.createPull(repo, input.title, typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
      out[key] = { pullRequest: pullJson(ctx, repo, pull, nodeSelectionOf(f, 'pullRequest')) };
    } else if (f.name === 'mergePullRequest') {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
      const repo = decoded?.kind === 'P' ? ctx.forge.getRepoById(Number(decoded.parts[0])) : undefined;
      const pull = repo?.pulls.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !pull) { errors.push({ message: 'mergePullRequest: pull request not found' }); out[key] = null; continue; }
      if (ctx.forge.pullConflicts(repo, pull)) { errors.push({ message: 'mergePullRequest: merge conflict' }); out[key] = null; continue; }
      ctx.forge.mergePull(repo, pull);
      out[key] = { pullRequest: pullJson(ctx, repo, pull, nodeSelectionOf(f, 'pullRequest')) };
    } else if (f.name === 'addComment') {
      const decoded = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
      const repo = decoded?.kind === 'I' ? ctx.forge.getRepoById(Number(decoded.parts[0])) : undefined;
      const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !issue || typeof input.body !== 'string') { errors.push({ message: 'addComment: subject not found' }); out[key] = null; continue; }
      const comment = ctx.forge.addComment(repo, issue, input.body);
      const nodeSel = nodeSelectionOf(f, 'commentEdge');
      let nodeOut: Record<string, unknown> | null = null;
      if (nodeSel) {
        for (const s2 of nodeSel) {
          if (s2.kind === 'field' && s2.field.name === 'node') {
            const inner: Record<string, unknown> = {};
            for (const s3 of s2.field.selection ?? []) {
              if (s3.kind !== 'field') continue;
              const k3 = s3.field.alias ?? s3.field.name;
              if (s3.field.name === 'id') inner[k3] = comment.nodeId;
              else if (s3.field.name === 'body') inner[k3] = comment.body;
              else inner[k3] = null;
            }
            nodeOut = inner;
          }
        }
      }
      out[key] = { commentEdge: { node: nodeOut ?? { id: comment.nodeId, body: comment.body } } };
    } else out[key] = null;
  }
  return out;
}

/** Execute one GraphQL operation body ({query, variables, operationName}). */
export function executeGraphQL(forge: Forge, body: unknown): GqlResult {
  const ctx: Ctx = { forge };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL body must be an object with query and variables' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  const operationName = (body as Record<string, unknown>).operationName;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided' }] };
  }
  let ops: Operation[];
  try {
    ops = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'No operation provided' }] };
  let op: Operation | undefined;
  if (typeof operationName === 'string' && operationName !== '') op = ops.find((o) => o.name === operationName);
  if (!op) op = ops[0];
  const errors: Array<{ message: string }> = [];
  const data = op.type === 'mutation' ? executeMutation(ctx, op, variables, errors) : executeQuery(ctx, op, variables, errors);
  return errors.length ? { data, errors } : { data };
}
