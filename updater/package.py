"""Build a self-contained desktop install ZIP using Python 3 and Go (maintainers only)."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

project = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("platform", choices=["darwin", "windows", "linux"])
parser.add_argument("arch", choices=["arm64", "amd64"])
parser.add_argument("output", type=Path)
args = parser.parse_args()
version = json.loads((project / "插件/manifest.json").read_text(encoding="utf-8"))["version"]
binary = "collector-updater" + (".exe" if args.platform == "windows" else "")
scripts = {
    "darwin": ("安装采集器.command", '''#!/bin/sh
set -eu
cd "$(dirname "$0")"
./collector-updater --install
open -R "$HOME/Library/Application Support/DouyinXhsCollector/插件"
'''),
    "linux": ("安装采集器.sh", '''#!/bin/sh
set -eu
cd "$(dirname "$0")"
./collector-updater --install
'''),
    "windows": ("安装采集器.cmd", '@echo off\r\n"%~dp0collector-updater.exe" --install\r\npause\r\n'),
}
go_root = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
args.output.mkdir(parents=True, exist_ok=True)
filename = args.output / f"douyin-xhs-collector-v{version}-{args.platform}-{args.arch}.zip"
with tempfile.TemporaryDirectory() as tmp:
    target = Path(tmp) / binary
    subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", str(target), "."],
                   cwd=project / "updater", check=True,
                   env={**os.environ, "GOOS": args.platform, "GOARCH": args.arch, "CGO_ENABLED": "0"})
    with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.write(target, binary)
        package.write(go_root / "LICENSE", "licenses/Go-LICENSE.txt")
        go_modules = go_root / "src/vendor/golang.org/x"
        for license_file in sorted(go_modules.glob("*/LICENSE")):
            package.write(license_file, f"licenses/golang-x-{license_file.parent.name}-LICENSE.txt")
        script_name, script = scripts[args.platform]
        launcher = Path(tmp) / script_name
        launcher.write_bytes(script.encode("utf-8"))
        launcher.chmod(0o755)
        package.write(launcher, script_name)
        tracked = subprocess.check_output(["git", "ls-files", "--cached", "-z", "--", "插件"], cwd=project)
        for raw in sorted(filter(None, tracked.split(b"\0"))):
            path = project / os.fsdecode(raw)
            if path.is_symlink(): raise ValueError(f"unexpected symlink: {path.name}")
            if path.is_file(): package.write(path, path.relative_to(project))
        for doc in ("LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "安装与使用.md"):
            package.write(project / doc, doc)
print(filename)
