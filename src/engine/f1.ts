// Signed distance model of a generic Formula 1 car built to the 2026 technical regulations
// (3.40 m wheelbase, 1.90 m width, narrower tyres, no beam wing, active aero flaps).
// Units are meters: x points downstream (nose at x≈0), y up (ground at 0), z lateral.
// Bodywork is authored in a "legacy" frame (3.60 m wheelbase, 2.0 m width) and mapped into the
// 2026 envelope by toBodyFrame(); wheels are evaluated directly in world space.
// Material ids: 0 paint, 1 carbon, 2 tyre, 3 helmet, 4 halo, 7 front wing, 8 rear wing,
// 9 wheel cover, 10 titanium (exhaust, brake ducts), 11 rain light.

export const F1_CONSTANTS = {
  frontAxleX: 1.0,
  rearAxleX: 4.4,
  wheelRadius: 0.355,
  bodyStretch: 3.4 / 3.6,
  bodyWidth: 0.96,
  rearOffset: -0.2,
};

import { RIG_WGSL } from "./car-model";

export const SDF_F1 = RIG_WGSL + /* wgsl */ `
const DEG: f32 = 0.017453292;
const FA: f32 = 1.0;
const RA: f32 = 4.6;
const WR: f32 = 0.36;
const FWZ: f32 = 0.84;
const FHW: f32 = 0.152;
const RWZ: f32 = 0.80;
const RHW: f32 = 0.20;
const RA26: f32 = 4.4;
const WR26: f32 = 0.355;
const FHW26: f32 = 0.14;
const RHW26: f32 = 0.1875;
const BODY_X: f32 = 0.9444444;
const BODY_Z: f32 = 0.96;
const BODY_LIP: f32 = 0.96;

fn rakeAngle() -> f32 { return atan((shape.rearRide - shape.rideH) / (RA26 - FA)); }
fn toBodyFrame(pw: vec3f) -> vec3f {
  let th = rakeAngle();
  let c = cos(th); let s = sin(th);
  let dx = pw.x - FA; let dy = pw.y - shape.rideH;
  let p = vec3f(FA + dx * c + dy * s, shape.rideH - dx * s + dy * c, pw.z);
  var x = p.x;
  if (x > FA) { x = select(FA + (x - FA) / BODY_X, x + (RA - RA26), x > RA26); }
  return vec3f(x, p.y, p.z / BODY_Z);
}
fn frontWheel26() -> vec3f { return vec3f(FA, WR26, FWZ * BODY_Z); }
fn rearWheel26() -> vec3f { return vec3f(RA26, WR26, RWZ * BODY_Z); }

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
fn smax(a: f32, b: f32, k: f32) -> f32 { return -smin(-a, -b, k); }
fn sdEllipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}
fn sdCylZ(p: vec3f, r: f32, hz: f32) -> f32 {
  let d = vec2f(length(p.xy) - r, abs(p.z) - hz);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}
// Wing element whose leading edge rises (or drops) and whose chord tapers towards the outer tip.
fn sdWingZ(p: vec3f, le: vec2f, chord: f32, ang: f32, thick: f32, z0: f32, z1: f32, rise: f32, taper: f32, curl: f32) -> f32 {
  let s = smoothstep(curl, z1, p.z);
  return sdWing(p, le + vec2f(0.0, rise * s), chord * (1.0 - taper * s), ang + rise * s * 0.6, thick, z0, z1) * 0.85;
}

fn tunnelRoof(x: f32, b: f32) -> f32 {
  if (x < 2.5) { return mix(b + 0.12, b + 0.05, smoothstep(1.55, 2.5, x)); }
  if (x < 3.8) { return b + 0.05; }
  return mix(b + 0.05, b + 0.25, smoothstep(3.8, 4.98, x));
}

fn sdFloor(p: vec3f, b: f32) -> f32 {
  let roof = tunnelRoof(p.x, b);
  let zLim = mix(0.80, 0.58, smoothstep(3.6, 4.15, p.x));
  let top = select(b + 0.05, roof + 0.03, abs(p.z - 0.40) < 0.28);
  let slab = max(max(b - p.y, p.y - top), max(abs(p.x - 3.265) - 1.715, p.z - zLim));
  let tunnel = max(p.y - roof, abs(p.z - 0.40) - 0.255);
  var d = max(slab, -tunnel) * 0.8;
  for (var i = 0; i < 2; i++) {
    let fz = 0.26 + f32(i) * 0.16;
    let fence = sdBox(p - vec3f(1.84, b + 0.08, fz), vec3f(0.28, 0.08, 0.012));
    d = min(d, max(fence, p.y - roof - 0.02));
  }
  for (var i = 0; i < 2; i++) {
    let sz = 0.30 + f32(i) * 0.20;
    let strake = sdBox(p - vec3f(4.62, b + 0.17, sz), vec3f(0.34, 0.17, 0.008));
    d = min(d, max(strake, p.y - roof));
  }
  d = min(d, sdCapsule(p, vec3f(2.25, b + 0.065, 0.79), vec3f(3.85, b + 0.05, 0.78), 0.02));
  return d;
}

fn sdTyre(p: vec3f, c: vec3f, hw: f32) -> f32 {
  let q = p - c;
  return sdRoundRect(vec2f(length(q.xy) - 0.2925, q.z), vec2f(0.0625, hw), 0.06);
}
fn sdWheelCover(p: vec3f, c: vec3f, hw: f32) -> f32 {
  let q = p - c;
  var d = sdCylZ(q, 0.234, hw - 0.028);
  d = min(d, sdCylZ(q - vec3f(0.0, 0.0, hw - 0.02), 0.045, 0.02));
  return d;
}

fn sdWheelSet(p: vec3f, res0: vec2f, c: vec3f, hw: f32, inboard: f32) -> vec2f {
  var res = res0;
  if (sdBox(p - c, vec3f(WR26 + 0.02, WR26 + 0.02, hw + 0.2)) > res.x) { return res; }
  res = opU(res, vec2f(sdTyre(p, c, hw), 2.0));
  res = opU(res, vec2f(sdWheelCover(p, c, hw), 9.0));
  let duct = sdCylZ(p - vec3f(c.x, c.y, c.z - hw - inboard * 0.5), 0.17, inboard * 0.5);
  let ductWing = sdRoundBox(p - vec3f(c.x - 0.04, c.y + 0.21, c.z - hw - 0.05), vec3f(0.16, 0.012, 0.05), 0.006);
  res = opU(res, vec2f(min(duct, ductWing), 10.0));
  return res;
}

fn sdSuspension(p: vec3f, b: f32) -> f32 {
  var d = sdCapsule(p, vec3f(1.10, b + 0.43, 0.17), vec3f(FA + 0.02, WR + 0.16, FWZ - FHW - 0.05), 0.017);
  d = min(d, sdCapsule(p, vec3f(1.42, b + 0.40, 0.17), vec3f(FA + 0.02, WR + 0.16, FWZ - FHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(0.98, b + 0.19, 0.15), vec3f(FA, WR - 0.13, FWZ - FHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(1.38, b + 0.17, 0.15), vec3f(FA, WR - 0.13, FWZ - FHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(FA + 0.03, WR - 0.10, FWZ - FHW - 0.07), vec3f(1.20, b + 0.47, 0.16), 0.014));
  d = min(d, sdCapsule(p, vec3f(0.86, b + 0.29, 0.16), vec3f(0.88, WR + 0.02, FWZ - FHW - 0.05), 0.013));
  d = min(d, sdCapsule(p, vec3f(4.30, b + 0.42, 0.20), vec3f(RA, WR + 0.17, RWZ - RHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(4.78, b + 0.40, 0.16), vec3f(RA, WR + 0.17, RWZ - RHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(4.28, b + 0.16, 0.24), vec3f(RA, WR - 0.14, RWZ - RHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(4.82, b + 0.15, 0.18), vec3f(RA, WR - 0.14, RWZ - RHW - 0.05), 0.017));
  d = min(d, sdCapsule(p, vec3f(RA - 0.03, WR + 0.14, RWZ - RHW - 0.07), vec3f(4.40, b + 0.18, 0.22), 0.014));
  return d;
}

fn noseTipY(b: f32) -> f32 { return b + select(0.17, 0.25, u32(shape.nose + 0.5) == 2u); }
fn noseStartX() -> f32 { return select(0.10, 0.34, u32(shape.nose + 0.5) == 1u); }

fn sdNose(p: vec3f, b: f32) -> f32 {
  let v = u32(shape.nose + 0.5);
  let x0 = noseStartX();
  let y0 = noseTipY(b);
  var s0 = vec2f(0.055, 0.11);
  if (v == 1u) { s0 = vec2f(0.075, 0.15); }
  if (v == 2u) { s0 = vec2f(0.045, 0.075); }
  var d = sdTaper(p, x0, 1.26, vec2f(y0, 0.0), vec2f(b + 0.36, 0.0), s0, vec2f(0.15, 0.17), 0.04, 0.12);
  d = smin(d, sdEllipsoid(p - vec3f(x0 + 0.02, y0, 0.0), vec3f(0.09, s0.x, s0.y)), 0.04);
  if (v != 0u) {
    let yw = 0.19 + b * 0.45;
    let pylon = sdRoundBox(p - vec3f(x0 + 0.06, 0.5 * (yw + y0), 0.09), vec3f(0.09, 0.5 * (y0 - yw) + 0.02, 0.006), 0.004);
    d = min(d, pylon);
  }
  return d;
}

fn sdEngineCover(p: vec3f, b: f32) -> f32 {
  let v = u32(shape.cover + 0.5);
  if (v == 1u) { return sdTaper(p, 2.96, 4.86, vec2f(b + 0.60, 0.0), vec2f(b + 0.40, 0.0), vec2f(0.32, 0.31), vec2f(0.12, 0.13), 0.15, 0.08); }
  if (v == 2u) { return sdTaper(p, 2.96, 4.70, vec2f(b + 0.57, 0.0), vec2f(b + 0.34, 0.0), vec2f(0.29, 0.19), vec2f(0.06, 0.05), 0.12, 0.04); }
  return sdTaper(p, 2.96, 4.86, vec2f(b + 0.58, 0.0), vec2f(b + 0.36, 0.0), vec2f(0.30, 0.24), vec2f(0.08, 0.07), 0.14, 0.06);
}

fn sdSidepods(p: vec3f, b: f32) -> f32 {
  let v = u32(shape.sidepod + 0.5);
  var pod: f32;
  if (v == 1u) {
    pod = sdTaper(p, 2.30, 4.05, vec2f(b + 0.40, 0.36), vec2f(b + 0.24, 0.24), vec2f(0.16, 0.08), vec2f(0.07, 0.05), 0.06, 0.04);
    pod = smax(pod, -sdRoundBox(p - vec3f(2.27, b + 0.42, 0.38), vec3f(0.06, 0.12, 0.05), 0.03), 0.02);
    return pod;
  }
  if (v == 2u) {
    pod = sdTaper(p, 2.30, 4.25, vec2f(b + 0.41, 0.52), vec2f(b + 0.24, 0.30), vec2f(0.18, 0.28), vec2f(0.08, 0.11), 0.10, 0.05);
    pod = smax(pod, -sdCapsule(p, vec3f(2.30, b + 0.13, 0.84), vec3f(3.70, b + 0.08, 0.58), 0.15), 0.05);
    pod = smax(pod, -sdCapsule(p, vec3f(2.55, b + 0.66, 0.52), vec3f(4.00, b + 0.40, 0.36), 0.11), 0.04);
    pod = smax(pod, -sdRoundBox(p - vec3f(2.28, b + 0.47, 0.57), vec3f(0.06, 0.10, 0.17), 0.05), 0.02);
    return pod;
  }
  if (v == 3u) {
    pod = sdTaper(p, 2.30, 4.25, vec2f(b + 0.47, 0.52), vec2f(b + 0.26, 0.28), vec2f(0.15, 0.25), vec2f(0.07, 0.10), 0.12, 0.05);
    pod = smax(pod, -sdCapsule(p, vec3f(2.25, b + 0.17, 0.86), vec3f(3.70, b + 0.10, 0.56), 0.22), 0.05);
    pod = smax(pod, -sdRoundBox(p - vec3f(2.28, b + 0.52, 0.55), vec3f(0.06, 0.07, 0.17), 0.04), 0.02);
    return pod;
  }
  pod = sdTaper(p, 2.30, 4.25, vec2f(b + 0.41, 0.52), vec2f(b + 0.22, 0.28), vec2f(0.18, 0.25), vec2f(0.07, 0.10), 0.12, 0.05);
  pod = smax(pod, -sdCapsule(p, vec3f(2.30, b + 0.13, 0.82), vec3f(3.70, b + 0.08, 0.56), 0.16), 0.05);
  pod = smax(pod, -sdRoundBox(p - vec3f(2.28, b + 0.47, 0.57), vec3f(0.06, 0.10, 0.17), 0.05), 0.02);
  return pod;
}

fn sdBodywork(p: vec3f, b: f32) -> f32 {
  var d = sdNose(p, b);
  d = smin(d, sdTaper(p, 1.20, 2.24, vec2f(b + 0.36, 0.0), vec2f(b + 0.42, 0.0), vec2f(0.15, 0.17), vec2f(0.25, 0.29), 0.12, 0.16), 0.08);
  d = smin(d, sdTaper(p, 2.20, 3.06, vec2f(b + 0.42, 0.0), vec2f(b + 0.42, 0.0), vec2f(0.25, 0.30), vec2f(0.25, 0.34), 0.16, 0.16), 0.06);
  d = smin(d, sdEngineCover(p, b), 0.10);

  let keel = sdTaper(p, 1.30, 4.70, vec2f(b + 0.22, 0.0), vec2f(b + 0.20, 0.0), vec2f(0.19, 0.19), vec2f(0.17, 0.14), 0.06, 0.05);
  d = smin(d, keel, 0.08);

  d = smin(d, sdSidepods(p, b), 0.12);

  var airbox = sdRoundBox(p - vec3f(3.02, b + 0.84, 0.0), vec3f(0.17, 0.11, 0.12), 0.08);
  airbox = smax(airbox, -sdEllipsoid(p - vec3f(2.85, b + 0.86, 0.0), vec3f(0.09, 0.066, 0.078)), 0.015);
  d = smin(d, airbox, 0.10);

  d = smax(d, -sdRoundBox(p - vec3f(2.62, b + 0.72, 0.0), vec3f(0.42, 0.13, 0.215), 0.10), 0.03);
  return d;
}

fn sdHalo(p: vec3f, b: f32) -> f32 {
  var d = sdCapsule(p, vec3f(2.17, b + 0.62, 0.0), vec3f(2.36, b + 0.90, 0.0), 0.034);
  d = smin(d, sdCapsule(p, vec3f(2.36, b + 0.90, 0.0), vec3f(2.52, b + 0.92, 0.20), 0.031), 0.03);
  d = smin(d, sdCapsule(p, vec3f(2.52, b + 0.92, 0.20), vec3f(2.82, b + 0.88, 0.26), 0.031), 0.03);
  d = smin(d, sdCapsule(p, vec3f(2.82, b + 0.88, 0.26), vec3f(3.02, b + 0.74, 0.25), 0.033), 0.03);
  return d;
}

fn frontWingSpan() -> f32 { return 0.94; }
fn rearEndplateTop() -> f32 {
  let tops = array<f32, 3>(1.06, 1.10, 1.02);
  return tops[min(u32(shape.rearWing + 0.5), 2u)];
}
fn frontEndplateTop() -> f32 {
  let tops = array<f32, 4>(0.20, 0.37, 0.16, 0.135);
  return tops[min(u32(shape.frontWing + 0.5), 3u)];
}

fn sdFrontWing(p: vec3f, yw: f32) -> f32 {
  let ff = shape.frontFlap;
  let v = u32(shape.frontWing + 0.5);
  var d = 1e3;
  var ep = 0.0;
  if (v == 1u) {
    d = sdWingZ(p, vec2f(-0.03, yw), 0.31, 2.0 * DEG + ff * 0.1, 0.034, 0.0, 0.94, 0.03, 0.2, 0.5);
    d = min(d, sdWingZ(p, vec2f(0.21, yw + 0.036), 0.17, 9.0 * DEG + ff * 0.45, 0.024, 0.0, 0.94, 0.15, 0.35, 0.3));
    d = min(d, sdWingZ(p, vec2f(0.335, yw + 0.075 + ff * 0.03), 0.14, 17.0 * DEG + ff * 0.75, 0.020, 0.10, 0.94, 0.19, 0.35, 0.25));
    d = min(d, sdWingZ(p, vec2f(0.425, yw + 0.118 + ff * 0.07), 0.12, 26.0 * DEG + ff, 0.018, 0.12, 0.94, 0.22, 0.4, 0.25));
    ep = sdRoundRect(vec2f(p.x - 0.25, p.y - (yw + 0.17)), vec2f(0.29, 0.20), 0.08);
  } else if (v == 2u) {
    d = sdWingZ(p, vec2f(-0.03, yw), 0.31, 3.0 * DEG + ff * 0.1, 0.034, 0.0, 0.94, -0.02, 0.15, 0.55);
    d = min(d, sdWingZ(p, vec2f(0.21, yw + 0.04), 0.19, 13.0 * DEG + ff * 0.45, 0.024, 0.0, 0.94, -0.04, 0.35, 0.35));
    d = min(d, sdWingZ(p, vec2f(0.35, yw + 0.085 + ff * 0.03), 0.16, 22.0 * DEG + ff * 0.75, 0.020, 0.06, 0.94, -0.06, 0.4, 0.35));
    d = min(d, sdWingZ(p, vec2f(0.45, yw + 0.13 + ff * 0.07), 0.13, 31.0 * DEG + ff, 0.018, 0.08, 0.94, -0.08, 0.45, 0.35));
    ep = sdRoundRect(vec2f(p.x - 0.25, p.y - (yw + 0.06)), vec2f(0.29, 0.10), 0.06);
  } else if (v == 3u) {
    d = sdWingZ(p, vec2f(-0.03, yw), 0.30, 1.0 * DEG + ff * 0.05, 0.030, 0.0, 0.94, 0.0, 0.1, 0.6);
    d = min(d, sdWingZ(p, vec2f(0.20, yw + 0.03), 0.16, 4.0 * DEG + ff * 0.3, 0.022, 0.0, 0.94, 0.02, 0.2, 0.5));
    ep = sdRoundRect(vec2f(p.x - 0.22, p.y - (yw + 0.05)), vec2f(0.26, 0.085), 0.05);
  } else {
    d = sdWingZ(p, vec2f(-0.03, yw), 0.31, 2.0 * DEG + ff * 0.1, 0.034, 0.0, 0.94, 0.06, 0.2, 0.5);
    d = min(d, sdWingZ(p, vec2f(0.21, yw + 0.036), 0.17, 9.0 * DEG + ff * 0.45, 0.024, 0.0, 0.94, 0.09, 0.25, 0.45));
    d = min(d, sdWingZ(p, vec2f(0.335, yw + 0.075 + ff * 0.03), 0.14, 17.0 * DEG + ff * 0.75, 0.020, 0.10, 0.94, 0.11, 0.25, 0.4));
    d = min(d, sdWingZ(p, vec2f(0.425, yw + 0.118 + ff * 0.07), 0.12, 26.0 * DEG + ff, 0.018, 0.12, 0.94, 0.13, 0.25, 0.4));
    ep = sdRoundRect(vec2f(p.x - 0.25, p.y - (yw + 0.085)), vec2f(0.29, 0.115), 0.07);
  }
  let span = frontWingSpan();
  d = min(d, max(ep, abs(p.z - (span + 0.012)) - 0.010));
  d = min(d, sdRoundBox(p - vec3f(0.22, yw - 0.008, span - 0.04), vec3f(0.30, 0.006, 0.06), 0.004));
  return d;
}

fn sdRearWing(p: vec3f, b: f32, yr: f32) -> f32 {
  let v = u32(shape.rearWing + 0.5);
  var chordM = 0.36; var angM = shape.rearMain; var riseM = -0.10;
  var chordF = 0.26; var angF = shape.rearFlap;
  var epH = vec2f(0.33, 0.29);
  if (v == 1u) {
    chordM = 0.42; angM += 3.0 * DEG; riseM = -0.15;
    chordF = 0.32; angF += 6.0 * DEG;
    epH = vec2f(0.36, 0.33);
  } else if (v == 2u) {
    chordM = 0.27; angM -= 5.0 * DEG; riseM = 0.02;
    chordF = 0.15; angF *= 0.55;
    epH = vec2f(0.30, 0.25);
  }
  var d = sdWingZ(p, vec2f(4.98, yr), chordM, angM, 0.05, 0.0, 0.50, riseM, 0.12, 0.22);
  let te = vec2f(4.98, yr) + vec2f(cos(angM), sin(angM)) * (chordM - 0.01) + vec2f(-0.03, 0.035);
  d = min(d, sdWingZ(p, te, chordF, angF, 0.03, 0.0, 0.49, riseM * 0.8, 0.10, 0.28));
  d = min(d, sdCapsule(p, vec3f(5.26, yr + 0.05, 0.0), vec3f(5.30, yr + 0.12, 0.0), 0.024));
  let ep = sdRoundRect(vec2f(p.x - 5.25, p.y - (yr - 0.03)), epH, 0.13);
  d = min(d, max(ep, abs(p.z - 0.513) - 0.012));
  d = min(d, sdRoundBox(p - vec3f(5.09, 0.5 * (b + 0.36 + yr + 0.06), 0.06), vec3f(0.07, 0.5 * (yr + 0.06 - b - 0.36), 0.008), 0.006));
  return d;
}

fn sdF1(pw: vec3f) -> vec2f {
  let pworld = vec3f(pw.x, pw.y, abs(pw.z));
  let p = toBodyFrame(pworld);
  let b = shape.rideH;
  let yw = 0.19 + b * 0.45;
  let yr = b + 0.80;

  var res = vec2f(1e3, 0.0);
  if (sdBox(p - vec3f(2.72, b + 0.52, 0.0), vec3f(2.74, 0.62, 0.95)) < res.x) {
    res = opU(res, vec2f(sdBodywork(p, b), 0.0));
    res = opU(res, vec2f(sdEllipsoid(p - vec3f(2.67, b + 0.71, 0.0), vec3f(0.15, 0.13, 0.12)), 3.0));
    res = opU(res, vec2f(sdHalo(p, b), 4.0));
    var mirror = sdRoundBox(p - vec3f(2.32, b + 0.67, 0.60), vec3f(0.035, 0.035, 0.085), 0.02);
    mirror = min(mirror, sdCapsule(p, vec3f(2.36, b + 0.66, 0.53), vec3f(2.45, b + 0.50, 0.46), 0.011));
    res = opU(res, vec2f(mirror, 0.0));
    var carbon = sdSuspension(p, b);
    carbon = min(carbon, sdTaper(p, 4.78, 5.40, vec2f(b + 0.33, 0.0), vec2f(b + 0.33, 0.0), vec2f(0.07, 0.065), vec2f(0.045, 0.045), 0.04, 0.03));
    carbon = min(carbon, sdRoundBox(p - vec3f(3.95, b + 0.74, 0.0), vec3f(0.55, 0.10, 0.008), 0.006));
    res = opU(res, vec2f(carbon, 1.0));
    res = opU(res, vec2f(sdRoundBox(p - vec3f(5.405, b + 0.33, 0.0), vec3f(0.012, 0.028, 0.05), 0.006), 11.0));
    var exhaust = sdCapsule(p, vec3f(4.95, b + 0.44, 0.0), vec3f(5.13, b + 0.45, 0.0), 0.042);
    exhaust = max(exhaust, -sdCapsule(p, vec3f(5.0, b + 0.44, 0.0), vec3f(5.2, b + 0.45, 0.0), 0.028));
    res = opU(res, vec2f(exhaust, 10.0));
  }
  if (sdBox(p - vec3f(3.26, b + 0.2, 0.4), vec3f(1.75, 0.22, 0.42)) < res.x) {
    res = opU(res, vec2f(sdFloor(p, b), 1.0));
  }
  res.x *= BODY_LIP * BODY_X;
  if (sdBox(p - vec3f(0.24, yw + 0.17, 0.48), vec3f(0.36, 0.34, 0.50)) < res.x / (BODY_LIP * BODY_X)) {
    res = opU(res, vec2f(sdFrontWing(p, yw) * BODY_LIP * BODY_X, 7.0));
  }
  if (sdBox(p - vec3f(5.20, b + 0.64, 0.27), vec3f(0.46, 0.56, 0.29)) < res.x / (BODY_LIP * BODY_X)) {
    res = opU(res, vec2f(sdRearWing(p, b, yr) * BODY_LIP * BODY_X, 8.0));
  }
  res = sdWheelSet(pworld, res, frontWheel26(), FHW26, 0.10);
  res = sdWheelSet(pworld, res, rearWheel26(), RHW26, 0.08);
  return res;
}

const W17_ORIGIN: vec3f = vec3f(-0.3, 0.0, 0.0);
const W17_H: f32 = 0.015;
const W17_DIMS: vec3f = vec3f(368.0, 84.0, 67.0);
const W17_BASE_RIDE: f32 = 0.092;
const W17_FRONT: vec3f = vec3f(1.0, 0.36, 0.779);
const W17_REAR: vec3f = vec3f(4.4, 0.351, 0.737);

fn w17BodyFrame(pw: vec3f) -> vec3f {
  let th = rakeAngle();
  let c = cos(th); let s = sin(th);
  let dx = pw.x - FA; let dy = pw.y - shape.rideH;
  return vec3f(FA + dx * c + dy * s, W17_BASE_RIDE - dx * s + dy * c, pw.z);
}
fn sdW17Body(p: vec3f) -> f32 {
  let ext = W17_DIMS * W17_H;
  let box = sdBox(p - (W17_ORIGIN + ext * 0.5), ext * 0.5);
  if (box > 0.0) { return box + 0.07; }
  let uvw = ((p - W17_ORIGIN) / W17_H + vec3f(0.5)) / W17_DIMS;
  return textureSampleLevel(carSdf, carSamp, uvw, 0.0).x;
}
fn sdW17Part(pb: vec3f, part: u32) -> f32 {
  let g0 = rig.grids[(part - 1u) * 2u];
  let g1 = rig.grids[(part - 1u) * 2u + 1u];
  let q = rigRotate(pb, part, -1.0);
  let ext = (g1.xyz - vec3f(1.0)) * g0.w;
  let box = sdBox(q - (g0.xyz + ext * 0.5), ext * 0.5);
  if (box > 0.0) { return box + 0.03; }
  let cell = (q - g0.xyz) / g0.w;
  let atlas = vec3f(textureDimensions(carParts));
  let uvw = vec3f(cell.x + 0.5, cell.y + 0.5, cell.z + g1.w + 0.5) / atlas;
  return textureSampleLevel(carParts, carSamp, uvw, 0.0).x * min(rigScale(part), 1.0);
}
fn sdW17(pw: vec3f) -> vec2f {
  let pa = vec3f(pw.x, pw.y, abs(pw.z));
  let p = w17BodyFrame(pa);
  let squeeze = 1.0 - rig.extra.z * podWeight(p);
  var res = vec2f(sdW17Body(podDeform(p, -1.0)) * 0.95 * squeeze, 12.0);
  if (rig.fly.z > 0.5 && p.x < 0.85 && p.y < 0.6) {
    res = opU(res, vec2f(min(min(sdW17Part(p, 1u), sdW17Part(p, 2u)), sdW17Part(p, 5u)) * 0.95, 7.0));
  }
  if (rig.fly.w > 0.5 && p.x > 4.4 && p.y > 0.5) {
    res = opU(res, vec2f(min(min(sdW17Part(p, 3u), sdW17Part(p, 4u)), sdW17Part(p, 6u)) * 0.95, 8.0));
  }
  res = opU(res, vec2f(min(sdTyre(pa, W17_FRONT, 0.175), sdCylZ(pa - W17_FRONT, 0.234, 0.15)), 2.0));
  res = opU(res, vec2f(min(sdTyre(pa, W17_REAR, 0.205), sdCylZ(pa - W17_REAR, 0.234, 0.18)), 2.0));
  return res;
}

// Cooling ducts through the W17 sidepods, carved out of the tunnel geometry only (the render
// keeps the closed mesh): air enters at the sidepod inlet and leaves at the coke-bottle exit.
// shape.duct scales them with the cooling setting (0 = closed bodywork).
fn w17Duct(pw: vec3f) -> f32 {
  if (shape.duct <= 0.0) { return 1e3; }
  let p = podDeform(w17BodyFrame(vec3f(pw.x, pw.y, abs(pw.z))), -1.0);
  let k = shape.duct;
  let mouth = sdCapsule(p, vec3f(2.05, 0.52, 0.58), vec3f(3.0, 0.50, 0.48), 0.09 * k);
  let main = sdCapsule(p, vec3f(2.05, 0.55, 0.47), vec3f(3.25, 0.46, 0.43), 0.1 * k);
  let exit = sdCapsule(p, vec3f(3.25, 0.46, 0.43), vec3f(4.1, 0.40, 0.32), 0.085 * k);
  return min(min(mouth, main), exit);
}

// Heat sources on the W17: brake discs inside the wheels, the exhaust above the crash structure,
// and the cooling exits at the back of the sidepods and the engine cover.
fn w17Emission(pw: vec3f) -> f32 {
  let pa = vec3f(pw.x, pw.y, abs(pw.z));
  let p = w17BodyFrame(pa);
  var e = 0.0;
  if (length(pa.xy - W17_FRONT.xy) < 0.2 && abs(pa.z - (W17_FRONT.z - 0.215)) < 0.1) { e = max(e, shape.heatBrakes); }
  if (length(pa.xy - W17_REAR.xy) < 0.2 && abs(pa.z - (W17_REAR.z - 0.245)) < 0.1) { e = max(e, shape.heatBrakes * 0.8); }
  if (length(p - vec3f(5.07, 0.53, 0.0)) < 0.1) { e = max(e, shape.heatEngine); }
  if (p.x > 3.7 && p.x < 4.3 && p.y > 0.2 && p.y < 0.5 && p.z > 0.18 && p.z < 0.48) { e = max(e, shape.heatRad); }
  if (p.x > 4.15 && p.x < 4.65 && p.y > 0.5 && p.z < 0.16) { e = max(e, shape.heatRad * 1.4); }
  return e;
}

fn f1Emission(pw: vec3f) -> f32 {
  let p = toBodyFrame(vec3f(pw.x, pw.y, abs(pw.z)));
  let b = shape.rideH;
  var e = 0.0;
  if (length(p.xy - vec2f(FA, WR)) < 0.21 && abs(p.z - (FWZ - FHW - 0.03)) < 0.12) { e = max(e, shape.heatBrakes); }
  if (length(p.xy - vec2f(RA, WR)) < 0.21 && abs(p.z - (RWZ - RHW - 0.03)) < 0.12) { e = max(e, shape.heatBrakes * 0.8); }
  if (p.x > 5.02 && sdCapsule(p, vec3f(4.95, b + 0.44, 0.0), vec3f(5.16, b + 0.45, 0.0), 0.09) < 0.0) { e = max(e, shape.heatEngine); }
  if (p.x > 3.85 && p.x < 4.5 && p.z > 0.10 && p.y > b + 0.12 && p.y < b + 0.45) { e = max(e, shape.heatRad); }
  if (p.x > 3.55 && p.x < 4.25 && p.z < 0.13 && p.y > b + 0.42) { e = max(e, shape.heatRad * 1.4); }
  return e;
}
`;
