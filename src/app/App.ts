/**
 * Application shell. The full orchestration (sources, rig, solver, stage,
 * recorders, panels) is assembled here; until those modules land this boots a
 * minimal status view so the build pipeline can be exercised end to end.
 */
export class App {
  constructor(private readonly root: HTMLElement) {}

  async start(): Promise<void> {
    this.root.innerHTML = '';
    const status = document.createElement('div');
    status.id = 'boot-status';
    status.textContent = 'CameraCharacter is starting…';
    this.root.appendChild(status);
  }
}
