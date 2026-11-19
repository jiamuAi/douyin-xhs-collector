"""Build one self-contained collector folder. Maintainers need Python 3, Git and Go."""
import argparse
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
parser = argparse.ArgumentParser()
parser.add_argument("platform", choices=["darwin", "windows", "linux"])
parser.add_argument("arch", choices=["arm64", "amd64"])
parser.add_argument("output", type=Path)
args = parser.parse_args()
version = json.loads((plugin / "manifest.json").read_text(encoding="utf-8"))["version"]
binary = "collector-updater" + (".exe" if args.platform == "windows" else "")
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
go_root = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
args.output.mkdir(parents=True, exist_ok=True)
filename = args.output / f"douyin-xhs-collector-v{version}-{args.platform}-{args.arch}.zip"
with tempfile.TemporaryDirectory() as tmp:
    target = Path(tmp) / binary
    subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", str(target), "."],
                   cwd=source, check=True,
                   env={**os.environ, "GOOS": args.platform, "GOARCH": args.arch, "CGO_ENABLED": "0"})
    with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.write(target, f"{components}/{binary}")
        package.write(go_root / "LICENSE", f"{product}/说明/licenses/Go-LICENSE.txt")
        for license_file in sorted((go_root / "src/vendor/golang.org/x").glob("*/LICENSE")):
            package.write(license_file, f"{product}/说明/licenses/golang-x-{license_file.parent.name}-LICENSE.txt")
        script_name, script = scripts[args.platform]
        launcher = Path(tmp) / script_name
        launcher.write_bytes(script.encode("utf-8"))
        launcher.chmod(0o755)
        package.write(launcher, f"{product}/{script_name}")
        tracked = subprocess.check_output(["git", "ls-files", "--cached", "-z", "--", "插件", ":(exclude)插件/组件/**"], cwd=project)
        for raw in sorted(filter(None, tracked.split(b"\0"))):
            path = project / os.fsdecode(raw)
            if path.is_symlink():
                raise ValueError(f"unexpected symlink: {path.name}")
            package.write(path, f"{product}/{path.relative_to(plugin).as_posix()}")
        for doc in ("LICENSE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "安装与使用.md"):
            package.write(project / doc, f"{product}/说明/{doc}")
print(filename)
