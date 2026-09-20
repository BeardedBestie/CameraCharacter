/**
 * Stage (docs/DESIGN.md §8): owns the renderer, scene, lights, floor/grid,
 * shadows, environment, resize and the camera modes. Browser only (WebGL, DOM,
 * ResizeObserver). All camera math lives in MirrorCamera.ts.
 */
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraMode, StageSettings } from '../core/types';
import { MirrorCameraController, type MirrorCameraInput } from './MirrorCamera';
import { disposeObject, enableShadows, findSpawn } from './placement';
import { installViewportInput } from './viewportInput';

export interface StageOptions {
  /** Cap on the device pixel ratio (default 2). */
  maxPixelRatio?: number;
  /** Radius of the floor disc in meters (default 6). */
  floorRadius?: number;
  /** Extent of the shadow camera's orthographic box in meters (default 4). */
  shadowExtent?: number;
}

const DEFAULT_CAMERA_POSITION = new Vector3(0, 1.0, 3.2);
const DEFAULT_CAMERA_TARGET = new Vector3(0, 0.9, 0);

export class Stage {
  readonly container: HTMLElement;
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly mirrorCamera: MirrorCameraController;
  readonly hemiLight: HemisphereLight;
  readonly keyLight: DirectionalLight;
  readonly fillLight: DirectionalLight;
  readonly floor: Mesh<CircleGeometry, MeshStandardMaterial>;
  readonly grid: GridHelper;

  /** Called every frame before rendering (after the camera update). */
  onBeforeRender: ((dt: number, stage: Stage) => void) | null = null;
  /** Called after a drag or wheel on the viewport switched the camera to orbit mode. */
  onCameraTakeover: (() => void) | null = null;
  /** Called on a double-click on the viewport; the app returns to its automatic camera. */
  onResetView: (() => void) | null = null;

  private settings: StageSettings;
  private model: Object3D | null = null;
  private environment: Object3D | null = null;
  private spawn: Vector3 | null = null;
  private readonly modelOriginValue = new Vector3();
  private cameraInput: MirrorCameraInput | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private removeViewportInput: (() => void) | null = null;
  private readonly onWindowResize = (): void => this.resize();
  private disposed = false;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement, settings: StageSettings, opts: StageOptions = {}) {
    this.container = container;
    this.settings = { ...settings };

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(Math.min(dpr, opts.maxPixelRatio ?? 2));
    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.touchAction = 'none';
    container.appendChild(el);

    this.scene.background = new Color(settings.background);

    this.camera = new PerspectiveCamera(settings.mirrorCameraFovDeg, 1, 0.05, 200);
    this.camera.position.copy(DEFAULT_CAMERA_POSITION);
    this.camera.lookAt(DEFAULT_CAMERA_TARGET);

    this.hemiLight = new HemisphereLight(0xdfe6ff, 0x3a3630, 1.1);
    this.hemiLight.position.set(0, 10, 0);
    this.scene.add(this.hemiLight);

    const extent = opts.shadowExtent ?? 4;
    this.keyLight = new DirectionalLight(0xfff4e6, 2.6);
    this.keyLight.position.set(2.5, 4.5, 3);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 25;
    this.keyLight.shadow.camera.left = -extent;
    this.keyLight.shadow.camera.right = extent;
    this.keyLight.shadow.camera.top = extent;
    this.keyLight.shadow.camera.bottom = -extent;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 4;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new DirectionalLight(0xbcd0ff, 0.7);
    this.fillLight.position.set(-3, 2, -2.5);
    this.scene.add(this.fillLight);

    const floorGeometry = new CircleGeometry(opts.floorRadius ?? 6, 96);
    floorGeometry.rotateX(-Math.PI / 2);
    this.floor = new Mesh(
      floorGeometry,
      new MeshStandardMaterial({ color: 0x262931, roughness: 0.95, metalness: 0.0 }),
    );
    this.floor.receiveShadow = true;
    this.floor.name = 'stage-floor';
    this.scene.add(this.floor);

    this.grid = new GridHelper(12, 24, 0x5b6270, 0x353a45);
    this.grid.position.y = 0.002;
    const gridMaterial = this.grid.material as Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.55;
    gridMaterial.depthWrite = false;
    this.grid.name = 'stage-grid';
    this.scene.add(this.grid);

    this.controls = new OrbitControls(this.camera, el);
    this.controls.target.copy(DEFAULT_CAMERA_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.95;
    this.controls.enabled = settings.cameraMode === 'orbit';

    this.mirrorCamera = new MirrorCameraController(this.camera, {
      vfovDeg: settings.mirrorCameraFovDeg,
      controls: this.controls,
      mode: settings.cameraMode,
    });

    // Standard mouse/touch camera controls in every mode: the first drag or
    // wheel hands the camera to OrbitControls from where the automatic camera
    // left it (rotate, zoom, pan); a double-click asks the app to hand it back.
    this.removeViewportInput = installViewportInput(el, {
      isManual: () => this.mirrorCamera.mode === 'orbit',
      onTakeOver: () => {
        this.setCameraMode('orbit');
        this.onCameraTakeover?.();
      },
      onResetView: () => this.onResetView?.(),
    });

    this.applySettings(settings);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
    }
    this.resize();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Viewport size in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get cameraMode(): CameraMode {
    return this.mirrorCamera.mode;
  }

  /** Where the character stands: the environment's spawn point or the origin. */
  get modelOrigin(): Vector3 {
    return this.modelOriginValue;
  }

  get currentModel(): Object3D | null {
    return this.model;
  }

  get currentEnvironment(): Object3D | null {
    return this.environment;
  }

  /** Applies a settings snapshot (background, floor/grid, camera mode and FOV). */
  applySettings(settings: StageSettings): void {
    this.settings = { ...settings };
    const bg = this.scene.background;
    if (bg instanceof Color) bg.set(settings.background);
    else this.scene.background = new Color(settings.background);
    this.floor.visible = settings.showFloor;
    this.grid.visible = settings.showGrid;
    this.mirrorCamera.setOptions({ vfovDeg: settings.mirrorCameraFovDeg });
    this.setCameraMode(settings.cameraMode);
  }

  setCameraMode(mode: CameraMode): void {
    const wasOrbit = this.mirrorCamera.mode === 'orbit';
    this.mirrorCamera.setMode(mode);
    this.controls.enabled = mode === 'orbit';
    if (mode === 'orbit' && !wasOrbit) this.controls.update();
    if (mode !== 'orbit' && wasOrbit) this.mirrorCamera.reset();
    this.settings.cameraMode = mode;
  }

  /** Per-frame camera input (framing fit, height table, hips); null freezes the mirror camera. */
  setCameraInput(input: MirrorCameraInput | null): void {
    this.cameraInput = input;
  }

  /** Places the model wrapper at the origin (or at the environment's spawn point). */
  setModel(wrapper: Object3D | null): void {
    if (this.model && this.model !== wrapper) this.scene.remove(this.model);
    this.model = wrapper;
    if (!wrapper) return;
    enableShadows(wrapper, { cast: true, receive: false });
    wrapper.position.copy(this.modelOriginValue);
    if (wrapper.parent !== this.scene) this.scene.add(wrapper);
    wrapper.updateMatrixWorld(true);
    this.mirrorCamera.reset();
  }

  /**
   * Adds an environment scene (or removes it with null). The character moves
   * to the environment's 'spawn' empty when there is one, else to the origin.
   * `spawn` overrides the marker search (e.g. from `loadEnvironment`).
   */
  setEnvironment(root: Object3D | null, spawn?: Vector3 | null): void {
    if (this.environment && this.environment !== root) this.scene.remove(this.environment);
    this.environment = root;
    if (root) {
      if (root.parent !== this.scene) this.scene.add(root);
      root.updateMatrixWorld(true);
      this.spawn = spawn !== undefined ? (spawn ? spawn.clone() : null) : findSpawn(root);
    } else {
      this.spawn = null;
    }
    this.modelOriginValue.copy(this.spawn ?? new Vector3());
    // Keep the floor and grid under the character (its feet are at origin.y).
    this.floor.position.set(this.modelOriginValue.x, this.modelOriginValue.y, this.modelOriginValue.z);
    this.grid.position.set(this.modelOriginValue.x, this.modelOriginValue.y + 0.002, this.modelOriginValue.z);
    this.keyLight.target.position.copy(this.modelOriginValue);
    if (this.model) {
      this.model.position.copy(this.modelOriginValue);
      this.model.updateMatrixWorld(true);
    }
    this.mirrorCamera.reset();
  }

  /** Whether the built-in floor is drawn (an environment usually brings its own). */
  setFloorVisible(visible: boolean): void {
    this.settings.showFloor = visible;
    this.floor.visible = visible;
  }

  setGridVisible(visible: boolean): void {
    this.settings.showGrid = visible;
    this.grid.visible = visible;
  }

  setBackground(color: string): void {
    this.settings.background = color;
    const bg = this.scene.background;
    if (bg instanceof Color) bg.set(color);
    else this.scene.background = new Color(color);
  }

  /** Recomputes the viewport from the container's size. */
  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Advances the camera by `dt` seconds and renders the scene. */
  render(dt: number): void {
    if (this.disposed) return;
    if (this.cameraInput) {
      this.mirrorCamera.update(dt, this.cameraInput);
    } else if (this.mirrorCamera.mode === 'orbit') {
      this.controls.update(dt);
    }
    this.onBeforeRender?.(dt, this);
    this.renderer.render(this.scene, this.camera);
  }

  /** Releases the renderer, controls and stage-owned geometry. Loaded models/environments are left to their owners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onWindowResize);
    this.removeViewportInput?.();
    this.removeViewportInput = null;
    this.controls.dispose();
    if (this.model) this.scene.remove(this.model);
    if (this.environment) this.scene.remove(this.environment);
    this.model = null;
    this.environment = null;
    disposeObject(this.floor);
    this.grid.geometry.dispose();
    (this.grid.material as Material).dispose();
    this.keyLight.shadow.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
