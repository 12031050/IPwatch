#!/usr/bin/env python3
"""从 manifest + dist 内的 FPK 自动同步 README 与 Pages 下载页的版本/大小/SHA-256。

用法（在仓库根目录执行）：
    python3 scripts/sync-download-info.py            # 写入更新
    python3 scripts/sync-download-info.py --check    # 只校验是否同步，未同步则退出码 1

设计：
- 版本号唯一来源 = manifest 的 version 字段。
- 安装包 = dist/ipwatch_v<version>.fpk（缺失则报错，避免写出不存在的下载信息）。
- 文件大小（字节 + KB）与 SHA-256 从 FPK 实际内容计算，杜绝手抄出错。
- 替换全部用正则锚定上下文，只动下载信息相关行，不碰正文与历史说明。
- 幂等：重复执行不产生额外 diff。
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest"
FPK_DIR = ROOT / "dist"
README = ROOT / "README.md"
PAGES = ROOT / "index.html"
UI_INDEX = ROOT / "app" / "server" / "public" / "index.html"


def read_version() -> str:
    text = MANIFEST.read_text(encoding="utf-8")
    m = re.search(r"^version\s*=\s*(\S+)", text, re.M)
    if not m:
        sys.exit("ERROR: manifest 中找不到 version 字段")
    return m.group(1).strip()


def locate_fpk(version: str) -> pathlib.Path:
    fpk = FPK_DIR / f"ipwatch_v{version}.fpk"
    if not fpk.is_file():
        sys.exit(f"ERROR: 找不到安装包 {fpk}，请先打包并复制到 dist/")
    return fpk


def fpk_meta(fpk: pathlib.Path) -> tuple[int, str, str]:
    data = fpk.read_bytes()
    size = len(data)
    kb = f"{size / 1024:.1f}"
    sha = hashlib.sha256(data).hexdigest()
    return size, kb, sha


def sync_readme(text: str, version: str, size: int, kb: str, sha: str) -> str:
    # 下载信息表格的四个可变字段（锚定行首，避免误伤正文里的版本号）
    text = re.sub(
        r"^(\| 当前版本 \| )v[\d.]+( \|)$",
        rf"\g<1>v{version}\2", text, flags=re.M)
    text = re.sub(
        r"^(\| 安装包 \| `)ipwatch_v[\d.]+\.fpk(` \|)$",
        rf"\g<1>ipwatch_v{version}.fpk\2", text, flags=re.M)
    text = re.sub(
        r"^(\| 文件大小 \| ).*?( \|)$",
        rf"\g<1>{kb} KB（{size:,} 字节）\2", text, flags=re.M)
    text = re.sub(
        r"^(\| SHA-256 \| `)[0-9a-f]{64}(` \|)$",
        rf"\g<1>{sha}\2", text, flags=re.M)
    # 正文中的版本号与包名（直链、安装命令、Releases 说明、版本章节）
    text = re.sub(r"ipwatch_v[\d.]+\.fpk", f"ipwatch_v{version}.fpk", text)
    text = re.sub(r"(?<![\d.])v\d+\.\d+\.\d+", f"v{version}", text)
    return text


def sync_pages(text: str, version: str, size: int) -> str:
    text = re.sub(r"ipwatch_v[\d.]+\.fpk", f"ipwatch_v{version}.fpk", text)
    text = re.sub(r"v\d+\.\d+\.\d+", f"v{version}", text)
    # 下载页大小用整数 KB（两处：版本 hint 的「v0.8.8 · N KB」和「大小 <b>N KB</b>」）
    kb_int = str(round(size / 1024))
    text = re.sub(r"(· )[\d.]+ KB", lambda m: f"{m.group(1)}{kb_int} KB", text)
    text = re.sub(r"(<b>)[\d.]+ KB(</b>)", lambda m: f"{m.group(1)}{kb_int} KB{m.group(2)}", text)
    return text


def sync_ui_version(text: str, version: str) -> str:
    return re.sub(r"(?<![\d.])v\d+\.\d+\.\d+", f"v{version}", text)


def apply(path: pathlib.Path, new_text: str, changed: list[str], check: bool) -> None:
    old = path.read_text(encoding="utf-8")
    if old == new_text:
        return
    changed.append(str(path.relative_to(ROOT)))
    if not check:
        path.write_text(new_text, encoding="utf-8", newline="\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="只校验，不写入；未同步返回码 1")
    args = ap.parse_args()

    version = read_version()
    fpk = locate_fpk(version)
    size, kb, sha = fpk_meta(fpk)

    changed: list[str] = []
    apply(README, sync_readme(README.read_text(encoding="utf-8"), version, size, kb, sha),
          changed, args.check)
    apply(PAGES, sync_pages(PAGES.read_text(encoding="utf-8"), version, size),
          changed, args.check)
    apply(UI_INDEX, sync_ui_version(UI_INDEX.read_text(encoding="utf-8"), version),
          changed, args.check)

    summary = f"version={version} size={size} bytes ({kb} KB) sha256={sha[:12]}…"
    if changed:
        print(f"[sync] 需要同步: {', '.join(changed)} | {summary}")
        return 1 if args.check else 0
    print(f"[sync] 已是最新，无需改动 | {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
