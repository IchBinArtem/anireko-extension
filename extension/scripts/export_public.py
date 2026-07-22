#!/usr/bin/env python3
"""Bootstrap the client-only public extension source repository.

The HTTP boundary is published as a versioned contract. Server implementations,
PHP, SQL, schema, storage, and server-side guards are never exported.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    extension = Path(__file__).resolve().parents[1]
    repo = extension.parent
    target = args.target.resolve()
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"target_not_empty: {target}")
    target.mkdir(parents=True, exist_ok=True)
    files = [line.strip() for line in (extension / "public-files.txt").read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    for name in files:
        source = repo / name
        if not source.is_file():
            raise SystemExit(f"missing_public_file: {name}")
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    shutil.copyfile(extension / "README.md", target / "README.md")
    shutil.copyfile(extension / "LICENSE", target / "LICENSE")
    (target / ".gitignore").write_text(
        "dist/\nnode_modules/\ntest-results/\nplaywright-report/\n__pycache__/\n*.pyc\n",
        encoding="utf-8",
    )
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
