/** Landmark groups shown as the body diagram in the Status panel (shared by the live and import apps). */
import { LM } from '../tracking/landmarks';

export const PART_GROUPS: { name: string; indices: number[] }[] = [
  { name: 'head', indices: [LM.NOSE, LM.LEFT_EAR, LM.RIGHT_EAR] },
  { name: 'torso', indices: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP] },
  { name: 'L arm', indices: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST] },
  { name: 'R arm', indices: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST] },
  { name: 'L hand', indices: [LM.LEFT_WRIST, LM.LEFT_INDEX, LM.LEFT_PINKY] },
  { name: 'R hand', indices: [LM.RIGHT_WRIST, LM.RIGHT_INDEX, LM.RIGHT_PINKY] },
  { name: 'L leg', indices: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE] },
  { name: 'R leg', indices: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE] },
  { name: 'feet', indices: [LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX] },
];
