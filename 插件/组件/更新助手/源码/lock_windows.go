package main

import (
	"errors"
	"path/filepath"
	"syscall"
)

func lock(root string) (func(), error) {
	p, err := syscall.UTF16PtrFromString(filepath.Join(root, "install.lock"))
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, errors.New("安装目录正被占用或无写入权限。")
	}
	return func() { syscall.CloseHandle(h) }, nil
}
