/**
 * Browser download helpers (anchor click with an object URL) and a pure
 * timestamped filename helper.
 */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

export function downloadArrayBuffer(buffer: ArrayBuffer, filename: string, mime = 'application/octet-stream'): void {
  downloadBlob(new Blob([buffer], { type: mime }), filename);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local-time stamp `YYYYMMDD-HHMMSS`. */
export function timestamp(date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** `${prefix}-YYYYMMDD-HHMMSS.${ext}` with the prefix sanitized for file systems. */
export function timestampedFilename(prefix: string, ext: string, date = new Date()): string {
  const safe = prefix.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'take';
  const cleanExt = ext.replace(/^\.+/, '');
  return `${safe}-${timestamp(date)}.${cleanExt}`;
}
