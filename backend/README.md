# Python pose provider (optional)

`stream_pose.py` is an alternative tracking source for CameraCharacter. It captures a
camera with OpenCV, runs the MediaPipe Tasks `PoseLandmarker` in VIDEO mode and streams
[PoseFrame v2](../docs/DESIGN.md#10-protocol-poseframe-v2) JSON to every connected WebSocket
client. It has no GUI of its own (apart from an optional debug preview window); the browser
app is the UI.

Use it when the in-browser MediaPipe source is not enough: a camera the browser cannot open
(industrial/USB3 cameras, RTSP/GStreamer/file inputs, anything `cv2.VideoCapture` can read),
a multi-machine setup (capture on one box, render on another), or when you want to run
the heavy model on a stronger CPU/GPU than the browser has access to.

## Run

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
python backend/stream_pose.py --camera 0 --preview
```

The first start downloads `pose_landmarker_<variant>.task` (5–30 MB) from Google's model
storage into `backend/models/` (override with `--model-dir`). After that it runs offline.

Then in the web app open the **Source** panel, pick **WebSocket** and connect to
`ws://localhost:8765` (or `ws://<host>:8765` from another machine). Mirror mode, filtering,
retargeting and recording all behave exactly as with the browser source, because the frames
carry raw MediaPipe coordinates and the browser does the conversion.

Verify the installation without a camera:

```bash
python backend/selftest.py            # downloads the lite model, runs one inference, checks the JSON schema
```

## Flags

| flag | default | meaning |
|---|---|---|
| `--camera` | `0` | camera index, device path (`/dev/video2`), video file or URL (`rtsp://...`) for `cv2.VideoCapture` |
| `--width` / `--height` | `1280` / `720` | requested capture size (the camera may pick the nearest supported mode; the real size is sent in `size`) |
| `--fps` | `30` | requested capture frame rate |
| `--model` | `full` | `lite`, `full` or `heavy` |
| `--port` / `--host` | `8765` / `0.0.0.0` | WebSocket bind address |
| `--preview` | off | show an OpenCV window with the skeleton drawn; press `q` in it to quit |
| `--mirror-preview` | off | flip only the preview window (the streamed landmarks are never flipped) |
| `--max-fps` | `0` (camera rate) | throttle inference; the camera is still drained so frames stay fresh |
| `--model-dir` | `backend/models` | where `.task` models are cached |

Stop with Ctrl-C (or `q` in the preview window); the camera and the landmarker are released
cleanly. `--preview` needs a GUI-enabled OpenCV build (`opencv-python`, which
`requirements.txt` installs); with `opencv-python-headless` the script refuses to start
in preview mode and tells you why.

## Protocol

Each WebSocket text message is one PoseFrame v2 (see [`example_frame.json`](example_frame.json)):

```json
{"v":2,"t":12345.678,"src":"python-opencv","size":[1280,720],
 "pose":{"world":[[x,y,z,visibility]×33],"image":[[x,y,z,visibility]×33]}}
```

* `t` is milliseconds, monotonic since the provider started (also the timestamp handed to
  `detect_for_video`, so it strictly increases).
* `world` landmarks are meters with the origin at the hip midpoint; `image` landmarks are
  normalized `[0,1]` image coordinates. Both use raw MediaPipe axes (x right, y down, z toward
  the camera negative). Landmark order is MediaPipe's 33-point BlazePose topology.
* `pose` is `null` when nobody is detected. `hands` and `face` are not sent by this provider.
* Floats are rounded to 5 decimals; a full frame is about 1.7 KB.

A newly connected client immediately receives the last frame (if any) and then live frames.
Frames are broadcast without waiting: a client whose socket buffer is full simply misses
frames instead of building up latency for everyone.

## Model variants and performance

| variant | size | typical CPU cost | when |
|---|---|---|---|
| `lite` | 5.8 MB | fastest | laptops, high frame rates, half-body framing |
| `full` | 9.5 MB | ~2× lite | default: good accuracy/speed balance for full-body capture |
| `heavy` | 30 MB | ~4× lite | recording takes where precision matters more than latency |

Notes:

* Inference runs on the CPU via XNNPACK (the MediaPipe Python wheel does not use a GPU on
  desktop). On a modern laptop CPU `full` sustains 25–30 fps at 720p; use `--max-fps 20` to
  leave CPU headroom for the browser rendering on the same machine, or `lite` on slower boxes.
* Capture resolution mostly affects the person detector's ability to find small/distant
  subjects; the landmark model always works on a crop. 640×480 is fine for close framing,
  1280×720 for full-body at 2–3 m.
* Lower webcam exposure/auto-gain latency in your camera settings if motion feels late; the
  provider itself adds under a millisecond on top of inference.
* On Linux the MediaPipe wheel links against `libEGL.so.1` and `libGLESv2.so.2` even for
  CPU inference. On a minimal server image install them with `apt-get install libegl1 libgles2`.
* The preview window is drawn from the capture thread. That is fine on Linux and Windows;
  on macOS OpenCV windows must run on the main thread, so use the browser overlay there
  instead of `--preview`.

## Files

* `stream_pose.py` — the provider (also importable: `ensure_model`, `create_landmarker`,
  `detect`, `encode_frame`, `frame_to_json`, `validate_pose_frame`, `draw_skeleton`).
* `selftest.py` — offline verification of download, landmarker, inference and the JSON schema.
* `example_frame.json` — one PoseFrame v2 with the exact shape the browser expects.
* `requirements.txt` — Python dependencies.
* `models/` — downloaded `.task` models (git-ignored).
