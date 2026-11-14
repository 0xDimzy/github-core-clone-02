// app.go — the forge request dispatcher over the raw net transport.
// A faithful port of the v3 TypeScript app.ts: same routes, same status
// codes, same bodies, same memoization. One global mutex serializes
// requests, exactly like Node's single-threaded event loop.
package main

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var shopToken = os.Getenv("MAKEFUN_SHOP_TOKEN")

const agentName = "forge/1.0"

var v2Advertisement []byte

func init() {
	var parts [][]byte
	parts = append(parts, pktLineStr("# service=git-upload-pack\n"), pktFlush,
		pktLineStr("version 2\n"),
		pktLineStr("agent="+agentName+"\n"),
		pktLineStr("ls-refs=unborn\n"),
		pktLineStr("fetch=shallow wait-for-done filter\n"),
		pktLineStr("object-format=sha1\n"),
		pktFlush)
	for _, p := range parts {
		v2Advertisement = append(v2Advertisement, p...)
	}
}

func uploadCaps(defaultBranch string) string {
	return fmt.Sprintf("symref=HEAD:refs/heads/%s multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=%s object-format=sha1", defaultBranch, agentName)
}

func receiveCaps(defaultBranch string) string {
	return fmt.Sprintf("report-status side-band-64k delete-refs ofs-delta agent=%s symref=HEAD:refs/heads/%s object-format=sha1", agentName, defaultBranch)
}

type forgeApp struct {
	forge      *Forge
	mu         sync.Mutex
	requestSeq int
}

func createApp() handlerFunc {
	app := &forgeApp{forge: NewForge()}
	return func(req *httpRequest) (res *httpResponse) {
		app.mu.Lock()
		defer app.mu.Unlock()
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(os.Stderr, "[forge] handler error: %v\n", r)
				res = app.jsonRes(500, map[string]interface{}{"message": "internal error"})
			}
		}()
		return app.handle(req)
	}
}

func (a *forgeApp) nextRequestID() string {
	a.requestSeq++
	return fmt.Sprintf("forge-%d", a.requestSeq)
}

func (a *forgeApp) jsonRes(status int, body interface{}) *httpResponse {
	return a.jsonResExtra(status, body, nil)
}

func (a *forgeApp) jsonResExtra(status int, body interface{}, extra [][2]string) *httpResponse {
	var b []byte
	switch v := body.(type) {
	case []byte:
		b = v
	case string:
		b = []byte(v)
	default:
		b = marshalJSON(v)
	}
	h := [][2]string{{"Content-Type", "application/json"}, {"X-GitHub-Request-Id", a.nextRequestID()}}
	h = append(h, extra...)
	return &httpResponse{status: status, headers: h, body: b}
}

func (a *forgeApp) jsonBytes(status int, body []byte, extra [][2]string) *httpResponse {
	h := [][2]string{{"Content-Type", "application/json"}, {"X-GitHub-Request-Id", a.nextRequestID()}}
	h = append(h, extra...)
	return &httpResponse{status: status, headers: h, body: body}
}

func (a *forgeApp) errRes(status int, message string) *httpResponse {
	return a.jsonRes(status, map[string]interface{}{"message": message})
}

func (a *forgeApp) gitRes(status int, contentType string, body []byte) *httpResponse {
	return &httpResponse{
		status:  status,
		headers: [][2]string{{"Content-Type", contentType}, {"X-GitHub-Request-Id", a.nextRequestID()}},
		body:    body,
	}
}

func fullJSONResponse(status int, body []byte) []byte {
	text := "OK"
	if status == 201 {
		text = "Created"
	}
	head := fmt.Sprintf("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nX-GitHub-Request-Id: forge-1\r\nConnection: keep-alive\r\nContent-Length: %d\r\n\r\n", status, text, len(body))
	out := make([]byte, 0, len(head)+len(body))
	out = append(out, head...)
	out = append(out, body...)
	return out
}

func (a *forgeApp) repoGetResponse(repo *Repo) []byte {
	if repo.RepoJSONCache != nil {
		return repo.RepoJSONCache
	}
	buf := fullJSONResponse(200, marshalJSON(repoJSON(repo)))
	repo.RepoJSONCache = buf
	return buf
}

func (a *forgeApp) issueGetResponse(repo *Repo, number int) []byte {
	if buf, ok := repo.IssueJSONCache[number]; ok {
		return buf
	}
	issue, ok := repo.Issues[number]
	if !ok {
		return nil
	}
	buf := fullJSONResponse(200, marshalJSON(issueJSON(repo, issue)))
	repo.IssueJSONCache[number] = buf
	return buf
}

// ---------------------------------------------------------------- request plumbing

func authorized(req *httpRequest) bool {
	header := req.headers["authorization"]
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	token := strings.TrimSpace(header[len("Bearer "):])
	if token == "" {
		return false
	}
	if shopToken != "" && token != shopToken {
		return false
	}
	return true
}

func baseURL(req *httpRequest) string { return "http://" + req.host }

func linkHeader(req *httpRequest, pageNum, perPage float64, totalPages int) string {
	base := baseURL(req) + req.path
	mk := func(p int) string {
		return fmt.Sprintf("<%s?page=%d&per_page=%s>", base, p, jsNumStr(perPage))
	}
	var parts []string
	if int(pageNum) < totalPages {
		parts = append(parts, mk(int(pageNum)+1)+`; rel="next"`)
	}
	if int(pageNum) > 1 {
		parts = append(parts, mk(int(pageNum)-1)+`; rel="prev"`)
	}
	parts = append(parts, mk(1)+`; rel="first"`)
	parts = append(parts, mk(totalPages)+`; rel="last"`)
	return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------- ref / commit views

func (a *forgeApp) resolveCommit(repo *Repo, ref *string) string {
	if ref == nil || *ref == "" {
		if tip, ok := a.forge.DefaultTip(repo); ok {
			return tip
		}
		return ""
	}
	r := *ref
	if isObjectId(r) {
		obj := repo.Objects[r]
		if obj == nil {
			return ""
		}
		if obj.Type == ObjCommit {
			return r
		}
		return peelToCommit(a.forge.lookup(repo), r)
	}
	full := r
	if !strings.HasPrefix(r, "refs/") {
		full = "refs/heads/" + r
	}
	tip, ok := repo.Refs[full]
	if !ok {
		return ""
	}
	return peelToCommit(a.forge.lookup(repo), tip)
}

func branchTip(repo *Repo, branch string) (string, bool) {
	v, ok := repo.Refs["refs/heads/"+branch]
	return v, ok
}

func (a *forgeApp) commitView(repo *Repo, oid string) map[string]interface{} {
	view := a.forge.CommitOf(repo, oid)
	message := ""
	if view != nil {
		message = commitMessageOf(repo, oid)
	}
	var parents []map[string]interface{}
	if view != nil {
		for _, p := range view.Parents {
			parents = append(parents, map[string]interface{}{"sha": p})
		}
	}
	if parents == nil {
		parents = []map[string]interface{}{}
	}
	return map[string]interface{}{
		"sha": oid,
		"commit": map[string]interface{}{
			"message":   message,
			"author":    map[string]interface{}{"name": viewerName, "email": viewerEmail},
			"committer": map[string]interface{}{"name": viewerName, "email": viewerEmail},
		},
		"parents": parents,
	}
}

// ---------------------------------------------------------------- git wire helpers

func sidebandChunks(data []byte) [][]byte {
	var out [][]byte
	for off := 0; off < len(data); off += 65515 {
		end := off + 65515
		if end > len(data) {
			end = len(data)
		}
		chunk := make([]byte, 0, end-off+1)
		chunk = append(chunk, 1)
		chunk = append(chunk, data[off:end]...)
		out = append(out, pktLine(chunk))
	}
	if len(data) == 0 {
		out = append(out, pktLine([]byte{1}))
	}
	return out
}

func (a *forgeApp) refLinesV0(repo *Repo, caps string) [][]byte {
	var lines [][]byte
	refs := a.forge.SortedRefs(repo)
	defaultTip, _ := a.forge.DefaultTip(repo)
	if len(refs) == 0 {
		lines = append(lines, pktLine([]byte(ZeroOID+" capabilities^{}\x00"+caps+"\n")))
		return lines
	}
	headOID := defaultTip
	if headOID == "" {
		for _, r := range refs {
			if strings.HasPrefix(r[0], "refs/heads/") {
				headOID = r[1]
				break
			}
		}
		if headOID == "" {
			headOID = ZeroOID
		}
	}
	lines = append(lines, pktLine([]byte(headOID+" HEAD\x00"+caps+"\n")))
	for _, r := range refs {
		name, oid := r[0], r[1]
		if strings.HasPrefix(name, "refs/tags/") {
			lines = append(lines, pktLine([]byte(oid+" "+name+"\n")))
			if obj := repo.Objects[oid]; obj != nil && obj.Type == ObjTag {
				if peeled := peelToCommit(a.forge.lookup(repo), oid); peeled != "" {
					lines = append(lines, pktLine([]byte(peeled+" "+name+"^{}\n")))
				}
			}
		} else {
			lines = append(lines, pktLine([]byte(oid+" "+name+"\n")))
		}
	}
	return lines
}

func (a *forgeApp) refAdvertisement(repo *Repo, service string) []byte {
	cached := repo.RefsCache
	if cached != nil && cached.gen == repo.Gen {
		if service == "upload" && cached.upload != nil {
			return cached.upload
		}
		if service == "receive" && cached.receive != nil {
			return cached.receive
		}
	}
	caps := uploadCaps(repo.DefaultBranch)
	svc := "# service=git-upload-pack\n"
	if service != "upload" {
		caps = receiveCaps(repo.DefaultBranch)
		svc = "# service=git-receive-pack\n"
	}
	var body []byte
	body = append(body, pktLineStr(svc)...)
	body = append(body, pktFlush...)
	for _, l := range a.refLinesV0(repo, caps) {
		body = append(body, l...)
	}
	body = append(body, pktFlush...)
	cur := cached
	if cur == nil || cur.gen != repo.Gen {
		cur = &refsCacheEntry{gen: repo.Gen}
	}
	if service == "upload" {
		cur.upload = body
	} else {
		cur.receive = body
	}
	repo.RefsCache = cur
	return body
}

// ---------------------------------------------------------------- fetch planning

type fetchPlan struct {
	wants     []string
	haves     []string
	shallowIn []string
	deepen    *int
}

func parseFetchPlan(lines []string, v2 bool) fetchPlan {
	plan := fetchPlan{}
	for _, line := range lines {
		text := strings.TrimSuffix(line, "\n")
		switch {
		case strings.HasPrefix(text, "want "):
			if v2 {
				plan.wants = append(plan.wants, strings.TrimSpace(text[5:]))
			} else {
				plan.wants = append(plan.wants, strings.SplitN(text[5:], " ", 2)[0])
			}
		case strings.HasPrefix(text, "have "):
			plan.haves = append(plan.haves, strings.TrimSpace(text[5:]))
		case strings.HasPrefix(text, "shallow "):
			plan.shallowIn = append(plan.shallowIn, strings.TrimSpace(text[8:]))
		case strings.HasPrefix(text, "deepen "):
			n, err := strconv.Atoi(strings.TrimSpace(text[7:]))
			if err == nil {
				plan.deepen = &n
			}
		}
	}
	return plan
}

// orderedSet preserves insertion order like a JS Set.
type orderedSet struct {
	keys []string
	set  map[string]bool
}

func newOrderedSet() *orderedSet { return &orderedSet{set: map[string]bool{}} }

func (s *orderedSet) add(k string) {
	if !s.set[k] {
		s.set[k] = true
		s.keys = append(s.keys, k)
	}
}

func (s *orderedSet) has(k string) bool { return s.set[k] }

func (s *orderedSet) delete(k string) {
	if s.set[k] {
		delete(s.set, k)
		for i, key := range s.keys {
			if key == k {
				s.keys = append(s.keys[:i], s.keys[i+1:]...)
				break
			}
		}
	}
}

func collectFetchSet(lookup Lookup, included *orderedSet, wants []string) *orderedSet {
	seen := newOrderedSet()
	var queue []string
	for _, oid := range included.keys {
		obj := lookup(oid)
		if obj == nil || obj.Type != ObjCommit || seen.has(oid) {
			continue
		}
		seen.add(oid)
		c, err := parseCommit(obj.Data)
		if err != nil {
			continue
		}
		queue = append(queue, c.Tree)
	}
	queue = append(queue, wants...)
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen.has(oid) {
			continue
		}
		obj := lookup(oid)
		if obj == nil {
			continue
		}
		seen.add(oid)
		switch obj.Type {
		case ObjCommit:
			c, err := parseCommit(obj.Data)
			if err != nil {
				continue
			}
			queue = append(queue, c.Tree)
			for _, p := range c.Parents {
				if included.has(p) {
					queue = append(queue, p)
				}
			}
		case ObjTag:
			t, err := parseTag(obj.Data)
			if err != nil {
				continue
			}
			queue = append(queue, t.Object)
		case ObjTree:
			entries, err := parseTree(obj.Data)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.Mode != "160000" {
					queue = append(queue, e.OID)
				}
			}
		}
	}
	return seen
}

func collectHaveSet(lookup Lookup, roots []string, boundaries map[string]bool) *orderedSet {
	seen := newOrderedSet()
	queue := append([]string{}, roots...)
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen.has(oid) {
			continue
		}
		obj := lookup(oid)
		if obj == nil {
			continue
		}
		seen.add(oid)
		switch obj.Type {
		case ObjCommit:
			c, err := parseCommit(obj.Data)
			if err != nil {
				continue
			}
			queue = append(queue, c.Tree)
			if !boundaries[oid] {
				queue = append(queue, c.Parents...)
			}
		case ObjTag:
			t, err := parseTag(obj.Data)
			if err != nil {
				continue
			}
			queue = append(queue, t.Object)
		case ObjTree:
			entries, err := parseTree(obj.Data)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.Mode != "160000" {
					queue = append(queue, e.OID)
				}
			}
		}
	}
	return seen
}

type fetchResult struct {
	acks      []string
	shallow   []string
	unshallow []string
	pack      []byte
}

func (a *forgeApp) computeFetchInner(repo *Repo, plan fetchPlan) fetchResult {
	lookup := a.forge.lookup(repo)
	var wantCommits []string
	for _, want := range plan.wants {
		if peeled := peelToCommit(lookup, want); peeled != "" {
			wantCommits = append(wantCommits, peeled)
		} else if _, ok := repo.Objects[want]; ok {
			wantCommits = append(wantCommits, want)
		}
	}
	// BFS distances from the want commits (insertion-ordered).
	distKeys := []string{}
	dist := map[string]int{}
	var queue []string
	for _, c := range wantCommits {
		if _, ok := dist[c]; !ok {
			dist[c] = 0
			distKeys = append(distKeys, c)
			queue = append(queue, c)
		}
	}
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		d := dist[oid]
		if plan.deepen != nil && d >= *plan.deepen-1 {
			continue
		}
		view := a.forge.CommitOf(repo, oid)
		if view == nil {
			continue
		}
		for _, p := range view.Parents {
			if _, ok := dist[p]; !ok {
				if _, exists := repo.Objects[p]; exists {
					dist[p] = d + 1
					distKeys = append(distKeys, p)
					queue = append(queue, p)
				}
			}
		}
	}
	included := newOrderedSet()
	var shallow []string
	var unshallow []string
	if plan.deepen != nil {
		depth := *plan.deepen
		for _, oid := range distKeys {
			if dist[oid] < depth {
				included.add(oid)
			}
		}
		for _, oid := range included.keys {
			d := dist[oid]
			view := a.forge.CommitOf(repo, oid)
			if view == nil {
				continue
			}
			if d == depth-1 && len(view.Parents) > 0 {
				shallow = append(shallow, oid)
			}
		}
		for _, old := range plan.shallowIn {
			if included.has(old) && dist[old] < depth-1 {
				unshallow = append(unshallow, old)
			}
		}
	} else {
		for _, oid := range distKeys {
			included.add(oid)
		}
		for _, old := range plan.shallowIn {
			if included.has(old) {
				unshallow = append(unshallow, old)
			}
		}
	}
	sendSet := collectFetchSet(lookup, included, plan.wants)
	var haveRoots []string
	for _, have := range plan.haves {
		if peeled := peelToCommit(lookup, have); peeled != "" {
			haveRoots = append(haveRoots, peeled)
		} else if _, ok := repo.Objects[have]; ok {
			haveRoots = append(haveRoots, have)
		}
	}
	if len(haveRoots) > 0 {
		boundaries := map[string]bool{}
		for _, s := range plan.shallowIn {
			boundaries[s] = true
		}
		haveSet := collectHaveSet(lookup, haveRoots, boundaries)
		for _, oid := range haveSet.keys {
			sendSet.delete(oid)
		}
	}
	var objects []*GitObject
	for _, oid := range sendSet.keys {
		if obj, ok := repo.Objects[oid]; ok {
			objects = append(objects, obj)
		}
	}
	var acks []string
	for _, have := range plan.haves {
		if peeled := peelToCommit(lookup, have); peeled != "" {
			if _, ok := dist[peeled]; ok {
				acks = append(acks, have)
			}
		}
	}
	return fetchResult{acks: acks, shallow: shallow, unshallow: unshallow, pack: writePack(objects)}
}

func fetchCacheKey(plan fetchPlan) string {
	deepen := ""
	if plan.deepen != nil {
		deepen = strconv.Itoa(*plan.deepen)
	}
	return strings.Join(plan.wants, ",") + "|" + strings.Join(plan.haves, ",") + "|" + strings.Join(plan.shallowIn, ",") + "|" + deepen
}

func (a *forgeApp) computeFetch(repo *Repo, plan fetchPlan) *fetchCacheEntry {
	key := fetchCacheKey(plan)
	if cached, ok := repo.FetchCache[key]; ok && cached.gen == repo.Gen {
		return cached
	}
	result := a.computeFetchInner(repo, plan)
	entry := &fetchCacheEntry{gen: repo.Gen, acks: result.acks, shallow: result.shallow, unshallow: result.unshallow, pack: result.pack}
	repo.FetchCache[key] = entry
	return entry
}

// ---------------------------------------------------------------- fetch responses

func (a *forgeApp) buildV0FetchResponse(repo *Repo, plan fetchPlan) []byte {
	cached := a.computeFetch(repo, plan)
	if cached.v0 != nil {
		return cached.v0
	}
	var out [][]byte
	if len(cached.acks) > 0 {
		for _, ack := range cached.acks {
			out = append(out, pktLineStr("ACK "+ack+"\n"))
		}
	} else {
		out = append(out, pktLineStr("NAK\n"))
	}
	for _, oid := range cached.shallow {
		out = append(out, pktLineStr("shallow "+oid+"\n"))
	}
	for _, oid := range cached.unshallow {
		out = append(out, pktLineStr("unshallow "+oid+"\n"))
	}
	out = append(out, sidebandChunks(cached.pack)...)
	out = append(out, pktFlush)
	var body []byte
	for _, p := range out {
		body = append(body, p...)
	}
	cached.v0 = body
	return body
}

func (a *forgeApp) buildV2FetchResponse(repo *Repo, plan fetchPlan) []byte {
	cached := a.computeFetch(repo, plan)
	if cached.v2 != nil {
		return cached.v2
	}
	var out [][]byte
	if len(plan.haves) > 0 {
		out = append(out, pktLineStr("acknowledgments\n"))
		if len(cached.acks) > 0 {
			for _, ack := range cached.acks {
				out = append(out, pktLineStr("ACK "+ack+"\n"))
			}
		} else {
			out = append(out, pktLineStr("NAK\n"))
		}
		out = append(out, pktLineStr("ready\n"), pktFlush)
	}
	if len(cached.shallow) > 0 || len(cached.unshallow) > 0 {
		out = append(out, pktLineStr("shallow-info\n"))
		for _, oid := range cached.shallow {
			out = append(out, pktLineStr("shallow "+oid+"\n"))
		}
		for _, oid := range cached.unshallow {
			out = append(out, pktLineStr("unshallow "+oid+"\n"))
		}
		out = append(out, pktFlush)
	}
	out = append(out, pktLineStr("packfile\n"))
	out = append(out, sidebandChunks(cached.pack)...)
	out = append(out, pktFlush)
	var body []byte
	for _, p := range out {
		body = append(body, p...)
	}
	cached.v2 = body
	return body
}

type lsRefsOptions struct {
	peel     bool
	symrefs  bool
	unborn   bool
	prefixes []string
}

func (a *forgeApp) buildLsRefsResponse(repo *Repo, opts lsRefsOptions) []byte {
	key := ""
	if opts.peel {
		key += "p"
	}
	if opts.symrefs {
		key += "s"
	}
	if opts.unborn {
		key += "u"
	}
	key += "|" + strings.Join(opts.prefixes, ",")
	if cached, ok := repo.LsRefsCache[key]; ok && cached.gen == repo.Gen {
		return cached.body
	}
	var out [][]byte
	defaultTip, hasTip := a.forge.DefaultTip(repo)
	keep := func(name string) bool {
		if len(opts.prefixes) == 0 {
			return true
		}
		for _, p := range opts.prefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
		return false
	}
	if opts.symrefs && keep("HEAD") {
		if hasTip {
			out = append(out, pktLineStr(defaultTip+" HEAD symref-target:refs/heads/"+repo.DefaultBranch+"\n"))
		} else if opts.unborn {
			out = append(out, pktLineStr("unborn HEAD symref-target:refs/heads/"+repo.DefaultBranch+"\n"))
		}
	}
	for _, r := range a.forge.SortedRefs(repo) {
		name, oid := r[0], r[1]
		if !keep(name) {
			continue
		}
		if strings.HasPrefix(name, "refs/tags/") {
			line := oid + " " + name
			if opts.peel {
				if obj := repo.Objects[oid]; obj != nil && obj.Type == ObjTag {
					if peeled := peelToCommit(a.forge.lookup(repo), oid); peeled != "" {
						line += " peeled:" + peeled
					}
				}
			}
			out = append(out, pktLineStr(line+"\n"))
		} else {
			out = append(out, pktLineStr(oid+" "+name+"\n"))
		}
	}
	out = append(out, pktFlush)
	var body []byte
	for _, p := range out {
		body = append(body, p...)
	}
	repo.LsRefsCache[key] = &lsRefsCacheEntry{gen: repo.Gen, body: body}
	return body
}

// ---------------------------------------------------------------- receive-pack

type receiveCommand struct {
	oldOID string
	newOID string
	ref    string
}

func parseReceiveCommands(decoded []pkt) []receiveCommand {
	var commands []receiveCommand
	for _, packet := range decoded {
		if packet.kind != pktData {
			continue
		}
		text := string(packet.payload)
		if i := strings.IndexByte(text, 0); i >= 0 {
			text = text[:i]
		}
		text = strings.TrimSuffix(text, "\n")
		parts := strings.Split(text, " ")
		if len(parts) != 3 {
			continue
		}
		if !isObjectId(parts[0]) || !isObjectId(parts[1]) || parts[2] == "" {
			continue
		}
		commands = append(commands, receiveCommand{oldOID: parts[0], newOID: parts[1], ref: parts[2]})
	}
	return commands
}

func (a *forgeApp) applyReceiveCommand(repo *Repo, cmd receiveCommand) string {
	current, exists := repo.Refs[cmd.ref]
	if cmd.oldOID == ZeroOID && cmd.newOID == ZeroOID {
		return "ng " + cmd.ref + " invalid command"
	}
	if cmd.oldOID == ZeroOID {
		if exists {
			return "ng " + cmd.ref + " already exists"
		}
		if _, ok := repo.Objects[cmd.newOID]; !ok {
			return "ng " + cmd.ref + " object not found"
		}
		if strings.HasPrefix(cmd.ref, "refs/heads/") {
			if peelToCommit(a.forge.lookup(repo), cmd.newOID) == "" {
				return "ng " + cmd.ref + " new tip is not a commit"
			}
		}
		repo.Refs[cmd.ref] = cmd.newOID
		a.forge.touch(repo)
		return "ok " + cmd.ref
	}
	if cmd.newOID == ZeroOID {
		if !exists {
			return "ng " + cmd.ref + " reference does not exist"
		}
		if current != cmd.oldOID {
			return "ng " + cmd.ref + " old value does not match"
		}
		delete(repo.Refs, cmd.ref)
		a.forge.touch(repo)
		return "ok " + cmd.ref
	}
	if !exists {
		return "ng " + cmd.ref + " reference does not exist"
	}
	if current != cmd.oldOID {
		return "ng " + cmd.ref + " old value does not match"
	}
	if _, ok := repo.Objects[cmd.newOID]; !ok {
		return "ng " + cmd.ref + " object not found"
	}
	newCommit := peelToCommit(a.forge.lookup(repo), cmd.newOID)
	if newCommit == "" {
		return "ng " + cmd.ref + " new tip is not a commit"
	}
	oldCommit := peelToCommit(a.forge.lookup(repo), cmd.oldOID)
	if oldCommit == "" || !a.forge.IsAncestor(repo, oldCommit, newCommit) {
		return "ng " + cmd.ref + " non-fast-forward"
	}
	repo.Refs[cmd.ref] = cmd.newOID
	a.forge.touch(repo)
	return "ok " + cmd.ref
}

// ---------------------------------------------------------------- top-level dispatch

func (a *forgeApp) handle(req *httpRequest) *httpResponse {
	method := req.method
	path := req.path
	segments := splitSegments(path)

	if method == "GET" && path == "/healthz" {
		return a.jsonRes(200, map[string]interface{}{"ok": true})
	}

	if len(segments) >= 2 && strings.HasSuffix(segments[1], ".git") {
		return a.handleGit(req, method, segments)
	}

	if path == "/api/graphql" {
		return a.handleGraphQL(req)
	}

	if path == "/mcp" {
		return a.handleMcpRoute(req)
	}

	if path == "/api/v3/" || path == "/api/v3" {
		return a.handleAPIRoot(req)
	}
	if path == "/api/v3/meta" {
		return a.handleAPIMeta(req)
	}

	if len(segments) >= 2 && segments[0] == "api" && segments[1] == "v3" {
		if !authorized(req) {
			return a.errRes(401, "Requires authentication")
		}
		return a.handleRest(req, method, segments)
	}

	return a.errRes(404, "Not Found")
}

func splitSegments(path string) []string {
	var out []string
	for _, s := range strings.Split(path, "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (a *forgeApp) handleGraphQL(req *httpRequest) *httpResponse {
	if req.method != "POST" {
		return a.errRes(405, "Method not allowed")
	}
	if !authorized(req) {
		return a.errRes(401, "Requires authentication")
	}
	parsed, ok := parseJSONBody(req.body)
	if !ok {
		return a.errRes(400, "Malformed JSON body")
	}
	if arr, isArr := parsed.([]interface{}); isArr {
		var out []interface{}
		for _, item := range arr {
			out = append(out, executeGraphQL(a.forge, item))
		}
		if out == nil {
			out = []interface{}{}
		}
		return a.jsonRes(200, out)
	}
	return a.jsonRes(200, executeGraphQL(a.forge, parsed))
}

func (a *forgeApp) handleMcpRoute(req *httpRequest) *httpResponse {
	if req.method == "DELETE" {
		return a.jsonRes(200, map[string]interface{}{})
	}
	if req.method != "POST" {
		return a.errRes(405, "Method not allowed")
	}
	if !authorized(req) {
		return a.errRes(401, "Requires authentication")
	}
	parsed, ok := parseJSONBody(req.body)
	if !ok {
		return a.jsonRes(400, map[string]interface{}{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]interface{}{"code": -32700, "message": "Parse error"},
		})
	}
	body, isObj := parsed.(map[string]interface{})
	if !isObj || body == nil {
		return a.jsonRes(400, map[string]interface{}{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]interface{}{"code": -32600, "message": "Invalid Request"},
		})
	}
	method, _ := body["method"].(string)
	if method == "" {
		return a.jsonRes(400, map[string]interface{}{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]interface{}{"code": -32600, "message": "Invalid Request"},
		})
	}
	out := handleMcp(a.forge, body)
	if out.body == nil {
		return &httpResponse{status: out.status, headers: [][2]string{{"X-GitHub-Request-Id", a.nextRequestID()}}, body: []byte{}}
	}
	return a.jsonRes(out.status, out.body)
}

func (a *forgeApp) handleAPIRoot(req *httpRequest) *httpResponse {
	if req.method != "GET" {
		return a.errRes(405, "Method not allowed")
	}
	return a.jsonResExtra(200, map[string]interface{}{"current_user_url": baseURL(req) + "/api/v3/user"},
		[][2]string{{"X-OAuth-Scopes", "repo, read:org"}})
}

func (a *forgeApp) handleAPIMeta(req *httpRequest) *httpResponse {
	if req.method != "GET" {
		return a.errRes(405, "Method not allowed")
	}
	return a.jsonRes(200, map[string]interface{}{"installed_version": "1.0.0"})
}

// sortKeys helper kept for deterministic iteration where needed.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ---------------------------------------------------------------- REST v3

func (a *forgeApp) handleRest(req *httpRequest, method string, segments []string) *httpResponse {
	query := req.query

	if len(segments) == 3 && segments[2] == "user" {
		return a.handleUserProfile(req, method)
	}

	if len(segments) == 4 && segments[2] == "user" && segments[3] == "repos" {
		return a.handleUserRepos(req, method, query)
	}

	if len(segments) >= 5 && segments[2] == "repos" {
		owner := segments[3]
		repoName := segments[4]
		repo := a.forge.GetRepo(owner, repoName)
		if repo == nil {
			return a.errRes(404, "Not Found")
		}
		rest := segments[5:]
		return a.handleRepoRest(req, repo, method, rest)
	}

	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleUserProfile(req *httpRequest, method string) *httpResponse {
	if method != "GET" {
		return a.errRes(405, "Method not allowed")
	}
	return a.jsonRes(200, map[string]interface{}{
		"login": viewerLogin, "id": viewerID, "name": viewerName, "email": viewerEmail, "type": "User",
		"url": baseURL(req) + "/api/v3/user", "html_url": "https://forge.local/" + viewerLogin,
	})
}

func (a *forgeApp) handleUserRepos(req *httpRequest, method string, query map[string]string) *httpResponse {
	if method == "POST" {
		parsed, ok := parseJSONBody(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		body := asObj(parsed)
		name, _ := getStr(body, "name")
		if name == "" {
			return a.errRes(422, "Repository name is required")
		}
		if a.forge.GetRepo(viewerLogin, name) != nil {
			return a.errRes(422, "Repository already exists")
		}
		repo := a.forge.CreateRepo(viewerLogin, name, getStrOr(body, "description", ""), getBool(body, "private"))
		return a.jsonRes(201, repoJSON(repo))
	}
	if method == "GET" {
		repos := a.forge.ListRepos(viewerLogin)
		start, end, totalPages, pageNum, perPage := paginateLen(len(repos), query)
		var list []interface{}
		for _, r := range repos[start:end] {
			list = append(list, repoJSON(r))
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonResExtra(200, list, [][2]string{{"Link", linkHeader(req, pageNum, perPage, totalPages)}})
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleRepoRest(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	var first string
	if len(rest) > 0 {
		first = rest[0]
	}
	switch first {
	case "":
		return a.handleRepoSelf(req, repo, method)
	case "branches":
		return a.handleRepoBranches(req, repo, method, rest)
	case "git":
		return a.handleRepoGitRefs(req, repo, method, rest)
	case "commits":
		return a.handleRepoCommits(req, repo, method, rest)
	case "contents":
		return a.handleRepoContents(req, repo, method, rest)
	case "labels":
		return a.handleRepoLabels(req, repo, method, rest)
	case "issues":
		return a.handleRepoIssues(req, repo, method, rest)
	case "pulls":
		return a.handleRepoPulls(req, repo, method, rest)
	default:
		return a.errRes(404, "Not Found")
	}
}

func (a *forgeApp) handleRepoSelf(req *httpRequest, repo *Repo, method string) *httpResponse {
	if method == "GET" {
		return &httpResponse{status: 200, headers: [][2]string{}, body: []byte{}, raw: a.repoGetResponse(repo)}
	}
	if method == "DELETE" {
		a.forge.DeleteRepo(repo.Owner, repo.Name)
		return &httpResponse{status: 204, headers: [][2]string{{"X-GitHub-Request-Id", a.nextRequestID()}}, body: []byte{}}
	}
	if method == "PATCH" {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		if desc, ok := getStr(body, "description"); ok {
			repo.Description = desc
		}
		_, repo.UpdatedAt = a.forge.stamp()
		a.forge.touch(repo)
		return a.jsonRes(200, repoJSON(repo))
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleRepoBranches(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if method == "GET" && len(rest) == 1 {
		var names []string
		for r := range repo.Refs {
			if strings.HasPrefix(r, "refs/heads/") {
				names = append(names, r[len("refs/heads/"):])
			}
		}
		sort.Strings(names)
		var branches []interface{}
		for _, name := range names {
			branches = append(branches, map[string]interface{}{"name": name, "commit": map[string]interface{}{"sha": repo.Refs["refs/heads/"+name]}})
		}
		if branches == nil {
			branches = []interface{}{}
		}
		return a.jsonRes(200, branches)
	}
	if method == "GET" && len(rest) >= 2 {
		branch := strings.Join(rest[1:], "/")
		tip, ok := branchTip(repo, branch)
		if !ok {
			return a.errRes(404, "Branch not found")
		}
		return a.jsonRes(200, map[string]interface{}{"name": branch, "commit": map[string]interface{}{"sha": tip}})
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleRepoGitRefs(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if len(rest) < 2 || rest[1] != "refs" {
		return a.errRes(404, "Not Found")
	}
	if method == "POST" && len(rest) == 2 {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		ref, _ := getStr(body, "ref")
		sha, _ := getStr(body, "sha")
		if !strings.HasPrefix(ref, "refs/") || !isObjectId(sha) {
			return a.errRes(422, "Invalid ref or sha")
		}
		if _, exists := repo.Objects[sha]; !exists {
			return a.errRes(422, "Invalid ref or sha")
		}
		if _, exists := repo.Refs[ref]; exists {
			return a.errRes(422, "Reference already exists")
		}
		repo.Refs[ref] = sha
		a.forge.touch(repo)
		return a.jsonRes(201, map[string]interface{}{"ref": ref, "object": map[string]interface{}{"sha": sha}})
	}
	if method == "GET" && len(rest) == 2 {
		var all []interface{}
		for _, r := range a.forge.SortedRefs(repo) {
			all = append(all, map[string]interface{}{"ref": r[0], "object": map[string]interface{}{"sha": r[1]}})
		}
		if all == nil {
			all = []interface{}{}
		}
		return a.jsonRes(200, all)
	}
	if method == "GET" && len(rest) >= 4 && rest[2] == "heads" {
		branch := strings.Join(rest[3:], "/")
		tip, ok := branchTip(repo, branch)
		if !ok {
			return a.errRes(404, "Reference not found")
		}
		return a.jsonRes(200, map[string]interface{}{"ref": "refs/heads/" + branch, "object": map[string]interface{}{"sha": tip}})
	}
	if method == "GET" && len(rest) >= 4 && rest[2] == "tags" {
		tag := strings.Join(rest[3:], "/")
		tip, ok := repo.Refs["refs/tags/"+tag]
		if !ok {
			return a.errRes(404, "Reference not found")
		}
		return a.jsonRes(200, map[string]interface{}{"ref": "refs/tags/" + tag, "object": map[string]interface{}{"sha": tip}})
	}
	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleRepoCommits(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if method == "GET" && len(rest) == 1 {
		var refPtr *string
		if s, ok := req.query["sha"]; ok {
			refPtr = &s
		}
		tip := a.resolveCommit(repo, refPtr)
		if tip == "" {
			return a.jsonRes(200, []interface{}{})
		}
		walked := a.forge.WalkCommits(repo, tip)
		start, end, _, _, _ := paginateLen(len(walked), req.query)
		var list []interface{}
		for _, oid := range walked[start:end] {
			list = append(list, a.commitView(repo, oid))
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleRepoContents(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	path := strings.Join(rest[1:], "/")
	switch method {
	case "GET":
		return a.handleContentsGet(req, repo, path)
	case "PUT":
		return a.handleContentsPut(req, repo, path)
	case "DELETE":
		return a.handleContentsDelete(req, repo, path)
	default:
		return a.errRes(405, "Method not allowed")
	}
}

func (a *forgeApp) handleContentsGet(req *httpRequest, repo *Repo, path string) *httpResponse {
	var refPtr *string
	if s, ok := req.query["ref"]; ok {
		refPtr = &s
	}
	tip := a.resolveCommit(repo, refPtr)
	if tip == "" {
		return a.errRes(404, "Not Found")
	}
	commit := a.forge.CommitOf(repo, tip)
	if commit == nil {
		return a.errRes(404, "Not Found")
	}
	treeOID := commit.Tree
	if path == "" {
		children := a.forge.ListDir(repo, treeOID, "")
		var list []interface{}
		for _, c := range children {
			list = append(list, map[string]interface{}{"type": c.Type, "name": c.Name, "path": c.Path, "sha": c.OID, "size": 0})
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	if oid, _, ok := a.forge.ReadPath(repo, treeOID, path); ok {
		blob := repo.Objects[oid]
		if blob == nil {
			return a.errRes(404, "Not Found")
		}
		name := path
		if i := strings.LastIndexByte(path, '/'); i >= 0 {
			name = path[i+1:]
		}
		return a.jsonRes(200, map[string]interface{}{
			"type": "file", "encoding": "base64", "name": name, "path": path,
			"sha": oid, "size": len(blob.Data), "content": b64Std(blob.Data),
		})
	}
	if children := a.forge.ListDir(repo, treeOID, path); children != nil {
		var list []interface{}
		for _, c := range children {
			list = append(list, map[string]interface{}{"type": c.Type, "name": c.Name, "path": c.Path, "sha": c.OID, "size": 0})
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleContentsPut(req *httpRequest, repo *Repo, path string) *httpResponse {
	body, ok := parseJSONObject(req.body)
	if !ok {
		return a.errRes(400, "Malformed JSON body")
	}
	message, _ := getStr(body, "message")
	contentB64, _ := getStr(body, "content")
	if message == "" || contentB64 == "" {
		return a.errRes(422, "message and content are required")
	}
	branch := getStrOr(body, "branch", repo.DefaultBranch)
	tip, tipOK := branchTip(repo, branch)
	if !tipOK {
		if defaultTip, ok := a.forge.DefaultTip(repo); ok {
			repo.Refs["refs/heads/"+branch] = defaultTip
			tip = defaultTip
			tipOK = true
		}
	}
	baseTree := EmptyTreeOID
	if tipOK {
		if c := a.forge.CommitOf(repo, tip); c != nil {
			baseTree = c.Tree
		}
	}
	var currentOID string
	var hasCurrent bool
	if tipOK {
		currentOID, _, hasCurrent = a.forge.ReadPath(repo, baseTree, path)
	}
	if expectedSha, ok := getStr(body, "sha"); ok {
		if !hasCurrent || currentOID != expectedSha {
			return a.errRes(409, "sha does not match the current file")
		}
	}
	content := lenientB64Decode(contentB64)
	blobOID := a.forge.PutObject(repo, ObjBlob, content)
	var parents []string
	if tipOK {
		parents = []string{tip}
	}
	newTree := a.forge.WritePath(repo, &baseTree, path, blobOID)
	commitSha := a.forge.MakeCommit(repo, newTree, parents, message)
	repo.Refs["refs/heads/"+branch] = commitSha
	a.forge.touch(repo)
	status := 201
	if hasCurrent {
		status = 200
	}
	name := path
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		name = path[i+1:]
	}
	return a.jsonRes(status, map[string]interface{}{
		"content": map[string]interface{}{"name": name, "path": path, "sha": blobOID, "size": len(content), "encoding": "base64", "type": "file"},
		"commit":  map[string]interface{}{"sha": commitSha, "message": message},
	})
}

func (a *forgeApp) handleContentsDelete(req *httpRequest, repo *Repo, path string) *httpResponse {
	body, ok := parseJSONObject(req.body)
	if !ok {
		return a.errRes(400, "Malformed JSON body")
	}
	message, _ := getStr(body, "message")
	sha, _ := getStr(body, "sha")
	branch := getStrOr(body, "branch", repo.DefaultBranch)
	tip, tipOK := branchTip(repo, branch)
	if !tipOK {
		return a.errRes(404, "Not Found")
	}
	commit := a.forge.CommitOf(repo, tip)
	if commit == nil {
		return a.errRes(404, "Not Found")
	}
	currentOID, _, hasCurrent := a.forge.ReadPath(repo, commit.Tree, path)
	if !hasCurrent {
		return a.errRes(404, "Not Found")
	}
	if sha != "" && currentOID != sha {
		return a.errRes(409, "sha does not match the current file")
	}
	newTree := a.forge.DeletePath(repo, commit.Tree, path)
	commitSha := a.forge.MakeCommit(repo, newTree, []string{tip}, message)
	repo.Refs["refs/heads/"+branch] = commitSha
	a.forge.touch(repo)
	return a.jsonRes(200, map[string]interface{}{"commit": map[string]interface{}{"sha": commitSha, "message": message}, "content": nil})
}

func (a *forgeApp) handleRepoLabels(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if method == "POST" && len(rest) == 1 {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		name, _ := getStr(body, "name")
		if name == "" {
			return a.errRes(422, "Label name is required")
		}
		color := getStrOr(body, "color", "ededed")
		if _, exists := repo.Labels[name]; !exists {
			repo.LabelsOrder = append(repo.LabelsOrder, name)
		}
		repo.Labels[name] = &Label{Name: name, Color: color, Description: getStrOr(body, "description", "")}
		a.forge.touch(repo)
		return a.jsonRes(201, map[string]interface{}{"name": name, "color": color, "description": ""})
	}
	if method == "GET" && len(rest) == 1 {
		var list []interface{}
		// Insertion order, like the TS Map.
		for _, n := range repo.LabelsOrder {
			l := repo.Labels[n]
			list = append(list, map[string]interface{}{"name": l.Name, "color": l.Color, "description": l.Description})
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(404, "Not Found")
}

func parseIssueLabels(value interface{}) []string {
	arr, ok := value.([]interface{})
	if !ok {
		return []string{}
	}
	var out []string
	for _, l := range arr {
		if s, ok := l.(string); ok {
			out = append(out, s)
		} else if m, ok := l.(map[string]interface{}); ok {
			if s, ok := m["name"].(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func (a *forgeApp) handleRepoIssues(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if len(rest) == 1 {
		return a.handleIssuesList(req, repo, method)
	}
	numF := jsNumber(rest[1])
	if !jsIsInteger(numF) {
		return a.errRes(404, "Not Found")
	}
	num := int(numF)
	issue, ok := repo.Issues[num]
	if !ok {
		return a.errRes(404, "Not Found")
	}
	if len(rest) == 2 {
		return a.handleIssueSingle(req, repo, issue, num, method)
	}
	if len(rest) == 3 && rest[2] == "comments" {
		return a.handleIssueComments(req, repo, issue, method)
	}
	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleIssuesList(req *httpRequest, repo *Repo, method string) *httpResponse {
	if method == "POST" {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		title, _ := getStr(body, "title")
		if title == "" {
			return a.errRes(422, "Issue title is required")
		}
		labels := parseIssueLabels(body["labels"])
		for _, label := range labels {
			if _, ok := repo.Labels[label]; !ok {
				return a.errRes(422, "Label \""+label+"\" does not exist")
			}
		}
		issue := a.forge.CreateIssue(repo, title, getStrOr(body, "body", ""), labels)
		return a.jsonRes(201, issueJSON(repo, issue))
	}
	if method == "GET" {
		state := req.query["state"]
		if _, ok := req.query["state"]; !ok {
			state = "open"
		}
		sortMode := req.query["sort"]
		if _, ok := req.query["sort"]; !ok {
			sortMode = "created"
		}
		direction := req.query["direction"]
		if _, ok := req.query["direction"]; !ok {
			direction = "desc"
		}
		var issues []*Issue
		for _, i := range repo.Issues {
			if state == "all" || i.State == state {
				issues = append(issues, i)
			}
		}
		// Base order is insertion order (createdSeq ascending), like the
		// TS Map; only sort === 'created' re-sorts.
		sort.Slice(issues, func(x, y int) bool { return issues[x].CreatedSeq < issues[y].CreatedSeq })
		if sortMode == "created" {
			sort.Slice(issues, func(x, y int) bool {
				if direction == "asc" {
					return issues[x].CreatedSeq < issues[y].CreatedSeq
				}
				return issues[x].CreatedSeq > issues[y].CreatedSeq
			})
		}
		start, end, _, _, _ := paginateLen(len(issues), req.query)
		var list []interface{}
		for _, i := range issues[start:end] {
			list = append(list, issueJSON(repo, i))
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleIssueSingle(req *httpRequest, repo *Repo, issue *Issue, num int, method string) *httpResponse {
	if method == "GET" {
		buf := a.issueGetResponse(repo, num)
		if buf == nil {
			return a.errRes(404, "Not Found")
		}
		return &httpResponse{status: 200, headers: [][2]string{}, body: []byte{}, raw: buf}
	}
	if method == "PATCH" {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		if state, ok := getStr(body, "state"); ok && (state == "open" || state == "closed") {
			issue.State = state
		}
		if title, ok := getStr(body, "title"); ok {
			issue.Title = title
		}
		if b, ok := getStr(body, "body"); ok {
			issue.Body = b
		}
		_, issue.UpdatedAt = a.forge.stamp()
		a.forge.touchIssue(repo, num)
		return a.jsonRes(200, issueJSON(repo, issue))
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleIssueComments(req *httpRequest, repo *Repo, issue *Issue, method string) *httpResponse {
	if method == "POST" {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		commentBody, _ := getStr(body, "body")
		if commentBody == "" {
			return a.errRes(422, "Comment body is required")
		}
		comment := a.forge.AddComment(repo, issue, commentBody)
		return a.jsonRes(201, map[string]interface{}{"id": comment.ID, "body": comment.Body, "user": map[string]interface{}{"login": viewerLogin, "id": viewerID}, "created_at": comment.CreatedAt})
	}
	if method == "GET" {
		var list []interface{}
		for _, c := range issue.Comments {
			list = append(list, map[string]interface{}{"id": c.ID, "body": c.Body, "user": map[string]interface{}{"login": viewerLogin, "id": viewerID}, "created_at": c.CreatedAt})
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handleRepoPulls(req *httpRequest, repo *Repo, method string, rest []string) *httpResponse {
	if len(rest) == 1 {
		return a.handlePullsList(req, repo, method)
	}
	numF := jsNumber(rest[1])
	if !jsIsInteger(numF) {
		return a.errRes(404, "Not Found")
	}
	num := int(numF)
	pull, ok := repo.Pulls[num]
	if !ok {
		return a.errRes(404, "Not Found")
	}
	if len(rest) == 2 {
		return a.handlePullSingle(req, repo, pull, method)
	}
	if len(rest) == 3 && rest[2] == "files" {
		return a.handlePullFiles(req, repo, pull, method)
	}
	if len(rest) == 3 && rest[2] == "merge" {
		return a.handlePullMerge(req, repo, pull, method)
	}
	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handlePullsList(req *httpRequest, repo *Repo, method string) *httpResponse {
	if method == "POST" {
		body, ok := parseJSONObject(req.body)
		if !ok {
			return a.errRes(400, "Malformed JSON body")
		}
		head, _ := getStr(body, "head")
		base, _ := getStr(body, "base")
		title, _ := getStr(body, "title")
		if head == "" || base == "" || title == "" {
			return a.errRes(422, "head, base and title are required")
		}
		headSha, ok1 := branchTip(repo, head)
		baseSha, ok2 := branchTip(repo, base)
		if !ok1 || !ok2 {
			return a.errRes(422, "head or base branch not found")
		}
		for _, p := range repo.Pulls {
			if p.State == "open" && p.HeadRef == head && p.BaseRef == base {
				return a.errRes(422, "A pull request already exists for this head branch")
			}
		}
		pull := a.forge.CreatePull(repo, title, getStrOr(body, "body", ""), head, base, headSha, baseSha)
		return a.jsonRes(201, pullJSON(repo, pull))
	}
	if method == "GET" {
		state := req.query["state"]
		if _, ok := req.query["state"]; !ok {
			state = "open"
		}
		var pulls []*Pull
		for _, p := range repo.Pulls {
			if state == "all" || p.State == state {
				pulls = append(pulls, p)
			}
		}
		sort.Slice(pulls, func(i, j int) bool { return pulls[i].CreatedSeq > pulls[j].CreatedSeq })
		start, end, _, _, _ := paginateLen(len(pulls), req.query)
		var list []interface{}
		for _, p := range pulls[start:end] {
			list = append(list, pullJSON(repo, p))
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handlePullSingle(req *httpRequest, repo *Repo, pull *Pull, method string) *httpResponse {
	if method == "GET" {
		return a.jsonRes(200, pullJSON(repo, pull))
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handlePullFiles(req *httpRequest, repo *Repo, pull *Pull, method string) *httpResponse {
	if method == "GET" {
		files := a.forge.PullFiles(repo, pull)
		var list []interface{}
		for _, f := range files {
			list = append(list, map[string]interface{}{"filename": f.Filename, "status": f.Status, "additions": f.Additions, "deletions": f.Deletions, "changes": f.Changes})
		}
		if list == nil {
			list = []interface{}{}
		}
		return a.jsonRes(200, list)
	}
	return a.errRes(405, "Method not allowed")
}

func (a *forgeApp) handlePullMerge(req *httpRequest, repo *Repo, pull *Pull, method string) *httpResponse {
	if method == "PUT" {
		if pull.State != "open" || pull.Merged {
			return a.errRes(405, "Pull request is not open")
		}
		if a.forge.PullConflicts(repo, pull) {
			return a.errRes(405, "Merge conflict")
		}
		sha := a.forge.MergePull(repo, pull)
		if sha == "" {
			return a.errRes(405, "Merge failed")
		}
		return a.jsonRes(200, map[string]interface{}{"merged": true, "sha": sha, "message": pull.Title})
	}
	return a.errRes(405, "Method not allowed")
}

// ---------------------------------------------------------------- git smart HTTP

func (a *forgeApp) handleGit(req *httpRequest, method string, segments []string) *httpResponse {
	owner := segments[0]
	repoName := segments[1][:len(segments[1])-len(".git")]
	sub := segments[2:]

	if !authorized(req) {
		return a.errRes(401, "Requires authentication")
	}
	repo := a.forge.GetRepo(owner, repoName)
	if repo == nil {
		return a.errRes(404, "Not Found")
	}

	if method == "GET" && len(sub) == 2 && sub[0] == "info" && sub[1] == "refs" {
		return a.handleInfoRefs(req, repo)
	}
	if method == "POST" && len(sub) == 1 && sub[0] == "git-upload-pack" {
		return a.handleUploadPack(req, repo)
	}
	if method == "POST" && len(sub) == 1 && sub[0] == "git-receive-pack" {
		return a.handleReceivePack(req, repo)
	}

	return a.errRes(404, "Not Found")
}

func (a *forgeApp) handleInfoRefs(req *httpRequest, repo *Repo) *httpResponse {
	service := req.query["service"]
	v2 := req.headers["git-protocol"] == "version=2"
	if service == "git-upload-pack" {
		if v2 {
			return a.gitRes(200, "application/x-git-upload-pack-advertisement", v2Advertisement)
		}
		return a.gitRes(200, "application/x-git-upload-pack-advertisement", a.refAdvertisement(repo, "upload"))
	}
	if service == "git-receive-pack" {
		return a.gitRes(200, "application/x-git-receive-pack-advertisement", a.refAdvertisement(repo, "receive"))
	}
	return a.errRes(400, "Unknown service")
}

func (a *forgeApp) handleUploadPack(req *httpRequest, repo *Repo) *httpResponse {
	var packets []pkt
	malformed := false
	func() {
		defer func() {
			if recover() != nil {
				malformed = true
			}
		}()
		packets, _ = decodePktLines(req.body)
	}()
	if malformed {
		return a.errRes(400, "Malformed pkt-line stream")
	}
	return a.handleUploadPackParsed(req, repo, packets)
}

func (a *forgeApp) handleUploadPackParsed(req *httpRequest, repo *Repo, packets []pkt) *httpResponse {
	var lines []string
	for _, p := range packets {
		if p.kind == pktData {
			lines = append(lines, string(p.payload))
		}
	}
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "command=") {
		plan := parseFetchPlan(lines, false)
		if len(plan.wants) == 0 {
			return a.errRes(400, "No wants in fetch request")
		}
		return a.gitRes(200, "application/x-git-upload-pack-result", a.buildV0FetchResponse(repo, plan))
	}
	command := strings.TrimSuffix(lines[0][len("command="):], "\n")
	var args []string
	for _, l := range lines[1:] {
		if l != "command=ls-refs\n" && l != "command=fetch\n" {
			args = append(args, l)
		}
	}
	if command == "ls-refs" {
		opts := lsRefsOptions{}
		for _, line := range args {
			text := strings.TrimSuffix(line, "\n")
			switch {
			case text == "peel":
				opts.peel = true
			case text == "symrefs":
				opts.symrefs = true
			case text == "unborn":
				opts.unborn = true
			case strings.HasPrefix(text, "ref-prefix "):
				opts.prefixes = append(opts.prefixes, text[len("ref-prefix "):])
			}
		}
		return a.gitRes(200, "application/x-git-upload-pack-result", a.buildLsRefsResponse(repo, opts))
	}
	if command == "fetch" {
		plan := parseFetchPlan(args, true)
		if len(plan.wants) == 0 {
			return a.errRes(400, "No wants in fetch request")
		}
		return a.gitRes(200, "application/x-git-upload-pack-result", a.buildV2FetchResponse(repo, plan))
	}
	return a.errRes(400, "Unknown upload-pack command: "+command)
}

func (a *forgeApp) handleReceivePack(req *httpRequest, repo *Repo) *httpResponse {
	raw := req.body
	var decoded []pkt
	var offset int
	malformed := false
	func() {
		defer func() {
			if recover() != nil {
				malformed = true
			}
		}()
		decoded, offset = decodePktLines(raw)
	}()
	if malformed {
		return a.errRes(400, "Malformed pkt-line stream")
	}
	commands := parseReceiveCommands(decoded)
	packBytes := raw[offset:]
	var reportLines []string
	unpackDetail := "ok"
	if len(packBytes) > 0 {
		objects, err := readPack(packBytes, a.forge.lookup(repo))
		if err != nil {
			unpackDetail = err.Error()
		} else {
			for oid, obj := range objects {
				if _, ok := repo.Objects[oid]; !ok {
					repo.Objects[oid] = obj
				}
			}
		}
	}
	if unpackDetail != "ok" {
		reportLines = append(reportLines, "unpack "+unpackDetail)
		for _, cmd := range commands {
			reportLines = append(reportLines, "ng "+cmd.ref+" unpack failed")
		}
	} else {
		reportLines = append(reportLines, "unpack ok")
		for _, cmd := range commands {
			reportLines = append(reportLines, a.applyReceiveCommand(repo, cmd))
		}
	}
	var inner []byte
	for _, l := range reportLines {
		inner = append(inner, pktLineStr(l+"\n")...)
	}
	inner = append(inner, pktFlush...)
	var body []byte
	for _, c := range sidebandChunks(inner) {
		body = append(body, c...)
	}
	body = append(body, pktFlush...)
	return a.gitRes(200, "application/x-git-receive-pack-result", body)
}
