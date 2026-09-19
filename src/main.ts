import { App } from './app/App';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const app = new App(root);
app.start().catch((err: unknown) => {
  console.error('CameraCharacter failed to start', err);
});

// Expose for debugging and end-to-end tests.
declare global {
  interface Window {
    cameraCharacter?: App;
  }
}
window.cameraCharacter = app;
