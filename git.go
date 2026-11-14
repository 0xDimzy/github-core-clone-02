// git.go — git object model, pkt-line codec, packfile read/write.
// A faithful port of the v3 TypeScript gitcore: same algorithms, same
// validation, same error strings, so the suite sees identical behavior.
// Pure functions over []byte. No git binary anywhere.
package main

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/adler32"
	"io"
	"sort"
)

const ZeroOID = "0000000000000000000000000000000000000000"

type GitObjectType string

const (
	ObjCommit GitObjectType = "commit"
	ObjTree   GitObjectType = "tree"
	ObjBlob   GitObjectType = "blob"
	ObjTag    GitObjectType = "tag"
)

type GitObject struct {
	Type GitObjectType
	Data []byte
}

var typeCode = map[GitObjectType]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}
var codeType = map[int]GitObjectType{1: "commit", 2: "tree", 3: "blob", 4: "tag"}

func isObjectId(v string) bool {
	if len(v) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := v[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// hashObject: sha1 over "<type> <size>\0" + payload.
func hashObject(typ GitObjectType, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", typ, len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// ------------------------------------------------------------- pkt-line

func pktLine(payload []byte) []byte {
	head := []byte(fmt.Sprintf("%04x", len(payload)+4))
	out := make([]byte, 0, len(payload)+4)
	out = append(out, head...)
	out = append(out, payload...)
	return out
}

func pktLineStr(s string) []byte { return pktLine([]byte(s)) }

var pktFlush = []byte("0000")
var pktDelim = []byte("0001")

type pktKind int

const (
	pktData pktKind = iota
	pktFlushKind
	pktDelimKind
	pktResponseEnd
)

type pkt struct {
	kind    pktKind
	payload []byte
}

func isHex4(b []byte) bool {
	if len(b) != 4 {
		return false
	}
	for _, c := range b {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func readPktHead(buf []byte, off int) (pktKind, int, bool) {
	if off+4 > len(buf) || !isHex4(buf[off:off+4]) {
		return 0, 0, false
	}
	n := 0
	for i := 0; i < 4; i++ {
		c := buf[off+i]
		n <<= 4
		switch {
		case c >= '0' && c <= '9':
			n |= int(c - '0')
		case c >= 'a' && c <= 'f':
			n |= int(c-'a') + 10
		default:
			n |= int(c-'A') + 10
		}
	}
	switch n {
	case 0:
		return pktFlushKind, 0, true
	case 1:
		return pktDelimKind, 0, true
	case 2:
		return pktResponseEnd, 0, true
	}
	if n < 4 || n > 65520 || off+n > len(buf) {
		panic("malformed pkt-line")
	}
	return pktData, n, true
}

// decodePktLines decodes pkt-lines from the front of buf. Returns packets
// plus the offset of the first unparsed byte (raw pack data follows a flush
// in receive-pack). Panics on malformed input, like the TS throw.
func decodePktLines(buf []byte) (packets []pkt, offset int) {
	off := 0
	for off+4 <= len(buf) {
		kind, length, ok := readPktHead(buf, off)
		if !ok {
			break
		}
		if kind == pktData {
			packets = append(packets, pkt{kind: pktData, payload: buf[off+4 : off+length]})
			off += length
		} else {
			packets = append(packets, pkt{kind: kind})
			off += 4
		}
	}
	return packets, off
}

// ------------------------------------------------------------- tree / commit / tag

type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

func parseTree(data []byte) ([]TreeEntry, error) {
	var entries []TreeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], 0x20)
		if sp < 0 {
			return nil, errors.New("bad tree entry")
		}
		sp += off
		nul := bytes.IndexByte(data[sp+1:], 0x00)
		if nul < 0 {
			return nil, errors.New("bad tree entry")
		}
		nul += sp + 1
		if nul+21 > len(data) {
			return nil, errors.New("bad tree entry")
		}
		entries = append(entries, TreeEntry{
			Mode: string(data[off:sp]),
			Name: string(data[sp+1 : nul]),
			OID:  hex.EncodeToString(data[nul+1 : nul+21]),
		})
		off = nul + 21
	}
	return entries, nil
}

func treeSortKey(e TreeEntry) []byte {
	name := e.Name
	if e.Mode == "40000" {
		name += "/"
	}
	return []byte(name)
}

func buildTree(entries []TreeEntry) []byte {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool {
		return bytes.Compare(treeSortKey(sorted[i]), treeSortKey(sorted[j])) < 0
	})
	var out []byte
	for _, e := range sorted {
		out = append(out, []byte(e.Mode+" "+e.Name+"\x00")...)
		raw, _ := hex.DecodeString(e.OID)
		out = append(out, raw...)
	}
	return out
}

func splitHeaderBlock(data []byte) (headerLines []string, message string) {
	blank := bytes.Index(data, []byte("\n\n"))
	headEnd := len(data)
	if blank >= 0 {
		headEnd = blank
		message = string(data[blank+2:])
	}
	headerLines = bytesToLines(data[:headEnd])
	return headerLines, message
}

func bytesToLines(b []byte) []string {
	if len(b) == 0 {
		return []string{""}
	}
	s := string(b)
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

type CommitView struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

func parseCommit(data []byte) (CommitView, error) {
	headerLines, message := splitHeaderBlock(data)
	var v CommitView
	v.Message = message
	for _, line := range headerLines {
		if line == "" {
			continue
		}
		key, value := splitHeaderLine(line)
		switch key {
		case "tree":
			v.Tree = value
		case "parent":
			v.Parents = append(v.Parents, value)
		case "author":
			v.Author = value
		case "committer":
			v.Committer = value
		}
	}
	if !isObjectId(v.Tree) {
		return v, errors.New("commit has no valid tree")
	}
	return v, nil
}

func splitHeaderLine(line string) (string, string) {
	for i := 0; i < len(line); i++ {
		if line[i] == ' ' {
			return line[:i], line[i+1:]
		}
	}
	return line, ""
}

func buildCommit(tree string, parents []string, message, author, committer string, timestamp int64, timezone string) []byte {
	if timezone == "" {
		timezone = "+0000"
	}
	var lines []string
	lines = append(lines, "tree "+tree)
	for _, p := range parents {
		lines = append(lines, "parent "+p)
	}
	lines = append(lines,
		fmt.Sprintf("author %s %d %s", author, timestamp, timezone),
		fmt.Sprintf("committer %s %d %s", committer, timestamp, timezone),
		"",
	)
	s := ""
	for i, l := range lines {
		if i > 0 {
			s += "\n"
		}
		s += l
	}
	return []byte(s + "\n" + message)
}

type TagView struct {
	Object  string
	Type    GitObjectType
	Tag     string
	Tagger  string
	Message string
}

func parseTag(data []byte) (TagView, error) {
	headerLines, message := splitHeaderBlock(data)
	headers := map[string]string{}
	for _, line := range headerLines {
		if line == "" {
			continue
		}
		sp := -1
		for i := 0; i < len(line); i++ {
			if line[i] == ' ' {
				sp = i
				break
			}
		}
		if sp < 0 {
			return TagView{}, errors.New("bad tag header")
		}
		headers[line[:sp]] = line[sp+1:]
	}
	object := headers["object"]
	typ := headers["type"]
	if !isObjectId(object) {
		return TagView{}, errors.New("tag has no valid object")
	}
	if typ != "commit" && typ != "tree" && typ != "blob" && typ != "tag" {
		return TagView{}, errors.New("tag has bad type")
	}
	return TagView{Object: object, Type: GitObjectType(typ), Tag: headers["tag"], Tagger: headers["tagger"], Message: message}, nil
}

// peelToCommit peels an oid to the commit it ultimately points at (through tags).
func peelToCommit(lookup func(string) *GitObject, oid string) string {
	cur := oid
	seen := map[string]bool{}
	for i := 0; i < 16; i++ {
		if seen[cur] {
			return ""
		}
		seen[cur] = true
		obj := lookup(cur)
		if obj == nil {
			return ""
		}
		if obj.Type == ObjCommit {
			return cur
		}
		if obj.Type == ObjTag {
			t, err := parseTag(obj.Data)
			if err != nil {
				return ""
			}
			cur = t.Object
			continue
		}
		return ""
	}
	return ""
}

// ------------------------------------------------------------- reachability

type Lookup func(string) *GitObject

func objectChildren(obj *GitObject) []string {
	switch obj.Type {
	case ObjCommit:
		c, err := parseCommit(obj.Data)
		if err != nil {
			return nil
		}
		out := []string{c.Tree}
		return append(out, c.Parents...)
	case ObjTag:
		t, err := parseTag(obj.Data)
		if err != nil {
			return nil
		}
		return []string{t.Object}
	case ObjTree:
		entries, err := parseTree(obj.Data)
		if err != nil {
			return nil
		}
		var out []string
		for _, e := range entries {
			if e.Mode != "160000" {
				out = append(out, e.OID)
			}
		}
		return out
	}
	return nil
}

// collectReachable returns every object reachable from roots. Errors on a missing object.
func collectReachable(roots []string, lookup Lookup) (map[string]bool, error) {
	seen := map[string]bool{}
	var queue []string
	for _, r := range roots {
		if isObjectId(r) {
			queue = append(queue, r)
		}
	}
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[oid] {
			continue
		}
		obj := lookup(oid)
		if obj == nil {
			return nil, fmt.Errorf("missing object %s", oid)
		}
		seen[oid] = true
		queue = append(queue, objectChildren(obj)...)
	}
	return seen, nil
}

func isAncestor(lookup Lookup, ancestor, tip string) bool {
	if ancestor == tip {
		return true
	}
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if oid == ancestor {
			return true
		}
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := lookup(oid)
		if obj == nil || obj.Type != ObjCommit {
			continue
		}
		c, err := parseCommit(obj.Data)
		if err != nil {
			continue
		}
		queue = append(queue, c.Parents...)
	}
	return false
}

// ------------------------------------------------------------- delta application

func readDeltaVarint(delta []byte, off *int) int {
	value := 0
	shift := uint(0)
	for {
		b := delta[*off]
		*off++
		value += int(b&0x7f) << shift
		shift += 7
		if b&0x80 == 0 {
			break
		}
	}
	return value
}

func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	srcSize := readDeltaVarint(delta, &off)
	tgtSize := readDeltaVarint(delta, &off)
	if srcSize != len(base) {
		return nil, errors.New("delta base size mismatch")
	}
	out := make([]byte, tgtSize)
	written := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOff := 0
			copySize := 0
			shift := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<uint(bit)) != 0 {
					copyOff += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			shift = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<uint(bit)) != 0 {
					copySize += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			if copyOff+copySize > len(base) || written+copySize > tgtSize {
				return nil, errors.New("delta copy out of range")
			}
			copy(out[written:written+copySize], base[copyOff:copyOff+copySize])
			written += copySize
		} else if op != 0 {
			lit := int(op & 0x7f)
			if off+lit > len(delta) || written+lit > tgtSize {
				return nil, errors.New("delta insert out of range")
			}
			copy(out[written:written+lit], delta[off:off+lit])
			off += lit
			written += lit
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	if written != tgtSize {
		return nil, errors.New("delta size mismatch")
	}
	return out, nil
}

// ------------------------------------------------------------- packfile

// countingReader counts every byte consumed from the underlying reader.
// flate reads it through ReadByte (it is a ByteReader), so the count is exact.
type countingReader struct {
	r   *bytes.Reader
	n   int64
	err error
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingReader) ReadByte() (byte, error) {
	b, err := c.r.ReadByte()
	if err == nil {
		c.n++
	}
	return b, err
}

// inflateZlibEntry inflates one zlib stream starting at data[0], expecting
// expectedSize decompressed bytes. Returns the data and the total input bytes
// consumed (2-byte header + deflate stream + 4-byte adler32 trailer).
func inflateZlibEntry(data []byte, expectedSize int) ([]byte, int, error) {
	if len(data) < 2 {
		return nil, 0, errors.New("pack entry too short")
	}
	cr := &countingReader{r: bytes.NewReader(data)}
	// 2-byte zlib header: CMF/FLG, method 8, checksum multiple of 31.
	hdr := make([]byte, 2)
	if _, err := cr.Read(hdr); err != nil {
		return nil, 0, err
	}
	if hdr[0]&0x0f != 8 || (int(hdr[0])<<8|int(hdr[1]))%31 != 0 {
		return nil, 0, errors.New("bad zlib header")
	}
	fr := flate.NewReader(cr)
	defer fr.Close()
	out := make([]byte, expectedSize)
	if expectedSize > 0 {
		if _, err := io.ReadFull(fr, out); err != nil {
			return nil, 0, err
		}
	}
	// The next read must be EOF (stream fully consumed).
	one := make([]byte, 1)
	if n, _ := fr.Read(one); n != 0 {
		return nil, 0, errors.New("pack entry size mismatch")
	}
	// 4-byte adler32 trailer, verified.
	adlerBytes := make([]byte, 4)
	if _, err := cr.Read(adlerBytes); err != nil {
		return nil, 0, err
	}
	want := adler32.Checksum(out)
	got := uint32(adlerBytes[0])<<24 | uint32(adlerBytes[1])<<16 | uint32(adlerBytes[2])<<8 | uint32(adlerBytes[3])
	if got != want {
		return nil, 0, errors.New("pack entry checksum mismatch")
	}
	return out, int(cr.n), nil
}

func readVarintSize(buf []byte, start int) (size int, next int, first int) {
	b := buf[start]
	first = int(b)
	size = int(b & 0x0f)
	shift := uint(4)
	off := start + 1
	for b&0x80 != 0 {
		b = buf[off]
		off++
		size += int(b&0x7f) << shift
		shift += 7
	}
	return size, off, first
}

func readOfsBase(buf []byte, start int) (baseOffset int, next int) {
	b := buf[start]
	off := start + 1
	value := int(b & 0x7f)
	for b&0x80 != 0 {
		b = buf[off]
		off++
		value = ((value + 1) * 128) + int(b&0x7f)
	}
	return value, off
}

type packEntryRaw struct {
	offset     int
	typeCode   int
	size       int
	data       []byte
	baseOffset int
	baseOID    string
	hasBaseOff bool
	hasBaseOID bool
}

func readPackHeader(pack []byte) (count int, trailerStart int, err error) {
	if len(pack) < 32 {
		return 0, 0, errors.New("pack too short")
	}
	if string(pack[0:4]) != "PACK" {
		return 0, 0, errors.New("pack has no PACK header")
	}
	version := int(pack[4])<<24 | int(pack[5])<<16 | int(pack[6])<<8 | int(pack[7])
	if version != 2 && version != 3 {
		return 0, 0, fmt.Errorf("unsupported pack version %d", version)
	}
	count = int(pack[8])<<24 | int(pack[9])<<16 | int(pack[10])<<8 | int(pack[11])
	trailerStart = len(pack) - 20
	trailer := hex.EncodeToString(pack[trailerStart:])
	h := sha1.New()
	h.Write(pack[:trailerStart])
	if hex.EncodeToString(h.Sum(nil)) != trailer {
		return 0, 0, errors.New("pack trailer checksum mismatch")
	}
	return count, trailerStart, nil
}

func readPackEntry(pack []byte, off int, trailerStart int) (packEntryRaw, int, error) {
	entryOffset := off
	size, next, first := readVarintSize(pack, off)
	off = next
	tc := (first >> 4) & 0x07
	entry := packEntryRaw{offset: entryOffset, typeCode: tc, size: size}
	if tc == 6 {
		b, n := readOfsBase(pack, off)
		off = n
		entry.baseOffset = entryOffset - b
		entry.hasBaseOff = true
	} else if tc == 7 {
		entry.baseOID = hex.EncodeToString(pack[off : off+20])
		entry.hasBaseOID = true
		off += 20
	} else if _, ok := codeType[tc]; !ok {
		return entry, 0, fmt.Errorf("pack entry has unknown type %d", tc)
	}
	inflated, consumed, err := inflateZlibEntry(pack[off:trailerStart], size)
	if err != nil {
		return entry, 0, err
	}
	entry.data = inflated
	off += consumed
	return entry, off, nil
}

type resolvedEntry struct {
	typ  GitObjectType
	data []byte
	oid  string
}

type packResolver struct {
	byOffset    map[int]*packEntryRaw
	byOID       map[string]*packEntryRaw
	resolved    map[int]*resolvedEntry
	resolving   map[int]bool
	entries     []*packEntryRaw
	resolveBase Lookup
}

func (pr *packResolver) resolveAll() (map[string]*GitObject, error) {
	objects := map[string]*GitObject{}
	for _, e := range pr.entries {
		r, err := pr.resolve(e)
		if err != nil {
			return nil, err
		}
		if _, ok := objects[r.oid]; !ok {
			objects[r.oid] = &GitObject{Type: r.typ, Data: r.data}
		}
	}
	return objects, nil
}

func (pr *packResolver) resolve(entry *packEntryRaw) (*resolvedEntry, error) {
	if cached, ok := pr.resolved[entry.offset]; ok {
		return cached, nil
	}
	if pr.resolving[entry.offset] {
		return nil, errors.New("delta cycle")
	}
	pr.resolving[entry.offset] = true
	var typ GitObjectType
	var data []byte
	var err error
	switch entry.typeCode {
	case 6:
		var base *resolvedEntry
		base, err = pr.resolveOfsBase(entry)
		if err == nil {
			typ = base.typ
			data, err = applyDelta(base.data, entry.data)
		}
	case 7:
		var base *resolvedEntry
		base, err = pr.resolveRefBase(entry)
		if err == nil {
			typ = base.typ
			data, err = applyDelta(base.data, entry.data)
		}
	default:
		typ = codeType[entry.typeCode]
		data = entry.data
	}
	if err != nil {
		delete(pr.resolving, entry.offset)
		return nil, err
	}
	oid := hashObject(typ, data)
	out := &resolvedEntry{typ: typ, data: data, oid: oid}
	pr.resolved[entry.offset] = out
	pr.byOID[oid] = entry
	delete(pr.resolving, entry.offset)
	return out, nil
}

func (pr *packResolver) resolveOfsBase(entry *packEntryRaw) (*resolvedEntry, error) {
	baseEntry, ok := pr.byOffset[entry.baseOffset]
	if !ok {
		return nil, errors.New("ofs-delta base not in pack")
	}
	return pr.resolve(baseEntry)
}

func (pr *packResolver) resolveRefBase(entry *packEntryRaw) (*resolvedEntry, error) {
	if baseEntry, ok := pr.byOID[entry.baseOID]; ok {
		return pr.resolve(baseEntry)
	}
	if pr.resolveBase != nil {
		if ext := pr.resolveBase(entry.baseOID); ext != nil {
			return &resolvedEntry{typ: ext.Type, data: ext.Data, oid: entry.baseOID}, nil
		}
	}
	return nil, fmt.Errorf("ref-delta base %s not available", entry.baseOID)
}

// readPack reads a packfile (v2/v3), resolving OFS/REF deltas.
func readPack(pack []byte, resolveBase Lookup) (map[string]*GitObject, error) {
	count, trailerStart, err := readPackHeader(pack)
	if err != nil {
		return nil, err
	}
	var raw []*packEntryRaw
	off := 12
	for i := 0; i < count; i++ {
		entry, next, err := readPackEntry(pack, off, trailerStart)
		if err != nil {
			return nil, err
		}
		e := entry
		raw = append(raw, &e)
		off = next
	}
	if off != trailerStart {
		return nil, errors.New("pack has trailing bytes")
	}
	hasDelta := false
	for _, e := range raw {
		if e.typeCode == 6 || e.typeCode == 7 {
			hasDelta = true
			break
		}
	}
	if !hasDelta {
		objects := map[string]*GitObject{}
		for _, e := range raw {
			typ := codeType[e.typeCode]
			oid := hashObject(typ, e.data)
			if _, ok := objects[oid]; !ok {
				objects[oid] = &GitObject{Type: typ, Data: e.data}
			}
		}
		return objects, nil
	}
	pr := &packResolver{
		byOffset:    map[int]*packEntryRaw{},
		byOID:       map[string]*packEntryRaw{},
		resolved:    map[int]*resolvedEntry{},
		resolving:   map[int]bool{},
		entries:     raw,
		resolveBase: resolveBase,
	}
	for _, e := range raw {
		pr.byOffset[e.offset] = e
	}
	return pr.resolveAll()
}

func packObjectHeader(typ GitObjectType, size int) []byte {
	code := typeCode[typ]
	var bytesOut []byte
	remaining := size
	first := (code << 4) | (remaining & 0x0f)
	remaining = remaining / 16
	for remaining > 0 {
		bytesOut = append(bytesOut, byte(first|0x80))
		first = remaining & 0x7f
		remaining = remaining / 128
	}
	bytesOut = append(bytesOut, byte(first))
	return bytesOut
}

// writePack builds a packfile from plain objects (no deltas).
func writePack(objects []*GitObject) []byte {
	header := make([]byte, 12)
	copy(header[0:4], "PACK")
	header[4] = 0
	header[5] = 0
	header[6] = 0
	header[7] = 2
	header[8] = byte(len(objects) >> 24)
	header[9] = byte(len(objects) >> 16)
	header[10] = byte(len(objects) >> 8)
	header[11] = byte(len(objects))
	var body bytes.Buffer
	body.Write(header)
	for _, o := range objects {
		body.Write(packObjectHeader(o.Type, len(o.Data)))
		var zb bytes.Buffer
		zw, _ := zlib.NewWriterLevel(&zb, flate.DefaultCompression)
		zw.Write(o.Data)
		zw.Close()
		body.Write(zb.Bytes())
	}
	b := body.Bytes()
	h := sha1.New()
	h.Write(b)
	return append(b, h.Sum(nil)...)
}
