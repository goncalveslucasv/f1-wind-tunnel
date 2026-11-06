type RGB = [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function turbo(t0: number): RGB {
  const x = clamp01(t0);
  const v = [1, x, x * x, x * x * x];
  const v2 = [v[2] * v[2], v[3] * v[2]];
  const d = (a: number[], b: number[]) => a.reduce((s, ai, i) => s + ai * b[i], 0);
  return [
    d(v, [0.13572138, 4.6153926, -42.66032258, 132.13108234]) + d(v2, [-152.94239396, 59.28637943]),
    d(v, [0.09140261, 2.19418839, 4.84296658, -14.18503333]) + d(v2, [4.27729857, 2.82956604]),
    d(v, [0.1066733, 12.64194608, -60.58204836, 110.36276771]) + d(v2, [-89.90310912, 27.34824973]),
  ].map(clamp01) as RGB;
}

function inferno(t0: number): RGB {
  const t = clamp01(t0);
  const c = [
    [0.0002189, 0.001651, -0.0194809], [0.1065134, 0.5639564, 3.9327124], [11.6024931, -3.972854, -15.9423941],
    [-41.7039961, 17.4363989, 44.3541452], [77.1629357, -33.4023589, -81.8073093], [-71.3194282, 32.6260643, 73.2095199],
    [25.1311262, -12.242669, -23.070325],
  ];
  return [0, 1, 2].map((k) => {
    let r = c[6][k];
    for (let i = 5; i >= 0; i--) r = c[i][k] + t * r;
    return clamp01(r);
  }) as RGB;
}

function viridisLike(t0: number): RGB {
  const t = clamp01(t0);
  return mix(mix([0.07, 0.04, 0.2], [0.13, 0.55, 0.55], smooth(0, 0.5, t)), [0.99, 0.91, 0.15], smooth(0.45, 1, t));
}

function wakeMap(t0: number): RGB {
  const t = clamp01(t0);
  let c = mix([0.02, 0.03, 0.06], [0.22, 0.05, 0.42], smooth(0, 0.25, t));
  c = mix(c, [0.85, 0.1, 0.55], smooth(0.25, 0.55, t));
  c = mix(c, [1.0, 0.55, 0.25], smooth(0.55, 0.8, t));
  return mix(c, [1.0, 0.95, 0.7], smooth(0.8, 1.0, t));
}

function neon(t0: number): RGB {
  const t = clamp01(t0);
  let c = mix([0.01, 0.02, 0.08], [0.02, 0.12, 0.45], smooth(0, 0.3, t));
  c = mix(c, [0.03, 0.45, 0.95], smooth(0.3, 0.6, t));
  c = mix(c, [0.25, 0.85, 1.0], smooth(0.6, 0.8, t));
  return mix(c, [0.92, 1.0, 1.0], smooth(0.8, 1.0, t));
}

export function paletteColor(id: number, t: number): RGB {
  switch (id) {
    case 0: return neon(t);
    case 1: return turbo(t * 0.86 + 0.07);
    case 2: return inferno(t * 0.92 + 0.04);
    case 3: return viridisLike(t);
    case 4: return wakeMap(t);
    default: return neon(t);
  }
}

export function paletteGradient(id: number): string {
  const stops: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const [r, g, b] = paletteColor(id, i / 16).map((c) => Math.round(c * 255));
    stops.push(`rgb(${r} ${g} ${b}) ${(i / 16) * 100}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
