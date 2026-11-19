package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const componentDir = "组件"
const helperDir = "更新助手"
const pendingDir = "payload-rollback"

// The native program, Chrome metadata and installation marker are owned locally.
// Neither a downloaded source archive nor a payload rollback installs those entries.
func localEntry(rel string) bool {
	top, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	switch strings.ToLower(top) {
	case componentDir, markerName, "_metadata", "说明", "安装采集器.command", "安装采集器.cmd", "安装采集器.sh":
		return true
	}
	return strings.HasPrefix(top, ".")
}

type payloadEntry struct {
	name string
	dir  bool
}

func payloadList(dir string) ([]payloadEntry, error) {
	var entries []payloadEntry
	err := filepath.WalkDir(dir, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if localEntry(rel) {
			if item.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !safeName(filepath.ToSlash(rel)) || (!item.IsDir() && !item.Type().IsRegular()) {
			return errors.New("插件目录包含不支持的文件。")
		}
		entries = append(entries, payloadEntry{rel, item.IsDir()})
		return nil
	})
	return entries, err
}

func atomicFile(path string, content []byte, mode fs.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".collector-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(content); err == nil {
		err = f.Chmod(mode)
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func copyPayloadFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	old, err := os.ReadFile(dst)
	if err == nil && bytes.Equal(old, b) {
		return nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return atomicFile(dst, b, 0600)
}

// Update regular files atomically; install the manifest last. The loaded extension
// root and its native component never move, including while Windows is running it.
func syncPayload(src, dst string) error {
	if _, err := manifestVersion(src); err != nil {
		return err
	}
	incoming, err := payloadList(src)
	if err != nil {
		return err
	}
	current, err := payloadList(dst)
	if err != nil {
		return err
	}
	kinds := make(map[string]bool, len(incoming))
	for _, e := range incoming {
		kinds[e.name] = e.dir
	}
	// Remove children before parents, including file/directory type changes.
	for i := len(current) - 1; i >= 0; i-- {
		e := current[i]
		if dir, keep := kinds[e.name]; keep && dir == e.dir {
			continue
		}
		if err := os.Remove(filepath.Join(dst, e.name)); err != nil {
			return err
		}
	}
	for _, e := range incoming {
		target := filepath.Join(dst, e.name)
		if e.dir {
			if err = os.MkdirAll(target, 0700); err != nil {
				return err
			}
		} else if e.name != "manifest.json" {
			if err = copyPayloadFile(filepath.Join(src, e.name), target); err != nil {
				return err
			}
		}
	}
	return copyPayloadFile(filepath.Join(src, "manifest.json"), filepath.Join(dst, "manifest.json"))
}

// Move the snapshot out of its active name before cleanup. An interrupted
// cleanup is never mistaken for a complete rollback snapshot.
func retireSnapshot(root string) error {
	trash, err := os.MkdirTemp(root, "finished-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(trash)
	return os.Rename(filepath.Join(root, pendingDir), filepath.Join(trash, "snapshot"))
}

func recoverPayload(root string) error {
	snapshot := filepath.Join(root, pendingDir)
	exists, err := isDir(snapshot)
	if err != nil || !exists {
		return err
	}
	dst := filepath.Join(root, folder)
	id := readMarker(snapshot)
	if id == "" || readMarker(dst) != id {
		return errors.New("更新恢复目录与已安装插件不匹配。")
	}
	if err = syncPayload(snapshot, dst); err != nil {
		return err
	}
	return retireSnapshot(root)
}

// Called under the same OS lock used by the v1.6.0 helper and the installer.
func activate(root, stage, id string) error {
	dst := filepath.Join(root, folder)
	if id == "" || readMarker(dst) != id {
		return errors.New("安装位置已改变，请重新打开插件。")
	}
	if _, err := manifestVersion(stage); err != nil {
		return err
	}
	backup, err := os.MkdirTemp(root, "backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(backup)
	if err = syncPayload(dst, backup); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(backup, markerName), marker{id}); err != nil {
		return err
	}
	if err = os.Rename(backup, filepath.Join(root, pendingDir)); err != nil {
		return err
	}
	if err = syncPayload(stage, dst); err != nil {
		if restoreErr := recoverPayload(root); restoreErr != nil {
			return errors.Join(err, restoreErr)
		}
		return err
	}
	return retireSnapshot(root)
}
