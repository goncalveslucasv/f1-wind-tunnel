const DEG = Math.PI / 180;

interface FrontElement { y: number; chord: number; ang: number; rise: number; curl: number }
export interface FrontWingDef {
  id: number;
  name: string;
  desc: string;
  tags: string[];
  span: number;
  endplate: { cy: number; hh: number };
  elements: FrontElement[];
}
export interface RearWingDef {
  id: number;
  name: string;
  desc: string;
  tags: string[];
  main: { chord: number; ang: number; rise: number };
  flap: { chord: number; ang: number };
  endplate: { hw: number; hh: number };
}

export const FRONT_WINGS: FrontWingDef[] = [
  {
    id: 0, name: "Estándar", desc: "Cuatro elementos y placa recta. Equilibrio entre carga y resistencia.", tags: ["carga media", "drag medio"],
    span: 0.9, endplate: { cy: 0.085, hh: 0.115 },
    elements: [
      { y: 0, chord: 0.31, ang: 2, rise: 0.06, curl: 0.5 }, { y: 0.036, chord: 0.17, ang: 9, rise: 0.09, curl: 0.45 },
      { y: 0.075, chord: 0.14, ang: 17, rise: 0.11, curl: 0.4 }, { y: 0.118, chord: 0.12, ang: 26, rise: 0.13, curl: 0.4 },
    ],
  },
  {
    id: 1, name: "Outwash", desc: "Los flaps suben hacia las puntas para desviar la estela de la rueda hacia afuera.", tags: ["carga exterior", "placa alta"],
    span: 0.9, endplate: { cy: 0.17, hh: 0.2 },
    elements: [
      { y: 0, chord: 0.31, ang: 2, rise: 0.03, curl: 0.5 }, { y: 0.036, chord: 0.17, ang: 9, rise: 0.15, curl: 0.3 },
      { y: 0.075, chord: 0.14, ang: 17, rise: 0.19, curl: 0.25 }, { y: 0.118, chord: 0.12, ang: 26, rise: 0.22, curl: 0.25 },
    ],
  },
  {
    id: 2, name: "Cuchara", desc: "Carga concentrada en el centro; las puntas bajan hacia la placa para sellar el flujo bajo el ala.", tags: ["carga al centro", "puntas bajas"],
    span: 0.9, endplate: { cy: 0.06, hh: 0.1 },
    elements: [
      { y: 0, chord: 0.31, ang: 3, rise: -0.02, curl: 0.55 }, { y: 0.04, chord: 0.19, ang: 13, rise: -0.04, curl: 0.35 },
      { y: 0.085, chord: 0.16, ang: 22, rise: -0.06, curl: 0.35 }, { y: 0.13, chord: 0.13, ang: 31, rise: -0.08, curl: 0.35 },
    ],
  },
  {
    id: 3, name: "Baja carga", desc: "Solo dos elementos casi planos, para circuitos rápidos.", tags: ["poca carga", "poco drag"],
    span: 0.9, endplate: { cy: 0.05, hh: 0.085 },
    elements: [{ y: 0, chord: 0.3, ang: 1, rise: 0, curl: 0.6 }, { y: 0.03, chord: 0.16, ang: 4, rise: 0.02, curl: 0.5 }],
  },
];

export const REAR_WINGS: RearWingDef[] = [
  {
    id: 0, name: "Media carga", desc: "Plano principal en cuchara y flap de 26 cm. La configuración de la mayoría de los circuitos.", tags: ["carga media", "drag medio"],
    main: { chord: 0.36, ang: 9, rise: -0.1 }, flap: { chord: 0.26, ang: 0 }, endplate: { hw: 0.33, hh: 0.29 },
  },
  {
    id: 1, name: "Alta carga", desc: "Cuerda más larga y más ángulo, para circuitos lentos con muchas curvas.", tags: ["mucha carga", "mucho drag"],
    main: { chord: 0.42, ang: 12, rise: -0.15 }, flap: { chord: 0.32, ang: 6 }, endplate: { hw: 0.36, hh: 0.33 },
  },
  {
    id: 2, name: "Baja carga", desc: "Plano fino y flap chico, para circuitos de alta velocidad.", tags: ["poca carga", "poco drag"],
    main: { chord: 0.27, ang: 4, rise: 0.02 }, flap: { chord: 0.15, ang: -14 }, endplate: { hw: 0.3, hh: 0.25 },
  },
];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function frontWingSvg(w: FrontWingDef, flapDeg = 14): string {
  const sx = 104, base = 62, sy = 230;
  const px = (z: number) => 110 + z * sx;
  const py = (y: number) => base - y * sy;
  let paths = "";
  w.elements.forEach((e, i) => {
    const pts: string[] = [];
    for (let k = -20; k <= 20; k++) {
      const z = (k / 20) * w.span;
      const flapLift = i === 0 ? 0 : flapDeg * DEG * (i === 1 ? 0 : i === 2 ? 0.03 : 0.07);
      pts.push(`${px(z).toFixed(1)},${py(e.y + flapLift + e.rise * smooth(e.curl, w.span, Math.abs(z))).toFixed(1)}`);
    }
    const thick = Math.max(1.8, Math.sin((e.ang + flapDeg * (i === 0 ? 0.1 : 0.6)) * DEG) * e.chord * sy * 0.32);
    paths += `<polyline points="${pts.join(" ")}" stroke-width="${thick.toFixed(1)}" />`;
  });
  const ep = w.endplate;
  for (const s of [-1, 1]) {
    const x = px(s * (w.span + 0.012));
    paths += `<rect class="ep" x="${(x - 2).toFixed(1)}" y="${py(ep.cy + ep.hh).toFixed(1)}" width="4" height="${(ep.hh * 2 * sy).toFixed(1)}" rx="2" />`;
  }
  paths += `<rect class="nose" x="100" y="${py(0.2)}" width="20" height="${0.2 * sy}" rx="9" />`;
  return `<svg viewBox="0 0 220 70" class="part-svg">${paths}</svg>`;
}

export function rearWingSvg(w: RearWingDef, flapDeg = 32): string {
  const mainA = w.main.ang * DEG;
  const flapA = (flapDeg + w.flap.ang) * DEG * (w.id === 2 ? 0.55 : 1);
  const le = [0, 0];
  const te = [Math.cos(mainA) * w.main.chord, Math.sin(mainA) * w.main.chord];
  const fle = [te[0] - 0.03, te[1] + 0.035];
  const fte = [fle[0] + Math.cos(flapA) * w.flap.chord, fle[1] + Math.sin(flapA) * w.flap.chord];
  const s = 150, ox = 110 - ((Math.max(te[0], fte[0]) * s) / 2), oy = 62;
  const X = (x: number) => (ox + x * s).toFixed(1);
  const Y = (y: number) => (oy - y * s).toFixed(1);
  const ep = w.endplate;
  const top = Math.max(te[1], fte[1]) + 0.03;
  return `<svg viewBox="0 0 220 80" class="part-svg">
    <rect class="ep-side" x="${X(-0.05)}" y="${Y(top)}" width="${((Math.max(te[0], fte[0]) + 0.1) * s).toFixed(1)}" height="${((top + ep.hh * 0.35) * s).toFixed(1)}" rx="10" />
    <line x1="${X(le[0])}" y1="${Y(le[1])}" x2="${X(te[0])}" y2="${Y(te[1])}" stroke-width="7" />
    <line x1="${X(fle[0])}" y1="${Y(fle[1])}" x2="${X(fte[0])}" y2="${Y(fte[1])}" stroke-width="4.5" />
  </svg>`;
}

export interface BodyPartDef { id: number; name: string; desc: string; tags: string[] }

export const SIDEPODS: (BodyPartDef & { pod: { y: number; z: number; hy: number; hz: number }; undercut: number; channel: boolean })[] = [
  {
    id: 0, name: "Downwash", desc: "Pontón ancho con rampa que baja hacia atrás y guía el aire hacia el difusor.", tags: ["concepto más usado"],
    pod: { y: 0.41, z: 0.52, hy: 0.18, hz: 0.25 }, undercut: 0.16, channel: false,
  },
  {
    id: 1, name: "Zero-pod", desc: "Pontón mínimo y angosto con una toma alta: casi todo el costado queda libre.", tags: ["menos área frontal", "refrigeración justa"],
    pod: { y: 0.40, z: 0.36, hy: 0.16, hz: 0.08 }, undercut: 0, channel: false,
  },
  {
    id: 2, name: "Bañera", desc: "Pontón ancho con un canal en la parte de arriba que encauza el flujo hacia atrás.", tags: ["canal superior"],
    pod: { y: 0.41, z: 0.52, hy: 0.18, hz: 0.28 }, undercut: 0.15, channel: true,
  },
  {
    id: 3, name: "Cintura alta", desc: "Pontón alto con un undercut profundo que deja pasar mucho aire por debajo.", tags: ["undercut profundo"],
    pod: { y: 0.47, z: 0.52, hy: 0.15, hz: 0.25 }, undercut: 0.22, channel: false,
  },
];

export const COVERS: (BodyPartDef & { y0: number; hz0: number; hz1: number; x1: number })[] = [
  { id: 0, name: "Estándar", desc: "Tapa media que se cierra de forma gradual hasta la caja de cambios.", tags: ["equilibrada"], y0: 0.58, hz0: 0.24, hz1: 0.07, x1: 4.86 },
  { id: 1, name: "Ancha", desc: "Más volumen para refrigeración: útil en carreras calurosas, a costa de resistencia.", tags: ["más refrigeración", "más drag"], y0: 0.60, hz0: 0.31, hz1: 0.13, x1: 4.86 },
  { id: 2, name: "Botella de Coca-Cola", desc: "Cola muy cerrada y baja que acelera el aire hacia el difusor.", tags: ["cola angosta"], y0: 0.57, hz0: 0.19, hz1: 0.05, x1: 4.7 },
];

export const NOSES: (BodyPartDef & { x0: number; y0: number; pylons: boolean })[] = [
  { id: 0, name: "Larga", desc: "Nariz que llega hasta el borde del ala y se apoya sobre el plano principal.", tags: ["estándar"], x0: 0.1, y0: 0.17, pylons: false },
  { id: 1, name: "Corta", desc: "Nariz más corta y ancha: el ala se sostiene con soportes y queda más plano principal libre.", tags: ["más ala libre"], x0: 0.34, y0: 0.17, pylons: true },
  { id: 2, name: "Alta y fina", desc: "Nariz elevada sobre soportes que deja pasar más aire por debajo hacia el piso.", tags: ["más flujo al piso"], x0: 0.1, y0: 0.25, pylons: true },
];

export function sidepodSvg(d: (typeof SIDEPODS)[number]): string {
  const s = 85, cx = 110, gy = 74;
  const X = (z: number) => cx + z * s;
  const Y = (y: number) => gy - y * s;
  const b = 0.12;
  let out = `<rect class="nose" x="${X(-0.26)}" y="${Y(b + 0.62)}" width="${0.52 * s}" height="${0.6 * s}" rx="10" />`;
  for (const side of [-1, 1]) {
    const p = d.pod;
    const zc = side * p.z;
    out += `<rect class="pod" x="${(X(zc - p.hz)).toFixed(1)}" y="${Y(b + p.y + p.hy).toFixed(1)}" width="${(p.hz * 2 * s).toFixed(1)}" height="${(p.hy * 2 * s).toFixed(1)}" rx="${Math.min(14, p.hz * s)}" />`;
    if (d.undercut > 0) out += `<ellipse class="cut" cx="${X(side * (p.z + 0.18)).toFixed(1)}" cy="${Y(b + 0.12).toFixed(1)}" rx="${(d.undercut * s * 1.1).toFixed(1)}" ry="${(d.undercut * s * 0.75).toFixed(1)}" />`;
    if (d.channel) out += `<ellipse class="cut" cx="${X(side * (p.z - 0.02)).toFixed(1)}" cy="${Y(b + p.y + p.hy + 0.02).toFixed(1)}" rx="${0.11 * s}" ry="${0.06 * s}" />`;
  }
  out += `<line x1="8" y1="${Y(b)}" x2="212" y2="${Y(b)}" stroke-width="3" />`;
  return `<svg viewBox="0 0 220 80" class="part-svg">${out}</svg>`;
}

export function coverSvg(d: (typeof COVERS)[number]): string {
  const sx = 70, sz = 95, ox = -186, cy = 40;
  const X = (x: number) => (ox + x * sx).toFixed(1);
  const Z = (z: number) => (cy + z * sz).toFixed(1);
  const pts: string[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = 2.96 + (d.x1 - 2.96) * t;
    pts.push(`${X(x)},${Z(-(d.hz0 + (d.hz1 - d.hz0) * t * (2 - t)))}`);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const x = 2.96 + (d.x1 - 2.96) * t;
    pts.push(`${X(x)},${Z(d.hz0 + (d.hz1 - d.hz0) * t * (2 - t))}`);
  }
  return `<svg viewBox="0 0 220 80" class="part-svg"><rect class="nose" x="${X(2.3)}" y="${Z(-0.3)}" width="${0.7 * sx}" height="${0.6 * sz}" rx="12" /><polygon class="pod" points="${pts.join(" ")}" /></svg>`;
}

export function noseSvg(d: (typeof NOSES)[number]): string {
  const s = 150, ox = 12, gy = 74, b = 0.12;
  const X = (x: number) => (ox + x * s).toFixed(1);
  const Y = (y: number) => (gy - y * s).toFixed(1);
  const yw = 0.19 + b * 0.45;
  const tipY = b + d.y0;
  let out = `<line x1="${X(-0.03)}" y1="${Y(yw)}" x2="${X(0.42)}" y2="${Y(yw + 0.05)}" stroke-width="5" />`;
  out += `<polygon class="pod" points="${X(d.x0)},${Y(tipY + 0.04)} ${X(1.3)},${Y(b + 0.52)} ${X(1.3)},${Y(b + 0.2)} ${X(d.x0)},${Y(tipY - 0.04)}" />`;
  if (d.pylons) out += `<line x1="${X(d.x0 + 0.08)}" y1="${Y(tipY - 0.03)}" x2="${X(d.x0 + 0.06)}" y2="${Y(yw + 0.02)}" stroke-width="3" />`;
  out += `<line x1="0" y1="${gy}" x2="220" y2="${gy}" stroke-width="2" />`;
  return `<svg viewBox="0 0 220 80" class="part-svg">${out}</svg>`;
}

type Pt = [number, number];
const rotateAbout = (pts: Pt[], pivot: Pt, deg: number): Pt[] => {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [pivot[0] + c * (x - pivot[0]) - s * (y - pivot[1]), pivot[1] + s * (x - pivot[0]) + c * (y - pivot[1])]);
};
const leading = (pts: Pt[]): Pt => pts.reduce((a, b) => (b[0] < a[0] ? b : a));

// Side-view thumbnail of the W17 wing sections, with each element rotated like the 3D rig.
export function w17WingSvg(sections: Pt[][], rotations: number[], groupWithPrevious: boolean[]): string {
  const posed: Pt[][] = [];
  let pivot: Pt = [0, 0];
  sections.forEach((sec, i) => {
    if (!groupWithPrevious[i]) pivot = leading(sec);
    posed.push(rotateAbout(sec, pivot, rotations[i]));
  });
  const all = posed.flat();
  const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
  const scale = Math.min(196 / (maxX - minX), 64 / (maxY - minY));
  const ox = 110 - ((minX + maxX) / 2) * scale, oy = 40 + ((minY + maxY) / 2) * scale;
  const polys = posed.map((sec) => `<polygon class="pod" points="${sec.map(([x, y]) => `${(ox + x * scale).toFixed(1)},${(oy - y * scale).toFixed(1)}`).join(" ")}" />`).join("");
  return `<svg viewBox="0 0 220 80" class="part-svg">${polys}</svg>`;
}
