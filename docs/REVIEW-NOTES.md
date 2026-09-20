# Open review findings (2026-09-20)

Independent reviewers produced these findings for the solver and diagnostics modules after implementation; the automated fix pass was cut off by a usage limit, so they are recorded here for the next session. Verify each against the code before acting.


## review:diagnostics

Checks: typecheck = cd /home/user/CameraCharacter && npx tsc --noEmit: 0 errors (project-wide, including src/diagnostics/** and tests/diagnostics/**).; tests = npx vitest run tests/diagnostics: 3 test files passed, 16 tests passed, 0 failed (Vitest 5.0.1, 636 ms).


### 1. [major] Snapshot 3D view cannot include the landmark skeleton (DESIGN §7)

`src/diagnostics/Snapshot.ts`:396

**Problem.** DESIGN §7 requires the snapshot's 3D panel to show 'the measured landmark skeleton drawn in world space over the model'. `captureSnapshot` only flips `skeleton.visible = true` (lines 396-398), but `LandmarkSkeleton3D.applyVisibility()` keeps `object.visible = visibleFlag && hasPose`, and `hasPose` is false whenever the last `update()` received null. That is exactly what the frame loop does when the stage toggle is off (App.ts:340 passes `showLandmarkSkeleton ? pose : null`), and App.ts:682-691 does not pass `skeleton` at all. Net effect: the PNG never contains the skeleton unless the user happened to enable the stage toggle; the `skeleton` option as documented ('force the 3D landmark skeleton visible') cannot do what it says.

**Proposed fix.** Add `pose: FilteredPose | null` and `hipsWorld: Vector3` to `CaptureSnapshotOptions`; in `captureSnapshot`, before `renderer.render`, do `skeleton.update(opts.pose, opts.hipsWorld); skeleton.visible = true;` and restore the previous `visible` flag in the `finally` (the next frame's `update` restores `hasPose`). Then App passes `skeleton: this.skeleton3D, pose: this.pose, hipsWorld: this.solve?.hipsWorldPos ?? this.stage.modelOrigin`. Add a Node test that `update(pose, hips)` followed by `visible = true` yields `object.visible === true` after a prior `update(null, ...)`.


### 2. [major] Bone names in the error table and JSON bundle ignore profile map overrides / swapSides

`src/diagnostics/BoneError.ts`:61

**Problem.** `summarize` (BoneError.ts:61) and `solveJson` (Snapshot.ts:189) report `bone: analysis.map[role]`, i.e. the raw auto-mapper result. The effective map is produced by `applyProfile(analysis, profile)` and lives on `ModelSession.map` (src/app/ModelSession.ts:84-86); `analysis.map` is never updated, and the retargeter is built with `{ ...analysis, map: this.map }`. So with `profile.swapSides` every left/right row in the PNG strip and in `solve.perRole.*.bone` names the opposite side's bone, and a role the user overrode is labelled with the bone that was replaced — in the bundle whose purpose is debugging the mapping. The same lookup gap affects `rollOffsetDeg` at Snapshot.ts:184 (`analysis.defaultBones` is un-mirrored under swapSides). `buildDiagnosticsJson` already receives `profile`, so this is fixable inside the module.

**Proposed fix.** In `buildDiagnosticsJson`/`solveJson`, compute `const eff = analysis ? applyProfile(analysis, profile) : null` (src/rig/profile.ts is pure; it imports only core/types) and use `eff.map[role]` for `bone` and `eff.boneSettings[role]?.rollOffsetDeg ?? 0` for the roll trim. Give `summarize` an optional 4th parameter `map?: HumanoidMap` that takes precedence over `analysis.map` (App then passes `this.model.map`). Add a test with `profile.swapSides = true` and a `mapOverrides` entry asserting the reported bone names.


### 3. [major] Bundle's reference basis disagrees with the solver on no-knee / no-elbow rigs

`src/diagnostics/Snapshot.ts`:185

**Problem.** `solveJson` reconstructs `reference {d,u}` with `referenceBasisFor(role, mode, analysis, calibration, roll)`. The solver applies `applyChordReference` on top of that in `auto` mode (solver.ts:504, 520-545): for a `noKnee`/`noElbow` side it replaces `ref.d` with the bind chord upper-head → end-head and re-orthogonalizes `u`. The bundle therefore prints the stub bone's own bind direction as the reference while `errorDeg`/`solvedDir` for that role are computed against the chord (`solvedDirection`, solver.ts:1051-1058). The Meshy sample — the design's flagship no-knee case — is exactly this configuration, so an LLM reading the bundle would see an inconsistent reference/error pair. The solver already exposes the reference actually in use: `Retargeter.referenceOf(role)` (solver.ts:616-621).

**Proposed fix.** Add an optional `referenceOf?: (role: HumanoidBone) => { d: Vector3; u: Vector3 } | null` to `DiagnosticsJsonInput`; in `solveJson` use it when provided and fall back to the `referenceBasisFor` reconstruction otherwise (keeps the pure/Node path). App passes `referenceOf: (r) => this.model?.retargeter?.referenceOf(r) ?? null`. Add a test on a `buildRig({...noKnee})` pipeline asserting `perRole.leftLowerLeg.reference.d` equals the chord direction.


### 4. [minor] Framing crop-line colour branch is dead: cropped and uncropped lines both draw yellow

`src/diagnostics/Overlay2D.ts`:241

**Problem.** `drawFit` colours a line orange (`cropLine`) when `yNorm < 0 || yNorm > 1`, claiming that marks a true crop. But `fitFraming` sets `visibleTop = min(1.05, h(y=0))` and `visibleBottom = max(0, h(y=1))` (framing.ts:206-207). For any valid fit (a < 0) this gives `a·visibleTop + b ∈ [0, a·1.05+b]` with the upper bound ≥ 0, and `a·visibleBottom + b ≤ 1`, so the orange branch is only reachable through floating-point noise. A real crop is exactly `yNorm == 0` (top) / `yNorm == 1` (bottom), which draws yellow — the same as the uncropped case. The overlay never distinguishes 'head cut by the frame edge' from 'whole body visible'.

**Proposed fix.** Decide crop from the fit, not the mapped y: `const cropped = name === 'top' ? fit.visibleTop < FRAMING_BOUNDS.maxTop - 1e-6 : fit.visibleBottom > 1e-6;` (import `FRAMING_BOUNDS` from `../retarget/framing`) and use `cropped ? OVERLAY_COLORS.cropLine : OVERLAY_COLORS.fitLine`. Extract this into a pure exported helper (e.g. `cropLineIsCrop(fit, 'top'|'bottom')`) and unit-test it with the two fits (head cropped: visibleTop = h(y=0) < 1.05; full body: visibleTop = 1.05).


### 5. [minor] Overlay forces a layout read (getBoundingClientRect) every frame

`src/diagnostics/Overlay2D.ts`:90

**Problem.** `resize()` is called from every `draw()` and reads `canvas.getBoundingClientRect()` (and `clientWidth/clientHeight` as fallback). The status panel updates DOM text each frame, so the layout is usually dirty and this read forces a synchronous reflow at 30-60 Hz on the render thread.

**Proposed fix.** Track the CSS size with a `ResizeObserver` on the canvas (created in the constructor when `typeof ResizeObserver !== 'undefined'`, disconnected in a `dispose()`), store `cssW/cssH`, and only fall back to a single measurement when the observer has not fired yet. Apply the DPR-scaled backing size only when the cached size changes.


### 6. [minor] Out-of-frame hollow markers are not edge-clamped as the code claims

`src/diagnostics/Overlay2D.ts`:172

**Problem.** The comment says out-of-frame landmarks are 'drawn at the edge-clamped position', but `px`/`py` map the raw normalized coordinates, so a landmark with x < 0 or x > 1.03 lands in the letterbox bars or off the canvas and the orange out-of-frame indicator is frequently invisible — precisely the 'landmark left the frame' state the overlay is supposed to make obvious.

**Proposed fix.** When `!pose.inFrame[i]`, clamp before mapping: `const x = px(Math.min(1, Math.max(0, img[i].x))); const y = py(Math.min(1, Math.max(0, img[i].y)));` (and the same for the endpoint of dashed segments that touch an out-of-frame landmark), or delete the comment if drawing at the raw position is intended.


### 7. [minor] Tests do not cover the profile-diff and crop-colour behaviour

`tests/diagnostics/snapshot.test.ts`:283

**Problem.** The only profile used in the tests has `swapSides: false` and a `mapOverrides` entry (`head: 'HeadOverride'`) whose effect on the reported `bone` is never asserted (the test only checks the profile is echoed), so the wrong-bone-name defect passes. Nothing exercises no-knee reference reconstruction or the framing crop-line decision, and `overlayFlipsX`/`containRect` are the only overlay logic tested.

**Proposed fix.** Add: (1) a `buildDiagnosticsJson` case with `swapSides: true` and a map override asserting `solve.perRole.<role>.bone` equals the effective bone; (2) a `summarize` case with the optional effective map; (3) a no-knee synthetic rig case asserting the emitted reference equals the solver's `referenceOf`; (4) a pure crop-decision helper test (see the Overlay2D finding).


## review:retarget

Checks: typecheck = cd /home/user/CameraCharacter && npx tsc --noEmit: 0 errors (whole project, including src/retarget/** and tests/retarget/**; the src/rig/src/app errors mentioned in the implementer's report are no longer present).; tests = npx vitest run tests/retarget: 3 files passed, 37/37 tests passed (solver 20, bodyModel 9, framing 8), 1.2 s. Numeric probes (scratchpad scripts, not committed): synthetic A-pose/T-pose/armature/no-knee rigs 0.0° per-bone error on 7 presets except clavicles (9-36°); depth 3.20/4.20/2.40 m and lateral ±0.3/-0.4 m exact; pronation split 0/29.4° forearm, 58.8° hand; sample-meshy.glb + clerk/skeleton/zombie/ninja_parts/npc_mom.glb: no NaN, solver-vs-three.js world quaternion mismatch <= 0.05°, meshy no-knee chord 0.0°, arm chains <= 2.4°; confirmed defects: face-matrix head pitched 20.6° after standing bases, head errorDeg constant 20.56° after bases, head yaw 16-29° for a 30° turn at c 0.6-0.98, clavicle errorDeg 22.5° = 0.3 x 75°, 0.409 m vertical offset retained after setHipsMode('horizontal').


### 1. [major] Landmark-derived neck/head pitch baseline is also applied to FaceLandmarker-sourced head bases, pitching the head down by the eye-ear bias in every close-up

`src/retarget/solver.ts`:556

**Problem.** `applyPitchBaseline` folds the standing head/neck pitch (median of the pose-landmark basis, which is pitched back by atan(eyeHeight/earDistance): 20.6° on the synthetic human, ~7-14° on a real subject) into the reference frame unconditionally. BodyModel.neckHead (bodyModel.ts:556-560) replaces the landmark basis with the FaceLandmarker matrix whenever `pose.face.rotation` is present, and that basis is level (no eye-ear bias) but is still tagged `source: 'measured'`. With `closeUpFace` on by default the tracker switches to the face matrix in bust/face framing automatically, so after the silent StandingBaseline is captured every close-up drives the head nose-down by the bias. Verified numerically: after `setStandingBases` from landmark frames, a level head with `face = identity` gives a head world-delta pitch of 20.6° (0.0° without the bases, 0.0° with the bases on the landmark path).

**Proposed fix.** Tag the basis by origin so the correction only applies to the source it was measured from: add `'face'` to `BasisSource` (bodyModel.ts:30) and pass it from `neckHead` when `useFace`; in `rebuildReferences` keep two inverse reference quaternions per neck/head entry (`qRefInv` with the pitch fold, `qRefInvRaw` without) and in `genericDelta` select `basis.source === 'face' ? e.qRefInvRaw : e.qRefInv`. `StandingBaseline.update` already filters on `source === 'measured'`, so face frames stay out of the pitch baseline. Add a solver test feeding `filteredFromFrame(frame, { face: new Quaternion() })` after `setStandingBases` and asserting a level head (world-delta pitch < 1°).


### 2. [major] Clavicle errorDeg reports the 30 % arm-swing share as an error, permanently flagging shoulders in the diagnostics

`src/retarget/solver.ts`:806

**Problem.** `combineShoulders` premultiplies 30 % of the upper-arm swing onto `sh.rPrime`, but `sh.measuredD` stays the raw midShoulder->shoulder direction, so `finishResults` reports errorDeg = 0.3 x (arm swing from the rig's bind). Verified: T-pose rig with a hanging-arm user gives leftShoulder errorDeg 22.5° (= 0.3 x 75°); on every real rig probed (sample-meshy, clerk, skeleton, zombie, ninja, npc_mom) shoulders show 8-30° while every other auto bone shows 0.0°. Shoulders are in `auto` mode with a mapped child, so this violates the §7 self-check (< 5°) and, since `FLAGGABLE_MODES` includes auto and `FLAG_ERROR_DEG` = 5, the per-bone error readout and snapshot flag both clavicles red on essentially every rig with clavicles; the E2E assertion 'per-bone error under threshold' (§13) can never pass.

**Proposed fix.** In `combineShoulders`, rotate the reported measured direction by the same share so the error measures what the bone was driven to: after `sh.rPrime.premultiply(_qa)` add `sh.measuredD.applyQuaternion(_qa)` (and, if the raw landmark direction should stay visible in snapshots, expose it separately). Add an assertion in the 'shoulders take 30 %' test that `perRole.leftShoulder.errorDeg < 2` with the arm hanging.


### 3. [minor] errorDeg for torso-baseline / pitch-baseline bones compares the uncorrected measured direction with the solved bone, giving a constant 'error' equal to the baseline offset

`src/retarget/solver.ts`:1028

**Problem.** `finishResults` computes `angleBetween(measuredDir, solvedDir)` from the raw `e.measuredD`, but for torso-like roles in relative/auto mode the reference was rotated by `t5` (torso baseline) and, for neck/head, by the standing pitch. A user standing exactly as during the baseline therefore drives the bone to its bind pose (correct) while errorDeg reports the baseline offset. Verified: after `setStandingBases`, head errorDeg is a constant 20.56° at c = 0.98 and c = 0.7 (0.0° before the bases). The same applies to hips/spine/chest by the torso lean captured in the baseline. The solver test 'standing baseline for neck and head' never asserts errorDeg after `setStandingBases`, which is why this passed.

**Proposed fix.** In `rebuildReferences`, after the final `_qa` is known, store per entry `e.baselineFix.copy(qRaw).multiply(_qa.clone().invert())` where `qRaw = quatFromDirUp(ref.d, ref.u)` before the t5/pitch fold (identity for other roles), and in `finishResults` use `o.measuredDir.copy(e.measuredD).applyQuaternion(e.baselineFix)` before `angleBetween`. Extend the baseline test with `expect(solve.perRole.head!.errorDeg!).toBeLessThan(1)` after the bases are set.


### 4. [minor] Head/neck yaw is scaled by landmark confidence because cU equals c and the twist state converges to cU x twist

`src/retarget/solver.ts`:799

**Problem.** The twist low-pass blends toward T with weight alpha*cU and toward identity with alpha*(1-cU); its steady state is a fraction cU of the measured twist. For the head, BodyModel sets `cU = headConf = c` (bodyModel.ts:560,576), so the primary head signal (yaw = twist about d_ref) is attenuated by the confidence itself, not by any uncertainty in the up reference. Verified: head turned 30° gives 29.4° at c = 0.98, 23.2° at c = 0.8, 16.0° at c = 0.6, with errorDeg 0.0 in all cases (the error metric only sees d), so the shortfall is invisible in diagnostics. Face landmarks in the smoothstep band 0.60-0.80 (§6.1 thresholds) are common at distance.

**Proposed fix.** Weight the twist by the up-reference confidence relative to the bone confidence rather than by the absolute value: `const wU = basis.c > 0 ? clamp(basis.cU / basis.c, 0, 1) : 0;` then use `wU` in the two `slerpShortest` calls. For limbs this keeps the intended decay (w * min(c, cW) / c) while a head whose up is as trustworthy as its direction turns fully; the rate factor `k = expFactor(...) * c` already provides the confidence-dependent damping.


### 5. [minor] Vertical crouch offset persists after setHipsMode leaves 'full'

`src/retarget/solver.ts`:579

**Problem.** `hipsTranslation` only recomputes the vertical offset when `hipsMode === 'full' && state === 'full'`; otherwise it holds `verticalOffset` (`hipsTarget.y = rest.y + this.verticalOffset`, line 1001). `setHipsMode` does not clear the held offset, so switching from `full` to `horizontal` while the user is crouched leaves the model sunk indefinitely. Verified: after a 60° squat in full mode (drop 0.409 m) and `setHipsMode('horizontal')`, 2 s of standing frames still report a 0.409 m drop; the design says horizontal has no vertical component.

**Proposed fix.** In `setHipsMode`, when `mode !== 'full'` reset `this.verticalOffset = 0; this.heldVertical = 0; this.verticalBlend = 0;` (and optionally `this.standingMax = NaN` so a later switch back re-learns the standing height). Add a test that toggles the mode after a squat and expects the hips to return to `restPos.y`.


### 6. [minor] referenceOf() and the swing/twist axis use the pre-baseline reference direction, not the effective one

`src/retarget/solver.ts`:505

**Problem.** `rebuildReferences` stores `e.refD = ref.d; e.refU = ref.u` before premultiplying `t5` and folding the neck/head pitch into `_qa`, and `genericDelta` (line 785) decomposes R about `e.refD`. §6.3 defines the twist about the pre-rotation axis d_ref, which after the baseline is the effective reference direction (up to 20° off canonical for the head on the synthetic human). When the twist state is partially decayed (cU < 1) the decomposition about the wrong axis leaks swing into twist and vice versa (second-order for pure yaw, first-order when yaw and nod combine). `referenceOf()` also reports the un-baselined basis to the snapshot ('reference bases and modes', §7.4). Verified: after `setStandingBases`, `referenceOf('head').d` = [0,1,0] while the effective reference is pitched 20.6°.

**Proposed fix.** After the final `_qa` is computed for the entry (after the pitch fold and `premultiply(this.t5)`), set `e.refD.set(1, 0, 0).applyQuaternion(_qa)` and `e.refU.set(0, 0, 1).applyQuaternion(_qa)` (frameFromDirUp puts d in column 0 and the forward reference in column 2) so the swing/twist axis, `applyChordReference` and `referenceOf()` all use the effective basis.


### 7. [minor] Two-bone fallback keeps dead `lastJoint` state; the design's 'nearest the last joint position' rule is not implemented

`src/retarget/bodyModel.ts`:295

**Problem.** `LimbFallback.lastJoint`/`hasLastJoint` are written every frame (lines 656-657, 810-811) and reset, but never read. §6.1 says the elbow/knee is placed on the solution circle nearest the last joint position while the stored bend normal decays toward torso forward; the code chooses the circle point solely from the (decaying) stored normal, so when the stored normal has decayed to torso forward and the true elbow was behind the body (e.g. hand on the hip), the reconstructed elbow flips to the front instead of staying near where it was last seen.

**Proposed fix.** Either use the field or remove it. To implement the rule: after `twoBoneJoint(S, Wr, L1, L2, this._bendDir, this._solved)` also solve with the negated bend direction into a second scratch vector and, when `fb.hasLastJoint`, keep the candidate closer to `fb.lastJoint` (then update `lastJoint`); otherwise delete `lastJoint`/`hasLastJoint` and the three writes so the state does not suggest behaviour that does not exist.


### 8. [minor] BodyModel.dorsal() allocates a result object on every call (twice per frame)

`src/retarget/bodyModel.ts`:722

**Problem.** The module header and the implementer's report state the hot path allocates nothing, but `dorsal()` returns a fresh `{ v, c }` literal on each of its three return paths and is called once per side per `update()`. Measured ~250 B per update over 20 000 updates; harmless in practice but contradicts the stated contract used to justify the module's per-frame budget.

**Proposed fix.** Return the normal through a reusable field: keep `private readonly dorsalOut = { v: new Vector3(), c: 0 }` (or write `c` into a per-side scalar) and have `dorsal()` fill and return that object; callers already copy `dorsal.v` immediately via `finish`.


### 9. [minor] Tests do not cover the calibrated mode, the face-matrix head path, or errorDeg after the standing bases

`tests/retarget/solver.test.ts`:452

**Problem.** The suite asserts nothing about `PoseCalibrationCapture` / `calibrated` mode (§7.3, `referenceBasisFor` 'calibrated' branch, `effectiveTorsoBaseline` with a calibration), never feeds a `FilteredPose.face.rotation` through the solver (the `face` option in `filteredFromFrame` is only used by framing tests), and the standing-baseline test checks the world delta but not `errorDeg` after `setStandingBases`. The first two gaps are exactly where the confirmed head-pitch defect lives and the third is why the constant 20.6° errorDeg went unnoticed.

**Proposed fix.** Add: (1) a calibration round trip: run `PoseCalibrationCapture` on 60 A-pose frames, `setCalibration(result)` with all limb modes `calibrated`, converge the same pose and assert every driven bone's world delta < 1° and errorDeg < 1°; (2) a face-path test as described in the head-pitch finding; (3) `expect(perRole.head/neck/hips.errorDeg).toBeLessThan(1)` after `setStandingBases` in the existing baseline test.
