// Prepares the W17 model for the tunnel:
//  - w17.rig.bin / w17.rig.json: which vertices belong to the articulated wing elements, the
//    hinge line of each element and outline sections used for the part picker thumbnails.
//  - w17.sdf.bin: signed distance grid of the static body (wheels and articulated parts excluded).
//  - w17.parts.bin: one small distance grid per articulated part, baked at rest pose.
import { readFileSync, writeFileSync } from "node:fs";
import { parseGlb } from "../src/engine/glb";
import { CAR_LAYOUT, RIG, WHEEL_MATERIALS, toCarFrame } from "../src/engine/car-model";

const root = new URL("../public/models/", import.meta.url).pathname;
const file = readFileSync(root + "w17.glb");
const scene = parseGlb(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));

type Vec3 = [number, number, number];
interface Prim { name: string; verts: Vec3[]; indices: Uint32Array; wheel: boolean }
const prims: Prim[] = scene.primitives.map((p) => ({
  name: scene.materials[p.material].name,
  verts: Array.from({ length: p.positions.length / 3 }, (_, i) => toCarFrame(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2])),
  indices: p.indices,
  wheel: WHEEL_MATERIALS.has(scene.materials[p.material].name),
}));

// ---------- Connected components ----------
function components(prim: Prim, keep: (v: Vec3) => boolean): Map<number, number[]> {
  const n = prim.verts.length;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const weld = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!keep(prim.verts[i])) continue;
    const k = prim.verts[i].map((x) => x.toFixed(4)).join();
    const w = weld.get(k);
    if (w === undefined) weld.set(k, i); else parent[find(i)] = find(w);
  }
  for (let f = 0; f < prim.indices.length; f += 3) {
    const t = [prim.indices[f], prim.indices[f + 1], prim.indices[f + 2]];
    if (!t.every((i) => keep(prim.verts[i]))) continue;
    parent[find(t[1])] = find(t[0]);
    parent[find(t[2])] = find(t[0]);
  }
  const out = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!keep(prim.verts[i])) continue;
    const r = find(i);
    if (!out.has(r)) out.set(r, []);
    out.get(r)!.push(i);
  }
  return out;
}
const bbox = (pts: Vec3[]) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  return { mn, mx };
};

// ---------- Element identification ----------
const { front, rear } = RIG;
const carbon = prims.find((p) => p.name === "mercedes_carbon1.007")!;
const paint = prims.find((p) => p.name === "mercedes_paint.007")!;

const inFrontBand = (v: Vec3) => v[0] < 0.75 && v[1] < 0.5 && Math.abs(v[2]) > front.bandZ[0] && Math.abs(v[2]) < front.bandZ[1];
const frontComps = [...components(carbon, inFrontBand).values()]
  .map((idx) => idx.map((i) => carbon.verts[i]))
  .filter((pts) => pts.length > 100 && bbox(pts).mn[2] > 0)
  .sort((a, b) => bbox(a).mn[0] - bbox(b).mn[0]);
if (frontComps.length < 3) throw new Error(`expected 3 front wing elements, found ${frontComps.length}`);
const frontElements = frontComps.slice(0, 3);

const inRear = (v: Vec3) => v[0] > 4.5 && v[1] > 0.8 && v[1] < 1.0 && Math.abs(v[2]) < rear.maxZ;
const rearComps = [...components(paint, inRear).values()]
  .map((idx) => idx.map((i) => paint.verts[i]))
  .filter((pts) => pts.length > 100)
  .sort((a, b) => bbox(a).mn[0] - bbox(b).mn[0]);
if (rearComps.length < 3) throw new Error(`expected 3 rear wing elements, found ${rearComps.length}`);
const rearElements = rearComps.slice(0, 3);

// Hinge line: leading-edge point of each element, tabulated along |z|.
const hingeTable = (pts: Vec3[]) => {
  const table: [number, number][] = [];
  for (let b = 0; b < front.bins; b++) {
    const z = b * front.dz;
    let best: Vec3 | null = null;
    for (const p of pts) {
      if (Math.abs(Math.abs(p[2]) - z) > front.dz * 0.75) continue;
      if (!best || p[0] < best[0]) best = p;
    }
    table.push(best ? [best[0], best[1]] : [NaN, NaN]);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let b = 1; b < table.length; b++) if (Number.isNaN(table[b][0])) table[b] = table[b - 1];
    for (let b = table.length - 2; b >= 0; b--) if (Number.isNaN(table[b][0])) table[b] = table[b + 1];
  }
  return table;
};
const frontHinges = [hingeTable(frontElements[1]), hingeTable(frontElements[2])];
const leadingEdge = (pts: Vec3[]): [number, number] => {
  let best = pts[0];
  for (const p of pts) if (p[0] < best[0]) best = p;
  return [best[0], best[1]];
};
const rearMainHinge = leadingEdge(rearElements[0]);
const rearFlapHinge = leadingEdge(rearElements[1]);

// Every vertex near an element's skin (decals and fasteners included) follows that element.
const binned = (sets: Vec3[][], dz: number) => {
  const grid = new Map<number, { el: number; p: Vec3 }[]>();
  sets.forEach((pts, el) => {
    for (const p of pts) {
      const b = Math.round(Math.abs(p[2]) / dz);
      if (!grid.has(b)) grid.set(b, []);
      grid.get(b)!.push({ el, p });
    }
  });
  return grid;
};
const frontBins = binned(frontElements, 0.01);
const rearBins = binned(rearElements, 0.01);
const nearestElement = (bins: Map<number, { el: number; p: Vec3 }[]>, v: Vec3, maxDist: number) => {
  const b = Math.round(Math.abs(v[2]) / 0.01);
  let best = -1, bestD = maxDist;
  for (let db = -1; db <= 1; db++) {
    for (const s of bins.get(b + db) ?? []) {
      const d = Math.hypot(s.p[0] - v[0], s.p[1] - v[1], Math.abs(s.p[2]) - Math.abs(v[2]));
      if (d < bestD) { bestD = d; best = s.el; }
    }
  }
  return best;
};

// Whole wing assemblies (elements, endplates, pillars) that can be detached in the UI.
const assemblyOf = (v: Vec3) => {
  const az = Math.abs(v[2]);
  if (v[0] > -0.35 && v[0] < 0.8 && v[1] < 0.47 && !(az < 0.15 && v[1] > 0.235)) return RIG.assembly.frontWing;
  if (v[0] > 4.5 && v[1] > 0.55 && az < 0.62) return RIG.assembly.rearWing;
  return 0;
};

let totalVerts = 0;
for (const p of prims) totalVerts += p.verts.length;
const vertexPart = new Uint8Array(totalVerts);
const partCounts = [0, 0, 0, 0, 0];
let base = 0;
for (const prim of prims) {
  if (!prim.wheel) {
    prim.verts.forEach((v, i) => {
      let part = 0;
      if (inFrontBand(v)) {
        const el = nearestElement(frontBins, v, 0.012);
        if (el === 1) part = RIG.parts.frontFlapA;
        else if (el === 2) part = RIG.parts.frontFlapB;
      } else if (inRear(v)) {
        const el = nearestElement(rearBins, v, 0.012);
        if (el === 0) part = RIG.parts.rearMain;
        else if (el >= 1) part = RIG.parts.rearFlap;
      }
      vertexPart[base + i] = part | (assemblyOf(v) << RIG.assemblyShift);
      partCounts[part]++;
    });
  }
  base += prim.verts.length;
}
console.log("rigged vertices", partCounts.slice(1).join(" / "));

// Outline sections for the picker thumbnails (convex hull of each element at a reference span).
const hull = (pts: [number, number][]) => {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...s].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
};
const sectionAt = (pts: Vec3[], z: number) => hull(pts.filter((p) => Math.abs(Math.abs(p[2]) - z) < 0.02).map((p) => [p[0], p[1]] as [number, number]));

// Mean camber description of every element along the span, used by the panel method.
const wingStations = (pts: Vec3[], z0: number, z1: number, step: number) => {
  const out: { z: number; le: [number, number]; mid: [number, number]; te: [number, number] }[] = [];
  for (let z = z0; z <= z1 + 1e-6; z += step) {
    const sec = pts.filter((p) => Math.abs(Math.abs(p[2]) - z) < step * 0.6);
    if (sec.length < 8) continue;
    let le = sec[0], te = sec[0];
    for (const p of sec) { if (p[0] < le[0]) le = p; if (p[0] > te[0]) te = p; }
    const xm = (le[0] + te[0]) / 2, band = (te[0] - le[0]) * 0.12;
    const mids = sec.filter((p) => Math.abs(p[0] - xm) < band);
    const ys = mids.length ? mids.map((p) => p[1]) : [(le[1] + te[1]) / 2];
    const r = (v: number) => +v.toFixed(4);
    out.push({ z: r(z), le: [r(le[0]), r(le[1])], mid: [r(xm), r((Math.min(...ys) + Math.max(...ys)) / 2)], te: [r(te[0]), r(te[1])] });
  }
  return out;
};
const wings = {
  front: frontElements.map((pts) => wingStations(pts, front.bandZ[0] + 0.01, front.bandZ[1] - 0.01, 0.02)),
  rear: rearElements.map((pts) => wingStations(pts, 0.02, rear.maxZ - 0.02, 0.03)),
};

// ---------- Distance grids ----------
interface GridLayout { origin: Vec3; h: number; dims: [number, number, number] }

function closestOnTriangle(px: number, py: number, pz: number, t: Float64Array): number {
  const ax = t[0], ay = t[1], az = t[2], bx = t[3], by = t[4], bz = t[5], cx = t[6], cy = t[7], cz = t[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return sq(apx - v * abx, apy - v * aby, apz - v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return sq(apx - w * acx, apy - w * acy, apz - w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(px - (bx + w * (cx - bx)), py - (by + w * (cy - by)), pz - (bz + w * (cz - bz)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0];
  const sign = (x >> 16) & 0x8000;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

// Triangles are selected by the part of their first vertex so each one lands in exactly one grid.
function bakeGrid(layout: GridLayout, want: (tag: number) => boolean, band: number, closing: number, shell: number): Uint16Array {
  const { origin, h, dims } = layout;
  const [NX, NY, NZ] = dims;
  const at = (i: number, j: number, k: number) => (k * NY + j) * NX + i;
  const dist = new Float32Array(NX * NY * NZ).fill(band);
  const tri = new Float64Array(9);
  let vbase = 0;
  for (const prim of prims) {
    if (!prim.wheel) {
      const I = prim.indices;
      for (let f = 0; f < I.length; f += 3) {
        if (!want(vertexPart[vbase + I[f]])) continue;
        for (let v = 0; v < 3; v++) {
          const p = prim.verts[I[f + v]];
          tri[v * 3] = p[0]; tri[v * 3 + 1] = p[1]; tri[v * 3 + 2] = p[2];
        }
        if (Math.max(tri[2], tri[5], tri[8]) < -band) continue;
        const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((Math.min(tri[a], tri[a + 3], tri[a + 6]) - band - origin[a]) / h)));
        const hi = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.ceil((Math.max(tri[a], tri[a + 3], tri[a + 6]) + band - origin[a]) / h)));
        for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
          const d = closestOnTriangle(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h, tri);
          const idx = at(i, j, k);
          if (d < dist[idx]) dist[idx] = d;
        }
      }
    }
    vbase += prim.verts.length;
  }

  // Morphological closing: flood the outside treating everything within `closing` of the surface
  // as a wall (seals openings in the mesh), then grow the flooded region back by `closing`.
  // Flooding starts from every face but the z=0 symmetry plane.
  const reached = new Uint8Array(NX * NY * NZ);
  const queue = new Int32Array(NX * NY * NZ);
  let qh = 0, qt = 0;
  const push = (i: number, j: number, k: number) => {
    const idx = at(i, j, k);
    if (reached[idx] || dist[idx] < closing) return;
    reached[idx] = 1;
    queue[qt++] = idx;
  };
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) { push(0, j, k); push(NX - 1, j, k); }
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { push(i, 0, k); push(i, NY - 1, k); }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) push(i, j, NZ - 1);
  while (qh < qt) {
    const idx = queue[qh++];
    const i = idx % NX, j = Math.floor(idx / NX) % NY, k = Math.floor(idx / (NX * NY));
    if (i > 0) push(i - 1, j, k);
    if (i < NX - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k);
    if (j < NY - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1);
    if (k < NZ - 1) push(i, j, k + 1);
  }
  const grow = new Int16Array(NX * NY * NZ).fill(-1);
  qh = 0; qt = 0;
  for (let idx = 0; idx < reached.length; idx++) if (reached[idx]) { grow[idx] = 0; queue[qt++] = idx; }
  const maxSteps = Math.ceil(closing / h);
  while (qh < qt) {
    const idx = queue[qh++];
    const g = grow[idx];
    if (g >= maxSteps) continue;
    const i = idx % NX, j = Math.floor(idx / NX) % NY, k = Math.floor(idx / (NX * NY));
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj, c = k + dk;
      if (a < 0 || b < 0 || c < 0 || a >= NX || b >= NY || c >= NZ) continue;
      const n = at(a, b, c);
      if (grow[n] >= 0) continue;
      grow[n] = g + 1;
      queue[qt++] = n;
    }
  }

  const out = new Uint16Array(NX * NY * NZ);
  for (let idx = 0; idx < out.length; idx++) {
    const d = dist[idx];
    out[idx] = toHalf(grow[idx] >= 0 ? d - shell : -Math.max(d, 0.001) - shell);
  }
  return out;
}

const t0 = Date.now();
const body = bakeGrid({ origin: CAR_LAYOUT.sdf.origin, h: CAR_LAYOUT.sdf.h, dims: CAR_LAYOUT.sdf.dims }, (tag) => tag === 0, 0.075, 0.06, 0.008);
writeFileSync(root + "w17.sdf.bin", Buffer.from(body.buffer));
console.log(`body grid in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const partGrids: { part: number; origin: Vec3; h: number; dims: [number, number, number]; offset: number }[] = [];
const chunks: Uint16Array[] = [];
let offset = 0;
const partOf = (tag: number) => tag & RIG.partMask;
const assemblyTag = (tag: number) => tag >> RIG.assemblyShift;
const gridSpecs: { part: number; want: (tag: number) => boolean; closing: number }[] = [
  { part: RIG.parts.frontFlapA, want: (t) => partOf(t) === RIG.parts.frontFlapA, closing: 0.012 },
  { part: RIG.parts.frontFlapB, want: (t) => partOf(t) === RIG.parts.frontFlapB, closing: 0.012 },
  { part: RIG.parts.rearFlap, want: (t) => partOf(t) === RIG.parts.rearFlap, closing: 0.012 },
  { part: RIG.parts.rearMain, want: (t) => partOf(t) === RIG.parts.rearMain, closing: 0.012 },
  { part: RIG.parts.frontStatic, want: (t) => partOf(t) === 0 && assemblyTag(t) === RIG.assembly.frontWing, closing: 0.03 },
  { part: RIG.parts.rearStatic, want: (t) => partOf(t) === 0 && assemblyTag(t) === RIG.assembly.rearWing, closing: 0.03 },
];
for (const spec of gridSpecs) {
  const pts: Vec3[] = [];
  let vb = 0;
  for (const prim of prims) {
    prim.verts.forEach((v, i) => { if (!prim.wheel && spec.want(vertexPart[vb + i])) pts.push([v[0], v[1], Math.abs(v[2])]); });
    vb += prim.verts.length;
  }
  const { mn, mx } = bbox(pts);
  const h = RIG.partGridH, margin = 0.04;
  const origin: Vec3 = [mn[0] - margin, mn[1] - margin, 0];
  const dims: [number, number, number] = [0, 1, 2].map((k) => Math.ceil((mx[k] + margin - origin[k]) / h) + 1) as [number, number, number];
  const grid = bakeGrid({ origin, h, dims }, spec.want, 0.03, spec.closing, 0.004);
  partGrids.push({ part: spec.part, origin, h, dims, offset });
  chunks.push(grid);
  offset += grid.length;
  console.log(`part ${spec.part}: ${dims.join("×")}`);
}
const partsBin = new Uint16Array(offset);
chunks.forEach((c, i) => partsBin.set(c, partGrids[i].offset));
writeFileSync(root + "w17.parts.bin", Buffer.from(partsBin.buffer));
writeFileSync(root + "w17.rig.bin", Buffer.from(vertexPart.buffer));
writeFileSync(root + "w17.rig.json", JSON.stringify({
  frontHinges: frontHinges.map((t) => t.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])),
  rearMainHinge, rearFlapHinge,
  partGrids,
  wings,
  sections: {
    front: frontElements.map((pts) => sectionAt(pts, 0.35)),
    rear: rearElements.map((pts) => sectionAt(pts, 0.3)),
  },
}));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
