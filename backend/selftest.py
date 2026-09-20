#!/usr/bin/env python3
"""
Self-test for the Python pose provider. Verifies, without a camera:

  1. the .task model downloads (or is already cached) into --model-dir,
  2. a PoseLandmarker is created in VIDEO running mode,
  3. detect_for_video runs on a numpy frame (a blank frame: expect no pose),
  4. the PoseFrame v2 encoder produces schema-valid JSON for both the
     "no subject" case and a 33-landmark result (integer `t`, optional `now`,
     5-decimal rounding, non-finite landmarks made invisible), using the
     validator shared with stream_pose.py, and backend/example_frame.json
     validates too,
  5. the broadcaster's slow-client policy skips clients with a saturated
     transport (websockets' broadcast() itself has no backpressure).

    python3 backend/selftest.py [--model lite|full|heavy] [--model-dir DIR]

Exit status 0 on success, 1 on the first failure (the error is printed verbatim).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
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
        frame = sp.encode_frame(34, (640, 480), result2, now_ms=time.perf_counter() * 1000.0)
        check(frame["pose"] is None, "blank frame must encode as pose: null")
        blank_frame["frame"] = frame

    def encode_null() -> None:
        frame = blank_frame["frame"]
        errors = sp.validate_pose_frame(frame)
        check(not errors, f"null-pose frame invalid: {errors}")
        text = sp.frame_to_json(frame)
        check(json.loads(text) == frame, "JSON round-trip changed the null-pose frame")
        check(frame["src"] == "python-opencv" and frame["v"] == 2 and frame["size"] == [640, 480], "frame header wrong")
        check(isinstance(frame["t"], int) and '"t":34,' in text, f"integer timestamp must stay an integer on the wire: {text}")
        check(isinstance(frame.get("now"), float) and frame["now"] > 0, "now must carry the capture performance counter (ms)")
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
        check("now" not in frame, "now must be omitted when the encoder is not given a capture clock")
        log(f"    message size {len(text)} bytes")

    def encode_edge_cases() -> None:
        from mediapipe.tasks.python.components.containers.landmark import Landmark

        # Integer timestamps (the production path) are emitted as JSON integers.
        frame = sp.encode_frame(4242, (2, 2), None, now_ms=100.123456)
        text = sp.frame_to_json(frame)
        check(frame["t"] == 4242 and isinstance(frame["t"], int), "int t changed type")
        check(frame["now"] == 100.12346, f"now not rounded to 5 decimals: {frame['now']}")
        check('"t":4242,"now":100.12346,' in text, f"unexpected wire form: {text}")
        check(not sp.validate_pose_frame(frame), "frame with now must validate")
        # A landmark with a non-finite coordinate is emitted invisible at the origin, never as a
        # visible point at 0.
        result = fake_result()
        result.pose_world_landmarks[0][5] = Landmark(x=float("nan"), y=0.1, z=0.2, visibility=0.99, presence=0.9)
        result.pose_world_landmarks[0][6] = Landmark(x=0.1, y=float("inf"), z=0.2, visibility=None, presence=None)
        result.pose_landmarks[0][7].visibility = float("nan")
        frame = sp.encode_frame(1, (2, 2), result)
        check(frame["pose"]["world"][5] == [0.0, 0.0, 0.0, 0.0], f"NaN coordinate not made invisible: {frame['pose']['world'][5]}")
        check(frame["pose"]["world"][6] == [0.0, 0.0, 0.0, 0.0], f"inf coordinate not made invisible: {frame['pose']['world'][6]}")
        check(frame["pose"]["image"][7][3] == 0.9, f"NaN visibility must fall back to presence (0.9), got {frame['pose']['image'][7][3]}")
        check(not sp.validate_pose_frame(frame), f"edge-case frame invalid: {sp.validate_pose_frame(frame)}")
        check("NaN" not in sp.frame_to_json(frame) and "Infinity" not in sp.frame_to_json(frame), "non-finite leaked into JSON")
        # -0.0 is normalized so the JSON never carries a negative zero.
        result = fake_result()
        result.pose_landmarks[0][0].x = -0.0
        result.pose_landmarks[0][0].y = -1e-9
        frame = sp.encode_frame(1, (2, 2), result)
        x0, y0 = frame["pose"]["image"][0][:2]
        check(x0 == 0.0 and y0 == 0.0 and math.copysign(1.0, x0) > 0 and math.copysign(1.0, y0) > 0, "negative zero not normalized")
        check(re.search(r"-0\.0+(?![0-9])", sp.frame_to_json(frame)) is None, "negative zero leaked into JSON")

    def validator_rejects() -> None:
        good = sp.encode_frame(1, (2, 2), fake_result())
        bad_cases = {
            "wrong version": {**good, "v": 1},
            "missing pose": {k: v for k, v in good.items() if k != "pose"},
            "short world": {**good, "pose": {"world": good["pose"]["world"][:32], "image": good["pose"]["image"]}},
            "bad tuple": {**good, "pose": {"world": [[0, 0, 0]] * 33, "image": good["pose"]["image"]}},
            "vis out of range": {**good, "pose": {"world": [[0, 0, 0, 2]] * 33, "image": good["pose"]["image"]}},
            "nan t": {**good, "t": float("nan")},
            "bool t": {**good, "t": True},
            "nan now": {**good, "now": float("nan")},
            "string now": {**good, "now": "12"},
            "not an object": [good],
        }
        for name, case in bad_cases.items():
            check(bool(sp.validate_pose_frame(case)), f"validator accepted invalid frame: {name}")
        with_extras = {**good, "hands": None, "face": None, "now": 12.5}
        check(not sp.validate_pose_frame(with_extras), "validator rejected null hands/face or numeric now")
        check(not sp.validate_pose_frame({**good, "now": None}), "validator must accept now: null")

    def broadcaster_policy() -> None:
        class FakeTransport:
            def __init__(self, backlog: int) -> None:
                self.backlog = backlog

            def get_write_buffer_size(self) -> int:
                return self.backlog

        class FakeClient:
            def __init__(self, backlog: int) -> None:
                self.transport = FakeTransport(backlog)

        sent: list[tuple[list[Any], str]] = []
        b = sp.Broadcaster(log=lambda _m: None)
        b._broadcast = lambda clients, message: sent.append((list(clients), message))  # type: ignore[assignment]
        fast, slow, edge = FakeClient(0), FakeClient(sp.MAX_CLIENT_BACKLOG_BYTES + 1), FakeClient(sp.MAX_CLIENT_BACKLOG_BYTES)
        b.clients.update((fast, slow, edge))
        b.push("frame-1")
        check(len(sent) == 1 and b.sent == 1, "one broadcast expected")
        recipients = sent[0][0]
        check(fast in recipients and edge in recipients and slow not in recipients, "saturated client must be skipped, others sent")
        check(b.dropped == 1, f"dropped count wrong: {b.dropped}")
        check(b.last_message == "frame-1", "last_message must be kept for late joiners")
        b.clients.clear()
        b.clients.add(slow)
        b.push("frame-2")
        check(len(sent) == 1 and b.dropped == 2, "no broadcast when every client is saturated")
        check(b.last_message == "frame-2", "last_message must update even when nobody receives it")
        no_transport = FakeClient(0)
        del no_transport.transport
        b.clients.add(no_transport)
        b.push("frame-3")
        check(sent[-1][0] == [no_transport], "a client without a transport counts as not backlogged")

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
    step("encoder edge cases (int t, now, non-finite landmarks, -0.0)", encode_edge_cases)
    step("validator rejects malformed frames", validator_rejects)
    step("example_frame.json validates", example_file)
    step("broadcaster skips saturated clients", broadcaster_policy)

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
