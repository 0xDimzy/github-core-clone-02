// mcp.ts — Model Context Protocol over JSON-RPC 2.0 (Streamable HTTP, plain JSON).
// Implements the modern era: server/discover, initialize, tools/list, tools/call.
import { VIEWER } from './store.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' }, number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

export interface McpRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; }

interface JsonRpcError { code: number; message: string; }

function rpcError(id: unknown, err: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

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

/** Handle one JSON-RPC request object. Returns { status, body } — body may be null (notification). */
export function handleMcp(forge: Forge, req: McpRequest): { status: number; body: unknown } {
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: MCP_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
        }),
      };
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
        }),
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { status: 200, body: rpcError(id, { code: -32601, message: `Method not found: ${name}` }) };
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
    default:
      if (id === undefined || id === null) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, { code: -32601, message: `Method not found: ${method}` }) };
  }
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (forge.getRepo(VIEWER.login, repoName)) throw new Error('Repository already exists');
      const repo = forge.createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolText(repoJson(repo));
    }
    case 'get_repo': {
      const orr = parseOwnerRepo(args);
      if (!orr) throw new Error('Missing owner/repo');
      const repo = forge.getRepo(orr.owner, orr.repo);
      if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
      return toolText(repoJson(repo));
    }
    case 'create_issue': {
      const orr = parseOwnerRepo(args);
      if (!orr) throw new Error('Missing owner/repo');
      const repo = forge.getRepo(orr.owner, orr.repo);
      if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
      const issue = forge.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      return toolText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const orr = parseOwnerRepo(args);
      if (!orr) throw new Error('Missing owner/repo');
      const repo = forge.getRepo(orr.owner, orr.repo);
      if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
      return toolText(issues.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const orr = parseOwnerRepo(args);
      if (!orr) throw new Error('Missing owner/repo');
      const repo = forge.getRepo(orr.owner, orr.repo);
      if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error(`NOTFOUND:Branch not found: ${!headSha ? head : base}`);
      const pull = forge.createPull(repo, args.title as string, typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolText(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const orr = parseOwnerRepo(args);
      if (!orr) throw new Error('Missing owner/repo');
      const repo = forge.getRepo(orr.owner, orr.repo);
      if (!repo) throw new Error(`NOTFOUND:Repository ${orr.owner}/${orr.repo} not found`);
      const number = (args.pull_number ?? args.number) as number;
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`NOTFOUND:Pull request ${number} not found`);
      if (forge.pullConflicts(repo, pull)) throw new Error('Merge conflict');
      const sha = forge.mergePull(repo, pull);
      if (!sha) throw new Error('Merge failed');
      return toolText({ ...pullJson(repo, pull), sha });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
