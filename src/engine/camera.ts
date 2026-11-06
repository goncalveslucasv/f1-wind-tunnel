import type { CameraState } from "./engine";

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Orbit {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
}

export function orbitCamera(o: Orbit, aspect: number, fovY = 40 * Math.PI / 180): CameraState {
  const cp = Math.cos(o.pitch);
  const pos: Vec3 = [
    o.target[0] + o.distance * cp * Math.cos(o.yaw),
    o.target[1] + o.distance * Math.sin(o.pitch),
    o.target[2] + o.distance * cp * Math.sin(o.yaw),
  ];
  const fwd = norm(sub(o.target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  const near = 0.05;
  const far = 200;
  const f = 1 / Math.tan(fovY / 2);
  // Column-major view and projection (WebGPU clip depth 0..1).
  const view = new Float32Array([
    right[0], up[0], -fwd[0], 0,
    right[1], up[1], -fwd[1], 0,
    right[2], up[2], -fwd[2], 0,
    -dot(right, pos), -dot(up, pos), dot(fwd, pos), 1,
  ]);
  const proj = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ]);
  const viewProj = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
      viewProj[c * 4 + r] = s;
    }
  }
  return { pos, fwd, right, up, fovY, viewProj };
}
