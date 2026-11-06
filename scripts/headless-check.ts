import { writeFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";
import * as V from "vgpu/node";
import { AeroEngine, ColorField, FlowMode, ShapeKind, type QualityId, type ShapeParams, type ViewParams } from "../src/engine/engine";
import { orbitCamera, type Orbit } from "../src/engine/camera";
import { readFileSync } from "node:fs";
import { MeshCar } from "../src/engine/mesh-car";
import type { RigData } from "../src/engine/car-model";

const quality = (process.argv[2] ?? "medium") as QualityId;
const frames = Number(process.argv[3] ?? 240);
const only = process.argv[4];
const outDir = new URL("../.check/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const gpu = await V.init();
const W = 1280, H = 720;
const out = V.target(gpu, { size: [W, H], format: "rgba8unorm" });
const engine = new AeroEngine(V as never, gpu, quality, [W, H]);

const shape: ShapeParams = {
  kind: ShapeKind.F1, frontWing: 0, rearWing: 0, sidepod: 0, cover: 0, nose: 0, rearRideH: 0.12, rearMainDeg: 0, gurney: false, frontWingOn: true, rearWingOn: true, rearShape: 0, thinWings: false, sidepods: 0, cooling: 1, frontFlapDeg: 0, rearFlapDeg: 0, rideH: 0.10, aoaDeg: 6,
  customMode: 0, customWidth: 0.5, customAxisY: 1, heatBrakes: true, heatEngine: true, heatRad: true,
};
const base: ViewParams = {
  colorField: ColorField.Speed, surfaceField: false, sliceAxis: 0, slicePos: 0, flowMode: FlowMode.Streamlines, kmh: 250,
  livery: { paint: [0.38, 0.4, 0.43], accent: [0.0, 0.82, 0.75], carbon: true },
};

let lastForces: unknown = null;
engine.onForces = (f) => { lastForces = f; };
engine.setView(base);
engine.setShape(shape);
engine.reset();

const orbit = (o: Partial<Orbit>) => orbitCamera({ target: [2.75, 0.42, 0], yaw: 2.3, pitch: 0.3, distance: 7.6, ...o }, W / H);

async function snap(name: string) {
  const px = await out.color.read({ mipLevel: 0, region: "all" });
  const png = new PNG({ width: W, height: H });
  png.data.set(px);
  writeFileSync(outDir + name, PNG.sync.write(png));
}

const t0 = performance.now();
for (let i = 0; i < frames; i++) {
  engine.frame(out, orbit({}), 8, 1 / 60);
  if (i % 40 === 0) await new Promise((r) => setTimeout(r, 0));
}
const t1 = performance.now();

const { fields, solid } = await engine.debugRead();
let bad = 0, solidCount = 0, uMax = 0;
for (let i = 0; i < engine.n; i++) {
  if (solid[i]) { solidCount++; continue; }
  const u = Math.hypot(fields[i * 4], fields[i * 4 + 1], fields[i * 4 + 2]);
  if (!Number.isFinite(u) || !Number.isFinite(fields[i * 4 + 3])) bad++;
  uMax = Math.max(uMax, u);
}
console.log(JSON.stringify({ quality, dims: engine.dims, solidCount, bad, uMax, msPerFrame: (t1 - t0) / frames, forces: lastForces }));

const shots: [string, Partial<ViewParams>, Partial<Orbit>][] = [
  ["hero", {}, {}],
  ["side-neon", {}, { yaw: Math.PI / 2, pitch: 0.02, distance: 7.2, target: [2.75, 0.5, 0] }],
  ["front-pressure", { colorField: ColorField.Pressure, surfaceField: true, flowMode: FlowMode.None }, { yaw: Math.PI + 0.001, pitch: 0.12, distance: 5.0, target: [2.4, 0.5, 0] }],
  ["vortices", { flowMode: FlowMode.Vortices }, { yaw: 2.55, pitch: 0.25, distance: 4.0, target: [0.9, 0.3, 0.6] }],
  ["clean", { flowMode: FlowMode.None }, { yaw: 2.1, pitch: 0.22, distance: 6.6 }],
  ["low-pressure", { colorField: ColorField.Pressure, surfaceField: true, flowMode: FlowMode.None }, { yaw: 2.0, pitch: 0.04, distance: 7.0, target: [2.7, 0.35, 0] }],
  ["helmet", { flowMode: FlowMode.None }, { yaw: 2.5, pitch: 0.3, distance: 1.3, target: [2.67, 0.83, 0] }],
  ["rear", { flowMode: FlowMode.Smoke }, { yaw: 0.5, pitch: 0.28, distance: 5.5, target: [4.6, 0.6, 0] }],
];
for (const [name, v, o] of shots) {
  if (only && !name.includes(only)) continue;
  engine.setView({ ...base, ...v });
  for (let i = 0; i < 6; i++) engine.frame(out, orbit(o), 2, 1 / 60);
  await snap(`${name}.png`);
}
const wingShots: [string, Partial<ShapeParams>, Partial<Orbit>][] = [
  ...[0, 1, 2, 3].map((v): [string, Partial<ShapeParams>, Partial<Orbit>] => [`front-wing-${v}`, { frontWing: v }, { yaw: 2.75, pitch: 0.22, distance: 2.6, target: [0.3, 0.3, 0.45] }]),
  ...[0, 1, 2].map((v): [string, Partial<ShapeParams>, Partial<Orbit>] => [`rear-wing-${v}`, { rearWing: v }, { yaw: 1.2, pitch: 0.15, distance: 2.4, target: [5.0, 0.9, 0.2] }]),
  ...[0, 1, 2, 3].map((v): [string, Partial<ShapeParams>, Partial<Orbit>] => [`body-sidepod-${v}`, { sidepod: v }, { yaw: 2.6, pitch: 0.18, distance: 4.2, target: [2.9, 0.35, 0.3] }]),
  ...[0, 1, 2].map((v): [string, Partial<ShapeParams>, Partial<Orbit>] => [`body-cover-${v}`, { cover: v }, { yaw: 0.6, pitch: 0.75, distance: 4.0, target: [3.6, 0.5, 0] }]),
  ...[0, 1, 2].map((v): [string, Partial<ShapeParams>, Partial<Orbit>] => [`body-nose-${v}`, { nose: v }, { yaw: 2.2, pitch: 0.12, distance: 2.8, target: [0.6, 0.3, 0.1] }]),
];
for (const [name, sp, o] of wingShots) {
  if (!only || !name.includes(only)) continue;
  console.error(name);
  engine.setView({ ...base, flowMode: FlowMode.None });
  engine.setShape({ ...shape, ...sp });
  for (let i = 0; i < 8; i++) engine.frame(out, orbit(o), 2, 1 / 60);
  await snap(`${name}.png`);
}
if (only && only.startsWith("w17")) {
  const dir = new URL("../public/models/", import.meta.url).pathname;
  const ab = (name: string) => { const b = readFileSync(dir + name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const rig = JSON.parse(readFileSync(dir + "w17.rig.json", "utf8")) as RigData;
  const mesh = await MeshCar.load(V as never, gpu, ab("w17.glb"), new Uint8Array(ab("w17.rig.bin")), async (bytes) => {
    const img = PNG.sync.read(Buffer.from(bytes));
    return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
  }, rig.wings.rear[rig.wings.rear.length - 1]);
  engine.setCarModel(mesh, new Uint16Array(ab("w17.sdf.bin")), new Uint16Array(ab("w17.parts.bin")), rig);
  const w17Shots: [string, Partial<ShapeParams>, Partial<Orbit>][] = [
    ["w17-rear", {}, { yaw: 0.35, pitch: 0.45, distance: 2.2, target: [4.85, 0.9, 0.15] }],
    ["w17-rear-straight", { frontFlapDeg: -12, rearFlapDeg: -28 }, { yaw: 0.35, pitch: 0.45, distance: 2.2, target: [4.85, 0.9, 0.15] }],
    ["w17-rear-gurney", { gurney: true }, { yaw: 0.9, pitch: 0.25, distance: 1.2, target: [4.95, 0.93, 0.25] }],
    ["w17-fly", { rearWingOn: false, frontWingOn: false }, { yaw: 2.2, pitch: 0.3, distance: 9.5, target: [2.7, 1.0, 0] }],
    ["w17-pods-0", {}, { yaw: 1.2, pitch: 0.75, distance: 4.4, target: [3.0, 0.4, 0] }],
    ["w17-pods-1", { sidepods: 1, cooling: 2 }, { yaw: 1.2, pitch: 0.75, distance: 4.4, target: [3.0, 0.4, 0] }],
    ["w17-spoon-0", {}, { yaw: 0.05, pitch: 0.12, distance: 2.6, target: [4.9, 0.85, 0] }],
    ["w17-spoon-1", { rearShape: 1, thinWings: true }, { yaw: 0.05, pitch: 0.12, distance: 2.6, target: [4.9, 0.85, 0] }],
    ["w17-spoon-2", { rearShape: 2 }, { yaw: 0.05, pitch: 0.12, distance: 2.6, target: [4.9, 0.85, 0] }],
    ["w17-rear-high", { rearWing: 1 }, { yaw: 0.35, pitch: 0.45, distance: 2.2, target: [4.85, 0.9, 0.15] }],
    ["w17-front", {}, { yaw: 2.6, pitch: 0.35, distance: 1.9, target: [0.2, 0.28, 0.3] }],
    ["w17-front-straight", { frontFlapDeg: -12, rearFlapDeg: -28 }, { yaw: 2.6, pitch: 0.35, distance: 1.9, target: [0.2, 0.28, 0.3] }],
    ["w17-front-high", { frontWing: 1, frontFlapDeg: 6 }, { yaw: 2.6, pitch: 0.35, distance: 1.9, target: [0.2, 0.28, 0.3] }],
  ];
  for (const [name, sp, o] of w17Shots) {
    if (!name.startsWith(only)) continue;
    console.error(name);
    engine.setView({ ...base, flowMode: FlowMode.None });
    engine.setShape({ ...shape, kind: ShapeKind.W17, rideH: 0.12, rearRideH: 0.14, ...sp });
    for (let i = 0; i < (name === "w17-fly" ? 42 : 10); i++) engine.frame(out, orbit(o), 2, 1 / 60);
    await snap(`${name}.png`);
  }
}
gpu.dispose();
