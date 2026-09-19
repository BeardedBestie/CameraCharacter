import type { AppActions, Panel } from '../actions';
import type { SettingsStore } from '../state';
import { button, buttonRow, hint, row, section, slider } from '../ui';

export function createSmoothingPanel(store: SettingsStore, actions: AppActions): Panel<void> {
  const sec = section('Smoothing', { collapsed: true });
  const s = store.get().smoothing;

  const minCutoff = slider({ min: 0.2, max: 5, step: 0.1, value: s.oneEuroMinCutoff, format: (v) => `${v.toFixed(1)} Hz` }, (v) =>
    store.update({ smoothing: { oneEuroMinCutoff: v } }),
  );
  const beta = slider({ min: 0, max: 100, step: 1, value: s.oneEuroBeta }, (v) => store.update({ smoothing: { oneEuroBeta: v } }));
  const boneRate = slider({ min: 2, max: 40, step: 1, value: s.boneRate, format: (v) => `${v}/s` }, (v) => store.update({ smoothing: { boneRate: v } }));
  const gain = slider({ min: 0, max: 6, step: 0.5, value: s.boneRateVelocityGain }, (v) => store.update({ smoothing: { boneRateVelocityGain: v } }));
  const twistTau = slider({ min: 0.05, max: 1, step: 0.05, value: s.twistTau, format: (v) => `${v.toFixed(2)} s` }, (v) =>
    store.update({ smoothing: { twistTau: v } }),
  );
  const pronation = slider({ min: 0, max: 1, step: 0.05, value: s.lowerArmTwistFraction }, (v) => store.update({ smoothing: { lowerArmTwistFraction: v } }));
  const holdArms = slider({ min: 0, max: 3000, step: 50, value: s.poseHoldMs.arms, format: (v) => `${v} ms` }, (v) =>
    store.update({ smoothing: { poseHoldMs: { arms: v } } }),
  );
  const holdLegs = slider({ min: 0, max: 3000, step: 50, value: s.poseHoldMs.legs, format: (v) => `${v} ms` }, (v) =>
    store.update({ smoothing: { poseHoldMs: { legs: v } } }),
  );
  const relax = slider({ min: 0.2, max: 10, step: 0.2, value: s.relaxRate, format: (v) => `${v.toFixed(1)}/s` }, (v) =>
    store.update({ smoothing: { relaxRate: v } }),
  );
  const gateOn = slider({ min: 0.3, max: 0.95, step: 0.05, value: s.gateBody.on }, (v) => store.update({ smoothing: { gateBody: { on: v } } }));
  const gateOff = slider({ min: 0.1, max: 0.9, step: 0.05, value: s.gateBody.off }, (v) => store.update({ smoothing: { gateBody: { off: v } } }));

  sec.body.append(
    hint('Landmark filter (One Euro). Lower cutoff = calmer when still; higher beta = less lag when moving fast.'),
    row('Min cutoff', minCutoff.root),
    row('Beta', beta.root),
    hint('Bone response.'),
    row('Rate', boneRate.root),
    row('Velocity gain', gain.root),
    row('Twist smoothing', twistTau.root),
    row('Forearm pronation', pronation.root),
    hint('Tracking loss: how long a limb holds before relaxing to rest, and how fast.'),
    row('Hold (arms)', holdArms.root),
    row('Hold (legs)', holdLegs.root),
    row('Relax rate', relax.root),
    hint('Visibility gate (body landmarks).'),
    row('Gate on ≥', gateOn.root),
    row('Gate off ≤', gateOff.root),
    buttonRow(button('Reset all settings', () => actions.resetSettings(), { variant: 'danger' })),
  );

  store.subscribe((st) => {
    const m = st.smoothing;
    minCutoff.set(m.oneEuroMinCutoff);
    beta.set(m.oneEuroBeta);
    boneRate.set(m.boneRate);
    gain.set(m.boneRateVelocityGain);
    twistTau.set(m.twistTau);
    pronation.set(m.lowerArmTwistFraction);
    holdArms.set(m.poseHoldMs.arms);
    holdLegs.set(m.poseHoldMs.legs);
    relax.set(m.relaxRate);
    gateOn.set(m.gateBody.on);
    gateOff.set(m.gateBody.off);
  });

  return { root: sec.root, update() {} };
}
