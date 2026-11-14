// store.go — the forge's in-memory store: repositories, git objects, issues, PRs.
// A faithful port of the v3 TypeScript store: deterministic ids/timestamps
// from counters seeded at process start, same memoization caches.
package main

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"time"
)

var viewerLogin = "adaiversen"
var viewerID = 1000
var viewerName = "ada iversen"
var viewerEmail = "adaiversen@example.invalid"

const EmptyTreeOID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

type Label struct {
	Name        string
	Color       string
	Description string
}

type Comment struct {
	ID        int
	NodeID    string
	Body      string
	CreatedAt string
	User      string
}

type Issue struct {
	Number     int
	ID         int
	NodeID     string
	Title      string
	Body       string
	State      string // "open" | "closed"
	Labels     []string
	Comments   []*Comment
	CreatedSeq int
	CreatedAt  string
	UpdatedAt  string
	User       string
}

type Pull struct {
	Number          int
	ID              int
	NodeID          string
	Title           string
	Body            string
	State           string // "open" | "closed"
	Merged          bool
	MergedAt        string // "" means null
	MergeCommitSha  string // "" means null
	HeadRef         string
	BaseRef         string
	HeadSha         string
	BaseSha         string
	BaseShaAtCreate string
	CreatedSeq      int
	CreatedAt       string
	UpdatedAt       string
	User            string
}

type fetchCacheEntry struct {
	gen       int
	acks      []string
	shallow   []string
	unshallow []string
	pack      []byte
	v2        []byte
	v0        []byte
}

type refsCacheEntry struct {
	gen     int
	upload  []byte
	receive []byte
}

type lsRefsCacheEntry struct {
	gen  int
	body []byte
}

type Repo struct {
	ID             int
	Owner          string
	Name           string
	Description    string
	IsPrivate      bool
	DefaultBranch  string
	CreatedSeq     int
	CreatedAt      string
	UpdatedAt      string
	Refs           map[string]string
	Objects        map[string]*GitObject
	Labels         map[string]*Label
	LabelsOrder    []string
	Issues         map[int]*Issue
	Pulls          map[int]*Pull
	NextNumber     int
	Gen            int
	ParsedCommits  map[string]*CommitView
	ParsedTrees    map[string][]TreeEntry
	IssueJSONCache map[int][]byte
	RepoJSONCache  []byte
	FetchCache     map[string]*fetchCacheEntry
	RefsCache      *refsCacheEntry
	LsRefsCache    map[string]*lsRefsCacheEntry
}

// gid encodes a global node id: base64url of "Kind:part:part".
func gid(kind string, parts ...interface{}) string {
	var sb strings.Builder
	sb.WriteString(kind)
	for _, p := range parts {
		sb.WriteString(":")
		fmt.Fprintf(&sb, "%v", p)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(sb.String()))
}

// decodeGid decodes a global node id back to kind and parts, or nil.
// Lenient like Node's Buffer.from(id, 'base64url'): invalid chars ignored.
func decodeGid(id string) (kind string, parts []string, ok bool) {
	text, decErr := lenientB64URLDecode(id)
	if decErr != nil {
		return "", nil, false
	}
	split := strings.Split(string(text), ":")
	if len(split) == 0 || split[0] == "" || len(split) < 2 {
		return "", nil, false
	}
	return split[0], split[1:], true
}

func lenientB64URLDecode(s string) ([]byte, error) {
	var filtered []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' {
			filtered = append(filtered, c)
		}
	}
	// Pad to a multiple of 4.
	for len(filtered)%4 != 0 {
		filtered = append(filtered, '=')
	}
	return base64.URLEncoding.DecodeString(string(filtered))
}

// b64Std is standard base64 encoding (Node's Buffer.toString('base64')).
func b64Std(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// lenientB64Decode mimics Node's Buffer.from(s, 'base64'): non-alphabet
// characters are ignored, missing padding tolerated.
func lenientB64Decode(s string) []byte {
	var filtered []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=' {
			filtered = append(filtered, c)
		}
	}
	for len(filtered)%4 != 0 {
		filtered = append(filtered, '=')
	}
	out, err := base64.StdEncoding.DecodeString(string(filtered))
	if err != nil {
		// Try RawStdEncoding (no padding) as a fallback.
		out2, err2 := base64.RawStdEncoding.DecodeString(string(filtered))
		if err2 != nil {
			return []byte{}
		}
		return out2
	}
	return out
}

type Forge struct {
	Repos         map[string]*Repo
	nextRepoID    int
	nextCommentID int
	seq           int
	clock         int64
}

func NewForge() *Forge {
	return &Forge{
		Repos:         map[string]*Repo{},
		nextRepoID:    5000,
		nextCommentID: 1,
		clock:         1700000000,
	}
}

func (f *Forge) stamp() (epoch int64, iso string) {
	epoch = f.clock
	f.clock++
	return epoch, time.Unix(epoch, 0).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func (f *Forge) nextSeq() int {
	f.seq++
	return f.seq
}

func (f *Forge) key(owner, name string) string { return owner + "/" + name }

func (f *Forge) GetRepo(owner, name string) *Repo { return f.Repos[f.key(owner, name)] }

func (f *Forge) GetRepoByID(id int) *Repo {
	for _, r := range f.Repos {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (f *Forge) touch(repo *Repo) {
	repo.Gen++
	repo.RepoJSONCache = nil
	repo.RefsCache = nil
}

func (f *Forge) touchIssue(repo *Repo, number int) {
	delete(repo.IssueJSONCache, number)
}

func (f *Forge) CreateRepo(owner, name, description string, isPrivate bool) *Repo {
	_, iso := f.stamp()
	repo := &Repo{
		ID:             f.nextRepoID,
		Owner:          owner,
		Name:           name,
		Description:    description,
		IsPrivate:      isPrivate,
		DefaultBranch:  "main",
		CreatedSeq:     f.nextSeq(),
		CreatedAt:      iso,
		UpdatedAt:      iso,
		Refs:           map[string]string{},
		Objects:        map[string]*GitObject{},
		Labels:         map[string]*Label{},
		Issues:         map[int]*Issue{},
		Pulls:          map[int]*Pull{},
		NextNumber:     1,
		ParsedCommits:  map[string]*CommitView{},
		ParsedTrees:    map[string][]TreeEntry{},
		IssueJSONCache: map[int][]byte{},
		FetchCache:     map[string]*fetchCacheEntry{},
		LsRefsCache:    map[string]*lsRefsCacheEntry{},
	}
	f.nextRepoID++
	repo.Objects[EmptyTreeOID] = &GitObject{Type: ObjTree, Data: []byte{}}
	f.Repos[f.key(owner, name)] = repo
	return repo
}

func (f *Forge) DeleteRepo(owner, name string) bool {
	_, ok := f.Repos[f.key(owner, name)]
	delete(f.Repos, f.key(owner, name))
	return ok
}

func (f *Forge) ListRepos(owner string) []*Repo {
	var out []*Repo
	for _, r := range f.Repos {
		if r.Owner == owner {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedSeq < out[j].CreatedSeq })
	return out
}

func (f *Forge) lookup(repo *Repo) Lookup {
	return func(oid string) *GitObject { return repo.Objects[oid] }
}

func (f *Forge) CommitOf(repo *Repo, oid string) *CommitView {
	if cached, ok := repo.ParsedCommits[oid]; ok {
		return cached
	}
	obj := repo.Objects[oid]
	if obj == nil || obj.Type != ObjCommit {
		return nil
	}
	parsed, err := parseCommit(obj.Data)
	if err != nil {
		return nil
	}
	p := parsed
	repo.ParsedCommits[oid] = &p
	return &p
}

func (f *Forge) TreeOf(repo *Repo, oid string) []TreeEntry {
	if cached, ok := repo.ParsedTrees[oid]; ok {
		return cached
	}
	obj := repo.Objects[oid]
	if obj == nil || obj.Type != ObjTree {
		return nil
	}
	parsed, err := parseTree(obj.Data)
	if err != nil {
		return nil
	}
	repo.ParsedTrees[oid] = parsed
	return parsed
}

func (f *Forge) treeMap(repo *Repo, treeOID string) map[string]struct {
	Mode string
	OID  string
} {
	entries := map[string]struct {
		Mode string
		OID  string
	}{}
	if treeOID == "" {
		return entries
	}
	parsed := f.TreeOf(repo, treeOID)
	if parsed == nil {
		return entries
	}
	for _, e := range parsed {
		entries[e.Name] = struct {
			Mode string
			OID  string
		}{e.Mode, e.OID}
	}
	return entries
}

func (f *Forge) PutObject(repo *Repo, typ GitObjectType, data []byte) string {
	oid := hashObject(typ, data)
	if _, ok := repo.Objects[oid]; !ok {
		repo.Objects[oid] = &GitObject{Type: typ, Data: data}
	}
	return oid
}

func (f *Forge) RefTip(repo *Repo, ref string) (string, bool) {
	v, ok := repo.Refs[ref]
	return v, ok
}

func (f *Forge) SortedRefs(repo *Repo) [][2]string {
	var out [][2]string
	for k, v := range repo.Refs {
		out = append(out, [2]string{k, v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out
}

func (f *Forge) DefaultTip(repo *Repo) (string, bool) {
	v, ok := repo.Refs["refs/heads/"+repo.DefaultBranch]
	return v, ok
}

func (f *Forge) DescendToDir(repo *Repo, treeOID, dirPath string) (string, bool) {
	current := treeOID
	for _, part := range strings.Split(dirPath, "/") {
		if part == "" {
			continue
		}
		entries := f.TreeOf(repo, current)
		if entries == nil {
			return "", false
		}
		found := false
		for _, e := range entries {
			if e.Name == part && e.Mode == "40000" {
				current = e.OID
				found = true
				break
			}
		}
		if !found {
			return "", false
		}
	}
	return current, true
}

func (f *Forge) FlattenTree(repo *Repo, treeOID, prefix string, out map[string]struct {
	OID  string
	Mode string
}) map[string]struct {
	OID  string
	Mode string
} {
	if out == nil {
		out = map[string]struct {
			OID  string
			Mode string
		}{}
	}
	entries := f.TreeOf(repo, treeOID)
	if entries == nil {
		return out
	}
	for _, e := range entries {
		path := e.Name
		if prefix != "" {
			path = prefix + "/" + e.Name
		}
		if e.Mode == "40000" {
			f.FlattenTree(repo, e.OID, path, out)
		} else {
			out[path] = struct {
				OID  string
				Mode string
			}{e.OID, e.Mode}
		}
	}
	return out
}

func (f *Forge) ReadPath(repo *Repo, treeOID, path string) (oid, mode string, ok bool) {
	parts := []string{}
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return "", "", false
	}
	parentOID, found := f.DescendToDir(repo, treeOID, strings.Join(parts[:len(parts)-1], "/"))
	if !found {
		return "", "", false
	}
	entries := f.TreeOf(repo, parentOID)
	if entries == nil {
		return "", "", false
	}
	for _, e := range entries {
		if e.Name == parts[len(parts)-1] {
			if e.Mode == "40000" {
				return "", "", false
			}
			return e.OID, e.Mode, true
		}
	}
	return "", "", false
}

func (f *Forge) WritePath(repo *Repo, baseTreeOID *string, path, blobOID string) string {
	parts := []string{}
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	var rec func(treeOID *string, depth int) string
	rec = func(treeOID *string, depth int) string {
		var base string
		hasBase := false
		if treeOID != nil {
			base = *treeOID
			hasBase = true
		}
		_ = hasBase
		entries := f.treeMap(repo, base)
		name := parts[depth]
		if depth == len(parts)-1 {
			entries[name] = struct {
				Mode string
				OID  string
			}{"100644", blobOID}
		} else {
			child, ok := entries[name]
			var childTree string
			if ok && child.Mode == "40000" {
				childTree = rec(&child.OID, depth+1)
			} else {
				childTree = rec(nil, depth+1)
			}
			entries[name] = struct {
				Mode string
				OID  string
			}{"40000", childTree}
		}
		return f.PutObject(repo, ObjTree, buildTree(treeEntriesFromMap(entries)))
	}
	return rec(baseTreeOID, 0)
}

func treeEntriesFromMap(m map[string]struct {
	Mode string
	OID  string
}) []TreeEntry {
	var out []TreeEntry
	for n, v := range m {
		out = append(out, TreeEntry{Mode: v.Mode, Name: n, OID: v.OID})
	}
	return out
}

func (f *Forge) DeletePath(repo *Repo, baseTreeOID, path string) string {
	parts := []string{}
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	var rec func(treeOID string, depth int) (string, bool)
	rec = func(treeOID string, depth int) (string, bool) {
		entries := f.treeMap(repo, treeOID)
		name := parts[depth]
		if depth == len(parts)-1 {
			delete(entries, name)
		} else {
			child, ok := entries[name]
			if !ok || child.Mode != "40000" {
				return treeOID, true
			}
			next, exists := rec(child.OID, depth+1)
			if !exists {
				delete(entries, name)
			} else {
				entries[name] = struct {
					Mode string
					OID  string
				}{"40000", next}
			}
		}
		if len(entries) == 0 {
			return "", false
		}
		return f.PutObject(repo, ObjTree, buildTree(treeEntriesFromMap(entries))), true
	}
	out, ok := rec(baseTreeOID, 0)
	if !ok {
		return EmptyTreeOID
	}
	return out
}

type dirChild struct {
	Name string
	Path string
	Type string // "file" | "dir"
	OID  string
	Mode string
}

func (f *Forge) ListDir(repo *Repo, treeOID, dirPath string) []dirChild {
	var target string
	if dirPath == "" {
		target = treeOID
	} else {
		t, ok := f.DescendToDir(repo, treeOID, dirPath)
		if !ok {
			return nil
		}
		target = t
	}
	entries := f.TreeOf(repo, target)
	if entries == nil {
		return nil
	}
	var out []dirChild
	for _, e := range entries {
		path := e.Name
		if dirPath != "" {
			path = dirPath + "/" + e.Name
		}
		typ := "file"
		if e.Mode == "40000" {
			typ = "dir"
		}
		out = append(out, dirChild{Name: e.Name, Path: path, Type: typ, OID: e.OID, Mode: e.Mode})
	}
	return out
}

func (f *Forge) MakeCommit(repo *Repo, treeOID string, parents []string, message string) string {
	epoch, _ := f.stamp()
	who := viewerName + " <" + viewerEmail + ">"
	data := buildCommit(treeOID, parents, message, who, who, epoch, "")
	return f.PutObject(repo, ObjCommit, data)
}

func (f *Forge) WalkCommits(repo *Repo, tip string) []string {
	var out []string
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		if seen[oid] || !isObjectId(oid) {
			continue
		}
		seen[oid] = true
		view := f.CommitOf(repo, oid)
		if view == nil {
			continue
		}
		out = append(out, oid)
		queue = append(queue, view.Parents...)
	}
	return out
}

func (f *Forge) CreateIssue(repo *Repo, title, body string, labels []string) *Issue {
	number := repo.NextNumber
	repo.NextNumber++
	_, iso := f.stamp()
	issue := &Issue{
		Number:     number,
		ID:         100000 + number*7 + (repo.ID % 1000),
		NodeID:     gid("I", repo.ID, number),
		Title:      title,
		Body:       body,
		State:      "open",
		Labels:     append([]string{}, labels...),
		Comments:   []*Comment{},
		CreatedSeq: f.nextSeq(),
		CreatedAt:  iso,
		UpdatedAt:  iso,
		User:       viewerLogin,
	}
	repo.Issues[number] = issue
	f.touch(repo)
	return issue
}

func (f *Forge) CreatePull(repo *Repo, title, body, headRef, baseRef, headSha, baseSha string) *Pull {
	number := repo.NextNumber
	repo.NextNumber++
	_, iso := f.stamp()
	pull := &Pull{
		Number:          number,
		ID:              200000 + number*7 + (repo.ID % 1000),
		NodeID:          gid("P", repo.ID, number),
		Title:           title,
		Body:            body,
		State:           "open",
		Merged:          false,
		MergedAt:        "",
		MergeCommitSha:  "",
		HeadRef:         headRef,
		BaseRef:         baseRef,
		HeadSha:         headSha,
		BaseSha:         baseSha,
		BaseShaAtCreate: baseSha,
		CreatedSeq:      f.nextSeq(),
		CreatedAt:       iso,
		UpdatedAt:       iso,
		User:            viewerLogin,
	}
	repo.Pulls[number] = pull
	f.touch(repo)
	return pull
}

func (f *Forge) AddComment(repo *Repo, issue *Issue, body string) *Comment {
	_, iso := f.stamp()
	comment := &Comment{
		ID:        f.nextCommentID,
		NodeID:    gid("C", repo.ID, issue.Number, f.nextCommentID),
		Body:      body,
		CreatedAt: iso,
		User:      viewerLogin,
	}
	f.nextCommentID++
	issue.Comments = append(issue.Comments, comment)
	f.touchIssue(repo, issue.Number)
	return comment
}

type diffFile struct {
	Filename  string
	Status    string
	Additions int
	Deletions int
	Changes   int
}

func (f *Forge) DiffFiles(repo *Repo, baseTreeOID, headTreeOID string) []diffFile {
	base := f.FlattenTree(repo, baseTreeOID, "", nil)
	head := f.FlattenTree(repo, headTreeOID, "", nil)
	paths := map[string]bool{}
	for p := range base {
		paths[p] = true
	}
	for p := range head {
		paths[p] = true
	}
	var sorted []string
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	var out []diffFile
	for _, path := range sorted {
		b, hasB := base[path]
		h, hasH := head[path]
		if hasB && hasH && b.OID == h.OID {
			continue
		}
		if !hasB && hasH {
			additions := len(linesOfObject(repo, h.OID))
			out = append(out, diffFile{Filename: path, Status: "added", Additions: additions, Changes: additions})
		} else if hasB && !hasH {
			deletions := len(linesOfObject(repo, b.OID))
			out = append(out, diffFile{Filename: path, Status: "removed", Deletions: deletions, Changes: deletions})
		} else if hasB && hasH {
			add, del := countLineChanges(linesOfObject(repo, b.OID), linesOfObject(repo, h.OID))
			out = append(out, diffFile{Filename: path, Status: "modified", Additions: add, Deletions: del, Changes: add + del})
		}
	}
	return out
}

func (f *Forge) PullFiles(repo *Repo, pull *Pull) []diffFile {
	headTip, ok := repo.Refs["refs/heads/"+pull.HeadRef]
	if !ok {
		return []diffFile{}
	}
	headView := f.CommitOf(repo, headTip)
	baseView := f.CommitOf(repo, pull.BaseSha)
	if headView == nil || baseView == nil {
		return []diffFile{}
	}
	return f.DiffFiles(repo, baseView.Tree, headView.Tree)
}

func (f *Forge) PullConflicts(repo *Repo, pull *Pull) bool {
	baseTip, ok1 := repo.Refs["refs/heads/"+pull.BaseRef]
	headTip, ok2 := repo.Refs["refs/heads/"+pull.HeadRef]
	if !ok1 || !ok2 {
		return false
	}
	baseView := f.CommitOf(repo, baseTip)
	headView := f.CommitOf(repo, headTip)
	mergeBaseView := f.CommitOf(repo, pull.BaseShaAtCreate)
	if baseView == nil || headView == nil || mergeBaseView == nil {
		return false
	}
	baseTree := f.FlattenTree(repo, baseView.Tree, "", nil)
	headTree := f.FlattenTree(repo, headView.Tree, "", nil)
	mergeBaseTree := f.FlattenTree(repo, mergeBaseView.Tree, "", nil)
	headChanged := changedPaths(mergeBaseTree, headTree)
	baseChanged := changedPaths(mergeBaseTree, baseTree)
	for p := range headChanged {
		if baseChanged[p] {
			hOID := ""
			if h, ok := headTree[p]; ok {
				hOID = h.OID
			}
			bOID := ""
			if b, ok := baseTree[p]; ok {
				bOID = b.OID
			}
			if hOID != bOID {
				return true
			}
		}
	}
	return false
}

func (f *Forge) MergePull(repo *Repo, pull *Pull) string {
	if pull.State != "open" || pull.Merged {
		return ""
	}
	if f.PullConflicts(repo, pull) {
		return ""
	}
	baseTip, ok1 := repo.Refs["refs/heads/"+pull.BaseRef]
	headTip, ok2 := repo.Refs["refs/heads/"+pull.HeadRef]
	if !ok1 || !ok2 {
		return ""
	}
	headView := f.CommitOf(repo, headTip)
	if headView == nil {
		return ""
	}
	_, iso := f.stamp()
	sha := f.MakeCommit(repo, headView.Tree, []string{baseTip}, pull.Title)
	repo.Refs["refs/heads/"+pull.BaseRef] = sha
	pull.State = "closed"
	pull.Merged = true
	pull.MergedAt = iso
	pull.MergeCommitSha = sha
	pull.UpdatedAt = iso
	f.touch(repo)
	return sha
}

func (f *Forge) ReachableFrom(repo *Repo, tips []string) (map[string]bool, error) {
	return collectReachable(tips, f.lookup(repo))
}

func (f *Forge) Peel(repo *Repo, oid string) string {
	return peelToCommit(f.lookup(repo), oid)
}

func (f *Forge) IsAncestor(repo *Repo, ancestor, tip string) bool {
	return isAncestor(f.lookup(repo), ancestor, tip)
}

func linesOfObject(repo *Repo, oid string) []string {
	if oid == "" {
		return []string{}
	}
	obj := repo.Objects[oid]
	if obj == nil {
		return []string{}
	}
	lines := strings.Split(string(obj.Data), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func countLineChanges(oldLines, newLines []string) (additions, deletions int) {
	remaining := map[string]int{}
	for _, line := range oldLines {
		remaining[line]++
	}
	for _, line := range newLines {
		if remaining[line] > 0 {
			remaining[line]--
		} else {
			additions++
		}
	}
	for _, c := range remaining {
		deletions += c
	}
	return additions, deletions
}

func changedPaths(before, after map[string]struct {
	OID  string
	Mode string
}) map[string]bool {
	changed := map[string]bool{}
	for path, entry := range before {
		if a, ok := after[path]; !ok || a.OID != entry.OID {
			changed[path] = true
		}
	}
	for path := range after {
		if _, ok := before[path]; !ok {
			changed[path] = true
		}
	}
	return changed
}

func commitMessageOf(repo *Repo, oid string) string {
	if view, ok := repo.ParsedCommits[oid]; ok {
		return view.Message
	}
	obj := repo.Objects[oid]
	if obj == nil || obj.Type != ObjCommit {
		return ""
	}
	v, err := parseCommit(obj.Data)
	if err != nil {
		return ""
	}
	return v.Message
}
