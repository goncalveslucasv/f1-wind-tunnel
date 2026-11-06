export interface GlbPrimitive {
  node: string;
  material: number;
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  indices: Uint32Array;
}

export interface GlbMaterial {
  name: string;
  baseColor: [number, number, number, number];
  baseColorTexture: number | null;
  normalTexture: number | null;
  metallic: number;
  roughness: number;
  blend: boolean;
  doubleSided: boolean;
}

export interface GlbScene {
  primitives: GlbPrimitive[];
  materials: GlbMaterial[];
  images: { mime: string; bytes: Uint8Array }[];
  textureImage: number[];
  asset: Record<string, unknown>;
}

type Json = Record<string, any>;
type Mat4 = Float64Array;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function nodeMatrix(n: Json): Mat4 {
  const m = new Float64Array(16);
  if (n.matrix) {
    m.set(n.matrix);
    return m;
  }
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  m[0] = (1 - 2 * (y * y + z * z)) * sx; m[1] = 2 * (x * y + z * w) * sx; m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy; m[5] = (1 - 2 * (x * x + z * z)) * sy; m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz; m[9] = 2 * (y * z - x * w) * sz; m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function parseGlb(buffer: ArrayBuffer): GlbScene {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("Not a GLB file");
  const jsonLen = view.getUint32(12, true);
  const json: Json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binOffset = 20 + jsonLen + 8;
  const binLen = view.getUint32(20 + jsonLen, true);
  const bin = new Uint8Array(buffer, binOffset, binLen);

  const readAccessor = (index: number): Float32Array | Uint32Array => {
    const a = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const n = COMPONENTS[a.type];
    const count = a.count * n;
    const base = bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
    const stride = bv.byteStride ?? n * size;
    const out = a.componentType === 5126 ? new Float32Array(count) : new Uint32Array(count);
    const dv = new DataView(buffer);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < n; k++) {
        const o = base + i * stride + k * size;
        out[i * n + k] =
          a.componentType === 5126 ? dv.getFloat32(o, true)
          : a.componentType === 5125 ? dv.getUint32(o, true)
          : a.componentType === 5123 ? dv.getUint16(o, true)
          : dv.getUint8(o);
      }
    }
    return out;
  };

  const primitives: GlbPrimitive[] = [];
  const walk = (index: number, parent: Mat4) => {
    const node = json.nodes[index];
    const world = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const normalMat = world;
      for (const p of json.meshes[node.mesh].primitives) {
        const pos = readAccessor(p.attributes.POSITION) as Float32Array;
        const nrm = p.attributes.NORMAL !== undefined ? (readAccessor(p.attributes.NORMAL) as Float32Array) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined ? (readAccessor(p.attributes.TEXCOORD_0) as Float32Array) : null;
        const vcount = pos.length / 3;
        const wp = new Float32Array(pos.length);
        const wn = nrm ? new Float32Array(nrm.length) : null;
        for (let i = 0; i < vcount; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          wp[i * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
          wp[i * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          wp[i * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
          if (nrm && wn) {
            const a = nrm[i * 3], b = nrm[i * 3 + 1], c = nrm[i * 3 + 2];
            let nx = normalMat[0] * a + normalMat[4] * b + normalMat[8] * c;
            let ny = normalMat[1] * a + normalMat[5] * b + normalMat[9] * c;
            let nz = normalMat[2] * a + normalMat[6] * b + normalMat[10] * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            nx /= l; ny /= l; nz /= l;
            wn[i * 3] = nx; wn[i * 3 + 1] = ny; wn[i * 3 + 2] = nz;
          }
        }
        let indices: Uint32Array;
        if (p.indices !== undefined) indices = Uint32Array.from(readAccessor(p.indices));
        else indices = Uint32Array.from({ length: vcount }, (_, i) => i);
        primitives.push({ node: node.name ?? "", material: p.material ?? 0, positions: wp, normals: wn, uvs: uv, indices });
      }
    }
    for (const c of node.children ?? []) walk(c, world);
  };
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, identity);

  const materials: GlbMaterial[] = (json.materials ?? []).map((m: Json) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    return {
      name: m.name ?? "",
      baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1],
      baseColorTexture: pbr.baseColorTexture?.index ?? null,
      normalTexture: m.normalTexture?.index ?? null,
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      blend: m.alphaMode === "BLEND" || m.alphaMode === "MASK",
      doubleSided: !!m.doubleSided,
    };
  });
  const images = (json.images ?? []).map((im: Json) => {
    const bv = json.bufferViews[im.bufferView];
    return { mime: im.mimeType as string, bytes: new Uint8Array(buffer, binOffset + (bv.byteOffset ?? 0), bv.byteLength) };
  });
  const textureImage = (json.textures ?? []).map((t: Json) => t.source as number);
  return { primitives, materials, images, textureImage, asset: json.asset ?? {} };
}
