// Game-style setup panel: tabs, stepper controls bound to hidden range inputs, and the
// performance read-out (top speed, cornering grip, downforce, efficiency, balance).

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.hidden = t.dataset.tab !== name;
}

function buildStepper(el: HTMLElement) {
  const input = $<HTMLInputElement>(el.dataset.input!);
  const min = Number(input.min), max = Number(input.max), step = Number(input.step) || 1;
  const pips = Number(el.dataset.pips ?? 0);
  const row = document.createElement("div");
  row.className = "st-row";
  const minus = document.createElement("button");
  minus.className = "st-btn";
  minus.textContent = "−";
  minus.setAttribute("aria-label", "Bajar");
  const plus = document.createElement("button");
  plus.className = "st-btn";
  plus.textContent = "+";
  plus.setAttribute("aria-label", "Subir");
  const track = document.createElement("div");
  track.className = pips ? "st-track pips" : "st-track bar";
  const marks: HTMLElement[] = [];
  if (pips) {
    for (let i = 0; i < pips; i++) { const m = document.createElement("i"); track.appendChild(m); marks.push(m); }
  } else {
    track.appendChild(document.createElement("i"));
  }
  row.append(minus, track, plus);
  el.appendChild(row);

  const update = () => {
    const v = Number(input.value);
    const f = (v - min) / (max - min);
    if (pips) marks.forEach((m, i) => m.classList.toggle("on", i < Math.round(f * (pips - 1)) + 1));
    else (track.firstChild as HTMLElement).style.width = `${f * 100}%`;
    minus.disabled = v <= min + 1e-9 || input.disabled;
    plus.disabled = v >= max - 1e-9 || input.disabled;
    el.classList.toggle("locked", input.disabled);
  };
  const set = (v: number) => {
    if (input.disabled) return;
    const snapped = Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
    if (Math.abs(snapped - Number(input.value)) < step * 0.01) return;
    input.value = String(+snapped.toFixed(4));
    input.dispatchEvent(new Event("input"));
  };
  minus.addEventListener("click", () => set(Number(input.value) - step));
  plus.addEventListener("click", () => set(Number(input.value) + step));
  track.addEventListener("pointerdown", (e) => {
    const pick = (ev: PointerEvent) => {
      const r = track.getBoundingClientRect();
      set(min + Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (max - min));
    };
    pick(e);
    track.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => pick(ev);
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", () => track.removeEventListener("pointermove", move), { once: true });
  });
  input.addEventListener("input", update);
  new MutationObserver(update).observe(input, { attributes: true, attributeFilter: ["disabled"] });
  update();
}

export function initGarage() {
  for (const b of document.querySelectorAll<HTMLElement>("#tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab!));
  for (const el of document.querySelectorAll<HTMLElement>(".stepper")) buildStepper(el);
}

export function flashStepper(inputId: string) {
  const el = document.querySelector<HTMLElement>(`.stepper[data-input="${inputId}"]`);
  if (!el) return;
  showTab(el.closest<HTMLElement>(".tab")?.dataset.tab ?? "aero");
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ---------- Performance read-out ----------
const RHO = 1.225;
const POWER_W = 690e3;
const MASS_KG = 800;
const MU = 1.7;
const KGF = 9.81;

export interface PerfInput { bodyDragN: number; bodyDownN: number; wingDragN: number; frontDownN: number; rearDownN: number; kmh: number; frontAxleShare?: number }
interface Perf { top: number; grip: number; down: number; eff: number; balance: number }

const STATS: { id: string; key: keyof Perf; range: [number, number]; fmt: (v: number) => string; unit: string; deltaFmt: (d: number) => string }[] = [
  { id: "statTop", key: "top", range: [270, 370], fmt: (v) => Math.round(v).toString(), unit: "km/h", deltaFmt: (d) => `${Math.round(d)} km/h` },
  { id: "statGrip", key: "grip", range: [1.5, 3.2], fmt: (v) => v.toFixed(2), unit: "g", deltaFmt: (d) => `${d.toFixed(2)} g` },
  { id: "statDown", key: "down", range: [-100, 700], fmt: (v) => Math.round(v).toString(), unit: "kg", deltaFmt: (d) => `${Math.round(d)} kg` },
  { id: "statEff", key: "eff", range: [0, 1.4], fmt: (v) => v.toFixed(2), unit: "L/D", deltaFmt: (d) => d.toFixed(2) },
];

let reference: Perf | null = null;
let latest: Perf | null = null;

// The body loads come from the turbulent tunnel simulation; a slow average keeps the read-out
// steady while the wing loads (panel method) respond instantly to setup changes.
const body = { drag: 0, down: 0, kmh: 0, ready: false };

function compute(input: PerfInput): Perf | null {
  if (!body.ready || body.kmh !== input.kmh) {
    Object.assign(body, { drag: input.bodyDragN, down: input.bodyDownN, kmh: input.kmh, ready: true });
  } else {
    body.drag += (input.bodyDragN - body.drag) * 0.05;
    body.down += (input.bodyDownN - body.down) * 0.05;
  }
  const p = { dragN: body.drag + input.wingDragN, downN: body.down + input.frontDownN + input.rearDownN, frontDownN: input.frontDownN, rearDownN: input.rearDownN, kmh: input.kmh };
  const v = p.kmh / 3.6;
  const q = 0.5 * RHO * v * v;
  if (q <= 0 || p.dragN <= 1) return null;
  const cda = p.dragN / q;
  const top = Math.cbrt((2 * POWER_W) / (RHO * cda)) * 3.6;
  const down200 = p.downN * Math.pow(200 / p.kmh, 2);
  const grip = MU * (1 + down200 / (MASS_KG * KGF));
  const wings = p.frontDownN + p.rearDownN;
  const balance = input.frontAxleShare ?? (wings > 1 ? p.frontDownN / wings : 0.5);
  return { top, grip, down: p.downN / KGF, eff: p.downN / p.dragN, balance };
}

export function renderPerformance(input: PerfInput) {
  const perf = compute(input);
  if (!perf) return;
  latest = perf;
  for (const s of STATS) {
    const el = $(s.id);
    const v = perf[s.key];
    const f = (x: number) => Math.min(1, Math.max(0, (x - s.range[0]) / (s.range[1] - s.range[0])));
    el.querySelector<HTMLElement>(".stat-val")!.innerHTML = `${s.fmt(v)}<small>${s.unit}</small>`;
    el.querySelector<HTMLElement>(".stat-bar i")!.style.width = `${f(v) * 100}%`;
    const refMark = el.querySelector<HTMLElement>(".stat-bar em")!;
    const delta = el.querySelector<HTMLElement>(".stat-delta")!;
    if (reference) {
      refMark.style.left = `${f(reference[s.key]) * 100}%`;
      refMark.hidden = false;
      const d = v - reference[s.key];
      const small = Math.abs(d) < (s.range[1] - s.range[0]) * 0.012;
      delta.textContent = small ? "" : `${d > 0 ? "▲" : "▼"} ${s.deltaFmt(Math.abs(d))}`;
      delta.className = `stat-delta ${small ? "" : d > 0 ? "up" : "down"}`;
    } else {
      refMark.hidden = true;
      delta.textContent = "";
    }
  }
  const centre = reference?.balance ?? perf.balance;
  const bal = Math.min(1, Math.max(0, 0.5 + (perf.balance - centre) / 0.16));
  $("balMarker").style.left = `${bal * 100}%`;
  $("balVal").textContent = `${Math.round(Math.min(1, Math.max(0, perf.balance)) * 100)}% eje delantero`;
}

export function setReference() {
  if (latest) reference = { ...latest };
}
export function clearReference() {
  reference = null;
}
