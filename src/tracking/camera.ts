/**
 * Webcam access helpers (browser only). Kept separate from the sources so the
 * app can open a camera once and share the video element with the preview,
 * the MediaPipe source and the video recorder.
 */

export interface OpenCameraOptions {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface OpenedCamera {
  stream: MediaStream;
  video: HTMLVideoElement;
}

function requireMediaDevices(): MediaDevices {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getUserMedia !== 'function') {
    throw new Error('Camera access is not available (navigator.mediaDevices.getUserMedia missing; use HTTPS or localhost)');
  }
  return md;
}

let permissionPrimed = false;

/**
 * List video input devices. Labels are only populated after the page has been
 * granted camera permission, so a throw-away stream is requested once.
 */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const md = requireMediaDevices();
  let devices = await md.enumerateDevices();
  let cams = devices.filter((d) => d.kind === 'videoinput');
  const unlabeled = cams.length === 0 || cams.some((d) => !d.label);
  if (unlabeled && !permissionPrimed) {
    try {
      const probe = await md.getUserMedia({ video: true, audio: false });
      for (const t of probe.getTracks()) t.stop();
      permissionPrimed = true;
      devices = await md.enumerateDevices();
      cams = devices.filter((d) => d.kind === 'videoinput');
    } catch {
      // Permission denied or no camera: return whatever enumerateDevices gave us.
    }
  }
  return cams;
}

function buildConstraints(opts: OpenCameraOptions): MediaStreamConstraints {
  const video: MediaTrackConstraints = {};
  if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
  else video.facingMode = 'user';
  if (opts.width) video.width = { ideal: opts.width };
  if (opts.height) video.height = { ideal: opts.height };
  if (opts.frameRate) video.frameRate = { ideal: opts.frameRate };
  return { video, audio: false };
}

/**
 * Open a camera stream into a muted, inline, autoplaying video element and
 * resolve once metadata is loaded and playback has started.
 */
export async function openCamera(opts: OpenCameraOptions = {}): Promise<OpenedCamera> {
  const md = requireMediaDevices();
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia(buildConstraints(opts));
  } catch (err) {
    if (opts.deviceId) {
      // The stored device may be unplugged: retry with any camera.
      stream = await md.getUserMedia(buildConstraints({ ...opts, deviceId: undefined }));
    } else {
      throw err;
    }
  }
  permissionPrimed = true;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.srcObject = stream;

  await new Promise<void>((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolve();
      return;
    }
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Video element failed to load the camera stream'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });

  try {
    await video.play();
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    throw err;
  }
  return { stream, video };
}

/** Stop every track of the element's stream and detach it. */
export function closeCamera(video: HTMLVideoElement): void {
  const src = video.srcObject;
  if (src && 'getTracks' in src) {
    for (const t of (src as MediaStream).getTracks()) t.stop();
  }
  try {
    video.pause();
  } catch {
    // ignore
  }
  video.srcObject = null;
  video.removeAttribute('src');
}

/** Actual capture size of an opened camera, [width, height]. */
export function captureSize(video: HTMLVideoElement): [number, number] {
  return [video.videoWidth || 0, video.videoHeight || 0];
}
