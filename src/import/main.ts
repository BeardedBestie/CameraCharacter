import { ImportApp } from './ImportApp';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const app = new ImportApp(root);
app.start().catch((err: unknown) => {
  console.error('CameraCharacter import page failed to start', err);
});

// Exposed for debugging and end-to-end tests.
declare global {
  interface Window {
    cameraCharacterImport?: ImportApp;
  }
}
window.cameraCharacterImport = app;
