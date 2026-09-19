#!/usr/bin/env python3
"""
CameraCharacter — optional Python pose provider (docs/DESIGN.md §14, §10).

OpenCV capture -> MediaPipe Tasks PoseLandmarker (VIDEO mode) -> PoseFrame v2
JSON broadcast to every connected WebSocket client. Headless; the browser app
is the UI (Source panel -> WebSocket -> ws://localhost:8765).

    python backend/stream_pose.py --camera 0 --preview

Capture and inference run in a worker thread; encoded frames are handed to the
asyncio loop with call_soon_threadsafe and broadcast without waiting for slow
clients (their frames are dropped, never queued up).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# Protocol constants (must match src/core/types.ts and src/tracking/landmarks.ts)
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = 2
SOURCE_ID = "python-opencv"
POSE_LANDMARK_COUNT = 33
FLOAT_DECIMALS = 5

MODEL_VARIANTS = ("lite", "full", "heavy")
MODEL_URL_TEMPLATE = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_{variant}/float16/1/pose_landmarker_{variant}.task"
)
DEFAULT_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# BlazePose 33-point topology, used only for the preview overlay.
POSE_CONNECTIONS: tuple[tuple[int, int], ...] = (
    # face
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10),
    # torso
    (11, 12), (11, 23), (12, 24), (23, 24),
    # left arm / hand
    (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    # right arm / hand
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    # left leg / foot
    (23, 25), (25, 27), (27, 29), (27, 31), (29, 31),
    # right leg / foot
    (24, 26), (26, 28), (28, 30), (28, 32), (30, 32),
)


# ---------------------------------------------------------------------------
# Model download
# ---------------------------------------------------------------------------

def model_url(variant: str) -> str:
    if variant not in MODEL_VARIANTS:
        raise ValueError(f"unknown model variant {variant!r}; expected one of {MODEL_VARIANTS}")
    return MODEL_URL_TEMPLATE.format(variant=variant)


def model_path(variant: str, model_dir: str = DEFAULT_MODEL_DIR) -> str:
    return os.path.join(model_dir, f"pose_landmarker_{variant}.task")


def ensure_model(variant: str, model_dir: str = DEFAULT_MODEL_DIR, log: Callable[[str], None] = print) -> str:
    """Return the local path of the .task model, downloading it into model_dir if missing."""
    path = model_path(variant, model_dir)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(model_dir, exist_ok=True)
    url = model_url(variant)
    log(f"[model] downloading {url}")
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f"pose_landmarker_{variant}.", suffix=".part", dir=model_dir)
    os.close(tmp_fd)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "CameraCharacter/2 (stream_pose.py)"})
        with urllib.request.urlopen(request, timeout=60) as response, open(tmp_path, "wb") as out:
            total_header = response.headers.get("Content-Length")
            total = int(total_header) if total_header and total_header.isdigit() else 0
            done = 0
            last_report = -1
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total > 0:
                    pct = int(done * 100 / total)
                    if pct // 10 != last_report // 10:
                        last_report = pct
                        log(f"[model] {pct:3d}%  {done / 1e6:.1f} / {total / 1e6:.1f} MB")
                elif done // (1 << 20) != last_report:
                    last_report = done // (1 << 20)
                    log(f"[model] {done / 1e6:.1f} MB")
        if os.path.getsize(tmp_path) == 0:
            raise RuntimeError(f"download of {url} produced an empty file")
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    log(f"[model] saved {path} ({os.path.getsize(path) / 1e6:.1f} MB)")
    return path


# ---------------------------------------------------------------------------
# MediaPipe Tasks wrappers (imported lazily so the validator works without them)
# ---------------------------------------------------------------------------

def create_landmarker(model_file: str, *, num_poses: int = 1, confidence: float = 0.5) -> Any:
    """Create a PoseLandmarker in VIDEO running mode from a local .task file."""
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_file),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=num_poses,
        min_pose_detection_confidence=confidence,
        min_pose_presence_confidence=confidence,
        min_tracking_confidence=confidence,
    )
    return vision.PoseLandmarker.create_from_options(options)


def to_mp_image(rgb: np.ndarray) -> Any:
    """Wrap an RGB uint8 HxWx3 array as a MediaPipe Image (no copy of the semantics; MediaPipe may copy)."""
    import mediapipe as mp

    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("expected an RGB uint8 array of shape (H, W, 3)")
    if not rgb.flags["C_CONTIGUOUS"]:
        rgb = np.ascontiguousarray(rgb)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)


def detect(landmarker: Any, rgb: np.ndarray, timestamp_ms: int) -> Any:
    """Run detect_for_video on an RGB frame. timestamp_ms must strictly increase between calls."""
    return landmarker.detect_for_video(to_mp_image(rgb), int(timestamp_ms))


# ---------------------------------------------------------------------------
# PoseFrame v2 encoding + validation (shared with selftest.py)
# ---------------------------------------------------------------------------

def _round(value: Optional[float]) -> float:
    if value is None:
        return 0.0
    v = float(value)
    if not math.isfinite(v):
        return 0.0
    r = round(v, FLOAT_DECIMALS)
    return 0.0 if r == 0 else r  # normalize -0.0


def _visibility(lm: Any) -> float:
    vis = getattr(lm, "visibility", None)
    if vis is None:
        vis = getattr(lm, "presence", None)
    if vis is None:
        return 1.0
    v = float(vis)
    if not math.isfinite(v):
        return 0.0
    return _round(min(1.0, max(0.0, v)))


def encode_landmarks(landmarks: Sequence[Any]) -> list[list[float]]:
    """Encode 33 (Normalized)Landmark objects as [[x, y, z, visibility] * 33]."""
    if len(landmarks) != POSE_LANDMARK_COUNT:
        raise ValueError(f"expected {POSE_LANDMARK_COUNT} landmarks, got {len(landmarks)}")
    return [[_round(lm.x), _round(lm.y), _round(lm.z), _visibility(lm)] for lm in landmarks]


def encode_frame(timestamp_ms: float, size: tuple[int, int], result: Any) -> dict[str, Any]:
    """
    Build a PoseFrame v2 dict from a PoseLandmarkerResult (or None). Landmarks stay in raw
    MediaPipe conventions; the browser converts. Hands/face are omitted.
    """
    pose: Optional[dict[str, Any]] = None
    if result is not None:
        image_sets = getattr(result, "pose_landmarks", None) or []
        world_sets = getattr(result, "pose_world_landmarks", None) or []
        if image_sets and world_sets and len(image_sets[0]) == POSE_LANDMARK_COUNT and len(world_sets[0]) == POSE_LANDMARK_COUNT:
            pose = {"world": encode_landmarks(world_sets[0]), "image": encode_landmarks(image_sets[0])}
    return {
        "v": PROTOCOL_VERSION,
        "t": _round(timestamp_ms),
        "src": SOURCE_ID,
        "size": [int(size[0]), int(size[1])],
        "pose": pose,
    }


def frame_to_json(frame: dict[str, Any]) -> str:
    return json.dumps(frame, separators=(",", ":"), allow_nan=False)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_landmark_array(value: Any, name: str, errors: list[str]) -> None:
    if not isinstance(value, list):
        errors.append(f"pose.{name} must be a list")
        return
    if len(value) != POSE_LANDMARK_COUNT:
        errors.append(f"pose.{name} must have {POSE_LANDMARK_COUNT} entries, has {len(value)}")
        return
    for i, lm in enumerate(value):
        if not isinstance(lm, list) or len(lm) != 4:
            errors.append(f"pose.{name}[{i}] must be [x, y, z, visibility]")
            continue
        if not all(_is_number(c) for c in lm):
            errors.append(f"pose.{name}[{i}] must contain finite numbers")
            continue
        if not 0.0 <= lm[3] <= 1.0:
            errors.append(f"pose.{name}[{i}] visibility {lm[3]} out of [0, 1]")


def validate_pose_frame(frame: Any) -> list[str]:
    """Return a list of schema violations for a decoded PoseFrame v2 (empty when valid)."""
    errors: list[str] = []
    if not isinstance(frame, dict):
        return ["frame must be a JSON object"]
    if frame.get("v") != PROTOCOL_VERSION or isinstance(frame.get("v"), bool):
        errors.append(f"v must be {PROTOCOL_VERSION}")
    if not _is_number(frame.get("t")):
        errors.append("t must be a finite number (ms)")
    src = frame.get("src")
    if not isinstance(src, str) or not src:
        errors.append("src must be a non-empty string")
    size = frame.get("size")
    if not (isinstance(size, list) and len(size) == 2 and all(_is_number(s) and s >= 0 for s in size)):
        errors.append("size must be [width, height]")
    if "pose" not in frame:
        errors.append("pose is required (object or null)")
    else:
        pose = frame["pose"]
        if pose is not None:
            if not isinstance(pose, dict):
                errors.append("pose must be an object or null")
            else:
                _check_landmark_array(pose.get("world"), "world", errors)
                _check_landmark_array(pose.get("image"), "image", errors)
    for optional in ("hands", "face"):
        if optional in frame and frame[optional] is not None and not isinstance(frame[optional], dict):
            errors.append(f"{optional} must be an object or null when present")
    return errors


# ---------------------------------------------------------------------------
# Preview drawing (OpenCV window)
# ---------------------------------------------------------------------------

def draw_skeleton(bgr: np.ndarray, image_landmarks: Optional[Sequence[Sequence[float]]]) -> None:
    """Draw the 33-point skeleton in place on a BGR frame from normalized [x, y, z, vis] tuples."""
    import cv2

    if not image_landmarks:
        return
    h, w = bgr.shape[:2]
    pts: list[Optional[tuple[int, int]]] = []
    for lm in image_landmarks:
        if lm[3] < 0.3:
            pts.append(None)
            continue
        pts.append((int(round(lm[0] * w)), int(round(lm[1] * h))))
    for a, b in POSE_CONNECTIONS:
        pa, pb = pts[a], pts[b]
        if pa is None or pb is None:
            continue
        cv2.line(bgr, pa, pb, (80, 220, 120), 2, cv2.LINE_AA)
    for i, p in enumerate(pts):
        if p is None:
            continue
        color = (60, 160, 255) if i % 2 == 1 or i in (0, 9, 10) else (255, 140, 60)
        cv2.circle(bgr, p, 3, color, -1, cv2.LINE_AA)


# ---------------------------------------------------------------------------
# Capture + inference worker
# ---------------------------------------------------------------------------

class PoseWorker(threading.Thread):
    """Reads frames from a cv2.VideoCapture, runs the landmarker and delivers JSON frames via a callback."""

    def __init__(
        self,
        *,
        camera: str,
        width: int,
        height: int,
        fps: float,
        model_file: str,
        max_fps: float,
        preview: bool,
        mirror_preview: bool,
        on_frame: Callable[[str, bool], None],
        log: Callable[[str], None] = print,
    ) -> None:
        super().__init__(name="pose-worker", daemon=True)
        self.camera = camera
        self.width = width
        self.height = height
        self.fps = fps
        self.model_file = model_file
        self.max_fps = max_fps
        self.preview = preview
        self.mirror_preview = mirror_preview
        self.on_frame = on_frame
        self.log = log
        self._stop_event = threading.Event()
        self.error: Optional[BaseException] = None
        self.frames = 0
        self.detections = 0

    def stop(self) -> None:
        self._stop_event.set()

    @property
    def stopped(self) -> bool:
        return self._stop_event.is_set()

    @staticmethod
    def _camera_source(camera: str) -> Any:
        stripped = camera.strip()
        if stripped.lstrip("-").isdigit():
            return int(stripped)
        return stripped

    def _open_capture(self) -> Any:
        import cv2

        cap = cv2.VideoCapture(self._camera_source(self.camera))
        if not cap.isOpened():
            raise RuntimeError(f"could not open camera {self.camera!r}")
        if self.width > 0:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        if self.height > 0:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        if self.fps > 0:
            cap.set(cv2.CAP_PROP_FPS, self.fps)
        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or self.width
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self.height
        actual_fps = cap.get(cv2.CAP_PROP_FPS)
        self.log(f"[camera] {self.camera!r} opened at {actual_w}x{actual_h} @ {actual_fps:.0f} fps (requested {self.width}x{self.height} @ {self.fps:.0f})")
        return cap

    def run(self) -> None:
        try:
            self._run()
        except BaseException as exc:  # surfaced to the main thread
            self.error = exc
            self.log(f"[worker] error: {exc!r}")
        finally:
            self._stop_event.set()

    def _run(self) -> None:
        import cv2

        cap = self._open_capture()
        landmarker = create_landmarker(self.model_file)
        window = "CameraCharacter pose (q to quit)"
        if self.preview:
            cv2.namedWindow(window, cv2.WINDOW_NORMAL)
        total_frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)  # > 0 only for file inputs
        t0 = time.monotonic()
        last_ts = -1
        min_interval = 1.0 / self.max_fps if self.max_fps > 0 else 0.0
        last_infer = 0.0
        read_failures = 0
        try:
            while not self._stop_event.is_set():
                ok, bgr = cap.read()
                if not ok or bgr is None:
                    if total_frames > 0 and cap.get(cv2.CAP_PROP_POS_FRAMES) >= total_frames:
                        self.log("[camera] end of input file")
                        break
                    read_failures += 1
                    if read_failures >= 30:
                        raise RuntimeError("camera stopped delivering frames")
                    time.sleep(0.02)
                    continue
                read_failures = 0
                now = time.monotonic()
                if min_interval > 0 and (now - last_infer) < min_interval:
                    # Throttle inference: keep draining the camera so frames stay fresh.
                    if self.preview:
                        if cv2.waitKey(1) & 0xFF == ord("q"):
                            break
                    continue
                last_infer = now
                # Strictly increasing integer timestamps are required by VIDEO mode.
                ts = int((now - t0) * 1000.0)
                if ts <= last_ts:
                    ts = last_ts + 1
                last_ts = ts
                h, w = bgr.shape[:2]
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                result = detect(landmarker, rgb, ts)
                frame = encode_frame(ts, (w, h), result)
                self.frames += 1
                detected = frame["pose"] is not None
                if detected:
                    self.detections += 1
                self.on_frame(frame_to_json(frame), detected)
                if self.preview:
                    if frame["pose"] is not None:
                        draw_skeleton(bgr, frame["pose"]["image"])
                    if self.mirror_preview:
                        bgr = cv2.flip(bgr, 1)
                    cv2.putText(bgr, f"{'pose' if detected else 'no subject'}  t={ts}ms", (10, 24),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
                    cv2.imshow(window, bgr)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        finally:
            cap.release()
            landmarker.close()
            if self.preview:
                try:
                    cv2.destroyAllWindows()
                except cv2.error:
                    pass


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

class Broadcaster:
    """Tracks connected clients and fans out frames without ever awaiting a slow client."""

    def __init__(self, log: Callable[[str], None] = print) -> None:
        self.clients: set[Any] = set()
        self.log = log
        self.sent = 0
        self.last_message: Optional[str] = None

    async def handler(self, connection: Any) -> None:
        peer = getattr(connection, "remote_address", None)
        self.clients.add(connection)
        self.log(f"[ws] client connected {peer} ({len(self.clients)} total)")
        try:
            if self.last_message is not None:
                await connection.send(self.last_message)
            # We never expect client messages; consume them so the connection stays healthy.
            async for _ in connection:
                pass
        except Exception as exc:  # connection errors are per-client and non-fatal
            self.log(f"[ws] client {peer} error: {exc!r}")
        finally:
            self.clients.discard(connection)
            self.log(f"[ws] client disconnected {peer} ({len(self.clients)} total)")

    def push(self, message: str) -> None:
        """Called on the event loop thread. Slow clients (full write buffer) skip this frame."""
        from websockets.asyncio.server import broadcast

        self.last_message = message
        if not self.clients:
            return
        broadcast(self.clients, message)
        self.sent += 1


async def serve(args: argparse.Namespace, model_file: str, log: Callable[[str], None] = print) -> int:
    from websockets.asyncio.server import serve as ws_serve

    loop = asyncio.get_running_loop()
    broadcaster = Broadcaster(log)
    stop_event = asyncio.Event()

    def on_frame(message: str, _detected: bool) -> None:
        loop.call_soon_threadsafe(broadcaster.push, message)

    worker = PoseWorker(
        camera=args.camera,
        width=args.width,
        height=args.height,
        fps=args.fps,
        model_file=model_file,
        max_fps=args.max_fps,
        preview=args.preview,
        mirror_preview=args.mirror_preview,
        on_frame=on_frame,
        log=log,
    )

    def request_stop() -> None:
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_stop)
        except (NotImplementedError, RuntimeError):
            pass  # Windows / non-main thread: KeyboardInterrupt still ends asyncio.run

    async with ws_serve(broadcaster.handler, args.host, args.port, compression=None, max_queue=4):
        log(f"[ws] serving PoseFrame v2 on ws://{args.host}:{args.port}  (model={args.model}, camera={args.camera})")
        worker.start()
        last_report = time.monotonic()
        last_frames = 0
        exit_code = 0
        while not stop_event.is_set():
            if worker.stopped:
                if worker.error is not None:
                    exit_code = 1
                else:
                    log("[worker] finished (preview closed or input ended)")
                break
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass
            now = time.monotonic()
            if now - last_report >= 5.0:
                fps = (worker.frames - last_frames) / (now - last_report)
                log(f"[status] inference {fps:4.1f} fps | detected {worker.detections}/{worker.frames} | clients {len(broadcaster.clients)}")
                last_report = now
                last_frames = worker.frames
        log("[main] shutting down")
        worker.stop()
    worker.join(timeout=5.0)
    return exit_code


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stream_pose.py",
        description="Stream MediaPipe pose landmarks (PoseFrame v2 JSON) from a camera over WebSocket.",
    )
    p.add_argument("--camera", default="0", help="camera index, device path, file or URL for cv2.VideoCapture (default 0)")
    p.add_argument("--width", type=int, default=1280, help="requested capture width (default 1280)")
    p.add_argument("--height", type=int, default=720, help="requested capture height (default 720)")
    p.add_argument("--fps", type=float, default=30.0, help="requested capture frame rate (default 30)")
    p.add_argument("--model", choices=MODEL_VARIANTS, default="full", help="pose landmarker variant (default full)")
    p.add_argument("--port", type=int, default=8765, help="WebSocket port (default 8765)")
    p.add_argument("--host", default="0.0.0.0", help="WebSocket bind address (default 0.0.0.0)")
    p.add_argument("--preview", action="store_true", help="show an OpenCV window with the skeleton; press q to quit")
    p.add_argument("--mirror-preview", action="store_true", help="flip only the preview window horizontally")
    p.add_argument("--max-fps", type=float, default=0.0, help="throttle inference to at most this rate (0 = camera rate)")
    p.add_argument("--model-dir", default=DEFAULT_MODEL_DIR, help="where .task models are cached (default backend/models)")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.preview:
        import cv2

        if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            print("--preview needs a display (DISPLAY/WAYLAND_DISPLAY is not set); run without --preview on a headless box",
                  file=sys.stderr)
            return 2
        try:
            cv2.namedWindow("__cameracharacter_probe__")
            cv2.destroyWindow("__cameracharacter_probe__")
        except cv2.error as exc:
            print(f"--preview needs a GUI-enabled OpenCV build (opencv-python, not -headless): {exc}", file=sys.stderr)
            return 2
    try:
        model_file = ensure_model(args.model, args.model_dir)
    except (urllib.error.URLError, OSError, RuntimeError) as exc:
        print(f"model download failed: {exc}", file=sys.stderr)
        return 1
    try:
        return asyncio.run(serve(args, model_file))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
