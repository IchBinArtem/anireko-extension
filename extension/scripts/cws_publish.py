#!/usr/bin/env python3
"""Upload a verified extension ZIP and submit it through Chrome Web Store API v2."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable
import urllib.error
import urllib.request
import zipfile


API_ROOT = "https://chromewebstore.googleapis.com"
CHROME_WEB_STORE_SCOPE = "https://www.googleapis.com/auth/chromewebstore"
IN_PROGRESS_STATES = {"IN_PROGRESS", "UPLOAD_IN_PROGRESS"}
SUCCESS_STATES = {"SUCCEEDED", "UPLOAD_SUCCEEDED"}
FAILURE_STATES = {"FAILED", "UPLOAD_FAILED", "NOT_FOUND"}
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
VERSION_PATTERN = re.compile(r"^\d+(?:\.\d+){0,3}$")


class CwsError(RuntimeError):
    """A safe, user-facing Chrome Web Store release error."""


def _safe_api_error(payload: bytes, status_code: int, token: str) -> str:
    message = ""
    try:
        decoded = json.loads(payload.decode("utf-8"))
        error = decoded.get("error", {}) if isinstance(decoded, dict) else {}
        if isinstance(error, dict):
            api_status = str(error.get("status") or "").strip()
            api_message = str(error.get("message") or "").strip()
            message = ": ".join(part for part in (api_status, api_message) if part)
    except (UnicodeDecodeError, json.JSONDecodeError):
        message = ""
    if not message:
        message = "request rejected"
    if token:
        message = message.replace(token, "[REDACTED]")
    return f"Chrome Web Store API HTTP {status_code}: {message[:1500]}"


def request_json(
    method: str,
    url: str,
    token: str,
    *,
    body: bytes | None = None,
    content_type: str | None = None,
    timeout_seconds: float = 60,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "anireko-extension-release/1",
    }
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        payload = error.read()
        raise CwsError(_safe_api_error(payload, error.code, token)) from error
    except urllib.error.URLError as error:
        raise CwsError(f"Chrome Web Store API transport error: {error.reason}") from error
    try:
        decoded = json.loads(payload.decode("utf-8")) if payload else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CwsError("Chrome Web Store API returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise CwsError("Chrome Web Store API returned a non-object response")
    return decoded


def item_name(publisher_id: str, extension_id: str) -> str:
    for label, value in (("publisher ID", publisher_id), ("extension ID", extension_id)):
        if not IDENTIFIER_PATTERN.fullmatch(value):
            raise CwsError(f"invalid {label}")
    return f"publishers/{publisher_id}/items/{extension_id}"


def package_version(package: Path) -> str:
    if not package.is_file():
        raise CwsError(f"release package does not exist: {package}")
    try:
        with zipfile.ZipFile(package) as archive:
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    except (KeyError, OSError, UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise CwsError("release package has no valid root manifest.json") from error
    version = manifest.get("version") if isinstance(manifest, dict) else None
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise CwsError("release package contains an invalid manifest version")
    return version


def fetch_status(name: str, token: str) -> dict[str, Any]:
    return request_json("GET", f"{API_ROOT}/v2/{name}:fetchStatus", token)


def _revision_versions(status: dict[str, Any], field: str) -> set[str]:
    revision = status.get(field)
    if not isinstance(revision, dict):
        return set()
    channels = revision.get("distributionChannels")
    if not isinstance(channels, list):
        return set()
    return {
        channel["crxVersion"]
        for channel in channels
        if isinstance(channel, dict) and isinstance(channel.get("crxVersion"), str)
    }


def _assert_safe_store_status(status: dict[str, Any]) -> None:
    if status.get("takenDown") is True:
        raise CwsError("Chrome Web Store item is taken down")
    if status.get("warned") is True:
        raise CwsError("Chrome Web Store item has an unresolved policy warning")


def run_release(
    *,
    token: str,
    publisher_id: str,
    extension_id: str,
    package: Path | None,
    expected_version: str | None,
    check_only: bool,
    poll_seconds: float,
    timeout_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    if not token:
        raise CwsError("CWS_ACCESS_TOKEN is empty")
    name = item_name(publisher_id, extension_id)
    initial_status = fetch_status(name, token)
    _assert_safe_store_status(initial_status)
    if check_only:
        print("Chrome Web Store access verified; no package was uploaded")
        return
    if package is None or expected_version is None:
        raise CwsError("package and expected version are required for publishing")
    if not VERSION_PATTERN.fullmatch(expected_version):
        raise CwsError("expected version is invalid")
    actual_version = package_version(package)
    if actual_version != expected_version:
        raise CwsError(
            f"tag/package version mismatch: expected {expected_version}, package has {actual_version}"
        )

    published_versions = _revision_versions(initial_status, "publishedItemRevisionStatus")
    submitted_versions = _revision_versions(initial_status, "submittedItemRevisionStatus")
    if expected_version in published_versions:
        print(f"Chrome Web Store already publishes version {expected_version}; nothing to do")
        return
    if expected_version in submitted_versions:
        print(f"Chrome Web Store already has version {expected_version} submitted; nothing to do")
        return

    upload = request_json(
        "POST",
        f"{API_ROOT}/upload/v2/{name}:upload",
        token,
        body=package.read_bytes(),
        content_type="application/zip",
        timeout_seconds=max(timeout_seconds, 60),
    )
    if upload.get("itemId") not in (None, extension_id):
        raise CwsError("Chrome Web Store upload response references another item")
    returned_version = upload.get("crxVersion")
    if returned_version not in (None, expected_version):
        raise CwsError("Chrome Web Store upload response references another version")
    upload_state = str(upload.get("uploadState") or "")

    if upload_state in IN_PROGRESS_STATES:
        deadline = monotonic() + timeout_seconds
        while monotonic() < deadline:
            sleep(poll_seconds)
            status = fetch_status(name, token)
            _assert_safe_store_status(status)
            upload_state = str(status.get("lastAsyncUploadState") or "")
            if upload_state in SUCCESS_STATES:
                break
            if upload_state in FAILURE_STATES:
                raise CwsError(f"Chrome Web Store package processing failed: {upload_state}")
        else:
            raise CwsError("Chrome Web Store package processing timed out")
    elif upload_state not in SUCCESS_STATES:
        raise CwsError(f"unexpected Chrome Web Store upload state: {upload_state or 'missing'}")

    publish_body = json.dumps(
        {
            "publishType": "DEFAULT_PUBLISH",
            "skipReview": False,
            "blockOnWarnings": True,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    submission = request_json(
        "POST",
        f"{API_ROOT}/v2/{name}:publish",
        token,
        body=publish_body,
        content_type="application/json",
    )
    if submission.get("itemId") not in (None, extension_id):
        raise CwsError("Chrome Web Store publish response references another item")
    state = str(submission.get("state") or "UNKNOWN")
    print(f"Chrome Web Store accepted version {expected_version}; submission state: {state}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publisher-id", required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--package", type=Path)
    parser.add_argument("--expected-version")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=10)
    parser.add_argument("--timeout-seconds", type=float, default=600)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        run_release(
            token=os.environ.get("CWS_ACCESS_TOKEN", ""),
            publisher_id=args.publisher_id,
            extension_id=args.extension_id,
            package=args.package,
            expected_version=args.expected_version,
            check_only=args.check_only,
            poll_seconds=args.poll_seconds,
            timeout_seconds=args.timeout_seconds,
        )
    except CwsError as error:
        print(f"release failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
