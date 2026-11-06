import type * as VGPU from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { parseGlb } from "./glb";
import { CAR_LAYOUT, RIG, WHEEL_MATERIALS, normalToCarFrame, toCarFrame, type WingStation } from "./car-model";
import { MESH_DRAW } from "./render-wgsl";

type V = typeof VGPU;
type Gpu = VGPU.Gpu;

export interface DecodedImage { width: number; height: number; data: Uint8Array }
export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<DecodedImage>;

export interface MeshCamera {
  viewProj: Float32Array;
  camPos: readonly number[];
  jitter: [number, number];
  rideH: number;
  rake: number;
}

const EMISSIVE = /light|led|kers|lcd/i;
const DECAL_BLEND = {
  color: { src: "src-alpha", dst: "one-minus-src-alpha" },
  alpha: { src: "zero", dst: "one" },
} as const;
const PAINT = /paint/i;
const CARBON = /carbon/i;

function halveRgba(src: DecodedImage): DecodedImage {
  const w = Math.max(1, src.width >> 1), h = Math.max(1, src.height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, y * 2), y1 = Math.min(src.height - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.width - 1, x * 2), x1 = Math.min(src.width - 1, x * 2 + 1);
      for (let c = 0; c < 4; c++) {
        out[(y * w + x) * 4 + c] = (
          src.data[(y0 * src.width + x0) * 4 + c] + src.data[(y0 * src.width + x1) * 4 + c] +
          src.data[(y1 * src.width + x0) * 4 + c] + src.data[(y1 * src.width + x1) * 4 + c] + 2) >> 2;
      }
    }
  }
  return { width: w, height: h, data: out };
}

export class MeshCar {
  private readonly draws: { draw: VGPU.Draw; count: number; optional?: "gurney" }[] = [];
  gurney = false;

  private constructor() {}

  static async load(V: V, gpu: Gpu, buffer: ArrayBuffer, vertexParts: Uint8Array, decode: ImageDecoder, gurneyEdge?: WingStation[]): Promise<MeshCar> {
    const car = new MeshCar();
    const scene = parseGlb(buffer);
    const device = (gpu as unknown as { device: { gpu: GPUDevice } }).device.gpu;

    const tab = gurneyEdge ? gurneyGeometry(gurneyEdge) : null;
    let vertexCount = tab ? tab.verts.length / 8 : 0, indexCount = tab ? tab.indices.length : 0;
    for (const p of scene.primitives) { vertexCount += p.positions.length / 3; indexCount += p.indices.length; }
    const verts = new Float32Array(vertexCount * 8);
    const indices = new Uint32Array(indexCount);
    const ranges: { first: number; count: number; material: number }[] = [];
    let vBase = 0, iBase = 0;
    for (const p of scene.primitives) {
      const n = p.positions.length / 3;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = toCarFrame(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
        const [nx, ny, nz] = p.normals ? normalToCarFrame(p.normals[i * 3], p.normals[i * 3 + 1], p.normals[i * 3 + 2]) : [0, 1, 0];
        const o = (vBase + i) * 8;
        verts[o] = x; verts[o + 1] = y; verts[o + 2] = z; verts[o + 3] = p.uvs ? p.uvs[i * 2] : 0;
        verts[o + 4] = nx; verts[o + 5] = ny; verts[o + 6] = nz; verts[o + 7] = p.uvs ? p.uvs[i * 2 + 1] : 0;
      }
      for (let i = 0; i < p.indices.length; i++) indices[iBase + i] = p.indices[i] + vBase;
      ranges.push({ first: iBase, count: p.indices.length, material: p.material });
      vBase += n;
      iBase += p.indices.length;
    }
    const meshVertices = vBase;
    let gurneyRange: { first: number; count: number } | null = null;
    if (tab) {
      verts.set(tab.verts, vBase * 8);
      for (let i = 0; i < tab.indices.length; i++) indices[iBase + i] = tab.indices[i] + vBase;
      gurneyRange = { first: iBase, count: tab.indices.length };
    }
    const tags = new Uint8Array(vertexCount);
    tags.set(vertexParts.subarray(0, meshVertices));
    if (tab) tags.fill(RIG.parts.rearFlap | (RIG.assembly.rearWing << RIG.assemblyShift), meshVertices, vertexCount);
    const split = detachSeams(verts, indices, tags);
    const vertBuf = V.storage(gpu, split.verts.byteLength);
    vertBuf.write(split.verts);
    const indexBuf = V.storage(gpu, indices.byteLength);
    indexBuf.write(indices);
    const partWords = new Uint8Array(Math.ceil(split.tags.length / 4) * 4);
    partWords.set(split.tags);
    const partBuf = V.storage(gpu, partWords.byteLength);
    partBuf.write(partWords);
    const restRig = {
      front: Array.from({ length: 71 }, () => [0, 0, 0, 0]),
      hinges: [0, 0, 0, 0], angles: [0, 0, 0, 0], extra: [0, 1, 0, 0], fly: [0, 0, 1, 1],
      grids: Array.from({ length: 12 }, () => [0, 0, 0, 1]),
    };

    const sampler = V.sampler(gpu, {
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8,
    });
    const makeTexture = (img: DecodedImage) => {
      const levels = Math.floor(Math.log2(Math.max(img.width, img.height))) + 1;
      const tex = V.texture(gpu, {
        kind: "2d", size: [img.width, img.height], format: "rgba8unorm-srgb",
        usage: ["texture_binding", "copy_dst"], mipLevelCount: levels,
      });
      let level = img;
      for (let m = 0; m < levels; m++) {
        device.queue.writeTexture({ texture: tex.gpu, mipLevel: m }, level.data, { bytesPerRow: level.width * 4 }, [level.width, level.height]);
        if (m < levels - 1) level = halveRgba(level);
      }
      return tex;
    };
    const white = makeTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    const imageTextures = new Map<number, VGPU.Texture>();
    const textureFor = async (texIndex: number | null) => {
      if (texIndex === null) return null;
      const img = scene.textureImage[texIndex];
      if (!imageTextures.has(img)) {
        const src = scene.images[img];
        imageTextures.set(img, makeTexture(await decode(src.bytes, src.mime)));
      }
      return imageTextures.get(img)!;
    };

    const shader = prepareShader(MESH_DRAW, "mesh-car.wgsl");
    const order = ranges.map((r, i) => i).sort((a, b) => Number(scene.materials[ranges[a].material].blend) - Number(scene.materials[ranges[b].material].blend));
    for (const ri of order) {
      const r = ranges[ri];
      const m = scene.materials[r.material];
      const tex = await textureFor(m.baseColorTexture);
      const isBody = !WHEEL_MATERIALS.has(m.name);
      const draw = V.draw(gpu, {
        shader,
        label: `car:${m.name}`,
        vertices: r.count,
        cull: "none",
        depth: m.blend ? { write: false, compare: "less-equal", bias: -4, biasSlopeScale: -1 } : { write: true, compare: "less" },
        colors: m.blend ? [{ blend: DECAL_BLEND }, { writeMask: [] }, { writeMask: [] }] : undefined,
        set: {
          mat: {
            color: m.baseColor,
            metal: Math.min(m.metallic, 0.9),
            rough: Math.max(m.roughness, 0.05),
            coat: PAINT.test(m.name) ? 1 : CARBON.test(m.name) ? 0.6 : 0.2,
            alphaCut: m.blend ? 0.02 : 0,
            emissive: EMISSIVE.test(m.name) ? 1.5 : 0,
            hasTex: tex ? 1 : 0,
            isBody: isBody ? 1 : 0,
            firstIndex: r.first,
          },
          verts: vertBuf,
          indices: indexBuf,
          albedoTex: tex ?? white,
          texSamp: sampler,
          rig: restRig,
          vparts: partBuf,
        },
      });
      car.draws.push({ draw, count: r.count });
    }
    if (gurneyRange) {
      const draw = V.draw(gpu, {
        shader,
        label: "car:gurney",
        vertices: gurneyRange.count,
        cull: "none",
        depth: { write: true, compare: "less" },
        set: {
          mat: { color: [0.025, 0.026, 0.03, 1], metal: 0, rough: 0.35, coat: 0.6, alphaCut: 0, emissive: 0, hasTex: 0, isBody: 1, firstIndex: gurneyRange.first },
          verts: vertBuf, indices: indexBuf, albedoTex: white, texSamp: sampler, rig: restRig, vparts: partBuf,
        },
      });
      car.draws.push({ draw, count: gurneyRange.count, optional: "gurney" });
    }
    return car;
  }

  setCamera(c: MeshCamera) {
    const cam = { viewProj: c.viewProj, camPos: c.camPos, rideH: c.rideH, jitter: c.jitter, rake: c.rake, baseRide: CAR_LAYOUT.baseRideH };
    for (const d of this.draws) d.draw.set({ cam });
  }

  setRig(rig: object) {
    for (const d of this.draws) d.draw.set({ rig });
  }

  record(pass: { draw: (d: VGPU.Draw, opts?: VGPU.DrawCallOptions) => void }) {
    for (const d of this.draws) if (!d.optional || this.gurney) pass.draw(d.draw, { vertices: d.count });
  }
}

const GURNEY_VISUAL_HEIGHT = 0.015;

// Thin tab along the trailing edge of the last rear-wing element, normal to its chord.
function gurneyGeometry(edge: WingStation[]) {
  const verts: number[] = [];
  const indices: number[] = [];
  const span = [{ ...edge[0], z: 0 }, ...edge, { ...edge[edge.length - 1], z: RIG.rear.maxZ }];
  for (const side of [1, -1]) {
    const base = verts.length / 8;
    for (const s of span) {
      const dx = s.te[0] - s.le[0], dy = s.te[1] - s.le[1];
      const l = Math.hypot(dx, dy) || 1;
      const up = [-dy / l, dx / l];
      const top = [s.te[0] + up[0] * GURNEY_VISUAL_HEIGHT, s.te[1] + up[1] * GURNEY_VISUAL_HEIGHT];
      verts.push(s.te[0], s.te[1], s.z * side, 0, dx / l, dy / l, 0, 0);
      verts.push(top[0], top[1], s.z * side, 0, dx / l, dy / l, 0, 0);
    }
    for (let i = 0; i < span.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return { verts: new Float32Array(verts), indices: new Uint32Array(indices) };
}

// Triangles that straddle a detachable wing and the body would stretch when the wing flies off.
// Each such triangle is given to the side that owns most of its vertices, and the vertices it
// borrows from the other side are duplicated with the right tag. Rewrites `indices` in place.
function detachSeams(verts: Float32Array<ArrayBuffer>, indices: Uint32Array, tags: Uint8Array<ArrayBuffer>): { verts: Float32Array<ArrayBuffer>; tags: Uint8Array<ArrayBuffer> } {
  const asm = (v: number) => tags[v] >> RIG.assemblyShift;
  const extra: number[] = [];
  const extraTags: number[] = [];
  const dup = new Map<number, number>();
  const base = tags.length;
  for (let f = 0; f < indices.length; f += 3) {
    const a = asm(indices[f]), b = asm(indices[f + 1]), c = asm(indices[f + 2]);
    if (a === b && b === c) continue;
    const owner = a === b || a === c ? a : b === c ? b : Math.max(a, b, c);
    for (let k = 0; k < 3; k++) {
      const v = indices[f + k];
      if (asm(v) === owner) continue;
      const key = v * 4 + owner;
      let n = dup.get(key);
      if (n === undefined) {
        n = base + extraTags.length;
        dup.set(key, n);
        for (let c2 = 0; c2 < 8; c2++) extra.push(verts[v * 8 + c2]);
        extraTags.push((tags[v] & RIG.partMask) | (owner << RIG.assemblyShift));
      }
      indices[f + k] = n;
    }
  }
  if (!extraTags.length) return { verts, tags };
  const outVerts = new Float32Array(verts.length + extra.length);
  outVerts.set(verts);
  outVerts.set(extra, verts.length);
  const outTags = new Uint8Array(tags.length + extraTags.length);
  outTags.set(tags);
  outTags.set(extraTags, tags.length);
  return { verts: outVerts, tags: outTags };
}
