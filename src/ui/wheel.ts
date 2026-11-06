// Radial view dial: outer ring switches the view mode, inner ring the flow particles.
// It drives the existing buttons in the "Vista" tab so both stay in sync.

interface WheelItem { value: string; label: string; icon: string }

const VIEW_ITEMS: WheelItem[] = [
  { value: "show", label: "Flujo", icon: '<path d="M2 8c6 0 8 3 20 3M2 13c6 0 8 3 20 3M2 18c8 0 10 2 20 2" />' },
  { value: "cfd", label: "Presión", icon: '<rect x="3" y="9" width="18" height="6" rx="3" /><path d="M7 9v6M12 9v6M17 9v6" />' },
  { value: "vortex", label: "Vórtices", icon: '<path d="M12 12m-2 0a2 2 0 1 0 4 0a4 4 0 1 0-8 0a6 6 0 1 0 12 0" />' },
  { value: "heat", label: "Calor", icon: '<path d="M12 3c3 4 5 6 5 10a5 5 0 0 1-10 0c0-2 1-4 2-5 0 2 1 3 2 3 0-3 0-5 1-8z" />' },
  { value: "wake", label: "Estela", icon: '<path d="M3 12h4M17 6v12M13 8v8M21 9v6M7 9l4 3-4 3" />' },
];
const PARTICLE_ITEMS: WheelItem[] = [
  { value: "1", label: "Líneas", icon: '<path d="M3 8h18M3 12h18M3 16h18" />' },
  { value: "4", label: "Vórtices", icon: '<path d="M4 12c0-4 4-6 8-6s6 3 6 6-3 4-5 4-3-2-3-3 1-2 2-2" />' },
  { value: "2", label: "Humo", icon: '<path d="M7 17a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.5A3.5 3.5 0 0 1 17 17z" />' },
  { value: "3", label: "Niebla", icon: '<path d="M4 9h12M7 13h13M4 17h10" stroke-dasharray="2 3" />' },
  { value: "0", label: "Ninguna", icon: '<circle cx="12" cy="12" r="7" /><path d="M7 17 17 7" />' },
];

const SIZE = 200;
const C = SIZE / 2;
const RINGS = { outer: [70, 97] as const, inner: [41, 66] as const };
const GAP_DEG = 4;

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};
function arcPath(r0: number, r1: number, a0: number, a1: number) {
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1), [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

function ring(items: WheelItem[], ringName: "outer" | "inner", offset: number) {
  const [r0, r1] = RINGS[ringName];
  const step = 360 / items.length;
  return items.map((it, i) => {
    const a0 = offset + i * step + GAP_DEG / 2, a1 = offset + (i + 1) * step - GAP_DEG / 2;
    const [ix, iy] = polar((r0 + r1) / 2, (a0 + a1) / 2);
    const s = ringName === "outer" ? 21 : 16;
    return `<g class="wh-seg" data-ring="${ringName}" data-value="${it.value}" data-label="${it.label}">
      <title>${ringName === "outer" ? "Vista" : "Partículas"}: ${it.label}</title>
      <path d="${arcPath(r0, r1, a0, a1)}" />
      <svg x="${ix - s / 2}" y="${iy - s / 2}" width="${s}" height="${s}" viewBox="0 0 24 24" class="wh-icon">${it.icon}</svg>
    </g>`;
  }).join("");
}

// Docked dial, always visible next to the canvas.
export function initWheel() {
  const dial = document.createElement("div");
  dial.className = "wheel-dock panel";
  dial.innerHTML = `
    <svg viewBox="0 0 ${SIZE} ${SIZE}" class="wh-svg">
      ${ring(VIEW_ITEMS, "outer", -36)}
      ${ring(PARTICLE_ITEMS, "inner", -36)}
      <circle cx="${C}" cy="${C}" r="${RINGS.inner[0] - 5}" class="wh-core" />
      <text x="${C}" y="${C - 2}" class="wh-title" id="whTitle">Flujo</text>
      <text x="${C}" y="${C + 13}" class="wh-kicker" id="whKicker">Líneas</text>
    </svg>`;
  document.body.appendChild(dial);

  const viewButton = (v: string) => document.querySelector<HTMLButtonElement>(`#presetSeg [data-preset="${v}"]`);
  const particleButton = (v: string) => document.querySelector<HTMLButtonElement>(`#partSeg [data-p="${v}"]`);
  const current = () => ({
    view: document.querySelector<HTMLElement>("#presetSeg .on")?.dataset.preset ?? "",
    particles: document.querySelector<HTMLElement>("#partSeg .on")?.dataset.p ?? "",
  });
  const title = dial.querySelector<SVGTextElement>("#whTitle")!;
  const kicker = dial.querySelector<SVGTextElement>("#whKicker")!;

  const sync = () => {
    const cur = current();
    for (const g of dial.querySelectorAll<SVGGElement>(".wh-seg")) {
      const on = g.dataset.ring === "outer" ? g.dataset.value === cur.view : g.dataset.value === cur.particles;
      g.classList.toggle("on", on);
    }
    title.textContent = VIEW_ITEMS.find((i) => i.value === cur.view)?.label ?? "Vista";
    kicker.textContent = PARTICLE_ITEMS.find((i) => i.value === cur.particles)?.label ?? "";
  };

  for (const g of dial.querySelectorAll<SVGGElement>(".wh-seg")) {
    g.addEventListener("pointerenter", () => {
      title.textContent = g.dataset.label!;
      kicker.textContent = g.dataset.ring === "outer" ? "vista" : "partículas";
    });
    g.addEventListener("pointerleave", sync);
    g.addEventListener("click", () => {
      const target = g.dataset.ring === "outer" ? viewButton(g.dataset.value!) : particleButton(g.dataset.value!);
      target?.click();
      sync();
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof Element && e.target.closest("input, textarea")) return;
    if (e.key !== "v" && e.key !== "V") return;
    const i = VIEW_ITEMS.findIndex((it) => it.value === current().view);
    viewButton(VIEW_ITEMS[(i + 1) % VIEW_ITEMS.length].value)?.click();
    sync();
  });
  for (const id of ["presetSeg", "partSeg"]) document.getElementById(id)?.addEventListener("click", () => setTimeout(sync, 0));
  sync();
}

const CAMERA_ITEMS: WheelItem[] = [
  { value: "persp", label: "3/4", icon: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 20 7.5M12 12v9M12 12 4 7.5" />' },
  { value: "side", label: "Lateral", icon: '<path d="M2 15h20M5 15l2-4h9l3 4" /><circle cx="7" cy="16" r="2" /><circle cx="17" cy="16" r="2" />' },
  { value: "front", label: "Frente", icon: '<rect x="5" y="9" width="14" height="6" rx="2" /><path d="M3 15v3M21 15v3M9 9l1-3h4l1 3" />' },
  { value: "top", label: "Arriba", icon: '<rect x="8" y="3" width="8" height="18" rx="3" /><path d="M5 6h3M16 6h3M5 18h3M16 18h3" />' },
  { value: "rear", label: "Atrás", icon: '<path d="M4 8h16M6 8v7h12V8M9 15v3M15 15v3M10 11h4" />' },
];
const CAM_RING = [52, 97] as const;

// Docked camera dial on the right side, mirroring the view dial.
export function initCameraDial() {
  const step = 360 / CAMERA_ITEMS.length;
  const segs = CAMERA_ITEMS.map((it, i) => {
    const a0 = -step / 2 + i * step + GAP_DEG / 2, a1 = -step / 2 + (i + 1) * step - GAP_DEG / 2;
    const [ix, iy] = polar((CAM_RING[0] + CAM_RING[1]) / 2, (a0 + a1) / 2);
    const s = 22;
    return `<g class="wh-seg" data-ring="outer" data-value="${it.value}" data-label="${it.label}">
      <title>Cámara: ${it.label}</title>
      <path d="${arcPath(CAM_RING[0], CAM_RING[1], a0, a1)}" />
      <svg x="${ix - s / 2}" y="${iy - s / 2 - 5}" width="${s}" height="${s}" viewBox="0 0 24 24" class="wh-icon">${it.icon}</svg>
      <text x="${ix}" y="${iy + 15}" class="wh-seg-label">${it.label}</text>
    </g>`;
  }).join("");
  const dial = document.createElement("div");
  dial.className = "wheel-dock cam-dock panel";
  dial.innerHTML = `
    <svg viewBox="0 0 ${SIZE} ${SIZE}" class="wh-svg">
      ${segs}
      <circle cx="${C}" cy="${C}" r="${CAM_RING[0] - 5}" class="wh-core" />
      <text x="${C}" y="${C - 2}" class="wh-title" id="camTitle">3/4</text>
      <text x="${C}" y="${C + 13}" class="wh-kicker">cámara</text>
    </svg>`;
  document.body.appendChild(dial);
  const title = dial.querySelector<SVGTextElement>("#camTitle")!;
  let current = "persp";
  const sync = () => {
    for (const g of dial.querySelectorAll<SVGGElement>(".wh-seg")) g.classList.toggle("on", g.dataset.value === current);
    title.textContent = CAMERA_ITEMS.find((i) => i.value === current)?.label ?? "Libre";
  };
  for (const g of dial.querySelectorAll<SVGGElement>(".wh-seg")) {
    g.addEventListener("pointerenter", () => { title.textContent = g.dataset.label!; });
    g.addEventListener("pointerleave", sync);
    g.addEventListener("click", () => {
      document.querySelector<HTMLButtonElement>(`.cams [data-cam="${g.dataset.value}"]`)?.click();
      current = g.dataset.value!;
      sync();
    });
  }
  const canvas = document.getElementById("view");
  let pressed = false;
  canvas?.addEventListener("pointerdown", () => { pressed = true; });
  window.addEventListener("pointerup", () => { pressed = false; });
  canvas?.addEventListener("pointermove", () => {
    if (pressed && current) { current = ""; sync(); }
  });
  sync();
}
