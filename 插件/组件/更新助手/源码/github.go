package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const repo = "jiamuAi/douyin-xhs-collector"
const api = "https://api.github.com/repos/" + repo
const archiveLimit = 48 << 20
const fileLimit = 12 << 20

var hashPattern = regexp.MustCompile("^[0-9a-f]{40}$")
var versionPattern = regexp.MustCompile("^(0|[1-9][0-9]{0,4})[.](0|[1-9][0-9]{0,4})[.](0|[1-9][0-9]{0,4})$")

type version [3]int

func parseVersion(s string) (v version, ok bool) {
	if !versionPattern.MatchString(s) {
		return
	}
	for i, n := range strings.Split(s, ".") {
		v[i], _ = strconv.Atoi(n)
		if v[i] > 65535 {
			return v, false
		}
	}
	return v, true
}
func compare(a, b version) int {
	for i := range a {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

type release struct{ Version, Commit string }

var client = &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
	if len(via) >= 3 || !githubURL(r.URL) {
		return errors.New("GitHub 返回了不支持的下载地址。")
	}
	return nil
}}

func githubURL(u *url.URL) bool {
	return u.Scheme == "https" && u.User == nil && (u.Host == "api.github.com" || u.Host == "codeload.github.com")
}
func get(urlString string, limit int64) ([]byte, error) {
	req, err := http.NewRequest("GET", urlString, nil)
	if err != nil || !githubURL(req.URL) {
		return nil, errors.New("更新地址无效。")
	}
	req.Header.Set("User-Agent", "douyin-xhs-collector-updater/1")
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("连接 GitHub 失败，请检查网络后重试。")
	}
	defer res.Body.Close()
	if res.StatusCode == 403 || res.StatusCode == 429 {
		return nil, errors.New("GitHub 暂时限制了请求，请稍后重试。")
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub 请求失败（HTTP %d），请稍后重试。", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("下载中断或文件超出大小限制。")
	}
	return b, nil
}
func readAPI(path string, dst any) error {
	b, err := get(api+path, 8<<20)
	if err != nil {
		return err
	}
	if json.Unmarshal(b, dst) != nil {
		return errors.New("GitHub 返回的数据不完整。")
	}
	return nil
}

// Pin main to a commit before reading its manifest, so a concurrent push cannot change the download.
func mainRelease() (release, error) {
	var ref struct{ Object struct{ SHA, Type string } }
	if err := readAPI("/git/ref/heads/main", &ref); err != nil {
		return release{}, err
	}
	if ref.Object.Type != "commit" || !hashPattern.MatchString(ref.Object.SHA) {
		return release{}, errors.New("无法确认主分支的发布提交。")
	}
	var file struct{ Encoding, Content, SHA string }
	if err := readAPI("/contents/"+url.PathEscape(folder)+"/manifest.json?ref="+ref.Object.SHA, &file); err != nil {
		return release{}, err
	}
	b, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil || file.Encoding != "base64" || len(b) > 64<<10 || blobID(b) != file.SHA {
		return release{}, errors.New("主分支的扩展清单校验失败。")
	}
	v, err := checkedManifest(b)
	return release{v, ref.Object.SHA}, err
}

func latest() (release, error) {
	best, err := mainRelease()
	if err != nil {
		return release{}, err
	}
	highest, _ := parseVersion(best.Version)
	for page := 1; page <= 20; page++ {
		var tags []struct {
			Name   string
			Commit struct{ SHA string }
		}
		if err := readAPI(fmt.Sprintf("/tags?per_page=100&page=%d", page), &tags); err != nil {
			return best, err
		}
		for _, tag := range tags {
			label, prefixed := strings.CutPrefix(tag.Name, "v")
			v, valid := parseVersion(label)
			if prefixed && valid && hashPattern.MatchString(tag.Commit.SHA) && compare(v, highest) >= 0 {
				best = release{label, tag.Commit.SHA}
				highest = v
			}
		}
		if len(tags) < 100 {
			return best, nil
		}
	}
	return release{}, errors.New("版本列表过长，无法确认最新版本。")
}

type treeEntry struct{ Path, Mode, Type, SHA string }

func filesFor(r release) (map[string]string, error) {
	var commit struct {
		SHA  string
		Tree struct{ SHA string }
	}
	if err := readAPI("/git/commits/"+r.Commit, &commit); err != nil {
		return nil, err
	}
	if commit.SHA != r.Commit || !hashPattern.MatchString(commit.Tree.SHA) {
		return nil, errors.New("发布提交校验失败。")
	}
	var tree struct {
		SHA       string
		Truncated bool
		Tree      []treeEntry
	}
	if err := readAPI("/git/trees/"+commit.Tree.SHA+"?recursive=1", &tree); err != nil {
		return nil, err
	}
	if tree.SHA != commit.Tree.SHA || tree.Truncated {
		return nil, errors.New("无法取得完整的发布文件清单。")
	}
	files := map[string]string{}
	paths := map[string]bool{}
	for _, entry := range tree.Tree {
		name, ok := strings.CutPrefix(entry.Path, "插件/")
		if !ok {
			continue
		}
		key := strings.ToLower(name)
		if !safeName(name) || paths[key] {
			return nil, errors.New("发布目录含不兼容的文件名。")
		}
		if localEntry(name) {
			continue
		}
		paths[key] = true
		if entry.Mode == "040000" && entry.Type == "tree" {
			continue
		}
		if (entry.Mode != "100644" && entry.Mode != "100755") || entry.Type != "blob" || !hashPattern.MatchString(entry.SHA) {
			return nil, errors.New("发布目录包含不支持的文件。")
		}
		files[name] = entry.SHA
	}
	if len(files) > 1024 || files["manifest.json"] == "" {
		return nil, errors.New("发布目录缺少清单或超出大小限制。")
	}
	return files, nil
}
func safeName(name string) bool {
	if name == "" || len(name) > 600 || strings.ContainsAny(name, "\\:<>\"|?*") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || !filepath.IsLocal(part) {
			return false
		}
		for _, r := range part {
			if r < 32 {
				return false
			}
		}
	}
	return true
}
func blobID(b []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d%c", len(b), 0)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

func extract(b []byte, r release, files map[string]string, dir string) error {
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return errors.New("下载的源码包无法打开。")
	}
	prefix := "douyin-xhs-collector-" + r.Commit + "/插件/"
	seen := map[string]bool{}
	total := 0
	for _, f := range z.File {
		name, ok := strings.CutPrefix(f.Name, prefix)
		if !ok || name == "" || strings.HasSuffix(name, "/") {
			continue
		}
		if safeName(name) && localEntry(name) {
			continue
		}
		want, known := files[name]
		if !known || !safeName(name) || seen[name] || !f.Mode().IsRegular() || f.UncompressedSize64 > fileLimit {
			return errors.New("源码包与发布文件清单不一致。")
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(in, fileLimit+1))
		in.Close()
		total += len(data)
		if err != nil || len(data) > fileLimit || total > archiveLimit {
			return errors.New("发布文件不完整或超出大小限制。")
		}
		if blobID(data) != want {
			return errors.New("发布文件校验失败，已取消更新。")
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(path, data, 0600); err != nil {
			return err
		}
		seen[name] = true
	}
	if len(seen) != len(files) {
		return errors.New("下载的源码包缺少发布文件。")
	}
	return nil
}
func prepare(r release, dir string) error {
	files, err := filesFor(r)
	if err != nil {
		return err
	}
	b, err := get("https://codeload.github.com/"+repo+"/zip/"+r.Commit, archiveLimit)
	if err != nil {
		return err
	}
	if err = extract(b, r, files, dir); err != nil {
		return err
	}
	v, err := manifestVersion(dir)
	if err != nil {
		return err
	}
	if v != r.Version {
		return errors.New("扩展清单版本与选定的发布版本不一致。")
	}
	return nil
}
