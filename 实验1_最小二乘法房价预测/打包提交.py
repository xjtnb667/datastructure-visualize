# -*- coding: utf-8 -*-
"""
打包提交文件：生成 学号_姓名_实验1.zip
================================================================
提交要求：压缩包内含源代码和实验报告。

用法（在项目根目录下）：
    python 打包提交.py                 # 用默认文件名 学号_姓名_实验1.zip
    python 打包提交.py 20230001_张三   # 用真实学号姓名命名

注意：本脚本故意不给源码打乱码，包里同时放 UTF-8 文本与生成好的 docx/pdf，
所以中文在 Windows 记事本、Word 里都能正常显示。
"""

import sys
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent          # 实验根目录
DEFAULT_STEM = "学号_姓名_实验1"

# 打进包里的内容（相对实验根目录的路径，支持文件与目录）
INCLUDE = [
    "code",
    "results",
    "report",
    "README.md",
]

# 不打的文件类型（临时文件、编译缓存等）
EXCLUDE_SUFFIX = {".pyc", ".pyo", ".tmp", ".log"}
EXCLUDE_DIRS = {"__pycache__", ".ipynb_checkpoints", ".pytest_cache"}


def collect(root: Path):
    files = []
    for item in INCLUDE:
        p = root / item
        if not p.exists():
            print(f"  [跳过] 不存在：{item}")
            continue
        if p.is_file():
            files.append(p)
            continue
        for f in sorted(p.rglob("*")):
            if not f.is_file():
                continue
            if f.suffix.lower() in EXCLUDE_SUFFIX:
                continue
            if any(part in EXCLUDE_DIRS for part in f.parts):
                continue
            files.append(f)
    return files


def main():
    stem = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_STEM
    zip_path = BASE / f"{stem}.zip"

    files = collect(BASE)
    if not files:
        print("没有找到要打包的文件，请检查目录结构。")
        return 1

    print(f"准备打包 {len(files)} 个文件 -> {zip_path.name}")
    total = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in files:
            arc = f.relative_to(BASE).as_posix()
            z.write(f, arc)
            total += f.stat().st_size
            print(f"  + {arc}  ({f.stat().st_size / 1024:.1f} KB)")

    size = zip_path.stat().st_size
    print(f"\n完成：{zip_path}")
    print(f"  原始大小 {total / 1024 / 1024:.2f} MB -> 压缩后 {size / 1024:.0f} KB")
    print(f"  共 {len(files)} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
