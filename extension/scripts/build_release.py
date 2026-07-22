#!/usr/bin/env python3
"""Build a byte-reproducible Chrome extension ZIP and integrity metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

FIXED_TIME = (2020, 1, 1, 0, 0, 0)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_clean(repo: Path) -> bool:
    result = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=repo, capture_output=True, text=True, check=True,
    )
    return not result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="Expected release tag, e.g. v0.2.4")
    parser.add_argument("--allow-dirty", action="store_true", help="Local development only")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    extension = Path(__file__).resolve().parents[1]
    repo = extension.parent
    manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    expected_tag = f"v{version}"
    if args.tag and args.tag != expected_tag:
        raise SystemExit(f"tag_manifest_mismatch: {args.tag} != {expected_tag}")
    if not args.allow_dirty and not git_clean(repo):
        raise SystemExit("dirty_or_untracked_release: commit the clean source before building")

    files = [line.strip() for line in (extension / "release-files.txt").read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if files != sorted(set(files), key=files.index):
        raise SystemExit("release-files.txt contains duplicates")
    missing = [name for name in files if not (extension / name).is_file()]
    if missing:
        raise SystemExit(f"missing release files: {missing}")

    output = (args.output or (repo / "dist")).resolve()
    output.mkdir(parents=True, exist_ok=True)
    zip_path = output / f"anireko-extension-{version}.zip"
    file_manifest = []
    # STORE (no deflate) avoids zlib-version drift across Windows/Linux runners.
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in files:
            data = (extension / name).read_bytes()
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_STORED)
            file_manifest.append({
                "path": name,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })

    archive_hash = sha256(zip_path)
    metadata = {
        "name": "anireko-extension",
        "version": version,
        "tag": expected_tag,
        "license": "MIT",
        "runtimeDependencies": [],
        "files": file_manifest,
        "archive": {"path": zip_path.name, "sha256": archive_hash},
    }
    (output / "FILE-MANIFEST.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output / "SBOM.json").write_text(json.dumps({
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {"component": {"type": "application", "name": "anireko-extension", "version": version}},
        "components": [],
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output / "SHA256SUMS").write_text(f"{archive_hash}  {zip_path.name}\n", encoding="ascii")
    print(f"{zip_path} {archive_hash}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
