package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
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
const releasesURL = "https://github.com/" + repo + "/releases"
const feedURL = releasesURL + "/latest/download/collector-update.json"
const archiveLimit = 48 << 20
const fileLimit = 12 << 20

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

type release struct {
	Schema  int    `json:"schema"`
	Version string `json:"version"`
	Asset   string `json:"asset"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

func archiveName(v string) string { return "collector-update-v" + v + ".zip" }

var client = &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
	if len(via) >= 5 || !releaseURL(r.URL) {
		return errors.New("GitHub 返回了不支持的下载地址。")
	}
	return nil
}}

func releaseURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil {
		return false
	}
	switch u.Host {
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+repo+"/releases/download/") || u.String() == feedURL
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}

func get(address string, limit int64) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil || !releaseURL(req.URL) {
		return nil, errors.New("更新地址无效。")
	}
	req.Header.Set("User-Agent", "douyin-xhs-collector-updater/2")
	res, err := client.Do(req)
	if err != nil {
		return nil, errors.New("连接 GitHub Releases 失败，请检查网络后重试。")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub 更新文件下载失败（HTTP %d），请稍后重试。", res.StatusCode)
	}
	if res.ContentLength > limit {
		return nil, errors.New("更新文件超过大小限制。")
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("更新文件下载中断或超出大小限制。")
	}
	return b, nil
}

func latest() (release, error) {
	b, err := get(feedURL, 16<<10)
	if err != nil {
		return release{}, err
	}
	var r release
	if json.Unmarshal(b, &r) != nil {
		return release{}, errors.New("GitHub 发布的更新清单无法解析。")
	}
	digest, err := hex.DecodeString(r.SHA256)
	if _, ok := parseVersion(r.Version); !ok || r.Schema != 1 || r.Asset != archiveName(r.Version) ||
		r.Size <= 0 || r.Size > archiveLimit || err != nil || len(digest) != sha256.Size {
		return release{}, errors.New("GitHub 发布的更新清单无效。")
	}
	return r, nil
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

// Release archives contain regular browser files at the root. The native helper,
// install marker and Chrome-owned files are never delivered by this channel.
func extract(b []byte, dir string) error {
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil || len(z.File) == 0 || len(z.File) > 1024 {
		return errors.New("更新包无法打开或文件数量不符合要求。")
	}
	seen := map[string]bool{}
	var total uint64
	for _, f := range z.File {
		name := f.Name
		folded := strings.ToLower(name)
		if !safeName(name) || localEntry(name) || seen[folded] || !f.Mode().IsRegular() || f.UncompressedSize64 > fileLimit {
			return errors.New("更新包中有不支持的文件。")
		}
		total += f.UncompressedSize64
		if total > archiveLimit {
			return errors.New("解压后的更新包超出大小限制。")
		}
		seen[folded] = true
		in, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(in, int64(f.UncompressedSize64)+1))
		in.Close()
		if err != nil || uint64(len(data)) != f.UncompressedSize64 {
			return errors.New("更新包中的文件不完整。")
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(path, data, 0600); err != nil {
			return err
		}
	}
	return nil
}

func prepare(r release, dir string) error {
	// A newer Release may go live after the check. Pin this download to its version.
	b, err := get(releasesURL+"/download/v"+r.Version+"/"+r.Asset, r.Size)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(b)
	if int64(len(b)) != r.Size || !strings.EqualFold(hex.EncodeToString(digest[:]), r.SHA256) {
		return errors.New("更新包的大小或 SHA-256 校验失败，已取消更新。")
	}
	if err = extract(b, dir); err != nil {
		return err
	}
	v, err := manifestVersion(dir)
	if err != nil {
		return err
	}
	if v != r.Version {
		return errors.New("扩展版本与发布清单不一致。")
	}
	return nil
}
