package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func registeredPath(t *testing.T, config string) string {
	t.Helper()
	var host registrationFile
	if err := json.Unmarshal(mustRead(t, config), &host); err != nil {
		t.Fatal(err)
	}
	if host.Name != hostName || host.Type != "stdio" || len(host.Allowed) != 1 || host.Allowed[0] != origin {
		t.Fatalf("unexpected native host registration: %+v", host)
	}
	return host.Path
}

func TestMigrateLegacyThenUpdateTwice(t *testing.T) {
	root, src, hosts := t.TempDir(), t.TempDir(), t.TempDir()
	dst := filepath.Join(root, folder)
	config := filepath.Join(hosts, hostName+".json")
	id := strings.Repeat("ab", 16)
	writeTestFile(t, filepath.Join(dst, "manifest.json"), manifestAt(t, "1.6.0"))
	writeTestFile(t, filepath.Join(dst, "old", "unused.js"), []byte("old"))
	writeTestFile(t, filepath.Join(dst, "swapped"), []byte("old"))
	if err := writeJSON(filepath.Join(dst, markerName), marker{id}); err != nil {
		t.Fatal(err)
	}
	oldData, newData := []byte("v1.6.0 native binary"), []byte("integrated binary")
	old := filepath.Join(root, "bin", binaryName(oldData))
	private := filepath.Join(root, "bin", "other.txt")
	writeTestFile(t, old, oldData)
	writeTestFile(t, private, []byte("keep"))
	if err := writeRegistration(config, old); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(componentPath(src), "collector-updater")
	writeTestFile(t, exe, newData)
	writeTestFile(t, filepath.Join(src, "manifest.json"), manifestAt(t, "1.6.1"))
	writeTestFile(t, filepath.Join(src, "swapped", "index.js"), []byte("new"))
	fail := func(string, string) error { return errors.New("registration unavailable") }
	if _, err := install(exe, src, root, hosts, fail); err == nil || registeredPath(t, config) != old || !bytes.Equal(mustRead(t, old), oldData) {
		t.Fatal("failed registration must preserve the previous working host")
	}
	existing, err := install(exe, src, root, hosts, writeRegistration)
	if err != nil || !existing {
		t.Fatal(existing, err)
	}
	binary := registeredPath(t, config)
	if binary != filepath.Join(componentPath(dst), binaryName(newData)) {
		t.Fatal("wrong integrated host path", binary)
	}
	if v, err := manifestVersion(dst); err != nil || v != "1.6.0" || readMarker(dst) != id {
		t.Fatal("migration changed the running extension", v, err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) || string(mustRead(t, private)) != "keep" {
		t.Fatal("legacy cleanup")
	}
	pluginInfo, helperInfo := mustStat(t, dst), mustStat(t, binary)
	// Remote packages, including rollbacks, cannot supply local identity or helper files.
	writeTestFile(t, filepath.Join(componentPath(src), filepath.Base(binary)), []byte("untrusted"))
	writeTestFile(t, filepath.Join(src, markerName), []byte("wrong marker"))
	for _, version := range []string{"1.6.1", "1.6.2"} {
		writeTestFile(t, filepath.Join(src, "manifest.json"), manifestAt(t, version))
		if err := activate(root, src, id); err != nil {
			t.Fatal(err)
		}
		if v, err := manifestVersion(dst); err != nil || v != version || readMarker(dst) != id ||
			registeredPath(t, config) != binary || !os.SameFile(helperInfo, mustStat(t, binary)) ||
			!os.SameFile(pluginInfo, mustStat(t, dst)) || !bytes.Equal(mustRead(t, binary), newData) {
			t.Fatal("payload or local identity changed", version, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dst, "old")); !os.IsNotExist(err) || string(mustRead(t, filepath.Join(dst, "swapped", "index.js"))) != "new" {
		t.Fatal("obsolete paths or file-to-directory change")
	}
	if _, err = install(exe, src, root, hosts, writeRegistration); err != nil || !os.SameFile(helperInfo, mustStat(t, binary)) {
		t.Fatal("same-version reinstall", err)
	}
}

func TestFreshInstallAndInterruptedPayload(t *testing.T) {
	root, src, hosts := t.TempDir(), t.TempDir(), t.TempDir()
	exe := filepath.Join(componentPath(src), "collector-updater")
	writeTestFile(t, exe, []byte("binary"))
	writeTestFile(t, filepath.Join(src, "manifest.json"), manifestAt(t, "1.6.1"))
	writeTestFile(t, filepath.Join(src, "popup.js"), []byte("rollback contents"))
	writeTestFile(t, filepath.Join(src, "安装采集器.cmd"), []byte("launcher"))
	existing, err := install(exe, src, root, hosts, writeRegistration)
	if err != nil || existing {
		t.Fatal(existing, err)
	}
	dst, snapshot := filepath.Join(root, folder), filepath.Join(root, pendingDir)
	if _, err := os.Stat(filepath.Join(dst, "安装采集器.cmd")); !os.IsNotExist(err) {
		t.Fatal("distribution launcher copied into Chrome")
	}
	binary := registeredPath(t, filepath.Join(hosts, hostName+".json"))
	helperInfo := mustStat(t, binary)
	id := readMarker(dst)
	if id == "" {
		t.Fatal("missing installation marker")
	}
	writeTestFile(t, filepath.Join(snapshot, markerName), mustRead(t, filepath.Join(dst, markerName)))
	if err := syncPayload(dst, snapshot); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(dst, "popup.js"), []byte("partly applied"))
	writeTestFile(t, filepath.Join(dst, "temporary.js"), []byte("incomplete upgrade"))
	if err := recoverInstall(root); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, filepath.Join(dst, "popup.js"))) != "rollback contents" || readMarker(dst) != id || !os.SameFile(helperInfo, mustStat(t, binary)) {
		t.Fatal("incomplete rollback")
	}
	for _, path := range []string{snapshot, filepath.Join(dst, "temporary.js")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("recovery left unexpected file", path, err)
		}
	}
}
