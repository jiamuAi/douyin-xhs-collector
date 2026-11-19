"""Publish a complete GitHub Release for the version in the extension manifest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]
version = json.loads((root / "插件/manifest.json").read_text(encoding="utf-8"))["version"]
tag = f"v{version}"


def version_tuple(value):
    if not re.fullmatch(r"(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){2}", value, re.ASCII):
        return None
    parts = tuple(map(int, value.split(".")))
    return parts if max(parts) <= 65535 else None


def read(*command):
    return subprocess.check_output(command, cwd=root, text=True).strip()


def gh(*args):
    subprocess.run(["gh", *args], cwd=root, check=True)


def releases():
    pages = json.loads(read("gh", "api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100"))
    return [release for page in pages for release in page]


def should_publish(history):
    candidate = version_tuple(version)
    if candidate is None:
        raise ValueError("the manifest must contain a stable three-part version")
    for release in history:
        name = release["tag_name"]
        if release["draft"] or release["prerelease"] or not name.startswith("v"):
            continue
        published = version_tuple(name[1:])
        if published is not None and published >= candidate:
            return False
    return True


def publish(output):
    history = releases()
    if not should_publish(history):
        print(f"{tag} already published or superseded")
        return
    commit = read("git", "rev-parse", "HEAD")
    if commit != os.environ["GITHUB_SHA"]:
        raise ValueError("the checkout differs from the triggering commit")
    remote_ref = "refs/tags/" + tag
    refs = read("git", "ls-remote", "origin", remote_ref, remote_ref+"^{}")
    if refs:
        targets = {}
        for line in refs.splitlines():
            sha, ref = line.split()
            targets[ref] = sha
        if targets.get(remote_ref+"^{}", targets.get(remote_ref)) != commit:
            raise ValueError(f"{tag} already points to a different commit")

    names = ["collector-update.json", f"collector-update-{tag}.zip"]
    names.extend(f"douyin-xhs-collector-{tag}-{platform}-{arch}.zip"
                 for platform in ("darwin", "windows", "linux") for arch in ("arm64", "amd64"))
    files = [output / name for name in names]
    digests = {f.name: "sha256:" + hashlib.sha256(f.read_bytes()).hexdigest() for f in files}
    feed = json.loads(files[0].read_text(encoding="utf-8"))
    if (feed["schema"], feed["version"], feed["asset"], feed["size"], "sha256:"+feed["sha256"]) != (
            1, version, files[1].name, files[1].stat().st_size, digests[files[1].name]):
        raise ValueError("the update feed does not match the versioned archive")

    draft = next((r for r in history if r["tag_name"] == tag), None)
    if draft:
        if not draft["draft"] or draft["target_commitish"] != commit:
            raise ValueError(f"existing release for {tag} is not a draft for this commit")
    else:
        notes = root / ".github" / "release-notes.md"
        gh("release", "create", tag, "--draft", "--target", commit, "--title", tag, "--notes-file", str(notes))
    gh("release", "upload", tag, *(str(f) for f in files), "--clobber")
    history = releases()
    record = next(r for r in history if r["tag_name"] == tag)
    if not record["draft"] or record["target_commitish"] != commit:
        raise ValueError("the release draft changed during upload")
    uploaded = {a["name"]: a.get("digest") for a in record["assets"] if a["state"] == "uploaded"}
    if uploaded != digests:
        raise ValueError("GitHub asset checksums do not match the complete local build")
    if should_publish(history):
        gh("release", "edit", tag, "--draft=false", "--latest")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="mode", required=True)
    commands.add_parser("plan")
    commands.add_parser("publish").add_argument("output", type=Path)
    args = parser.parse_args()
    if args.mode == "plan":
        result = should_publish(releases())
        print(f"{tag}: {'publish' if result else 'skip'}")
        if "GITHUB_OUTPUT" in os.environ:
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as step:
                print(f"publish={str(result).lower()}", file=step)
    else:
        publish(args.output.resolve())
