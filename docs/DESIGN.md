# CameraCharacter v2 — Design (revision 2.1)

Status: working design after an adversarial review (seven lenses; findings folded in on 2026-09-19). This document is the contract that the implementation follows. Decisions and their provenance are logged in `decisionlog.md`.

## 1. Goals

1. Drop a rigged humanoid model in (Meshy, Mixamo, VRoid/VRM, Rigify, UE5 Mannequin, Character Creator, Daz, generic Blender, the bundled sample pack) and inhabit it from a webcam within seconds, with no manual bone mapping in the common case.
2. Robust retargeting: no twisted limbs, no "candy-wrapper" rolls, no upside-down heads. Works whether the rig's bind pose is a T-pose, an A-pose, arms-down, or stylized.
3. Graceful degradation: as the user gets closer to the camera and fewer landmarks are visible, the animation reduces gracefully (upper body only, then head/shoulders, then face) instead of snapping, and a "mirror" virtual camera frames the model the way the webcam frames the user.
4. Calibration that is automatic by default, refinable by the user, and debuggable with a one-click diagnostic snapshot that a human or an LLM can read.
5. Recording: raw landmark takes (re-targetable later onto any model), retargeted animation as a GLB with the model and optional scene ("3D video asset"), BVH for DCC tools, and 2D video of the viewport.
6. Runs in the browser with no server. An optional Python provider streams the same protocol for OpenCV-based or multi-machine setups.

Non-goals for v2: multi-person tracking, physics/spring bones, full facial animation pipelines (basic blendshape passthrough only), IK foot planting (roadmap).

## 2. Architecture

```
PoseSource ──▶ PoseFrame ──▶ PoseFilter ──▶ BodyModel ──▶ Retargeter ──▶ Rig (three.js bones)
 (MediaPipe web |            (mirror,       (per-bone       (world-delta        │
  WebSocket |                 gating,        measured basis   solver, degrade,   ▼
  Recording |                 One Euro)      + confidence,    calibration)     Stage (scene, MirrorCamera, env)
  Synthetic)                                 framing state)                      │
                     Recorders: LandmarkRecorder (.mocap.json)  ClipRecorder ──▶ GLB / BVH   VideoRecorder ──▶ webm/mp4
                     Diagnostics: overlay, per-bone error, snapshot bundle
```

Everything runs in the browser (Vite + TypeScript + three.js + `@mediapipe/tasks-vision`). The Python provider (`backend/stream_pose.py`) is an alternative `PoseSource` speaking the same JSON protocol over a WebSocket.

Module layout:

```
src/
  core/        types.ts (PoseFrame, HumanoidBone, HumanoidMap, RigAnalysis, RigProfile, Settings), math.ts
  tracking/    landmarks.ts, PoseSource.ts, MediaPipeSource.ts, WebSocketSource.ts, RecordingSource.ts,
               SyntheticSource.ts, PoseFilter.ts, convert.ts, protocol.ts, mediapipeModels.ts, camera.ts
  rig/         skeletonGraph.ts (bind pose), boneNames.ts, topology.ts, autoMap.ts, restPose.ts, profile.ts,
               loadModel.ts, glbSkeleton.ts (Node reader for tests)
  retarget/    canonical.ts, bodyModel.ts, solver.ts, calibration.ts, framing.ts
  stage/       Stage.ts, MirrorCamera.ts, environment.ts
  record/      LandmarkRecorder.ts, ClipRecorder.ts, exportGlb.ts, exportBvh.ts, VideoRecorder.ts
  diagnostics/ Overlay.ts, BoneError.ts, Snapshot.ts
  testing/     syntheticHuman.ts (parametric human → MediaPipe-style landmarks)
  app/         App.ts, panels/*.ts, styles.css
backend/       stream_pose.py, selftest.py, requirements.txt, README.md
public/        models/*.glb (samples), mediapipe/wasm (copied at build), recordings/ (generated)
tests/         vitest unit tests + fixtures
e2e/           Playwright tests
```

Pure modules (no DOM, testable in Node): core, rig except loadModel, retarget, record/exportBvh, tracking/convert + protocol + PoseFilter + RecordingSource, testing.

## 3. Coordinate conventions

MediaPipe pose landmarks (both `worldLandmarks` and normalized `landmarks`) use image conventions: x to the image right, y down, z depth with negative toward the camera. World landmarks are in meters with origin at the hip midpoint. Normalized landmarks are in [0,1] of the image, with z in roughly the same scale as x.

Conversion to three.js (Y-up, right-handed): `(x, y, z) → (x, -y, -z)`. This is a proper rotation (180° about X), so handedness is preserved.

After conversion, for a subject facing the camera: the subject's anatomical **left** side is at **+X** and the subject **faces +Z** (toward the viewer). A standard three.js/glTF humanoid also faces +Z with its left side at +X. So the raw, un-mirrored mapping is "actor mode": the subject's left arm drives the model's left arm and the model faces the viewer like a person standing in front of them. Pelvis forward = `cross(up, hipLeft→hipRight)` = +Z for a level, camera-facing subject.

**Mirror mode** (default on) is a pipeline step (in `PoseFilter`), never a video operation: MediaPipe always runs on the un-flipped frame so its left/right labels stay anatomically correct; only the preview is flipped. Rules:

* world landmarks: `x → −x`, then swap left/right landmark indices;
* image landmarks: `x → 1 − x`, then swap indices;
* hands: swap the `left`/`right` entries, then negate x of their points;
* face blendshapes: swap `Left`/`Right` in names; face rotation `R → S·R·S` with `S = diag(−1, 1, 1)` (still a proper rotation).

`mirror(mirror(frame)) == frame` is a unit test. Recordings store raw (un-mirrored, unfiltered) frames; mirror and filtering are replay-time steps.

Model conventions are verified at load (§5.5). A root correction quaternion is applied if the model is Z-up or faces −Z.

## 4. Canonical humanoid

Bone roles follow the VRM humanoid naming (a superset of Mixamo's skeleton); see `src/core/types.ts` (`HUMANOID_BONES`, `HUMANOID_PARENT`).

Required for driving: `hips`, at least one of `spine|chest|upperChest`, `head`, both `upperArm`, both `lowerArm`, both `upperLeg`, both `lowerLeg`. Missing optional bones (shoulder, neck, hands, feet, toes, fingers) degrade gracefully: their motion is absorbed by the nearest mapped ancestor.

For each role we define a **direction** `d` (bone head → tail) and an **up reference** `u`, in the corrected model frame (Y up, facing +Z, left at +X). The same definitions are used for the measured basis (§6.1), for the rig's bind pose (§6.2 auto mode), and for the canonical T-pose and standing-rest tables below. All up references are **in-plane and side-independent**:

| role | u definition (measured the same way on landmarks and on the rig's bind skeleton) |
|---|---|
| hips, spine, chest, upperChest, neck, head | forward (+Z of the torso / head) |
| shoulder | torso forward |
| upperArm | flexion direction: component of `elbow→wrist` perpendicular to `d`; fallback torso forward when the elbow is straight |
| lowerArm | the hand's dorsal normal; canonical +Y (T-pose palms down) |
| hand | dorsal normal `n = s·cross(wrist→index, wrist→pinky)`, `s = +1` left, `−1` right (after any mirror swap) |
| upperLeg | kneecap direction: **minus** the component of `knee→ankle` perpendicular to `d`; fallback torso forward (knees do not hyperextend: constrain to the forward hemisphere) |
| lowerLeg | component of `heel→footIndex` perpendicular to `d` (foot forward); fallback low confidence |
| foot, toes | component of `ankle→knee` perpendicular to `d` (up) |

Canonical T-pose (`dir`, `up`) and standing rest (`restDir`, `restUp`), with the plausibility cone (max angle between a rig's bind direction and `dir` for the bone to count as anatomical):

| role | T-pose dir | T-pose up | cone | standing dir | standing up |
|---|---|---|---|---|---|
| hips, spine, chest, upperChest | +Y | +Z | 60° | +Y | +Z |
| neck, head | +Y | +Z | 70° | +Y | +Z |
| shoulder | ±X | +Z | 75° | ±X (slightly down) | +Z |
| upperArm | ±X | +Z | 110° | −Y (0.2 out) | +Z |
| lowerArm | ±X | +Y | 120° | −Y | ±X (dorsal outward, palms facing the thighs) |
| hand | ±X | +Y | 120° | −Y | ±X |
| upperLeg | −Y | +Z | 60° | −Y | +Z |
| lowerLeg | −Y | +Z | 70° | −Y | +Z |
| foot | (0, −0.5, 0.85) ankle→ball | +Y | 80° | same | +Y |
| toes | +Z | +Y | 80° | +Z | +Y |

These tables live in `src/retarget/canonical.ts`. A T-pose rig and an A-pose rig both fall inside the arm cone; a stub bone pointing up (the Meshy sample's thigh) does not.

## 5. Rig analysis

### 5.1 Loading

Formats: `.glb/.gltf` (GLTFLoader with DRACO, KTX2 and Meshopt support), `.fbx` (FBXLoader), `.vrm` (three-vrm). Details that matter for the versions we ship:

* **FBX**: the loader does not apply the file's unit scale; it stores `userData.unitScaleFactor` (cm = 1). Materials arrive as Phong/Lambert: convert to `MeshStandardMaterial` (color, map, normalMap, emissive, alphaMap, opacity, transparent, side; roughness 0.75, metalness 0; `map.colorSpace = SRGBColorSpace`) so they light like glTF models and export as PBR. Bone names lose the colon: Mixamo bones arrive as `mixamorigHips`.
* **VRM**: register `new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false })` (otherwise `vrm.update()` overwrites every human bone each frame), read `gltf.userData.vrm`, call `VRMUtils.rotateVRM0(vrm)` for 0.x and then **skip** the facing detector, call `VRMUtils.combineSkeletons(gltf.scene)` before bind-pose analysis, build the humanoid map from `vrm.humanoid.getRawBoneNode(role)` (VRM bone names equal ours), and **exclude** the `normalizedHumanBonesRoot` proxy subtree from bone collection. Keep calling `vrm.update(dt)` after the solver for spring bones and expressions. Exports are plain GLB ("VRM metadata not preserved").
* After analysis, the loader root is placed under a **wrapper Group** that carries the height normalization scale and the root correction. Nothing inside the loaded hierarchy is rescaled.

### 5.2 Bone collection

Collect **all named descendants** of the loaded root (not only `isBone` nodes: GLTFLoader marks only skin joints as bones, so tail markers such as `HeadTop_End` may be plain nodes, and FBXLoader marks `LimbNode`s). Role candidates are restricted to **skin joints with total skin weight > 0** (sum `skinWeight` per joint index once at load). Zero-weight leaves are available as tail hints.

Multiple skeletons: group skins that share ≥ 1 joint; run detection per group; use the group with the largest summed skin weight and report others as "secondary skeleton ignored". If both `DEF-` and `ORG-`/`MCH-`/unprefixed duplicates exist (full Rigify export), only the `DEF-` set (the weighted one) is eligible.

### 5.3 Bind pose

The rest pose is the **bind pose**, recovered from each skeleton's inverse bind matrices. `Skeleton.pose()` must **not** be used: for a joint whose parent is not a bone it copies the bind world matrix into the local matrix, which double-applies any transform on a non-bone ancestor (the sample rig's `BaseArmature` has a +90° X rotation; Blender, Meshy, FBX and rotated VRM roots all hit this).

Procedure (`skeletonGraph.applyBindPose`), run with the loader root at identity and before any normalization:

1. `G_i = inverse(boneInverses[i])` is joint *i*'s bind world matrix in loader-root space (valid for GLTFLoader, which binds with the identity matrix, and for FBXLoader, whose inverses come from cluster TransformLink and bind with the mesh world matrix; three's skinning is Σw·(boneWorld·boneInverse)·bindMatrix).
2. Parent bind world `P`: the parent's own `G` if it is a joint of the same skeleton, else the parent's actual `matrixWorld` from the file's node transforms (after `root.updateMatrixWorld(true)`).
3. `bone.matrix = inverse(P)·G_i`, decomposed into position/quaternion/scale, parents first; joints shared by several skins keep the first bind transform (warn if inverse bind matrices disagree by > 1e−3).
4. Non-bone ancestors keep their file transforms.

Rigs without skins keep node transforms. After the wrapper's scale and root correction are set, `updateMatrixWorld(true)` runs once and rest world positions/quaternions are read from `matrixWorld` in the final scene frame; that frame is what the solver seeds from (§6.3). A unit test on `sample-meshy.glb` checks that after `applyBindPose` every joint's world matrix equals `inverse(IBM)` (hips world y ≈ 0.57).

### 5.4 Automatic bone mapping

Two detectors, then reconciliation. **Topology finds the skeleton's structure; names classify bones into limb classes and sides; roles within a class come from chain order.**

**Helper classification (before anything else).** On whole tokens, never substrings:

* *Tail marker* = leaf node with a token in {`end`, `_end`, `nub`, `tip`, `site`, `leaf`} or a Mixamo-style finger tip (`Thumb4`, `Index4` with no children), and zero skin weight. `bend` is never a marker token (Genesis `lShldrBend` is a primary bone).
* *Segment/twist merge*: a bone with a `twist|roll` token or a `.NNN` numeric segment suffix is merged into its parent (skipped, kept as an unmapped intermediate) only when its **stem** (name minus side/twist/segment tokens) equals the parent's stem: `lShldrTwist` after `lShldrBend`, `DEF-upper_arm.L.001` after `DEF-upper_arm.L`, `upperarm_twist_01_l` under `upperarm_l`. A twist-named bone whose stem differs from its parent and that lies on the unique path to an extremity (Character Creator `CC_Base_NeckTwist01 → NeckTwist02 → Head`) is a real chain link and stays.
* *Ignore class* (precedence over any lexicon match): `^ik_|_ik$|_ik_|^mch|ctrl|_ctl|con_|pole|target|_fk$|tweak|prop|weapon|socket|attach|center_of_mass|interaction|camera|heel|sole|ankle_bck|ankle_fwd`, VRoid `J_Sec_`/`J_Adj_`/`J_Opt_`, hair/skirt/breast/tail/wing/eye-lid tokens. Side-branch correctives (UE5 `*_correctiveRoot_*`, `*_bicep/tricep/out/in/fwd/bck_*`, `clavicle_out/scap/pec_*`, `wrist_inner/outer_*`, `calf_knee*`, Rigify `heel.02.L`, `DEF-breast.*`) never lie on an extremity path and fall out of the topology step automatically.

**Name detector** (`boneNames.ts`). Normalize: strip only true namespace prefixes (`mixamorig\d*:?`, `J_Bip_` keeping the following `C_/L_/R_` as the side token, `DEF-`, `ORG-`, `MCH-`, `CC_Base_`, `Character1_`, `Genesis\d*(Female|Male)?_?`, `Bip0?0?1 `, `b_`, `bone_`; **not** `Armature|`, `Armature_`, `root|`), split camelCase / snake / dot / space / digits, detect side tokens (`left|right`, `l|r` as separate tokens, `.L/.R`, `_L/_R`, `L_/R_`, leading `l`/`r` glued to a capitalized word as in Daz `lShldrBend`, UE5 `_l/_r`). Tokenize **longest phrase first** over a phrase table (`forearm`, `upleg`, `toebase`, `headtop`, `upperarm`, `lowerarm`, `upperchest`, `shldr`, …). Output per bone is a **class + side + ordinal hint**, not a role:

* `torso`: `hips|hip|pelvis|abdomen|waist|torso|spine*|chest|upperchest|neck|head`
* `arm(L|R)`: `clavicle|collar|shoulder|shldr|arm|upperarm|humerus|bicep|forearm|elbow|lowerarm|ulna|wrist|hand|palm`
* `leg(L|R)`: sided `hip`, `thigh|upleg|upperleg|femur|leg|knee|shin|calf|lowerleg|tibia|ankle|foot|toe|toebase|ball|metatarsal`
* `finger(side, digit, ordinal)`: `thumb|index|middle|ring|pinky|little` with `1..4` or `metacarpal|proximal|intermediate|distal`; a finger digit token pre-empts `hand`
* `ignore`, `marker` (above), `unknown`

Only two decisions are name-driven: (i) the first arm link is `shoulder` iff the chain has ≥ 4 non-helper links, or its token is `clavicle|collar`, or it is `shoulder` and the next link carries `arm|upperarm|humerus|shldr`; otherwise the first link is `upperArm`; (ii) finger digit identity.

**Topology detector** (`topology.ts`), on the bind-pose graph after helper classification, using an **extremity-path** search rather than child counts:

1. Estimate the up axis (principal axis of joint positions, sign toward the larger cluster of leaves) and, provisionally, the facing (§5.5).
2. Extremities among leaf chains: **feet** = the two leaf-chain ends that are lowest along the up axis, mirrored in x (`|xL + xR| < 0.15·height`), each with ≥ 2 links and total length ≥ 0.25·height (this drops skirts, tails, `heel.02.L`); **hands** = the two leaf-chain ends with the largest |x| (mirror test) not on the leg paths; **head** = lowest common ancestor (LCA) of the remaining highest leaves (hair, `head_end`, `headfront` all collapse to `Head`).
3. `hips = LCA(footL, footR, headLeaf)`; `spineBranch = LCA(handL, handR, headLeaf)`, a proper descendant of hips. Torso chain = path(hips → spineBranch) exclusive of both ends. Intermediate nodes that are not chain-like (Genesis/CC4 `pelvis`, UE5 `spine_04_latissimus` siblings) are unmapped intermediates that the solver composes.
4. Leg chain = path(hips → foot end) minus hips, allowing intermediates before the first link that displaces ≥ 0.05·height from the hips; near-zero length = < 2 % of height. The Meshy stub (6 %) therefore stays `upperLeg`.
5. Arm chain = path(spineBranch → hand); head chain = path(spineBranch → head). Direction tests use **chain end minus chain start**, never the first link.
6. Role assignment by chain order: torso chain of N links → `spine` = link 1, `upperChest` = link N if N ≥ 3, `chest` = link round(N/2) (UE5: spine_01/03/05; Genesis: abdomenLower/chestLower/chestUpper); remaining links unmapped intermediates. Head chain: `head` = the link named `head` if present, else the last link before facial/hair branching; `neck` = first link; middle links unmapped. Arm chain: [`shoulder`], `upperArm`, `lowerArm`, `hand`, then finger chains ordered thumb → little by rest position (thumb: most forward/+Z and closest to the wrist). Leg chain: `upperLeg`, `lowerLeg`, `foot`; `toes` = the link with a `toe|ball` token else the last link; `metatarsal`/`heel` intermediates unmapped.

**Sides and facing (one joint decision).** (1) If the name detector yields consistent side tokens on the arm and leg chains (≥ 4 sided bones, no contradictions), sides come from names and facing is derived so that named-left has x > named-right (`forward = cross(up, right→left)`); cross-check with `foot→toes` when available and warn on disagreement (do not flip). (2) If names are unsided, use `foot→toes` or a `headfront`/`*_front` marker for facing, then x-sign for side. (3) Else assume +Z facing, assign side from x, and emit a "facing assumed" warning; the mapping panel has a one-click "swap sides".

**Reconciliation.** Chain-order roles are the result; name classes constrain which chain a bone may belong to (a bone classified `armL` is never assigned a leg role) and decide the two name-driven choices above. Confidence: class and chain agree → 0.95; chain only (unsided/unknown names) → 0.7 ("topology only" shown in the table); name-only candidates that violate hierarchy consistency (must be a descendant of the mapped parent role and an ancestor of the mapped child role) are dropped with a warning. Required roles missing → warning. The sample's scrambled `skeleton.glb` (`neck` below the arm branch, `Spine1` above it) maps correctly because the chain decides.

**No-knee / stub chains.** If `upperLeg` length < 0.3 × `lowerLeg` length, or the `lowerLeg` head is not below the `upperLeg` head by ≥ 0.2 × leg length, the leg is flagged `noKnee`: `upperLeg` mode = `follow` and `lowerLeg` is driven from the chord hip→ankle (§6.2). The same rule applies to arms (`noElbow`). Warning: "rig has no knee joint on <side> leg; leg driven as one segment".

### 5.5 Rest analysis and global checks

For every mapped role: rest world position and quaternion (final scene frame), **rest direction** toward the mapped child in the humanoid chain, else toward the single zero-weight tail marker child (`head_end`), else the child collinear with the parent link, else a role-specific estimate (hand: continue the lowerArm direction; head: model +Y; toes/foot: forward). Never the mean of all children (Meshy `headfront` would tilt the head 6°). Bone length in scaled units; canonical deviation and `anatomical` flag (§4 cones).

Global: up axis and facing (above), left/right consistency, **source height from the skeleton bind extents** (feet to the top of the head chain including markers) cross-checked with the skinned geometry in bind space, never from node-transform bounding boxes (several sample files have their mesh node posed lying down). `scale = targetHeight / sourceHeight`. A monotonic **height table** for the mirror camera (§8): headTop (skinned-mesh top), eyes, shoulders, hips, knees, ankles from bones only if in canonical order, otherwise interpolated between valid neighbours (e.g. knee := hips + 0.55·(ankle − hips) when the knee bone sits above the hips).

### 5.6 Analysis vs profile

`RigAnalysis` (runtime, recomputed on every load): map, confidence, warnings, family, axes, root correction, scale, source height, per-bone analysis, height table, no-knee flags, `familyKey`, `instanceKey`.

* `familyKey` = hash of the mapped humanoid subgraph (role → normalized bone name and role parent relations), excluding markers/helpers/meshes. Shared by every Mixamo character, every rig from the sample pack, etc. Used for bundled presets and lexicon-level overrides.
* `instanceKey` = familyKey + quantized bind signature (per mapped bone: rest direction rounded to 5° and length to 1 cm in height-normalized units). Used for roll trims, per-bone modes, calibration and sockets.

`RigProfile` (persisted) stores **user intent only**: map overrides (role → bone name), per-bone settings (mode, roll trim, smoothing), sockets, calibration, display name. It is applied as a diff over the auto result, only where the referenced bone still exists. Scale, root correction, confidences and warnings are never persisted. Bundled presets are lexicon entries and family-level map overrides in `src/rig/presets.ts`.

## 6. Retargeting

### 6.1 Measured bases from landmarks

`BodyModel` converts a filtered `FilteredPose` into, per role, a **measured basis**: unit direction `d`, unit up reference `u`, confidence `c` (landmarks), and up confidence `c_u`. Landmark indices are MediaPipe's 33-point pose (see `landmarks.ts`).

| role | d | u (per §4) |
|---|---|---|
| hips | midHip → midShoulder | pelvis forward = `cross(up, hipL→hipR)`; yaw/roll from the hip line |
| spine, chest, upperChest | (not measured separately; see distribution §6.3) | shoulders basis: right = shoulderL→shoulderR, up = midHip→midShoulder |
| neck | midShoulder → midEar | head forward |
| head | up = `cross(earL→earR, forward)` with forward = midEye − midEar orthogonalized | forward; replaced by the FaceLandmarker matrix when face tracking is on |
| shoulder | midShoulder → shoulder landmark | torso forward; driven at 30 % of the upperArm swing |
| upperArm | shoulder → elbow | flexion direction (perp component of elbow→wrist), blended with torso forward by `w = smoothstep(8°, 20°, bendAngle)`; `c_u = w·c` |
| lowerArm | elbow → wrist | hand dorsal normal when hand landmarks are confident; else `c_u` low (twist decays) |
| hand | wrist → mid(index, pinky) | dorsal normal; HandLandmarker data when enabled |
| upperLeg | hip → knee | kneecap direction (forward hemisphere), blended with torso forward by the same `w`; `c_u = w·c` |
| lowerLeg | knee → ankle | perp component of heel→footIndex |
| foot | ankle → footIndex | perp component of ankle→knee |
| toes | heel → footIndex (horizontal) | same |

Bend normals keep the previous frame's value and reject a new one that differs by > 90° unless the bend angle > 45° (a real fast fold). The elbow/knee bend angle itself is filtered.

**Confidence and gating** (in `PoseFilter`, per landmark): visibility EMA (120 ms); `inFrame = x ∈ [−0.03, 1.03] ∧ y ∈ [−0.03, 1.03]`; the gate opens only if `inFrame ∧ ema ≥ on` for ≥ 150 ms (dwell) and releases when `¬inFrame` for 100 ms or `ema ≤ off` for ≥ 250 ms. Thresholds: body/arms 0.65/0.45; feet, heels, toes 0.50/0.30; face landmarks 0.80/0.60. One Euro filters are frozen while a landmark's gate is closed and reset when it reopens (re-entry starts from the true position). Role confidence `c = smoothstep((minEma − off)/(on − off))` over the role's landmarks, times the re-acquisition ramp (0 → 1 over 300 ms after the pose returns).

**Fallbacks.** Elbow (or knee) lost but shoulder (hip) and wrist (ankle) visible → two-bone solve using the **user's** segment lengths (running medians of world-landmark distances while all three are gated; disabled until 60 samples), only when `r = |S−W| / (L1+L2) ∈ [0.55, 0.98]` and the S→W direction has |z| < 0.7; the elbow is placed on the solution circle nearest the last elbow position; the stored bend normal decays toward torso forward over 1 s; knees never bend backward. In the ambiguous visibility band the extrapolated MediaPipe joint is blended 50/50 with the solve. Otherwise the limb holds for `poseHoldMs` (arms/hands 700, legs/feet 1000, torso 300) and then relaxes toward rest at `relaxRate`.

**Hips lost** (seated, cropped at the waist): the pelvis holds its last orientation and eases (2 s) to yaw = shoulder-line yaw, roll 0, pitch 0; the spine chain is driven from the shoulders basis relative to that pelvis; legs relax; hips translation locks. When hip visibility is in the ambiguous band, hip-line yaw is blended with shoulder yaw. A synthetic seated frame with hips jittered ±3 cm must move the head yaw < 2°.

### 6.2 Reference bases

For each role we also need a **reference basis** `(d_ref, u_ref)`: the basis that corresponds to the model's bind pose, using the same definitions as §4. Modes, chosen per bone by the rig analysis and overridable in the profile:

* **auto** (limbs, when anatomical): run the **same estimators as §6.1 on the rig's bind skeleton**, with bind joint positions in place of landmarks (shoulder = upperArm head, elbow = lowerArm head, wrist = hand head, hip = upperLeg head, knee = lowerLeg head, ankle = foot head, foot direction = foot→toes, torso forward = model +Z). This yields `d_ref` and `u_ref` with identical conventions by construction, including the bind bend direction when the bind elbow/knee angle > 12° (the Meshy sample's elbows flex 55° "down": the user's flexion direction maps onto the rig's hinge). Only when the rig's geometry does not define `u` (straight bind elbow, no hand child) fall back to the canonical up min-rotated to `d_ref`.
* **relative** (torso chain by default; stub bones): `(d_ref, u_ref)` = the standing-rest columns of §4 in the corrected model frame. The user's deviation from that rest is applied on top of each bone's bind orientation, which preserves designed curvature (the sample's neck bone points 45° forward; a curved spine stays curved). Precondition: the bone's bind pose corresponds to what a standing human's bone does; the analysis selects relative for torso roles and for out-of-cone bones with a short subtree; other out-of-cone bones get `auto` plus a warning.
* **calibrated**: `(d_ref, u_ref)` measured from the user while matching the model's rest pose (§7).
* **follow**: no measurement; the bone takes the same world delta as its chain's driven bone (no-knee stub thighs).
* **off**: the bone keeps its bind pose.

`rollOffsetDeg` rotates `u_ref` about `d_ref` after mode selection, in every mode.

**Torso baseline.** MediaPipe's standing torso vector leans back a few degrees. The measured torso basis is compared against a **standing baseline** (median torso basis over the first 2 s of confident full-body tracking, or the pose calibration), so the model stands as designed when the user stands normally.

**No-knee legs.** `lowerLeg` is driven from the chord hip→ankle (landmarks 23/24 → 27/28) with the kneecap direction as `u`, canonical `d` −Y; `upperLeg` follows.

### 6.3 Solve

For each mapped role in parent-first order (`HUMANOID_SOLVE_ORDER`):

```
F_ref  = frameFromDirUp(d_ref, u_ref)              // §4 conventions (core/math.ts)
F_meas = frameFromDirUp(d, u)                       // u always present (measured or fallback)
R      = F_meas · F_refᵀ                            // world rotation taking ref to measured
// swing/twist about the PRE-rotation axis d_ref:
T      = twist(R, d_ref)  (identity if the projection norm < 1e-6)
S      = R · T⁻¹                                    // minimal rotation d_ref → d
twist_state ← low-pass(T, τ = 0.3 s) weighted by c_u   // decays toward identity (= bind twist) when c_u is low
R'     = S · twist_state
Q_world_target = R' · Q_world_rest(bone)
Q_local_target = inverse(Q_world_parent_now) · Q_world_target
bone.quaternion ← slerpShortest(bone.quaternion, Q_local_target, k)   // k = expFactor(rate·(1 + gain·ω), dt) · c
Q_world_now(bone) = Q_world_parent_now · bone.quaternion
```

`Q_world_parent_now` is maintained by the solver: seeded once per frame from `hips.parent.getWorldQuaternion()` (after `updateMatrixWorld` at frame start, so the armature/wrapper transforms are included), and composed through every node between mapped bones using each node's current local quaternion (unmapped intermediates hold their bind local because §5.3 wrote it). Because the delta is applied in world space on top of the bind-pose world orientation, the rig's local axis conventions never enter the math. A T-pose rig with `d = −d_ref` (arm crossed in front of the chest) must produce a finite `R` whose swing axis is ±Y; no NaN for 180° about any axis (unit test).

**Forearm pronation.** Palm-derived twist on a rig without forearm-twist helpers candy-wraps the elbow; apply a configurable fraction of it to `lowerArm` (default 0.5; 0 when the rig has no `*twist*` bones under the forearm) and the remainder to `hand`.

**Spine distribution.** `R_hips = F_meas(hips)·F_refᵀ`, `R_top = F_meas(shoulders)·F_refᵀ` (both relative to the standing baseline); for each torso link k (mapped or intermediate) `R_k = slerp(R_hips, R_top, f_k)` with `f_k` the cumulative chain **length** fraction; `Q_world_target_k = R_k · Q_world_rest_k`. Neck and head then apply their own measured deltas.

**Hips translation** (modes `locked` | `horizontal` | `full`). Computed in **world space** and converted with `hips.position.copy(hips.parent.worldToLocal(P_world))` (a rotated or scaled armature must not turn a lift into a slide; unit test: +0.1 m world lift moves `hips.matrixWorld` by exactly +0.1 in Y on a rig with a 90°-rotated, 0.01-scaled armature). Sources:

* **Depth** `Z`: for each confident in-frame segment (shoulder–shoulder, shoulder–hip ×2, hip–hip, shoulder–elbow ×2), camera-plane length `Lw` = world-landmark vector with z dropped, image length `Li` = |Δ(x·W, y·H)| in pixels; `Z_i = f·Lw/Li` with `f = (H/2)/tan(vfov/2)` (assumed webcam vertical FOV 45°, editable in the Source panel; only sets absolute scale). Length-weighted median, One Euro filtered; translation = `Z − Z_ref` with `Z_ref` a slow running median (20 s), pinned by calibration when present.
* **Lateral** `x = (xImg − 0.5)·W·Z/f` (metric, consistent with depth), mirrored in mirror mode.
* **Vertical**: from world landmarks only: `hipsHeight = −min(ankleL.y, ankleR.y)` (hip-centred origin); crouch/jump offset = `hipsHeight − standingRunningMax`; only when both ankles are gated and in frame, else locked with a 1 s blend when available again.
* In mirror camera mode the estimated `Z` feeds the camera framing, not the hips (`full` is meaningful in orbit/follow only). Default `horizontal`. Feet are clamped to the floor.

### 6.4 Degradation policy and framing states

`framing.ts` fits, every frame, `y_img = a·h + b` by least squares over in-frame gated landmarks paired with their **user-proportion heights** (eyes 0.94H, ears 0.93H, shoulders 0.82H, hips 0.53H, knees 0.28H, ankles 0.04H; needs ≥ 2 height groups, else the previous fit is kept). The frame edges map to `hVisibleTop = min(1.05H, h(y=0))` and `hVisibleBottom = max(0, h(y=1))`; the **visible span** is continuous when a knee drops out (its point was already on the line) and captures the true crop line. Framing states with hysteresis (boundary ±5 % for 400 ms): **full** (span ≥ 0.85H), **waist** (0.45–0.85H), **bust** (0.20–0.45H), **face** (< 0.20H, or pose lost while a face is tracked), **none**.

| state | policy |
|---|---|
| full | everything drives |
| waist | legs relax; hips vertical locked; torso, arms, head drive |
| bust | landmarks below the shoulders are ignored regardless of visibility (they are extrapolated); hips-lost policy; arms drive from the shoulders |
| face | head/neck from the FaceLandmarker matrix (run at full cadence in bust/face even if face tracking is off: `closeUpFace`, default on); last upper-spine yaw held; arms relax |
| none | keep the last framing state and camera for 3 s, then ease bones to rest over 1 s and the camera to full-body over 2 s; if a face is still tracked never go idle; a pose returning within 3 s is the same subject (no camera reset) |

The status panel shows a body diagram with per-part confidence and the framing state.

## 7. Calibration

1. **Rig auto-calibration** (every load): mapping, bind-pose analysis, plausibility flags, unit and facing correction, per-bone mode selection, height table. Result: `RigAnalysis` plus the applied `RigProfile` diff.
2. **Standing baseline** (automatic, silent): median torso basis, running segment-length medians and `Z_ref` from the first seconds of confident full-body tracking.
3. **Pose calibration** (optional, ~3 s): the model shows its bind pose next to the webcam preview; the user matches it mirror-style; countdown; average `(d, u)` per role over 60 frames → `PoseCalibration` (reference bases, shoulder width, torso length, segment lengths, torso baseline, `Z_ref`). Bones then use `calibrated` mode when enabled. Stored per `instanceKey`, cleared with one click.
4. **Diagnostic snapshot**: one click captures a composite PNG (webcam frame with landmarks | 3D view with the measured landmark skeleton drawn in world space over the model | per-bone error bars) and a JSON bundle: analysis (map, confidences, warnings, axes, rest directions, height table), profile diff, measured bases and `c/c_u`, reference bases and modes, solved directions, per-bone and per-chain angular error, framing state and fit, settings, mirror flag, hand assignment, library versions. The 3D view is read back by calling `renderer.render()` and `drawImage` synchronously in the same task (no `preserveDrawingBuffer`).

Self-check: per-bone error = angle between measured `d` (or the chord for chord-driven bones) and the bone's actual world direction after solving; per-chain error (hip→ankle, shoulder→wrist) in addition. In `auto` mode with a mapped child it should be < 5°.

## 8. Stage and mirror camera

`Stage` owns the renderer, lights, floor/grid, shadows, environment and resize. Camera modes:

* **orbit**: OrbitControls.
* **mirror** (default): from the visible span (§6.4) and the rig's height table (§5.5) compute the model's visible span `[mBottom, mTop]`; `distance = (modelSpan·1.08) / (2·tan(vfov/2))` with the mirror camera's vertical FOV 35°; camera height = midpoint of the visible model span; look direction horizontal (a mirror does not tilt). Horizontal: the model's lateral offset mirrors the user's metric lateral offset (§6.3), so moving sideways moves the character sideways in the frame like a mirror; the camera's x follows a slower spring. Springs: critically damped 1.5 Hz on distance, 2.5 Hz on target; 4 % dead-band on the span and a 1.5 m/s rate limit on distance so breathing does not pump the zoom; distance clamped to [0.6, 6] m (a 1.7 m body at 35° needs ≈ 3.1 m).
* **follow**: full body framed, pans with the hips.

Environment: a GLB scene can be loaded and placed; the model stands at the origin (or at an empty named `spawn`). The environment can be included in the GLB export.

## 9. Recording and export

* **Landmark take** (`.mocap.json`): raw PoseFrame v2 stream (un-mirrored, unfiltered) with a rich `meta` (§10). Replayable through `RecordingSource` (play/pause/scrub/loop/speed) and re-targetable to any model.
* **Animation clip**: `ClipRecorder` samples every mapped bone's local quaternion and the hips' local position (after the world→local conversion) at 30 or 60 Hz into `THREE.AnimationClip` tracks named `${node.uuid}.quaternion` / `${hips.uuid}.position` (`PropertyBinding.findNode` matches uuids; names collide between meshes and bones). Every track node must be a descendant of the export root (assert). Recorded `t0` (performance.now at start) is shared with the video and take recorders.
* **GLB export** (`GLTFExporter`): snapshot the current bone TRS, apply the bind pose (§5.3) and `updateMatrixWorld`, export, restore. Export the **wrapper Group** (scale + root correction + loader root), never the Scene; `onlyVisible: false` so hidden helper meshes do not drop joints; `await exporter.parseAsync(model, { binary: true, animations: [clip] })`; with an environment `parseAsync([model, env], { binary: true, animations: [[clip], []] })`. Skip the model's pre-existing animations unless opted in. When KTX2 support is on, call `exporter.setTextureUtils(new WebGLTextureUtils(renderer))`. The wrapper scale is exported as a node scale and IBMs are unaffected, so no re-binding is needed; the original unit is recorded in metadata only.
* **BVH**: hierarchy of the mapped roles (unmapped intermediates skipped), names = role names (no spaces/colons). `OFFSET_j = bindWorldPos(j) − bindWorldPos(mappedParent)` in world Y-up meters (cm toggle for MotionBuilder). Per frame and role `j` with mapped parent `p`: `Δ_j = Q_world_now(j)·conj(Q_world_bind(j))` (the solver's world delta, after root correction and normalization); `R_bvh(j) = conj(Δ_p)·Δ_j` (root's parent = identity); written as `Euler.setFromQuaternion(R_bvh, 'ZXY')` in degrees for `CHANNELS 3 Zrotation Xrotation Yrotation` (three's ZXY builds `Rz·Rx·Ry`, matching BVH's outermost-first channel order). Root: `CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation` with the **absolute** hips world position. An `End Site` for every leaf (offset = rest direction × estimated length) so Blender does not synthesize tails. `Frames: N`, `Frame Time: (1/rate).toFixed(6)`. Round-trip unit test: drive a synthetic rig to a known pose, export, re-evaluate the BVH kinematics in code, and check each joint's world direction within 1°.
* **Video**: composite every frame into a fixed **even-sized** offscreen canvas (viewport rounded down to even, or 1920×1080), including the optional webcam PiP, and `captureStream` that canvas. Codec probe order: `video/mp4;codecs=avc1.42E01E,mp4a.40.2`, `video/mp4`, `video/webm;codecs=vp9,opus`, `video/webm;codecs=vp8,opus`, `video/webm`; the file extension follows the container. For WebM, patch the EBML `Duration` on stop with the measured elapsed time so the file seeks. Optional microphone track merged into the stream. Warn that recording stalls when the tab is hidden.

## 10. Protocol: PoseFrame v2

Used by `WebSocketSource`, `RecordingSource`, `SyntheticSource` and the Python provider. Coordinates are **raw MediaPipe conventions**; frames are raw (un-mirrored, unfiltered); arrays are compact. `hands.left/right` are **anatomical** sides.

```json
{
  "v": 2, "t": 12345.678, "now": 98765.4,
  "src": "mediapipe-web" | "python-opencv" | "recording" | "synthetic",
  "size": [1280, 720],
  "pose": { "world": [[x, y, z, visibility] × 33], "image": [[x, y, z, visibility] × 33] } | null,
  "hands": { "left": { "local": [[x,y,z] × 21], "image": [[x,y,z] × 21], "score": 0.9, "handedness": "Right" }, "right": null } | null,
  "face": { "blendshapes": { "jawOpen": 0.21 }, "matrix": [16 numbers, column-major] } | null
}
```

`t` = the video frame's media time in ms (monotonic per source); `now` = `performance.now()` at capture (optional; aligns with video and clip recorders). Hand `local` points are meters relative to the hand's own geometric centre (MediaPipe hand world landmarks cannot be composed with pose world landmarks; they are used for palm orientation only). `handedness` is the raw MediaPipe label; MediaPipe assumes a mirrored selfie frame, so on our un-flipped frame the label is swapped, and hands are assigned to sides by nearest pose wrist in image space, falling back to the swapped label.

Recording file:

```json
{ "format": "cameracharacter-mocap", "version": 2,
  "meta": { "createdAt": ISO, "source": "mediapipe-web", "size": [w,h], "mirror": false, "fovDeg": 45,
            "t0": { "wallclock": ISO, "performanceNow": 12345.6 },
            "camera": { "deviceLabel": "...", "facingMode": "user", "frameRate": 30, "vfovDeg": 45 },
            "tracker": { "lib": "@mediapipe/tasks-vision", "version": "1.0.1", "poseModel": "full", "delegate": "GPU", "hands": false, "face": false },
            "smoothing": { ...SmoothingSettings in effect... }, "calibration": PoseCalibration | null,
            "referenceModel": { "familyKey": "...", "displayName": "..." } | null, "notes": "..." },
  "frames": [PoseFrame, ...] }
```

## 11. Tracking sources

* **MediaPipeSource** (browser): `const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')` (the six wasm files are copied by `vite.config.ts` from `node_modules/@mediapipe/tasks-vision/wasm` to `public/mediapipe/wasm`; CDN fallback if the local file is missing); `PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetBuffer, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1, … })` inside a try/catch that retries with `delegate: 'CPU'`; model bytes from `/models/mediapipe/*.task` if self-hosted, else Google storage, cached with the Cache API. Inference on `requestVideoFrameCallback` (fallback rAF), skipping frames whose media time did not advance; `detectForVideo(video, ts)` return form with a strictly increasing integer `ts` derived from `performance.now()` (never `video.currentTime`, which restarts on camera switch); guard `result.landmarks.length === 0`. Model variants lite/full/heavy (default full). Optional `HandLandmarker` (numHands 2) and `FaceLandmarker` (`outputFaceBlendshapes`, `outputFacialTransformationMatrixes`) run every `auxCadence` pose frames; the face runs at full cadence in bust/face framing states. Read `result.handedness` (not the deprecated `handednesses`). The bundle reports usage metrics to Google (documented). A `HolisticLandmarker` variant is an optional later source (maps 1:1 onto PoseFrame v2, no facial matrix, no model-size choice).
* **WebSocketSource**: PoseFrame v2 over `ws://host:port`, exponential reconnect.
* **RecordingSource**: plays `.mocap.json`, honors timestamps, scrub/loop/speed; deterministic `step()` for tests.
* **SyntheticSource**: generates frames from `src/testing/syntheticHuman.ts` presets in real time (webcam-free demo and tests).

`PoseFilter` applies mirror, the per-landmark gate (§6.1), and **scale-free** One Euro filtering: the derivative is normalized by the subject's apparent size (image arrays: fitted torso image length; world arrays: measured torso length), with `minCutoff` 1.0 Hz, `beta` 30 (0–100 in the Smoothing panel), `dCutoff` 1.0 Hz; world z uses half the cutoff. Unit test: a step of 0.3 units in 33 ms reaches 90 % within 3 frames with beta 30 and takes > 8 frames with beta 0.

## 12. UI

Single page. The 3D viewport fills the window. A draggable webcam picture-in-picture shows the flipped preview with the landmark overlay. A collapsible right panel has sections: **Source** (camera picker, resolution, webcam FOV, model variant, hands/face toggles, WebSocket URL, recording file, synthetic preset), **Model** (drop zone / file picker / sample models incl. the bundled pack; mapping table: role, detected bone, confidence, dropdown override, "swap sides"; warnings), **Calibration** (calibrate pose with countdown, per-bone mode and roll trim, reset, snapshot), **Stage** (mirror on/off, camera mode, hips translation mode, environment load, floor/grid, background), **Smoothing** (One Euro parameters, bone rate, hold/relax times), **Recording** (record take / clip / video, export GLB / BVH / JSON, load take), **Status** (inference and render FPS, framing state, body diagram, per-bone error when diagnostics are on). Unrigged models (static meshes) are reported clearly and can be shown as props.

URL parameters for automation and demos: `?source=recording&file=/recordings/arm-raise.mocap.json&model=/models/sample-meshy.glb&autoplay=1&diagnostics=1&camera=mirror`, or `?source=synthetic&preset=walk`.

## 13. Testing

* **Unit (Vitest, Node)**: math (frames, swing/twist incl. 180° cases, One Euro scale-free step test, springs, gates with dwell); auto-mapper against name/hierarchy fixtures (Mixamo with and without prefix, Meshy, UE5, Rigify DEF-only and full, VRoid, CC4, Genesis 8, Blender generic, nameless `Bone.001` rigs, SMPL-style joint names) and against every real bundled GLB (read by the Node GLB skeleton reader): expected map, axes, height, no-knee flags; bind-pose test on the sample; solver property tests with the synthetic human on synthetic rigs (T-pose, A-pose, arms-down, bent-elbow, Z-up, rotated/scaled armature, no-knee): each driven bone's world direction matches the input within 2° in auto mode, hips lift test, no NaN; degradation tests (dropped landmarks never produce NaN or discontinuities; seated jitter test); framing fit tests; BVH round trip; mirror involution.
* **End-to-end (Playwright, headless Chromium with SwiftShader WebGL)**: load the app with URL parameters against synthetic presets and the sample models; assert no console errors, diagnostics report per-bone error under threshold, framing state transitions on the approach preset; screenshots saved for visual inspection.
* **Manual**: live webcam sessions by the user with diagnostic snapshots fed back.

## 14. Python provider (optional)

`backend/stream_pose.py`: OpenCV capture → `mediapipe.tasks.python.vision.PoseLandmarker` (VIDEO mode, lite/full/heavy, CPU delegate; the Linux wheel has no GPU) → PoseFrame v2 JSON over `websockets.asyncio.server.serve` on `ws://0.0.0.0:8765`; `timestamp_ms = int(monotonic_ms)` strictly increasing; `mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)`. Flags: `--camera`, `--width/--height`, `--fps`, `--model`, `--port`, `--host`, `--preview`. Requirements: `mediapipe>=1.0.1`, `opencv-python`, `websockets>=14`, `numpy`.

## 15. Roadmap (after v2)

Props and weapons in hands (§16), foot IK / ground contact, VRM spring bones, full ARKit blendshape mapping for models that have them, multi-person, WebGPU renderer, OSC/VMC protocol output for other tools, take management (multiple takes, trimming), scene authoring (camera paths, lights), Holistic landmarker source.

## 16. Props in hands and the alignment loop

Goal: put a weapon or prop in the character's hand so it follows the hand naturally, with as little manual alignment as possible, and never redo the alignment for the same kind of rig and prop.

### 16.1 Sockets

A **socket** is a hand role (`leftHand`/`rightHand`; later also `head`, `hips`, `spine` for hats, holsters, backpacks) plus an offset transform in the bone's local space: position, rotation (Euler degrees for the sliders, stored as quaternion), scale. A prop is a loaded `Object3D` parented to the socket bone with that offset. Sockets are stored in the rig profile (`sockets: Record<socketName, SocketOffset>`) and exported/imported with it.

### 16.2 Automatic first pass

The first pass uses what the rig analysis already knows about the hand:

* **Hand frame.** From the hand bone's rest analysis: `f` = finger direction (wrist → fingers), `n` = dorsal normal (back of the hand; palm = −n), `l` = lateral axis `cross(f, n)` (index side → pinky side, sign chosen so the frame is right-handed). Palm center ≈ wrist + 0.35·handLength·f − 0.15·handLength·n. A closed fist encloses a grip whose axis runs along `l`.
* **Prop frame.** From the prop file, in priority order: (1) a named node such as `grip`, `handle`, `socket_hand`; (2) glTF root `extras` from the bundled weapon pack: `muzzle` (front point) and `length` with the convention origin at the rear end at floor level and the prop extending along −Z; (3) bounding-box heuristics: the long axis is the pointing axis, the rear end is the grip end for one-handed tools.
* **Category rules.** *Firearm*: barrel direction → `f` (index finger points along the barrel), gun up (+Y) → −`l` (from the grip bottom to the slide), grip point = rear-bottom of the box raised by ~25 % of the height, placed at the palm center. *Melee / tool* (bat, katana): the handle segment (rear 15–25 % of the length) sits across the fist with the handle axis along `l`, blade forward along `f` rotated 60° toward the palm normal for a natural carry. *Small object* (grenade, ammo box): centered in the palm, largest axis along `f`. Two-handed props also get an optional second socket that only applies a look-at constraint for the off hand (no IK in v2).

The result is displayed immediately; typically it is close but not exact because rigs differ in where the hand bone sits relative to the mesh's palm.

### 16.3 Correction sliders and persistence

A **Prop panel** shows six sliders (position x/y/z in centimeters, rotation x/y/z in degrees) and a uniform scale, applied live in the socket's local frame, plus "mirror to other hand", "reset to first pass", "snap rotation to 15°" and a small gizmo in the viewport. **Export** writes a preset:

```json
{ "format": "cameracharacter-socket-preset", "version": 1,
  "familyKey": "…", "instanceKey": "…", "socket": "rightHand",
  "propCategory": "firearm", "propId": "gun_pistol_01",
  "offset": { "position": [x,y,z], "rotation": [x,y,z,w], "scale": 1 },
  "firstPass": { … the automatic proposal, kept for comparison … } }
```

Presets are keyed hierarchically: instance + prop id → family + prop category → prop category only. The most specific match becomes the default on the next load; the difference between the first pass and the accepted offset is stored so the heuristics for that rig family can be re-fitted (the mean correction per family and category is applied as a prior).

### 16.4 The interaction pattern

This is **mixed-initiative, human-in-the-loop calibration**: the system takes the initiative with a proposal (a prior computed from conventions and analysis), the person refines it by **direct manipulation** (sliders and a gizmo rather than numbers or prompts), and the refinement is **persisted as a preset** and folded back into the proposal for the next time (learning from corrections). The same loop is used for bone roll trims, per-bone reference modes, pose calibration, and camera framing. Guidelines that follow from the pattern: the proposal must be visible and editable within seconds; every slider has a reset to the proposal; corrections are exportable and diffable against the proposal; defaults improve without retraining anything (a preset store is enough); the LLM-assisted snapshot loop (§7) is the same pattern one level up, used when the proposal itself needs new rules.
