package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
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
func blob(b []byte) string {
	return fmt.Sprintf("%x", sha1.Sum(append([]byte(fmt.Sprintf("blob %d%c", len(b), 0)), b...)))
}
func archived(t *testing.T, r release, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	root := "douyin-xhs-collector-" + r.Commit + "/插件/"
	if _, err := z.Create(root); err != nil {
		t.Fatal(err)
	}
	for n, b := range files {
		f, err := z.Create(root + n)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func TestArchiveChecks(t *testing.T) {
	r := release{"2.0.0", strings.Repeat("a", 40)}
	for _, tc := range []struct {
		name  string
		data  map[string][]byte
		valid bool
	}{
		{"directory entry with complete tree", map[string][]byte{"icons/a": []byte("data")}, true},
		{"wrong content", map[string][]byte{"icons/a": []byte("changed")}, false},
		{"missing file", map[string][]byte{}, false},
		{"unexpected file", map[string][]byte{"icons/a": []byte("data"), "extra": []byte("extra")}, false},
		{"outside directory", map[string][]byte{"../outside": []byte("data")}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := extract(archived(t, r, tc.data), r, map[string]string{"icons/a": blob([]byte("data"))}, t.TempDir())
			if (err == nil) != tc.valid {
				t.Fatal(err)
			}
		})
	}
}

type fixtureHTTP func(*http.Request) (*http.Response, error)

func (f fixtureHTTP) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func mockRelease(t *testing.T, corrupt bool) release {
	t.Helper()
	r := release{"1.6.1", strings.Repeat("a", 40)}
	treeID := strings.Repeat("b", 40)
	manifest := manifestAt(t, r.Version)
	files := map[string][]byte{"manifest.json": manifest}
	if corrupt {
		files["manifest.json"] = []byte("incomplete")
	}
	archive := archived(t, r, files)
	previous := client
	t.Cleanup(func() { client = previous })
	client = &http.Client{Transport: fixtureHTTP(func(req *http.Request) (*http.Response, error) {
		var data []byte
		switch req.URL.String() {
		case api + "/git/ref/heads/main":
			data = []byte(fmt.Sprintf(`{"object":{"sha":"%s","type":"commit"}}`, r.Commit))
		case api + "/contents/%E6%8F%92%E4%BB%B6/manifest.json?ref=" + r.Commit:
			data = []byte(fmt.Sprintf(`{"encoding":"base64","content":"%s","sha":"%s"}`, base64.StdEncoding.EncodeToString(manifest), blob(manifest)))
		case api + "/tags?per_page=100&page=1":
			data = []byte(fmt.Sprintf(`[{"name":"v1.6.1","commit":{"sha":"%s"}},{"name":"v2.0.0-beta","commit":{"sha":"%s"}},{"name":"v1.5.0","commit":{"sha":"%s"}}]`, r.Commit, r.Commit, r.Commit))
		case api + "/git/commits/" + r.Commit:
			data = []byte(fmt.Sprintf(`{"sha":"%s","tree":{"sha":"%s"}}`, r.Commit, treeID))
		case api + "/git/trees/" + treeID + "?recursive=1":
			data = []byte(fmt.Sprintf(`{"sha":"%s","tree":[{"path":"插件/manifest.json","mode":"100644","type":"blob","sha":"%s"}]}`, treeID, blob(manifest)))
		case "https://codeload.github.com/" + repo + "/zip/" + r.Commit:
			data = archive
		default:
			t.Fatalf("unexpected request %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: http.Header{}}, nil
	})}
	return r
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

func TestMainPushWithoutRelease(t *testing.T) {
	for _, tags := range []struct{ label, expected string }{{"v1.5.0", "main"}, {"v1.6.1", "tag"}, {"v1.7.0", "tag"}} {
		t.Run(tags.label, func(t *testing.T) {
			main := mockRelease(t, false)
			tagSHA := strings.Repeat("d", 40)
			fixture := client.Transport
			client.Transport = fixtureHTTP(func(req *http.Request) (*http.Response, error) {
				if req.URL.Path == "/repos/"+repo+"/tags" {
					body := fmt.Sprintf(`[{"name":"%s","commit":{"sha":"%s"}}]`, tags.label, tagSHA)
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
				}
				return fixture.RoundTrip(req)
			})
			got, err := latest()
			want := main.Commit
			if tags.expected == "tag" {
				want = tagSHA
			}
			if err != nil || got.Commit != want {
				t.Fatalf("unexpected release %v %v", got, err)
			}
		})
	}
}
