// graphql.go — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send. A faithful port of the v3 TypeScript graphql.ts,
// including its parser quirks (list variable types are a parse error there,
// string escapes do not decode \u, named fragment spreads select nothing).
package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- AST

type gqlValueKind int

const (
	vkVariable gqlValueKind = iota
	vkString
	vkInt
	vkFloat
	vkBoolean
	vkNull
	vkEnum
	vkList
	vkObject
)

type gqlValue struct {
	kind    gqlValueKind
	name    string // variable name / enum value
	str     string
	num     float64
	boolean bool
	list    []*gqlValue
	fields  []gqlObjField
}

type gqlObjField struct {
	name  string
	value *gqlValue
}

type gqlField struct {
	alias     string
	name      string
	args      []gqlArg
	selection []*gqlSelection
	hasAlias  bool
}

type gqlArg struct {
	name  string
	value *gqlValue
}

type gqlSelection struct {
	isInline  bool
	typeName  string // "" means no type condition (named spread: empty selection)
	hasType   bool
	field     *gqlField
	selection []*gqlSelection
}

type gqlVarDef struct {
	name     string
	typ      string
	required bool
}

type gqlOperation struct {
	typ       string // "query" | "mutation"
	name      string
	variables []gqlVarDef
	selection []*gqlSelection
}

func fieldKey(f *gqlField) string {
	if f.hasAlias {
		return f.alias
	}
	return f.name
}

// ---------------------------------------------------------------- Parser

type gqlParseError struct{ msg string }

func (e *gqlParseError) Error() string { return e.msg }

type gqlParser struct {
	pos int
	src string
}

func (p *gqlParser) skipWs() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '#' {
			for p.pos < len(p.src) && p.src[p.pos] != '\n' {
				p.pos++
			}
		} else if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			p.pos++
		} else {
			break
		}
	}
}

func (p *gqlParser) peek() byte {
	p.skipWs()
	if p.pos < len(p.src) {
		return p.src[p.pos]
	}
	return 0
}

func (p *gqlParser) take(expected byte) byte {
	p.skipWs()
	c := byte(0)
	if p.pos < len(p.src) {
		c = p.src[p.pos]
	}
	if expected != 0 && c != expected {
		panic(&gqlParseError{msg: fmt.Sprintf("expected %c at %d, saw %q", expected, p.pos, string(c))})
	}
	p.pos++
	return c
}

func (p *gqlParser) takeName() string {
	p.skipWs()
	start := p.pos
	if p.pos < len(p.src) {
		c := p.src[p.pos]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' {
			p.pos++
			for p.pos < len(p.src) {
				c = p.src[p.pos]
				if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' {
					p.pos++
				} else {
					break
				}
			}
			return p.src[start:p.pos]
		}
	}
	panic(&gqlParseError{msg: fmt.Sprintf("expected name at %d", start)})
}

func (p *gqlParser) readEscape() byte {
	e := p.src[p.pos]
	p.pos++
	switch e {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	default:
		return e
	}
}

func (p *gqlParser) takeString() string {
	p.skipWs()
	if p.pos >= len(p.src) || p.src[p.pos] != '"' {
		panic(&gqlParseError{msg: fmt.Sprintf("expected string at %d", p.pos)})
	}
	p.pos++
	var out []byte
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		p.pos++
		if c == '"' {
			return string(out)
		}
		if c == '\\' {
			out = append(out, p.readEscape())
		} else {
			out = append(out, c)
		}
	}
	panic(&gqlParseError{msg: "unterminated string"})
}

var numberRe = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?`)

func (p *gqlParser) readNumberLiteral() *gqlValue {
	m := numberRe.FindString(p.src[p.pos:])
	if m == "" {
		panic(&gqlParseError{msg: "bad number"})
	}
	p.pos += len(m)
	if strings.Contains(m, ".") {
		f, err := strconv.ParseFloat(m, 64)
		if err != nil {
			panic(&gqlParseError{msg: "bad number"})
		}
		return &gqlValue{kind: vkFloat, num: f}
	}
	n, err := strconv.ParseInt(m, 10, 64)
	if err != nil {
		panic(&gqlParseError{msg: "bad number"})
	}
	return &gqlValue{kind: vkInt, num: float64(n)}
}

func (p *gqlParser) parseDocument() []*gqlOperation {
	var ops []*gqlOperation
	for p.peek() != 0 {
		if p.peek() == '{' {
			ops = append(ops, &gqlOperation{typ: "query", selection: p.parseSelectionSet()})
			continue
		}
		word := p.takeName()
		if word == "query" || word == "mutation" {
			ops = append(ops, p.parseOperation(word))
		} else if word == "fragment" {
			p.parseFragmentDefinition()
		} else {
			panic(&gqlParseError{msg: "unexpected " + word})
		}
	}
	return ops
}

func (p *gqlParser) parseOperation(word string) *gqlOperation {
	var name string
	if c := p.peek(); (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' {
		name = p.takeName()
	}
	var variables []gqlVarDef
	if p.peek() == '(' {
		variables = p.parseVariableDefinitions()
	}
	return &gqlOperation{typ: word, name: name, variables: variables, selection: p.parseSelectionSet()}
}

func (p *gqlParser) parseVariableDefinitions() []gqlVarDef {
	var variables []gqlVarDef
	p.take('(')
	for p.peek() != ')' {
		p.take('$')
		vname := p.takeName()
		p.take(':')
		required := false
		var typ string
		if p.peek() == '[' {
			p.take('[')
			typ = "[" + p.takeName() + "]"
			if p.peek() == '!' {
				p.take('!')
			}
		} else {
			typ = p.takeName()
		}
		if p.peek() == '!' {
			p.take('!')
			required = true
		}
		if p.peek() == '=' {
			p.take('=')
			p.parseValue()
		}
		variables = append(variables, gqlVarDef{name: vname, typ: typ, required: required})
	}
	p.take(')')
	return variables
}

func (p *gqlParser) parseFragmentDefinition() {
	p.takeName()
	if c := p.peek(); c == 'o' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
		p.takeName()
		p.takeName()
	}
	p.parseSelectionSet()
}

func (p *gqlParser) parseSelectionSet() []*gqlSelection {
	p.take('{')
	var out []*gqlSelection
	for p.peek() != '}' {
		if p.peek() == 0 {
			panic(&gqlParseError{msg: "unterminated selection set"})
		}
		out = append(out, p.parseSelection())
	}
	p.take('}')
	return out
}

func (p *gqlParser) parseSelection() *gqlSelection {
	if strings.HasPrefix(p.src[p.pos:], "...") {
		return p.parseInlineFragment()
	}
	return &gqlSelection{field: p.parseFieldNode()}
}

func (p *gqlParser) parseInlineFragment() *gqlSelection {
	p.pos += 3
	p.skipWs()
	if strings.HasPrefix(p.src[p.pos:], "on") {
		next := byte(0)
		if p.pos+2 < len(p.src) {
			next = p.src[p.pos+2]
		}
		isNameChar := (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || (next >= '0' && next <= '9') || next == '_'
		if !isNameChar {
			p.pos += 2
			typeName := p.takeName()
			return &gqlSelection{isInline: true, typeName: typeName, hasType: true, selection: p.parseSelectionSet()}
		}
	}
	p.takeName()
	return &gqlSelection{isInline: true, selection: []*gqlSelection{}}
}

func (p *gqlParser) parseFieldNode() *gqlField {
	first := p.takeName()
	alias := ""
	name := first
	hasAlias := false
	if p.peek() == ':' {
		p.take(':')
		alias = first
		hasAlias = true
		name = p.takeName()
	}
	var args []gqlArg
	if p.peek() == '(' {
		args = p.parseArguments()
	}
	var selection []*gqlSelection
	if p.peek() == '{' {
		selection = p.parseSelectionSet()
	}
	return &gqlField{alias: alias, name: name, args: args, selection: selection, hasAlias: hasAlias}
}

func (p *gqlParser) parseArguments() []gqlArg {
	var args []gqlArg
	p.take('(')
	for p.peek() != ')' {
		aname := p.takeName()
		p.take(':')
		args = append(args, gqlArg{name: aname, value: p.parseValue()})
	}
	p.take(')')
	return args
}

func (p *gqlParser) parseValue() *gqlValue {
	c := p.peek()
	if c == '$' {
		p.take('$')
		return &gqlValue{kind: vkVariable, name: p.takeName()}
	}
	if c == '"' {
		return &gqlValue{kind: vkString, str: p.takeString()}
	}
	if c == '[' {
		return p.parseListValue()
	}
	if c == '{' {
		return p.parseObjectValue()
	}
	if c == '-' || (c >= '0' && c <= '9') {
		return p.readNumberLiteral()
	}
	name := p.takeName()
	switch name {
	case "true":
		return &gqlValue{kind: vkBoolean, boolean: true}
	case "false":
		return &gqlValue{kind: vkBoolean, boolean: false}
	case "null":
		return &gqlValue{kind: vkNull}
	default:
		return &gqlValue{kind: vkEnum, name: name}
	}
}

func (p *gqlParser) parseListValue() *gqlValue {
	p.take('[')
	var values []*gqlValue
	for p.peek() != ']' {
		values = append(values, p.parseValue())
	}
	p.take(']')
	return &gqlValue{kind: vkList, list: values}
}

func (p *gqlParser) parseObjectValue() *gqlValue {
	p.take('{')
	var fields []gqlObjField
	for p.peek() != '}' {
		name := p.takeName()
		p.take(':')
		fields = append(fields, gqlObjField{name: name, value: p.parseValue()})
	}
	p.take('}')
	return &gqlValue{kind: vkObject, fields: fields}
}

// ---------------------------------------------------------------- values

func valueOf(node *gqlValue, variables map[string]interface{}) interface{} {
	switch node.kind {
	case vkVariable:
		if v, ok := variables[node.name]; ok {
			return v
		}
		return nil
	case vkString:
		return node.str
	case vkInt, vkFloat:
		return node.num
	case vkBoolean:
		return node.boolean
	case vkNull:
		return nil
	case vkEnum:
		return node.name
	case vkList:
		var out []interface{}
		for _, v := range node.list {
			out = append(out, valueOf(v, variables))
		}
		if out == nil {
			out = []interface{}{}
		}
		return out
	case vkObject:
		o := map[string]interface{}{}
		for _, f := range node.fields {
			o[f.name] = valueOf(f.value, variables)
		}
		return o
	}
	return nil
}

// ---------------------------------------------------------------- schema

var gqlFields = map[string][]string{
	"Query":                            {"viewer", "repository", "node", "__type"},
	"User":                             {"login", "id", "name", "email", "url"},
	"Repository":                       {"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "url", "description", "createdAt", "updatedAt", "private", "isPrivate"},
	"Ref":                              {"name"},
	"Issue":                            {"id", "number", "title", "body", "state", "url", "createdAt", "updatedAt", "author", "comments"},
	"IssueConnection":                  {"nodes", "edges", "pageInfo", "totalCount"},
	"IssueEdge":                        {"node", "cursor"},
	"PullRequest":                      {"id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRefOid", "baseRefOid", "files", "url", "createdAt", "updatedAt", "mergedAt", "author"},
	"PullRequestConnection":            {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestEdge":                  {"node", "cursor"},
	"PullRequestChangedFileConnection": {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestChangedFile":           {"path", "filename", "additions", "deletions", "changes", "status"},
	"PageInfo":                         {"hasNextPage", "hasPreviousPage", "endCursor", "startCursor"},
	"__Type":                           {"name", "kind", "fields", "enumValues", "description"},
	"__Field":                          {"name", "description"},
	"__EnumValue":                      {"name", "description"},
	"Mutation":                         {"createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"},
	"CreateIssuePayload":               {"issue", "clientMutationId"},
	"CloseIssuePayload":                {"issue", "clientMutationId"},
	"CreatePullRequestPayload":         {"pullRequest", "clientMutationId"},
	"MergePullRequestPayload":          {"pullRequest", "clientMutationId"},
	"AddCommentPayload":                {"commentEdge", "clientMutationId"},
	"CommentEdge":                      {"node", "cursor"},
	"Comment":                          {"id", "body", "createdAt", "author"},
}

var gqlTypeOf = map[string]string{
	"viewer": "User", "repository": "Repository", "node": "Node", "owner": "User",
	"defaultBranchRef": "Ref", "issue": "Issue", "issues": "IssueConnection",
	"pullRequests": "PullRequestConnection", "pullRequest": "PullRequest",
	"author": "User", "nodes": "*", "edges": "*", "pageInfo": "PageInfo",
	"files": "PullRequestChangedFileConnection", "commentEdge": "CommentEdge",
	"comments": "IssueConnection",
}

func typeNameOfField(parentType, field string) string {
	if parentType == "Query" && field == "__type" {
		return "__Type"
	}
	if t, ok := gqlTypeOf[field]; ok {
		return t
	}
	return "Scalar"
}

func connectionElementType(parentType string) string {
	switch parentType {
	case "IssueConnection":
		return "Issue"
	case "PullRequestConnection":
		return "PullRequest"
	case "PullRequestChangedFileConnection":
		return "PullRequestChangedFile"
	default:
		return "Issue"
	}
}

// ---------------------------------------------------------------- selection helpers

type gqlCtx struct {
	forge *Forge
}

type gqlError struct{ message string }

func argMap(field *gqlField, variables map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, a := range field.args {
		out[a.name] = valueOf(a.value, variables)
	}
	return out
}

func validateSelection(selection []*gqlSelection, parentType string, errors *[]gqlError) {
	allowed := gqlFields[parentType]
	allowedSet := map[string]bool{}
	for _, f := range allowed {
		allowedSet[f] = true
	}
	for _, sel := range selection {
		if sel.isInline {
			if sel.hasType {
				validateSelection(sel.selection, sel.typeName, errors)
			}
			continue
		}
		f := sel.field
		if strings.HasPrefix(f.name, "__") {
			continue
		}
		if allowed != nil && !allowedSet[f.name] {
			*errors = append(*errors, gqlError{message: fmt.Sprintf("Cannot query field %q on type %q.", f.name, parentType)})
			continue
		}
		if f.selection != nil {
			childType := typeNameOfField(parentType, f.name)
			if childType == "*" {
				validateSelection(f.selection, connectionElementType(parentType), errors)
			} else if childType != "Scalar" && childType != "Node" {
				validateSelection(f.selection, childType, errors)
			}
		}
	}
}

func cursorFor(seq int) string {
	return gid("c", seq)
}

func seqFromCursor(cursor interface{}) (int, bool) {
	s, ok := cursor.(string)
	if !ok || s == "" {
		return 0, false
	}
	text, err := lenientB64URLDecode(s)
	if err != nil {
		return 0, false
	}
	m := regexp.MustCompile(`^c:(\d+)$`).FindStringSubmatch(string(text))
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
}

func pageInfoFor(hasNext, hasPrev bool, endCursor, startCursor interface{}) map[string]interface{} {
	return map[string]interface{}{"hasNextPage": hasNext, "hasPreviousPage": hasPrev, "endCursor": endCursor, "startCursor": startCursor}
}

func flatSelection(selection []*gqlSelection, typeName string) []*gqlField {
	var out []*gqlField
	for _, sel := range selection {
		if sel.isInline {
			if !sel.hasType || sel.typeName == typeName {
				out = append(out, flatSelection(sel.selection, typeName)...)
			}
		} else {
			out = append(out, sel.field)
		}
	}
	return out
}

func nodeSelectionOf(field *gqlField, name string) []*gqlSelection {
	if field.selection == nil {
		return nil
	}
	for _, sel := range field.selection {
		if !sel.isInline && sel.field.name == name {
			return sel.field.selection
		}
	}
	return nil
}

// ---------------------------------------------------------------- object builders

func gqlUserJson(selection []*gqlSelection) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range flatSelection(selection, "User") {
		key := fieldKey(f)
		switch f.name {
		case "login":
			out[key] = viewerLogin
		case "id":
			out[key] = gid("U", viewerID)
		case "name":
			out[key] = viewerName
		case "email":
			out[key] = viewerEmail
		default:
			out[key] = nil
		}
	}
	return out
}

func gqlIssueJson(ctx *gqlCtx, repo *Repo, issue *Issue, selection []*gqlSelection) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range flatSelection(selection, "Issue") {
		key := fieldKey(f)
		switch f.name {
		case "id":
			out[key] = issue.NodeID
		case "number":
			out[key] = issue.Number
		case "title":
			out[key] = issue.Title
		case "body":
			out[key] = issue.Body
		case "state":
			if issue.State == "open" {
				out[key] = "OPEN"
			} else {
				out[key] = "CLOSED"
			}
		case "url":
			out[key] = "https://forge.local/" + repo.Owner + "/" + repo.Name + "/issues/" + fmt.Sprint(issue.Number)
		case "createdAt":
			out[key] = issue.CreatedAt
		case "updatedAt":
			out[key] = issue.UpdatedAt
		case "author":
			out[key] = gqlUserJson(f.selection)
		default:
			out[key] = nil
		}
	}
	return out
}

func gqlFileNode(file diffFile, selection []*gqlSelection) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range flatSelection(selection, "PullRequestChangedFile") {
		key := fieldKey(f)
		switch f.name {
		case "path", "filename":
			out[key] = file.Filename
		case "status":
			out[key] = strings.ToUpper(file.Status)
		case "additions":
			out[key] = file.Additions
		case "deletions":
			out[key] = file.Deletions
		case "changes":
			out[key] = file.Changes
		default:
			out[key] = nil
		}
	}
	return out
}

func gqlPullJson(ctx *gqlCtx, repo *Repo, pull *Pull, selection []*gqlSelection) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range flatSelection(selection, "PullRequest") {
		key := fieldKey(f)
		switch f.name {
		case "id":
			out[key] = pull.NodeID
		case "number":
			out[key] = pull.Number
		case "title":
			out[key] = pull.Title
		case "body":
			out[key] = pull.Body
		case "state":
			if pull.Merged {
				out[key] = "MERGED"
			} else if pull.State == "open" {
				out[key] = "OPEN"
			} else {
				out[key] = "CLOSED"
			}
		case "merged":
			out[key] = pull.Merged
		case "mergeable":
			out[key] = gqlPullMergeableState(ctx, repo, pull)
		case "headRefName":
			out[key] = pull.HeadRef
		case "baseRefName":
			out[key] = pull.BaseRef
		case "headRefOid":
			out[key] = pull.HeadSha
		case "baseRefOid":
			out[key] = pull.BaseSha
		case "url":
			out[key] = "https://forge.local/" + repo.Owner + "/" + repo.Name + "/pull/" + fmt.Sprint(pull.Number)
		case "createdAt":
			out[key] = pull.CreatedAt
		case "updatedAt":
			out[key] = pull.UpdatedAt
		case "mergedAt":
			if pull.MergedAt == "" {
				out[key] = nil
			} else {
				out[key] = pull.MergedAt
			}
		case "author":
			out[key] = gqlUserJson(f.selection)
		case "files":
			out[key] = gqlPullFilesConnection(ctx, repo, pull, f)
		default:
			out[key] = nil
		}
	}
	return out
}

func gqlPullMergeableState(ctx *gqlCtx, repo *Repo, pull *Pull) string {
	if pull.State != "open" {
		return "UNKNOWN"
	}
	if ctx.forge.PullConflicts(repo, pull) {
		return "CONFLICTING"
	}
	return "MERGEABLE"
}

func gqlPullFilesConnection(ctx *gqlCtx, repo *Repo, pull *Pull, field *gqlField) map[string]interface{} {
	args := argMap(field, map[string]interface{}{})
	first := 100
	if n, ok := args["first"].(float64); ok {
		first = int(n)
	}
	files := ctx.forge.PullFiles(repo, pull)
	if len(files) > first {
		files = files[:first]
	}
	nodeSel := nodeSelectionOf(field, "nodes")
	var nodes []interface{}
	for _, file := range files {
		nodes = append(nodes, gqlFileNode(file, nodeSel))
	}
	if nodes == nil {
		nodes = []interface{}{}
	}
	return map[string]interface{}{
		"nodes":      nodes,
		"pageInfo":   pageInfoFor(false, false, nil, nil),
		"totalCount": len(files),
	}
}

func filterIssuesByState(issues []*Issue, states []string) []*Issue {
	if states == nil {
		return issues
	}
	want := map[string]bool{}
	for _, s := range states {
		if strings.ToUpper(s) == "OPEN" {
			want["open"] = true
		} else {
			want["closed"] = true
		}
	}
	var out []*Issue
	for _, issue := range issues {
		if want[issue.State] {
			out = append(out, issue)
		}
	}
	return out
}

func sortIssueList(issues []*Issue, desc bool) []*Issue {
	sorted := append([]*Issue{}, issues...)
	sort.Slice(sorted, func(i, j int) bool {
		if desc {
			if sorted[i].CreatedSeq != sorted[j].CreatedSeq {
				return sorted[i].CreatedSeq > sorted[j].CreatedSeq
			}
			return sorted[i].Number > sorted[j].Number
		}
		if sorted[i].CreatedSeq != sorted[j].CreatedSeq {
			return sorted[i].CreatedSeq < sorted[j].CreatedSeq
		}
		return sorted[i].Number < sorted[j].Number
	})
	return sorted
}

func gqlIssuesConnection(ctx *gqlCtx, repo *Repo, field *gqlField, variables map[string]interface{}) map[string]interface{} {
	args := argMap(field, variables)
	first := 10
	if n, ok := args["first"].(float64); ok {
		first = int(n)
	}
	afterSeq, hasAfter := seqFromCursor(args["after"])
	var states []string
	if arr, ok := args["states"].([]interface{}); ok {
		for _, s := range arr {
			if str, ok := s.(string); ok {
				states = append(states, str)
			}
		}
	}
	orderBy := asObj(args["orderBy"])
	desc := false
	if d, ok := orderBy["direction"].(string); ok && d == "DESC" {
		desc = true
	}
	var issues []*Issue
	for _, i := range repo.Issues {
		issues = append(issues, i)
	}
	issues = filterIssuesByState(issues, states)
	issues = sortIssueList(issues, desc)
	if hasAfter {
		var filtered []*Issue
		for _, i := range issues {
			if desc {
				if i.CreatedSeq < afterSeq {
					filtered = append(filtered, i)
				}
			} else if i.CreatedSeq > afterSeq {
				filtered = append(filtered, i)
			}
		}
		issues = filtered
	}
	total := len(issues)
	var page []*Issue
	if len(issues) > first {
		page = issues[:first]
	} else {
		page = issues
	}
	hasNext := len(issues) > first
	var endCursor, startCursor interface{}
	if len(page) > 0 {
		endCursor = cursorFor(page[len(page)-1].CreatedSeq)
		startCursor = cursorFor(page[0].CreatedSeq)
	}
	nodeSel := nodeSelectionOf(field, "nodes")
	var nodes []interface{}
	for _, i := range page {
		nodes = append(nodes, gqlIssueJson(ctx, repo, i, nodeSel))
	}
	if nodes == nil {
		nodes = []interface{}{}
	}
	return map[string]interface{}{
		"nodes":      nodes,
		"pageInfo":   pageInfoFor(hasNext, hasAfter, endCursor, startCursor),
		"totalCount": total,
	}
}

func gqlPullsConnection(ctx *gqlCtx, repo *Repo, field *gqlField, variables map[string]interface{}) map[string]interface{} {
	args := argMap(field, variables)
	first := 10
	if n, ok := args["first"].(float64); ok {
		first = int(n)
	}
	var pulls []*Pull
	for _, p := range repo.Pulls {
		if p.State == "open" {
			pulls = append(pulls, p)
		}
	}
	sort.Slice(pulls, func(i, j int) bool { return pulls[i].CreatedSeq > pulls[j].CreatedSeq })
	total := len(pulls)
	var page []*Pull
	if len(pulls) > first {
		page = pulls[:first]
	} else {
		page = pulls
	}
	nodeSel := nodeSelectionOf(field, "nodes")
	var nodes []interface{}
	for _, p := range page {
		nodes = append(nodes, gqlPullJson(ctx, repo, p, nodeSel))
	}
	if nodes == nil {
		nodes = []interface{}{}
	}
	return map[string]interface{}{
		"nodes":      nodes,
		"pageInfo":   pageInfoFor(total > first, false, nil, nil),
		"totalCount": total,
	}
}

func gqlRepoJson(ctx *gqlCtx, repo *Repo, selection []*gqlSelection, variables map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range flatSelection(selection, "Repository") {
		key := fieldKey(f)
		switch f.name {
		case "id":
			out[key] = gid("R", repo.ID)
		case "databaseId":
			out[key] = repo.ID
		case "name":
			out[key] = repo.Name
		case "nameWithOwner":
			out[key] = repo.Owner + "/" + repo.Name
		case "owner":
			out[key] = gqlUserJson(f.selection)
		case "defaultBranchRef":
			if tip, ok := ctx.forge.DefaultTip(repo); ok {
				_ = tip
				out[key] = map[string]interface{}{"name": repo.DefaultBranch}
			} else {
				out[key] = nil
			}
		case "viewerPermission":
			out[key] = "ADMIN"
		case "hasIssuesEnabled":
			out[key] = true
		case "url":
			out[key] = "https://forge.local/" + repo.Owner + "/" + repo.Name
		case "description":
			out[key] = repo.Description
		case "createdAt":
			out[key] = repo.CreatedAt
		case "updatedAt":
			out[key] = repo.UpdatedAt
		case "private", "isPrivate":
			out[key] = repo.IsPrivate
		case "issue":
			args := argMap(f, variables)
			var issue *Issue
			if n, ok := args["number"].(float64); ok {
				issue = repo.Issues[int(n)]
			}
			if issue != nil {
				out[key] = gqlIssueJson(ctx, repo, issue, f.selection)
			} else {
				out[key] = nil
			}
		case "issues":
			out[key] = gqlIssuesConnection(ctx, repo, f, variables)
		case "pullRequests":
			out[key] = gqlPullsConnection(ctx, repo, f, variables)
		case "pullRequest":
			args := argMap(f, variables)
			var pull *Pull
			if n, ok := args["number"].(float64); ok {
				pull = repo.Pulls[int(n)]
			}
			if pull != nil {
				out[key] = gqlPullJson(ctx, repo, pull, f.selection)
			} else {
				out[key] = nil
			}
		default:
			out[key] = nil
		}
	}
	return out
}

// ---------------------------------------------------------------- introspection

type introspectInfo struct {
	fields     []string
	enumValues []string
}

var gqlIntrospection = map[string]introspectInfo{
	"Issue":            {fields: []string{"id", "number", "title", "body", "state", "url", "createdAt", "updatedAt", "author", "comments", "labels"}},
	"PullRequest":      {fields: []string{"id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRefOid", "baseRefOid", "files", "url", "createdAt", "updatedAt", "mergedAt", "author"}},
	"Repository":       {fields: []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "url", "description", "createdAt", "updatedAt", "private", "isPrivate"}},
	"SearchType":       {fields: []string{}, enumValues: []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION"}},
	"User":             {fields: []string{"login", "id", "name", "email", "url"}},
	"IssueState":       {fields: []string{}, enumValues: []string{"OPEN", "CLOSED"}},
	"PullRequestState": {fields: []string{}, enumValues: []string{"OPEN", "CLOSED", "MERGED"}},
	"MergeableState":   {fields: []string{}, enumValues: []string{"MERGEABLE", "CONFLICTING", "UNKNOWN"}},
}

func gqlTypeJson(field *gqlField, name string) map[string]interface{} {
	info, ok := gqlIntrospection[name]
	out := map[string]interface{}{}
	for _, sel := range field.selection {
		if sel.isInline {
			continue
		}
		f := sel.field
		key := fieldKey(f)
		switch f.name {
		case "name":
			if ok {
				out[key] = name
			} else {
				out[key] = nil
			}
		case "kind":
			if len(info.enumValues) > 0 {
				out[key] = "ENUM"
			} else {
				out[key] = "OBJECT"
			}
		case "fields":
			if ok {
				var list []interface{}
				for _, n := range info.fields {
					list = append(list, map[string]interface{}{"name": n, "description": nil})
				}
				if list == nil {
					list = []interface{}{}
				}
				out[key] = list
			} else {
				out[key] = nil
			}
		case "enumValues":
			if len(info.enumValues) > 0 {
				var list []interface{}
				for _, n := range info.enumValues {
					list = append(list, map[string]interface{}{"name": n, "description": nil})
				}
				out[key] = list
			} else {
				out[key] = nil
			}
		case "description":
			out[key] = nil
		default:
			out[key] = nil
		}
	}
	if !ok {
		return map[string]interface{}{"name": nil, "kind": nil, "fields": nil, "enumValues": nil, "description": nil}
	}
	return out
}

// ---------------------------------------------------------------- queries

func gqlExecuteQuery(ctx *gqlCtx, op *gqlOperation, variables map[string]interface{}, errors *[]gqlError) map[string]interface{} {
	validateSelection(op.selection, "Query", errors)
	out := map[string]interface{}{}
	for _, sel := range op.selection {
		if sel.isInline {
			continue
		}
		f := sel.field
		key := fieldKey(f)
		switch f.name {
		case "viewer":
			out[key] = gqlUserJson(f.selection)
		case "__type":
			args := argMap(f, variables)
			name, _ := args["name"].(string)
			out[key] = gqlTypeJson(f, name)
		case "repository":
			args := argMap(f, variables)
			owner, _ := args["owner"].(string)
			name, _ := args["name"].(string)
			var repo *Repo
			if owner != "" && name != "" {
				repo = ctx.forge.GetRepo(owner, name)
			}
			if repo != nil {
				out[key] = gqlRepoJson(ctx, repo, f.selection, variables)
			} else {
				out[key] = nil
			}
		case "node":
			args := argMap(f, variables)
			out[key] = gqlNodeJson(ctx, args["id"], f.selection, variables)
		default:
			out[key] = nil
		}
	}
	return out
}

func gqlNodeJson(ctx *gqlCtx, id interface{}, selection []*gqlSelection, variables map[string]interface{}) interface{} {
	s, ok := id.(string)
	if !ok {
		return nil
	}
	kind, parts, ok := decodeGid(s)
	if !ok {
		return nil
	}
	repoID := int(jsNumber(parts[0]))
	repo := ctx.forge.GetRepoByID(repoID)
	if repo == nil {
		return nil
	}
	switch kind {
	case "R":
		return gqlRepoJson(ctx, repo, selection, variables)
	case "I":
		issue := repo.Issues[int(jsNumber(parts[1]))]
		if issue == nil {
			return nil
		}
		return gqlIssueJson(ctx, repo, issue, selection)
	case "P":
		pull := repo.Pulls[int(jsNumber(parts[1]))]
		if pull == nil {
			return nil
		}
		return gqlPullJson(ctx, repo, pull, selection)
	default:
		return nil
	}
}

// ---------------------------------------------------------------- mutations

func gqlRepoFromGid(ctx *gqlCtx, id interface{}, kind string) *Repo {
	s, ok := id.(string)
	if !ok {
		return nil
	}
	k, parts, ok := decodeGid(s)
	if !ok || k != kind {
		return nil
	}
	return ctx.forge.GetRepoByID(int(jsNumber(parts[0])))
}

func gqlIssueFromGid(ctx *gqlCtx, id interface{}) (*Repo, *Issue) {
	repo := gqlRepoFromGid(ctx, id, "I")
	if repo == nil {
		return nil, nil
	}
	s, _ := id.(string)
	_, parts, ok := decodeGid(s)
	if !ok {
		return nil, nil
	}
	issue := repo.Issues[int(jsNumber(parts[1]))]
	if issue == nil {
		return nil, nil
	}
	return repo, issue
}

func gqlPullFromGid(ctx *gqlCtx, id interface{}) (*Repo, *Pull) {
	repo := gqlRepoFromGid(ctx, id, "P")
	if repo == nil {
		return nil, nil
	}
	s, _ := id.(string)
	_, parts, ok := decodeGid(s)
	if !ok {
		return nil, nil
	}
	pull := repo.Pulls[int(jsNumber(parts[1]))]
	if pull == nil {
		return nil, nil
	}
	return repo, pull
}

func gqlMutateCreateIssue(ctx *gqlCtx, input map[string]interface{}, field *gqlField, errors *[]gqlError) map[string]interface{} {
	repo := gqlRepoFromGid(ctx, input["repositoryId"], "R")
	title, isStr := input["title"].(string)
	if repo == nil || !isStr {
		*errors = append(*errors, gqlError{message: "createIssue: repository not found"})
		return nil
	}
	body := ""
	if b, ok := input["body"].(string); ok {
		body = b
	}
	issue := ctx.forge.CreateIssue(repo, title, body, []string{})
	return map[string]interface{}{"issue": gqlIssueJson(ctx, repo, issue, nodeSelectionOf(field, "issue"))}
}

func gqlMutateCloseIssue(ctx *gqlCtx, input map[string]interface{}, field *gqlField, errors *[]gqlError) map[string]interface{} {
	repo, issue := gqlIssueFromGid(ctx, input["issueId"])
	if issue == nil {
		*errors = append(*errors, gqlError{message: "closeIssue: issue not found"})
		return nil
	}
	issue.State = "closed"
	_, issue.UpdatedAt = ctx.forge.stamp()
	ctx.forge.touchIssue(repo, issue.Number)
	return map[string]interface{}{"issue": gqlIssueJson(ctx, repo, issue, nodeSelectionOf(field, "issue"))}
}

func gqlMutateCreatePullRequest(ctx *gqlCtx, input map[string]interface{}, field *gqlField, errors *[]gqlError) map[string]interface{} {
	repo := gqlRepoFromGid(ctx, input["repositoryId"], "R")
	head, _ := input["headRefName"].(string)
	base, _ := input["baseRefName"].(string)
	var headSha, baseSha string
	var okH, okB bool
	if repo != nil {
		headSha, okH = repo.Refs["refs/heads/"+head]
		baseSha, okB = repo.Refs["refs/heads/"+base]
	}
	title, isStr := input["title"].(string)
	if repo == nil || !okH || !okB || !isStr {
		*errors = append(*errors, gqlError{message: "createPullRequest: repository or branch not found"})
		return nil
	}
	body := ""
	if b, ok := input["body"].(string); ok {
		body = b
	}
	pull := ctx.forge.CreatePull(repo, title, body, head, base, headSha, baseSha)
	return map[string]interface{}{"pullRequest": gqlPullJson(ctx, repo, pull, nodeSelectionOf(field, "pullRequest"))}
}

func gqlMutateMergePullRequest(ctx *gqlCtx, input map[string]interface{}, field *gqlField, errors *[]gqlError) map[string]interface{} {
	repo, pull := gqlPullFromGid(ctx, input["pullRequestId"])
	if pull == nil {
		*errors = append(*errors, gqlError{message: "mergePullRequest: pull request not found"})
		return nil
	}
	if ctx.forge.PullConflicts(repo, pull) {
		*errors = append(*errors, gqlError{message: "mergePullRequest: merge conflict"})
		return nil
	}
	ctx.forge.MergePull(repo, pull)
	return map[string]interface{}{"pullRequest": gqlPullJson(ctx, repo, pull, nodeSelectionOf(field, "pullRequest"))}
}

func gqlBuildCommentNode(nodeSel []*gqlSelection, comment *Comment) map[string]interface{} {
	var nodeOut map[string]interface{}
	if nodeSel != nil {
		for _, sel := range nodeSel {
			if !sel.isInline && sel.field.name == "node" {
				inner := map[string]interface{}{}
				for _, sub := range sel.field.selection {
					if sub.isInline {
						continue
					}
					key := fieldKey(sub.field)
					switch sub.field.name {
					case "id":
						inner[key] = comment.NodeID
					case "body":
						inner[key] = comment.Body
					default:
						inner[key] = nil
					}
				}
				nodeOut = inner
			}
		}
	}
	if nodeOut == nil {
		nodeOut = map[string]interface{}{"id": comment.NodeID, "body": comment.Body}
	}
	return nodeOut
}

func gqlMutateAddComment(ctx *gqlCtx, input map[string]interface{}, field *gqlField, errors *[]gqlError) map[string]interface{} {
	repo, issue := gqlIssueFromGid(ctx, input["subjectId"])
	body, isStr := input["body"].(string)
	if issue == nil || !isStr {
		*errors = append(*errors, gqlError{message: "addComment: subject not found"})
		return nil
	}
	comment := ctx.forge.AddComment(repo, issue, body)
	nodeSel := nodeSelectionOf(field, "commentEdge")
	return map[string]interface{}{"commentEdge": map[string]interface{}{"node": gqlBuildCommentNode(nodeSel, comment)}}
}

func gqlExecuteMutation(ctx *gqlCtx, op *gqlOperation, variables map[string]interface{}, errors *[]gqlError) map[string]interface{} {
	validateSelection(op.selection, "Mutation", errors)
	out := map[string]interface{}{}
	for _, sel := range op.selection {
		if sel.isInline {
			continue
		}
		f := sel.field
		key := fieldKey(f)
		args := argMap(f, variables)
		input := asObj(args["input"])
		if input == nil {
			input = map[string]interface{}{}
		}
		switch f.name {
		case "createIssue":
			out[key] = gqlMutateCreateIssue(ctx, input, f, errors)
		case "closeIssue":
			out[key] = gqlMutateCloseIssue(ctx, input, f, errors)
		case "createPullRequest":
			out[key] = gqlMutateCreatePullRequest(ctx, input, f, errors)
		case "mergePullRequest":
			out[key] = gqlMutateMergePullRequest(ctx, input, f, errors)
		case "addComment":
			out[key] = gqlMutateAddComment(ctx, input, f, errors)
		default:
			out[key] = nil
		}
	}
	return out
}

// ---------------------------------------------------------------- entry

func executeGraphQL(forge *Forge, body interface{}) map[string]interface{} {
	ctx := &gqlCtx{forge: forge}
	m, isObj := body.(map[string]interface{})
	if !isObj || body == nil {
		return map[string]interface{}{"data": nil, "errors": []interface{}{map[string]interface{}{"message": "GraphQL body must be an object with query and variables"}}}
	}
	query, _ := m["query"].(string)
	variables := asObj(m["variables"])
	if variables == nil {
		variables = map[string]interface{}{}
	}
	operationName := m["operationName"]
	if query == "" || strings.TrimSpace(query) == "" {
		return map[string]interface{}{"data": nil, "errors": []interface{}{map[string]interface{}{"message": "No query provided"}}}
	}
	var ops []*gqlOperation
	var parseErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				if e, ok := r.(*gqlParseError); ok {
					parseErr = e
				} else {
					parseErr = fmt.Errorf("GraphQL parse error")
				}
			}
		}()
		ops = (&gqlParser{src: query}).parseDocument()
	}()
	if parseErr != nil {
		return map[string]interface{}{"data": nil, "errors": []interface{}{map[string]interface{}{"message": parseErr.Error()}}}
	}
	if len(ops) == 0 {
		return map[string]interface{}{"data": nil, "errors": []interface{}{map[string]interface{}{"message": "No operation provided"}}}
	}
	op := gqlSelectOperation(ops, operationName)
	var errors []gqlError
	var data map[string]interface{}
	if op.typ == "mutation" {
		data = gqlExecuteMutation(ctx, op, variables, &errors)
	} else {
		data = gqlExecuteQuery(ctx, op, variables, &errors)
	}
	if len(errors) > 0 {
		var list []interface{}
		for _, e := range errors {
			list = append(list, map[string]interface{}{"message": e.message})
		}
		return map[string]interface{}{"data": data, "errors": list}
	}
	return map[string]interface{}{"data": data}
}

func gqlSelectOperation(ops []*gqlOperation, operationName interface{}) *gqlOperation {
	if name, ok := operationName.(string); ok && name != "" {
		for _, o := range ops {
			if o.name == name {
				return o
			}
		}
	}
	return ops[0]
}
