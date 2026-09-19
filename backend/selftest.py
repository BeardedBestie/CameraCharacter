#!/usr/bin/env python3
"""
Self-test for the Python pose provider. Verifies, without a camera:

  1. the .task model downloads (or is already cached) into --model-dir,
  2. a PoseLandmarker is created in VIDEO running mode,
  3. detect_for_video runs on a numpy frame (a blank frame: expect no pose),
  4. the PoseFrame v2 encoder produces schema-valid JSON for both the
     "no subject" case and a 33-landmark result, using the validator shared
     with stream_pose.py, and backend/example_frame.json validates too.

    python3 backend/selftest.py [--model lite|full|heavy] [--model-dir DIR]

Exit status 0 on success, 1 on the first failure (the error is printed verbatim).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from typing import Any, Callable

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import stream_pose as sp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def run_step(name: str, fn: Callable[[], None]) -> bool:
    """Run one step, print its outcome with the error verbatim, and return whether it passed."""
    print(f"--- {name}")
    t0 = time.monotonic()
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - every failure is reported, the run continues
        dt = time.monotonic() - t0
        print(f"    FAILED ({dt:.2f}s): {exc!r}")
        traceback.print_exc()
        return False
    print(f"    ok ({time.monotonic() - t0:.2f}s)")
    return True


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def fake_result(count: int = sp.POSE_LANDMARK_COUNT) -> Any:
    """A PoseLandmarkerResult-shaped object with deterministic dummy landmarks."""
    from mediapipe.tasks.python.components.containers.landmark import Landmark, NormalizedLandmark
    from mediapipe.tasks.python.vision.pose_landmarker import PoseLandmarkerResult

    image = [NormalizedLandmark(x=0.5 + i * 0.001, y=0.25 + i * 0.01, z=-0.1 * (i % 3), visibility=1.0 - i / 64, presence=0.9)
             for i in range(count)]
    world = [Landmark(x=(i - 16) * 0.02, y=-0.6 + i * 0.03, z=0.05 * ((i % 5) - 2), visibility=1.0 - i / 64, presence=0.9)
             for i in range(count)]
    return PoseLandmarkerResult(pose_landmarks=[image], pose_world_landmarks=[world], segmentation_masks=None)


def run(model: str, model_dir: str, log: Callable[[str], None] = print) -> int:
    failures = 0

    def step(name: str, fn: Callable[[], None]) -> None:
        nonlocal failures
        if not run_step(name, fn):
            failures += 1

    model_file: dict[str, str] = {}

    def download() -> None:
        path = sp.ensure_model(model, model_dir, log)
        check(os.path.isfile(path) and os.path.getsize(path) > 0, f"model file missing or empty: {path}")
        model_file["path"] = path
        # Second call must hit the cache (no network, same path).
        again = sp.ensure_model(model, model_dir, lambda _msg: (_ for _ in ()).throw(AssertionError("unexpected download")))
        check(again == path, "cached model path differs")
        log(f"    model: {path} ({os.path.getsize(path) / 1e6:.1f} MB, cached)")

    landmarker: dict[str, Any] = {}

    def create() -> None:
        from mediapipe.tasks.python import vision

        lm = sp.create_landmarker(model_file["path"])
        check(isinstance(lm, vision.PoseLandmarker), "create_landmarker did not return a PoseLandmarker")
        landmarker["lm"] = lm

    blank_frame: dict[str, Any] = {}

    def detect_blank() -> None:
        rgb = np.zeros((480, 640, 3), dtype=np.uint8)
        result = sp.detect(landmarker["lm"], rgb, 1)
        check(hasattr(result, "pose_landmarks") and hasattr(result, "pose_world_landmarks"), "unexpected result type")
        check(len(result.pose_landmarks) == 0, f"expected no pose on a blank frame, got {len(result.pose_landmarks)}")
        # Timestamps must strictly increase; a second call with a larger stamp must also work.
        result2 = sp.detect(landmarker["lm"], rgb, 34)
        check(len(result2.pose_landmarks) == 0, "expected no pose on the second blank frame")
        frame = sp.encode_frame(34, (640, 480), result2)
        check(frame["pose"] is None, "blank frame must encode as pose: null")
        blank_frame["frame"] = frame

    def encode_null() -> None:
        frame = blank_frame["frame"]
        errors = sp.validate_pose_frame(frame)
        check(not errors, f"null-pose frame invalid: {errors}")
        text = sp.frame_to_json(frame)
        check(json.loads(text) == frame, "JSON round-trip changed the null-pose frame")
        check(frame["src"] == "python-opencv" and frame["v"] == 2 and frame["size"] == [640, 480], "frame header wrong")
        log(f"    {text}")

    def encode_landmarks() -> None:
        frame = sp.encode_frame(1234.56789, (1280, 720), fake_result())
        errors = sp.validate_pose_frame(frame)
        check(not errors, f"33-landmark frame invalid: {errors}")
        check(frame["t"] == 1234.56789, "timestamp rounding changed a 5-decimal value")
        check(len(frame["pose"]["world"]) == 33 and len(frame["pose"]["image"]) == 33, "landmark counts wrong")
        check(all(len(lm) == 4 for lm in frame["pose"]["world"] + frame["pose"]["image"]), "landmark tuples must have 4 numbers")
        check(frame["pose"]["image"][0] == [0.5, 0.25, 0.0, 1.0], f"first image landmark encoded wrong: {frame['pose']['image'][0]}")
        check(all(0.0 <= lm[3] <= 1.0 for lm in frame["pose"]["world"]), "visibility not clamped")
        text = sp.frame_to_json(frame)
        decoded = json.loads(text)
        check(decoded == frame, "JSON round-trip changed the landmark frame")
        check(not sp.validate_pose_frame(decoded), "decoded frame invalid")
        check(len(text) < 6000, f"message unexpectedly large: {len(text)} bytes")
        log(f"    message size {len(text)} bytes")

    def validator_rejects() -> None:
        good = sp.encode_frame(1, (2, 2), fake_result())
        bad_cases = {
            "wrong version": {**good, "v": 1},
            "missing pose": {k: v for k, v in good.items() if k != "pose"},
            "short world": {**good, "pose": {"world": good["pose"]["world"][:32], "image": good["pose"]["image"]}},
            "bad tuple": {**good, "pose": {"world": [[0, 0, 0]] * 33, "image": good["pose"]["image"]}},
            "vis out of range": {**good, "pose": {"world": [[0, 0, 0, 2]] * 33, "image": good["pose"]["image"]}},
            "nan t": {**good, "t": float("nan")},
            "not an object": [good],
        }
        for name, case in bad_cases.items():
            check(bool(sp.validate_pose_frame(case)), f"validator accepted invalid frame: {name}")
        with_extras = {**good, "hands": None, "face": None}
        check(not sp.validate_pose_frame(with_extras), "validator rejected null hands/face")

    def example_file() -> None:
        path = os.path.join(HERE, "example_frame.json")
        with open(path, "r", encoding="utf-8") as f:
            example = json.load(f)
        errors = sp.validate_pose_frame(example)
        check(not errors, f"example_frame.json invalid: {errors}")
        check(example["src"] == "python-opencv" and example["pose"] is not None, "example_frame.json should carry a pose")

    step("model download / cache", download)
    if "path" in model_file:
        step("create PoseLandmarker (VIDEO mode)", create)
    if "lm" in landmarker:
        step("detect_for_video on a blank numpy frame", detect_blank)
        if "frame" in blank_frame:
            step("encode + validate null-pose frame", encode_null)
    step("encode + validate 33-landmark frame", encode_landmarks)
    step("validator rejects malformed frames", validator_rejects)
    step("example_frame.json validates", example_file)

    if "lm" in landmarker:
        landmarker["lm"].close()

    if failures:
        print(f"\nSELFTEST FAILED: {failures} step(s) failed")
        return 1
    print("\nSELFTEST OK")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Self-test for backend/stream_pose.py")
    p.add_argument("--model", choices=sp.MODEL_VARIANTS, default="lite", help="model variant to download and load (default lite)")
    p.add_argument("--model-dir", default=sp.DEFAULT_MODEL_DIR)
    args = p.parse_args()
    return run(args.model, args.model_dir)


if __name__ == "__main__":
    sys.exit(main())
