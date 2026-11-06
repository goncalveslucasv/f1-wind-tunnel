import * as V from "vgpu/node";
import { AeroEngine, ColorField, FlowMode, type ShapeParams } from "../src/engine/engine";
import { orbitCamera } from "../src/engine/camera";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { MeshCar } from "../src/engine/mesh-car";
import type { RigData } from "../src/engine/car-model";

const gpu = await V.init();
const out = V.target(gpu, { size: [64, 64], format: "rgba8unorm" });
const e = new AeroEngine(V as never, gpu, "medium", [64, 64]);
const base: ShapeParams = { kind: 0, frontWing: 0, rearWing: 0, sidepod: 0, cover: 0, nose: 0, rearRideH: 0.12, rearMainDeg: 0, gurney: false, frontWingOn: true, rearWingOn: true, rearShape: 0, thinWings: false, sidepods: 0, cooling: 1, frontFlapDeg: 0, rearFlapDeg: 0, rideH: 0.12, aoaDeg: 6, customMode: 0, customWidth: 0.5, customAxisY: 1, heatBrakes: false, heatEngine: false, heatRad: false };
e.setView({ colorField: ColorField.Speed, surfaceField: false, sliceAxis: 0, slicePos: 0, flowMode: FlowMode.None, kmh: 250, livery: { paint: [0, 0, 0], accent: [0, 0, 0], carbon: true } });
const useW17 = process.argv[2] === "w17";
if (useW17) {
  const dir = new URL("../public/models/", import.meta.url).pathname;
  const ab = (name: string) => { const b = readFileSync(dir + name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const rig = JSON.parse(readFileSync(dir + "w17.rig.json", "utf8")) as RigData;
  const mesh = await MeshCar.load(V as never, gpu, ab("w17.glb"), new Uint8Array(ab("w17.rig.bin")), async () => ({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }));
  e.setCarModel(mesh, new Uint16Array(ab("w17.sdf.bin")), new Uint16Array(ab("w17.parts.bin")), rig);
  Object.assign(base, { kind: 5, rideH: 0.12, rearRideH: 0.14 });
}
void PNG;
e.setShape(base);
e.reset();
const cam = orbitCamera({ target: [2.7, 0.45, 0], yaw: 2.35, pitch: 0.38, distance: 8.5 }, 1);
let acc = { d: 0, l: 0, fd: 0, fl: 0, rd: 0, rl: 0, n: 0 };
e.onForces = (f) => { acc.d += f.dragN; acc.l += f.downforceN; acc.fd += f.frontWing.drag; acc.fl += f.frontWing.down; acc.rd += f.rearWing.drag; acc.rl += f.rearWing.down; acc.n++; };
async function run(frames: number) { for (let i = 0; i < frames; i++) { e.frame(out, cam, 8, 1 / 60); if (i % 16 === 0) await new Promise((r) => setTimeout(r, 5)); } }
async function measure(label: string, p: Partial<ShapeParams>) {
  e.setShape({ ...base, ...p });
  await run(200);
  acc = { d: 0, l: 0, fd: 0, fl: 0, rd: 0, rl: 0, n: 0 };
  await run(320);
  const r = (x: number) => Math.round(x / acc.n);
  console.log(label.padEnd(18), "total D/L", r(acc.d), r(acc.l), "| front D/L", r(acc.fd), r(acc.fl), "| rear D/L", r(acc.rd), r(acc.rl));
}
await run(1200);
const only = useW17 ? process.argv[3] : process.argv[2];
const cases: [string, Partial<ShapeParams>][] = [
  ["base", {}],
  ["straight mode", { rearFlapDeg: -28, frontFlapDeg: -12 }],
  ["front: outwash", { frontWing: 1 }],
  ["front: spoon", { frontWing: 2 }],
  ["front: low", { frontWing: 3 }],
  ["rear: high", { rearWing: 1 }],
  ["rear: low", { rearWing: 2 }],
  ["sidepod: zero", { sidepod: 1 }],
  ["sidepod: tub", { sidepod: 2 }],
  ["sidepod: high", { sidepod: 3 }],
  ["cover: wide", { cover: 1 }],
  ["cover: coke", { cover: 2 }],
  ["nose: short", { nose: 1 }],
  ["nose: high", { nose: 2 }],
  ["rake +8cm", { rearRideH: 0.20 }],
];
const w17Cases: [string, Partial<ShapeParams>][] = [
  ["base", {}],
  ["straight mode", { rearFlapDeg: -28, frontFlapDeg: -12 }],
  ["front: high", { frontWing: 1 }],
  ["front: low", { frontWing: 2 }],
  ["rear: high", { rearWing: 1 }],
  ["rear: low", { rearWing: 2 }],
];
for (const [label, p] of useW17 ? w17Cases : cases) {
  if (only && !label.includes(only)) continue;
  if (label !== "base") await measure("  base (ref)", {});
  await measure(label, p);
}
gpu.dispose();
