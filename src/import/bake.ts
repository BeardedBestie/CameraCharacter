/**
 * Offline baking of a landmark take into a retargeted animation Take
 * (docs/DESIGN.md §17.5). The whole recording is pushed through the same
 * pipeline the live loop uses (PoseFilter → framing → BodyModel → standing
 * baseline → Retargeter) frame by frame with the recording's own frame gaps as
 * `dt`, and the solved skeleton is sampled onto the clip grid. Deterministic,
 * faster than real time, no timers, no DOM (three.js math only), so it runs in
 * Node tests and in the browser alike. The caller owns the pipeline objects
 * and may keep using them afterwards (they are reset before and after).
 */
import type { FramingFit, MocapRecording, PoseFrame, Take } from '../core/types';
import { ClipRecorder } from '../record/ClipRecorder';
import type { BodyModel } from '../retarget/bodyModel';
import type { StandingBaseline } from '../retarget/calibration';
import { fitFraming } from '../retarget/framing';
import type { Retargeter, SolveResult } from '../retarget/solver';
import type { PoseFilter } from '../tracking/PoseFilter';

export interface BakePipeline {
  filter: PoseFilter;
  bodyModel: BodyModel;
  baseline: StandingBaseline;
  retargeter: Retargeter;
  noKnee: { left: boolean; right: boolean };
  noElbow: { left: boolean; right: boolean };
  /** Whether the filter mirrors (the body model needs the same flag). */
  mirror: boolean;
}

export interface BakeOptions {
  /** Clip sample rate (frames per second of the output animation). */
  fps: number;
  /**
   * Seconds of the first frame repeated before the take starts so the
   * filters and bone smoothing have converged at t = 0 (default 1).
   */
  preRollSec?: number;
  /** Largest `dt` (seconds) fed to the pipeline for a single frame gap (default 0.1, like the live loop). */
  maxDtSec?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface Baker {
  /** Frames to process, pre-roll included. */
  readonly total: number;
  /** Frames processed so far. */
  readonly done: number;
  readonly finished: boolean;
  /** Process one frame; returns false once every frame has been consumed. */
  step(): boolean;
  /** Stop and return the Take with whatever has been sampled (also resets the pipeline). */
  finish(): Take;
}

const DEFAULT_PRE_ROLL_SEC = 1;
const DEFAULT_MAX_DT = 0.1;
const MIN_DT = 1e-3;

function resetPipeline(pipe: BakePipeline): void {
  pipe.filter.reset();
  pipe.bodyModel.reset();
  pipe.baseline.reset();
  pipe.retargeter.reset();
}

/** Builds a stepper over the recording; `step()` until it returns false, then `finish()`. */
export function createBaker(rec: MocapRecording, pipe: BakePipeline, opts: BakeOptions): Baker {
  if (!(opts.fps > 0)) throw new Error(`bake: fps must be positive, got ${opts.fps}`);
  const frames = rec.frames;
  const n = frames.length;
  if (n === 0) throw new Error('bake: the recording has no frames');
  const maxDt = opts.maxDtSec ?? DEFAULT_MAX_DT;
  const t0 = frames[0].t;
  // Nominal gap (median positive gap) for the pre-roll frames.
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) {
    const g = frames[i].t - frames[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const gapMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1000 / opts.fps;
  const preRoll = Math.max(0, Math.round(((opts.preRollSec ?? DEFAULT_PRE_ROLL_SEC) * 1000) / gapMs));
  const total = preRoll + n;

  const recorder = new ClipRecorder(pipe.retargeter.takeHeader(opts.fps), opts.fps);
  recorder.start(0);
  resetPipeline(pipe);

  let cursor = 0;
  let lastT = NaN;
  let fit: FramingFit | null = null;
  let lastSolve: SolveResult | null = null;
  let finished = false;

  const feed = (frame: PoseFrame, sampleAtSec: number | null): void => {
    const dtRaw = Number.isNaN(lastT) ? gapMs / 1000 : (frame.t - lastT) / 1000;
    lastT = frame.t;
    const dt = Math.min(maxDt, Math.max(MIN_DT, dtRaw));
    const pose = pipe.filter.process(frame);
    fit = fitFraming(pose, fit, dt);
    const body = pipe.bodyModel.update(pose, dt, {
      framing: fit.state,
      noKnee: pipe.noKnee,
      noElbow: pipe.noElbow,
      mirror: pipe.mirror,
    });
    const r = pipe.retargeter;
    pipe.baseline.update(body, pose, fit.state, dt, lastSolve?.depthZ ?? null);
    if (pipe.baseline.isReady) r.setTorsoBaseline(pipe.baseline.torsoBaseline);
    lastSolve = r.solve(body, pose, dt, fit);
    if (sampleAtSec !== null) recorder.push(r.sampleTake(sampleAtSec));
  };

  const baker: Baker = {
    get total() {
      return total;
    },
    get done() {
      return cursor;
    },
    get finished() {
      return finished;
    },
    step() {
      if (finished || cursor >= total) return false;
      if (cursor < preRoll) {
        const k = preRoll - cursor;
        feed({ ...frames[0], t: t0 - k * gapMs }, null);
      } else {
        const i = cursor - preRoll;
        feed(frames[i], (frames[i].t - t0) / 1000);
      }
      cursor++;
      opts.onProgress?.(cursor, total);
      return cursor < total;
    },
    finish() {
      finished = true;
      const take = recorder.stop();
      resetPipeline(pipe);
      return take;
    },
  };
  return baker;
}

/** Bakes synchronously (tests, short takes). */
export function bakeRecording(rec: MocapRecording, pipe: BakePipeline, opts: BakeOptions): Take {
  const baker = createBaker(rec, pipe, opts);
  while (baker.step()) {
    // keep stepping
  }
  return baker.finish();
}

export interface BakeAsyncOptions extends BakeOptions {
  /** Frames processed between yields to the event loop (default 60). */
  yieldEvery?: number;
  signal?: AbortSignal;
}

/** Bakes in slices so a progress bar can repaint; rejects with an AbortError when the signal fires. */
export async function bakeRecordingAsync(rec: MocapRecording, pipe: BakePipeline, opts: BakeAsyncOptions): Promise<Take> {
  const baker = createBaker(rec, pipe, opts);
  const every = Math.max(1, Math.floor(opts.yieldEvery ?? 60));
  let sinceYield = 0;
  try {
    while (baker.step()) {
      if (++sinceYield >= every) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (opts.signal?.aborted) {
          const err = new Error('Baking cancelled');
          err.name = 'AbortError';
          throw err;
        }
      }
    }
    return baker.finish();
  } catch (err) {
    if (!baker.finished) baker.finish();
    throw err;
  }
}
