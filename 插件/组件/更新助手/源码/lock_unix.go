//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func lock(root string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(root, "install.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return nil, errors.New("另一个更新正在进行，请稍后再试。")
	}
	return func() { f.Close() }, nil
}
