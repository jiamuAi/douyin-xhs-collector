"""Build installer ZIPs and the browser-only GitHub Releases update feed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

source = Path(__file__).resolve().parent
plugin = source.parents[2]
project = plugin.parent
product = "抖音小红书内容采集器"
components = f"{product}/组件/更新助手"
version = json.loads((plugin / "manifest.json").read_text(encoding="utf-8"))["version"]

scripts = {
    "darwin": ("安装采集器.command", '''#!/bin/sh
set -eu
cd "$(dirname "$0")"
dir="$HOME/Library/Application Support/DouyinXhsCollector/插件"
show_folder=1
if [ -f "$dir/update-install.json" ]; then show_folder=0; fi
"./组件/更新助手/collector-updater" --install
if [ "$show_folder" = 1 ]; then open -R "$dir"; fi
'''),
    "linux": ("安装采集器.sh", '''#!/bin/sh
set -eu
cd "$(dirname "$0")"
"./组件/更新助手/collector-updater" --install
'''),
    "windows": ("安装采集器.cmd", '@echo off\r\nchcp 65001 >nul\r\n"%~dp0组件\\更新助手\\collector-updater.exe" --install\r\npause\r\n'),
}


def browser_files():
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "-z", "--", "插件", ":(exclude)插件/组件/**"],
        cwd=project,
    )
    files = []
    for raw in sorted(filter(None, tracked.split(b"\0"))):
        path = project / os.fsdecode(raw)
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"unexpected browser file: {path.name}")
        name = path.relative_to(plugin).as_posix()
        if name == "update-install.json":
            if json.loads(path.read_text(encoding="utf-8")) != {}:
                raise ValueError("the repository must contain an empty installation marker")
        files.append((name, path))
    return files


def build_update(output, files):
    archive = output / f"collector-update-v{version}.zip"
    with zipfile.ZipFile(archive, "w") as package:
        for name, path in files:
            if name == "update-install.json":
                continue
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    data = archive.read_bytes()
    feed = {"schema": 1, "version": version, "asset": archive.name,
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    (output / "collector-update.json").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
    print(archive)


def build_installer(platform, arch, output, files):
    binary = "collector-updater" + (".exe" if platform == "windows" else "")
    go_root = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
    filename = output / f"douyin-xhs-collector-v{version}-{platform}-{arch}.zip"
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / binary
        subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", str(target), "."],
                       cwd=source, check=True,
                       env={**os.environ, "GOOS": platform, "GOARCH": arch, "CGO_ENABLED": "0"})
        with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED) as package:
            package.write(target, f"{components}/{binary}")
            package.write(go_root / "LICENSE", f"{product}/说明/licenses/Go-LICENSE.txt")
            for license_file in sorted((go_root / "src/vendor/golang.org/x").glob("*/LICENSE")):
                package.write(license_file, f"{product}/说明/licenses/golang-x-{license_file.parent.name}-LICENSE.txt")
            script_name, script = scripts[platform]
            launcher = Path(tmp) / script_name
            launcher.write_bytes(script.encode("utf-8"))
            launcher.chmod(0o755)
            package.write(launcher, f"{product}/{script_name}")
            for name, path in files:
                package.write(path, f"{product}/{name}")
            for doc in ("LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "安装与使用.md"):
                package.write(project / doc, f"{product}/说明/{doc}")
    print(filename)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="kind", required=True)
    for platform in scripts:
        command = commands.add_parser(platform)
        command.add_argument("arch", choices=["arm64", "amd64"])
        command.add_argument("output", type=Path)
    commands.add_parser("update").add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.kind == "update":
        build_update(args.output, browser_files())
    else:
        build_installer(args.kind, args.arch, args.output, browser_files())
