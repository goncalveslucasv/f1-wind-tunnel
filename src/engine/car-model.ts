// Placement of the "2026 Mercedes W17" model (Dave Love, Sketchfab, CC BY 4.0) in the tunnel frame.
// The source mesh is Y-up with the nose towards +Z; the tunnel frame has x downstream, y up and
// z lateral, with the front axle at x = 1.0 and the ground at y = 0.

export const CAR_CREDIT = {
  title: "2026 Mercedes W17",
  author: "Dave Love",
  url: "https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b",
  license: "CC BY 4.0",
};

const MESH_FRONT_AXLE_Z = 1.615;
const MESH_GROUND_Y = -0.04;

export const CAR_LAYOUT = {
  frontAxleX: 1.0,
  baseRideH: 0.092,
  wheels: {
    front: { x: 1.0, y: 0.36, z: 0.779, r: 0.355, hw: 0.175 },
    rear: { x: 4.4, y: 0.351, z: 0.737, r: 0.355, hw: 0.205 },
  },
  sdf: { h: 0.015, origin: [-0.3, 0, 0] as [number, number, number], dims: [368, 84, 67] as [number, number, number] },
};

export const WHEEL_MATERIALS = new Set(["tread_medium.007", "sidewall.007", "mercedes_wheel_hub.007", "discs.007"]);

export function toCarFrame(x: number, y: number, z: number): [number, number, number] {
  return [CAR_LAYOUT.frontAxleX + (MESH_FRONT_AXLE_Z - z), y - MESH_GROUND_Y, x];
}

export function normalToCarFrame(x: number, y: number, z: number): [number, number, number] {
  return [-z, y, x];
}

// Articulated wing elements. Front flaps rotate about a leading-edge hinge tabulated along |z| and
// fade out near the nose and the endplates; the rear elements rotate rigidly about fixed hinges.
export const RIG = {
  parts: { frontFlapA: 1, frontFlapB: 2, rearFlap: 3, rearMain: 4, frontStatic: 5, rearStatic: 6 },
  partMask: 7,
  assemblyShift: 3,
  assembly: { frontWing: 1, rearWing: 2 },
  front: { bandZ: [0.16, 0.56] as [number, number], fadeIn: [0.16, 0.22] as [number, number], fadeOut: [0.5, 0.56] as [number, number], dz: 0.01, bins: 71 },
  rear: { maxZ: 0.53 },
  partGridH: 0.01,
  frontThinFactor: 0.65,
};

export interface RigData {
  frontHinges: [number, number][][];
  rearMainHinge: [number, number];
  rearFlapHinge: [number, number];
  partGrids: { part: number; origin: [number, number, number]; h: number; dims: [number, number, number]; offset: number }[];
  sections: { front: [number, number][][]; rear: [number, number][][] };
  wings: { front: WingStation[][]; rear: WingStation[][] };
}
export interface WingStation { z: number; le: [number, number]; mid: [number, number]; te: [number, number] }

// Shared by the mesh shader and the distance field: `rig` must be bound as a uniform.
export const RIG_WGSL = /* wgsl */ `
struct Rig {
  front: array<vec4f, 71>,
  hinges: vec4f,
  angles: vec4f,
  // x: rear-wing tip twist (rad), y: chord scale of the flaps, z: sidepod squeeze, w: unused.
  extra: vec4f,
  // x/y: front/rear wing fly-away progress, z/w: front/rear wing fitted (1) or detached (0).
  fly: vec4f,
  grids: array<vec4f, 12>,
}
fn rigWeight(part: u32, z: f32) -> f32 {
  if (part == 1u || part == 2u) {
    let az = abs(z);
    return smoothstep(${RIG.front.fadeIn[0]}, ${RIG.front.fadeIn[1]}, az) * (1.0 - smoothstep(${RIG.front.fadeOut[0]}, ${RIG.front.fadeOut[1]}, az));
  }
  return select(0.0, 1.0, part == 3u || part == 4u);
}
fn rigHinge(part: u32, z: f32) -> vec2f {
  if (part == 3u) { return rig.hinges.zw; }
  if (part == 4u) { return rig.hinges.xy; }
  let f = clamp(abs(z) / ${RIG.front.dz}, 0.0, ${RIG.front.bins - 1}.0);
  let i = u32(floor(f));
  let j = min(i + 1u, ${RIG.front.bins - 1}u);
  let a = rig.front[i]; let b = rig.front[j];
  let t = f - f32(i);
  return select(mix(a.zw, b.zw, t), mix(a.xy, b.xy, t), part == 1u);
}
fn rigAngle(part: u32, z: f32) -> f32 {
  var a = 0.0;
  if (part == 1u) { a = rig.angles.x; }
  else if (part == 2u) { a = rig.angles.y; }
  else if (part == 3u) { a = rig.angles.z; }
  else if (part == 4u) { a = rig.angles.w; }
  // Rear-wing planform: twisting the tips gives the Monza "spoon" or the Monaco "board".
  if (part == 3u || part == 4u) { a += rig.extra.x * smoothstep(0.12, 0.48, abs(z)); }
  return a * rigWeight(part, z);
}
// Thin profiles shorten the rear flaps fully and the front flaps by a softer amount.
fn rigScale(part: u32) -> f32 {
  if (part == 3u) { return rig.extra.y; }
  if (part == 1u || part == 2u) { return 1.0 - (1.0 - rig.extra.y) * ${RIG.frontThinFactor}; }
  return 1.0;
}
fn rigRotate(p: vec3f, part: u32, dir: f32) -> vec3f {
  if (part == 0u || part > 4u) { return p; }
  let a = rigAngle(part, p.z) * dir;
  let k = rigScale(part);
  let h = rigHinge(part, p.z);
  let c = cos(a); let s = sin(a);
  var d = p.xy - h;
  if (dir > 0.0) { d *= k; }
  d = vec2f(c * d.x - s * d.y, s * d.x + c * d.y);
  if (dir < 0.0) { d /= k; }
  return vec3f(h + d, p.z);
}
fn rigRotateDir(v: vec3f, part: u32, z: f32) -> vec3f {
  let a = rigAngle(part, z);
  let c = cos(a); let s = sin(a);
  return vec3f(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

// Sidepods: squeeze the bodywork between the axles towards the tub and down towards the floor.
fn podWeight(p: vec3f) -> f32 {
  return smoothstep(1.85, 2.25, p.x) * (1.0 - smoothstep(3.55, 4.05, p.x))
    * smoothstep(0.12, 0.2, p.y) * (1.0 - smoothstep(0.6, 0.7, p.y))
    * smoothstep(0.26, 0.4, abs(p.z));
}
fn podDeform(p: vec3f, dir: f32) -> vec3f {
  let c = rig.extra.z * podWeight(p);
  if (c <= 0.0) { return p; }
  let az = abs(p.z);
  let kz = select(1.0 / (1.0 - c), 1.0 - c, dir > 0.0);
  let ky = select(1.0 / (1.0 - 0.45 * c), 1.0 - 0.45 * c, dir > 0.0);
  let nz = select(az, 0.26 + (az - 0.26) * kz, az > 0.26);
  return vec3f(p.x, 0.12 + (p.y - 0.12) * ky, sign(p.z) * nz);
}
`;

export const W17_FRONT_LEVELS = [
  { id: 0, name: "Media carga", flap: 0, desc: "Ángulos de fábrica del W17: equilibrio para la mayoría de los circuitos.", tags: ["original"] },
  { id: 1, name: "Alta carga", flap: 7, desc: "Flaps más cerrados para circuitos lentos con muchas curvas.", tags: ["más carga", "más drag"] },
  { id: 2, name: "Baja carga", flap: -9, desc: "Flaps más planos para circuitos rápidos como Monza.", tags: ["menos drag"] },
];
export const W17_REAR_LEVELS = [
  { id: 0, name: "Media carga", main: 0, flap: 0, desc: "Configuración de fábrica del W17.", tags: ["original"] },
  { id: 1, name: "Alta carga", main: 3, flap: 9, desc: "Plano principal y flap con más ángulo: mucha carga para Mónaco o Hungría.", tags: ["más carga", "más drag"] },
  { id: 2, name: "Baja carga", main: -4, flap: -13, desc: "Elementos casi planos para las rectas largas.", tags: ["menos drag"] },
];

export interface RigExtras { rearTwist: number; flapScale: number; podSqueeze: number; fly: [number, number, number, number] }

export function rigUniform(rig: RigData, angles: [number, number, number, number], extras: RigExtras = { rearTwist: 0, flapScale: 1, podSqueeze: 0, fly: [0, 0, 1, 1] }) {
  const front = rig.frontHinges[0].map((a, i) => [a[0], a[1], rig.frontHinges[1][i][0], rig.frontHinges[1][i][1]]);
  const grids: number[][] = [];
  for (const g of rig.partGrids) {
    grids.push([g.origin[0], g.origin[1], g.origin[2], g.h]);
    grids.push([g.dims[0], g.dims[1], g.dims[2], 0]);
  }
  let z = 0;
  for (let i = 0; i < rig.partGrids.length; i++) {
    grids[i * 2 + 1][3] = z;
    z += rig.partGrids[i].dims[2] + 1;
  }
  return {
    front,
    hinges: [rig.rearMainHinge[0], rig.rearMainHinge[1], rig.rearFlapHinge[0], rig.rearFlapHinge[1]],
    angles,
    extra: [extras.rearTwist, extras.flapScale, extras.podSqueeze, 0],
    fly: extras.fly,
    grids: [...grids, ...Array.from({ length: Math.max(0, 12 - grids.length) }, () => [0, 0, 0, 1])],
  };
}

// Packs the per-part grids into one 3D texture, stacked along z with a padding slice between them.
export function partsAtlas(rig: RigData, data: Uint16Array) {
  const nx = Math.max(...rig.partGrids.map((g) => g.dims[0]));
  const ny = Math.max(...rig.partGrids.map((g) => g.dims[1]));
  const nz = rig.partGrids.reduce((s, g) => s + g.dims[2] + 1, 0);
  const far = 0x2400;
  const out = new Uint16Array(nx * ny * nz).fill(far);
  let z0 = 0;
  for (const g of rig.partGrids) {
    const [gx, gy, gz] = g.dims;
    for (let k = 0; k < gz; k++) for (let j = 0; j < gy; j++) {
      const src = g.offset + (k * gy + j) * gx;
      out.set(data.subarray(src, src + gx), ((z0 + k) * ny + j) * nx);
    }
    z0 += gz + 1;
  }
  return { dims: [nx, ny, nz] as [number, number, number], data: out };
}
