package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type request struct {
	Action       string `json:"action"`
	Version      string `json:"version"`
	Installation string `json:"installation"`
}
type response struct {
	Integrated    bool   `json:"integrated,omitempty"`
	ReleaseAssets bool   `json:"releaseAssets,omitempty"`
	State         string `json:"state"`
	Version       string `json:"version,omitempty"`
	Message       string `json:"message,omitempty"`
}

func receive(in io.Reader) (msg request, err error) {
	var size uint32
	if err = binary.Read(in, binary.LittleEndian, &size); err != nil {
		return
	}
	if size == 0 || size > 2048 {
		return msg, errors.New("更新请求无效。")
	}
	b := make([]byte, size)
	if _, err = io.ReadFull(in, b); err != nil {
		return
	}
	err = json.Unmarshal(b, &msg)
	return
}
func send(out io.Writer, msg response) error {
	msg.Integrated = true
	msg.ReleaseAssets = true
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if err = binary.Write(out, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = out.Write(b)
	return err
}
func action(in io.Reader, want string) error {
	m, err := receive(in)
	if err != nil {
		return err
	}
	if m.Action != want {
		return errors.New("更新操作顺序无效。")
	}
	return nil
}
func session(in io.Reader, out io.Writer, root string) error {
	m, err := receive(in)
	if err != nil {
		return err
	}
	current, ok := parseVersion(m.Version)
	if m.Action != "check" || !ok {
		return errors.New("更新请求无效。")
	}
	dst := filepath.Join(root, folder)
	unlock, err := lock(root)
	if err != nil {
		return err
	}
	defer unlock()
	if err = recoverInstall(root); err != nil {
		return err
	}
	installed := m.Installation != "" && readMarker(dst) == m.Installation
	if installed {
		cleanHelpers(filepath.Join(root, "bin"), "")
		disk, err := manifestVersion(dst)
		if err != nil {
			return err
		}
		v, _ := parseVersion(disk)
		if compare(v, current) > 0 {
			return send(out, response{State: "reload", Version: disk})
		}
		if disk != m.Version {
			return errors.New("浏览器版本与本机文件不一致，请重新加载插件。")
		}
	}
	r, err := latest()
	if err != nil {
		return err
	}
	candidate, _ := parseVersion(r.Version)
	switch compare(candidate, current) {
	case -1:
		return send(out, response{State: "ahead", Version: r.Version})
	case 0:
		return send(out, response{State: "current", Version: r.Version})
	}
	if !installed {
		return send(out, response{State: "setup", Version: r.Version})
	}
	if err = send(out, response{State: "available", Version: r.Version}); err != nil {
		return err
	}
	if err = action(in, "prepare"); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(root, "stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = prepare(r, stage); err != nil {
		return err
	}
	if err = send(out, response{State: "ready", Version: r.Version}); err != nil {
		return err
	}
	if err = action(in, "install"); err != nil {
		return err
	}
	if err = activate(root, stage, m.Installation); err != nil {
		return err
	}
	return send(out, response{State: "installed", Version: r.Version})
}
func main() {
	exe, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	if len(os.Args) >= 2 && os.Args[1] == origin {
		var plugin string
		plugin, err = pluginForHelper(exe)
		if err == nil && filepath.Base(plugin) == folder {
			err = session(os.Stdin, os.Stdout, filepath.Dir(plugin))
		} else {
			err = errors.New("更新助手未从已安装的插件目录启动。")
		}
		if err != nil && !errors.Is(err, io.EOF) {
			var pathErr *os.PathError
			message := err.Error()
			if errors.As(err, &pathErr) {
				message = "无法读写本机安装目录，请关闭占用的文件后重试。"
			}
			send(os.Stdout, response{State: "error", Message: message})
		}
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "--install" {
		fmt.Fprintln(os.Stderr, "请运行安装包中的「安装采集器」。")
		os.Exit(1)
	}
	root, registration, err := userPaths()
	if err == nil {
		var src string
		src, err = pluginForHelper(exe)
		if err == nil {
			var existing bool
			existing, err = install(exe, src, root, registration, register)
			if err == nil && existing {
				fmt.Println("更新助手已就位。请打开 Chrome 中原来的采集器，点「检查并更新」。")
				return
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "安装失败。", err)
		os.Exit(1)
	}
	fmt.Println("已安装。请在 Chrome 的「加载已解压的扩展程序」中选择此文件夹：")
	fmt.Println(filepath.Join(root, folder))
}
