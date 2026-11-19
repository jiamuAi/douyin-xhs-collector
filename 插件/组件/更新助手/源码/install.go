package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const hostName = "ai.jiamu.dy_xhs_collector"
const extensionID = "npnmgnkhnkjhgbccjajcfbbhppkjgpke"
const origin = "chrome-extension://" + extensionID + "/"
const markerName = "update-install.json"
const folder = "插件"

type marker struct {
	Installation string `json:"installation"`
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("安装记录或清单不是普通文件。")
	}
	return os.ReadFile(path)
}

func manifestVersion(dir string) (string, error) {
	b, err := readRegular(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return "", err
	}
	return checkedManifest(b)
}

func checkedManifest(b []byte) (string, error) {
	var m struct {
		Key, Version string
		Manifest     int `json:"manifest_version"`
	}
	if json.Unmarshal(b, &m) != nil {
		return "", errors.New("扩展清单无效。")
	}
	k, err := base64.StdEncoding.DecodeString(m.Key)
	digest := sha256.Sum256(k)
	id := "" // Chrome maps each hex nibble to a letter.
	for _, n := range digest[:16] {
		id += string([]byte{'a' + (n >> 4), 'a' + (n & 15)})
	}
	if _, ok := parseVersion(m.Version); err != nil || !ok || m.Manifest != 3 || id != extensionID {
		return "", errors.New("扩展身份或版本校验失败。")
	}
	return m.Version, nil
}
func readMarker(dir string) string {
	b, err := readRegular(filepath.Join(dir, markerName))
	var m marker
	if err != nil || json.Unmarshal(b, &m) != nil || len(m.Installation) != 32 {
		return ""
	}
	if _, err = hex.DecodeString(m.Installation); err != nil {
		return ""
	}
	return m.Installation
}
func writeJSON(path string, data any) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return atomicFile(path, append(b, '\n'), 0600)
}
func isDir(dir string) (bool, error) {
	s, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !s.IsDir() {
		return false, errors.New("安装目录被其他文件占用。")
	}
	return true, nil
}
func managed(dir string) bool { return readMarker(dir) != "" }
func recoverSwap(root string) error {
	dst, old := filepath.Join(root, folder), filepath.Join(root, "previous")
	exists, err := isDir(dst)
	if err != nil {
		return err
	}
	backup, err := isDir(old)
	if err != nil {
		return err
	}
	if exists && !managed(dst) || backup && !managed(old) {
		return errors.New("目标目录已有其他文件，请检查安装位置。")
	}
	if !backup {
		return nil
	}
	if !exists {
		return os.Rename(old, dst)
	}
	if _, err = manifestVersion(dst); err != nil {
		return err
	}
	return os.RemoveAll(old)
}

func userPaths() (root, registration string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		return filepath.Join(base, "DouyinXhsCollector"), filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts"), nil
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			return "", "", errors.New("缺少本地应用目录。")
		}
		root = filepath.Join(base, "DouyinXhsCollector")
		return root, root, nil
	case "linux":
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
		config, err := os.UserConfigDir()
		return filepath.Join(base, "DouyinXhsCollector"), filepath.Join(config, "google-chrome", "NativeMessagingHosts"), err
	}
	return "", "", errors.New("此系统尚未提供更新助手。")
}

type registrationFile struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Path        string   `json:"path"`
	Type        string   `json:"type"`
	Allowed     []string `json:"allowed_origins"`
}

func componentPath(plugin string) string { return filepath.Join(plugin, componentDir, helperDir) }

func pluginForHelper(exe string) (string, error) {
	parent := filepath.Dir(exe)
	if filepath.Base(parent) != helperDir || filepath.Base(filepath.Dir(parent)) != componentDir {
		return "", errors.New("请保留完整的采集器文件夹，运行其中的「安装采集器」。")
	}
	return filepath.Dir(filepath.Dir(parent)), nil
}

func ensureDirectory(path string) error {
	exists, err := isDir(path)
	if err != nil || exists {
		return err
	}
	return os.Mkdir(path, 0700)
}

func binaryName(data []byte) string {
	sum := sha256.Sum256(data)
	name := "collector-updater-" + hex.EncodeToString(sum[:8])
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func putHelper(exe, plugin string) (string, error) {
	data, err := os.ReadFile(exe)
	if err != nil {
		return "", err
	}
	for _, dir := range []string{filepath.Join(plugin, componentDir), componentPath(plugin)} {
		if err = ensureDirectory(dir); err != nil {
			return "", err
		}
	}
	target := filepath.Join(componentPath(plugin), binaryName(data))
	info, err := os.Lstat(target)
	if err == nil {
		if !info.Mode().IsRegular() {
			return "", errors.New("更新助手位置被其他文件占用。")
		}
		old, err := os.ReadFile(target)
		if err != nil {
			return "", err
		}
		if bytes.Equal(old, data) {
			return target, nil
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	return target, atomicFile(target, data, 0700)
}

func ownedBinaryName(name string) bool {
	if runtime.GOOS == "windows" {
		var ok bool
		name, ok = strings.CutSuffix(name, ".exe")
		if !ok {
			return false
		}
	}
	hash, ok := strings.CutPrefix(name, "collector-updater-")
	if !ok || len(hash) != 16 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func checkRegistration(config, root string) error {
	b, err := readRegular(config)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var old registrationFile
	if json.Unmarshal(b, &old) == nil && old.Name == hostName && old.Type == "stdio" && len(old.Allowed) == 1 && old.Allowed[0] == origin && ownedBinaryName(filepath.Base(old.Path)) {
		parent := filepath.Dir(old.Path)
		if samePath(parent, filepath.Join(root, "bin")) || samePath(parent, componentPath(filepath.Join(root, folder))) {
			return nil
		}
	}
	return errors.New("已有其他程序占用同一更新助手名称。")
}

func register(config, binary string) error {
	// On Windows the registry always points to this same per-user JSON file.
	// Establish the pointer first; an existing JSON remains usable if reg.exe fails.
	if runtime.GOOS == "windows" {
		reg := filepath.Join(os.Getenv("SystemRoot"), "System32", "reg.exe")
		if err := exec.Command(reg, "add", `HKCU\Software\Google\Chrome\NativeMessagingHosts\`+hostName, "/ve", "/t", "REG_SZ", "/d", config, "/f").Run(); err != nil {
			return errors.New("Chrome 本机更新助手注册失败。")
		}
	}
	return writeRegistration(config, binary)
}

func writeRegistration(config, binary string) error {
	return writeJSON(config, registrationFile{hostName, "抖音小红书内容采集器更新助手", binary, "stdio", []string{origin}})
}

// Only remove files produced by this installer. A running older Windows process
// may still hold its executable open; the next native session retries cleanup.
func cleanHelpers(dir, keep string) {
	exists, err := isDir(dir)
	if err != nil || !exists {
		return
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, f := range files {
		p := filepath.Join(dir, f.Name())
		if !ownedBinaryName(f.Name()) || !f.Type().IsRegular() || samePath(p, keep) {
			continue
		}
		data, err := os.ReadFile(p)
		if err == nil && binaryName(data) == f.Name() {
			_ = os.Remove(p)
		}
	}
	if keep == "" {
		_ = os.Remove(dir) // Only an empty directory can be removed here.
	}
}

func recoverInstall(root string) error {
	// The v1.6.0 helper may have been interrupted during a whole-folder swap.
	if err := recoverSwap(root); err != nil {
		return err
	}
	return recoverPayload(root)
}

// Existing installations keep their Chrome path, marker and current payload;
// their next popup update coordinates with active collection and export jobs.
func install(exe, src, root, registration string, registerHost func(string, string) error) (existing bool, err error) {
	newVersion, err := manifestVersion(src)
	if err != nil {
		return false, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return false, err
	}
	if _, err = isDir(root); err != nil {
		return false, err
	}
	unlock, err := lock(root)
	if err != nil {
		return false, err
	}
	defer unlock()
	if err = recoverInstall(root); err != nil {
		return false, err
	}
	dst := filepath.Join(root, folder)
	existing, err = isDir(dst)
	if err != nil {
		return false, err
	}
	if err = os.MkdirAll(registration, 0700); err != nil {
		return false, err
	}
	config := filepath.Join(registration, hostName+".json")
	if err = checkRegistration(config, root); err != nil {
		return false, err
	}

	var binary string
	if existing {
		v, err := manifestVersion(dst)
		if err != nil {
			return false, err
		}
		current, _ := parseVersion(v)
		candidate, _ := parseVersion(newVersion)
		if compare(candidate, current) < 0 {
			return false, errors.New("安装包版本低于已安装版本。")
		}
		if v == newVersion {
			// A same-version reinstall can repair the browser files offline.
			if err = activate(root, src, readMarker(dst)); err != nil {
				return false, err
			}
		}
		binary, err = putHelper(exe, dst)
		if err != nil {
			return false, err
		}
	} else {
		stage, err := os.MkdirTemp(root, "install-")
		if err != nil {
			return false, err
		}
		defer os.RemoveAll(stage)
		if err = syncPayload(src, stage); err != nil {
			return false, err
		}
		var id [16]byte
		if _, err = rand.Read(id[:]); err != nil {
			return false, err
		}
		if err = writeJSON(filepath.Join(stage, markerName), marker{hex.EncodeToString(id[:])}); err != nil {
			return false, err
		}
		staged, err := putHelper(exe, stage)
		if err != nil {
			return false, err
		}
		binary = filepath.Join(componentPath(dst), filepath.Base(staged))
		if err = os.Rename(stage, dst); err != nil {
			return false, err
		}
	}
	if err = registerHost(config, binary); err != nil {
		return false, err
	}
	cleanHelpers(filepath.Join(root, "bin"), "")
	cleanHelpers(componentPath(dst), binary)
	return existing, nil
}
