// mcp.ts — Model Context Protocol over JSON-RPC 2.0 (Streamable HTTP, plain JSON).
// Implements the modern era: server/discover, initialize, tools/list, tools/call.
//
// Layout of this file, top to bottom:
//   1. tool catalog (the six tools, built with defineTool)
//   2. JSON-RPC envelope helpers (rpcResult / rpcError)
//   3. view serializers (repoJson / issueJson / pullJson)
//   4. argument helpers (string/number args, owner+repo resolution)
//   5. method dispatch (handleMcp -> one named handler per method)
//   6. tool dispatch (callTool -> one named handler per tool)
import { VIEWER } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ------------------------------------------------------------- 1. tool catalog

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

type PropSpec = Record<string, { type: string; description: string }>;

/** Build one tool definition from a name, a description, its argument
 *  properties, and the list of required argument names. */
function defineTool(name: string, description: string, properties: PropSpec, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_PROP = { type: 'string', description: 'Repository owner login' };
const REPO_PROP = { type: 'string', description: 'Repository name' };

const TOOLS: ToolDef[] = [
  defineTool('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'Repository name' },
    description: { type: 'string', description: 'Repository description' },
    private: { type: 'boolean', description: 'Whether the repository is private' },
  }, ['name']),
  defineTool('get_repo', 'Get a repository by owner and name.', {
    owner: OWNER_PROP,
    repo: REPO_PROP,
    full_name: { type: 'string', description: 'Repository full name owner/repo' },
  }, ['owner', 'repo']),
  defineTool('create_issue', 'Create an issue in a repository.', {
    owner: OWNER_PROP,
    repo: REPO_PROP,
    title: { type: 'string', description: 'Issue title' },
    body: { type: 'string', description: 'Issue body' },
  }, ['owner', 'repo', 'title']),
  defineTool('list_issues', 'List issues in a repository.', {
    owner: OWNER_PROP,
    repo: REPO_PROP,
    state: { type: 'string', description: 'Issue state: open, closed, or all' },
  }, ['owner', 'repo']),
  defineTool('create_pull_request', 'Create a pull request in a repository.', {
    owner: OWNER_PROP,
    repo: REPO_PROP,
    title: { type: 'string', description: 'Pull request title' },
    head: { type: 'string', description: 'Head branch name' },
    base: { type: 'string', description: 'Base branch name' },
    body: { type: 'string', description: 'Pull request body' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  defineTool('merge_pull_request', 'Merge a pull request (squash) in a repository.', {
    owner: OWNER_PROP,
    repo: REPO_PROP,
    pull_number: { type: 'integer', description: 'Pull request number' },
    number: { type: 'integer', description: 'Pull request number' },
  }, ['owner', 'repo', 'pull_number']),
];

// ------------------------------------------------------------- 2. JSON-RPC envelope

export interface McpRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; }

interface JsonRpcError { code: number; message: string; }

function rpcError(id: unknown, err: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/** A method-not-found error for an unknown method or tool name. */
function methodNotFound(id: unknown, name: string): Record<string, unknown> {
  return rpcError(id, { code: -32601, message: `Method not found: ${name}` });
}

/** The server's own identity, sent in server/discover and initialize. */
function serverInfo(): Record<string, unknown> {
  return { name: 'forge', version: '1.0.0' };
}

// ------------------------------------------------------------- 3. view serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch,
    created_at: repo.createdAt, updated_at: repo.updatedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt, updated_at: pull.updatedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ------------------------------------------------------------- 4. argument helpers

function parseOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) { owner = parts[0]; repo = parts[1]; }
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** An optional string argument: the fallback when it is missing or not a string. */
function optionalStringArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Resolve the repo a tool call targets: parse owner/repo from the arguments,
 * then load the repo. Throws 'Missing owner/repo' when the arguments do not
 * name one, and 'NOTFOUND:Repository ... not found' when it does not exist.
 */
function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const orr = parseOwnerRepo(args);
  if (!orr) throw new Error('Missing owner/repo');
  const repo = forge.getRepo(orr.owner, orr.repo);
  if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
  return repo;
}

function toolText(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ------------------------------------------------------------- 5. method dispatch

type McpOutcome = { status: number; body: unknown };

function handleDiscover(id: unknown): McpOutcome {
  return {
    status: 200,
    body: rpcResult(id, {
      supportedVersions: MCP_PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    }),
  };
}

function handleInitialize(id: unknown, params: Record<string, unknown>): McpOutcome {
  const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
  return {
    status: 200,
    body: rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    }),
  };
}

function handleToolsList(id: unknown): McpOutcome {
  return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
}

function handlePing(id: unknown): McpOutcome {
  return { status: 200, body: rpcResult(id, {}) };
}

/** A notification (no id, no response body): acknowledged with 202. */
function handleNotification(): McpOutcome {
  return { status: 202, body: null };
}

function handleToolsCall(forge: Forge, id: unknown, params: Record<string, unknown>): McpOutcome {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { status: 200, body: methodNotFound(id, name) };
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length) {
    return { status: 200, body: rpcResult(id, toolError(`Missing required arguments: ${missing.join(', ')}`)) };
  }
  try {
    return { status: 200, body: rpcResult(id, callTool(forge, name, args)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('NOTFOUND:')) {
      return { status: 200, body: rpcResult(id, toolError(message.slice(9))) };
    }
    return { status: 200, body: rpcError(id, { code: -32602, message }) };
  }
}

/** Handle one JSON-RPC request object. Returns { status, body } — body may be null (notification). */
export function handleMcp(forge: Forge, req: McpRequest): McpOutcome {
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': return handleDiscover(id);
    case 'initialize': return handleInitialize(id, params);
    case 'notifications/initialized':
    case 'notifications/cancelled': return handleNotification();
    case 'ping': return handlePing(id);
    case 'tools/list': return handleToolsList(id);
    case 'tools/call': return handleToolsCall(forge, id, params);
    default:
      if (id === undefined || id === null) return handleNotification();
      return { status: 200, body: methodNotFound(id, method) };
  }
}

// ------------------------------------------------------------- 6. tool dispatch

function createRepoTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repoName = args.name as string;
  if (forge.getRepo(VIEWER.login, repoName)) throw new Error('Repository already exists');
  const repo = forge.createRepo(
    VIEWER.login, repoName,
    optionalStringArg(args, 'description', ''),
    args.private === true,
  );
  return toolText(repoJson(repo));
}

function getRepoTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = requireRepo(forge, args);
  return toolText(repoJson(repo));
}

function createIssueTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = requireRepo(forge, args);
  const issue = forge.createIssue(
    repo,
    args.title as string,
    optionalStringArg(args, 'body', ''),
    [],
  );
  return toolText(issueJson(repo, issue));
}

function listIssuesTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = requireRepo(forge, args);
  const state = optionalStringArg(args, 'state', 'open');
  const issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
  return toolText(issues.map((i) => issueJson(repo, i)));
}

function createPullRequestTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = requireRepo(forge, args);
  const head = args.head as string;
  const base = args.base as string;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new Error(`NOTFOUND:Branch not found: ${!headSha ? head : base}`);
  const pull = forge.createPull(
    repo,
    args.title as string,
    optionalStringArg(args, 'body', ''),
    head, base, headSha, baseSha,
  );
  return toolText(pullJson(repo, pull));
}

function mergePullRequestTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = requireRepo(forge, args);
  const number = (args.pull_number ?? args.number) as number;
  const pull = repo.pulls.get(number);
  if (!pull) throw new Error(`NOTFOUND:Pull request ${number} not found`);
  if (forge.pullConflicts(repo, pull)) throw new Error('Merge conflict');
  const sha = forge.mergePull(repo, pull);
  if (!sha) throw new Error('Merge failed');
  return toolText({ ...pullJson(repo, pull), sha });
}

type ToolHandler = (forge: Forge, args: Record<string, unknown>) => Record<string, unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo: createRepoTool,
  get_repo: getRepoTool,
  create_issue: createIssueTool,
  list_issues: listIssuesTool,
  create_pull_request: createPullRequestTool,
  merge_pull_request: mergePullRequestTool,
};

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(forge, args);
}
