package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStableVersions(t *testing.T) {
	a, _ := parseVersion("1.10.0")
	b, _ := parseVersion("1.9.99")
	if compare(a, b) != 1 || compare(b, a) != -1 || compare(a, a) != 0 {
		t.Fatal("numeric order")
	}
	for _, s := range []string{"v1.2.3", "1.2.3-rc.1", "1.02.3", "1.2", "1.2.65536"} {
		if _, ok := parseVersion(s); ok {
			t.Fatal(s)
		}
	}
}
func manifestAt(t *testing.T, v string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err = json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	m["version"] = v
	b, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func writeTestFile(t *testing.T, p string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func archived(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for name, data := range files {
		f, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestArchiveChecks(t *testing.T) {
	for _, name := range []string{"../outside", "/absolute", "icons\\icon", markerName, componentDir + "/app", "_metadata/info", ".secret"} {
		t.Run(name, func(t *testing.T) {
			if err := extract(archived(t, map[string][]byte{name: []byte("data")}), t.TempDir()); err == nil {
				t.Fatal("unexpected path accepted", name)
			}
		})
	}
	if err := extract(archived(t, map[string][]byte{"A.js": nil, "a.js": nil}), t.TempDir()); err == nil {
		t.Fatal("case-colliding filenames accepted")
	}
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: "shortcut"}
	h.SetMode(os.ModeSymlink | 0777)
	w, err := z.CreateHeader(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write([]byte("outside")); err != nil {
		t.Fatal(err)
	}
	if err = z.Close(); err != nil {
		t.Fatal(err)
	}
	if err = extract(buf.Bytes(), t.TempDir()); err == nil {
		t.Fatal("link accepted")
	}
}

type fixtureHTTP func(*http.Request) (*http.Response, error)

func (f fixtureHTTP) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func reply(data []byte) *http.Response {
	return &http.Response{StatusCode: 200, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data)), Header: http.Header{}}
}
func useTransport(t *testing.T, transport fixtureHTTP) {
	t.Helper()
	before := client.Transport
	client.Transport = transport
	t.Cleanup(func() { client.Transport = before })
}

func testRelease(v string, archive []byte) release {
	digest := sha256.Sum256(archive)
	return release{Schema: 1, Version: v, Asset: archiveName(v), Size: int64(len(archive)), SHA256: fmt.Sprintf("%x", digest)}
}

func mockRelease(t *testing.T, corrupt bool) release {
	t.Helper()
	v := "1.6.1"
	archive := archived(t, map[string][]byte{"manifest.json": manifestAt(t, v)})
	r := testRelease(v, archive)
	feed, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if corrupt {
		archive[len(archive)-1] ^= 0xff
	}
	useTransport(t, func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" {
			t.Fatal("authenticated update")
		}
		switch req.URL.String() {
		case feedURL:
			return reply(feed), nil
		case releasesURL + "/download/v" + v + "/" + r.Asset:
			return reply(archive), nil
		default:
			t.Fatalf("unexpected network request %s", req.URL)
			return nil, nil
		}
	})
	return r
}

func TestInvalidReleaseFeed(t *testing.T) {
	for _, change := range []func(*release){
		func(r *release) { r.Version = "1.6.2-alpha" }, func(r *release) { r.Schema = 2 },
		func(r *release) { r.Size = 0 }, func(r *release) { r.Size = archiveLimit + 1 },
		func(r *release) { r.Asset = "https://example.com/other" }, func(r *release) { r.SHA256 = "bad" },
	} {
		r := testRelease("1.6.2", []byte("data"))
		change(&r)
		data, _ := json.Marshal(r)
		useTransport(t, func(*http.Request) (*http.Response, error) { return reply(data), nil })
		if _, err := latest(); err == nil {
			t.Fatal("invalid metadata accepted", r)
		}
	}
}

func TestSelectedReleaseStaysPinned(t *testing.T) {
	archive := archived(t, map[string][]byte{"manifest.json": manifestAt(t, "1.6.2")})
	r := testRelease("1.6.2", archive)
	feed, _ := json.Marshal(r)
	var requested []string
	useTransport(t, func(req *http.Request) (*http.Response, error) {
		requested = append(requested, req.URL.String())
		if len(requested) == 1 {
			return reply(feed), nil
		}
		return reply(archive), nil
	})
	got, err := latest()
	if err != nil {
		t.Fatal(err)
	}
	if err = prepare(got, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 || requested[0] != feedURL || requested[1] != releasesURL+"/download/v1.6.2/"+r.Asset {
		t.Fatal("expected one check and one pinned public asset", requested)
	}
}

func TestVerifiedArchiveMustMatchExtension(t *testing.T) {
	for _, files := range []map[string][]byte{
		{"missing.js": nil},
		{"manifest.json": manifestAt(t, "1.7.0")},
		{"manifest.json": []byte("{}")},
	} {
		archive := archived(t, files)
		r := testRelease("1.6.2", archive)
		useTransport(t, func(*http.Request) (*http.Response, error) { return reply(archive), nil })
		if err := prepare(r, t.TempDir()); err == nil {
			t.Fatal("incompatible payload accepted")
		}
	}
}

func TestRedirectPolicy(t *testing.T) {
	for _, tc := range []struct {
		address string
		want    bool
	}{
		{feedURL, true}, {releasesURL + "/download/v1.6.2/collector-update.json", true},
		{"https://release-assets.githubusercontent.com/github-production-release-asset/id?sig=opaque", true},
		{"https://api.github.com/repos/" + repo, false}, {"http://github.com/" + repo + "/releases/download/asset", false},
		{"https://github.com/other/repo/releases/download/v1/file", false},
		{"https://guest@release-assets.githubusercontent.com/asset", false}, {"https://release-assets.githubusercontent.com.example.com/asset", false},
	} {
		req, err := http.NewRequest(http.MethodGet, tc.address, nil)
		if err != nil {
			t.Fatal(err)
		}
		if (client.CheckRedirect(req, nil) == nil) != tc.want {
			t.Fatal(tc.address)
		}
	}
}

func protocol(t *testing.T, root string, requests ...request) ([]response, error) {
	t.Helper()
	var in, out bytes.Buffer
	for _, m := range requests {
		b, _ := json.Marshal(m)
		binary.Write(&in, binary.LittleEndian, uint32(len(b)))
		in.Write(b)
	}
	err := session(&in, &out, root)
	var result []response
	for out.Len() > 0 {
		var n uint32
		if e := binary.Read(&out, binary.LittleEndian, &n); e != nil {
			t.Fatal(e)
		}
		var m response
		if e := json.Unmarshal(out.Next(int(n)), &m); e != nil {
			t.Fatal(e)
		}
		result = append(result, m)
	}
	return result, err
}
func TestInstallProtocol(t *testing.T) {
	for _, mode := range []string{"apply", "cancel", "corrupt", "unmanaged", "ahead", "current", "already on disk"} {
		t.Run(mode, func(t *testing.T) {
			r := mockRelease(t, mode == "corrupt")
			root := t.TempDir()
			dst := filepath.Join(root, folder)
			v := "1.6.0"
			if mode == "ahead" {
				v = "2.0.0"
			}
			if mode == "current" || mode == "already on disk" {
				v = r.Version
			}
			writeTestFile(t, filepath.Join(dst, "manifest.json"), manifestAt(t, v))
			writeTestFile(t, filepath.Join(dst, "stale.js"), []byte("old"))
			id := strings.Repeat("12", 16)
			if err := writeJSON(filepath.Join(dst, markerName), marker{id}); err != nil {
				t.Fatal(err)
			}
			current := v
			if mode == "already on disk" {
				current = "1.6.0"
			}
			supplied := id
			if mode == "unmanaged" {
				supplied = ""
			}
			commands := []request{{Action: "check", Version: current, Installation: supplied}, {Action: "prepare"}}
			if mode != "cancel" {
				commands = append(commands, request{Action: "install"})
			}
			results, err := protocol(t, root, commands...)
			if len(results) == 0 {
				t.Fatal("no replies", err)
			}
			want := map[string]string{"apply": "installed", "cancel": "ready", "corrupt": "available", "unmanaged": "setup", "ahead": "ahead", "current": "current", "already on disk": "reload"}[mode]
			if results[len(results)-1].State != want {
				t.Fatalf("got %v, error %v", results, err)
			}
			if (err != nil) != (mode == "corrupt" || mode == "cancel") {
				t.Fatal(err)
			}
			got, _ := manifestVersion(dst)
			if mode == "apply" {
				v = r.Version
				if _, err := os.Stat(filepath.Join(dst, "stale.js")); !os.IsNotExist(err) {
					t.Fatal("stale file remains")
				}
			}
			if got != v || readMarker(dst) != id {
				t.Fatal("unexpected installation", got)
			}
		})
	}
}
func TestRecoveryAndLock(t *testing.T) {
	root := t.TempDir()
	previous := filepath.Join(root, "previous")
	writeTestFile(t, filepath.Join(previous, "manifest.json"), manifestAt(t, "1.6.0"))
	if err := writeJSON(filepath.Join(previous, markerName), marker{strings.Repeat("ab", 16)}); err != nil {
		t.Fatal(err)
	}
	release, err := lock(root)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lock(root); err == nil {
		second()
		t.Fatal("concurrent update allowed")
	}
	release()
	if err := recoverSwap(root); err != nil {
		t.Fatal(err)
	}
	got, err := manifestVersion(filepath.Join(root, folder))
	if got != "1.6.0" || err != nil {
		t.Fatal(got, err)
	}
}
func TestRejectUnexpectedFrame(t *testing.T) {
	if _, err := receive(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0x7f})); err == nil {
		t.Fatal("oversized message accepted")
	}
	if _, err := protocol(t, t.TempDir(), request{Action: "install", Version: "1.6.0"}); err == nil {
		t.Fatal("unverified installation accepted")
	}
}
