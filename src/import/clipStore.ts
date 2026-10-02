/**
 * Persistence for imported clips (docs/DESIGN.md §17.6): the extracted take,
 * a thumbnail, the camera track and (when small enough) the source video
 * blob, so a reload of /import/ brings the library back. IndexedDB in the
 * browser, an in-memory store elsewhere (tests, private mode without storage).
 * Light summaries live in their own object store so listing the library does
 * not load every take and video.
 */
import type { MocapRecording } from '../core/types';
import type { CameraTrackJson } from './CameraTrack';

export interface ClipStats {
  frames: number;
  detectedFrames: number;
  durationMs: number;
  sampleFps: number;
  width: number;
  height: number;
}

export interface ClipSummary {
  id: string;
  name: string;
  createdAt: string;
  stats: ClipStats;
  /** Data URL of a small poster frame, when available. */
  thumbnail?: string;
  hasVideo: boolean;
  videoBytes: number;
}

export interface StoredClip extends Omit<ClipSummary, 'hasVideo' | 'videoBytes'> {
  recording: MocapRecording;
  video?: Blob;
  videoType?: string;
  cameraTrack?: CameraTrackJson;
}

export interface ClipStore {
  readonly kind: 'indexeddb' | 'memory';
  list(): Promise<ClipSummary[]>;
  get(id: string): Promise<StoredClip | null>;
  put(clip: StoredClip): Promise<void>;
  /** Merge a partial update (camera track, name) into a stored clip. No-op when the id is unknown. */
  patch(id: string, patch: Partial<Pick<StoredClip, 'name' | 'cameraTrack' | 'thumbnail'>>): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const CLIP_DB_NAME = 'cameracharacter-import';
export const CLIP_DB_VERSION = 1;
const CLIPS = 'clips';
const SUMMARIES = 'summaries';
/** Videos above this size are not persisted (the take still is). */
export const MAX_STORED_VIDEO_BYTES = 200 * 1024 * 1024;

export function summarize(clip: StoredClip): ClipSummary {
  const out: ClipSummary = {
    id: clip.id,
    name: clip.name,
    createdAt: clip.createdAt,
    stats: { ...clip.stats },
    hasVideo: !!clip.video,
    videoBytes: clip.video?.size ?? 0,
  };
  if (clip.thumbnail) out.thumbnail = clip.thumbnail;
  return out;
}

/** Sortable, URL-safe id: time prefix plus random suffix. */
export function newClipId(now: Date = new Date(), random: () => number = Math.random): string {
  const time = now.getTime().toString(36).padStart(9, '0');
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += Math.floor(random() * 36).toString(36);
  return `${time}-${suffix}`;
}

/** Statistics of a recording for the clip list. */
export function statsOf(rec: MocapRecording): ClipStats {
  const frames = rec.frames.length;
  let detected = 0;
  for (const f of rec.frames) if (f.pose) detected++;
  const durationMs = frames > 1 ? rec.frames[frames - 1].t - rec.frames[0].t : 0;
  const v = rec.meta.video;
  const sampleFps = v?.sampleFps ?? (durationMs > 0 && frames > 1 ? ((frames - 1) * 1000) / durationMs : 30);
  return {
    frames,
    detectedFrames: v?.detectedFrames ?? detected,
    durationMs: v?.durationMs ?? durationMs,
    sampleFps: Math.round(sampleFps * 100) / 100,
    width: v?.width ?? rec.meta.size[0],
    height: v?.height ?? rec.meta.size[1],
  };
}

export class MemoryClipStore implements ClipStore {
  readonly kind = 'memory' as const;
  private readonly clips = new Map<string, StoredClip>();

  async list(): Promise<ClipSummary[]> {
    return Array.from(this.clips.values())
      .map(summarize)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<StoredClip | null> {
    return this.clips.get(id) ?? null;
  }

  async put(clip: StoredClip): Promise<void> {
    this.clips.set(clip.id, { ...clip });
  }

  async patch(id: string, patch: Partial<Pick<StoredClip, 'name' | 'cameraTrack' | 'thumbnail'>>): Promise<void> {
    const cur = this.clips.get(id);
    if (!cur) return;
    this.clips.set(id, { ...cur, ...patch });
  }

  async delete(id: string): Promise<void> {
    this.clips.delete(id);
  }

  async clear(): Promise<void> {
    this.clips.clear();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbClipStore implements ClipStore {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = CLIP_DB_NAME): Promise<IndexedDbClipStore> {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, CLIP_DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(CLIPS)) d.createObjectStore(CLIPS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(SUMMARIES)) d.createObjectStore(SUMMARIES, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });
    return new IndexedDbClipStore(db);
  }

  async list(): Promise<ClipSummary[]> {
    const tx = this.db.transaction(SUMMARIES, 'readonly');
    const all = (await request(tx.objectStore(SUMMARIES).getAll())) as ClipSummary[];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<StoredClip | null> {
    const tx = this.db.transaction(CLIPS, 'readonly');
    const clip = (await request(tx.objectStore(CLIPS).get(id))) as StoredClip | undefined;
    return clip ?? null;
  }

  async put(clip: StoredClip): Promise<void> {
    const stored: StoredClip = { ...clip };
    if (stored.video && stored.video.size > MAX_STORED_VIDEO_BYTES) {
      delete stored.video;
      delete stored.videoType;
    }
    const tx = this.db.transaction([CLIPS, SUMMARIES], 'readwrite');
    tx.objectStore(CLIPS).put(stored);
    tx.objectStore(SUMMARIES).put(summarize(stored));
    await transactionDone(tx);
  }

  async patch(id: string, patch: Partial<Pick<StoredClip, 'name' | 'cameraTrack' | 'thumbnail'>>): Promise<void> {
    const tx = this.db.transaction([CLIPS, SUMMARIES], 'readwrite');
    const store = tx.objectStore(CLIPS);
    const cur = (await request(store.get(id))) as StoredClip | undefined;
    if (!cur) return;
    const next = { ...cur, ...patch };
    store.put(next);
    tx.objectStore(SUMMARIES).put(summarize(next));
    await transactionDone(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([CLIPS, SUMMARIES], 'readwrite');
    tx.objectStore(CLIPS).delete(id);
    tx.objectStore(SUMMARIES).delete(id);
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([CLIPS, SUMMARIES], 'readwrite');
    tx.objectStore(CLIPS).clear();
    tx.objectStore(SUMMARIES).clear();
    await transactionDone(tx);
  }
}

/** IndexedDB when available and working, else the in-memory store. */
export async function openClipStore(): Promise<ClipStore> {
  try {
    return await IndexedDbClipStore.open();
  } catch {
    return new MemoryClipStore();
  }
}
