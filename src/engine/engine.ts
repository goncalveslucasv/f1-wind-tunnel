import type * as VGPU from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { HEAT, LBM_INIT, LBM_STEP, PARTICLES_DRAW, PARTICLES_SIM, VOXELIZE } from "./wgsl";
import { BLUR, PRESENT, RENDER, STREAM_DRAW, STREAM_SIM, TAA } from "./render-wgsl";
import { CAR_LAYOUT, W17_FRONT_LEVELS, W17_REAR_LEVELS, partsAtlas, rigUniform, type RigData } from "./car-model";
import type { MeshCar } from "./mesh-car";

type V = typeof VGPU;
type Gpu = VGPU.Gpu;
type Storage = VGPU.StorageBuffer;
type Vec3 = [number, number, number];

export type QualityId = "low" | "medium" | "high";
export const QUALITIES: Record<QualityId, { nx: number; ny: number; nz: number; particles: number }> = {
  low: { nx: 168, ny: 50, nz: 38, particles: 40_000 },
  medium: { nx: 232, ny: 68, nz: 52, particles: 80_000 },
  high: { nx: 296, ny: 88, nz: 66, particles: 140_000 },
};

const DOMAIN_LENGTH = 10.4;
const ORIGIN_X = -2.4;
const FORCE_SCALE = 10_000;
const AIR_DENSITY = 1.225;
export const PROFILE_W = 256;
export const PROFILE_H = 128;
const WG = 128;
const MAX_LINES = 160;
const STREAM_STEPS = 360;

export enum ShapeKind { F1 = 0, Sphere = 1, Cube = 2, Wing = 3, Custom = 4, W17 = 5, Empty = 6 }

export const isRaceCar = (k: ShapeKind) => k === ShapeKind.F1 || k === ShapeKind.W17;
export enum ColorField { Speed = 0, Pressure = 1, Temperature = 2, Vorticity = 3, Wake = 4 }
export enum FlowMode { None = 0, Streamlines = 1, Smoke = 2, Fog = 3, Vortices = 4 }

export interface ShapeParams {
  kind: ShapeKind;
  frontWing: number;
  rearWing: number;
  sidepod: number;
  cover: number;
  nose: number;
  rearRideH: number;
  rearMainDeg: number;
  gurney: boolean;
  frontWingOn: boolean;
  rearWingOn: boolean;
  /** 0 standard, 1 Monza spoon, 2 Monaco board. */
  rearShape: number;
  thinWings: boolean;
  /** 0 standard, 1 compact. */
  sidepods: number;
  /** 0 closed, 1 normal, 2 open. */
  cooling: number;
  frontFlapDeg: number;
  rearFlapDeg: number;
  rideH: number;
  aoaDeg: number;
  customMode: 0 | 1;
  customWidth: number;
  customAxisY: number;
  heatBrakes: boolean;
  heatEngine: boolean;
  heatRad: boolean;
}

export interface CustomProfile {
  sdf: Float32Array<ArrayBuffer>;
  originX: number;
  originY: number;
  cell: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface Livery {
  paint: Vec3;
  accent: Vec3;
  carbon: boolean;
}

export interface ViewParams {
  colorField: ColorField;
  surfaceField: boolean;
  sliceAxis: 0 | 1 | 2 | 3;
  slicePos: number;
  flowMode: FlowMode;
  kmh: number;
  livery: Livery;
}

export interface CameraState {
  pos: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  fovY: number;
  viewProj: Float32Array;
}

export interface ForcePair { drag: number; down: number }
export interface Forces {
  dragN: number;
  downforceN: number;
  body: ForcePair;
  frontWing: ForcePair;
  rearWing: ForcePair;
}

const DEG = Math.PI / 180;
const LATTICE_U = 0.0925;
const REAR_SHAPE_TWIST: Record<number, number> = { 0: 0, 1: -16, 2: 6 };
const THIN_FLAP_SCALE = 0.72;
const COMPACT_POD_SQUEEZE = 0.32;
const COOLING_HEAT = [1.55, 1, 0.6];
// Sidepod duct size for closed / normal / open cooling (W17 only).
const COOLING_DUCT = [0, 1, 1.3];

const prep = (wgsl: string, name: string) => prepareShader(wgsl, name);

export function f1Anchors(rideH: number) {
  const yw = 0.19 + rideH * 0.45;
  const yr = rideH + 0.8;
  return {
    frontWing: [0.25, yw + 0.12, 0.67] as Vec3,
    floor: [2.89, rideH, 0.43] as Vec3,
    diffuser: [4.65, rideH + 0.18, 0.34] as Vec3,
    rearWing: [5.0, yr + 0.18, 0.29] as Vec3,
    sidepod: [2.32, rideH + 0.45, 0.6] as Vec3,
    center: [2.79, rideH + 0.35, 0] as Vec3,
    yw,
    yr,
  };
}

/** Maps a point of the W17 body (modelled at its base ride height) into the tunnel frame. */
export function w17Place(p: Pick<ShapeParams, "rideH" | "rearRideH">, x: number, y: number, z: number): Vec3 {
  const rake = Math.atan((p.rearRideH - p.rideH) / (CAR_LAYOUT.wheels.rear.x - CAR_LAYOUT.frontAxleX));
  const c = Math.cos(rake), s = Math.sin(rake);
  const bx = x - CAR_LAYOUT.frontAxleX, by = y - CAR_LAYOUT.baseRideH;
  return [CAR_LAYOUT.frontAxleX + c * bx - s * by, p.rideH + s * bx + c * by, z];
}

/** Label anchors and pick volumes on the W17 itself. */
export function carAnchors(p: ShapeParams) {
  if (p.kind !== ShapeKind.W17) return f1Anchors(p.rideH);
  const at = (x: number, y: number, z: number) => w17Place(p, x, y, z);
  return {
    frontWing: at(0.3, 0.36, 0.55),
    floor: at(2.9, 0.1, 0.62),
    diffuser: at(4.8, 0.3, 0.42),
    rearWing: at(4.85, 0.93, 0.35),
    sidepod: at(2.6, 0.5, 0.55),
    center: at(2.7, 0.45, 0),
    yw: 0,
    yr: 0,
  };
}

export class AeroEngine {
  readonly dims: [number, number, number];
  readonly n: number;
  readonly h: number;
  readonly origin: Vec3;
  readonly particleCount: number;

  private fA: Storage;
  private fB: Storage;
  private solid: Storage;
  private emit: Storage;
  private fields: Storage;
  private tA: Storage;
  private tB: Storage;
  private forces: Storage;
  private parts: Storage;
  private profile: Storage;
  private linePts: Storage;

  private init: VGPU.Compute;
  private initB: VGPU.Compute;
  private lbm: [VGPU.Compute, VGPU.Compute];
  private heat: [VGPU.Compute, VGPU.Compute];
  private voxelize: VGPU.Compute;
  private psim: VGPU.Compute;
  private ssim: VGPU.Compute;

  private scene: VGPU.Target;
  private gbuf: VGPU.Target;
  private carSdf: VGPU.Texture;
  private carParts: VGPU.Texture;
  private rig: RigData | null = null;
  private rigState: ReturnType<typeof rigUniform> | null = null;
  private fly: [number, number] = [0, 0];
  private flyTarget: [number, number] = [0, 0];
  private meshCar: MeshCar | null = null;
  private glow: VGPU.Target;
  private bloomA: VGPU.Target;
  private bloomB: VGPU.Target;
  private hist: [VGPU.Target, VGPU.Target];
  private resolve: [VGPU.Effect, VGPU.Effect];
  private presentFrom: [VGPU.Effect, VGPU.Effect];
  private prevViewProj: Float32Array | null = null;
  private historyValid = false;
  private render: VGPU.Effect;
  private blurH: VGPU.Effect;
  private blurV: VGPU.Effect;
  private particles: VGPU.Draw;
  private streams: VGPU.Draw;

  private uLb = LATTICE_U;
  private uLbTarget = LATTICE_U;
  private frameNo = 0;
  private scatterFrames = 2;
  private stepsSinceRead = 0;
  private reading = false;
  private shapeParams!: ShapeParams;
  private viewParams!: ViewParams;
  private bounds = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
  private time = 0;
  private flowTime = 0;
  private profileMeta?: CustomProfile;
  private outSize: [number, number] = [1, 1];
  private renderScale = 1;

  onForces?: (f: Forces) => void;

  constructor(private V: V, private gpu: Gpu, quality: QualityId, size: readonly [number, number]) {
    const q = QUALITIES[quality];
    this.dims = [q.nx, q.ny, q.nz];
    this.n = q.nx * q.ny * q.nz;
    this.h = DOMAIN_LENGTH / q.nx;
    this.origin = [ORIGIN_X, 0, 0];
    this.particleCount = q.particles;

    const n = this.n;
    this.fA = V.storage(gpu, n * 19 * 4);
    this.fB = V.storage(gpu, n * 19 * 4);
    this.solid = V.storage(gpu, n * 4);
    this.emit = V.storage(gpu, n * 4);
    this.fields = V.storage(gpu, n * 16);
    this.tA = V.storage(gpu, n * 4);
    this.tB = V.storage(gpu, n * 4);
    this.forces = V.storage(gpu, 48);
    this.parts = V.storage(gpu, this.particleCount * 32);
    this.linePts = V.storage(gpu, MAX_LINES * STREAM_STEPS * 16);
    this.profile = V.storage(gpu, PROFILE_W * PROFILE_H * 4);
    this.profile.write(new Float32Array(PROFILE_W * PROFILE_H).fill(10));

    const grid = { dims: this.dims, n, origin: this.origin, h: this.h };
    const sim = { uIn: this.uLb, tau0: 0.508, smag: 0.17, pad: 0 };

    const initShader = prep(LBM_INIT, "lbm-init.wgsl");
    this.init = V.compute(gpu, initShader, { label: "lbm-init", set: { grid, sim, fa: this.fA, fields: this.fields } });
    this.initB = V.compute(gpu, initShader, { label: "lbm-init-b", set: { grid, sim, fa: this.fB, fields: this.fields } });

    const stepShader = prep(LBM_STEP, "lbm-step.wgsl");
    const common = { grid, sim, solid: this.solid, emit: this.emit, fields: this.fields, forces: this.forces };
    this.lbm = [
      V.compute(gpu, stepShader, { label: "lbm-ab", set: { ...common, fin: this.fA, fout: this.fB } }),
      V.compute(gpu, stepShader, { label: "lbm-ba", set: { ...common, fin: this.fB, fout: this.fA } }),
    ];

    const heatShader = prep(HEAT, "heat.wgsl");
    const heatU = { dt: 3, cool: 0.004, diffuse: 0.04, pad: 0 };
    this.heat = [
      V.compute(gpu, heatShader, { label: "heat-ab", set: { grid, heat: heatU, fields: this.fields, emit: this.emit, tin: this.tA, tout: this.tB } }),
      V.compute(gpu, heatShader, { label: "heat-ba", set: { grid, heat: heatU, fields: this.fields, emit: this.emit, tin: this.tB, tout: this.tA } }),
    ];

    const [sx, sy, sz] = CAR_LAYOUT.sdf.dims;
    this.carSdf = V.texture(gpu, { kind: "3d", size: [sx, sy, sz], format: "r16float", usage: ["texture_binding", "copy_dst"], label: "car-sdf" });
    const carSamp = V.sampler(gpu, { magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.carParts = V.texture(gpu, { kind: "3d", size: [1, 1, 1], format: "r16float", usage: ["texture_binding", "copy_dst"], label: "car-parts" });
    const rig = {
      front: Array.from({ length: 71 }, () => [0, 0, 0, 0]),
      hinges: [0, 0, 0, 0], angles: [0, 0, 0, 0], extra: [0, 1, 0, 0], fly: [0, 0, 1, 1],
      grids: Array.from({ length: 12 }, () => [0, 0, 0, 1]),
    };
    this.voxelize = V.compute(gpu, prep(VOXELIZE, "voxelize.wgsl"), {
      label: "voxelize",
      set: { grid, profile: this.profile, solid: this.solid, emit: this.emit, carSdf: this.carSdf, carSamp, carParts: this.carParts, rig },
    });
    this.psim = V.compute(gpu, prep(PARTICLES_SIM, "particles-sim.wgsl"), {
      label: "particles-sim", set: { grid, fields: this.fields, temps: this.tA, parts: this.parts },
    });
    this.ssim = V.compute(gpu, prep(STREAM_SIM, "stream-sim.wgsl"), {
      label: "stream-sim", set: { grid, fields: this.fields, temps: this.tA, pts: this.linePts },
    });

    this.outSize = [size[0], size[1]];
    const [w, h] = [Math.max(1, size[0]), Math.max(1, size[1])];
    const half: [number, number] = [Math.max(1, w >> 1), Math.max(1, h >> 1)];
    this.scene = V.target(gpu, { size: [w, h], format: "rgba16float" });
    this.gbuf = V.target(gpu, {
      size: [w, h],
      colors: [{ format: "rgba16float" }, { format: "rgba16float" }, { format: "rgba8unorm" }],
      depth: true,
      clearColor: [0, 0, 0, 0],
      label: "car-gbuffer",
    });
    this.glow = V.target(gpu, { size: [w, h], format: "rgba16float", clearColor: [0, 0, 0, 0] });
    this.hist = [
      V.target(gpu, { size: [w, h], format: "rgba16float" }),
      V.target(gpu, { size: [w, h], format: "rgba16float" }),
    ];
    this.bloomA = V.target(gpu, { size: half, format: "rgba16float" });
    this.bloomB = V.target(gpu, { size: half, format: "rgba16float" });

    this.render = V.effect(gpu, prep(RENDER, "render.wgsl"), {
      label: "render",
      set: {
        grid, profile: this.profile, fields: this.fields, temps: this.tA, carSdf: this.carSdf, carSamp, carParts: this.carParts, rig,
        gAlbedo: this.gbuf.colors[0], gNormal: this.gbuf.colors[1], gMaterial: this.gbuf.colors[2],
      },
    });
    const blurShader = prep(BLUR, "blur.wgsl");
    this.blurH = V.effect(gpu, blurShader, { label: "blur-h", set: { src: this.glow, blur: { dir: [1, 0], spacing: 3.0, gain: 1 } } });
    this.blurV = V.effect(gpu, blurShader, { label: "blur-v", set: { src: this.bloomA, blur: { dir: [0, 1], spacing: 1.5, gain: 1 } } });
    const taaShader = prep(TAA, "taa.wgsl");
    this.resolve = [
      V.effect(gpu, taaShader, { label: "taa-0", set: { cur: this.scene, hist: this.hist[1] } }),
      V.effect(gpu, taaShader, { label: "taa-1", set: { cur: this.scene, hist: this.hist[0] } }),
    ];
    const presentShader = prep(PRESENT, "present.wgsl");
    const post = { bloom: 0.75, exposure: 1.0, pad0: 0, pad1: 0 };
    this.presentFrom = [
      V.effect(gpu, presentShader, { label: "present-0", set: { scene: this.hist[0], glow: this.glow, bloomTex: this.bloomB, post } }),
      V.effect(gpu, presentShader, { label: "present-1", set: { scene: this.hist[1], glow: this.glow, bloomTex: this.bloomB, post } }),
    ];
    const additive = { color: { src: "one", dst: "one" }, alpha: { src: "one", dst: "one" } } as const;
    this.particles = V.draw(gpu, {
      shader: prep(PARTICLES_DRAW, "particles-draw.wgsl"),
      label: "particles",
      vertices: 6,
      instances: this.particleCount * 2,
      blend: additive,
      set: { parts: this.parts, scene: this.scene },
    });
    this.streams = V.draw(gpu, {
      shader: prep(STREAM_DRAW, "stream-draw.wgsl"),
      label: "streamlines",
      vertices: 6,
      blend: additive,
      set: { pts: this.linePts, scene: this.scene },
    });
  }

  setRenderScale(scale: number) {
    if (Math.abs(scale - this.renderScale) < 1e-3) return;
    this.renderScale = scale;
    this.resize(this.outSize);
  }

  get scale() { return this.renderScale; }

  resize(size: readonly [number, number]) {
    this.outSize = [size[0], size[1]];
    const [w, h] = [Math.max(1, Math.round(size[0] * this.renderScale)), Math.max(1, Math.round(size[1] * this.renderScale))];
    this.scene.resize([w, h]);
    this.gbuf.resize([w, h]);
    this.render.set({ gAlbedo: this.gbuf.colors[0], gNormal: this.gbuf.colors[1], gMaterial: this.gbuf.colors[2] });
    this.hist[0].resize([w, h]);
    this.hist[1].resize([w, h]);
    this.historyValid = false;
    this.glow.resize([Math.max(1, size[0]), Math.max(1, size[1])]);
    this.bloomA.resize([Math.max(1, w >> 1), Math.max(1, h >> 1)]);
    this.bloomB.resize([Math.max(1, w >> 1), Math.max(1, h >> 1)]);
  }

  get speedLattice() { return this.uLb; }

  reset() {
    const wg = Math.ceil(this.n / WG);
    this.syncSim();
    this.V.frame(this.gpu, (f) => f.computePass((pass) => {
      pass.dispatch(this.init, wg);
      pass.dispatch(this.initB, wg);
    }));
    this.tA.write(new Float32Array(this.n));
    this.tB.write(new Float32Array(this.n));
    this.scatterFrames = 2;
  }

  setProfile(profile: CustomProfile) {
    this.profile.write(profile.sdf);
    this.profileMeta = profile;
  }

  // Detached wings fly off over ~1.3 s and fly back in when refitted; only the mesh animates,
  // the tunnel geometry switches as soon as the setup changes.
  /** Particles and streamline pulses move with the wind speed, relative to 250 km/h. */
  private visualFlowRate() {
    return Math.min(1.6, Math.max(0.35, (this.viewParams?.kmh ?? 250) / 250));
  }

  private animateWings(dt: number) {
    if (!this.rigState || !this.meshCar) return;
    let moved = false;
    for (const i of [0, 1] as const) {
      const d = this.flyTarget[i] - this.fly[i];
      if (Math.abs(d) < 1e-4) continue;
      this.fly[i] = this.flyTarget[i] > this.fly[i] ? Math.min(1, this.fly[i] + dt * 0.75) : Math.max(0, this.fly[i] - dt * 1.4);
      moved = true;
    }
    if (!moved) return;
    const f = this.rigState.fly;
    this.rigState = { ...this.rigState, fly: [this.fly[0], this.fly[1], f[2], f[3]] };
    this.meshCar.setRig(this.rigState);
  }

  setCarModel(mesh: MeshCar, sdf: Uint16Array, parts: Uint16Array, rig: RigData) {
    const [sx, sy, sz] = CAR_LAYOUT.sdf.dims;
    const device = (this.gpu as unknown as { device: { gpu: GPUDevice } }).device.gpu;
    device.queue.writeTexture({ texture: this.carSdf.gpu }, sdf, { bytesPerRow: sx * 2, rowsPerImage: sy }, [sx, sy, sz]);
    const atlas = partsAtlas(rig, parts);
    this.carParts = this.V.texture(this.gpu, { kind: "3d", size: atlas.dims, format: "r16float", usage: ["texture_binding", "copy_dst"], label: "car-parts" });
    device.queue.writeTexture({ texture: this.carParts.gpu }, atlas.data, { bytesPerRow: atlas.dims[0] * 2, rowsPerImage: atlas.dims[1] }, atlas.dims);
    this.voxelize.set({ carParts: this.carParts });
    this.render.set({ carParts: this.carParts });
    this.rig = rig;
    this.meshCar = mesh;
    if (this.shapeParams) this.setShape(this.shapeParams);
  }

  get hasCarModel() { return this.meshCar !== null; }

  setShape(p: ShapeParams) {
    this.shapeParams = p;
    const meta = this.profileMeta;
    const shape = {
      kind: p.kind,
      profileMode: p.customMode,
      pw: PROFILE_W,
      ph: PROFILE_H,
      frontFlap: (p.frontFlapDeg + 14) * DEG,
      rearMain: 9 * DEG,
      rearFlap: (p.rearFlapDeg + 32) * DEG,
      rideH: p.rideH,
      aoa: p.aoaDeg * DEG,
      width: p.customWidth,
      axisY: p.customAxisY,
      pScale: meta?.cell ?? 0.02,
      pOrigin: [meta?.originX ?? 0, meta?.originY ?? 0],
      heatBrakes: p.heatBrakes ? 520 : 0,
      heatEngine: p.heatEngine ? 620 * COOLING_HEAT[p.cooling ?? 1] : 0,
      heatRad: p.heatRad ? 75 * COOLING_HEAT[p.cooling ?? 1] : 0,
      frontWing: p.frontWing, rearWing: p.rearWing, sidepod: p.sidepod,
      cover: p.cover, nose: p.nose, rearRide: p.rearRideH, duct: COOLING_DUCT[p.cooling ?? 1],
    };
    if (this.meshCar) this.meshCar.gurney = p.gurney;
    if (this.rig) {
      const front = W17_FRONT_LEVELS[p.frontWing] ?? W17_FRONT_LEVELS[0];
      const rear = W17_REAR_LEVELS[p.rearWing] ?? W17_REAR_LEVELS[0];
      const frontDeg = p.frontFlapDeg + front.flap;
      const rig = rigUniform(this.rig, [frontDeg * 0.8 * DEG, frontDeg * DEG, (p.rearFlapDeg + rear.flap) * DEG, (rear.main + p.rearMainDeg) * DEG], {
        rearTwist: (REAR_SHAPE_TWIST[p.rearShape] ?? 0) * DEG,
        flapScale: p.thinWings ? THIN_FLAP_SCALE : 1,
        podSqueeze: p.sidepods === 1 ? COMPACT_POD_SQUEEZE : 0,
        fly: [this.fly[0], this.fly[1], p.frontWingOn ? 1 : 0, p.rearWingOn ? 1 : 0],
      });
      this.rigState = rig;
      this.flyTarget = [p.frontWingOn ? 0 : 1, p.rearWingOn ? 0 : 1];
      this.voxelize.set({ rig });
      this.render.set({ rig });
      this.meshCar?.setRig(rig);
    }
    this.voxelize.set({ shape });
    this.render.set({ shape });
    this.bounds = this.shapeBounds(p);
    this.V.frame(this.gpu, (f) => f.computePass((pass) => pass.dispatch(this.voxelize, Math.ceil(this.n / WG))));
  }

  get shapeBox() { return this.bounds; }

  private shapeBounds(p: ShapeParams): { min: Vec3; max: Vec3 } {
    switch (p.kind) {
      case ShapeKind.F1: return { min: [-0.08, 0, -0.98], max: [5.46, p.rideH + 1.34, 0.98] };
      case ShapeKind.W17: return { min: [-0.3, 0, -0.98], max: [5.2, p.rideH + 1.16, 0.98] };
      case ShapeKind.Empty: return { min: [2.6, 0.5, -0.05], max: [2.7, 0.6, 0.05] };
      case ShapeKind.Sphere: return { min: [1.95, 0.35, -0.65], max: [3.25, 1.65, 0.65] };
      case ShapeKind.Cube: return { min: [2.05, 0.45, -0.55], max: [3.15, 1.55, 0.55] };
      case ShapeKind.Wing: return { min: [1.3, 0.2, -1.3], max: [3.6, 2.2, 1.3] };
      default: {
        const b = this.profileMeta?.bounds ?? { minX: 0, maxX: 1, minY: 0, maxY: 1 };
        const zr = p.customMode === 1 ? Math.max(b.maxY - p.customAxisY, p.customAxisY - b.minY) : p.customWidth;
        return { min: [b.minX - 0.05, Math.max(0, b.minY - 0.05), -zr - 0.05], max: [b.maxX + 0.05, b.maxY + 0.05, zr + 0.05] };
      }
    }
  }

  setView(v: ViewParams) {
    this.viewParams = v;
    // The lattice runs at a fixed Mach/Reynolds point; forces are scaled to the real speed, so the
    // coefficients (and the top speed derived from them) do not drift with the wind speed.
    this.uLbTarget = LATTICE_U;
  }

  private syncSim() {
    const sim = { uIn: this.uLb };
    this.init.set({ sim }); this.initB.set({ sim });
    this.lbm[0].set({ sim }); this.lbm[1].set({ sim });
  }

  private viewUniform() {
    const v = this.viewParams;
    const vReal = v.kmh / 3.6;
    const stag = 0.5 * vReal * vReal / 1005;
    const p = this.shapeParams;
    const hot = isRaceCar(p.kind) && (p.heatBrakes || p.heatEngine || p.heatRad);
    return {
      uIn: this.uLb,
      vReal,
      cpMin: -1.1,
      cpMax: 0.7,
      tMin: hot ? 0 : -stag * 1.4,
      tMax: hot ? 220 : stag * 1.05,
      speedMax: 1.5,
      vortMax: 0.6,
    };
  }

  temperatureRange(): [number, number] {
    const u = this.viewUniform();
    return [25 + u.tMin, 25 + u.tMax];
  }

  private emitterPoints(): { e: number[][]; count: number } {
    const p = this.shapeParams;
    let pts: number[][];
    if (p.kind === ShapeKind.W17) {
      // Vortex cores of the real W17: endplate tips of both wings, the inboard front-wing vortex
      // and the floor-edge vortex, placed in the body frame and moved with ride height and rake.
      const place = (x: number, y: number, z: number, r: number) => [...w17Place(p, x, y, z), r];
      pts = [
        ...(p.frontWingOn ? [place(0.62, 0.44, 0.69, 0.05), place(0.5, 0.27, 0.2, 0.04)] : []),
        ...(p.rearWingOn ? [place(5.13, 0.96, 0.57, 0.05)] : []),
        place(2.4, 0.16, 0.86, 0.05),
      ];
    } else if (isRaceCar(p.kind)) {
      const a = f1Anchors(p.rideH);
      pts = [
        [0.52, a.yw + 0.2, 0.926, 0.06],
        [0.52, a.yw + 0.07, 0.21, 0.05],
        [5.36, a.yr + 0.26, 0.494, 0.06],
        [2.22, p.rideH + 0.06, 0.79, 0.05],
      ];
    } else {
      const b = this.bounds;
      pts = [
        [b.max[0], b.max[1] - 0.05, b.max[2] - 0.05, 0.08],
        [b.max[0], b.min[1] + 0.05, b.max[2] - 0.05, 0.08],
        [b.max[0], (b.min[1] + b.max[1]) / 2, 0.05, 0.1],
      ];
    }
    const e = Array.from({ length: 8 }, (_, i) => pts[i] ?? [0, 0, 0, 0]);
    return { e, count: pts.length };
  }

  private streamConfig() {
    const v = this.viewParams;
    if (v.flowMode === FlowMode.Vortices) {
      const em = this.emitterPoints();
      const perEmitter = Math.floor(MAX_LINES / em.count);
      return { lines: perEmitter * em.count, seedMode: 1, perEmitter, emitters: em.count, e: em.e, stepLen: 0.022, rows: 1, cols: 1, min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
    }
    const b = this.bounds;
    const isF1 = isRaceCar(this.shapeParams.kind);
    const rows = 18;
    const cols = 5;
    const min: Vec3 = [-1.2, isF1 ? 0.05 : Math.max(0.04, b.min[1] - 0.2), 0.03];
    const max: Vec3 = [0, isF1 ? 1.3 : b.max[1] + 0.2, isF1 ? 0.95 : b.max[2] + 0.2];
    return { lines: rows * cols, seedMode: 0, perEmitter: 1, emitters: 1, e: this.emitterPoints().e, stepLen: 0.03, rows, cols, min, max };
  }

  frame(target: VGPU.Target | VGPU.Surface, cam: CameraState, steps: number, dt: number) {
    const V = this.V;
    this.time += dt;
    this.flowTime += dt * this.visualFlowRate();
    this.animateWings(dt);
    this.frameNo++;
    this.uLb += (this.uLbTarget - this.uLb) * 0.03;
    this.syncSim();
    const view = this.viewUniform();
    const v = this.viewParams;
    const wg = Math.ceil(this.n / WG);
    const evenSteps = Math.max(2, steps - (steps % 2));
    const size = this.scene.size;
    const outSize = this.glow.size;
    const colorMode = v.colorField === ColorField.Vorticity ? 0 : v.colorField;

    const useParticles = v.flowMode === FlowMode.Smoke || v.flowMode === FlowMode.Fog;
    const useStreams = v.flowMode === FlowMode.Streamlines || v.flowMode === FlowMode.Vortices;

    if (useParticles) {
      const spawn = this.spawnRegion();
      this.psim.set({
        view,
        psim: {
          count: this.particleCount,
          spawnMode: v.flowMode === FlowMode.Fog ? 0 : 1,
          colorMode,
          frame: this.frameNo,
          dt: evenSteps * this.visualFlowRate(),
          life: 900,
          scatter: this.scatterFrames > 0 ? 1 : 0,
          rakeRows: spawn.rows,
          rakeCols: spawn.cols,
          spawnMin: spawn.min,
          spawnMax: spawn.max,
          pad: 0,
        },
      });
      if (this.scatterFrames > 0) this.scatterFrames--;
      this.particles.set({
        pd: {
          viewProj: cam.viewProj,
          camPos: cam.pos,
          width: Math.max(1.4, outSize[1] / 700) * (v.flowMode === FlowMode.Smoke ? 1.4 : 1.1),
          res: [outSize[0], outSize[1]],
          trail: v.flowMode === FlowMode.Smoke ? 6 : 3,
          alpha: v.flowMode === FlowMode.Smoke ? 0.08 : 0.16,
          count: this.particleCount,
          palette: colorMode,
          fadeIn: 8,
          pad: 0,
        },
      });
    }

    let lines = 0;
    if (useStreams) {
      const sc = this.streamConfig();
      lines = sc.lines;
      this.ssim.set({
        view,
        stream: {
          lines: sc.lines, steps: STREAM_STEPS, seedMode: sc.seedMode, colorMode,
          seedMin: sc.min, rows: sc.rows,
          seedMax: sc.max, cols: sc.cols,
          stepLen: sc.stepLen, time: this.flowTime, perEmitter: sc.perEmitter, emitters: sc.emitters,
        },
        emitters: { e: sc.e },
      });
      this.streams.set({
        sd: {
          viewProj: cam.viewProj,
          camPos: cam.pos,
          width: Math.max(1.4, outSize[1] / 760),
          res: [outSize[0], outSize[1]],
          time: this.flowTime,
          intensity: v.flowMode === FlowMode.Vortices ? 1.0 : 0.5,
          lines: sc.lines,
          steps: STREAM_STEPS,
          palette: colorMode,
          pulse: 2.6,
        },
      });
    }

    this.heat[0].set({ heat: { dt: evenSteps / 2 } });
    this.heat[1].set({ heat: { dt: evenSteps / 2 } });

    const k = (this.frameNo % 8) + 1;
    const jx = halton(k, 2) - 0.5;
    const jy = halton(k, 3) - 0.5;
    const cur = this.frameNo & 1;
    const viewProj = Float32Array.from(cam.viewProj);
    this.resolve[cur].set({
      taa: {
        prevViewProj: this.prevViewProj ?? viewProj,
        camPos: cam.pos, tanHalf: Math.tan(cam.fovY / 2),
        fwd: cam.fwd, aspect: size[0] / size[1],
        right: cam.right, blend: this.historyValid ? 0.1 : 1,
        up: cam.up, pad: 0,
      },
    });
    this.prevViewProj = viewProj;
    this.historyValid = true;

    const meshMode = this.shapeParams.kind === ShapeKind.W17 && this.meshCar !== null;
    if (meshMode) {
      this.meshCar!.setCamera({
        viewProj: cam.viewProj, camPos: cam.pos, jitter: [-jx * 2 / size[0], jy * 2 / size[1]],
        rideH: this.shapeParams.rideH,
        rake: Math.atan((this.shapeParams.rearRideH - this.shapeParams.rideH) / (CAR_LAYOUT.wheels.rear.x - CAR_LAYOUT.frontAxleX)),
      });
    }

    const liv = v.livery;
    this.render.set({
      cam: {
        pos: cam.pos, tanHalf: Math.tan(cam.fovY / 2),
        fwd: cam.fwd, aspect: size[0] / size[1],
        right: cam.right, time: this.time,
        up: cam.up, roadSpeed: v.kmh / 3.6 * 0.12,
        jitter: [jx * 2 / size[0], -jy * 2 / size[1]], pad0: 0, pad1: 0,
      },
      look: {
        bmin: this.bounds.min, surfMode: v.surfaceField ? 1 : 0,
        bmax: this.bounds.max, palette: v.colorField,
        paint: liv.paint, carbonBody: liv.carbon ? 1 : 0,
        accent: liv.accent, isF1: this.shapeParams.kind === ShapeKind.F1 ? 1 : 0,
        sliceAxis: v.sliceAxis, slicePos: v.slicePos, sliceAlpha: 0.82, showFlow: 1,
        meshMode: meshMode ? 1 : 0, cooling: this.shapeParams.cooling ?? 1, pad1: 0, pad2: 0,
      },
      view,
    });

    V.frame(this.gpu, (f) => {
      f.computePass((pass) => {
        for (let s = 0; s < evenSteps; s++) pass.dispatch(this.lbm[s % 2], wg);
        pass.dispatch(this.heat[0], wg);
        pass.dispatch(this.heat[1], wg);
        if (useParticles) pass.dispatch(this.psim, Math.ceil(this.particleCount / WG));
        if (useStreams) pass.dispatch(this.ssim, Math.ceil(lines / 64));
      });
      if (meshMode) f.pass({ target: this.gbuf, clear: [0, 0, 0, 0] }, (p) => this.meshCar!.record(p));
      f.pass(this.scene, this.render);
      f.pass(this.hist[cur], this.resolve[cur]);
      f.pass({ target: this.glow, clear: [0, 0, 0, 0] }, (p) => {
        if (useParticles) p.draw(this.particles);
        if (useStreams) p.draw(this.streams, { instances: lines * 2 * (STREAM_STEPS - 1) });
      });
      f.pass(this.bloomA, this.blurH);
      f.pass(this.bloomB, this.blurV);
      f.pass(target, this.presentFrom[cur]);
    });
    this.stepsSinceRead += evenSteps;
    this.maybeReadForces();
  }

  private spawnRegion() {
    const b = this.bounds;
    const zMax = Math.max(0.3, b.max[2] + 0.25);
    const yMax = Math.max(0.5, b.max[1] + 0.25);
    const yMin = isRaceCar(this.shapeParams.kind) ? 0.04 : Math.max(0.04, b.min[1] - 0.25);
    return { min: [ORIGIN_X + this.h * 2, yMin, 0.0] as Vec3, max: [0, yMax, zMax] as Vec3, rows: 12, cols: 7 };
  }

  private maybeReadForces() {
    if (this.reading || this.frameNo % 8 !== 0) return;
    this.reading = true;
    const steps = this.stepsSinceRead;
    this.stepsSinceRead = 0;
    const uLb = this.uLb;
    const vReal = this.viewParams.kmh / 3.6;
    const pending = this.forces.read();
    this.forces.write(new Int32Array(12));
    pending.then((buf) => {
      this.reading = false;
      if (steps === 0) return;
      const raw = new Int32Array(buf);
      const scale = (1 / FORCE_SCALE / steps) * AIR_DENSITY * (vReal / uLb) ** 2 * this.h * this.h * 2;
      const pair = (g: number): ForcePair => ({ drag: raw[g * 3] * scale, down: -raw[g * 3 + 1] * scale });
      const body = pair(0), frontWing = pair(1), rearWing = pair(2);
      this.onForces?.({
        dragN: body.drag + frontWing.drag + rearWing.drag,
        downforceN: body.down + frontWing.down + rearWing.down,
        body, frontWing, rearWing,
      });
    }).catch((err) => { this.reading = false; console.warn("force readback failed", err); });
  }

  async debugRead() {
    const f = new Float32Array(await this.fields.read());
    const s = new Uint32Array(await this.solid.read());
    const t = new Float32Array(await this.tA.read());
    return { fields: f, solid: s, temps: t };
  }
}

function halton(i: number, base: number) {
  let f = 1;
  let r = 0;
  for (let n = i; n > 0; n = Math.floor(n / base)) {
    f /= base;
    r += f * (n % base);
  }
  return r;
}
