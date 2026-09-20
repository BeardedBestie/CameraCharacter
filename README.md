# CameraCharacter

Inhabit a 3D character from a webcam. Drop in a rigged humanoid model (Meshy, Mixamo, VRoid/VRM, Rigify, UE5, Character Creator…), stand in front of the camera, and the character moves with you. Everything runs in the browser: pose tracking (MediaPipe Tasks Vision), automatic bone mapping, retargeting, a mirror-style virtual camera, and recording of takes as re-targetable landmark data, GLB animation assets, BVH, or video.

Intended uses: interactive art installations, quick character puppeteering, motion-capture recording for animation, and recording actor performances inside a 3D scene as a 3D asset.

> Status: version 2 is a ground-up rebuild of an earlier prototype. The design is documented in [`docs/DESIGN.md`](docs/DESIGN.md); decisions and their provenance are in [`decisionlog.md`](decisionlog.md).
>
> **Verified so far** (automatically, without a webcam): the TypeScript build; 324 unit tests covering the math, the filters, the auto-mapper against eleven rig families and every bundled character file, the solver on synthetic rigs and motion, framing, the mirror camera, BVH round trips and the Python provider; and a Playwright suite that boots the app in headless Chromium, loads the bundled models, drives them from synthetic motion and recorded takes, and checks bone error, framing transitions and camera behaviour.
> **Not yet verified**: live webcam sessions (MediaPipe on real video, hand/face landmarkers, the face-matrix basis), FBX and VRM files from the wild, the pose-calibration flow, and video/GLB export inside a real browser. Open reviewer findings are listed in [`docs/REVIEW-NOTES.md`](docs/REVIEW-NOTES.md). The first live session with the diagnostic snapshot is the next step.

## What it does

- **Automatic bone mapping.** Rigs are analysed by name *and* by skeleton topology, so Mixamo's `mixamorig:LeftForeArm`, Meshy's `Spine02 → Spine01 → Spine` (named upside down), UE5's `lowerarm_l`, Rigify's `DEF-forearm.L`, VRoid's `J_Bip_L_LowerArm` and nameless Blender rigs all resolve to the same humanoid roles. The mapping is shown with a confidence per bone and can be corrected live.
- **Rest-pose-aware retargeting.** Rotations are applied as world-space deltas from the rig's *bind pose*, so it does not matter whether a rig's bones point along +X, +Y, or something odd, nor whether the bind pose is a T-pose, an A-pose, or relaxed. Each bone gets a full 3-axis orientation from landmark triplets (elbow bend plane, palm normal, foot direction…), which removes the limb twisting that direction-only retargeting produces.
- **Graceful degradation.** Every body part has a confidence with hysteresis. When you walk up to the camera and only your upper body is visible, the legs settle to rest while the torso, arms and head keep animating; lost elbows are filled in by a two-bone solve; nothing snaps to a T-pose.
- **Mirror camera.** The virtual camera frames the character the way the webcam frames you: full body when you stand back, head-and-shoulders when you lean in, continuously and smoothly.
- **Calibration that is automatic first.** Rig analysis at load time chooses per-bone reference modes; an optional three-second pose calibration refines them for stylized rigs; a one-click diagnostic snapshot (side-by-side image plus JSON) lets a developer or an LLM diagnose a new rig family.
- **Recording.** Raw landmark takes (`.mocap.json`) that can be replayed and re-targeted onto any model later; retargeted animation exported as a GLB with the model (and optionally the scene) embedded; BVH for Blender/Maya/MotionBuilder; WebM video of the viewport.
- **No server required.** Optional Python provider for OpenCV-based pipelines, other cameras, or a second machine, speaking the same protocol over WebSocket.

## Quick start

Requirements: Node.js 20+, a Chromium-based browser or Firefox with WebGL2, a webcam.

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`), allow camera access, and either use the bundled sample character or drop a `.glb`, `.gltf`, `.fbx` or `.vrm` file onto the window. Stand back so your whole body is visible for the best result; the character follows immediately.

No webcam? Choose **Source → Synthetic** to drive the character from generated motion (walk, squat, wave, close-up…), or load a recorded `.mocap.json` take.

### Optional: Python pose provider

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
python backend/stream_pose.py --camera 0 --preview
```

Then in the app choose **Source → WebSocket** and connect to `ws://localhost:8765`. See [`backend/README.md`](backend/README.md).

## How it works

```
Webcam ─▶ MediaPipe PoseLandmarker ─▶ PoseFrame ─▶ filters ─▶ body model ─▶ retargeter ─▶ rig bones
          (+ optional hands, face)     (33 world +   (One Euro,  (per-bone     (world-delta
                                        33 image      hysteresis, direction +   from bind pose,
                                        landmarks)    mirror)     up reference) degradation)
                                                                                     │
                                Stage: scene, lights, mirror camera, environment ◀───┘
                                Recorders: landmark take · animation clip → GLB/BVH · video
                                Diagnostics: overlay, per-bone error, snapshot bundle
```

### Coordinate conventions

MediaPipe reports world landmarks in meters relative to the hip midpoint with image conventions (x right, y down, z toward the camera negative). They are converted to three.js (x, −y, −z). A person facing the camera then has their anatomical left at +X and faces +Z, which is exactly how a glTF humanoid stands, so the un-mirrored "actor" mapping drives the character's left arm from your left arm. **Mirror mode** (default) negates X and swaps left/right so the character behaves like a mirror. MediaPipe always runs on the un-flipped frame so its left/right labels stay correct; only the preview is flipped.

### Automatic bone mapping

Two detectors run independently and are reconciled:

1. **Names.** Bone names are normalized (namespace prefixes such as `mixamorig:`, `DEF-`, `J_Bip_L_`, `CC_Base_` stripped; camelCase/snake/dot split; side tokens detected) and matched against a synonym lexicon per role.
2. **Topology.** From the bind pose, the hips are found as the joint whose subtree splits into two mirrored downward chains (legs) and one upward chain (spine); the spine chain ends at the first joint that owns two sideways chains (arms) and a head chain; chains are then labelled in order (shoulder, upper arm, lower arm, hand; upper leg, lower leg, foot, toes). Helper bones (twist, IK, hair, skirt, props) are excluded.

When both agree the confidence is high; topology decides spine order and sides, names decide shoulder-versus-upper-arm and fingers. The result is a **rig profile** (mapping, confidences, warnings, rest analysis, per-bone settings) stored per skeleton fingerprint in the browser and exportable as JSON.

### Retargeting

The rest pose is the rig's **bind pose**, recovered from the skin's inverse bind matrices against the real parent transform (many exports store an animation frame in the node transforms, and three.js's `Skeleton.pose()` double-applies armature transforms, so neither is used).

For each bone the body model produces a measured basis: a direction (shoulder → elbow) and an up reference with a confidence. Up references are defined the same way everywhere and are independent of the body side: the elbow's flexion direction for the upper arm, the back-of-hand normal for the lower arm and hand, the kneecap direction for the thigh, the foot's forward direction for the shin, up for the foot. For `auto` bones the reference basis is obtained by running the **same estimators on the rig's bind skeleton**, so a rig bound with bent elbows maps your flexion onto its hinge instead of twisting the arm. The solver computes the world rotation taking the reference basis to the measured basis, splits it into swing and twist about the bone axis (twist is low-passed and decays to the bind twist when the up reference is uncertain), applies it on top of the bind-pose world orientation, and converts to local space through a solver-maintained parent chain that composes unmapped intermediate bones. The torso chain is driven relative to a standing baseline so a curved spine or a forward-leaning neck keeps its designed shape.

Reference modes per bone:

| mode | reference | use |
|---|---|---|
| `auto` | the model's bind pose (direction and up from the bind skeleton) | limbs on standard rigs (T-pose, A-pose, arms down, bent elbows) |
| `relative` | a canonical standing rest | the torso chain; stub bones; the model shows its own rest pose when you stand normally and your motion is applied as a delta |
| `calibrated` | measured from you while matching the model's rest pose | escape hatch for unusual rigs or systematic tracking bias |
| `follow` | none | a stub thigh on a rig without a knee: the whole leg is driven as one segment from hip to ankle |

The rig analysis chooses modes from the bind pose (anatomical cones, stub detection, no-knee detection); all are overridable, and a roll trim per bone corrects residual twist.

### Degradation and the mirror camera

Landmark visibilities are smoothed and gated with hysteresis, a dwell time (a single spike never opens a gate), an in-frame test (MediaPipe extrapolates off-frame joints with optimistic visibility) and per-group thresholds (feet are chronically less visible). Filters freeze while a landmark is gated off and restart from the true position when it returns. A limb whose landmarks are lost holds its pose (700 ms arms, 1 s legs), then relaxes toward rest. Lost elbows or knees are reconstructed from the shoulder/hip and wrist/ankle using your own measured segment lengths. Framing states (full, waist, bust, face) decide what is driven: seated users get a pelvis that settles to the shoulder line instead of rocking from hallucinated hip landmarks; a close-up drives the head from the face landmarker. Tracking loss keeps the framing for three seconds before easing to rest.

In mirror camera mode the app fits, every frame, a line through the image heights of the visible landmarks against standard body proportions. That gives a continuous estimate of which part of the body the webcam crops, which is mapped onto the character's height table and drives the camera distance and target with critically damped springs, a dead-band and a rate limit, so the character fills the viewport the way you fill the webcam frame without zoom pumping when a knee flickers in and out.

### Calibration

1. **Rig auto-calibration** on every load (no user action): mapping, bind-pose analysis, unit and facing correction, per-bone mode selection, height table.
2. **Standing baseline** (automatic, silent): your torso's resting orientation, your segment lengths and your distance are measured from the first seconds of full-body tracking.
3. **Pose calibration** (optional, about three seconds): the character shows its rest pose next to the webcam preview; you match it, a countdown runs, and the averaged reference bases are stored for you.
4. **Diagnostic snapshot**: one click captures the webcam frame with landmarks, the 3D view with the measured skeleton overlaid, per-bone error bars, and a JSON bundle (analysis, mapping with confidences, rest directions, measured and reference bases, solved directions, framing state, settings, versions). Hand it to a developer or paste it to an LLM to diagnose mapping or roll problems on a new rig family; fixes land as lexicon entries, presets, or profile tweaks. This is a development-time loop, not a runtime dependency.

The app also self-checks: after solving, the angle between each measured direction and the bone's actual direction is reported, and bones over 5° are highlighted.

## Supported models

| source | format | notes |
|---|---|---|
| Mixamo | FBX, GLB | `mixamorig:` prefix, T-pose bind, centimeters (FBX). Fingers supported. |
| Meshy | GLB | A-pose-ish bind with bent elbows; spine chain named in reverse; some stub bones (handled with `relative` mode). Sample bundled. |
| VRoid / VRM 0.x and 1.0 | VRM | Humanoid map read from the VRM metadata; VRM 0.x rotated to face +Z. |
| Rigify (Blender) | GLB | `DEF-` bones used; `ORG-`/`MCH-` ignored. |
| UE5 Mannequin | FBX, GLB | `pelvis`, `spine_01…05`, `upperarm_l`… twist bones ignored. |
| Character Creator 4 | FBX | `CC_Base_*` names; twist bones ignored. |
| Daz Genesis | FBX | Bend/Twist pairs handled. |
| Generic Blender | GLB, FBX | `upper_arm.L`, or nameless `Bone.001…` rigs via topology. |
| Bundled sample pack (`models/characters`) | GLB | 28 game characters from a modular-parts pipeline: Meshy-style names, modular part meshes on one skin, root scaled by 0.01, node transforms posed by an animation (bind pose recovered from the skin), one rig with scrambled spine/neck names (topology decides). Four color variants are unrigged static meshes. |

Any humanoid with hips, a spine, a head, two arms and two legs can be driven. Missing optional bones (shoulders, neck, feet, toes, fingers) are fine.

## Recording and export

| output | contents | use |
|---|---|---|
| `.mocap.json` | raw PoseFrame v2 stream (world + image landmarks, optional hands/face), timestamps, capture info | replay, re-target onto another model, archive a take losslessly |
| `.glb` | the model with the retargeted animation clip embedded (optionally with the loaded environment) | a self-contained "3D video" asset for Blender, Unity, Unreal, three.js, any glTF viewer |
| `.bvh` | humanoid hierarchy with rest offsets, root position + per-joint rotation channels | DCC mocap import (Blender, Maya, MotionBuilder) |
| `.webm` | viewport video (optional webcam picture-in-picture) | sharing, previews |

## Protocol

`WebSocketSource`, `RecordingSource` and the Python provider exchange **PoseFrame v2** JSON in raw MediaPipe conventions:

```json
{
  "v": 2, "t": 12345.678, "src": "python-opencv", "size": [1280, 720],
  "pose": { "world": [[x, y, z, visibility] /* ×33 */], "image": [[x, y, z, visibility] /* ×33 */] },
  "hands": { "left": { "world": [[x,y,z] /* ×21 */], "image": [[x,y,z] /* ×21 */], "score": 0.9 }, "right": null },
  "face": { "blendshapes": { "jawOpen": 0.21 }, "matrix": [/* 16 */] }
}
```

`pose` is `null` when nobody is detected; `hands` and `face` are optional. Recording files wrap frames as `{"format": "cameracharacter-mocap", "version": 2, "meta": {...}, "frames": [...]}`. The TypeScript definitions are in [`src/core/types.ts`](src/core/types.ts).

## Development

```bash
npm run dev          # Vite dev server
npm run typecheck    # TypeScript (strict)
npm run test         # Vitest unit tests (math, mapping, solver, filters, exports)
npm run build        # production build to dist/
npm run gen:recordings   # synthetic .mocap.json takes into public/recordings/
npm run test:e2e     # Playwright end-to-end (headless Chromium, synthetic takes)
```

Project layout:

```
src/core        shared types (PoseFrame v2, humanoid roles, rig profile) and math
src/tracking    MediaPipe, WebSocket and recording sources; filters and mirror
src/rig         model loading, bind-pose analysis, automatic bone mapping, profiles
src/retarget    canonical conventions, body model, world-delta solver, calibration
src/stage       renderer, lights, mirror camera, environments
src/record      landmark recorder, clip recorder, GLB/BVH/video export
src/diagnostics overlays, per-bone error, snapshot bundle
src/testing     synthetic human generator (tests, e2e, webcam-free demo source)
src/app         UI panels and orchestration
backend         optional Python provider
docs            design document
tests, e2e      Vitest and Playwright suites
```

Testing strategy: the math, mapping and solver are pure and tested in Node, including against the real bundled Meshy rig (read by a minimal GLB skeleton reader) and synthetic rigs; the solver is checked by generating landmarks from a synthetic human with known joint angles and asserting that the driven bones reproduce those directions. End-to-end tests load the app in headless Chromium with synthetic recordings and save screenshots.

## Roadmap

- **Props and weapons in the character's hands.** Attach a prop GLB to a hand socket. The app makes an automatic first pass (grip frame derived from the hand's finger direction and palm normal; the prop's grip axis and pointing direction from its bounding box, the bundled weapon pack's `muzzle`/`length` extras, or a named grip node), then a slider panel lets you correct position, rotation and scale live, and one click exports the corrected offsets as a preset that becomes the new default for that rig family and prop category. Design notes in [`docs/DESIGN.md`](docs/DESIGN.md#16-props-in-hands-and-the-alignment-loop).
- Foot IK and ground contact, VRM spring bones, full ARKit blendshape mapping for models that carry them, multi-person tracking, WebGPU rendering, OSC/VMC output for other tools, take management (trimming, multiple takes), scene authoring (camera paths, lights).

### How alignment problems are solved in this project

Bone roll trims, prop sockets, camera framing presets and rig quirks all follow the same loop: **the system proposes, the person corrects with direct manipulation, and the correction is persisted as the new default** (and, in aggregate, informs better proposals). This is a mixed-initiative, human-in-the-loop calibration pattern; see the design document for how it is applied.

## Acknowledgements

Pose tracking by [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker). Rendering by [three.js](https://threejs.org/). VRM support by [three-vrm](https://github.com/pixiv/three-vrm).
