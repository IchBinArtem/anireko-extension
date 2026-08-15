from __future__ import annotations

from io import BytesIO
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cws_publish.py"
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "extension-release.yml"
SPEC = importlib.util.spec_from_file_location("cws_publish", SCRIPT)
assert SPEC and SPEC.loader
cws_publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cws_publish)


PUBLISHER_ID = "3f669473-129b-48f0-942f-5f99d60af803"
EXTENSION_ID = "leojnckhalnjpfcpiabhdcgnnlfppdap"
TOKEN = "test-access-token"


def create_package(directory: Path, version: str = "0.3.12") -> Path:
    package = directory / "extension.zip"
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr("manifest.json", json.dumps({"manifest_version": 3, "version": version}))
    return package


def run_release(package: Path | None, *, check_only: bool = False) -> None:
    cws_publish.run_release(
        token=TOKEN,
        publisher_id=PUBLISHER_ID,
        extension_id=EXTENSION_ID,
        package=package,
        expected_version=None if check_only else "0.3.12",
        check_only=check_only,
        poll_seconds=0,
        timeout_seconds=30,
        sleep=lambda _: None,
    )


class CwsPublishTests(unittest.TestCase):
    def test_release_mutations_require_a_pushed_tag(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        pushed_tag_guard = (
            "if: github.event_name == 'push' && github.ref_type == 'tag' "
            "&& startsWith(github.ref, 'refs/tags/v')"
        )

        self.assertEqual(2, workflow.count(pushed_tag_guard))

    @mock.patch.object(cws_publish, "request_json")
    def test_check_only_never_mutates_store(self, request_json: mock.Mock) -> None:
        request_json.return_value = {"itemId": EXTENSION_ID}

        run_release(None, check_only=True)

        self.assertEqual(1, request_json.call_count)
        self.assertEqual("GET", request_json.call_args.args[0])

    @mock.patch.object(cws_publish, "request_json")
    def test_successful_upload_is_submitted_for_default_publish(self, request_json: mock.Mock) -> None:
        request_json.side_effect = [
            {"itemId": EXTENSION_ID},
            {"itemId": EXTENSION_ID, "crxVersion": "0.3.12", "uploadState": "SUCCEEDED"},
            {"itemId": EXTENSION_ID, "state": "PENDING_REVIEW"},
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            run_release(create_package(Path(temporary_directory)))

        self.assertEqual(["GET", "POST", "POST"], [call.args[0] for call in request_json.call_args_list])
        publish_call = request_json.call_args_list[2]
        self.assertTrue(publish_call.args[1].endswith(":publish"))
        self.assertEqual(
            {
                "publishType": "DEFAULT_PUBLISH",
                "skipReview": False,
                "blockOnWarnings": True,
            },
            json.loads(publish_call.kwargs["body"]),
        )

    @mock.patch.object(cws_publish, "request_json")
    def test_async_upload_is_polled_before_publish(self, request_json: mock.Mock) -> None:
        request_json.side_effect = [
            {"itemId": EXTENSION_ID},
            {"itemId": EXTENSION_ID, "uploadState": "IN_PROGRESS"},
            {"itemId": EXTENSION_ID, "lastAsyncUploadState": "SUCCEEDED"},
            {"itemId": EXTENSION_ID, "state": "PENDING_REVIEW"},
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            run_release(create_package(Path(temporary_directory)))

        self.assertEqual(["GET", "POST", "GET", "POST"], [call.args[0] for call in request_json.call_args_list])

    @mock.patch.object(cws_publish, "request_json")
    def test_existing_submitted_version_is_idempotent(self, request_json: mock.Mock) -> None:
        request_json.return_value = {
            "submittedItemRevisionStatus": {
                "distributionChannels": [{"crxVersion": "0.3.12"}]
            }
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            run_release(create_package(Path(temporary_directory)))

        self.assertEqual(1, request_json.call_count)

    @mock.patch.object(cws_publish, "request_json")
    def test_policy_warning_blocks_upload(self, request_json: mock.Mock) -> None:
        request_json.return_value = {"itemId": EXTENSION_ID, "warned": True}

        with self.assertRaisesRegex(cws_publish.CwsError, "policy warning"):
            run_release(None, check_only=True)

        self.assertEqual(1, request_json.call_count)

    @mock.patch.object(cws_publish, "request_json")
    def test_failed_async_upload_never_publishes(self, request_json: mock.Mock) -> None:
        request_json.side_effect = [
            {"itemId": EXTENSION_ID},
            {"itemId": EXTENSION_ID, "uploadState": "IN_PROGRESS"},
            {"itemId": EXTENSION_ID, "lastAsyncUploadState": "FAILED"},
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaisesRegex(cws_publish.CwsError, "processing failed"):
                run_release(create_package(Path(temporary_directory)))

        self.assertEqual(["GET", "POST", "GET"], [call.args[0] for call in request_json.call_args_list])

    @mock.patch.object(cws_publish, "request_json")
    def test_upload_response_for_another_version_never_publishes(
        self, request_json: mock.Mock
    ) -> None:
        request_json.side_effect = [
            {"itemId": EXTENSION_ID},
            {"itemId": EXTENSION_ID, "crxVersion": "9.9.9", "uploadState": "SUCCEEDED"},
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaisesRegex(cws_publish.CwsError, "another version"):
                run_release(create_package(Path(temporary_directory)))

        self.assertEqual(["GET", "POST"], [call.args[0] for call in request_json.call_args_list])

    @mock.patch.object(cws_publish, "request_json")
    def test_package_version_mismatch_fails_before_upload(self, request_json: mock.Mock) -> None:
        request_json.return_value = {"itemId": EXTENSION_ID}
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = create_package(Path(temporary_directory), "0.3.11")
            with self.assertRaisesRegex(cws_publish.CwsError, "tag/package version mismatch"):
                run_release(package)

        self.assertEqual(1, request_json.call_count)

    @mock.patch("urllib.request.urlopen")
    def test_http_error_never_echoes_access_token(self, urlopen: mock.Mock) -> None:
        urlopen.side_effect = urllib.error.HTTPError(
            "https://example.invalid",
            403,
            "Forbidden",
            {},
            BytesIO(json.dumps({"error": {"status": "DENIED", "message": TOKEN}}).encode()),
        )

        with self.assertRaises(cws_publish.CwsError) as raised:
            cws_publish.request_json("GET", "https://example.invalid", TOKEN)

        self.assertNotIn(TOKEN, str(raised.exception))
        self.assertIn("[REDACTED]", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
