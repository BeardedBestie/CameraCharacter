/**
 * Per-bone and per-chain error summary of a solver frame (docs/DESIGN.md §7
 * self-check) and a rolling window of per-role statistics for the status
 * panel. Pure: no DOM, no three.js scene objects.
 */
import type { HumanoidBone, RigAnalysis } from '../core/types';
import type { SolveResult } from '../retarget/solver';
import {
  CHAIN_NAMES,
  DEFAULT_FLAG_THRESHOLDS,
  FLAGGABLE_MODES,
  type BoneErrorEntry,
  type BoneErrorSummary,
  type ChainErrorEntry,
  type FlagThresholds,
  type RoleErrorStats,
} from './types';

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Summarizes one solver frame. A bone is flagged when its error exceeds
 * `thresholds.errorDeg` while its landmark confidence exceeds
 * `thresholds.confidence` and its reference mode is `auto` or `calibrated`
 * (modes whose reference is geometric, so the solved direction should match
 * the measurement; `relative` torso bones apply a delta on top of designed
 * curvature and `follow`/`off` bones do not track a measurement).
 */
export function summarize(
  solve: SolveResult,
  analysis: RigAnalysis | null,
  thresholds: FlagThresholds = DEFAULT_FLAG_THRESHOLDS,
): BoneErrorSummary {
  const perBone: BoneErrorEntry[] = [];
  let worst: HumanoidBone | null = null;
  let maxErrorDeg: number | null = null;
  let sum = 0;
  let n = 0;
  let anyFlagged = false;
  for (const role of solve.roles) {
    const r = solve.perRole[role];
    if (!r) continue;
    const errorDeg = finiteOrNull(r.errorDeg);
    const confidence = Number.isFinite(r.confidence) ? r.confidence : 0;
    const cU = Number.isFinite(r.cU) ? r.cU : 0;
    const confident = confidence > thresholds.confidence;
    const flagged = errorDeg !== null && errorDeg > thresholds.errorDeg && confident && FLAGGABLE_MODES.includes(r.mode);
    if (errorDeg !== null && confident) {
      sum += errorDeg;
      n++;
      if (maxErrorDeg === null || errorDeg > maxErrorDeg) {
        maxErrorDeg = errorDeg;
        worst = role;
      }
    }
    if (flagged) anyFlagged = true;
    perBone.push({
      role,
      bone: analysis?.map[role] ?? null,
      errorDeg,
      confidence,
      cU,
      mode: r.mode,
      source: r.source,
      flagged,
    });
  }
  const chains: ChainErrorEntry[] = CHAIN_NAMES.map((name) => ({ name, errorDeg: finiteOrNull(solve.chainErrorDeg[name]) }));
  return {
    perBone,
    chains,
    worst,
    maxErrorDeg,
    meanErrorDeg: n > 0 ? sum / n : null,
    ok: !anyFlagged,
  };
}

/** Roles of a summary that are flagged, in solve order. */
export function flaggedRoles(summary: BoneErrorSummary): HumanoidBone[] {
  return summary.perBone.filter((b) => b.flagged).map((b) => b.role);
}

/**
 * Rolling per-role error statistics over the last `windowFrames` pushed
 * summaries. Frames in which a role reported no error (null) do not count
 * toward that role's window.
 */
export class ErrorStats {
  private readonly windows = new Map<HumanoidBone, { buf: Float64Array; idx: number; count: number }>();

  constructor(readonly windowFrames = 60) {
    if (!(Number.isInteger(windowFrames) && windowFrames > 0)) throw new Error(`ErrorStats: windowFrames must be a positive integer (got ${windowFrames})`);
  }

  push(summary: BoneErrorSummary): void {
    for (const b of summary.perBone) {
      if (b.errorDeg === null) continue;
      let w = this.windows.get(b.role);
      if (!w) {
        w = { buf: new Float64Array(this.windowFrames), idx: 0, count: 0 };
        this.windows.set(b.role, w);
      }
      w.buf[w.idx] = b.errorDeg;
      w.idx = (w.idx + 1) % this.windowFrames;
      if (w.count < this.windowFrames) w.count++;
    }
  }

  /** Mean and max error over the window, or null when the role has no samples. */
  get(role: HumanoidBone): RoleErrorStats | null {
    const w = this.windows.get(role);
    if (!w || w.count === 0) return null;
    let sum = 0;
    let max = -Infinity;
    for (let i = 0; i < w.count; i++) {
      const v = w.buf[i];
      sum += v;
      if (v > max) max = v;
    }
    return { mean: sum / w.count, max, n: w.count };
  }

  /** Roles that currently have samples. */
  roles(): HumanoidBone[] {
    const out: HumanoidBone[] = [];
    for (const [role, w] of this.windows) if (w.count > 0) out.push(role);
    return out;
  }

  reset(): void {
    this.windows.clear();
  }
}
