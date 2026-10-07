#!/usr/bin/env python3
"""Capture the replayed terminal grids, never the user's browser profile."""
import json
import pathlib
import subprocess
import tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
SELECTED = {"typical-background-120x36", "uncommitted-background-120x36", "branch-comparison-120x36", "grounded-map-120x36", "point-detail-120x36", "point-overview-return-120x36", "closed-draft-main-120x36", "closed-draft-learner-120x36", "japanese-focused-120x36", "narrow-focus-fallback-80x24", "wide-focused-160x48", "native-failure-cleanup-160x48", "ai-target-confirm-visible-160x48", "ai-target-cancel-restored-160x48", "ai-target-changed-160x48"}
for name in ["native-qa", "native-qa-regular"]:
    directory = ROOT / ".evidence" / name
    screenshots = []
    with tempfile.TemporaryDirectory(prefix="pi-understanding-firefox-") as profile:
        for stage in json.loads((directory / "stages.json").read_text()):
            if stage["name"] not in SELECTED and not stage["name"].startswith(("shortcut-", "command-focus-", "wide-first-")):
                continue
            output = directory / (stage["name"] + ".png")
            subprocess.run(["firefox", "--headless", "--no-remote", "--profile", profile, "--window-size", f'{stage["cols"] * 10},{stage["rows"] * 20}', "--screenshot", str(output), (directory / (stage["name"] + ".html")).as_uri()], check=True, timeout=40, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            assert output.exists() and output.stat().st_size > 0
            screenshots.append(str(output))
    summary = json.loads((directory / "summary.json").read_text())
    summary["screenshots"] = screenshots
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"{name}: {len(screenshots)} rendered PNGs")
