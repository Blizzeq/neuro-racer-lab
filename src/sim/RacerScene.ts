import Phaser from 'phaser';
import type {
  CameraState,
  ExportSnapshot,
  Point,
  SaveSnapshot,
  TrackDefinition,
  TrackSegment,
  TrainingConfig,
  TrainingStats,
} from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { TrackGenerationError, clamp, createPresetTrack, distance, generateTrack } from '../lib/geometry';
import { hardestSegmentIndex } from '../lib/curriculum';
import { CAR_HALF_AXIS, CAR_RADIUS, SENSOR_ANGLES, type SimCar } from '../lib/simulation';
import { TrainingSession, compareCars } from '../lib/trainingSession';
import { createExportSnapshot, hasSnapshot, loadSnapshot, parseExportSnapshot, saveSnapshot } from '../lib/storage';

type SceneCallbacks = {
  onReady: (scene: RacerScene) => void;
  onStats: (stats: TrainingStats) => void;
  onTrackChange: (track: TrackDefinition) => void;
  onStorageChange: (hasSave: boolean) => void;
  onCameraChange: (camera: CameraState) => void;
  onMessage: (message: string) => void;
};

const CAR_COLORS = [0x38f8d4, 0xd6ff5a, 0xffce45, 0xff5b7c, 0xffd66b, 0xf489ff, 0x67a6ff, 0xff6b5b];
const CAR_TEXTURES = [
  'car-cyan',
  'car-lime',
  'car-amber',
  'car-pink',
  'car-gold',
  'car-purple',
  'car-blue',
  'car-red',
] as const;
const CAR_SPRITE_WIDTH = 30;
const CAR_SPRITE_HEIGHT = 17;
const START_GATE_TEXTURE = 'checkpoint-finish';
const SPAWN_RING_TEXTURE = 'ring-cyan';
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 3;
const FIT_MARGIN = 140;
const FRAME_BUDGET_MS = 12;
const STATS_INTERVAL_MS = 120;
const HEAT_REDRAW_INTERVAL_MS = 400;
const DRAW_POINT_SPACING = 10;
const TRAIL_LEADERS = 5;
const HEAT_TEXTURE = 'heat-dot';
const HEAT_DOT_RADIUS = 14;

/**
 * Phaser renderer and input layer. Owns no training logic: it steps a TrainingSession,
 * draws its state, and maps pointer/wheel/pinch gestures to a camera over an unbounded world.
 */
export class RacerScene extends Phaser.Scene {
  private readonly callbacks: SceneCallbacks;
  private session: TrainingSession;
  private running = false;
  private drawing = false;
  private followBest = false;
  private userZoom = 1;
  private pixelRatio = 1;
  private drawPoints: Point[] = [];
  private drawPointerId: number | null = null;
  private activePointers = new Map<number, { x: number; y: number }>();
  private panPointerId: number | null = null;
  private pinchDistance: number | null = null;
  private domHandlers: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private lastStatsAt = 0;
  private lastHeatAt = 0;
  private lastGridKey = '';
  private lastCameraKey = '';
  private carSprites: Phaser.GameObjects.Image[] = [];
  private decorImages: Phaser.GameObjects.Image[] = [];
  private gridGraphics?: Phaser.GameObjects.Graphics;
  private trackGraphics?: Phaser.GameObjects.Graphics;
  private heatBlitter?: Phaser.GameObjects.Blitter;
  private ghostGraphics?: Phaser.GameObjects.Graphics;
  private dynamicGraphics?: Phaser.GameObjects.Graphics;
  private drawGraphics?: Phaser.GameObjects.Graphics;

  constructor(callbacks: SceneCallbacks) {
    super({ key: 'RacerScene' });
    this.callbacks = callbacks;
    this.session = new TrainingSession(createPresetTrack(), DEFAULT_TRAINING_CONFIG);
  }

  preload(): void {
    for (const key of CAR_TEXTURES) {
      this.load.image(key, `/assets/cars/${key}.png`);
    }
    this.load.image(START_GATE_TEXTURE, '/assets/effects/checkpoint-finish.png');
    this.load.image(SPAWN_RING_TEXTURE, '/assets/effects/ring-cyan.png');
  }

  create(): void {
    this.gridGraphics = this.add.graphics().setDepth(0);
    this.trackGraphics = this.add.graphics().setDepth(1);
    this.createHeatTexture();
    this.heatBlitter = this.add.blitter(0, 0, HEAT_TEXTURE).setDepth(2);
    this.ghostGraphics = this.add.graphics().setDepth(3);
    this.dynamicGraphics = this.add.graphics().setDepth(6);
    this.drawGraphics = this.add.graphics().setDepth(8);
    this.pixelRatio = this.game.scale.zoom > 0 ? 1 / this.game.scale.zoom : 1;
    this.installInput();
    this.onTrackReplaced(false);
    this.callbacks.onReady(this);
    this.callbacks.onStorageChange(hasSnapshot());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.removeInput());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.removeInput());
  }

  update(): void {
    if (this.running) {
      this.advanceSimulation();
    }
    this.updateFollowCamera();
    this.renderFrame();
    const now = performance.now();
    if (now - this.lastStatsAt > STATS_INTERVAL_MS) {
      this.emitStats();
    }
  }

  /** Called by the React stage when its container changes size (CSS pixels). */
  resizeViewport(width: number, height: number): void {
    if (width < 2 || height < 2) {
      return;
    }
    const camera = this.cameras.main;
    const center = { x: camera.scrollX + camera.width / 2, y: camera.scrollY + camera.height / 2 };
    const firstLayout = camera.width <= 1 || camera.height <= 1;
    this.scale.resize(Math.round(width * this.pixelRatio), Math.round(height * this.pixelRatio));
    camera.setSize(this.scale.width, this.scale.height);
    if (firstLayout) {
      this.fitToTrack();
    } else {
      this.centerCameraOn(center);
    }
  }

  applyConfig(config: Partial<TrainingConfig>): void {
    if (this.session.applyConfig(config)) {
      this.syncCarSprites();
      this.drawTrack();
    }
    this.emitStats();
  }

  setRunning(running: boolean): void {
    if (running && this.session.trainingComplete && !this.session.showcaseMode) {
      return;
    }
    this.running = running;
    if (running) {
      this.setDrawing(false);
    }
    this.emitStats();
  }

  setDrawing(drawing: boolean): void {
    this.drawing = drawing;
    this.drawPoints = [];
    this.drawPointerId = null;
    this.drawGraphics?.clear();
    this.updateCursor();
    if (drawing) {
      this.running = false;
    }
    this.emitStats();
  }

  runChampionDemo(): boolean {
    if (!this.session.startChampionRun()) {
      return false;
    }
    this.syncCarSprites();
    this.drawTrack();
    this.running = true;
    this.drawing = false;
    this.emitStats();
    return true;
  }

  loadPresetTrack(): void {
    this.running = false;
    this.session.setTrack(createPresetTrack());
    this.onTrackReplaced(true);
  }

  resetTraining(): void {
    this.running = false;
    this.session.resetTraining();
    this.syncCarSprites();
    this.drawTrack();
    this.emitStats();
  }

  saveCurrentSnapshot(): ExportSnapshot | null {
    const snapshot = saveSnapshot(this.session.track, this.session.champion, this.session.config, this.session.generation);
    this.callbacks.onStorageChange(snapshot !== null);
    return snapshot;
  }

  loadSavedSnapshot(): SaveSnapshot | null {
    const snapshot = loadSnapshot();
    if (!snapshot) {
      return null;
    }
    this.restoreSnapshot(snapshot);
    return snapshot;
  }

  exportCurrentSnapshot(): ExportSnapshot {
    return createExportSnapshot(this.session.track, this.session.champion, this.session.config, this.session.generation);
  }

  importSnapshot(raw: string): ExportSnapshot | null {
    const snapshot = parseExportSnapshot(raw);
    if (!snapshot) {
      return null;
    }
    this.restoreSnapshot(snapshot);
    return snapshot;
  }

  zoomIn(): void {
    this.zoomAtScreenPoint(this.cameras.main.width / 2, this.cameras.main.height / 2, 1.2);
  }

  zoomOut(): void {
    this.zoomAtScreenPoint(this.cameras.main.width / 2, this.cameras.main.height / 2, 1 / 1.2);
  }

  fitToTrack(): void {
    this.followBest = false;
    const camera = this.cameras.main;
    const bounds = this.session.track.bounds;
    const width = bounds.maxX - bounds.minX + FIT_MARGIN * 2;
    const height = bounds.maxY - bounds.minY + FIT_MARGIN * 2;
    const cssWidth = camera.width / this.pixelRatio;
    const cssHeight = camera.height / this.pixelRatio;
    this.setUserZoom(Math.min(cssWidth / width, cssHeight / height, 1.4));
    this.centerCameraOn({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 });
  }

  toggleFollowBest(): CameraState {
    this.followBest = !this.followBest;
    this.emitCamera(true);
    return this.getCameraState();
  }

  getCameraState(): CameraState {
    const camera = this.cameras.main;
    return { zoom: this.userZoom, scrollX: camera.scrollX, scrollY: camera.scrollY, followBest: this.followBest };
  }

  private restoreSnapshot(snapshot: SaveSnapshot): void {
    this.running = false;
    if (snapshot.version === 2) {
      this.session.applyConfig(snapshot.config);
    }
    this.session.setTrack(snapshot.track);
    this.session.restoreChampion(snapshot.bestGenome, snapshot.generation);
    this.onTrackReplaced(true);
  }

  private onTrackReplaced(notify: boolean): void {
    this.drawing = false;
    this.drawPoints = [];
    this.drawGraphics?.clear();
    this.updateCursor();
    this.syncCarSprites();
    this.drawTrack();
    this.refreshTrackDecor();
    this.heatBlitter?.clear();
    if (this.cameras.main.width > 1) {
      this.fitToTrack();
    }
    if (notify) {
      this.callbacks.onTrackChange(this.session.track);
    }
    this.emitStats();
  }

  private advanceSimulation(): void {
    const started = performance.now();
    // Champion runs play in real time so the lap can actually be watched.
    const ticks = this.session.showcaseMode ? 1 : clamp(Math.round(this.session.config.speedMultiplier), 1, 64);
    for (let tick = 0; tick < ticks; tick += 1) {
      const event = this.session.step();
      if (event === 'tick') {
        if (tick % 4 === 3 && performance.now() - started > FRAME_BUDGET_MS) {
          break;
        }
        continue;
      }

      this.syncCarSprites();
      this.drawTrack();
      if (event === 'complete' || event === 'showcaseComplete' || event === 'idle') {
        this.running = false;
        if (event === 'showcaseComplete') {
          this.reportShowcase();
        } else if (event === 'complete') {
          this.callbacks.onMessage('Training complete');
        }
        this.emitStats();
        break;
      }
      this.emitStats();
      if (performance.now() - started > FRAME_BUDGET_MS) {
        break;
      }
    }
  }

  private reportShowcase(): void {
    const result = this.session.lastShowcase;
    if (!result) {
      return;
    }
    this.callbacks.onMessage(result.outcome === 'lap' && result.lapTicks
      ? `Champion lap ${(result.lapTicks / 60).toFixed(2)}s`
      : `Champion run ended: ${result.outcome}`);
  }

  private emitStats(): void {
    this.lastStatsAt = performance.now();
    const status: TrainingStats['status'] = this.drawing ? 'drawing' : this.running ? 'running' : 'paused';
    this.callbacks.onStats(this.session.getStats(status));
  }

  // ---------------------------------------------------------------- rendering

  private renderFrame(): void {
    this.drawGrid();
    const now = performance.now();
    if (now - this.lastHeatAt > HEAT_REDRAW_INTERVAL_MS) {
      this.lastHeatAt = now;
      this.drawHeat();
    }

    const graphics = this.dynamicGraphics;
    if (!graphics) {
      return;
    }
    graphics.clear();
    const cars = this.session.cars;
    const focus = this.session.focusCar();

    const leaders = cars
      .filter((car) => car.trail.length > 2)
      .sort((a, b) => compareCars(b, a))
      .slice(0, TRAIL_LEADERS);
    for (const car of leaders) {
      graphics.lineStyle(car.alive ? 2 : 1, CAR_COLORS[car.slot % CAR_COLORS.length], car.alive ? 0.4 : 0.16);
      graphics.strokePoints(car.alive ? [...car.trail, { x: car.x, y: car.y }] : car.trail, false);
    }

    this.drawGhostFrame(graphics);

    cars.forEach((car, index) => {
      const sprite = this.carSprites[index];
      if (!sprite) {
        return;
      }
      sprite
        .setPosition(car.x, car.y)
        .setRotation(car.angle)
        .setAlpha(car.alive ? (car === focus ? 1 : 0.8) : 0.16)
        .setDepth(car === focus ? 5.5 : 5);
    });

    if (focus) {
      this.drawFocusMarker(graphics, focus);
    }
  }

  private drawFocusMarker(graphics: Phaser.GameObjects.Graphics, car: SimCar): void {
    const cos = Math.cos(car.angle);
    const sin = Math.sin(car.angle);
    const halfLength = CAR_HALF_AXIS + CAR_RADIUS + 3;
    const halfWidth = CAR_RADIUS + 3;
    const corners = [
      [-halfLength, -halfWidth],
      [halfLength, -halfWidth],
      [halfLength, halfWidth],
      [-halfLength, halfWidth],
    ].map(([x, y]) => ({ x: car.x + x * cos - y * sin, y: car.y + x * sin + y * cos }));
    graphics.lineStyle(2, 0xffffff, 0.45);
    graphics.strokePoints(corners, true, true);

    if (!car.alive) {
      return;
    }
    SENSOR_ANGLES.forEach((sensorAngle, sensor) => {
      const angle = car.angle + sensorAngle;
      const reach = car.sensors[sensor];
      const endX = car.x + Math.cos(angle) * reach;
      const endY = car.y + Math.sin(angle) * reach;
      graphics.lineStyle(1, 0x38f8d4, 0.2 + (1 - reach / 260) * 0.45);
      graphics.lineBetween(car.x, car.y, endX, endY);
      graphics.fillStyle(0xffce45, 0.7);
      graphics.fillCircle(endX, endY, 2.2);
    });
  }

  private drawGhostFrame(graphics: Phaser.GameObjects.Graphics): void {
    const replay = this.session.fullLapGhostReplay.length > 3 ? this.session.fullLapGhostReplay : this.session.ghostReplay;
    if (replay.length < 3) {
      return;
    }
    const frame = replay[Math.floor(this.session.generationStep / 4) % replay.length];
    const cos = Math.cos(frame.angle);
    const sin = Math.sin(frame.angle);
    const shape = [[-10, -7], [13, 0], [-10, 7], [-5, 0]].map(([x, y]) => ({
      x: frame.x + x * cos - y * sin,
      y: frame.y + x * sin + y * cos,
    }));
    graphics.fillStyle(0xffffff, 0.28);
    graphics.fillPoints(shape, true, true);
  }

  private drawGhostPaths(): void {
    const graphics = this.ghostGraphics;
    if (!graphics) {
      return;
    }
    graphics.clear();
    if (this.session.fullLapGhostReplay.length > 3) {
      graphics.lineStyle(4, 0xffffff, 0.18);
      graphics.strokePoints(this.session.fullLapGhostReplay, false);
    }
    if (this.session.ghostReplay.length > 3) {
      graphics.lineStyle(3, 0x38f8d4, 0.2);
      graphics.strokePoints(this.session.ghostReplay, false);
    }
  }

  /** Heat dots are blitter bobs sharing one soft texture: far cheaper than tessellating circles each frame. */
  private drawHeat(): void {
    const blitter = this.heatBlitter;
    if (!blitter) {
      return;
    }
    blitter.clear();
    for (const point of this.session.heatPoints) {
      blitter.create(point.x - HEAT_DOT_RADIUS, point.y - HEAT_DOT_RADIUS).setAlpha(0.18 + point.strength * 0.4);
    }
  }

  private createHeatTexture(): void {
    if (this.textures.exists(HEAT_TEXTURE)) {
      return;
    }
    const size = HEAT_DOT_RADIUS * 2;
    const texture = this.textures.createCanvas(HEAT_TEXTURE, size, size);
    const context = texture?.getContext();
    if (!texture || !context) {
      return;
    }
    const gradient = context.createRadialGradient(HEAT_DOT_RADIUS, HEAT_DOT_RADIUS, 0, HEAT_DOT_RADIUS, HEAT_DOT_RADIUS, HEAT_DOT_RADIUS);
    gradient.addColorStop(0, 'rgba(255, 91, 124, 0.55)');
    gradient.addColorStop(1, 'rgba(255, 91, 124, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    texture.refresh();
  }

  private drawGrid(): void {
    const graphics = this.gridGraphics;
    if (!graphics) {
      return;
    }
    const view = this.cameras.main.worldView;
    const cameraZoom = this.cameras.main.zoom;
    const spacing = 80 * cameraZoom >= 10 * this.pixelRatio ? 80 : 400;
    const left = Math.floor(view.x / spacing) * spacing;
    const top = Math.floor(view.y / spacing) * spacing;
    const right = view.right + spacing;
    const bottom = view.bottom + spacing;
    const key = `${left}:${top}:${right}:${bottom}:${spacing}`;
    if (key === this.lastGridKey) {
      return;
    }
    this.lastGridKey = key;
    graphics.clear();
    graphics.lineStyle(1 / cameraZoom, 0x1a2530, 0.75);
    for (let x = left; x <= right; x += spacing) {
      graphics.lineBetween(x, top, x, bottom);
    }
    for (let y = top; y <= bottom; y += spacing) {
      graphics.lineBetween(left, y, right, y);
    }
  }

  private drawTrack(): void {
    const graphics = this.trackGraphics;
    if (!graphics) {
      return;
    }
    const track = this.session.track;
    const left = track.leftBoundary;
    const right = track.rightBoundary;
    const count = track.centerline.length;
    graphics.clear();

    graphics.fillStyle(0x131923, 1);
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      graphics.fillTriangle(left[index].x, left[index].y, left[next].x, left[next].y, right[next].x, right[next].y);
      graphics.fillTriangle(left[index].x, left[index].y, right[next].x, right[next].y, right[index].x, right[index].y);
    }
    graphics.lineStyle(10, 0x202b37, 0.7);
    graphics.strokePoints(left, true, true);
    graphics.strokePoints(right, true, true);
    graphics.lineStyle(3, 0x33f0cf, 0.86);
    graphics.strokePoints(left, true, true);
    graphics.lineStyle(3, 0xffce45, 0.8);
    graphics.strokePoints(right, true, true);
    graphics.lineStyle(1, 0x6b7b8f, 0.35);
    graphics.strokePoints(track.centerline, true, true);

    const active = this.session.activeSegmentIndex;
    const hardest = hardestSegmentIndex(this.session.segmentScores);
    for (const segment of this.session.trackSegments) {
      const isActive = segment.index === active;
      if (isActive || segment.index === hardest) {
        graphics.lineStyle(isActive ? 6 : 4, isActive ? 0x38f8d4 : 0xff5b7c, isActive ? 0.42 : 0.28);
        graphics.strokePoints(this.segmentPoints(segment), false);
      }
      graphics.fillStyle(0x8fa3bb, isActive ? 0.74 : 0.24);
      graphics.fillCircle(segment.spawnPose.x, segment.spawnPose.y, isActive ? 4.2 : 2.6);
    }

    for (const checkpoint of track.checkpoints) {
      const start = checkpoint.index === 0;
      graphics.lineStyle(start ? 4 : 1, start ? 0xffffff : 0x8fa3bb, start ? 0.9 : 0.24);
      graphics.lineBetween(checkpoint.a.x, checkpoint.a.y, checkpoint.b.x, checkpoint.b.y);
    }

    graphics.fillStyle(0x38f8d4, 0.92);
    graphics.fillCircle(track.spawnPose.x, track.spawnPose.y, 5);
    this.drawGhostPaths();
  }

  private segmentPoints(segment: TrackSegment): Point[] {
    const centerline = this.session.track.centerline;
    const points: Point[] = [];
    let index = segment.startIndex;
    for (let guard = 0; guard < centerline.length; guard += 1) {
      points.push(centerline[index]);
      if (index === segment.endIndex) {
        break;
      }
      index = (index + 1) % centerline.length;
    }
    return points;
  }

  private refreshTrackDecor(): void {
    for (const image of this.decorImages) {
      image.destroy();
    }
    this.decorImages = [];
    if (!this.textures.exists(START_GATE_TEXTURE) || !this.textures.exists(SPAWN_RING_TEXTURE)) {
      return;
    }

    const track = this.session.track;
    const start = track.checkpoints[0];
    const gatePosition = start ? { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 } : track.spawnPose;
    const gateWidth = clamp(track.width * 1.14, 78, 150);
    const gate = this.add
      .image(gatePosition.x, gatePosition.y, START_GATE_TEXTURE)
      .setDisplaySize(gateWidth, gateWidth * 0.5)
      .setRotation(track.spawnPose.angle + Math.PI / 2)
      .setAlpha(0.88)
      .setDepth(4);
    const ring = this.add
      .image(track.spawnPose.x, track.spawnPose.y, SPAWN_RING_TEXTURE)
      .setDisplaySize(64, 64)
      .setAlpha(0.38)
      .setDepth(4)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.decorImages.push(gate, ring);
  }

  /** Keeps exactly one sprite per simulated car, reusing images across generations. */
  private syncCarSprites(): void {
    const cars = this.session.cars;
    while (this.carSprites.length < cars.length) {
      const index = this.carSprites.length;
      this.carSprites.push(
        this.add
          .image(0, 0, CAR_TEXTURES[index % CAR_TEXTURES.length])
          .setDisplaySize(CAR_SPRITE_WIDTH, CAR_SPRITE_HEIGHT)
          .setDepth(5),
      );
    }
    this.carSprites.forEach((sprite, index) => {
      const car = cars[index];
      sprite.setVisible(Boolean(car));
      if (car) {
        sprite.setTexture(CAR_TEXTURES[car.slot % CAR_TEXTURES.length]).setDisplaySize(CAR_SPRITE_WIDTH, CAR_SPRITE_HEIGHT);
      }
    });
    this.drawGhostPaths();
  }

  // ---------------------------------------------------------------- camera

  private setUserZoom(zoom: number): void {
    this.userZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.cameras.main.setZoom(this.userZoom * this.pixelRatio);
  }

  private centerCameraOn(point: Point): void {
    const camera = this.cameras.main;
    camera.setScroll(point.x - camera.width / 2, point.y - camera.height / 2);
    this.emitCamera(false);
  }

  /** Converts a canvas-pixel position to world coordinates (camera origin is the viewport center). */
  private screenToWorld(screenX: number, screenY: number): Point {
    const camera = this.cameras.main;
    return {
      x: camera.scrollX + camera.width / 2 + (screenX - camera.width / 2) / camera.zoom,
      y: camera.scrollY + camera.height / 2 + (screenY - camera.height / 2) / camera.zoom,
    };
  }

  private zoomAtScreenPoint(screenX: number, screenY: number, factor: number): void {
    const camera = this.cameras.main;
    const anchor = this.screenToWorld(screenX, screenY);
    this.setUserZoom(this.userZoom * factor);
    camera.setScroll(
      anchor.x - camera.width / 2 - (screenX - camera.width / 2) / camera.zoom,
      anchor.y - camera.height / 2 - (screenY - camera.height / 2) / camera.zoom,
    );
    this.emitCamera(false);
  }

  private panByScreenDelta(dx: number, dy: number): void {
    const camera = this.cameras.main;
    camera.setScroll(camera.scrollX - dx / camera.zoom, camera.scrollY - dy / camera.zoom);
    this.emitCamera(false);
  }

  private updateFollowCamera(): void {
    if (!this.followBest) {
      return;
    }
    const focus = this.session.focusCar();
    if (!focus) {
      return;
    }
    const camera = this.cameras.main;
    const targetX = focus.x - camera.width / 2;
    const targetY = focus.y - camera.height / 2;
    camera.setScroll(camera.scrollX + (targetX - camera.scrollX) * 0.18, camera.scrollY + (targetY - camera.scrollY) * 0.18);
    this.emitCamera(false);
  }

  private emitCamera(force: boolean): void {
    const state = this.getCameraState();
    const key = `${state.zoom.toFixed(3)}:${state.followBest}`;
    if (force || key !== this.lastCameraKey) {
      this.lastCameraKey = key;
      this.callbacks.onCameraChange(state);
    }
  }

  // ---------------------------------------------------------------- input

  private installInput(): void {
    const element = this.game.canvas.parentElement;
    if (!element) {
      return;
    }

    const listen = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler, options);
      this.domHandlers.push({ target, type, handler });
    };

    listen(element, 'contextmenu', (event) => event.preventDefault());
    listen(element, 'wheel', ((event: WheelEvent) => {
      event.preventDefault();
      this.followBest = false;
      const point = this.eventToScreen(event);
      const factor = Math.exp(-clamp(event.deltaY, -120, 120) * (event.ctrlKey ? 0.01 : 0.0022));
      this.zoomAtScreenPoint(point.x, point.y, factor);
    }) as EventListener, { passive: false });
    listen(element, 'pointerdown', ((event: PointerEvent) => this.handlePointerDown(event, element)) as EventListener);
    listen(element, 'pointermove', ((event: PointerEvent) => this.handlePointerMove(event)) as EventListener);
    listen(element, 'pointerup', ((event: PointerEvent) => this.handlePointerUp(event, element)) as EventListener);
    listen(element, 'pointercancel', ((event: PointerEvent) => {
      // An interrupted stroke (OS gesture, palm rejection) must not replace the track.
      if (event.pointerId === this.drawPointerId) {
        this.cancelDrawStroke();
      }
      this.handlePointerUp(event, element);
    }) as EventListener);
    this.updateCursor();
  }

  private removeInput(): void {
    for (const { target, type, handler } of this.domHandlers) {
      target.removeEventListener(type, handler);
    }
    this.domHandlers = [];
  }

  private handlePointerDown(event: PointerEvent, element: HTMLElement): void {
    event.preventDefault();
    element.setPointerCapture?.(event.pointerId);
    const point = this.eventToScreen(event);
    this.activePointers.set(event.pointerId, point);

    if (this.activePointers.size >= 2) {
      this.cancelDrawStroke();
      this.panPointerId = null;
      this.pinchDistance = this.currentPinchDistance();
      return;
    }

    const wantsPan = !this.drawing || event.button === 1 || event.button === 2;
    if (wantsPan) {
      if (this.followBest) {
        this.followBest = false;
        this.emitCamera(true);
      }
      this.panPointerId = event.pointerId;
      element.style.cursor = 'grabbing';
      return;
    }

    this.drawPointerId = event.pointerId;
    this.drawPoints = [this.screenToWorld(point.x, point.y)];
    this.renderDrawPoints();
  }

  private handlePointerMove(event: PointerEvent): void {
    const previous = this.activePointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const point = this.eventToScreen(event);
    this.activePointers.set(event.pointerId, point);

    if (this.activePointers.size >= 2 && this.pinchDistance !== null) {
      const nextDistance = this.currentPinchDistance();
      const center = this.currentPinchCenter();
      if (nextDistance > 0 && this.pinchDistance > 0) {
        this.zoomAtScreenPoint(center.x, center.y, nextDistance / this.pinchDistance);
      }
      this.panByScreenDelta((point.x - previous.x) / 2, (point.y - previous.y) / 2);
      this.pinchDistance = nextDistance;
      return;
    }

    if (event.pointerId === this.panPointerId) {
      this.panByScreenDelta(point.x - previous.x, point.y - previous.y);
      return;
    }

    if (event.pointerId === this.drawPointerId) {
      const world = this.screenToWorld(point.x, point.y);
      const last = this.drawPoints.at(-1);
      if (!last || distance(last, world) > DRAW_POINT_SPACING / this.userZoom) {
        this.drawPoints.push(world);
        this.renderDrawPoints();
      }
    }
  }

  private handlePointerUp(event: PointerEvent, element: HTMLElement): void {
    element.releasePointerCapture?.(event.pointerId);
    this.activePointers.delete(event.pointerId);
    if (this.activePointers.size >= 2) {
      this.pinchDistance = this.currentPinchDistance();
    } else {
      this.pinchDistance = null;
      if (this.activePointers.size === 1 && !this.drawing) {
        // After a pinch the remaining finger keeps panning.
        this.panPointerId = [...this.activePointers.keys()][0];
      }
    }
    if (event.pointerId === this.panPointerId) {
      this.panPointerId = null;
      this.updateCursor();
    }
    if (this.activePointers.size === 0) {
      this.panPointerId = null;
    }
    if (event.pointerId === this.drawPointerId) {
      this.drawPointerId = null;
      this.finishDrawingTrack();
    }
  }

  private finishDrawingTrack(): void {
    if (!this.drawing) {
      return;
    }
    if (this.drawPoints.length < 8) {
      this.cancelDrawStroke();
      this.callbacks.onMessage('Stroke too short. Draw a closed loop.');
      return;
    }
    try {
      const track = generateTrack(this.drawPoints);
      this.session.setTrack(track);
      this.onTrackReplaced(true);
    } catch (error) {
      this.cancelDrawStroke();
      this.callbacks.onMessage(error instanceof TrackGenerationError ? error.message : 'Could not build a track from this stroke.');
    }
  }

  private cancelDrawStroke(): void {
    this.drawPointerId = null;
    this.drawPoints = [];
    this.drawGraphics?.clear();
  }

  private renderDrawPoints(): void {
    const graphics = this.drawGraphics;
    if (!graphics) {
      return;
    }
    graphics.clear();
    if (this.drawPoints.length < 2) {
      return;
    }
    const zoom = this.cameras.main.zoom / this.pixelRatio;
    graphics.lineStyle(4 / zoom, 0xff5b7c, 0.9);
    graphics.strokePoints(this.drawPoints, false);
    graphics.fillStyle(0xffce45, 0.9);
    for (const point of this.drawPoints) {
      graphics.fillCircle(point.x, point.y, 2.2 / zoom);
    }
  }

  private eventToScreen(event: MouseEvent): Point {
    const rect = this.game.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.pixelRatio,
      y: (event.clientY - rect.top) * this.pixelRatio,
    };
  }

  private currentPinchDistance(): number {
    const [a, b] = [...this.activePointers.values()];
    return a && b ? distance(a, b) : 0;
  }

  private currentPinchCenter(): Point {
    const [a, b] = [...this.activePointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  }

  private updateCursor(): void {
    const element = this.game?.canvas?.parentElement;
    if (element) {
      element.style.cursor = this.drawing ? 'crosshair' : 'grab';
    }
  }
}
