# CameraCharacter v2 — Design

Status: working design. This document is the contract that the implementation follows.
Decisions and their provenance are logged in `decisionlog.md`.

## 1. Goals

1. Drop a rigged humanoid model in (Meshy, Mixamo, VRoid/VRM, Rigify, UE5 Mannequin, Character Creator, generic Blender) and inhabit it from a webcam within seconds, with no manual bone mapping in the common case.
2. Robust retargeting: no twisted limbs, no "candy-wrapper" rolls, no upside-down heads. Works whether the rig's bind pose is a T-pose, an A-pose, or something stylized.
3. Graceful degradation: as the user gets closer to the camera and fewer landmarks are visible, the animation reduces gracefully (upper body only, then head/arms only) instead of snapping, and a "mirror" virtual camera frames the model the way the webcam frames the user.
4. Calibration that is automatic by default, refinable by the user, and debuggable with a one-click diagnostic snapshot that a human or an LLM can read.
5. Recording: raw landmark takes (re-targetable later onto any model), retargeted animation as a GLB with the model and optional scene ("3D video asset"), BVH for DCC tools, and 2D video of the viewport.
6. Runs in the browser with no server. An optional Python provider streams the same protocol for OpenCV-based or multi-machine setups.

Non-goals for v2: multi-person tracking, physics/spring bones, full facial animation pipelines (basic blendshape passthrough only), IK foot planting (roadmap).

## 2. Architecture

```
PoseSource ──▶ PoseFrame ──▶ PoseFilter ──▶ BodyModel ──▶ Retargeter ──▶ Rig (three.js bones)
 (MediaPipe web |            (One Euro,     (per-bone       (world-delta        │
  WebSocket |                 hysteresis,    measured basis   solver, degrade,   ▼
  Recording)                  mirror)        + confidence)    calibration)     Stage (scene, MirrorCamera, env)
                                                                                 │
                     Recorders: LandmarkRecorder (.mocap.json)  ClipRecorder ──▶ GLB / BVH   VideoRecorder ──▶ webm
                     Diagnostics: overlay, per-bone error, snapshot bundle
```

Everything runs in the browser (Vite + TypeScript + three.js + `@mediapipe/tasks-vision`). The Python provider (`backend/stream_pose.py`) is an alternative `PoseSource` speaking the same JSON protocol over a WebSocket.

Module layout:

```
src/
  core/        types.ts (PoseFrame, HumanoidBone, HumanoidMap, RigProfile, Settings), math.ts
  tracking/    landmarks.ts, MediaPipeSource.ts, WebSocketSource.ts, RecordingSource.ts, PoseFilter.ts
  rig/         autoMap.ts, restPose.ts, profile.ts, loadModel.ts, glbSkeleton.ts (test reader)
  retarget/    canonical.ts, bodyModel.ts, solver.ts, calibration.ts
  stage/       Stage.ts, MirrorCamera.ts, environment.ts
  record/      LandmarkRecorder.ts, ClipRecorder.ts, exportGlb.ts, exportBvh.ts, VideoRecorder.ts
  diagnostics/ Overlay.ts, BoneError.ts, Snapshot.ts
  app/         App.ts, panels/*.ts, styles.css
backend/       stream_pose.py, requirements.txt
public/        models/sample-meshy.glb, recordings/*.mocap.json (synthetic), mediapipe/ (wasm, copied at build)
tests/         vitest unit tests + fixtures
e2e/           Playwright tests
```

## 3. Coordinate conventions

MediaPipe pose landmarks (both `worldLandmarks` and normalized `landmarks`) use image conventions: x to the image right, y down, z depth with negative toward the camera. World landmarks are in meters with origin at the hip midpoint. Normalized landmarks are in [0,1] of the image, with z in roughly the same scale as x.

Conversion to three.js (Y-up, right-handed): `(x, y, z) → (x, -y, -z)`.

After conversion, for a subject facing the camera: the subject's anatomical **left** side is at **+X** and the subject **faces +Z** (toward the viewer). A standard three.js/glTF humanoid also faces +Z with its left side at +X. So the raw, un-mirrored mapping is "actor mode": the subject's left arm drives the model's left arm and the model faces the viewer like a person standing in front of them.

**Mirror mode** (default on) negates X of every landmark and swaps left/right labels. The model then behaves like a mirror: raise your right hand and the arm on the same side of the screen rises. Mirror mode is a property of the pipeline, not of the video (MediaPipe always runs on the un-flipped frame so its left/right labels stay anatomically correct; the webcam preview is flipped for display only).

Model conventions are verified at load (see §5.3): up axis from hips→head, facing from the mean foot/toe direction or from `cross(left→right, up)`. A root correction quaternion is applied if the model faces -Z (VRM 0.x) or is Z-up.

## 4. Canonical humanoid

Bone roles follow the VRM humanoid naming, which is a superset of Mixamo's skeleton:

```
hips, spine, chest, upperChest, neck, head, jaw,
leftShoulder, leftUpperArm, leftLowerArm, leftHand,
rightShoulder, rightUpperArm, rightLowerArm, rightHand,
leftUpperLeg, leftLowerLeg, leftFoot, leftToes,
rightUpperLeg, rightLowerLeg, rightFoot, rightToes,
left/right {Thumb,Index,Middle,Ring,Little}{Metacarpal,Proximal,Intermediate,Distal}  (fingers, optional)
leftEye, rightEye (optional)
```

Required for driving: `hips`, at least one of `spine|chest|upperChest`, `head`, both `upperArm`, both `lowerArm`, both `upperLeg`, both `lowerLeg`. Missing optional bones (shoulder, neck, hands, feet, toes, fingers) degrade gracefully: their motion is absorbed by the nearest mapped ancestor.

For each role the canonical T-pose direction (bone head → bone tail, world, model facing +Z) and canonical "up reference" are:

| role | direction | up reference | plausibility cone |
|---|---|---|---|
| hips | +Y (toward spine) | +Z (forward) | 60° |
| spine/chest/upperChest | +Y | +Z | 60° |
| neck | +Y | +Z | 70° |
| head | +Y | +Z | 70° |
| left/right shoulder | ±X | +Z | 70° |
| left/right upperArm | ±X | +Z (elbow bend normal points −Y… see §6.3) | 100° (T to arms-down) |
| left/right lowerArm | ±X | +Z | 110° |
| left/right hand | ±X | +Y (back of hand) | 110° |
| left/right upperLeg | −Y | +Z | 60° |
| left/right lowerLeg | −Y | +Z | 70° |
| left/right foot | +Z (toward toes), slight −Y | +Y | 80° |
| left/right toes | +Z | +Y | 80° |

The plausibility cone is the maximum angle between the rig's bind-pose bone direction and the canonical direction for the bone to be considered "anatomical". Arms accept anything from T-pose to hanging down (A-pose rigs, relaxed rigs). Out-of-cone bones are flagged and driven in *relative* mode (§6.2).

## 5. Rig analysis

### 5.1 Loading

Formats: `.glb/.gltf` (GLTFLoader with DRACO + KTX2 + Meshopt support), `.fbx` (FBXLoader; Mixamo FBX exports are in centimeters), `.vrm` (three-vrm plugin; humanoid map taken directly from `vrm.humanoid`; VRM 0.x rotated to face +Z). After load: bounding box height is normalized to a target height (default 1.7 m) by scaling the model root, so hips positioning, camera framing and export are unit-consistent. Original scale is remembered for export.

### 5.2 Bone collection

All `Object3D` nodes with `isBone`, or, if a rig has no `SkinnedMesh`/`Bone` objects (some FBX and some GLTF exports use plain nodes), all named nodes under the deepest common ancestor of the skinned meshes' skeleton roots. Nodes with `_end`/`End`/`Nub`/`tip` suffixes are leaf "tail" markers and are used only as tail hints.

### 5.3 Bind pose and rest analysis

The **rest pose is the bind pose**, taken from each skeleton's inverse bind matrices (`Skeleton.pose()`), not from the node transforms in the file. Meshy and some Blender exports store an arbitrary animation frame in the node transforms; the skin weights were painted for the bind pose. Rigs without skins fall back to node transforms.

For every bone we record in rest: world position, world quaternion, and the **rest direction**: toward the mapped child in the humanoid chain if any (e.g. upperArm → lowerArm), otherwise toward the mean of its children, otherwise (leaf: hand, toes, head) a role-specific estimate (hand: continue the lowerArm direction; head: parent-relative +Y; toes/foot: +Z projected). Twist/roll helper bones (`*twist*`, `*roll*`, `*_ik`, `*Nub`) are excluded from chains.

Global checks: up axis (hips→head), facing (from the `foot→toes` mean, else `cross(hipsLeft→hipsRight, up)`), left/right consistency (left bones must have x > right bones in the rest pose after correction), unit scale (height). Anomalies produce warnings shown in the UI and included in the diagnostic snapshot.

### 5.4 Automatic bone mapping

Two independent detectors, then a reconciliation:

**Name detector.** Normalize: lowercase, strip namespace prefixes (`mixamorig\d*:`, `Armature|`, `Armature_`, `DEF-`, `ORG-`, `MCH-`, `J_Bip_[CLR]_`, `J_Sec_`, `Bip01 `, `Bip001 `, `b_`, `bone_`, `CC_Base_`, `Character1_`, `Genesis\d*`, `root|`), split camelCase / snake / dot / space into tokens, detect side tokens (`left|right`, `l|r` as separate tokens, `.L/.R`, `_L/_R`, `L_/R_`, VRoid `L_/R_`, trailing `.l/.r`), map remaining tokens through a synonym lexicon per role (e.g. upperArm: `arm`, `upperarm`, `uparm`, `upper_arm`, `humerus`, `bicep`, `shoulder` when a separate clavicle exists…; lowerArm: `forearm`, `lowerarm`, `elbow`, `ulna`; upperLeg: `upleg`, `thigh`, `upperleg`, `femur`, `hip` (side-qualified); lowerLeg: `leg`, `calf`, `shin`, `knee`, `lowerleg`, `tibia`; foot: `foot`, `ankle`; toes: `toe`, `toebase`, `ball`; spine chain: `spine`, `spine1`, `spine2`, `spine01`, `chest`, `upperchest`, `torso`, `abdomen`, `waist`; hips: `hips`, `hip`, `pelvis`, `root` only when it has leg children; neck/head/jaw; hand; fingers `thumb|index|middle|ring|pinky|little` with digit or `metacarpal|proximal|intermediate|distal` tokens). Numeric suffixes order chain candidates but are **not trusted for spine order**.

**Topology detector.** From the rest analysis: the hips is the bone whose subtree splits into exactly two downward chains (legs, mirrored in x) and one upward chain (spine), chosen by score (children count, direction, symmetry). The spine chain follows single-child links upward until the first node whose subtree contains both a left and a right arm chain and a head chain; that node is `upperChest` if the chain has ≥3 links, `chest` if 2, `spine` if 1 (the rest of the chain fills `spine`, `chest` in order from the hips). Arm chains: from the branch node, a sideways chain; if 4+ links, the first short link is `shoulder`; then `upperArm`, `lowerArm`, `hand`; further branching = fingers, sorted by rest x/z into thumb..little. Legs: `upperLeg`, `lowerLeg`, `foot`, `toes` by chain order; the leg chain may have its own helper bones (twist) skipped by name and by near-zero length. Head chain: `neck` (if ≥2 links), `head`, tail marker ignored. Side from rest x relative to hips.

**Reconciliation.** For each role, if both detectors agree → confidence high. If only one fires → medium, with the name detector winning for shoulder-vs-upperArm ambiguity and fingers, and the topology detector winning for spine ordering and side assignment. Conflicts and unmapped required roles produce warnings. Output is a `HumanoidMap` (role → bone name) with per-role confidence and a list of warnings, persisted in the `RigProfile` and editable in the UI (dropdown per role, live). The Meshy sample rig, whose spine is named `Spine02 → Spine01 → Spine` from the hips upward, maps correctly because topology decides order.

### 5.5 Rig profile

```ts
interface RigProfile {
  version: 2;
  fingerprint: string;            // hash of sorted "bone<parent" pairs
  displayName: string;
  map: HumanoidMap;               // role -> bone name
  confidence: Partial<Record<HumanoidBone, number>>;
  warnings: string[];
  rootCorrection: [x,y,z,w];      // applied to model root (facing/up fixes)
  scale: number;                  // applied to reach target height
  bones: Partial<Record<HumanoidBone, {
    mode: 'auto' | 'relative' | 'calibrated' | 'off';
    rollOffsetDeg: number;        // user twist trim about the bone axis
    smoothing?: number;
  }>>;
  calibration?: PoseCalibration;  // optional per-user reference (see §7)
}
```

Persisted in `localStorage` keyed by fingerprint; importable/exportable as JSON; bundled defaults for well-known rigs (Mixamo, Meshy) ship in `src/rig/presets.ts`.

## 6. Retargeting

### 6.1 Measured bases from landmarks

`BodyModel` converts a filtered `PoseFrame` into, per role, a **measured basis**: a unit direction `d`, a unit up-reference `u` (not parallel to `d`), and a confidence `c ∈ [0,1]`. Landmark indices follow MediaPipe's 33-point pose (nose 0, eyes 1–6, ears 7–8, mouth 9–10, shoulders 11–12, elbows 13–14, wrists 15–16, pinky 17–18, index 19–20, thumb 21–22, hips 23–24, knees 25–26, ankles 27–28, heels 29–30, foot index 31–32).

| role | d | u | notes |
|---|---|---|---|
| hips | up = midShoulder − midHip | forward = cross(up, hipL→hipR)… normalized (right-handed so the subject faces +Z when hips are level) | pelvis yaw and roll from the hip line; pitch from the torso |
| spine, chest, upperChest | slerp between the hips basis and the shoulders basis (shoulder line as right, torso up) by chain fraction | | distributes twist across the spine |
| neck | midShoulder → midEar | head forward | |
| head | midEar → (midEye + top estimate) i.e. up from ears toward eyes rotated; simpler: up = cross(right, forward) with right = earL→earR, forward = nose − midEar | forward | replaced by the FaceLandmarker facial transformation matrix when face tracking is enabled |
| shoulder | shoulder point is inferred: midShoulder(+chest offset) → shoulder | torso forward | driven at a fraction (0.3) of the upperArm swing |
| upperArm | shoulder → elbow | bend-plane normal `cross(shoulder→elbow, elbow→wrist)` when the elbow angle > 12°, else inherit the torso's forward | |
| lowerArm | elbow → wrist | palm normal from (wrist, index, pinky) when the hand landmarks are confident, else the upperArm's u | palm normal gives forearm pronation |
| hand | wrist → mid(index, pinky) | palm normal | replaced by HandLandmarker data when enabled |
| upperLeg | hip → knee | bend normal `cross(hip→knee, knee→ankle)` when knee angle > 12°, else torso forward | |
| lowerLeg | knee → ankle | foot direction `heel→footIndex` projected, else upperLeg's u | |
| foot | heel → footIndex | up = cross(right-ish, d) using ankle→knee | |
| toes | foot direction | same | |

Confidence per role is the minimum of the smoothed visibilities of its landmarks, passed through a hysteresis gate (on ≥ 0.65, off ≤ 0.45, 250 ms hold) so limbs never flicker.

Fallbacks: elbow lost but shoulder and wrist visible → a two-bone solve (using the model's upperArm/lowerArm lengths and the last-known bend normal) produces upperArm and lowerArm directions; likewise for knees. Wrist lost → lowerArm holds, then relaxes.

### 6.2 Reference bases

For each role we also need a **reference basis** `(d_ref, u_ref)`: the human basis that corresponds to the model's bind pose. Three modes, chosen per bone by the rig analysis and overridable in the profile:

* **auto** (default for anatomical bones): `d_ref` = the model's bind-pose bone direction; `u_ref` = the canonical up rotated by the minimal rotation from the canonical direction to `d_ref`. This assumes the model's bind pose is one a human could stand in (T-pose, A-pose, relaxed arms, bent elbows are all fine). Under this mode a user standing in a T-pose puts any T- or A-pose rig into a T-pose.
* **relative** (default for non-anatomical bones, e.g. the sample Meshy rig's stub thigh bone): `d_ref` = the canonical *human* rest direction (thigh −Y, shin −Y, arms hanging −Y…), so when the user stands normally the model shows its own designed rest pose and user motion is applied as a delta.
* **calibrated**: `d_ref,u_ref` measured from the user while mimicking the model's rest pose (§7). This is the escape hatch for stylized rigs and for correcting systematic tracking bias.

`rollOffsetDeg` rotates `u_ref` about `d_ref` to trim twist.

### 6.3 Solve

For each mapped role in parent-first order (hips, spine…, neck, head, shoulders, upper/lower arms, hands, upper/lower legs, feet, toes, fingers):

```
F_ref  = orthonormal frame from (d_ref, u_ref)          // columns: d, cross(u,d) normalized, u'
F_meas = orthonormal frame from (d, u)
R      = F_meas · F_refᵀ                                  // world rotation taking ref to measured
if u has low confidence: R = swingOnly(R, d_ref) + dampedTwist   // twist about the bone axis eased toward 0
Q_world_target = R · Q_world_rest(bone)                    // world-delta from bind pose
Q_local_target = inverse(Q_world_parent_now) · Q_world_target
bone.quaternion.slerp(Q_local_target, k)                   // k from confidence, smoothing, motion speed
Q_world_now(bone) = Q_world_parent_now · bone.quaternion   // maintained by the solver, not by updateMatrixWorld
```

`Q_world_parent_now` is the solver-maintained world quaternion of the mapped parent chain, seeded from the model root's world quaternion once per frame. Because the delta is applied in world space on top of the bind-pose world orientation, the rig's local axis conventions (bones along +Y, +X, arbitrary roll) never enter the math, which is what the previous implementation got wrong. Unmapped intermediate bones (e.g. an unmapped `neck` between chest and head) keep their bind-pose local rotation and simply follow their parent; the solver's world chain accounts for them by composing their rest local rotations.

Spine distribution: the torso rotation from hips to upperChest is distributed along the mapped spine chain by slerping the hips→shoulders basis delta with cumulative weights (e.g. 0.35/0.35/0.3), so bending and twisting look continuous.

Hips translation (modes: `locked`, `horizontal`, `full`): from the normalized image landmarks — x from the hip midpoint's image x relative to center, y from the hip image y relative to the calibrated standing baseline, depth from the apparent torso size (shoulder-to-hip distance in image space vs baseline, converted via the model's torso length). Applied to the hips bone position with smoothing; clamped so feet never go far below the floor.

Per-bone smoothing is a critically damped slerp with a rate that increases with angular velocity (responsive on fast motion, calm when still). Confidence weighting: `k = k_base · c`; when `c → 0` the bone relaxes toward its rest local rotation at `relaxRate` after `holdMs`.

### 6.4 Degradation policy

* Visible: full body → everything drives.
* Knees/feet lost (waist-up framing): legs relax to rest; hips vertical locked; torso, arms, head continue.
* Elbows/wrists partially lost: two-bone fallback, then hold, then relax.
* Only head/shoulders (close-up): head, neck, shoulders, upper spine drive; arms relax; hips locked.
* Nothing tracked for > 1.5 s: whole body eases to rest ("idle"), status shows "no subject".

The status panel shows a body diagram with per-part confidence so the user sees why something stopped moving.

## 7. Calibration

Three layers, from automatic to assisted:

1. **Rig auto-calibration** (every load, no user action): mapping, bind-pose analysis, plausibility flags, unit/facing corrections, per-bone mode selection. Result: `RigProfile`.
2. **Pose calibration** (optional, per user, ~3 s): the UI puts the model into its bind pose next to the webcam preview and asks the user to match it (mirror-style), counts down, and averages `(d, u)` per role over 60 frames to produce `PoseCalibration` (reference bases, shoulder width, standing hips baseline, torso apparent size). Bones then use `calibrated` mode when enabled. Stored per user in `localStorage`, cleared with one click. Skipping it is fine: `auto` works for standard rigs.
3. **Diagnostic snapshot** (assisted loop): one click captures a composite PNG (webcam frame with landmark overlay | 3D view of the model with the measured landmark skeleton drawn in world space over it | per-bone error bars) plus a JSON bundle (profile, mapping with confidences, warnings, rest directions, measured bases, solved directions, per-bone angular error, settings, library versions). The user can hand the bundle to a developer or an LLM to diagnose mapping/twist problems for a new rig family; the fix lands as a lexicon entry, a preset, or a profile tweak. This is a development-time loop, not a runtime dependency.

Self-check: the **per-bone error** is the angle between the measured direction `d` and the solved bone's actual world direction (child position − bone position). In `auto` mode with a mapped child it should be < 5°; larger values flag mapping errors, roll issues, or missing parents, and are highlighted in the UI.

## 8. Stage and mirror camera

`Stage` owns the renderer, lights, floor/grid, shadow settings, environment and resize. Camera modes:

* **orbit**: user-controlled OrbitControls.
* **mirror** (default): continuous framing. From the confidently visible image landmarks, take the vertical extent `[yTop, yBottom]` (normalized image coords) and the roles bounding it; look up the corresponding model heights (head top, eyes, shoulders, hips, knees, ankles interpolated), and solve the camera distance and height so that the model's visible extent fills the same vertical fraction of the viewport as the user's extent fills the camera frame, with a margin. Horizontal target follows the hips. Camera distance and target are driven by critically damped springs; distance is clamped to `[0.6, 6]` m; when tracking is lost the camera eases back to the full-body default.
* **follow**: keeps the full body framed but pans with the hips.

Environment: a GLB scene can be loaded and placed; the model stands at the origin (or at the environment's `spawn` empty if present). The environment can be included in the GLB export.

## 9. Recording and export

* **Landmark take** (`.mocap.json`): PoseFrame v2 stream with timestamps, source info, mirror flag, optional hands/face. Replayable through `RecordingSource` (play/pause/scrub/loop/speed), which means any take can be re-targeted to a different model later. Recording the raw stream is cheap and lossless.
* **Animation clip**: `ClipRecorder` samples every mapped bone's local quaternion and the hips position at a fixed rate (30 or 60 Hz) into `THREE.AnimationClip` tracks. Export via `GLTFExporter` (binary) with the model (skin, materials) and the clip embedded, optionally with the environment: a self-contained "3D video asset" playable in any glTF viewer, Blender, Unity, Unreal, three.js.
* **BVH**: hierarchy of the mapped humanoid bones (rest offsets in model units), `CHANNELS 6` on hips (Xposition Yposition Zposition Zrotation Xrotation Yrotation), `CHANNELS 3` elsewhere, one line per sampled frame. Imports into Blender/Maya/MotionBuilder.
* **Video**: `canvas.captureStream(fps)` + `MediaRecorder` → `.webm` (VP9/Opus if available). Optional webcam picture-in-picture composited via an offscreen canvas.

## 10. Protocol: PoseFrame v2

Used by `WebSocketSource`, `RecordingSource`, and the Python provider. Coordinates are **raw MediaPipe conventions** (the browser converts); arrays are compact.

```json
{
  "v": 2,
  "t": 12345.678,                       // ms, monotonic per source
  "src": "mediapipe-web" | "python-opencv" | "recording",
  "size": [1280, 720],                  // capture size in px
  "pose": {
    "world": [[x, y, z, visibility] × 33],
    "image": [[x, y, z, visibility] × 33]
  },
  "hands": { "left": {"world": [[x,y,z] × 21], "image": [[x,y,z] × 21]}, "right": {...} } | null,
  "face": { "blendshapes": {"jawOpen": 0.21, ...}, "matrix": [16 numbers, column-major] } | null
}
```

A recording file is `{"format": "cameracharacter-mocap", "version": 2, "meta": {...}, "frames": [PoseFrame...]}`.

## 11. Tracking sources

* **MediaPipeSource** (browser): `PoseLandmarker` in `VIDEO` running mode with `delegate: 'GPU'` and automatic fallback to `CPU`; model variants lite/full/heavy selectable (default full). WASM files are served from `public/mediapipe/` (copied from `node_modules/@mediapipe/tasks-vision/wasm` at build) so the app works offline after the first model download; `.task` models are fetched from Google's storage and cached with the Cache API, with an option to self-host under `public/models/mediapipe/`. Optional `HandLandmarker` and `FaceLandmarker` (blendshapes + facial transformation matrix) run at reduced cadence (every 2nd/3rd frame) when enabled. Inference runs off the render loop via `requestVideoFrameCallback`; results are timestamped.
* **WebSocketSource**: connects to `ws://host:port`, parses PoseFrame v2, exponential reconnect.
* **RecordingSource**: plays `.mocap.json`, honors timestamps, supports scrub/loop/speed; also used by tests.

`PoseFilter` applies a One Euro filter per landmark coordinate (min cutoff 1.0 Hz, beta 0.02 default, tunable in the Smoothing panel), the visibility hysteresis gate, and the mirror transform.

## 12. UI

Single page. The 3D viewport fills the window. A draggable webcam picture-in-picture shows the flipped preview with the landmark overlay. A collapsible right panel has sections: **Source** (camera picker, resolution, model variant, hands/face toggles, WebSocket URL, recording file), **Model** (drop zone / file picker / sample models; mapping table: role, detected bone, confidence, dropdown override; warnings), **Calibration** (calibrate pose with countdown, per-bone mode and roll trim, reset, snapshot), **Stage** (mirror on/off, camera mode, hips translation mode, environment load, floor/grid, background), **Smoothing** (One Euro parameters, bone smoothing, hold/relax times), **Recording** (record take / clip / video, export GLB / BVH / JSON, load take), **Status** (FPS for inference and render, tracking quality body diagram, per-bone error when diagnostics are on).

URL parameters for automation and demos: `?source=recording&file=/recordings/arm-raise.mocap.json&model=/models/sample-meshy.glb&autoplay=1&diagnostics=1&camera=mirror`.

## 13. Testing

* **Unit (Vitest, Node)**: math (frame construction, swing/twist, One Euro, springs); auto-mapper against name-list fixtures (Mixamo, Meshy incl. reversed spine, Rigify DEF-, UE5 Mannequin, VRoid, Character Creator 4, Blender generic, ambiguous/partial rigs); rest analysis and solver on synthetic rigs built in code (T-pose, A-pose, Z-up, cm-scale, bent-elbow, stylized) and on the real sample GLB read by a minimal GLB skeleton reader; solver property tests using a synthetic landmark generator: after solving, each driven bone's world direction matches the input direction within 2° in auto mode; degradation tests (dropping landmarks never produces NaN or discontinuities > threshold).
* **End-to-end (Playwright, headless Chromium with SwiftShader WebGL)**: load the app with URL parameters against synthetic recordings and the sample model; assert no console errors, diagnostics report per-bone error under threshold, mirror camera converges; save screenshots for visual inspection by the developer/LLM.
* **Manual**: live webcam sessions by the user, with diagnostic snapshots fed back.

## 14. Python provider (optional)

`backend/stream_pose.py`: OpenCV capture → `mediapipe.tasks.python.vision.PoseLandmarker` (VIDEO mode, lite/full/heavy) → PoseFrame v2 JSON over `websockets` on `ws://0.0.0.0:8765`. Flags: `--camera`, `--width/--height`, `--model`, `--port`, `--preview`. No GUI framework; the browser app is the UI. Requirements: `mediapipe>=1.0`, `opencv-python`, `websockets`, `numpy`.

## 15. Roadmap (after v2)

Foot IK / ground contact, VRM spring bones, full ARKit blendshape mapping for models that have them, multi-person, WebGPU renderer, OSC/VMC protocol output for other tools, take management (multiple takes, trimming), scene authoring (camera paths, lights).
