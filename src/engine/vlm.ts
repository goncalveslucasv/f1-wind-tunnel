// Vortex lattice estimate of the wing loads, built from the real W17 wing sections.
// Each element becomes a cambered lifting surface of horseshoe vortices; the ground is modelled
// with mirror images (y -> -y), so the front wing feels ground effect. Inviscid by construction,
// it captures what the coarse lattice Boltzmann grid cannot: the high-Reynolds lift of thin,
// slotted wing elements.
import { CAR_LAYOUT, RIG, type RigData, type WingStation } from "./car-model";

type V3 = [number, number, number];
type Pt = [number, number];

export interface WingPose {
  /** Rotation in radians applied to each element about its hinge at a given |z|. */
  rotate: (element: number, z: number, p: Pt) => Pt;
  /** Maps a point from the car frame to the tunnel frame (ride height, rake). */
  toWorld: (p: V3) => V3;
}

export interface WingLoads {
  downforceN: number;
  dragN: number;
  /** Streamwise position where the downforce acts (centre of pressure). */
  copX: number;
  /** Height at which the drag acts. */
  dragY: number;
}

const RHO = 1.225;
const CD0 = 0.018;
const CORE = 0.01;
const FAR = 60;
// Half-span covered by each wing, from the nose (or centreline) to the endplate.
const FRONT_SPAN: [number, number] = [0.09, 0.62];
const REAR_SPAN: [number, number] = [0.0, 0.53];

interface Horseshoe { a: V3; b: V3; ta: V3; tb: V3; cp: V3; n: V3; area: number }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function segment(p: V3, a: V3, b: V3, out: V3, gamma: number) {
  const r1 = sub(p, a), r2 = sub(p, b);
  const c = cross(r1, r2);
  const r0 = sub(b, a);
  const l1 = Math.hypot(...r1), l2 = Math.hypot(...r2);
  const c2 = dot(c, c) + CORE * CORE * dot(r0, r0);
  if (l1 < 1e-6 || l2 < 1e-6) return;
  const k = (gamma / (4 * Math.PI * c2)) * (dot(r0, r1) / l1 - dot(r0, r2) / l2);
  out[0] += c[0] * k; out[1] += c[1] * k; out[2] += c[2] * k;
}

// Trailing legs run along the surface to the trailing edge, then straight downstream.
function horseshoeVelocity(p: V3, h: Horseshoe, gamma: number, out: V3) {
  const aFar: V3 = [h.ta[0] + FAR, h.ta[1], h.ta[2]];
  const bFar: V3 = [h.tb[0] + FAR, h.tb[1], h.tb[2]];
  for (const sign of [1, -1]) {
    const m = (v: V3): V3 => [v[0], v[1] * sign, v[2]];
    const g = gamma * sign;
    segment(p, m(aFar), m(h.ta), out, g);
    segment(p, m(h.ta), m(h.a), out, g);
    segment(p, m(h.a), m(h.b), out, g);
    segment(p, m(h.b), m(h.tb), out, g);
    segment(p, m(h.tb), m(bFar), out, g);
  }
}

function station(stations: WingStation[], z: number): WingStation {
  if (z <= stations[0].z) return stations[0];
  if (z >= stations[stations.length - 1].z) return stations[stations.length - 1];
  let i = 0;
  while (stations[i + 1].z < z) i++;
  const s0 = stations[i], s1 = stations[i + 1];
  const t = (z - s0.z) / (s1.z - s0.z);
  const mix = (a: Pt, b: Pt): Pt => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  return { z, le: mix(s0.le, s1.le), mid: mix(s0.mid, s1.mid), te: mix(s0.te, s1.te) };
}

// Camber line through leading edge, mid-chord point and trailing edge.
function camberPoint(s: WingStation, t: number): Pt {
  const c: Pt = [2 * s.mid[0] - 0.5 * (s.le[0] + s.te[0]), 2 * s.mid[1] - 0.5 * (s.le[1] + s.te[1])];
  const u = 1 - t;
  return [u * u * s.le[0] + 2 * u * t * c[0] + t * t * s.te[0], u * u * s.le[1] + 2 * u * t * c[1] + t * t * s.te[1]];
}

function buildLattice(elements: WingStation[][], pose: WingPose, span: [number, number], spanStrips: number, chordPanels: number): Horseshoe[] {
  const out: Horseshoe[] = [];
  elements.forEach((stations, e) => {
    const z0 = Math.min(stations[0].z, span[0]), z1 = Math.max(stations[stations.length - 1].z, span[1]);
    const point = (z: number, t: number, side: number): V3 => {
      const local = pose.rotate(e, z, camberPoint(station(stations, z), t));
      return pose.toWorld([local[0], local[1], z * side]);
    };
    for (const side of [1, -1]) {
      for (let i = 0; i < spanStrips; i++) {
        const za = lerp(z0, z1, i / spanStrips), zb = lerp(z0, z1, (i + 1) / spanStrips);
        const [zl, zr] = side > 0 ? [za, zb] : [zb, za];
        for (let j = 0; j < chordPanels; j++) {
          const t0 = j / chordPanels, t1 = (j + 1) / chordPanels;
          const tq = lerp(t0, t1, 0.25), tc = lerp(t0, t1, 0.75);
          const a = point(zl, tq, side), b = point(zr, tq, side);
          const zm = (zl + zr) / 2;
          const cp = point(zm, tc, side);
          const p00 = point(zl, t0, side), p01 = point(zr, t0, side), p10 = point(zl, t1, side), p11 = point(zr, t1, side);
          const n = cross(sub(p11, p00), sub(p01, p10));
          const len = Math.hypot(...n) || 1;
          out.push({ a, b, ta: point(zl, 1, side), tb: point(zr, 1, side), cp, n: [n[0] / len, n[1] / len, n[2] / len], area: len / 2 });
        }
      }
    }
  });
  return out;
}

function solve(A: Float64Array, rhs: Float64Array, n: number): Float64Array {
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i * n + k]) > Math.abs(A[piv * n + k])) piv = i;
    if (piv !== k) {
      for (let j = 0; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[piv * n + j]; A[piv * n + j] = t; }
      const t = rhs[k]; rhs[k] = rhs[piv]; rhs[piv] = t;
    }
    const d = A[k * n + k] || 1e-12;
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / d;
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      rhs[i] -= f * rhs[k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = rhs[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / (A[i * n + i] || 1e-12);
  }
  return x;
}

export function wingLoads(elements: WingStation[][], pose: WingPose, span: [number, number], speed: number, spanStrips = 10, chordPanels = 4): WingLoads {
  const hs = buildLattice(elements, pose, span, spanStrips, chordPanels);
  const n = hs.length;
  const vinf: V3 = [speed, 0, 0];
  const A = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const v: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      v[0] = v[1] = v[2] = 0;
      horseshoeVelocity(hs[i].cp, hs[j], 1, v);
      A[i * n + j] = dot(v, hs[i].n);
    }
    rhs[i] = -dot(vinf, hs[i].n);
  }
  const gamma = solve(A, rhs, n);

  const force: V3 = [0, 0, 0];
  let area = 0, momentX = 0, momentY = 0;
  for (let i = 0; i < n; i++) {
    const h = hs[i];
    const m: V3 = [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2, (h.a[2] + h.b[2]) / 2];
    const vel: V3 = [vinf[0], vinf[1], vinf[2]];
    for (let j = 0; j < n; j++) horseshoeVelocity(m, hs[j], gamma[j], vel);
    const f = cross(vel, sub(h.b, h.a));
    force[0] += RHO * gamma[i] * f[0];
    force[1] += RHO * gamma[i] * f[1];
    force[2] += RHO * gamma[i] * f[2];
    momentX += -RHO * gamma[i] * f[1] * m[0];
    momentY += RHO * gamma[i] * f[0] * m[1];
    area += h.area;
  }
  const q = 0.5 * RHO * speed * speed;
  const down = -force[1];
  const centroid = hs.reduce((acc, h) => acc + h.cp[0], 0) / Math.max(1, n);
  const height = hs.reduce((acc, h) => acc + h.cp[1], 0) / Math.max(1, n);
  return {
    downforceN: down,
    dragN: force[0] + CD0 * q * area,
    copX: Math.abs(down) > 1 ? momentX / down : centroid,
    dragY: Math.abs(force[0]) > 1 ? momentY / force[0] : height,
  };
}

export interface W17WingSetup {
  frontDeg: number;
  rearFlapDeg: number;
  rearMainDeg: number;
  rideH: number;
  rearRideH: number;
  gurney: boolean;
  frontOn: boolean;
  rearOn: boolean;
  /** Tip twist of the rear wing in degrees (negative: Monza spoon). */
  rearTwistDeg: number;
  /** Chord scale of the flaps (thin, low-drag profiles below 1). */
  flapScale: number;
}

const scaleAbout = (p: Pt, h: Pt, k: number): Pt => (k === 1 ? p : [h[0] + (p[0] - h[0]) * k, h[1] + (p[1] - h[1]) * k]);
const NO_LOAD: WingLoads = { downforceN: 0, dragN: 0, copX: 0, dragY: 0 };

// Effective height: the inviscid lattice overstates a real 15 mm tab, so it is calibrated to the
// usual +10–15 % downforce gain of a Gurney flap.
const GURNEY_HEIGHT = 0.004;

// A Gurney flap is a short tab normal to the trailing edge of the last element, on its pressure side.
function withGurney(elements: WingStation[][]): WingStation[][] {
  const last = elements[elements.length - 1];
  const tab = last.map((s) => {
    const dx = s.te[0] - s.le[0], dy = s.te[1] - s.le[1];
    const l = Math.hypot(dx, dy) || 1;
    const up: Pt = [-dy / l, dx / l];
    return {
      z: s.z,
      le: s.te,
      mid: [s.te[0] + up[0] * GURNEY_HEIGHT * 0.5, s.te[1] + up[1] * GURNEY_HEIGHT * 0.5] as Pt,
      te: [s.te[0] + up[0] * GURNEY_HEIGHT, s.te[1] + up[1] * GURNEY_HEIGHT] as Pt,
    };
  });
  return [...elements, tab];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const rotateAbout = (p: Pt, h: Pt, a: number): Pt => {
  if (a === 0) return p;
  const c = Math.cos(a), s = Math.sin(a), dx = p[0] - h[0], dy = p[1] - h[1];
  return [h[0] + c * dx - s * dy, h[1] + s * dx + c * dy];
};

// Mirrors the articulation applied by the mesh shader and the distance field (RIG_WGSL).
export function w17WingLoads(rig: RigData, setup: W17WingSetup, speed: number) {
  const DEG = Math.PI / 180;
  const rake = Math.atan((setup.rearRideH - setup.rideH) / (CAR_LAYOUT.wheels.rear.x - CAR_LAYOUT.frontAxleX));
  const c = Math.cos(rake), s = Math.sin(rake);
  const toWorld = (p: V3): V3 => {
    const bx = p[0] - CAR_LAYOUT.frontAxleX, by = p[1] - CAR_LAYOUT.baseRideH;
    return [CAR_LAYOUT.frontAxleX + c * bx - s * by, setup.rideH + s * bx + c * by, p[2]];
  };
  const hinge = (table: [number, number][], z: number): Pt => {
    const f = Math.min(Math.max(z / RIG.front.dz, 0), RIG.front.bins - 1);
    const i = Math.floor(f), j = Math.min(i + 1, RIG.front.bins - 1), t = f - i;
    return [lerp(table[i][0], table[j][0], t), lerp(table[i][1], table[j][1], t)];
  };
  const frontWeight = (z: number) => smooth(RIG.front.fadeIn[0], RIG.front.fadeIn[1], z) * (1 - smooth(RIG.front.fadeOut[0], RIG.front.fadeOut[1], z));
  const front: WingPose = {
    toWorld,
    rotate: (e, z, p) => {
      if (e === 0) return p;
      const w = frontWeight(z);
      const h = hinge(rig.frontHinges[e - 1], z);
      const k = 1 - (1 - setup.flapScale) * RIG.frontThinFactor;
      return rotateAbout(scaleAbout(p, h, k), h, setup.frontDeg * DEG * (e === 1 ? 0.8 : 1) * w);
    },
  };
  const rear: WingPose = {
    toWorld,
    rotate: (e, z, p) => {
      const twist = setup.rearTwistDeg * smooth(0.12, 0.48, z) * DEG;
      if (e === 0) return rotateAbout(p, rig.rearMainHinge, setup.rearMainDeg * DEG + twist);
      return rotateAbout(scaleAbout(p, rig.rearFlapHinge, setup.flapScale), rig.rearFlapHinge, setup.rearFlapDeg * DEG + twist);
    },
  };
  const rearElements = setup.gurney ? withGurney(rig.wings.rear) : rig.wings.rear;
  return {
    front: setup.frontOn ? wingLoads(rig.wings.front, front, FRONT_SPAN, speed) : NO_LOAD,
    rear: setup.rearOn ? wingLoads(rearElements, rear, REAR_SPAN, speed) : NO_LOAD,
  };
}
