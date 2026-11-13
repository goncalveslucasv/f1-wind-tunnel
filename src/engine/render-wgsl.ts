import { COLORMAPS, FIELD_SAMPLING, GRID, SDF, SHAPE, VIEW } from "./wgsl";
import { RIG_WGSL } from "./car-model";

export const RENDER = GRID + SHAPE + /* wgsl */ `
struct Cam {
  pos: vec3f, tanHalf: f32,
  fwd: vec3f, aspect: f32,
  right: vec3f, time: f32,
  up: vec3f, roadSpeed: f32,
  jitter: vec2f, pad0: f32, pad1: f32,
}
struct Look {
  bmin: vec3f, surfMode: u32,
  bmax: vec3f, palette: u32,
  paint: vec3f, carbonBody: u32,
  accent: vec3f, isF1: u32,
  sliceAxis: u32, slicePos: f32, sliceAlpha: f32, showFlow: u32,
  meshMode: u32, cooling: u32, pad1: u32, pad2: u32,
}
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> shape: Shape;
@group(0) @binding(2) var<uniform> cam: Cam;
@group(0) @binding(3) var<uniform> look: Look;
@group(0) @binding(4) var<uniform> view: View;
@group(0) @binding(5) var<storage, read> profile: array<f32>;
@group(0) @binding(6) var<storage, read> fields: array<vec4f>;
@group(0) @binding(7) var<storage, read> temps: array<f32>;
@group(0) @binding(8) var carSdf: texture_3d<f32>;
@group(0) @binding(9) var carSamp: sampler;
@group(0) @binding(10) var gAlbedo: texture_2d<f32>;
@group(0) @binding(11) var gNormal: texture_2d<f32>;
@group(0) @binding(12) var gMaterial: texture_2d<f32>;
@group(0) @binding(13) var carParts: texture_3d<f32>;
@group(0) @binding(14) var<uniform> rig: Rig;
` + SDF + FIELD_SAMPLING + VIEW + COLORMAPS + /* wgsl */ `
const FAR: f32 = 6.0e4;
const PI: f32 = 3.14159265;
const KEY: vec3f = vec3f(-0.32, 0.90, 0.30);

fn toLinear(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

// Dark photo studio: three long overhead softboxes plus a rim strip behind the car.
fn studioEnv(d: vec3f) -> vec3f {
  var c = vec3f(0.004, 0.005, 0.007) + vec3f(0.018, 0.020, 0.025) * smoothstep(-0.05, 0.5, d.y);
  if (d.y > 0.08) {
    let u = d.z / d.y;
    let v = d.x / d.y;
    var box = 0.0;
    for (var i = -1; i <= 1; i++) {
      box += smoothstep(0.17, 0.12, abs(u - f32(i) * 0.75));
    }
    box *= smoothstep(1.9, 1.6, abs(v - 0.3));
    c += vec3f(2.4, 2.45, 2.6) * box * smoothstep(0.08, 0.35, d.y);
  }
  let rim = smoothstep(0.80, 0.95, d.x) * smoothstep(0.35, 0.05, abs(d.y - 0.18));
  c += vec3f(0.9, 1.0, 1.15) * rim;
  return c;
}
fn backdrop(rd: vec3f) -> vec3f {
  return vec3f(0.006, 0.007, 0.010) + vec3f(0.010, 0.012, 0.016) * smoothstep(-0.2, 0.6, rd.y);
}
fn boxHit(ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv; let t1 = (bmax - ro) * inv;
  let tn = min(t0, t1); let tf = max(t0, t1);
  return vec2f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}
fn march(ro: vec3f, rd: vec3f, maxSteps: i32) -> vec2f {
  let tb = boxHit(ro, rd, look.bmin, look.bmax);
  if (tb.x > tb.y || tb.y < 0.0) { return vec2f(FAR, 0.0); }
  var t = max(tb.x, 0.0);
  for (var i = 0; i < maxSteps; i++) {
    let r = sceneSdf(ro + rd * t);
    if (r.x < 0.0004 * t + 0.0003) { return vec2f(t, r.y); }
    t += r.x * 0.9;
    if (t > tb.y) { break; }
  }
  return vec2f(FAR, 0.0);
}
fn calcNormal(p: vec3f) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.0008;
  return normalize(e.xyy * sceneSdf(p + e.xyy).x + e.yyx * sceneSdf(p + e.yyx).x + e.yxy * sceneSdf(p + e.yxy).x + e.xxx * sceneSdf(p + e.xxx).x);
}
fn ambientOcc(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 1; i <= 5; i++) {
    let hh = 0.012 + 0.03 * f32(i);
    occ += (hh - sceneSdf(p + n * hh).x) * sca;
    sca *= 0.75;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}
fn softShadow(ro: vec3f, rd: vec3f) -> f32 {
  let tb = boxHit(ro, rd, look.bmin, look.bmax);
  if (tb.x > tb.y || tb.y < 0.0) { return 1.0; }
  var t = max(tb.x, 0.01);
  var res = 1.0;
  for (var i = 0; i < 48; i++) {
    let hh = sceneSdf(ro + rd * t).x;
    res = min(res, 12.0 * hh / t);
    if (res < 0.01 || t > tb.y) { break; }
    t += clamp(hh, 0.01, 0.2);
  }
  return clamp(res, 0.0, 1.0);
}

struct Mat { albedo: vec3f, rough: f32, metal: f32, coat: f32, emit: vec3f }
var<private> viewDist: f32 = 0.0;

fn carbonWeave(p: vec3f, n: vec3f) -> f32 {
  let an = abs(n);
  var uv = p.xy;
  if (an.x > an.y && an.x > an.z) { uv = p.yz; } else if (an.y > an.z) { uv = p.xz; }
  let g = uv * 75.0;
  let cell = floor(g);
  let f = fract(g);
  let twill = (i32(cell.x + cell.y * 2.0) & 3) < 2;
  let s = select(f.y, f.x, twill);
  let detail = clamp(1.6 - viewDist * 0.22, 0.0, 1.0);
  return 0.8 + (0.42 * sin(s * PI) * select(0.8, 1.0, twill) - 0.08) * detail;
}
fn carbonMat(p: vec3f, n: vec3f) -> Mat {
  return Mat(vec3f(0.028, 0.029, 0.032) * carbonWeave(p, n), 0.28, 0.0, 0.9, vec3f(0.0));
}
fn paintMat(c: vec3f) -> Mat { return Mat(c, 0.22, 0.0, 1.0, vec3f(0.0)); }

fn hash2(c: vec2f) -> f32 { return fract(sin(dot(c, vec2f(127.1, 311.7))) * 43758.5453); }
fn glossBlack() -> Mat { return Mat(vec3f(0.009, 0.0095, 0.011), 0.14, 0.0, 1.0, vec3f(0.0)); }
fn bodyAxisY(x: f32, b: f32) -> f32 {
  if (x < 1.26) { return mix(noseTipY(b), b + 0.36, clamp((x - noseStartX()) / (1.26 - noseStartX()), 0.0, 1.0)); }
  return b + mix(0.36, 0.42, clamp((x - 1.26) / 0.98, 0.0, 1.0));
}
fn sparkleField(p: vec3f, b: f32) -> f32 {
  let uv = vec2f(p.x * 10.0, (p.y - b) * 10.0 + p.z * 7.0);
  let cell = floor(uv);
  let r = hash2(cell);
  let f = fract(uv) - vec2f(0.5) - (vec2f(hash2(cell + 7.3), hash2(cell + 3.1)) - 0.5) * 0.4;
  let size = mix(0.55, 0.06, smoothstep(3.1, 4.5, p.x)) * step(0.25, r);
  let star = abs(f.x) * abs(f.y) * 30.0 + (abs(f.x) + abs(f.y)) * 0.6;
  return 1.0 - smoothstep(size * 0.8, size, star);
}
fn liveryBody(p: vec3f, n: vec3f, b: f32, silver: vec3f, teal: vec3f) -> Mat {
  if (p.z > 0.5 && p.x < 2.5 && p.y > b + 0.6) { return paintMat(teal); }
  let cy = bodyAxisY(p.x, b);
  let onChassis = p.x < 2.75 && p.z < 0.33 && p.y < b + 0.62;
  let edge = cy - 0.015 + 0.03 * smoothstep(0.4, 2.4, p.x);
  if (onChassis && p.x > 0.35 && abs(p.y - edge) < mix(0.010, 0.016, smoothstep(0.5, 2.0, p.x))) { return paintMat(teal); }
  if (onChassis && p.y > edge && p.x < 2.62 - (p.y - b - 0.42) * 0.6) { return Mat(silver, 0.38, 0.35, 0.8, vec3f(0.0)); }
  if (p.z > 0.2 && p.x > 2.35 && p.x < 4.4) {
    let t = clamp((p.x - 2.35) / 2.05, 0.0, 1.0);
    let line = b + 0.53 - 0.15 * (p.x - 2.45);
    if (abs(p.y - line) < mix(0.04, 0.007, t)) { return paintMat(teal); }
  }
  let onCover = p.x > 3.05 && p.x < 4.7 && p.y > b + 0.42 && p.z < 0.32;
  if (onCover && sparkleField(p, b) > 0.5) { return Mat(silver, 0.38, 0.35, 0.8, vec3f(0.0)); }
  return glossBlack();
}

// Cooling louvres painted onto the W17 bodywork: slots on the sidepod shoulders, plus gills on
// the engine cover when cooling is fully open.
fn louvres(p: vec3f, n: vec3f, mt: Mat) -> Mat {
  if (look.cooling == 0u) { return mt; }
  let open = look.cooling == 2u;
  let az = abs(p.z);
  var slot = 0.0;
  let x0 = select(3.35, 3.05, open);
  let x1 = select(3.85, 3.95, open);
  if (p.x > x0 && p.x < x1 && az > 0.16 && az < 0.48 && p.y > 0.45 && n.y > 0.55) {
    let f = fract(p.x / 0.045);
    slot = step(f, select(0.32, 0.55, open)) * smoothstep(0.16, 0.2, az) * (1.0 - smoothstep(0.44, 0.48, az));
  }
  if (open && p.x > 3.6 && p.x < 4.25 && az > 0.08 && az < 0.32 && p.y > 0.5 && p.y < 0.8 && abs(n.z) > 0.5) {
    slot = max(slot, step(fract(p.x / 0.05), 0.4) * smoothstep(0.52, 0.56, p.y) * (1.0 - smoothstep(0.74, 0.78, p.y)));
  }
  if (slot <= 0.0) { return mt; }
  return Mat(mix(mt.albedo, vec3f(0.004), slot), mix(mt.rough, 0.9, slot), mt.metal * (1.0 - slot), mt.coat * (1.0 - slot), mt.emit);
}

fn materialAt(m: f32, pw: vec3f, n: vec3f) -> Mat {
  let pAbs = vec3f(pw.x, pw.y, abs(pw.z));
  let p = select(pAbs, toBodyFrame(pAbs), look.isF1 != 0u);
  let b = shape.rideH;
  let accent = toLinear(look.accent);
  let paint = toLinear(look.paint);
  if (m < 0.5) {
    if (look.isF1 != 0u) { return liveryBody(p, n, b, paint, accent); }
    if (look.carbonBody != 0u) { return carbonMat(p, n); }
    return paintMat(paint);
  }
  if (m < 1.5) { return carbonMat(p, n); }
  if (m < 2.5) {
    let front = pAbs.x < 2.7;
    let c = select(rearWheel26(), frontWheel26(), front);
    let hw = select(RHW26, FHW26, front);
    let q = pAbs - c;
    let r = length(q.xy);
    let ang = atan2(q.y, q.x);
    var alb = vec3f(0.016, 0.016, 0.018);
    if (abs(q.z) > hw - 0.05) {
      let a = fract(ang / (2.0 * PI) * 2.0);
      let word = fract(a * 7.0) < 0.62 && (a < 0.42 || (a > 0.5 && a < 0.92));
      if (r > 0.291 && r < 0.313 && word) { alb = vec3f(0.24, 0.245, 0.25); }
      if (r > 0.321 && r < 0.326) { alb = vec3f(0.05); }
    }
    return Mat(alb, 0.82, 0.0, 0.0, vec3f(0.0));
  }
  if (m < 3.5) {
    let q = p - vec3f(2.67, b + 0.71, 0.0);
    if (p.x < 2.62 && q.y > -0.028 && q.y < 0.03) {
      let shift = smoothstep(-0.5, 0.6, n.y * 1.5 + q.z * 5.0);
      let tint = mix(mix(vec3f(0.05, 0.75, 0.95), vec3f(0.15, 0.25, 1.0), smoothstep(0.0, 0.5, shift)), vec3f(0.65, 0.15, 0.85), smoothstep(0.5, 1.0, shift));
      return Mat(tint, 0.05, 1.0, 1.0, tint * 0.22);
    }
    if ((abs(q.y + 0.032) < 0.005 || abs(q.y - 0.034) < 0.005) && p.x < 2.63) { return paintMat(vec3f(0.02)); }
    var alb = vec3f(0.06, 0.48, 0.80);
    let swoosh = q.y * 0.9 - q.x * 0.55;
    if (q.y < -0.07) { alb = vec3f(0.012, 0.014, 0.02); }
    else if (abs(swoosh + 0.015) < 0.018 && q.x > -0.04) { alb = vec3f(0.01, 0.03, 0.09); }
    else if (abs(swoosh + 0.04) < 0.005 && q.x > -0.02) { alb = accent; }
    if (q.y > 0.08 && p.z < 0.022) { alb = vec3f(0.01, 0.03, 0.09); }
    if (q.y > 0.08 && abs(p.z - 0.026) < 0.004) { alb = accent; }
    return Mat(alb, 0.16, 0.0, 1.0, vec3f(0.0));
  }
  if (m < 4.5) { return Mat(vec3f(0.05, 0.05, 0.055), 0.35, 0.3, 0.6, vec3f(0.0)); }
  if (m < 6.5) { return Mat(vec3f(0.55, 0.57, 0.60), 0.35, 0.0, 0.6, vec3f(0.0)); }
  if (m < 7.5) {
    let yw = 0.19 + b * 0.45;
    let endZ = frontWingSpan() - 0.01;
    if (p.z > endZ && p.y > yw + frontEndplateTop() - 0.035) { return paintMat(accent); }
    if (p.z > endZ) { return glossBlack(); }
    return carbonMat(p, n);
  }
  if (m < 8.5) {
    if (p.z > 0.495 && p.y > b + rearEndplateTop() - 0.06) { return paintMat(accent); }
    return carbonMat(p, n);
  }
  // On the W17 the shaded surfaces come from the mesh; the distance field is only seen in
  // reflections, where a neutral dark body (and the tyres below) stands in for the real paint.
  if (look.meshMode != 0u) { return Mat(vec3f(0.02, 0.021, 0.024), 0.3, 0.0, 0.8, vec3f(0.0)); }
  if (m > 11.5) { return Mat(vec3f(0.02, 0.021, 0.024), 0.3, 0.0, 0.8, vec3f(0.0)); }
  if (m < 9.5 && m > 8.5) {
    let front = pAbs.x < 2.7;
    let c = select(rearWheel26(), frontWheel26(), front);
    let q = pAbs - c;
    let spokes = 0.75 + 0.25 * smoothstep(0.2, 0.8, abs(sin(atan2(q.y, q.x) * 5.0)));
    if (length(q.xy) < 0.05) { return Mat(vec3f(0.035, 0.036, 0.04), 0.3, 0.8, 0.5, vec3f(0.0)); }
    return Mat(vec3f(0.07, 0.072, 0.08) * spokes, 0.32, 0.8, 0.4, vec3f(0.0));
  }
  if (m < 10.5) {
    let tint = mix(vec3f(0.55, 0.42, 0.25), vec3f(0.25, 0.30, 0.55), smoothstep(4.98, 5.12, p.x));
    return Mat(tint, 0.3, 1.0, 0.0, vec3f(0.0));
  }
  return Mat(vec3f(0.3, 0.0, 0.0), 0.2, 0.0, 1.0, vec3f(4.0, 0.12, 0.08));
}

fn shadeSurface(p: vec3f, n: vec3f, rd: vec3f, mt: Mat, fast: bool) -> vec3f {
  let key = normalize(KEY);
  var sh = 1.0;
  var ao = 1.0;
  let lift = select(0.004, 0.045, look.meshMode != 0u);
  if (!fast) { sh = softShadow(p + n * lift, key); ao = ambientOcc(p + n * (lift - 0.004), n); }
  let ndl = max(dot(n, key), 0.0);
  let fill = max(dot(n, normalize(vec3f(0.6, 0.35, -0.7))), 0.0) * 0.18 + max(dot(n, normalize(vec3f(0.6, 0.35, 0.7))), 0.0) * 0.18;
  let amb = (0.45 + 0.55 * n.y) * 0.22 * ao;
  let h = normalize(key - rd);
  let rough = mt.rough;
  let shin = mix(12.0, 900.0, (1.0 - rough) * (1.0 - rough));
  let f0 = mix(vec3f(0.04), mt.albedo, mt.metal);
  let nv = max(dot(n, -rd), 0.0);
  let fres = f0 + (vec3f(1.0) - f0) * pow(1.0 - nv, 5.0);
  let spec = pow(max(dot(n, h), 0.0), shin) * (shin + 8.0) / (8.0 * PI);
  let diffuse = mt.albedo * (1.0 - mt.metal);
  let refl = reflect(rd, n);
  let env = studioEnv(refl);
  var col = diffuse * (ndl * sh * 2.4 + fill + amb);
  col += fres * spec * ndl * sh * 1.6 * (1.0 - rough * 0.6);
  col += env * fres * ao * mix(1.0 - rough, 1.0, mt.metal) * 0.9;
  let coatF = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  col += env * coatF * mt.coat * ao * 0.8;
  col += mt.emit;
  return col;
}

fn domainMin() -> vec3f { return vec3f(grid.origin.x, 0.0, -(grid.origin.z + f32(grid.dims.z) * grid.h)); }
fn domainMax() -> vec3f { return grid.origin + vec3f(grid.dims) * grid.h; }

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) + cam.jitter;
  let rd = normalize(cam.fwd + ndc.x * cam.tanHalf * cam.aspect * cam.right + ndc.y * cam.tanHalf * cam.up);
  let ro = cam.pos;
  let key = normalize(KEY);

  var col = backdrop(rd);
  var tHit = FAR;
  var hit = vec2f(FAR, 0.0);
  var gN = vec4f(0.0);
  var gA = vec4f(0.0);
  var gM = vec4f(0.0);
  if (look.meshMode != 0u) {
    let gsz = vec2i(textureDimensions(gNormal));
    let gp = clamp(vec2i(uv * vec2f(gsz)), vec2i(0), gsz - vec2i(1));
    gN = textureLoad(gNormal, gp, 0);
    if (gN.w > 0.0) {
      hit = vec2f(gN.w, 12.0);
      gA = textureLoad(gAlbedo, gp, 0);
      gM = textureLoad(gMaterial, gp, 0);
    }
  } else {
    hit = march(ro, rd, 220);
  }
  var tGround = FAR;
  if (rd.y < -1e-4) { tGround = -ro.y / rd.y; }

  if (hit.x < tGround && hit.x < FAR) {
    let p = ro + rd * hit.x;
    viewDist = hit.x;
    var n: vec3f;
    var mt: Mat;
    if (look.meshMode != 0u) {
      n = normalize(gN.xyz);
      if (dot(n, rd) > 0.0) { n = -n; }
      mt = louvres(p, n, Mat(gA.rgb, gA.a, gM.x, gM.y, gA.rgb * gM.z));
    } else {
      n = calcNormal(p);
      mt = materialAt(hit.y, p, n);
    }
    if (look.surfMode == 1u) {
      // Thin, stacked wing elements sit in cells that are all solid at this grid size, so step
      // out along the normal until the probe reaches simulated air.
      var probe = p + n * grid.h * 0.8;
      var s = sampleFlow(probe);
      for (var k = 0; k < 4 && s.fluid <= 0.0; k++) {
        probe += n * grid.h;
        s = sampleFlow(probe);
      }
      if (s.fluid > 0.0) {
        let v = clamp(fieldValue(look.palette, s, probe), 0.0, 1.0);
        let iso = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.035, abs(fract(v * 14.0) - 0.5) - 0.44));
        mt = Mat(toLinear(palette(look.palette, v)) * iso, 0.55, 0.0, 0.25, vec3f(0.0));
      }
    }
    col = shadeSurface(p, n, rd, mt, false);
    tHit = hit.x;
  } else if (tGround < FAR) {
    let p = ro + rd * tGround;
    let up = vec3f(0.0, 1.0, 0.0);
    let pool = exp(-((p.x - 2.8) * (p.x - 2.8)) / 14.0 - (p.z * p.z) / 5.0);
    var gc = vec3f(0.006, 0.0065, 0.008) + vec3f(0.030, 0.032, 0.038) * pool;
    let belt = abs(p.z) < 1.15 && p.x > -0.6 && p.x < 6.2;
    if (belt) {
      let stripe = fract((p.x - cam.time * cam.roadSpeed) * 1.2);
      gc = gc * 0.75 + vec3f(0.006) * smoothstep(0.0, 0.08, stripe) * smoothstep(0.2, 0.12, stripe);
      gc += vec3f(0.05, 0.05, 0.055) * (1.0 - smoothstep(0.0, 0.012, abs(abs(p.z) - 1.15))) * pool;
    }
    let sh = softShadow(p + up * 0.005, key);
    let ao = clamp(sceneSdf(p).x * 2.6 + 0.12, 0.0, 1.0);
    col = gc * (0.35 + 0.65 * sh) * mix(0.25, 1.0, ao);
    let rdir = reflect(rd, up);
    let fres = 0.02 + 0.22 * pow(1.0 - abs(rd.y), 5.0);
    var refl = studioEnv(rdir) * 0.35;
    let rh = march(p + up * 0.002, rdir, 90);
    if (rh.x < FAR) {
      let rp = p + rdir * rh.x;
      let rn = calcNormal(rp);
      viewDist = tGround + rh.x;
      refl = shadeSurface(rp, rn, rdir, materialAt(rh.y, rp, rn), true) * exp(-rh.x * 2.2);
    }
    col += refl * fres * ao;
    let fogT = 1.0 - exp(-tGround * 0.03);
    col = mix(col, backdrop(rd), fogT);
    tHit = tGround;
  }

  if (look.sliceAxis > 0u && look.showFlow != 0u) {
    let axis = look.sliceAxis - 1u;
    let rdA = rd[axis];
    if (abs(rdA) > 1e-5) {
      let ts = (look.slicePos - ro[axis]) / rdA;
      if (ts > 0.0 && ts < tHit) {
        let p = ro + rd * ts;
        let lo = max(domainMin(), vec3f(-1.5, 0.0, -2.2)); let hi = min(domainMax(), vec3f(8.5, 2.6, 2.2));
        if (all(p >= lo) && all(p <= hi)) {
          let s = sampleFlow(p);
          if (s.fluid > 0.05) {
            let v = clamp(fieldValue(look.palette, s, p), 0.0, 1.0);
            let c = toLinear(palette(look.palette, v));
            let iso = abs(fract(v * 12.0) - 0.5);
            let contour = 1.0 - smoothstep(0.0, 0.06, iso) * 0.2;
            col = mix(col, c * 0.8 * contour, look.sliceAlpha);
            tHit = ts;
          }
        }
      }
    }
  }
  return vec4f(col, min(tHit, FAR));
}
`;

export const BLUR = /* wgsl */ `
struct Blur { dir: vec2f, spacing: f32, gain: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> blur: Blur;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sz = vec2i(textureDimensions(src));
  let base = uv * vec2f(sz);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var k = -6; k <= 6; k++) {
    let w = exp(-f32(k * k) / 14.0);
    let q = clamp(vec2i(base + blur.dir * f32(k) * blur.spacing), vec2i(0), sz - vec2i(1));
    acc += textureLoad(src, q, 0).rgb * w;
    wsum += w;
  }
  return vec4f(acc / wsum * blur.gain, 1.0);
}
`;

export const PRESENT = /* wgsl */ `
struct Post { bloom: f32, exposure: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var glow: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> post: Post;
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
fn bilinear(t: texture_2d<f32>, uv: vec2f) -> vec3f {
  let sz = vec2f(textureDimensions(t));
  let p = uv * sz - vec2f(0.5);
  let i0 = vec2i(floor(p));
  let f = p - vec2f(i0);
  let m = vec2i(sz) - vec2i(1);
  let a = textureLoad(t, clamp(i0, vec2i(0), m), 0).rgb;
  let b = textureLoad(t, clamp(i0 + vec2i(1, 0), vec2i(0), m), 0).rgb;
  let c = textureLoad(t, clamp(i0 + vec2i(0, 1), vec2i(0), m), 0).rgb;
  let d = textureLoad(t, clamp(i0 + vec2i(1, 1), vec2i(0), m), 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = bilinear(scene, uv);
  let gsz = vec2i(textureDimensions(glow));
  let g = textureLoad(glow, clamp(vec2i(uv * vec2f(gsz)), vec2i(0), gsz - vec2i(1)), 0).rgb;
  let bl = bilinear(bloomTex, uv);

  let hdr = c * post.exposure + g + bl * post.bloom;
  var o = pow(aces(hdr), vec3f(1.0 / 2.2));
  let d = uv - vec2f(0.5);
  o *= 1.0 - dot(d, d) * 0.6;
  return vec4f(o, 1.0);
}
`;

export const TAA = /* wgsl */ `
struct Taa {
  prevViewProj: mat4x4f,
  camPos: vec3f, tanHalf: f32,
  fwd: vec3f, aspect: f32,
  right: vec3f, blend: f32,
  up: vec3f, pad: f32,
}
@group(0) @binding(0) var cur: texture_2d<f32>;
@group(0) @binding(1) var hist: texture_2d<f32>;
@group(0) @binding(2) var<uniform> taa: Taa;
fn tm(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn itm(c: vec3f) -> vec3f { return c / max(1e-4, 1.0 - max(c.r, max(c.g, c.b))); }
fn histAt(uv: vec2f) -> vec4f {
  let sz = vec2f(textureDimensions(hist));
  let p = uv * sz - vec2f(0.5);
  let i0 = vec2i(floor(p));
  let f = p - vec2f(i0);
  let m = vec2i(sz) - vec2i(1);
  let a = textureLoad(hist, clamp(i0, vec2i(0), m), 0);
  let b = textureLoad(hist, clamp(i0 + vec2i(1, 0), vec2i(0), m), 0);
  let c = textureLoad(hist, clamp(i0 + vec2i(0, 1), vec2i(0), m), 0);
  let d = textureLoad(hist, clamp(i0 + vec2i(1, 1), vec2i(0), m), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sz = vec2i(textureDimensions(cur));
  let px = clamp(vec2i(uv * vec2f(sz)), vec2i(0), sz - vec2i(1));
  let c0 = textureLoad(cur, px, 0);
  var mu = vec3f(0.0);
  var m2 = vec3f(0.0);
  var closest = c0.a;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let s = textureLoad(cur, clamp(px + vec2i(i, j), vec2i(0), sz - vec2i(1)), 0);
      let t = tm(s.rgb);
      mu += t; m2 += t * t;
      closest = min(closest, s.a);
    }
  }
  mu /= 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3f(0.0)));
  let lo = mu - sigma * 1.25;
  let hi = mu + sigma * 1.25;

  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let rd = normalize(taa.fwd + ndc.x * taa.tanHalf * taa.aspect * taa.right + ndc.y * taa.tanHalf * taa.up);
  let wp = taa.camPos + rd * min(closest, 1.0e4);
  let clip = taa.prevViewProj * vec4f(wp, 1.0);
  let puv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  let valid = clip.w > 0.0 && all(puv >= vec2f(0.0)) && all(puv <= vec2f(1.0));

  let cur3 = tm(c0.rgb);
  var outc = cur3;
  if (valid && taa.blend < 1.0) {
    let h = clamp(tm(histAt(puv).rgb), lo, hi);
    let motion = length((puv - uv) * vec2f(sz));
    let w = clamp(taa.blend + motion * 0.04, taa.blend, 1.0);
    outc = mix(h, cur3, w);
  }
  return vec4f(itm(outc), c0.a);
}
`;

export const STREAM_SIM = GRID + /* wgsl */ `
struct Stream {
  lines: u32, steps: u32, seedMode: u32, colorMode: u32,
  seedMin: vec3f, rows: u32,
  seedMax: vec3f, cols: u32,
  stepLen: f32, time: f32, perEmitter: u32, emitters: u32,
}
struct Emitters { e: array<vec4f, 8> }
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<uniform> stream: Stream;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var<uniform> emitters: Emitters;
@group(0) @binding(4) var<storage, read> fields: array<vec4f>;
@group(0) @binding(5) var<storage, read> temps: array<f32>;
@group(0) @binding(6) var<storage, read_write> pts: array<vec4f>;
` + FIELD_SAMPLING + VIEW + /* wgsl */ `
fn seedOf(line: u32) -> vec3f {
  if (stream.seedMode == 1u) {
    let ei = min(line / stream.perEmitter, stream.emitters - 1u);
    let k = line % stream.perEmitter;
    let e = emitters.e[ei];
    let a = (f32(k) + 0.5) / f32(stream.perEmitter) * 6.2831853 + stream.time * 0.6;
    let ring = 0.35 + 0.65 * f32(k % 3u) / 2.0;
    return e.xyz + vec3f(0.0, cos(a), sin(a)) * e.w * ring;
  }
  let row = line / stream.cols;
  let col = line % stream.cols;
  let fy = (f32(row) + 0.5) / f32(stream.rows);
  let fz = (f32(col) + 0.5) / f32(stream.cols);
  return vec3f(stream.seedMin.x, mix(stream.seedMin.y, stream.seedMax.y, fy), mix(stream.seedMin.z, stream.seedMax.z, fz));
}
@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let line = gid.x;
  if (line >= stream.lines) { return; }
  let base = line * stream.steps;
  var p = seedOf(line);
  var alive = true;
  let hi = grid.origin + vec3f(grid.dims) * grid.h;
  for (var k = 0u; k < stream.steps; k++) {
    if (!alive) { pts[base + k] = vec4f(p, -1.0); continue; }
    let s1 = sampleFlow(p);
    if (s1.fluid < 0.3 || length(s1.u) < view.uIn * 0.03) {
      alive = false;
      pts[base + k] = vec4f(p, -1.0);
      continue;
    }
    pts[base + k] = vec4f(p, clamp(fieldValue(stream.colorMode, s1, p), 0.0, 1.0));
    let mid = p + normalize(s1.u) * stream.stepLen * 0.5;
    let s2 = sampleFlow(mid);
    var dir = s1.u;
    if (s2.fluid > 0.3) { dir = s2.u; }
    p += normalize(dir) * stream.stepLen;
    if (p.x > hi.x - grid.h * 3.0 || p.y < 0.01 || p.y > hi.y || abs(p.z) > hi.z) { alive = false; }
  }
}
`;

export const STREAM_DRAW = COLORMAPS + /* wgsl */ `
struct SDraw {
  viewProj: mat4x4f,
  camPos: vec3f, width: f32,
  res: vec2f, time: f32, intensity: f32,
  lines: u32, steps: u32, palette: u32, pulse: f32,
}
@group(0) @binding(0) var<uniform> sd: SDraw;
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;
@group(0) @binding(2) var scene: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) side: f32,
  @location(2) dist: f32,
}
fn hash1(n: u32) -> f32 {
  let s = n * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
}
@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var out: VOut;
  let segs = sd.steps - 1u;
  let seg = ii % segs;
  let lineAll = ii / segs;
  let mirror = lineAll >= sd.lines;
  let line = lineAll % sd.lines;
  var a = pts[line * sd.steps + seg];
  var b = pts[line * sd.steps + seg + 1u];
  if (a.w < 0.0 || b.w < 0.0) { out.pos = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  if (mirror) { a.z = -a.z; b.z = -b.z; }
  let ca = sd.viewProj * vec4f(a.xyz, 1.0);
  let cb = sd.viewProj * vec4f(b.xyz, 1.0);
  if (ca.w < 0.05 || cb.w < 0.05) { out.pos = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  let sa = ca.xy / ca.w * sd.res * 0.5;
  let sb = cb.xy / cb.w * sd.res * 0.5;
  var dir = sb - sa;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-4);
  let nrm = vec2f(-dir.y, dir.x);
  let corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let cn = corners[vi];
  let along = cn.x;
  let sp = mix(sa, sb, along) + nrm * cn.y * sd.width * 0.5 + dir * (along * 2.0 - 1.0) * sd.width * 0.3;
  let cw = mix(ca.w, cb.w, along);
  let cz = mix(ca.z / ca.w, cb.z / cb.w, along);
  out.pos = vec4f(sp / (sd.res * 0.5) * cw, cz * cw, cw);
  let t = f32(seg) + along;
  let phase = fract(t * 0.011 - sd.time * 0.42 + hash1(line * 7u + 3u));
  let pulse = pow(phase, 14.0) * sd.pulse;
  let fadeIn = smoothstep(0.0, 14.0, t);
  let fadeOut = 1.0 - smoothstep(f32(sd.steps) * 0.8, f32(sd.steps), t);
  let v = mix(a.w, b.w, along);
  out.color = palette(sd.palette, v) * sd.intensity * (0.55 + pulse) * fadeIn * fadeOut;
  out.side = cn.y;
  out.dist = distance(sd.camPos, mix(a.xyz, b.xyz, along));
  return out;
}
@fragment fn fs_main(v: VOut) -> @location(0) vec4f {
  let sz = vec2i(textureDimensions(scene));
  let px = clamp(vec2i(v.pos.xy / sd.res * vec2f(sz)), vec2i(0), sz - vec2i(1));
  if (v.dist > textureLoad(scene, px, 0).a + 0.02) { discard; }
  let a = 1.0 - v.side * v.side;
  return vec4f(v.color * a, a);
}
`;

export const MESH_DRAW = RIG_WGSL + /* wgsl */ `
struct MeshCam {
  viewProj: mat4x4f,
  camPos: vec3f, rideH: f32,
  jitter: vec2f, rake: f32, baseRide: f32,
}
struct MeshMat {
  color: vec4f,
  metal: f32, rough: f32, coat: f32, alphaCut: f32,
  emissive: f32, hasTex: f32, isBody: f32, firstIndex: u32,
}
@group(0) @binding(0) var<uniform> cam: MeshCam;
@group(0) @binding(1) var<uniform> mat: MeshMat;
@group(0) @binding(2) var<storage, read> verts: array<vec4f>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var albedoTex: texture_2d<f32>;
@group(0) @binding(5) var texSamp: sampler;
@group(0) @binding(6) var<uniform> rig: Rig;
@group(0) @binding(7) var<storage, read> vparts: array<u32>;

const FRONT_AXLE: f32 = 1.0;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

// Detached wings tumble away: they pitch over, climb and drift off, the two halves spreading.
fn flyPivot(assembly: u32) -> vec3f { return select(vec3f(4.85, 0.85, 0.0), vec3f(0.2, 0.28, 0.0), assembly == 1u); }
fn flySpin(assembly: u32, t: f32) -> f32 { return select(-5.5, 4.8, assembly == 1u) * t; }
fn flyAway(p: vec3f, n: vec3f, assembly: u32, t: f32) -> vec3f {
  let c = flyPivot(assembly);
  let a = flySpin(assembly, t);
  let d = p.xy - c.xy;
  let r = vec2f(cos(a) * d.x - sin(a) * d.y, sin(a) * d.x + cos(a) * d.y);
  // A quick pop upwards, then the wing tumbles back with the airflow.
  let up = 2.4 * sin(min(t, 1.0) * 1.5708) + 0.6 * t;
  let back = select(4.5, 3.0, assembly == 1u) * t * t;
  let drift = vec3f(back, up, 0.0);
  return vec3f(c.xy + r, p.z * (1.0 + 1.2 * t * t)) + drift;
}
fn flyNormal(n: vec3f, assembly: u32, t: f32) -> vec3f {
  let a = flySpin(assembly, t);
  return vec3f(cos(a) * n.x - sin(a) * n.y, sin(a) * n.x + cos(a) * n.y, n.z);
}

fn toWorld(p: vec3f) -> vec3f {
  if (mat.isBody == 0.0) { return p; }
  let c = cos(cam.rake); let s = sin(cam.rake);
  let bx = p.x - FRONT_AXLE; let by = p.y - cam.baseRide;
  return vec3f(FRONT_AXLE + c * bx - s * by, cam.rideH + s * bx + c * by, p.z);
}
fn rotateNormal(n: vec3f) -> vec3f {
  if (mat.isBody == 0.0) { return n; }
  let c = cos(cam.rake); let s = sin(cam.rake);
  return vec3f(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  let i = indices[mat.firstIndex + vi];
  let a = verts[i * 2u];
  let b = verts[i * 2u + 1u];
  let tag = (vparts[i / 4u] >> (8u * (i % 4u))) & 0xffu;
  let part = tag & 7u;
  let assembly = tag >> 3u;
  var p = a.xyz;
  var nrm = b.xyz;
  if (part != 0u) {
    nrm = rigRotateDir(nrm, part, p.z);
    p = rigRotate(p, part, 1.0);
  } else if (assembly == 0u && mat.isBody > 0.5) {
    p = podDeform(p, 1.0);
  }
  var hidden = false;
  if (assembly != 0u) {
    let t = select(rig.fly.y, rig.fly.x, assembly == 1u);
    if (t > 0.0) {
      let fly = flyAway(p, nrm, assembly, t);
      p = fly.xyz;
      nrm = flyNormal(nrm, assembly, t);
      hidden = t >= 0.999;
    }
  }
  let w = toWorld(p);
  var out: VOut;
  var clip = cam.viewProj * vec4f(w, 1.0);
  clip = vec4f(clip.xy + cam.jitter * clip.w, clip.zw);
  out.pos = select(clip, vec4f(2.0, 2.0, 2.0, 1.0), hidden);
  out.world = w;
  out.normal = rotateNormal(nrm);
  out.uv = vec2f(a.w, b.w);
  return out;
}

struct GOut {
  @location(0) albedo: vec4f,
  @location(1) normalDist: vec4f,
  @location(2) material: vec4f,
}

@fragment fn fs_main(v: VOut) -> GOut {
  var c = mat.color;
  if (mat.hasTex > 0.5) { c *= textureSample(albedoTex, texSamp, v.uv); }
  if (c.a < mat.alphaCut) { discard; }
  var out: GOut;
  out.albedo = vec4f(c.rgb, select(mat.rough, c.a, mat.alphaCut > 0.0));
  out.normalDist = vec4f(normalize(v.normal), distance(v.world, cam.camPos));
  out.material = vec4f(mat.metal, mat.coat, mat.emissive, 1.0);
  return out;
}
`;
