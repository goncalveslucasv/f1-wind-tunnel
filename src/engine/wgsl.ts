// WGSL sources are composed from shared chunks so the simulation voxelizer and the
// renderer evaluate exactly the same signed distance field.
import { SDF_F1 } from "./f1";

export const GRID = /* wgsl */ `
struct Grid { dims: vec3u, n: u32, origin: vec3f, h: f32 }
`;

export const SHAPE = /* wgsl */ `
struct Shape {
  kind: u32, profileMode: u32, pw: u32, ph: u32,
  frontFlap: f32, rearMain: f32, rearFlap: f32, rideH: f32,
  aoa: f32, width: f32, axisY: f32, pScale: f32,
  pOrigin: vec2f, heatBrakes: f32, heatEngine: f32,
  heatRad: f32, frontWing: f32, rearWing: f32, sidepod: f32,
  cover: f32, nose: f32, rearRide: f32, pad3: f32,
}
`;

const SDF_PRIMITIVES = /* wgsl */ `
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sdRoundBox(p: vec3f, b: vec3f, r: f32) -> f32 { return sdBox(p, b - vec3f(r)) - r; }
fn sdCapsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let hh = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * hh) - r;
}
fn sdRoundRect(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn opExtrude(d2: f32, dz: f32) -> f32 {
  let w = vec2f(d2, dz);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
}
fn sdWheel(p: vec3f, c: vec3f, r: f32, hw: f32) -> f32 {
  let q = p - c;
  let rr = 0.045;
  let d = vec2f(length(q.xy) - (r - rr), abs(q.z) - (hw - rr));
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - rr;
}
// Tapered rounded section swept along x: centre (y,z) and half size (y,z) lerp from x0 to x1.
fn sdTaper(p: vec3f, x0: f32, x1: f32, c0: vec2f, c1: vec2f, s0: vec2f, s1: vec2f, r0: f32, r1: f32) -> f32 {
  let t = clamp((p.x - x0) / (x1 - x0), 0.0, 1.0);
  let c = mix(c0, c1, t);
  let s = mix(s0, s1, t);
  let r = min(mix(r0, r1, t), min(s.x, s.y));
  let d2 = sdRoundRect(vec2f(p.y, p.z) - c, s, r);
  let dx = abs(p.x - 0.5 * (x0 + x1)) - 0.5 * (x1 - x0);
  return opExtrude(d2, dx) * 0.8;
}
fn sdUnevenCapsule(p0: vec2f, r1: f32, r2: f32, hh: f32) -> f32 {
  let p = vec2f(abs(p0.x), p0.y);
  let b = (r1 - r2) / hh;
  let a = sqrt(max(1.0 - b * b, 0.0));
  let k = dot(p, vec2f(-b, a));
  if (k < 0.0) { return length(p) - r1; }
  if (k > a * hh) { return length(p - vec2f(0.0, hh)) - r2; }
  return dot(p, vec2f(a, b)) - r1;
}
// Airfoil-like element: leading edge at le, chord along angle ang (trailing edge raised for ang > 0).
fn sdWing(p: vec3f, le: vec2f, chord: f32, ang: f32, thick: f32, z0: f32, z1: f32) -> f32 {
  let q = p.xy - le;
  let c = cos(ang); let s = sin(ang);
  let lx = q.x * c + q.y * s;
  let ly = -q.x * s + q.y * c;
  let r1 = thick * 0.5;
  let r2 = max(thick * 0.12, 0.006);
  let d2 = sdUnevenCapsule(vec2f(ly, lx - r1), r1, r2, max(chord - r1 - r2, 0.01));
  return opExtrude(d2, abs(p.z - 0.5 * (z0 + z1)) - 0.5 * (z1 - z0));
}
fn opU(a: vec2f, b: vec2f) -> vec2f { if (b.x < a.x) { return b; } return a; }
`;

const SDF_SCENE = /* wgsl */ `
fn profileAt(ix: i32, iy: i32) -> f32 {
  let x = clamp(ix, 0, i32(shape.pw) - 1);
  let y = clamp(iy, 0, i32(shape.ph) - 1);
  return profile[u32(y) * shape.pw + u32(x)];
}
fn sdProfile2D(q: vec2f) -> f32 {
  let g = (q - shape.pOrigin) / shape.pScale - vec2f(0.5);
  let size = vec2f(f32(shape.pw), f32(shape.ph));
  let gc = clamp(g, vec2f(0.0), size - vec2f(1.0));
  let i0 = vec2i(floor(gc));
  let f = gc - vec2f(i0);
  let a = mix(profileAt(i0.x, i0.y), profileAt(i0.x + 1, i0.y), f.x);
  let c = mix(profileAt(i0.x, i0.y + 1), profileAt(i0.x + 1, i0.y + 1), f.x);
  return mix(a, c, f.y) + length(g - gc) * shape.pScale;
}
fn sdCustom(p: vec3f) -> f32 {
  if (shape.profileMode == 1u) {
    let r = length(vec2f(p.y - shape.axisY, p.z));
    return sdProfile2D(vec2f(p.x, shape.axisY + r));
  }
  return opExtrude(sdProfile2D(p.xy), abs(p.z) - shape.width);
}
fn sceneSdf(p: vec3f) -> vec2f {
  switch (shape.kind) {
    case 0u: { return sdF1(p); }
    case 1u: { return vec2f(length(p - vec3f(2.6, 1.0, 0.0)) - 0.6, 6.0); }
    case 2u: { return vec2f(sdRoundBox(p - vec3f(2.6, 1.0, 0.0), vec3f(0.5), 0.03), 6.0); }
    case 3u: { return vec2f(sdWing(p, vec2f(1.6, 1.2), 1.8, -shape.aoa, 0.24, -1.25, 1.25), 6.0); }
    case 5u: { return sdW17(p); }
    case 6u: { return vec2f(1e3, 0.0); }
    default: { return vec2f(sdCustom(p), 6.0); }
  }
}
fn sceneEmission(p: vec3f) -> f32 {
  if (shape.kind == 0u) { return f1Emission(p); }
  if (shape.kind == 5u) { return w17Emission(p); }
  return 0.0;
}
`;

// The shape code references the `shape` uniform, `profile` storage and the baked car grid
// (`carSdf`, `carParts`, `carSamp` and the `rig` uniform) by name; every entry shader that includes it declares those bindings.
export const SDF = SDF_PRIMITIVES + SDF_F1 + SDF_SCENE;

export const D3Q19 = /* wgsl */ `
const CX = array<i32, 19>(0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0);
const CY = array<i32, 19>(0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1);
const CZ = array<i32, 19>(0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1);
const OPP = array<u32, 19>(0u, 2u, 1u, 4u, 3u, 6u, 5u, 8u, 7u, 10u, 9u, 12u, 11u, 14u, 13u, 16u, 15u, 18u, 17u);
const ZMIR = array<u32, 19>(0u, 1u, 2u, 3u, 4u, 6u, 5u, 7u, 8u, 9u, 10u, 13u, 14u, 11u, 12u, 17u, 18u, 15u, 16u);
const WT = array<f32, 19>(
  0.33333334,
  0.055555556, 0.055555556, 0.055555556, 0.055555556, 0.055555556, 0.055555556,
  0.027777778, 0.027777778, 0.027777778, 0.027777778, 0.027777778, 0.027777778,
  0.027777778, 0.027777778, 0.027777778, 0.027777778, 0.027777778, 0.027777778);

fn feq(i: u32, rho: f32, u: vec3f) -> f32 {
  let cu = f32(CX[i]) * u.x + f32(CY[i]) * u.y + f32(CZ[i]) * u.z;
  return WT[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
`;

export const LBM_INIT = GRID + D3Q19 + /* wgsl */ `
struct Sim { uIn: f32, tau0: f32, smag: f32, pad: f32 }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> sim: Sim;
@group(0) @binding(2) var<storage, read_write> fa: array<f32>;
@group(0) @binding(3) var<storage, read_write> fields: array<vec4f>;
@compute @workgroup_size(128)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= grid.n) { return; }
  let u = vec3f(sim.uIn, 0.0, 0.0);
  for (var i = 0u; i < 19u; i++) { fa[i * grid.n + idx] = feq(i, 1.0, u); }
  fields[idx] = vec4f(u, 1.0);
}
`;

export const LBM_STEP = GRID + D3Q19 + /* wgsl */ `
struct Sim { uIn: f32, tau0: f32, smag: f32, pad: f32 }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> sim: Sim;
@group(0) @binding(2) var<storage, read> fin: array<f32>;

@group(0) @binding(3) var<storage, read_write> fout: array<f32>;


@group(0) @binding(4) var<storage, read> solid: array<u32>;
@group(0) @binding(5) var<storage, read_write> fields: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> forces: array<atomic<i32>, 12>;

var<workgroup> wforce: array<atomic<i32>, 9>;

const FORCE_SCALE: f32 = 10000.0;

fn isBad(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u; }

var<private> gforce: array<vec3f, 3>;
fn stepCell(idx: u32) {
  let n = grid.n;
  let NX = grid.dims.x; let NY = grid.dims.y; let NZ = grid.dims.z;
  if (solid[idx] != 0u) {
    for (var i = 0u; i < 19u; i++) { fout[i * n + idx] = WT[i]; }
    fields[idx] = vec4f(0.0);
    return;
  }
  let x = i32(idx % NX);
  let y = i32((idx / NX) % NY);
  let z = i32(idx / (NX * NY));
  let uin = vec3f(sim.uIn, 0.0, 0.0);
  var floorU = sim.uIn;
  if (y == 0) {
    let row = u32(z) * NX * NY;
    let xl = u32(max(x - 2, 0)); let xr = u32(min(x + 2, i32(NX) - 1));
    let zl = u32(max(z - 1, 0)); let zr = u32(min(z + 1, i32(NZ) - 1));
    if (solid[row + xl] != 0u || solid[row + xr] != 0u || solid[idx + NX] != 0u ||
        solid[zl * NX * NY + u32(x)] != 0u || solid[zr * NX * NY + u32(x)] != 0u) { floorU = 0.0; }
  }
  let prevU = fields[idx].xyz;
  var f: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    let c = vec3i(CX[i], CY[i], CZ[i]);
    var s = vec3i(x, y, z) - c;
    var v: f32;
    if (s.x < 0) {
      v = feq(i, 1.0, uin);
    } else if (s.x >= i32(NX)) {
      v = feq(i, 1.0, prevU);
    } else if (s.y < 0) {
      v = fin[OPP[i] * n + idx] + 6.0 * WT[i] * f32(c.x) * floorU;
    } else if (s.y >= i32(NY) || s.z >= i32(NZ)) {
      v = feq(i, 1.0, uin);
    } else {
      var src = i;
      var mirrored = false;
      if (s.z < 0) { s.z = 0; src = ZMIR[i]; mirrored = true; }
      let sidx = u32(s.x) + NX * (u32(s.y) + NY * u32(s.z));
      let sg = solid[sidx];
      if (sg != 0u) {
        v = fin[OPP[i] * n + idx];
        if (!mirrored) { gforce[sg - 1u] -= 2.0 * (v - WT[i]) * vec3f(c); }
      } else {
        v = fin[src * n + sidx];
      }
    }
    f[i] = v;
  }

  var rho = 0.0;
  var mom = vec3f(0.0);
  for (var i = 0u; i < 19u; i++) {
    rho += f[i];
    mom += f[i] * vec3f(f32(CX[i]), f32(CY[i]), f32(CZ[i]));
  }
  var u = mom / max(rho, 1e-4);
  if (isBad(rho) || isBad(u.x) || isBad(u.y) || isBad(u.z) || rho < 0.3 || rho > 3.0 || length(u) > 0.35) {
    rho = 1.0;
    u = uin * 0.5;
    for (var i = 0u; i < 19u; i++) { f[i] = feq(i, rho, u); }
    gforce[0] = vec3f(0.0); gforce[1] = vec3f(0.0); gforce[2] = vec3f(0.0);
  }

  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0;
  var eq: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    eq[i] = feq(i, rho, u);
    let ne = f[i] - eq[i];
    let cx = f32(CX[i]); let cy = f32(CY[i]); let cz = f32(CZ[i]);
    pxx += ne * cx * cx; pyy += ne * cy * cy; pzz += ne * cz * cz;
    pxy += ne * cx * cy; pxz += ne * cx * cz; pyz += ne * cy * cz;
  }
  let q = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  let tau0 = sim.tau0 + 0.4 * smoothstep(f32(NX) - 18.0, f32(NX) - 1.0, f32(x)) + 0.25 * (1.0 - smoothstep(0.0, 10.0, f32(x)));
  let tau = 0.5 * (tau0 + sqrt(tau0 * tau0 + 18.0 * 1.41421356 * sim.smag * sim.smag * q / rho));
  let omega = 1.0 / tau;
  // Regularized collision: keep only the second-order (stress) part of the non-equilibrium
  // populations, which removes the ghost modes that make plain BGK unstable at low viscosity.
  let third = 1.0 / 3.0;
  for (var i = 0u; i < 19u; i++) {
    let cx = f32(CX[i]); let cy = f32(CY[i]); let cz = f32(CZ[i]);
    let qp = (cx * cx - third) * pxx + (cy * cy - third) * pyy + (cz * cz - third) * pzz
      + 2.0 * (cx * cy * pxy + cx * cz * pxz + cy * cz * pyz);
    fout[i * n + idx] = eq[i] + (1.0 - omega) * 4.5 * WT[i] * qp;
  }
  fields[idx] = vec4f(u, rho);
}

@compute @workgroup_size(128)
fn cs_main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < 9u) { atomicStore(&wforce[li], 0); }
  workgroupBarrier();
  gforce[0] = vec3f(0.0); gforce[1] = vec3f(0.0); gforce[2] = vec3f(0.0);
  if (gid.x < grid.n) { stepCell(gid.x); }
  for (var g = 0u; g < 3u; g++) {
    let fg = gforce[g];
    if (fg.x != 0.0) { atomicAdd(&wforce[g * 3u], i32(round(fg.x * FORCE_SCALE))); }
    if (fg.y != 0.0) { atomicAdd(&wforce[g * 3u + 1u], i32(round(fg.y * FORCE_SCALE))); }
  }
  workgroupBarrier();
  if (li < 9u) {
    let val = atomicLoad(&wforce[li]);
    if (val != 0) { atomicAdd(&forces[li], val); }
  }
}
`;

export const VOXELIZE = GRID + SHAPE + /* wgsl */ `
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> shape: Shape;
@group(0) @binding(2) var<storage, read> profile: array<f32>;
@group(0) @binding(3) var<storage, read_write> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> emit: array<f32>;
@group(0) @binding(5) var carSdf: texture_3d<f32>;
@group(0) @binding(6) var carSamp: sampler;
@group(0) @binding(7) var carParts: texture_3d<f32>;
@group(0) @binding(8) var<uniform> rig: Rig;
` + SDF + /* wgsl */ `
@compute @workgroup_size(128)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= grid.n) { return; }
  let NX = grid.dims.x; let NY = grid.dims.y;
  let c = vec3u(idx % NX, (idx / NX) % NY, idx / (NX * NY));
  let p = grid.origin + (vec3f(c) + vec3f(0.5)) * grid.h;
  let r = sceneSdf(p);
  let inside = r.x < select(0.3, 0.45, shape.kind == 5u) * grid.h && c.x > 1u && c.x < NX - 2u;
  var group = 1u;
  if (abs(r.y - 7.0) < 0.5) { group = 2u; }
  if (abs(r.y - 8.0) < 0.5) { group = 3u; }
  solid[idx] = select(0u, group, inside);
  emit[idx] = select(0.0, sceneEmission(p), inside);
}
`;

export const FIELD_SAMPLING = /* wgsl */ `
fn cellIdx(c: vec3i) -> u32 {
  let d = vec3i(grid.dims);
  let q = clamp(c, vec3i(0), d - vec3i(1));
  return u32(q.x) + grid.dims.x * (u32(q.y) + grid.dims.y * u32(q.z));
}
// Returns (ux, uy, uz, rho) and temperature, interpolating only fluid cells.
struct Sample { u: vec3f, rho: f32, temp: f32, fluid: f32 }
fn sampleFlow(pw: vec3f) -> Sample {
  let zs = select(1.0, -1.0, pw.z < 0.0);
  let p = vec3f(pw.x, pw.y, abs(pw.z));
  let g = (p - grid.origin) / grid.h - vec3f(0.5);
  let i0 = vec3i(floor(g));
  let f = g - vec3f(i0);
  var acc = vec4f(0.0);
  var tacc = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    var c = i0 + o;
    if (c.z < 0) { c.z = -c.z - 1; }
    let id = cellIdx(c);
    let v = fields[id];
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * select(1.0 - f.z, f.z, o.z == 1);
    if (v.w > 0.0) { acc += v * w; tacc += temps[id] * w; wsum += w; }
  }
  var s: Sample;
  if (wsum < 1e-5) { s.u = vec3f(0.0); s.rho = 1.0; s.temp = 0.0; s.fluid = 0.0; return s; }
  let r = acc / wsum;
  s.u = vec3f(r.x, r.y, r.z * zs);
  s.rho = r.w;
  s.temp = tacc / wsum;
  s.fluid = wsum;
  return s;
}
fn vorticityAt(p: vec3f) -> f32 {
  let e = grid.h;
  let dx0 = sampleFlow(p - vec3f(e, 0.0, 0.0)).u; let dx1 = sampleFlow(p + vec3f(e, 0.0, 0.0)).u;
  let dy0 = sampleFlow(p - vec3f(0.0, e, 0.0)).u; let dy1 = sampleFlow(p + vec3f(0.0, e, 0.0)).u;
  let dz0 = sampleFlow(p - vec3f(0.0, 0.0, e)).u; let dz1 = sampleFlow(p + vec3f(0.0, 0.0, e)).u;
  let w = vec3f((dy1.z - dy0.z) - (dz1.y - dz0.y), (dz1.x - dz0.x) - (dx1.z - dx0.z), (dx1.y - dx0.y) - (dy1.x - dy0.x)) * 0.5;
  return length(w);
}
`;

export const COLORMAPS = /* wgsl */ `
fn turbo(t0: f32) -> vec3f {
  let x = clamp(t0, 0.0, 1.0);
  let v4 = vec4f(1.0, x, x * x, x * x * x);
  let v2 = v4.zw * v4.z;
  return clamp(vec3f(
    dot(v4, vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2f(-152.94239396, 59.28637943)),
    dot(v4, vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2f(4.27729857, 2.82956604)),
    dot(v4, vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2f(-89.90310912, 27.34824973))), vec3f(0.0), vec3f(1.0));
}
fn inferno(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  let c0 = vec3f(0.0002189, 0.0016510, -0.0194809);
  let c1 = vec3f(0.1065134, 0.5639564, 3.9327124);
  let c2 = vec3f(11.6024931, -3.9728540, -15.9423941);
  let c3 = vec3f(-41.7039961, 17.4363989, 44.3541452);
  let c4 = vec3f(77.1629357, -33.4023589, -81.8073093);
  let c5 = vec3f(-71.3194282, 32.6260643, 73.2095199);
  let c6 = vec3f(25.1311262, -12.2426690, -23.0703250);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), vec3f(0.0), vec3f(1.0));
}
fn coolwarm(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  let lo = vec3f(0.23, 0.30, 0.75);
  let mid = vec3f(0.90, 0.90, 0.90);
  let hi = vec3f(0.78, 0.10, 0.14);
  if (t < 0.5) { return mix(lo, mid, t * 2.0); }
  return mix(mid, hi, t * 2.0 - 1.0);
}
fn viridisLike(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  return mix(mix(vec3f(0.07, 0.04, 0.20), vec3f(0.13, 0.55, 0.55), smoothstep(0.0, 0.5, t)), vec3f(0.99, 0.91, 0.15), smoothstep(0.45, 1.0, t));
}
// Wake map: clean air stays dark, total-pressure losses glow magenta to pale yellow.
fn wakeMap(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  var c = mix(vec3f(0.02, 0.03, 0.06), vec3f(0.22, 0.05, 0.42), smoothstep(0.0, 0.25, t));
  c = mix(c, vec3f(0.85, 0.1, 0.55), smoothstep(0.25, 0.55, t));
  c = mix(c, vec3f(1.0, 0.55, 0.25), smoothstep(0.55, 0.8, t));
  return mix(c, vec3f(1.0, 0.95, 0.7), smoothstep(0.8, 1.0, t));
}
fn neon(t0: f32) -> vec3f {
  let t = clamp(t0, 0.0, 1.0);
  var c = mix(vec3f(0.01, 0.02, 0.08), vec3f(0.02, 0.12, 0.45), smoothstep(0.0, 0.3, t));
  c = mix(c, vec3f(0.03, 0.45, 0.95), smoothstep(0.3, 0.6, t));
  c = mix(c, vec3f(0.25, 0.85, 1.0), smoothstep(0.6, 0.8, t));
  return mix(c, vec3f(0.92, 1.0, 1.0), smoothstep(0.8, 1.0, t));
}
// palette: 0 speed, 1 pressure, 2 temperature, 3 vorticity
fn palette(id: u32, t: f32) -> vec3f {
  switch (id) {
    case 0u: { return neon(t); }
    case 1u: { return turbo(t * 0.86 + 0.07); }
    case 2u: { return inferno(t * 0.92 + 0.04); }
    case 3u: { return viridisLike(t); }
    case 4u: { return wakeMap(t); }
    default: { return neon(t); }
  }
}
`;

export const VIEW = /* wgsl */ `
struct View {
  uIn: f32, vReal: f32, cpMin: f32, cpMax: f32,
  tMin: f32, tMax: f32, speedMax: f32, vortMax: f32,
}
fn adiabaticDelta(cp: f32) -> f32 { return cp * 0.5 * view.vReal * view.vReal / 1005.0; }
fn rhoRef() -> f32 {
  let r = fields[cellIdx(vec3i(6, i32(grid.dims.y) - 6, i32(grid.dims.z) - 6))].w;
  return select(1.0, r, r > 0.5);
}
fn pressureCoef(s: Sample) -> f32 { return (s.rho - rhoRef()) / 3.0 / (0.5 * view.uIn * view.uIn); }
fn fieldValue(id: u32, s: Sample, p: vec3f) -> f32 {
  switch (id) {
    case 1u: {
      return (pressureCoef(s) - view.cpMin) / (view.cpMax - view.cpMin);
    }
    case 2u: {
      let t = s.temp + adiabaticDelta(pressureCoef(s));
      return (t - view.tMin) / (view.tMax - view.tMin);
    }
    case 3u: { return vorticityAt(p) / (view.uIn * view.vortMax); }
    case 4u: {
      // Wake rake: streamwise velocity deficit, i.e. the momentum the car took out of the air.
      return clamp((1.0 - s.u.x / view.uIn) / 0.9, 0.0, 1.0);
    }
    default: { return length(s.u) / (view.uIn * view.speedMax); }
  }
}
`;

export const HEAT = GRID + /* wgsl */ `
struct Heat { dt: f32, cool: f32, diffuse: f32, pad: f32 }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> heat: Heat;
@group(0) @binding(2) var<storage, read> fields: array<vec4f>;
@group(0) @binding(3) var<storage, read> emit: array<f32>;
@group(0) @binding(4) var<storage, read> tin: array<f32>;
@group(0) @binding(5) var<storage, read_write> tout: array<f32>;

fn idxOf(c: vec3i) -> u32 {
  let d = vec3i(grid.dims);
  var q = c;
  if (q.z < 0) { q.z = -q.z - 1; }
  q = clamp(q, vec3i(0), d - vec3i(1));
  return u32(q.x) + grid.dims.x * (u32(q.y) + grid.dims.y * u32(q.z));
}
fn tAt(c: vec3i) -> f32 {
  if (c.x < 0) { return 0.0; }
  return tin[idxOf(c)];
}
@compute @workgroup_size(128)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= grid.n) { return; }
  let NX = grid.dims.x; let NY = grid.dims.y;
  let c = vec3i(vec3u(idx % NX, (idx / NX) % NY, idx / (NX * NY)));
  let fv = fields[idx];
  if (fv.w <= 0.0) { tout[idx] = emit[idx]; return; }
  let g = vec3f(c) - fv.xyz * heat.dt;
  let i0 = vec3i(floor(g));
  let f = g - vec3f(i0);
  var t = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * select(1.0 - f.z, f.z, o.z == 1);
    t += tAt(i0 + o) * w;
  }
  var nb = 0.0;
  var src = 0.0;
  let offs = array<vec3i, 6>(vec3i(1, 0, 0), vec3i(-1, 0, 0), vec3i(0, 1, 0), vec3i(0, -1, 0), vec3i(0, 0, 1), vec3i(0, 0, -1));
  for (var k = 0; k < 6; k++) {
    let cc = c + offs[k];
    nb += tAt(cc);
    if (cc.x >= 0 && cc.y >= 0 && cc.x < i32(NX) && cc.y < i32(NY) && cc.z < i32(grid.dims.z)) {
      src = max(src, emit[idxOf(cc)]);
    }
  }
  t = mix(t, nb / 6.0, heat.diffuse);
  if (src > 0.0) { t = mix(t, src, 0.35); }
  tout[idx] = max(t * (1.0 - heat.cool), 0.0);
}
`;

export const PARTICLE_STRUCT = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f }
`;

export const PARTICLES_SIM = GRID + PARTICLE_STRUCT + /* wgsl */ `
struct PSim {
  count: u32, spawnMode: u32, colorMode: u32, frame: u32,
  dt: f32, life: f32, scatter: u32, rakeRows: u32,
  spawnMin: vec3f, rakeCols: u32,
  spawnMax: vec3f, pad: f32,
}
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> psim: PSim;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var<storage, read> fields: array<vec4f>;
@group(0) @binding(4) var<storage, read> temps: array<f32>;
@group(0) @binding(5) var<storage, read_write> parts: array<Particle>;
` + FIELD_SAMPLING + VIEW + /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / 4294967295.0;
}
fn domainMax() -> vec3f { return grid.origin + vec3f(grid.dims) * grid.h; }

fn spawn(i: u32, seed: ptr<function, u32>) -> Particle {
  var p: Particle;
  let lo = psim.spawnMin; let hi = psim.spawnMax;
  var pos: vec3f;
  if (psim.spawnMode == 1u) {
    let lanes = psim.rakeRows * psim.rakeCols;
    let lane = i % lanes;
    let row = lane / psim.rakeCols;
    let col = lane % psim.rakeCols;
    let fy = (f32(row) + 0.5) / f32(psim.rakeRows);
    let fz = (f32(col) + 0.5) / f32(psim.rakeCols);
    pos = vec3f(lo.x, mix(lo.y, hi.y, fy), mix(lo.z, hi.z, fz));
    pos += vec3f(rand(seed) * 0.12, (rand(seed) - 0.5) * 0.012, (rand(seed) - 0.5) * 0.012);
  } else {
    pos = vec3f(lo.x + rand(seed) * 0.15, mix(lo.y, hi.y, rand(seed)), mix(lo.z, hi.z, rand(seed)));
  }
  if (psim.scatter != 0u) { pos.x = mix(lo.x, domainMax().x - grid.h * 2.0, rand(seed)); }
  p.pos = vec4f(pos, 0.0);
  p.vel = vec4f(0.0, 0.0, 0.0, -1.0);
  return p;
}

@compute @workgroup_size(128)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= psim.count) { return; }
  var seed = pcg(i * 9781u + psim.frame * 6271u + 17u);
  var p = parts[i];
  let maxLife = psim.life * (0.6 + 0.4 * f32(pcg(i * 31u) % 1000u) / 1000.0);
  let hi = domainMax();
  if (psim.scatter != 0u || p.pos.w > maxLife) {
    p = spawn(i, &seed);
  }
  let s1 = sampleFlow(p.pos.xyz);
  let mid = p.pos.xyz + s1.u * grid.h * psim.dt * 0.5;
  let s2 = sampleFlow(mid);
  var d = s2.u * grid.h * psim.dt;
  let dl = length(d);
  if (dl > grid.h * 2.0) { d *= grid.h * 2.0 / dl; }
  var np = p.pos.xyz + d;
  let dead = np.x > hi.x - grid.h * 1.5 || np.y < 0.0 || np.y > hi.y || np.z > hi.z || s2.fluid < 0.05;
  if (dead) {
    p = spawn(i, &seed);
    p.pos.w = 0.0;
    parts[i] = p;
    return;
  }
  if (np.z < 0.0) { np.z = -np.z; }
  let sv = sampleFlow(np);
  p.pos = vec4f(np, p.pos.w + 1.0);
  p.vel = vec4f(d, clamp(fieldValue(psim.colorMode, sv, np), 0.0, 1.0));
  parts[i] = p;
}
`;

export const PARTICLES_DRAW = PARTICLE_STRUCT + COLORMAPS + /* wgsl */ `
struct PDraw {
  viewProj: mat4x4f,
  camPos: vec3f, width: f32,
  res: vec2f, trail: f32, alpha: f32,
  count: u32, palette: u32, fadeIn: f32, pad: f32,
}
@group(0) @binding(0) var<uniform> pd: PDraw;
@group(0) @binding(1) var<storage, read> parts: array<Particle>;
@group(0) @binding(2) var scene: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) side: f32,
  @location(2) dist: f32,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var out: VOut;
  let pi = ii % pd.count;
  let mirror = ii >= pd.count;
  var p = parts[pi];
  if (p.vel.w < 0.0) { out.pos = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  var head = p.pos.xyz;
  var vel = p.vel.xyz;
  if (mirror) { head.z = -head.z; vel.z = -vel.z; }
  let tail = head - vel * pd.trail;
  let a = pd.viewProj * vec4f(tail, 1.0);
  let b = pd.viewProj * vec4f(head, 1.0);
  if (a.w < 0.05 || b.w < 0.05) { out.pos = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  let sa = a.xy / a.w * pd.res * 0.5;
  let sb = b.xy / b.w * pd.res * 0.5;
  var dir = sb - sa;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  let corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let cn = corners[vi];
  let along = cn.x;
  let w = pd.width;
  let sp = mix(sa, sb, along) + nrm * cn.y * w * 0.5 + dir * (along * 2.0 - 1.0) * w * 0.5;
  let cw = mix(a.w, b.w, along);
  let cz = mix(a.z / a.w, b.z / b.w, along);
  out.pos = vec4f(sp / (pd.res * 0.5) * cw, cz * cw, cw);
  let fade = clamp(p.pos.w / pd.fadeIn, 0.0, 1.0);
  let c = palette(pd.palette, p.vel.w);
  var heatBoost = 1.0;
  if (pd.palette == 2u) { heatBoost = mix(0.25, 4.0, smoothstep(0.08, 0.6, p.vel.w)); }
  out.color = vec4f(c, pd.alpha * fade * heatBoost * mix(0.15, 1.0, along));
  out.side = cn.y;
  out.dist = distance(pd.camPos, mix(tail, head, along));
  return out;
}

@fragment fn fs_main(v: VOut) -> @location(0) vec4f {
  let sz = vec2i(textureDimensions(scene));
  let px = clamp(vec2i(v.pos.xy / pd.res * vec2f(sz)), vec2i(0), sz - vec2i(1));
  let sceneDist = textureLoad(scene, px, 0).a;
  if (v.dist > sceneDist + 0.03) { discard; }
  let a = v.color.a * (1.0 - v.side * v.side);
  return vec4f(v.color.rgb * a, a);
}
`;

