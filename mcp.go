// mcp.go — Model Context Protocol over JSON-RPC 2.0 (Streamable HTTP,
// plain JSON), plus the REST view serializers shared with app.go.
// A faithful port of the v3 TypeScript mcp.ts.
package main

import (
	"fmt"
	"sort"
	"strings"
)

var mcpProtocolVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

type toolDef struct {
	Name        string
	Description string
	Properties  map[string]interface{}
	Required    []string
}

func defineTool(name, description string, properties map[string]interface{}, required []string) toolDef {
	return toolDef{Name: name, Description: description, Properties: properties, Required: required}
}

func strProp(desc string) map[string]interface{} {
	return map[string]interface{}{"type": "string", "description": desc}
}

var mcpTools []toolDef

func init() {
	ownerProp := strProp("Repository owner login")
	repoProp := strProp("Repository name")
	mcpTools = []toolDef{
		defineTool("create_repo", "Create a new repository for the authenticated user.", map[string]interface{}{
			"name":        strProp("Repository name"),
			"description": strProp("Repository description"),
			"private":     map[string]interface{}{"type": "boolean", "description": "Whether the repository is private"},
		}, []string{"name"}),
		defineTool("get_repo", "Get a repository by owner and name.", map[string]interface{}{
			"owner":     ownerProp,
			"repo":      repoProp,
			"full_name": strProp("Repository full name owner/repo"),
		}, []string{"owner", "repo"}),
		defineTool("create_issue", "Create an issue in a repository.", map[string]interface{}{
			"owner": ownerProp, "repo": repoProp,
			"title": strProp("Issue title"),
			"body":  strProp("Issue body"),
		}, []string{"owner", "repo", "title"}),
		defineTool("list_issues", "List issues in a repository.", map[string]interface{}{
			"owner": ownerProp, "repo": repoProp,
			"state": strProp("Issue state: open, closed, or all"),
		}, []string{"owner", "repo"}),
		defineTool("create_pull_request", "Create a pull request in a repository.", map[string]interface{}{
			"owner": ownerProp, "repo": repoProp,
			"title": strProp("Pull request title"),
			"head":  strProp("Head branch name"),
			"base":  strProp("Base branch name"),
			"body":  strProp("Pull request body"),
		}, []string{"owner", "repo", "title", "head", "base"}),
		defineTool("merge_pull_request", "Merge a pull request (squash) in a repository.", map[string]interface{}{
			"owner": ownerProp, "repo": repoProp,
			"pull_number": map[string]interface{}{"type": "integer", "description": "Pull request number"},
			"number":      map[string]interface{}{"type": "integer", "description": "Pull request number"},
		}, []string{"owner", "repo", "pull_number"}),
	}
}

func toolDefJSON(t toolDef) map[string]interface{} {
	// Properties keep their insertion semantics via a map; the suite
	// parses JSON, so key order is irrelevant.
	return map[string]interface{}{
		"name":        t.Name,
		"description": t.Description,
		"inputSchema": map[string]interface{}{
			"type":       "object",
			"properties": t.Properties,
			"required":   t.Required,
		},
	}
}

// ------------------------------------------------------------- view serializers

func repoJSON(repo *Repo) map[string]interface{} {
	return map[string]interface{}{
		"id": repo.ID, "name": repo.Name, "full_name": repo.Owner + "/" + repo.Name,
		"owner":          map[string]interface{}{"login": repo.Owner, "id": viewerID, "type": "User"},
		"private":        repo.IsPrivate,
		"description":    repo.Description,
		"default_branch": repo.DefaultBranch,
		"created_at":     repo.CreatedAt,
		"updated_at":     repo.UpdatedAt,
		"html_url":       "https://forge.local/" + repo.Owner + "/" + repo.Name,
	}
}

func issueJSON(repo *Repo, issue *Issue) map[string]interface{} {
	var labels []interface{}
	for _, name := range issue.Labels {
		labels = append(labels, map[string]interface{}{"name": name})
	}
	if labels == nil {
		labels = []interface{}{}
	}
	return map[string]interface{}{
		"id": issue.ID, "number": issue.Number, "title": issue.Title, "body": issue.Body, "state": issue.State,
		"labels":     labels,
		"user":       map[string]interface{}{"login": viewerLogin, "id": viewerID},
		"created_at": issue.CreatedAt, "updated_at": issue.UpdatedAt,
		"html_url": "https://forge.local/" + repo.Owner + "/" + repo.Name + "/issues/" + fmt.Sprint(issue.Number),
	}
}

func pullJSON(repo *Repo, pull *Pull) map[string]interface{} {
	mergedAt := interface{}(nil)
	if pull.MergedAt != "" {
		mergedAt = pull.MergedAt
	}
	mergeSha := interface{}(nil)
	if pull.MergeCommitSha != "" {
		mergeSha = pull.MergeCommitSha
	}
	return map[string]interface{}{
		"id": pull.ID, "number": pull.Number, "title": pull.Title, "body": pull.Body, "state": pull.State,
		"merged": pull.Merged, "merged_at": mergedAt, "merge_commit_sha": mergeSha,
		"head":       map[string]interface{}{"ref": pull.HeadRef, "sha": pull.HeadSha},
		"base":       map[string]interface{}{"ref": pull.BaseRef, "sha": pull.BaseSha},
		"user":       map[string]interface{}{"login": viewerLogin, "id": viewerID},
		"created_at": pull.CreatedAt, "updated_at": pull.UpdatedAt,
		"html_url": "https://forge.local/" + repo.Owner + "/" + repo.Name + "/pull/" + fmt.Sprint(pull.Number),
	}
}

// ------------------------------------------------------------- JSON-RPC envelope

type mcpOutcome struct {
	status int
	body   interface{} // nil means notification: empty body
}

func rpcError(id interface{}, code int, message string) map[string]interface{} {
	if id == nil {
		id = nil
	}
	return map[string]interface{}{"jsonrpc": "2.0", "id": id, "error": map[string]interface{}{"code": code, "message": message}}
}

func rpcResult(id interface{}, result interface{}) map[string]interface{} {
	return map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result}
}

func methodNotFound(id interface{}, name string) map[string]interface{} {
	return rpcError(id, -32601, "Method not found: "+name)
}

func serverInfo() map[string]interface{} {
	return map[string]interface{}{"name": "forge", "version": "1.0.0"}
}

// ------------------------------------------------------------- argument helpers

func parseOwnerRepo(args map[string]interface{}) (owner, repo string, ok bool) {
	owner, _ = args["owner"].(string)
	repo, _ = args["repo"].(string)
	if owner == "" || repo == "" {
		if full, isStr := args["full_name"].(string); isStr {
			parts := strings.Split(full, "/")
			if len(parts) == 2 {
				owner, repo = parts[0], parts[1]
			}
		}
	}
	if owner == "" || repo == "" {
		return "", "", false
	}
	return owner, repo, true
}

func optionalStringArg(args map[string]interface{}, key, fallback string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return fallback
}

func requireRepo(forge *Forge, args map[string]interface{}) (*Repo, error) {
	owner, repo, ok := parseOwnerRepo(args)
	if !ok {
		return nil, fmt.Errorf("Missing owner/repo")
	}
	r := forge.GetRepo(owner, repo)
	if r == nil {
		return nil, fmt.Errorf("NOTFOUND:Repository %s/%s not found", owner, repo)
	}
	return r, nil
}

func toolText(result interface{}) map[string]interface{} {
	var text string
	if s, ok := result.(string); ok {
		text = s
	} else {
		text = string(marshalJSON(result))
	}
	return map[string]interface{}{
		"content":           []interface{}{map[string]interface{}{"type": "text", "text": text}},
		"structuredContent": result,
		"isError":           false,
	}
}

func toolError(message string) map[string]interface{} {
	return map[string]interface{}{
		"content": []interface{}{map[string]interface{}{"type": "text", "text": message}},
		"isError": true,
	}
}

// ------------------------------------------------------------- method dispatch

func handleMcp(forge *Forge, req map[string]interface{}) mcpOutcome {
	id, hasID := req["id"]
	_ = hasID
	method, _ := req["method"].(string)
	params := asObj(req["params"])
	if params == nil {
		params = map[string]interface{}{}
	}

	switch method {
	case "server/discover":
		return mcpOutcome{status: 200, body: rpcResult(id, map[string]interface{}{
			"supportedVersions": mcpProtocolVersions,
			"capabilities":      map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo":        serverInfo(),
			"_meta":             map[string]interface{}{"io.modelcontextprotocol/serverInfo": serverInfo()},
		})}
	case "initialize":
		offered := mcpProtocolVersions[0]
		if v, ok := params["protocolVersion"].(string); ok {
			offered = v
		}
		return mcpOutcome{status: 200, body: rpcResult(id, map[string]interface{}{
			"protocolVersion": offered,
			"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo":      serverInfo(),
		})}
	case "notifications/initialized", "notifications/cancelled":
		return mcpOutcome{status: 202, body: nil}
	case "ping":
		return mcpOutcome{status: 200, body: rpcResult(id, map[string]interface{}{})}
	case "tools/list":
		var tools []interface{}
		for _, t := range mcpTools {
			tools = append(tools, toolDefJSON(t))
		}
		return mcpOutcome{status: 200, body: rpcResult(id, map[string]interface{}{"tools": tools})}
	case "tools/call":
		return handleToolsCall(forge, id, params)
	default:
		if id == nil {
			return mcpOutcome{status: 202, body: nil}
		}
		return mcpOutcome{status: 200, body: methodNotFound(id, method)}
	}
}

func handleToolsCall(forge *Forge, id interface{}, params map[string]interface{}) mcpOutcome {
	name, _ := params["name"].(string)
	args := asObj(params["arguments"])
	if args == nil {
		args = map[string]interface{}{}
	}
	var tool *toolDef
	for i := range mcpTools {
		if mcpTools[i].Name == name {
			tool = &mcpTools[i]
			break
		}
	}
	if tool == nil {
		return mcpOutcome{status: 200, body: methodNotFound(id, name)}
	}
	var missing []string
	for _, r := range tool.Required {
		v := args[r]
		if v == nil {
			missing = append(missing, r)
		} else if s, ok := v.(string); ok && s == "" {
			missing = append(missing, r)
		}
	}
	if len(missing) > 0 {
		return mcpOutcome{status: 200, body: rpcResult(id, toolError("Missing required arguments: "+strings.Join(missing, ", ")))}
	}
	result, err := callTool(forge, name, args)
	if err != nil {
		msg := err.Error()
		if strings.HasPrefix(msg, "NOTFOUND:") {
			return mcpOutcome{status: 200, body: rpcResult(id, toolError(msg[len("NOTFOUND:"):]))}
		}
		return mcpOutcome{status: 200, body: rpcError(id, -32602, msg)}
	}
	return mcpOutcome{status: 200, body: rpcResult(id, result)}
}

// ------------------------------------------------------------- tool dispatch

func createRepoTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repoName, _ := args["name"].(string)
	if forge.GetRepo(viewerLogin, repoName) != nil {
		return nil, fmt.Errorf("Repository already exists")
	}
	repo := forge.CreateRepo(viewerLogin, repoName, optionalStringArg(args, "description", ""), getBool(args, "private"))
	return toolText(repoJSON(repo)), nil
}

func getRepoTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repo, err := requireRepo(forge, args)
	if err != nil {
		return nil, err
	}
	return toolText(repoJSON(repo)), nil
}

func createIssueTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repo, err := requireRepo(forge, args)
	if err != nil {
		return nil, err
	}
	title, _ := args["title"].(string)
	issue := forge.CreateIssue(repo, title, optionalStringArg(args, "body", ""), []string{})
	return toolText(issueJSON(repo, issue)), nil
}

func listIssuesTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repo, err := requireRepo(forge, args)
	if err != nil {
		return nil, err
	}
	state := optionalStringArg(args, "state", "open")
	var issues []*Issue
	for _, i := range repo.Issues {
		if state == "all" || i.State == state {
			issues = append(issues, i)
		}
	}
	sort.Slice(issues, func(x, y int) bool { return issues[x].CreatedSeq < issues[y].CreatedSeq })
	var list []interface{}
	for _, i := range issues {
		list = append(list, issueJSON(repo, i))
	}
	if list == nil {
		list = []interface{}{}
	}
	return toolText(list), nil
}

func createPullRequestTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repo, err := requireRepo(forge, args)
	if err != nil {
		return nil, err
	}
	head, _ := args["head"].(string)
	base, _ := args["base"].(string)
	headSha, ok1 := repo.Refs["refs/heads/"+head]
	baseSha, ok2 := repo.Refs["refs/heads/"+base]
	if !ok1 || !ok2 {
		missing := head
		if ok1 {
			missing = base
		}
		return nil, fmt.Errorf("NOTFOUND:Branch not found: %s", missing)
	}
	title, _ := args["title"].(string)
	pull := forge.CreatePull(repo, title, optionalStringArg(args, "body", ""), head, base, headSha, baseSha)
	return toolText(pullJSON(repo, pull)), nil
}

func mergePullRequestTool(forge *Forge, args map[string]interface{}) (map[string]interface{}, error) {
	repo, err := requireRepo(forge, args)
	if err != nil {
		return nil, err
	}
	var number float64
	if v, ok := args["pull_number"]; ok && v != nil {
		number, _ = v.(float64)
	} else if v, ok := args["number"]; ok && v != nil {
		number, _ = v.(float64)
	}
	pull, ok := repo.Pulls[int(number)]
	if !ok {
		return nil, fmt.Errorf("NOTFOUND:Pull request %d not found", int(number))
	}
	if forge.PullConflicts(repo, pull) {
		return nil, fmt.Errorf("Merge conflict")
	}
	sha := forge.MergePull(repo, pull)
	if sha == "" {
		return nil, fmt.Errorf("Merge failed")
	}
	merged := pullJSON(repo, pull)
	merged["sha"] = sha
	return toolText(merged), nil
}

func callTool(forge *Forge, name string, args map[string]interface{}) (map[string]interface{}, error) {
	switch name {
	case "create_repo":
		return createRepoTool(forge, args)
	case "get_repo":
		return getRepoTool(forge, args)
	case "create_issue":
		return createIssueTool(forge, args)
	case "list_issues":
		return listIssuesTool(forge, args)
	case "create_pull_request":
		return createPullRequestTool(forge, args)
	case "merge_pull_request":
		return mergePullRequestTool(forge, args)
	default:
		return nil, fmt.Errorf("Unknown tool: %s", name)
	}
}
