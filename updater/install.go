package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

func manifestVersion(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
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
	b, err := os.ReadFile(filepath.Join(dir, markerName))
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
	tmp, err := os.CreateTemp(filepath.Dir(path), ".collector-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(append(b, '\n'))
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), path)
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

// Call under the installation lock. A previous installation remains recoverable across an interruption.
func activate(root, stage, id string) error {
	if err := writeJSON(filepath.Join(stage, markerName), marker{id}); err != nil {
		return err
	}
	dst, old := filepath.Join(root, folder), filepath.Join(root, "previous")
	exists, err := isDir(dst)
	if err != nil {
		return err
	}
	if exists {
		if readMarker(dst) != id {
			return errors.New("安装位置已改变，请重新打开插件。")
		}
		if err = os.Rename(dst, old); err != nil {
			return err
		}
	}
	if err = os.Rename(stage, dst); err != nil {
		if exists {
			if restoreErr := os.Rename(old, dst); restoreErr != nil {
				return fmt.Errorf("需要再次运行安装工具恢复目录：%w", restoreErr)
			}
		}
		return err
	}
	// The next locked operation removes the previous version after validating the active directory.
	return nil
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
func copyExtension(src, dst string) error {
	return filepath.WalkDir(src, func(path string, item fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(src, path)
		if e != nil {
			return e
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(item.Name(), ".") || item.Name() == "_metadata" {
			if item.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if rel == markerName {
			return nil
		}
		if !safeName(filepath.ToSlash(rel)) {
			return errors.New("安装包中的文件名无效。")
		}
		target := filepath.Join(dst, rel)
		if item.IsDir() {
			return os.Mkdir(target, 0700)
		}
		if !item.Type().IsRegular() {
			return errors.New("安装包包含不支持的文件。")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0600)
	})
}

type registrationFile struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Path        string   `json:"path"`
	Type        string   `json:"type"`
	Allowed     []string `json:"allowed_origins"`
}

func install(exe, src, root, registration string) error {
	newVersion, err := manifestVersion(src)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if _, err = isDir(root); err != nil {
		return err
	}
	unlock, err := lock(root)
	if err != nil {
		return err
	}
	defer unlock()
	if err = recoverSwap(root); err != nil {
		return err
	}
	dst := filepath.Join(root, folder)
	id := readMarker(dst)
	if id != "" {
		v, err := manifestVersion(dst)
		if err != nil {
			return err
		}
		current, _ := parseVersion(v)
		candidate, _ := parseVersion(newVersion)
		if compare(candidate, current) < 0 {
			return errors.New("安装包版本低于已安装版本。")
		}
	} else {
		var b [16]byte
		if _, err = rand.Read(b[:]); err != nil {
			return err
		}
		id = hex.EncodeToString(b[:])
	}
	stage, err := os.MkdirTemp(root, "stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = copyExtension(src, stage); err != nil {
		return err
	}
	if got, err := manifestVersion(stage); err != nil || got != newVersion {
		return errors.New("复制扩展文件失败。")
	}
	bin := filepath.Join(root, "bin")
	if err = os.MkdirAll(bin, 0700); err != nil {
		return err
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	binary := filepath.Join(bin, "collector-updater-"+hex.EncodeToString(sum[:8]))
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	// Versioned names also permit upgrading the helper while Windows has an older binary open.
	if old, err := os.ReadFile(binary); err != nil || sha256.Sum256(old) != sum {
		file, err := os.CreateTemp(bin, "install-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		_, err = file.Write(data)
		if err == nil {
			err = file.Chmod(0700)
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = os.Rename(file.Name(), binary); err != nil {
			return err
		}
	}
	if err = os.MkdirAll(registration, 0700); err != nil {
		return err
	}
	config := filepath.Join(registration, hostName+".json")
	if old, err := os.ReadFile(config); err == nil {
		var registered registrationFile
		if json.Unmarshal(old, &registered) != nil || registered.Name != hostName || filepath.Dir(registered.Path) != bin {
			return errors.New("已有其他程序占用同一更新助手名称。")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err = writeJSON(config, registrationFile{hostName, "抖音小红书内容采集器更新助手", binary, "stdio", []string{origin}}); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		reg := filepath.Join(os.Getenv("SystemRoot"), "System32", "reg.exe")
		if err = exec.Command(reg, "add", `HKCU\Software\Google\Chrome\NativeMessagingHosts\`+hostName, "/ve", "/t", "REG_SZ", "/d", config, "/f").Run(); err != nil {
			return errors.New("Chrome 本机更新助手注册失败。")
		}
	}
	return activate(root, stage, id)
}
