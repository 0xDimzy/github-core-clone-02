// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send. No GraphQL library: a recursive-descent parser
// plus resolvers over the Forge store.
//
// The file is laid out in pipeline order:
//   1. AST node types — what the parser produces
//   2. Parser — recursive descent over the query text
//   3. Value resolution — literal AST nodes against the variables
//   4. Schema tables — which fields exist on which type (validation)
//   5. Selection helpers — flattening fragments, cursors, page info
//   6. Object builders — one per GraphQL object type
//   7. Introspection — the __type query
//   8. Query execution — top-level query fields and node lookup
//   9. Mutations — the five write operations
//  10. executeGraphQL — the public entry point
import { decodeGid, gid, VIEWER } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------- 1. AST

/** A literal value in the query text: variable, scalar, list, or object. */
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

/** One field inside a selection set, with optional alias, args, sub-selection. */
interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

/** One entry of a selection set: a field, or an inline fragment. */
type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeName: string | null; selection: SelectionNode[] };

/** A single top-level operation (query or mutation) from the document. */
interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selection: SelectionNode[];
}

/** The response key for a field: its alias when present, else its name. */
function fieldKey(field: FieldNode): string {
  return field.alias ?? field.name;
}

// ---------------------------------------------------------------- 2. Parser

class GqlParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  // -- low-level scanning ------------------------------------------

  /** Skip whitespace, commas, and `#` line comments. */
  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '#') {
        this.skipLineComment();
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        this.pos++;
      } else {
        break;
      }
    }
  }

  /** Advance past a `#` comment up to (not including) the newline. */
  private skipLineComment(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
  }

  /** Next non-whitespace character without consuming it. */
  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  /** Consume one character, requiring it to equal `expected` when given. */
  private take(expected?: string): string {
    this.skipWs();
    const c = this.src[this.pos] ?? '';
    if (expected !== undefined && c !== expected) {
      throw new GqlParseError(`expected ${expected} at ${this.pos}, saw ${JSON.stringify(c)}`);
    }
    this.pos++;
    return c;
  }

  /** Consume a bare name ([A-Za-z_][A-Za-z0-9_]*). */
  private takeName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new GqlParseError(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  /** Decode one backslash escape inside a string literal. */
  private readEscape(): string {
    const e = this.src[this.pos++];
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    return e;
  }

  /** Consume a double-quoted string literal, handling escapes. */
  private takeString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new GqlParseError(`expected string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') out += this.readEscape();
      else out += c;
    }
    throw new GqlParseError('unterminated string');
  }

  /** Consume an integer or float literal. */
  private readNumberLiteral(): ValueNode {
    const m = /^-?[0-9]+(\.[0-9]+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new GqlParseError('bad number');
    this.pos += m[0].length;
    return m[0].includes('.')
      ? { kind: 'float', value: parseFloat(m[0]) }
      : { kind: 'int', value: parseInt(m[0], 10) };
  }

  // -- document structure ------------------------------------------

  /** Parse the whole document into its operations. */
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== '') {
      if (this.peek() === '{') {
        // Shorthand query: a bare selection set with no keyword.
        ops.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const word = this.takeName();
      if (word === 'query' || word === 'mutation') {
        ops.push(this.parseOperation(word));
      } else if (word === 'fragment') {
        this.parseFragmentDefinition();
      } else {
        throw new GqlParseError(`unexpected ${word}`);
      }
    }
    return ops;
  }

  /** Parse one `query`/`mutation` operation after its keyword. */
  private parseOperation(word: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    if (/[A-Za-z_]/.test(this.peek())) name = this.takeName();
    const variables = this.peek() === '(' ? this.parseVariableDefinitions() : [];
    return { type: word, name, variables, selection: this.parseSelectionSet() };
  }

  /** Parse a `($name: Type, ...)` variable-definition list. */
  private parseVariableDefinitions(): Operation['variables'] {
    const variables: Operation['variables'] = [];
    this.take('(');
    while (this.peek() !== ')') {
      this.take('$');
      const vname = this.takeName();
      this.take(':');
      let required = false;
      let type = '';
      if (this.peek() === '[') {
        this.take('[');
        type = `[${this.takeName()}]`;
        if (this.peek() === '!') this.take('!');
      } else {
        type = this.takeName();
      }
      if (this.peek() === '!') {
        this.take('!');
        required = true;
      }
      if (this.peek() === '=') {
        this.take('=');
        this.parseValue();
      }
      variables.push({ name: vname, type, required });
    }
    this.take(')');
    return variables;
  }

  /** Parse a `fragment Name on Type { ... }` definition (and discard it). */
  private parseFragmentDefinition(): void {
    this.takeName();
    if (this.peek() === 'o' || /[A-Za-z]/.test(this.peek())) {
      this.takeName();
      this.takeName();
    }
    this.parseSelectionSet();
  }

  /** Parse a `{ ... }` selection set. */
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

  /** Parse one entry of a selection set: field or inline fragment. */
  private parseSelection(): SelectionNode {
    if (this.src.startsWith('...', this.pos)) return this.parseInlineFragment();
    return { kind: 'field', field: this.parseFieldNode() };
  }

  /** Parse a `...on Type { ... }` or `...FragmentName` spread. */
  private parseInlineFragment(): SelectionNode {
    this.pos += 3;
    this.skipWs();
    if (this.src.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
      this.pos += 2;
      const typeName = this.takeName();
      return { kind: 'inline', typeName, selection: this.parseSelectionSet() };
    }
    // Named fragment spread: the fragment body is not inlined (fragments
    // are parsed and discarded in parseFragmentDefinition), so it selects
    // nothing here.
    this.takeName();
    return { kind: 'inline', typeName: null, selection: [] };
  }

  /** Parse one field: optional alias, name, arguments, sub-selection. */
  private parseFieldNode(): FieldNode {
    const first = this.takeName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.take(':');
      alias = first;
      name = this.takeName();
    }
    const args = this.peek() === '(' ? this.parseArguments() : [];
    let selection: SelectionNode[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  /** Parse a `(name: value, ...)` argument list. */
  private parseArguments(): FieldNode['args'] {
    const args: FieldNode['args'] = [];
    this.take('(');
    while (this.peek() !== ')') {
      const aname = this.takeName();
      this.take(':');
      args.push({ name: aname, value: this.parseValue() });
    }
    this.take(')');
    return args;
  }

  // -- values ------------------------------------------------------

  /** Parse one literal value. */
  parseValue(): ValueNode {
    const c = this.peek();
    if (c === '$') {
      this.take('$');
      return { kind: 'variable', name: this.takeName() };
    }
    if (c === '"') return { kind: 'string', value: this.takeString() };
    if (c === '[') return this.parseListValue();
    if (c === '{') return this.parseObjectValue();
    if (c === '-' || /[0-9]/.test(c)) return this.readNumberLiteral();
    const name = this.takeName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  /** Parse a `[value, ...]` list literal. */
  private parseListValue(): ValueNode {
    this.take('[');
    const values: ValueNode[] = [];
    while (this.peek() !== ']') values.push(this.parseValue());
    this.take(']');
    return { kind: 'list', values };
  }

  /** Parse a `{name: value, ...}` object literal. */
  private parseObjectValue(): ValueNode {
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
}

// ---------------------------------------------------------------- 3. Values

/** Resolve a literal AST node to a plain value, substituting variables. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const f of node.fields) o[f.name] = valueOf(f.value, variables);
      return o;
    }
  }
}

// ---------------------------------------------------------------- 4. Schema

// Field tables used to validate selections: which fields exist on each type.
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

// The object type a field resolves to ('*' = a connection whose element
// type depends on the parent; 'Scalar' = a leaf value).
const TYPE_OF: Record<string, string> = {
  viewer: 'User',
  repository: 'Repository',
  node: 'Node',
  owner: 'User',
  defaultBranchRef: 'Ref',
  issue: 'Issue',
  issues: 'IssueConnection',
  pullRequests: 'PullRequestConnection',
  pullRequest: 'PullRequest',
  author: 'User',
  nodes: '*',
  edges: '*',
  pageInfo: 'PageInfo',
  files: 'PullRequestChangedFileConnection',
  commentEdge: 'CommentEdge',
  comments: 'IssueConnection',
};

/** The GraphQL type of `field` when selected on `parentType`. */
function typeNameOfField(parentType: string, field: string): string {
  if (parentType === 'Query' && field === '__type') return '__Type';
  return TYPE_OF[field] ?? 'Scalar';
}

/** Element type of a connection's `nodes`/`edges` lists. */
function connectionElementType(parentType: string): string {
  if (parentType === 'IssueConnection') return 'Issue';
  if (parentType === 'PullRequestConnection') return 'PullRequest';
  if (parentType === 'PullRequestChangedFileConnection') return 'PullRequestChangedFile';
  return 'Issue';
}

// ---------------------------------------------------------------- 5. Selection

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }> | undefined;
}

interface Ctx {
  forge: Forge;
}

/** Evaluate a field's arguments against the operation variables. */
function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, variables);
  return out;
}

/** Recursively validate a selection set against the schema tables. */
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
        validateSelection(f.selection, connectionElementType(parentType), errors);
      } else if (childType !== 'Scalar' && childType !== 'Node') {
        validateSelection(f.selection, childType, errors);
      }
    }
  }
}

/** Encode a sequence number as an opaque page cursor. */
function cursorFor(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64url');
}

/** Decode a page cursor back to its sequence number, or null. */
function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^c:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** A Relay-style pageInfo object for a connection. */
function pageInfoFor(hasNextPage: boolean, hasPreviousPage: boolean, endCursor: string | null, startCursor: string | null): Record<string, unknown> {
  return { hasNextPage, hasPreviousPage, endCursor, startCursor };
}

// Flatten a selection set into plain fields, expanding inline fragments
// whose type condition matches this object type (or has none).
function flatSelection(selection: SelectionNode[] | null, typeName: string): FieldNode[] {
  const out: FieldNode[] = [];
  for (const sel of selection ?? []) {
    if (sel.kind === 'inline') {
      if (sel.typeName === null || sel.typeName === typeName) {
        out.push(...flatSelection(sel.selection, typeName));
      }
    } else {
      out.push(sel.field);
    }
  }
  return out;
}

/** The sub-selection of a named child field (e.g. `nodes` inside a connection). */
function nodeSelectionOf(field: FieldNode, name: string): SelectionNode[] | null {
  if (!field.selection) return null;
  for (const sel of field.selection) {
    if (sel.kind === 'field' && sel.field.name === name) return sel.field.selection;
  }
  return null;
}

// ---------------------------------------------------------------- 6. Objects

/** The viewer (the single forge user) as a User object. */
function userJson(selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'User')) {
    const key = fieldKey(f);
    if (f.name === 'login') out[key] = VIEWER.login;
    else if (f.name === 'id') out[key] = gid('U', VIEWER.id);
    else if (f.name === 'name') out[key] = VIEWER.name;
    else if (f.name === 'email') out[key] = VIEWER.email;
    else out[key] = null;
  }
  return out;
}

/** One issue as an Issue object. */
function issueJson(ctx: Ctx, repo: Repo, issue: Issue, selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'Issue')) {
    const key = fieldKey(f);
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

/** One changed file as a PullRequestChangedFile object. */
function fileNode(
  file: { filename: string; status: string; additions: number; deletions: number; changes: number },
  selection: SelectionNode[] | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'PullRequestChangedFile')) {
    const key = fieldKey(f);
    if (f.name === 'path' || f.name === 'filename') out[key] = file.filename;
    else if (f.name === 'status') out[key] = file.status.toUpperCase();
    else if (f.name === 'additions') out[key] = file.additions;
    else if (f.name === 'deletions') out[key] = file.deletions;
    else if (f.name === 'changes') out[key] = file.changes;
    else out[key] = null;
  }
  return out;
}

/** One pull request as a PullRequest object. */
function pullJson(ctx: Ctx, repo: Repo, pull: Pull, selection: SelectionNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'PullRequest')) {
    const key = fieldKey(f);
    switch (f.name) {
      case 'id': out[key] = pull.nodeId; break;
      case 'number': out[key] = pull.number; break;
      case 'title': out[key] = pull.title; break;
      case 'body': out[key] = pull.body; break;
      case 'state': out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'merged': out[key] = pull.merged; break;
      case 'mergeable': out[key] = pullMergeableState(ctx, repo, pull); break;
      case 'headRefName': out[key] = pull.headRef; break;
      case 'baseRefName': out[key] = pull.baseRef; break;
      case 'headRefOid': out[key] = pull.headSha; break;
      case 'baseRefOid': out[key] = pull.baseSha; break;
      case 'url': out[key] = `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`; break;
      case 'createdAt': out[key] = pull.createdAt; break;
      case 'updatedAt': out[key] = pull.updatedAt; break;
      case 'mergedAt': out[key] = pull.mergedAt; break;
      case 'author': out[key] = userJson(f.selection); break;
      case 'files': out[key] = pullFilesConnection(ctx, repo, pull, f); break;
      default: out[key] = null;
    }
  }
  return out;
}

/** The mergeable state of a pull request: UNKNOWN once closed, else by conflict. */
function pullMergeableState(ctx: Ctx, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return ctx.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** The `files` connection of a pull request (first N changed files). */
function pullFilesConnection(ctx: Ctx, repo: Repo, pull: Pull, field: FieldNode): Record<string, unknown> {
  const args = argMap(field, {});
  const first = typeof args.first === 'number' ? args.first : 100;
  const files = ctx.forge.pullFiles(repo, pull).slice(0, first);
  const nodeSel = nodeSelectionOf(field, 'nodes');
  return {
    nodes: files.map((file) => fileNode(file, nodeSel)),
    pageInfo: pageInfoFor(false, false, null, null),
    totalCount: files.length,
  };
}

/** Keep only issues whose state is in `states` (OPEN/CLOSED), or all when null. */
function filterIssuesByState(issues: Issue[], states: string[] | null): Issue[] {
  if (!states) return issues;
  const want = new Set(states.map((s) => (String(s).toUpperCase() === 'OPEN' ? 'open' : 'closed')));
  return issues.filter((issue) => want.has(issue.state));
}

/** Sort issues by creation sequence (then number), ascending or descending. */
function sortIssueList(issues: Issue[], desc: boolean): Issue[] {
  const sorted = [...issues];
  sorted.sort((a, b) =>
    desc
      ? b.createdSeq - a.createdSeq || b.number - a.number
      : a.createdSeq - b.createdSeq || a.number - b.number,
  );
  return sorted;
}

/** The `issues` connection of a repository: filter, sort, paginate. */
function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args = argMap(field, variables);
  const first = typeof args.first === 'number' ? args.first : 10;
  const afterSeq = seqFromCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const desc = orderBy.direction === 'DESC';
  let issues = filterIssuesByState([...repo.issues.values()], states);
  issues = sortIssueList(issues, desc);
  if (afterSeq !== null) {
    issues = issues.filter((i) => (desc ? i.createdSeq < afterSeq : i.createdSeq > afterSeq));
  }
  const page = issues.slice(0, first);
  const hasNext = issues.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1].createdSeq) : null;
  const startCursor = page.length ? cursorFor(page[0].createdSeq) : null;
  const nodeSel = nodeSelectionOf(field, 'nodes');
  return {
    nodes: page.map((i) => issueJson(ctx, repo, i, nodeSel)),
    pageInfo: pageInfoFor(hasNext, afterSeq !== null, endCursor, startCursor),
    totalCount: issues.length,
  };
}

/** The `pullRequests` connection of a repository (open pulls, newest first). */
function pullsConnection(ctx: Ctx, repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args = argMap(field, variables);
  const first = typeof args.first === 'number' ? args.first : 10;
  const pulls = [...repo.pulls.values()]
    .filter((p) => p.state === 'open')
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pulls.slice(0, first);
  const nodeSel = nodeSelectionOf(field, 'nodes');
  return {
    nodes: page.map((p) => pullJson(ctx, repo, p, nodeSel)),
    pageInfo: pageInfoFor(pulls.length > first, false, null, null),
    totalCount: pulls.length,
  };
}

/** One repository as a Repository object. */
function repoJson(ctx: Ctx, repo: Repo, selection: SelectionNode[] | null, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flatSelection(selection, 'Repository')) {
    const key = fieldKey(f);
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
      case 'private':
      case 'isPrivate': out[key] = repo.isPrivate; break;
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

// ---------------------------------------------------------------- 7. Introspection

// The subset of the schema exposed through __type queries.
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

/** One __Type object for the introspected type name (nulls when unknown). */
function typeJson(field: FieldNode, name: string): Record<string, unknown> {
  const info = INTROSPECTION[name];
  const out: Record<string, unknown> = {};
  for (const sel of field.selection ?? []) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = fieldKey(f);
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

// ---------------------------------------------------------------- 8. Queries

/** Execute one query operation. */
function executeQuery(ctx: Ctx, op: Operation, variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  validateSelection(op.selection, 'Query', errors);
  const out: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = fieldKey(f);
    if (f.name === 'viewer') {
      out[key] = userJson(f.selection);
    } else if (f.name === '__type') {
      const args = argMap(f, variables);
      const name = typeof args.name === 'string' ? args.name : '';
      out[key] = typeJson(f, name);
    } else if (f.name === 'repository') {
      const args = argMap(f, variables);
      const repo = typeof args.owner === 'string' && typeof args.name === 'string'
        ? ctx.forge.getRepo(args.owner, args.name)
        : undefined;
      out[key] = repo ? repoJson(ctx, repo, f.selection, variables) : null;
    } else if (f.name === 'node') {
      const args = argMap(f, variables);
      out[key] = nodeJson(ctx, args.id, f.selection, variables);
    } else {
      out[key] = null;
    }
  }
  return out;
}

/** Resolve a global node id (R/I/P) to its object. */
function nodeJson(ctx: Ctx, id: unknown, selection: SelectionNode[] | null, variables: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded) return null;
  const repo = ctx.forge.getRepoById(Number(decoded.parts[0]));
  if (!repo) return null;
  if (decoded.kind === 'R') return repoJson(ctx, repo, selection, variables);
  if (decoded.kind === 'I') {
    const issue = repo.issues.get(Number(decoded.parts[1]));
    return issue ? issueJson(ctx, repo, issue, selection) : null;
  }
  if (decoded.kind === 'P') {
    const pull = repo.pulls.get(Number(decoded.parts[1]));
    return pull ? pullJson(ctx, repo, pull, selection) : null;
  }
  return null;
}

// ---------------------------------------------------------------- 9. Mutations

/** A repo decoded from a global id of the expected kind, or undefined. */
function repoFromGid(ctx: Ctx, id: unknown, kind: string): Repo | undefined {
  const decoded = typeof id === 'string' ? decodeGid(id) : null;
  if (!decoded || decoded.kind !== kind) return undefined;
  return ctx.forge.getRepoById(Number(decoded.parts[0]));
}

/** An issue (plus its repo) decoded from a global id, or null. */
function issueFromGid(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } | null {
  const repo = repoFromGid(ctx, id, 'I');
  if (!repo) return null;
  const decoded = typeof id === 'string' ? decodeGid(id) : null;
  const issue = repo.issues.get(Number(decoded?.parts[1] ?? NaN));
  if (!issue) return null;
  return { repo, issue };
}

/** A pull request (plus its repo) decoded from a global id, or null. */
function pullFromGid(ctx: Ctx, id: unknown): { repo: Repo; pull: Pull } | null {
  const repo = repoFromGid(ctx, id, 'P');
  if (!repo) return null;
  const decoded = typeof id === 'string' ? decodeGid(id) : null;
  const pull = repo.pulls.get(Number(decoded?.parts[1] ?? NaN));
  if (!pull) return null;
  return { repo, pull };
}

/** createIssue: make the issue and return its payload. */
function mutateCreateIssue(ctx: Ctx, input: Record<string, unknown>, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const repo = repoFromGid(ctx, input.repositoryId, 'R');
  if (!repo || typeof input.title !== 'string') {
    errors.push({ message: 'createIssue: repository not found' });
    return null;
  }
  const issue = ctx.forge.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
  return { issue: issueJson(ctx, repo, issue, nodeSelectionOf(field, 'issue')) };
}

/** closeIssue: close the issue and return its payload. */
function mutateCloseIssue(ctx: Ctx, input: Record<string, unknown>, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const found = issueFromGid(ctx, input.issueId);
  if (!found) {
    errors.push({ message: 'closeIssue: issue not found' });
    return null;
  }
  const { repo, issue } = found;
  issue.state = 'closed';
  issue.updatedAt = ctx.forge.stamp().iso;
  ctx.forge.touchIssue(repo, issue.number);
  return { issue: issueJson(ctx, repo, issue, nodeSelectionOf(field, 'issue')) };
}

/** createPullRequest: open the PR and return its payload. */
function mutateCreatePullRequest(ctx: Ctx, input: Record<string, unknown>, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const repo = repoFromGid(ctx, input.repositoryId, 'R');
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headSha = repo?.refs.get(`refs/heads/${head}`);
  const baseSha = repo?.refs.get(`refs/heads/${base}`);
  if (!repo || !headSha || !baseSha || typeof input.title !== 'string') {
    errors.push({ message: 'createPullRequest: repository or branch not found' });
    return null;
  }
  const pull = ctx.forge.createPull(repo, input.title, typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
  return { pullRequest: pullJson(ctx, repo, pull, nodeSelectionOf(field, 'pullRequest')) };
}

/** mergePullRequest: squash-merge the PR and return its payload. */
function mutateMergePullRequest(ctx: Ctx, input: Record<string, unknown>, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const found = pullFromGid(ctx, input.pullRequestId);
  if (!found) {
    errors.push({ message: 'mergePullRequest: pull request not found' });
    return null;
  }
  const { repo, pull } = found;
  if (ctx.forge.pullConflicts(repo, pull)) {
    errors.push({ message: 'mergePullRequest: merge conflict' });
    return null;
  }
  ctx.forge.mergePull(repo, pull);
  return { pullRequest: pullJson(ctx, repo, pull, nodeSelectionOf(field, 'pullRequest')) };
}

/** Build the `node` object of an addComment commentEdge from its selection. */
function buildCommentNode(nodeSel: SelectionNode[] | null, comment: { nodeId: string; body: string }): Record<string, unknown> {
  let nodeOut: Record<string, unknown> | null = null;
  if (nodeSel) {
    for (const sel of nodeSel) {
      if (sel.kind === 'field' && sel.field.name === 'node') {
        const inner: Record<string, unknown> = {};
        for (const sub of sel.field.selection ?? []) {
          if (sub.kind !== 'field') continue;
          const key = fieldKey(sub.field);
          if (sub.field.name === 'id') inner[key] = comment.nodeId;
          else if (sub.field.name === 'body') inner[key] = comment.body;
          else inner[key] = null;
        }
        nodeOut = inner;
      }
    }
  }
  return nodeOut ?? { id: comment.nodeId, body: comment.body };
}

/** addComment: append the comment and return its commentEdge payload. */
function mutateAddComment(ctx: Ctx, input: Record<string, unknown>, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const found = issueFromGid(ctx, input.subjectId);
  if (!found || typeof input.body !== 'string') {
    errors.push({ message: 'addComment: subject not found' });
    return null;
  }
  const { repo, issue } = found;
  const comment = ctx.forge.addComment(repo, issue, input.body);
  const nodeSel = nodeSelectionOf(field, 'commentEdge');
  return { commentEdge: { node: buildCommentNode(nodeSel, comment) } };
}

/** Execute one mutation operation, dispatching each top-level field. */
function executeMutation(ctx: Ctx, op: Operation, variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  validateSelection(op.selection, 'Mutation', errors);
  const out: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'inline') continue;
    const f = sel.field;
    const key = fieldKey(f);
    const args = argMap(f, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (f.name === 'createIssue') out[key] = mutateCreateIssue(ctx, input, f, errors);
    else if (f.name === 'closeIssue') out[key] = mutateCloseIssue(ctx, input, f, errors);
    else if (f.name === 'createPullRequest') out[key] = mutateCreatePullRequest(ctx, input, f, errors);
    else if (f.name === 'mergePullRequest') out[key] = mutateMergePullRequest(ctx, input, f, errors);
    else if (f.name === 'addComment') out[key] = mutateAddComment(ctx, input, f, errors);
    else out[key] = null;
  }
  return out;
}

// ---------------------------------------------------------------- 10. Entry

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
  const op = selectOperation(ops, operationName);
  const errors: Array<{ message: string }> = [];
  const data = op.type === 'mutation'
    ? executeMutation(ctx, op, variables, errors)
    : executeQuery(ctx, op, variables, errors);
  return errors.length ? { data, errors } : { data };
}

/** Pick the operation to run: the named one when operationName matches, else the first. */
function selectOperation(ops: Operation[], operationName: unknown): Operation {
  if (typeof operationName === 'string' && operationName !== '') {
    const named = ops.find((o) => o.name === operationName);
    if (named) return named;
  }
  return ops[0];
}
