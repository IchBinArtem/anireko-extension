from __future__ import annotations

from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "extension-release.yml"
DEPENDABOT = Path(__file__).resolve().parents[2] / ".github" / "dependabot.yml"


def job_block(workflow: str, name: str) -> str:
    match = re.search(
        rf"^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z0-9-]+:\n|\Z)",
        workflow,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"missing workflow job: {name}")
    return match.group("body")


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_default_and_verification_permissions_are_read_only(self) -> None:
        header = self.workflow.split("jobs:", maxsplit=1)[0]
        self.assertIn("permissions:\n  contents: read", header)
        self.assertNotIn("id-token:", header)
        self.assertNotIn("attestations:", header)

        build = job_block(self.workflow, "verify-build")
        self.assertIn("permissions:\n      contents: read", build)
        self.assertNotIn("id-token:", build)
        self.assertNotIn("attestations:", build)
        self.assertNotIn("gh release create", build)
        self.assertNotIn("attest-build-provenance", build)

    def test_release_mutation_is_isolated_to_pushed_tags(self) -> None:
        release = job_block(self.workflow, "publish-github-release")
        self.assertIn(
            "if: github.event_name == 'push' && github.ref_type == 'tag' "
            "&& startsWith(github.ref, 'refs/tags/v')",
            release,
        )
        self.assertIn("needs: verify-build", release)
        self.assertIn("contents: write", release)
        self.assertIn("id-token: write", release)
        self.assertIn("attestations: write", release)
        self.assertIn("attest-build-provenance", release)
        self.assertIn("gh release create", release)
        self.assertNotIn("actions/checkout", release)
        self.assertIn("GH_REPO: ${{ github.repository }}", release)
        self.assertIn('--repo "$GH_REPO"', release)

    def test_chrome_web_store_jobs_have_no_repository_write_access(self) -> None:
        for name in ("verify-chrome-web-store-access", "publish-chrome-web-store"):
            with self.subTest(job=name):
                block = job_block(self.workflow, name)
                self.assertIn("contents: read", block)
                self.assertIn("id-token: write", block)
                self.assertNotIn("contents: write", block)
                self.assertNotIn("attestations:", block)

    def test_dispatch_is_wired_to_check_only(self) -> None:
        access = job_block(self.workflow, "verify-chrome-web-store-access")
        self.assertIn("--check-only", access)
        self.assertNotIn("--package", access)

    def test_store_upload_verifies_downloaded_checksums_first(self) -> None:
        publish = job_block(self.workflow, "publish-chrome-web-store")
        checksum = publish.index("sha256sum --check SHA256SUMS")
        upload = publish.index("--package")
        self.assertLess(checksum, upload)

    def test_untrusted_tag_value_enters_shell_only_through_environment(self) -> None:
        for name in ("verify-build", "publish-github-release", "publish-chrome-web-store"):
            with self.subTest(job=name):
                block = job_block(self.workflow, name)
                self.assertIn("RELEASE_TAG: ${{ github.ref_name }}", block)
                self.assertNotIn("${GITHUB_REF_NAME", block)

    def test_every_action_is_pinned_and_node_24_compatible(self) -> None:
        minimum_majors = {
            "actions/checkout": 7,
            "actions/setup-node": 7,
            "actions/setup-python": 7,
            "actions/upload-artifact": 7,
            "actions/download-artifact": 8,
            "actions/attest-build-provenance": 4,
            "google-github-actions/auth": 3,
        }
        uses = re.findall(
            r"^\s*- uses: ([^@\s]+)@([^\s]+)(?:\s+#\s+v(\d+)(?:\.\d+\.\d+)?)?$",
            self.workflow,
            flags=re.MULTILINE,
        )
        self.assertGreater(len(uses), 0)
        for action, revision, major in uses:
            with self.subTest(action=action):
                self.assertRegex(revision, r"^[0-9a-f]{40}$")
                self.assertIn(action, minimum_majors)
                self.assertTrue(major, "pinned action must retain a readable version comment")
                self.assertGreaterEqual(int(major), minimum_majors[action])

    def test_python_release_tests_run_in_ci(self) -> None:
        build = job_block(self.workflow, "verify-build")
        self.assertIn(
            'python -m unittest discover -s extension/tests -p "test_*.py"',
            build,
        )

    def test_every_pull_request_reports_the_required_check(self) -> None:
        pull_request = self.workflow.split("  push:", maxsplit=1)[0]
        self.assertIn("  pull_request:\n", pull_request)
        self.assertNotIn("paths:", pull_request)

        build = job_block(self.workflow, "verify-build")
        self.assertIn("    name: verify-build", build)

    def test_dependabot_covers_actions_and_e2e_npm_dependencies(self) -> None:
        dependabot = DEPENDABOT.read_text(encoding="utf-8")
        self.assertIn("package-ecosystem: github-actions", dependabot)
        self.assertIn("package-ecosystem: npm", dependabot)
        self.assertIn("directory: /tests/e2e", dependabot)


if __name__ == "__main__":
    unittest.main()
