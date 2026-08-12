from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_release.py"
SPEC = importlib.util.spec_from_file_location("build_release", SCRIPT)
assert SPEC and SPEC.loader
build_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_release)


class BuildReleaseTests(unittest.TestCase):
    def test_clean_release_uses_head_blob_not_worktree_line_endings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            extension = repo / "extension"
            extension.mkdir()
            sample = extension / "sample.txt"

            self.run_git(repo, "init", "--quiet")
            self.run_git(repo, "config", "user.name", "AniReko Tests")
            self.run_git(repo, "config", "user.email", "tests@anireko.invalid")
            self.run_git(repo, "config", "core.autocrlf", "false")
            sample.write_bytes(b"line one\nline two\n")
            self.run_git(repo, "add", "extension/sample.txt")
            self.run_git(repo, "commit", "--quiet", "-m", "fixture")

            self.run_git(repo, "config", "core.autocrlf", "true")
            sample.unlink()
            self.run_git(repo, "checkout", "--", "extension/sample.txt")

            self.assertTrue(build_release.git_clean(repo))
            self.assertEqual(b"line one\r\nline two\r\n", sample.read_bytes())
            self.assertEqual(
                b"line one\nline two\n",
                build_release.release_source_bytes(repo, extension, "sample.txt", False),
            )
            self.assertEqual(
                b"line one\r\nline two\r\n",
                build_release.release_source_bytes(repo, extension, "sample.txt", True),
            )

    @staticmethod
    def run_git(repo: Path, *arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=repo,
            capture_output=True,
            check=True,
        )


if __name__ == "__main__":
    unittest.main()
