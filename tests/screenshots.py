#!/usr/bin/env python3
"""Capture the replayed terminal grids, never the user's browser profile."""
import json
import pathlib
import subprocess
import tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
SELECTED = {"typical-background-120x36", "uncommitted-background-120x36", "branch-comparison-120x36", "grounded-map-120x36", "point-detail-120x36", "point-overview-return-120x36", "closed-draft-main-120x36", "closed-draft-learner-120x36", "japanese-focused-120x36", "narrow-focus-fallback-80x24", "wide-focused-160x48", "native-failure-cleanup-160x48", "ai-target-confirm-visible-160x48", "ai-target-cancel-restored-160x48", "ai-target-changed-160x48",
            # Model-ownership traversal, optional questions, hypotheses and independent scrolling.
            "model-empty-120x36", "model-overview-120x36", "model-tab-120x36", "model-claim-120x36", "model-evidence-120x36", "model-back-claim-120x36", "model-skip-120x36", "model-ctrl-o-120x36", "proposal-120x36", "quiet-120x36", "claim-question-120x36",
            "long-latest-120x36", "long-pgup-120x36", "long-wheel-chat-120x36", "long-top-120x36", "reading-while-streaming-120x36", "stream-followed-120x36", "alts-main-120x36", "alts-learner-120x36",
            "narrow-model-wheel-80x24", "narrow-chat-wheel-80x24", "narrow-claim-80x24", "narrow-claim-reveal-80x24", "narrow-evidence-80x24", "wide-claim-160x48", "wide-evidence-160x48", "wide-chat-wheel-160x48",
            # Long-claim keyboard reading: top, middle-only and end frames, controls after the detail, Shift paging.
            "long-claim-overview-80x24", "long-claim-plain-00-80x24", "long-claim-plain-06-80x24", "long-claim-plain-16-80x24", "long-claim-plain-top-80x24",
            "long-claim-controls-08-80x24", "long-claim-controls-18-80x24", "long-claim-controls-evidence-80x24", "long-claim-controls-back-80x24", "long-claim-controls-skipped-80x24",
            "long-claim-page-05-80x24", "long-claim-middle-120x36"}
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
