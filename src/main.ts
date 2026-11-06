import * as V from "vgpu";
import {
  AeroEngine, ColorField, FlowMode, QUALITIES, ShapeKind, carAnchors, f1Anchors, isRaceCar, w17Place,
  type Forces, type Livery, type QualityId, type ShapeParams, type ViewParams,
} from "./engine/engine";
import { orbitCamera, type Orbit } from "./engine/camera";
import { MeshCar, type DecodedImage } from "./engine/mesh-car";
import { W17_FRONT_LEVELS, W17_REAR_LEVELS, type RigData } from "./engine/car-model";
import { paletteGradient } from "./ui/palettes";
import { flashStepper, initGarage, renderPerformance, setReference, showTab } from "./ui/garage";
import { initCameraDial, initWheel } from "./ui/wheel";
import { AeroMap } from "./ui/aeromap";
import { COVERS, FRONT_WINGS, NOSES, REAR_WINGS, SIDEPODS, coverSvg, frontWingSvg, noseSvg, rearWingSvg, sidepodSvg, w17WingSvg } from "./ui/parts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KGF = 9.81;
const AIR_DENSITY = 1.225;

const REAR_TWIST_DEG = [0, -16, 6];
// ΔCdA / ΔClA in m² (≈ ±10–15 kg at 250 km/h).
const COOLING_COEF = [{ cd: -0.03, cl: 0.01 }, { cd: 0, cl: 0 }, { cd: 0.055, cl: -0.02 }];
const SIDEPOD_COEF = [{ cd: 0, cl: 0 }, { cd: -0.05, cl: 0.035 }];
const WING_STEP_FRONT = 2.5;
const WING_STEP_REAR_FLAP = 3;
const WING_STEP_REAR_MAIN = 0.8;
const STRAIGHT_REAR_FLAP_DEG = -28;
const STRAIGHT_FRONT_FLAP_DEG = -12;
// Wake rake 1.2 m behind the rear wing (x = 6.2 m), as a fraction of the transversal slice range.
const WAKE_RAKE_T = (6.2 + 2.0) / 10.0;
const SLICE_RANGES: Record<1 | 2 | 3, [number, number]> = { 1: [-2.0, 8.0], 2: [0.03, 2.4], 3: [0, 1.6] };
const CAMERA_PRESETS: Record<string, Pick<Orbit, "yaw" | "pitch" | "distance">> = {
  persp: { yaw: 2.3, pitch: 0.3, distance: 8.8 },
  side: { yaw: Math.PI / 2, pitch: 0.05, distance: 9.6 },
  front: { yaw: Math.PI + 0.001, pitch: 0.12, distance: 5.6 },
  top: { yaw: Math.PI / 2, pitch: 1.45, distance: 8.5 },
  rear: { yaw: 0.5, pitch: 0.28, distance: 6.4 },
  frontWing: { yaw: 2.45, pitch: 0.3, distance: 5.6 },
  wake: { yaw: 0.35, pitch: 0.32, distance: 6.2 },
};
const LIVERY: Livery = { paint: [0.38, 0.4, 0.43], accent: [0.0, 0.82, 0.75], carbon: true };

function showFallback(detail = "") {
  $("fallback").hidden = false;
  $("fallbackDetail").textContent = detail;
}

async function boot() {
  if (!("gpu" in navigator)) return showFallback();
  let gpu: V.Gpu;
  try {
    gpu = await V.init();
  } catch (err) {
    return showFallback(String((err as Error)?.message ?? err));
  }

  const params = new URLSearchParams(location.search);
  const quality = (params.get("q") as QualityId) in QUALITIES ? (params.get("q") as QualityId) : "medium";

  initGarage();
  initWheel();
  initCameraDial();
  const canvas = $<HTMLCanvasElement>("view");
  const surf = V.surface(gpu, canvas, { dpr: [1, 2], clearColor: [0, 0, 0, 1] });
  const engine = new AeroEngine(V, gpu, quality, surf.size);
  surf.onResize(() => engine.resize(surf.size));
  if (import.meta.env.DEV) Object.assign(window, { __engine: engine });

  $("gridInfo").textContent = `${engine.dims[0]}×${engine.dims[1]}×${engine.dims[2] * 2} celdas · lattice Boltzmann D3Q19`;
  $("cellSize").textContent = (engine.h * 100).toFixed(1);

  const shapeTarget: ShapeParams = {
    kind: ShapeKind.Empty, frontWing: 0, rearWing: 0, sidepod: 0, cover: 0, nose: 0, rearRideH: 0.14, rearMainDeg: 0, gurney: false, frontWingOn: true, rearWingOn: true, rearShape: 0, thinWings: false, sidepods: 0, cooling: 1, frontFlapDeg: 0, rearFlapDeg: 0, rideH: 0.12, aoaDeg: 6,
    customMode: 0, customWidth: 0.6, customAxisY: 1, heatBrakes: true, heatEngine: true, heatRad: true,
  };
  const shapeCur: ShapeParams = { ...shapeTarget };
  const view: ViewParams = {
    colorField: ColorField.Speed, surfaceField: false, sliceAxis: 0, slicePos: 0.19, flowMode: FlowMode.Streamlines, kmh: 250,
    livery: LIVERY,
  };
  let labelsOn = true;
  const slicePosByAxis: Record<1 | 2 | 3, number> = { 1: 0.55, 2: 0.2, 3: 0.12 };
  let rearFlapUser = 0;
  let frontFlapUser = 0;
  let straightMode = false;

  const orbit: Orbit = { target: [2.75, 0.42, 0], ...CAMERA_PRESETS.persp };
  const orbitGoal: Orbit = { ...orbit, target: [...orbit.target] as [number, number, number] };

  const flowAfterLoad = view.flowMode;
  view.flowMode = FlowMode.None;
  engine.setView(view);
  engine.setShape(shapeCur);
  engine.reset();

  // ---------- Controls ----------
  const setSeg = (segId: string, attr: string, value: string) => {
    for (const b of $(segId).querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("on", b.dataset[attr] === value);
  };
  const onSeg = (segId: string, attr: string, fn: (v: string) => void) => {
    $(segId).addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b || b.dataset[attr] === undefined) return;
      fn(b.dataset[attr]!);
    });
  };
  const bindRange = (id: string, fmt: (v: number) => string, fn: (v: number) => void) => {
    const input = $<HTMLInputElement>(id);
    const out = $(id + "Val");
    const apply = () => {
      const v = Number(input.value);
      if (out) out.textContent = fmt(v);
      fn(v);
    };
    input.addEventListener("input", apply);
    apply();
    return input;
  };

  const showSectionsFor = (kind: ShapeKind) => {
    for (const s of document.querySelectorAll<HTMLElement>("section[data-for]")) s.hidden = !s.dataset.for!.split(" ").includes(String(kind));
  };

  const setKind = (kind: ShapeKind) => {
    shapeTarget.kind = kind;
    shapeCur.kind = kind;
    showSectionsFor(kind);
    orbitGoal.target = [2.75, 0.42, 0];
    requestWingLoads();
    engine.setShape(shapeCur);
    resetChart();
    updateLegend();
    closePicker();
    syncPartButtons();
  };
  showSectionsFor(ShapeKind.W17);

  const applyFlaps = () => {
    shapeTarget.rearFlapDeg = straightMode ? STRAIGHT_REAR_FLAP_DEG : rearFlapUser;
    shapeTarget.frontFlapDeg = straightMode ? STRAIGHT_FRONT_FLAP_DEG : frontFlapUser;
  };
  const frontInput = bindRange("front", (v) => `${v}`, (v) => { frontFlapUser = (v - 6) * WING_STEP_FRONT; applyFlaps(); });
  const rearInput = bindRange("rear", (v) => `${v}`, (v) => {
    rearFlapUser = (v - 6) * WING_STEP_REAR_FLAP;
    shapeTarget.rearMainDeg = (v - 6) * WING_STEP_REAR_MAIN;
    applyFlaps();
  });
  const gurneyInput = $<HTMLInputElement>("gurney");
  gurneyInput.addEventListener("change", () => {
    shapeTarget.gurney = shapeCur.gurney = gurneyInput.checked;
    engine.setShape(shapeCur);
    requestWingLoads();
    markChange("rear", gurneyInput.checked ? "con gurney" : "sin gurney");
  });
  const rakeText = () => {
    const deg = (Math.atan((shapeTarget.rearRideH - shapeTarget.rideH) / 3.4) * 180) / Math.PI;
    $("rakeVal").textContent = `rake ${deg >= 0 ? "" : "−"}${Math.abs(deg).toFixed(1)}°`;
  };
  const rideInput = bindRange("ride", (v) => `${Math.round(v * 100)} cm`, (v) => { shapeTarget.rideH = v; rakeText(); });
  const rearRideInput = bindRange("rearRide", (v) => `${Math.round(v * 100)} cm`, (v) => { shapeTarget.rearRideH = v; rakeText(); });
  rearRideInput.addEventListener("input", () => markChange("total", `altura trasera ${Math.round(Number(rearRideInput.value) * 100)} cm`));
  frontInput.addEventListener("input", () => markChange("front", `ala del. ${frontInput.value}`));
  rearInput.addEventListener("input", () => markChange("rear", `ala tras. ${rearInput.value}`));
  rideInput.addEventListener("input", () => markChange("total", `altura delantera ${Math.round(Number(rideInput.value) * 100)} cm`));
  const speedInput = bindRange("speed", (v) => `${v} km/h`, (v) => { view.kmh = v; engine.setView(view); updateLegend(); });
  speedInput.addEventListener("input", () => requestWingLoads());

  const aeroBtn = $<HTMLButtonElement>("aeroMode");
  const syncAeroUi = () => {
    aeroBtn.classList.toggle("open", straightMode);
    $("aeroState").textContent = straightMode ? "Alerones abiertos" : "Alerones cerrados";
    rearInput.disabled = straightMode || !shapeTarget.rearWingOn;
    frontInput.disabled = straightMode || !shapeTarget.frontWingOn;
  };
  aeroBtn.addEventListener("click", () => {
    straightMode = !straightMode;
    applyFlaps();
    syncAeroUi();
    markChange("total", straightMode ? "alerones abiertos" : "alerones cerrados");
  });
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    if ((e.target instanceof Element && e.target.closest("input, textarea, .modal")) || !isRaceCar(shapeCur.kind)) return;
    e.preventDefault();
    aeroBtn.click();
  });

  // ---------- Build: fitted wings, rear-wing shape, profiles, sidepods, cooling ----------
  const applyBuild = (label: string, focus: "front" | "rear" | "total", quiet = false) => {
    shapeCur.frontWingOn = shapeTarget.frontWingOn;
    shapeCur.rearWingOn = shapeTarget.rearWingOn;
    shapeCur.rearShape = shapeTarget.rearShape;
    shapeCur.thinWings = shapeTarget.thinWings;
    shapeCur.sidepods = shapeTarget.sidepods;
    shapeCur.cooling = shapeTarget.cooling;
    engine.setShape(shapeCur);
    requestWingLoads();
    syncAeroUi();
    if (!quiet) markChange(focus, label);
  };
  for (const [id, key, name, focus] of [["frontOn", "frontWingOn", "alerón delantero", "front"], ["rearOn", "rearWingOn", "alerón trasero", "rear"]] as const) {
    $<HTMLInputElement>(id).addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      shapeTarget[key] = on;
      document.querySelector(`.wing-stepper[data-mount="${id}"]`)?.classList.toggle("detached", !on);
      applyBuild(on ? `${name} montado` : `sin ${name}`, focus);
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>(".st-eject, .st-mount")) {
    b.addEventListener("click", () => $<HTMLInputElement>(b.dataset.mount!).click());
  }
  const SHAPE_NAMES = ["estándar", "cuchara", "tablón"];
  const setRearShape = (v: number, quiet = false) => {
    shapeTarget.rearShape = v;
    setSeg("rearShapeSeg", "v", String(v));
    applyBuild(`trasero ${SHAPE_NAMES[v]}`, "rear", quiet);
  };
  onSeg("rearShapeSeg", "v", (v) => { setRearShape(Number(v)); syncTrack(); });
  const thinInput = $<HTMLInputElement>("thinWings");
  const setThin = (on: boolean, quiet = false) => {
    shapeTarget.thinWings = on;
    thinInput.checked = on;
    applyBuild(on ? "perfiles finos" : "perfiles normales", "total", quiet);
  };
  thinInput.addEventListener("change", () => { setThin(thinInput.checked); syncTrack(); });
  onSeg("podSeg", "v", (v) => {
    shapeTarget.sidepods = Number(v);
    setSeg("podSeg", "v", v);
    applyBuild(v === "1" ? "pontones compactos" : "pontones estándar", "total");
  });
  const COOLING_NAMES = ["refrigeración cerrada", "refrigeración normal", "refrigeración abierta"];
  onSeg("coolSeg", "v", (v) => {
    shapeTarget.cooling = Number(v);
    setSeg("coolSeg", "v", v);
    applyBuild(COOLING_NAMES[Number(v)], "total");
    updateLegend();
  });

  const TRACKS: Record<string, { front: number; rear: number; ride: number; rearRide: number; shape: number; thin: boolean; name: string }> = {
    monza: { name: "Monza", front: 2, rear: 1, ride: 0.11, rearRide: 0.13, shape: 1, thin: true },
    silverstone: { name: "Silverstone", front: 6, rear: 6, ride: 0.12, rearRide: 0.14, shape: 0, thin: false },
    monaco: { name: "Mónaco", front: 10, rear: 11, ride: 0.13, rearRide: 0.18, shape: 2, thin: false },
  };
  const setInput = (id: string, v: number) => {
    const el = $<HTMLInputElement>(id);
    if (Math.abs(Number(el.value) - v) < 1e-6) return;
    el.value = String(v);
    el.dispatchEvent(new Event("input"));
  };
  const syncTrack = () => {
    for (const b of document.querySelectorAll<HTMLElement>("#trackSeg button")) {
      const t = TRACKS[b.dataset.track!];
      const on = Number(frontInput.value) === t.front && Number(rearInput.value) === t.rear
        && Math.abs(Number(rideInput.value) - t.ride) < 1e-6 && Math.abs(Number(rearRideInput.value) - t.rearRide) < 1e-6
        && shapeTarget.rearShape === t.shape && shapeTarget.thinWings === t.thin;
      b.classList.toggle("on", on);
    }
  };
  for (const b of document.querySelectorAll<HTMLElement>("#trackSeg button")) {
    b.addEventListener("click", () => {
      const t = TRACKS[b.dataset.track!];
      if (straightMode) aeroBtn.click();
      setRearShape(t.shape, true);
      setThin(t.thin, true);
      setInput("front", t.front);
      setInput("rear", t.rear);
      setInput("ride", t.ride);
      setInput("rearRide", t.rearRide);
      markChange("total", t.name);
      syncTrack();
    });
  }
  for (const id of ["front", "rear", "ride", "rearRide"]) $(id).addEventListener("input", syncTrack);
  syncTrack();
  $("setRef").addEventListener("click", () => setReference());
  let quietChanges = false;
  const aeroMap = new AeroMap({
    setHeights: (front, rear) => {
      quietChanges = true;
      setInput("ride", front);
      setInput("rearRide", rear);
      quietChanges = false;
    },
    getHeights: () => [shapeTarget.rideH, shapeTarget.rearRideH],
    balance: () => frontAxleShare(),
    onApply: (front, rear) => {
      setInput("ride", front);
      setInput("rearRide", rear);
      markChange("total", `mapa ${Math.round(front * 100)}/${Math.round(rear * 100)} cm`);
    },
  });

  // ---------- Part swap ----------
  type Part = "front" | "rear" | "sidepod" | "cover" | "nose";
  type PartKey = "frontWing" | "rearWing" | "sidepod" | "cover" | "nose";
  const PARTS: Record<Part, { title: string; short: string; key: PartKey; focus: "front" | "rear" | "total"; items: { id: number; name: string; desc: string; tags: string[] }[]; svg: (id: number) => string }> = {
    front: { title: "Alerón delantero", short: "delantero", key: "frontWing", focus: "front", items: FRONT_WINGS, svg: (id) => frontWingSvg(FRONT_WINGS[id]) },
    rear: { title: "Alerón trasero", short: "trasero", key: "rearWing", focus: "rear", items: REAR_WINGS, svg: (id) => rearWingSvg(REAR_WINGS[id]) },
    sidepod: { title: "Pontones", short: "pontones", key: "sidepod", focus: "total", items: SIDEPODS, svg: (id) => sidepodSvg(SIDEPODS[id]) },
    cover: { title: "Tapa del motor", short: "tapa", key: "cover", focus: "total", items: COVERS, svg: (id) => coverSvg(COVERS[id]) },
    nose: { title: "Nariz", short: "nariz", key: "nose", focus: "total", items: NOSES, svg: (id) => noseSvg(NOSES[id]) },
  };
  let rigData: RigData | null = null;
  const w17Parts = (part: Part) => {
    if (part === "front") {
      return { ...PARTS.front, items: W17_FRONT_LEVELS, svg: (id: number) => rigData ? w17WingSvg(rigData.sections.front, [0, W17_FRONT_LEVELS[id].flap * 0.8, W17_FRONT_LEVELS[id].flap], [false, false, false]) : "" };
    }
    return { ...PARTS.rear, items: W17_REAR_LEVELS, svg: (id: number) => rigData ? w17WingSvg(rigData.sections.rear, [W17_REAR_LEVELS[id].main, W17_REAR_LEVELS[id].flap, W17_REAR_LEVELS[id].flap], [false, false, true]) : "" };
  };
  const partDef = (part: Part) => (shapeCur.kind === ShapeKind.W17 && (part === "front" || part === "rear") ? w17Parts(part) : PARTS[part]);
  const syncPartButtons = () => {
    for (const part of Object.keys(PARTS) as Part[]) {
      const el = document.querySelector<HTMLElement>(`.part-btn[data-part="${part}"] b`);
      const def = partDef(part);
      if (el) el.textContent = def.items[shapeTarget[def.key]]?.name ?? def.items[0].name;
    }
  };
  const picker = $("partPicker");
  let pickerPart: Part | null = null;
  function renderPicker() {
    if (!pickerPart) return;
    const def = partDef(pickerPart);
    $("pickerTitle").textContent = def.title;
    const current = shapeTarget[def.key];
    $("pickerGrid").innerHTML = def.items.map((d) => `
      <button class="picker-card${d.id === current ? " on" : ""}" data-id="${d.id}">
        ${def.svg(d.id)}
        <b>${d.name}</b><p>${d.desc}</p>
        <span class="tags">${d.tags.map((t) => `<i>${t}</i>`).join("")}</span>
      </button>`).join("");
  }
  function openPicker(part: Part) {
    if (shapeCur.kind === ShapeKind.W17 && (part === "front" || part === "rear")) { flashStepper(part); return; }
    if (shapeCur.kind !== ShapeKind.F1 && !(shapeCur.kind === ShapeKind.W17 && (part === "front" || part === "rear"))) return;
    pickerPart = part;
    renderPicker();
    const safe = safeArea();
    const width = Math.min(900, safe.right - safe.left - 16);
    picker.style.width = `${width}px`;
    picker.style.left = `${(safe.left + safe.right) / 2}px`;
    picker.hidden = false;
  }
  const closePicker = () => { picker.hidden = true; pickerPart = null; };
  function setPart(part: Part, id: number) {
    const def = partDef(part);
    shapeTarget[def.key] = shapeCur[def.key] = id;
    const nameEl = document.querySelector<HTMLElement>(`.part-btn[data-part="${part}"] b`);
    if (nameEl) nameEl.textContent = def.items[id].name;
    engine.setShape(shapeCur);
    requestWingLoads();
    markChange(def.focus, `${def.short}: ${def.items[id].name}`);
    renderPicker();
  }
  $("pickerGrid").addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (card && pickerPart) setPart(pickerPart, Number(card.dataset.id));
  });
  $("pickerClose").addEventListener("click", closePicker);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".part-btn")) {
    b.addEventListener("click", () => (pickerPart === b.dataset.part ? closePicker() : openPicker(b.dataset.part as Part)));
  }


  onSeg("colorSeg", "c", (v) => setColor(Number(v) as ColorField));
  const setFlow = (mode: FlowMode) => {
    view.flowMode = mode;
    setSeg("partSeg", "p", String(mode));
    engine.setView(view);
  };
  onSeg("partSeg", "p", (v) => setFlow(Number(v) as FlowMode));
  const setColor = (c: ColorField) => {
    view.colorField = c;
    setSeg("colorSeg", "c", String(c));
    engine.setView(view);
    updateLegend();
  };
  const setSurface = (on: boolean) => {
    view.surfaceField = on;
    $<HTMLInputElement>("surface").checked = on;
    engine.setView(view);
  };
  const setSlice = (axis: 0 | 1 | 2 | 3) => {
    view.sliceAxis = axis;
    setSeg("sliceSeg", "s", String(axis));
    $("slicePosRow").hidden = axis === 0;
    engine.setView(view);
  };
  const setLabels = (on: boolean) => {
    labelsOn = on;
    $<HTMLInputElement>("labelsOn").checked = on;
    $("labels").hidden = !on;
  };
  $<HTMLInputElement>("labelsOn").addEventListener("change", (e) => setLabels((e.target as HTMLInputElement).checked));


  const PRESETS: Record<string, () => void> = {
    show: () => { setColor(ColorField.Speed); setSurface(false); setSlice(0); setFlow(FlowMode.Streamlines); setLabels(true); Object.assign(orbitGoal, CAMERA_PRESETS.side); },
    cfd: () => { setColor(ColorField.Pressure); setSurface(true); setSlice(0); setFlow(FlowMode.None); setLabels(false); Object.assign(orbitGoal, CAMERA_PRESETS.front); },
    vortex: () => { setColor(ColorField.Speed); setSurface(false); setSlice(0); setFlow(FlowMode.Vortices); setLabels(false); Object.assign(orbitGoal, CAMERA_PRESETS.frontWing); orbitGoal.target = [1.6, 0.35, 0.3]; },
    heat: () => { setColor(ColorField.Temperature); setSurface(true); setSlice(0); setFlow(FlowMode.Fog); setLabels(false); Object.assign(orbitGoal, CAMERA_PRESETS.rear); },
    wake: () => {
      setColor(ColorField.Wake); setSurface(false); setFlow(FlowMode.None); setLabels(false);
      setSlice(1);
      slicePosInput.value = String(WAKE_RAKE_T);
      applySlicePos();
      Object.assign(orbitGoal, CAMERA_PRESETS.wake);
      orbitGoal.target = [5.6, 0.55, 0];
    },
  };
  onSeg("presetSeg", "preset", (v) => {
    setSeg("presetSeg", "preset", v);
    if (!isRaceCar(shapeCur.kind) && shapeCur.kind !== ShapeKind.Empty) setKind(engine.hasCarModel ? ShapeKind.W17 : ShapeKind.F1);
    orbitGoal.target = [2.75, 0.42, 0];
    PRESETS[v]();
  });
  const slicePosInput = $<HTMLInputElement>("slicePos");
  const applySlicePos = () => {
    if (view.sliceAxis === 0) return;
    const axis = view.sliceAxis;
    const t = Number(slicePosInput.value);
    slicePosByAxis[axis] = t;
    const [lo, hi] = SLICE_RANGES[axis];
    view.slicePos = lo + (hi - lo) * t;
    const label = axis === 1 ? `x = ${view.slicePos.toFixed(2)} m` : axis === 2 ? `altura ${view.slicePos.toFixed(2)} m` : `${view.slicePos.toFixed(2)} m del centro`;
    $("slicePosVal").textContent = label;
    engine.setView(view);
  };
  slicePosInput.addEventListener("input", applySlicePos);
  onSeg("sliceSeg", "s", (v) => {
    setSlice(Number(v) as 0 | 1 | 2 | 3);
    if (view.sliceAxis !== 0) slicePosInput.value = String(slicePosByAxis[view.sliceAxis]);
    applySlicePos();
  });
  applySlicePos();
  $("slicePosRow").hidden = true;
  $<HTMLInputElement>("surface").addEventListener("change", (e) => setSurface((e.target as HTMLInputElement).checked));

  setSeg("qualitySeg", "q", quality);
  onSeg("qualitySeg", "q", (q) => {
    if (q === quality) return;
    const u = new URL(location.href);
    u.searchParams.set("q", q);
    location.href = u.toString();
  });
  $("reset").addEventListener("click", () => { engine.reset(); resetChart(); });

  $("panelToggle").addEventListener("click", () => $("controls").classList.toggle("open"));

  // ---------- Camera ----------
  for (const b of document.querySelectorAll<HTMLButtonElement>(".cams button")) {
    b.addEventListener("click", () => Object.assign(orbitGoal, CAMERA_PRESETS[b.dataset.cam!]));
  }
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const hideHint = () => { $("dragHint").style.opacity = "0"; };
  setTimeout(hideHint, 7000);
  let press: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    press = { x: e.clientX, y: e.clientY, t: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add("dragging");
    hideHint();
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) { canvas.classList.toggle("pick", pickPart(e.clientX, e.clientY) !== null); return; }
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      orbitGoal.yaw += (cur.x - prev.x) * 0.006;
      orbitGoal.pitch = Math.min(1.5, Math.max(0.01, orbitGoal.pitch + (cur.y - prev.y) * 0.005));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) orbitGoal.distance = Math.min(22, Math.max(2.5, orbitGoal.distance * (pinchDist / d)));
      pinchDist = d;
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", (e) => {
    const wasTap = press && pointers.size === 1 && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6 && performance.now() - press.t < 400;
    endPointer(e);
    press = null;
    if (!wasTap) return;
    const part = pickPart(e.clientX, e.clientY);
    if (part) openPicker(part);
    else if (!picker.hidden) closePicker();
  });
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbitGoal.distance = Math.min(22, Math.max(2.5, orbitGoal.distance * Math.exp(e.deltaY * 0.0012)));
    hideHint();
  }, { passive: false });

  // ---------- Wing loads (panel method) ----------
  // On the W17 the wing forces come from a vortex lattice solve on the real wing sections; the
  // lattice Boltzmann grid is too coarse to resolve thin slotted elements (see README).
  type Loads = { downforceN: number; dragN: number; copX: number; dragY: number };
  let wingLoads: { front: Loads; rear: Loads } | null = null;
  let vlmWorker: Worker | null = null;
  let vlmRequest = 0;
  let vlmTimer = 0;
  const requestWingLoads = () => {
    if (!vlmWorker || shapeCur.kind !== ShapeKind.W17) return;
    clearTimeout(vlmTimer);
    vlmTimer = window.setTimeout(() => {
      const front = W17_FRONT_LEVELS[shapeCur.frontWing] ?? W17_FRONT_LEVELS[0];
      const rear = W17_REAR_LEVELS[shapeCur.rearWing] ?? W17_REAR_LEVELS[0];
      vlmWorker!.postMessage({
        id: ++vlmRequest,
        setup: {
          frontDeg: shapeCur.frontFlapDeg + front.flap,
          rearFlapDeg: shapeCur.rearFlapDeg + rear.flap,
          rearMainDeg: rear.main + shapeCur.rearMainDeg,
          rideH: shapeCur.rideH,
          rearRideH: shapeCur.rearRideH,
          gurney: shapeCur.gurney,
          frontOn: shapeCur.frontWingOn,
          rearOn: shapeCur.rearWingOn,
          rearTwistDeg: REAR_TWIST_DEG[shapeCur.rearShape] ?? 0,
          flapScale: shapeCur.thinWings ? 0.72 : 1,
        },
        speed: view.kmh / 3.6,
      });
    }, 60);
  };
  const startWingSolver = (rig: RigData) => {
    vlmWorker = new Worker(new URL("./engine/vlm-worker.ts", import.meta.url), { type: "module" });
    vlmWorker.onmessage = (e: MessageEvent<{ id: number; loads: { front: Loads; rear: Loads } }>) => {
      if (e.data.id === vlmRequest) wingLoads = e.data.loads;
    };
    vlmWorker.postMessage({ id: 0, rig, setup: { frontDeg: 0, rearFlapDeg: 0, rearMainDeg: 0, rideH: 0.12, rearRideH: 0.14, gurney: false, frontOn: true, rearOn: true, rearTwistDeg: 0, flapScale: 1 }, speed: 1 });
    requestWingLoads();
  };
  // Body loads: the tunnel's wake oscillates slowly (±50 kg), so the body is reported through its
  // long-run coefficients (≈12 s average), normalised by dynamic pressure so speed changes apply
  // at once. Cooling and sidepod packages add calibrated deltas: they act mostly through internal
  // flow and fine details the grid cannot resolve.
  const bodyCoef = { cd: 0, cl: 0, n: 0 };
  const resetBodyCoef = () => { bodyCoef.n = 0; };
  const withPanelWings = (f: Forces): Forces => {
    if (shapeCur.kind !== ShapeKind.W17 || !wingLoads) return f;
    const q = 0.5 * AIR_DENSITY * (view.kmh / 3.6) ** 2;
    const a = bodyCoef.n < 20 ? 0.15 : bodyCoef.n < 60 ? 0.04 : 0.011;
    bodyCoef.cd += (f.body.drag / q - bodyCoef.cd) * (bodyCoef.n === 0 ? 1 : a);
    bodyCoef.cl += (f.body.down / q - bodyCoef.cl) * (bodyCoef.n === 0 ? 1 : a);
    bodyCoef.n++;
    const pods = SIDEPOD_COEF[shapeCur.sidepods] ?? SIDEPOD_COEF[0];
    const cool = COOLING_COEF[shapeCur.cooling] ?? COOLING_COEF[1];
    const fw = { drag: wingLoads.front.dragN, down: wingLoads.front.downforceN };
    const rw = { drag: wingLoads.rear.dragN, down: wingLoads.rear.downforceN };
    const body = { drag: (bodyCoef.cd + pods.cd + cool.cd) * q, down: (bodyCoef.cl + pods.cl + cool.cl) * q };
    return {
      ...f,
      body,
      frontWing: fw,
      rearWing: rw,
      dragN: body.drag + fw.drag + rw.drag,
      downforceN: body.down + fw.down + rw.down,
    };
  };

  // Share of the wing downforce carried by the front axle, from the moments of each wing's load
  // (at its centre of pressure) about the contact patches. The rear wing sits behind the rear
  // axle, so it slightly unloads the front. The body is left out: at this grid resolution the
  // floor produces lift, which would distort the balance.
  const AXLE_FRONT = 1.0, AXLE_REAR = 4.4;
  const frontAxleShare = (): number | undefined => {
    if (!wingLoads || shapeCur.kind !== ShapeKind.W17) return undefined;
    const wb = AXLE_REAR - AXLE_FRONT;
    const wings = [wingLoads.front, wingLoads.rear];
    const total = wings.reduce((a, w) => a + w.downforceN, 0);
    if (total < 100) return undefined;
    return wings.reduce((a, w) => a + w.downforceN * (AXLE_REAR - w.copX) / wb, 0) / total;
  };

  // ---------- Telemetry ----------
  type Sample = { t: number; drag: number; down: number; fd: number; fdd: number; rd: number; rdd: number; bd: number; bdd: number };
  type Focus = "total" | "front" | "rear" | "body";
  const FOCUS_KEYS: Record<Focus, { drag: keyof Sample; down: keyof Sample; name: string }> = {
    total: { drag: "drag", down: "down", name: "Auto completo" },
    front: { drag: "fd", down: "fdd", name: "Alerón delantero" },
    rear: { drag: "rd", down: "rdd", name: "Alerón trasero" },
    body: { drag: "bd", down: "bdd", name: "Carrocería, piso y ruedas" },
  };
  const FORCE_KEYS = ["drag", "down", "fd", "fdd", "rd", "rdd", "bd", "bdd"] as const;
  const AVG_WINDOW_MS = 3000;
  const CHART_POINTS = 220;
  const recent: Sample[] = [];
  const smoothed: Sample = { t: 0, drag: 0, down: 0, fd: 0, fdd: 0, rd: 0, rdd: 0, bd: 0, bdd: 0 };
  const history: Sample[] = [];
  const markers: { t: number; label: string }[] = [];
  let focus: Focus = "total";
  let change: { t: number; label: string; base: Sample } | null = null;
  const WARMUP_MS = 2500;
  let warmupUntil = performance.now() + WARMUP_MS;
  const resetChart = () => {
    history.length = 0; recent.length = 0; markers.length = 0; change = null;
    resetBodyCoef();
    warmupUntil = performance.now() + WARMUP_MS;
  };

  function setFocus(f: Focus) {
    focus = f;
    $("chartFocus").textContent = f === "total" ? FOCUS_KEYS[f].name : `${FOCUS_KEYS[f].name}  ✕`;
    if (recent.length) renderTelemetry();
  }

  function markChange(f: Focus, label: string) {
    if (quietChanges) return;
    if (!isRaceCar(shapeCur.kind) && f !== "total") f = "total";
    if (focus !== f) setFocus(f);
    const now = performance.now();
    const last = markers[markers.length - 1];
    if (last && now - last.t < 1200) { last.t = now; last.label = label; }
    else markers.push({ t: now, label });
    if (!change || now - change.t > 1200) change = { t: now, label, base: { ...smoothed } };
    else { change.t = now; change.label = label; }
  }

  engine.onForces = (lbm: Forces) => {
    const now = performance.now();
    if (now < warmupUntil) return;
    const f = withPanelWings(lbm);
    aeroMap.sample(f.downforceN, f.dragN);
    const raw: Sample = {
      t: now, drag: f.dragN, down: f.downforceN,
      fd: f.frontWing.drag, fdd: f.frontWing.down, rd: f.rearWing.drag, rdd: f.rearWing.down, bd: f.body.drag, bdd: f.body.down,
    };
    recent.push(raw);
    while (recent.length > 1 && now - recent[0].t > AVG_WINDOW_MS) recent.shift();
    for (const k of FORCE_KEYS) smoothed[k] = recent.reduce((acc, r) => acc + r[k], 0) / recent.length;
    const last = history[history.length - 1];
    const point = { ...raw };
    if (last) for (const k of FORCE_KEYS) point[k] = last[k] + (raw[k] - last[k]) * 0.35;
    history.push(point);
    if (history.length > CHART_POINTS) history.shift();
    while (markers.length && markers[0].t < history[0].t) markers.shift();
    renderTelemetry();
  };

  const fmtKg = (n: number) => `${Math.round(n / KGF).toLocaleString("es-AR")} kg`;
  const chart = $<HTMLCanvasElement>("chart");
  const cctx = chart.getContext("2d")!;

  const niceStep = (range: number) => {
    const raw = range / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  };

  function drawChart() {
    const { width: w, height: h } = chart;
    cctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;
    const keys = FOCUS_KEYS[focus];
    const val = (s: Sample, k: keyof Sample) => s[k] / KGF;
    let lo = 0, hi = 0;
    for (const s of history) { lo = Math.min(lo, val(s, keys.drag), val(s, keys.down)); hi = Math.max(hi, val(s, keys.drag), val(s, keys.down)); }
    const step = niceStep(Math.max(hi - lo, 30));
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const padB = 10, labelW = 78, rowH = 24, maxRows = 2;
    const x = (i: number) => labelW + (i / (CHART_POINTS - 1)) * (w - labelW);
    const off = CHART_POINTS - history.length;

    cctx.font = "20px ui-monospace, SFMono-Regular, Menlo, monospace";
    const rows: [number, number][][] = Array.from({ length: maxRows }, () => []);
    const placed = markers.map((m) => {
      let i = history.findIndex((s) => s.t >= m.t);
      if (i < 0) i = history.length - 1;
      return { xx: Math.round(x(i + off)) + 0.5, label: m.label, row: -1, lx: 0 };
    });
    for (let k = placed.length - 1; k >= 0; k--) {
      const p = placed[k];
      const tw = cctx.measureText(p.label).width;
      const lx = p.xx + 6 + tw <= w - 2 ? p.xx + 6 : Math.max(labelW, p.xx - 6 - tw);
      const span: [number, number] = [lx - 8, lx + tw + 8];
      const r = rows.findIndex((row) => row.every(([a, b]) => span[1] <= a || span[0] >= b));
      if (r < 0) continue;
      rows[r].push(span);
      p.row = r;
      p.lx = lx;
    }
    const usedRows = rows.filter((r) => r.length).length;
    const padT = 10 + usedRows * rowH;
    const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
    cctx.textAlign = "right";
    cctx.textBaseline = "middle";
    for (let v = lo; v <= hi + 1e-6; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      cctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.08)";
      cctx.lineWidth = v === 0 ? 2 : 1;
      cctx.beginPath(); cctx.moveTo(labelW, yy); cctx.lineTo(w, yy); cctx.stroke();
      cctx.fillStyle = v === 0 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)";
      cctx.fillText(`${Math.round(v)}`, labelW - 10, yy);
    }

    cctx.textAlign = "left";
    cctx.textBaseline = "top";
    for (const p of placed) {
      const labelled = p.row >= 0;
      cctx.strokeStyle = labelled ? "rgba(0,210,190,0.8)" : "rgba(0,210,190,0.35)";
      cctx.lineWidth = 2;
      cctx.setLineDash([6, 6]);
      cctx.beginPath(); cctx.moveTo(p.xx, labelled ? 4 + p.row * rowH : padT); cctx.lineTo(p.xx, h - padB); cctx.stroke();
      cctx.setLineDash([]);
      if (!labelled) continue;
      cctx.fillStyle = p.row === 0 ? "rgba(140,247,236,0.95)" : "rgba(140,247,236,0.7)";
      cctx.fillText(p.label, p.lx, 2 + p.row * rowH);
    }

    const line = (key: keyof Sample, color: string) => {
      cctx.strokeStyle = color;
      cctx.lineWidth = 3;
      cctx.lineJoin = "round";
      cctx.beginPath();
      history.forEach((s, i) => { if (i === 0) cctx.moveTo(x(i + off), y(val(s, key))); else cctx.lineTo(x(i + off), y(val(s, key))); });
      cctx.stroke();
    };
    line(keys.drag, "#ff5a5f");
    line(keys.down, "#00d2be");
  }

  function renderChange() {
    const el = $("chartDelta");
    if (!change) { el.hidden = true; return; }
    const keys = FOCUS_KEYS[focus];
    const elapsed = performance.now() - change.t;
    el.hidden = false;
    if (elapsed < AVG_WINDOW_MS + 500) {
      el.innerHTML = `<b>${change.label}</b> · midiendo el efecto…`;
      return;
    }
    const sign = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n / KGF))} kg`;
    const dDown = smoothed[keys.down] - change.base[keys.down];
    const dDrag = smoothed[keys.drag] - change.base[keys.drag];
    el.innerHTML = `<b>${change.label}</b> · ${keys.name.toLowerCase()}: carga <span class="d-down">${sign(dDown)}</span> · drag <span class="d-drag">${sign(dDrag)}</span>`;
  }

  function renderTelemetry() {
    if (isRaceCar(shapeCur.kind)) {
      renderPerformance({
        bodyDragN: smoothed.bd, bodyDownN: smoothed.bdd, wingDragN: smoothed.fd + smoothed.rd,
        frontDownN: smoothed.fdd, rearDownN: smoothed.rdd, kmh: view.kmh, frontAxleShare: frontAxleShare(),
      });
    }
    $("drag").textContent = fmtKg(smoothed.drag);
    $("down").textContent = smoothed.down < 0 ? `${fmtKg(smoothed.down)} ↑` : fmtKg(smoothed.down);
    $("down").title = smoothed.down < 0 ? "Negativo: el objeto tiende a levantarse (sustentación)" : "";
    $("ld").textContent = Math.abs(smoothed.drag) > 1 ? (smoothed.down / smoothed.drag).toFixed(2) : "—";
    const q = 0.5 * AIR_DENSITY * (view.kmh / 3.6) ** 2;
    $("cda").textContent = `${(smoothed.drag / q).toFixed(2)} m²`;
    drawChart();
    renderChange();

    const bd = $("breakdown");
    if (!isRaceCar(shapeCur.kind)) { bd.innerHTML = ""; return; }
    const rows: [Focus, string, number, number][] = [
      ["front", "Alerón delantero", smoothed.fdd, smoothed.fd],
      ["rear", "Alerón trasero", smoothed.rdd, smoothed.rd],
      ["body", "Carrocería y piso", smoothed.bdd, smoothed.bd],
    ];
    const scale = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r[2]), Math.abs(r[3]))));
    const kg = (n: number) => Math.round(n / KGF);
    bd.innerHTML = rows.map(([key, name, down, drag]) => `
      <button class="comp${focus === key ? " on" : ""}" data-focus="${key}">
        <span class="stat-label">${name}</span>
        <span class="comp-vals">
          <b class="v-down" title="${down < 0 ? "Sustentación" : "Carga"}">${down < 0 ? "↑" : ""}${Math.abs(kg(down))}<small>kg</small></b>
          <b class="v-drag" title="Resistencia">${kg(drag)}<small>kg</small></b>
        </span>
        <span class="stat-bar down${down < 0 ? " lift" : ""}"><i style="width:${(Math.abs(down) / scale) * 100}%"></i></span>
        <span class="stat-bar drag"><i style="width:${(Math.abs(drag) / scale) * 100}%"></i></span>
      </button>`).join("");
  }
  $("breakdown").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-focus]");
    if (row) setFocus(focus === row.dataset.focus ? "total" : (row.dataset.focus as Focus));
  });
  $("chartFocus").addEventListener("click", () => setFocus("total"));

  // ---------- Legend ----------
  function updateLegend() {
    const c = view.colorField;
    $("legendBar").style.background = paletteGradient(c);
    const set = (title: string, a: string, b: string, cc: string) => {
      $("legendTitle").textContent = title;
      $("legendMin").textContent = a;
      $("legendMid").textContent = b;
      $("legendMax").textContent = cc;
    };
    if (c === ColorField.Speed) set("Velocidad del aire", "0", `${Math.round(view.kmh * 0.75)}`, `${Math.round(view.kmh * 1.5)} km/h`);
    else if (c === ColorField.Pressure) set("Presión (coef. Cp)", "−1.1 succión", "−0.2", "+0.7 presión");
    else if (c === ColorField.Temperature) {
      const [lo, hi] = engine.temperatureRange();
      const digits = hi - lo < 10 ? 1 : 0;
      set("Temperatura del aire", `${lo.toFixed(digits)} °C`, `${((lo + hi) / 2).toFixed(digits)}`, `${hi.toFixed(digits)} °C`);
    } else if (c === ColorField.Wake) set("Estela · aire frenado por el auto", "aire limpio", "", "aire sucio");
    else set("Vorticidad (remolinos)", "baja", "", "alta");
  }
  updateLegend();

  // ---------- Labels ----------
  const svg = $("labelSvg") as unknown as SVGSVGElement;
  const labelHost = $("labels");
  type LabelDef = { key: "frontWing" | "floor" | "diffuser" | "rearWing"; title: string; sub: string; value: () => string };
  const LABELS: LabelDef[] = [
    { key: "frontWing", title: "Alerón delantero", sub: "", value: () => `carga ${fmtKg(smoothed.fdd)}` },
    { key: "floor", title: "Piso y carrocería", sub: "", value: () => `${smoothed.bdd >= 0 ? "carga" : "sustentación"} ${fmtKg(Math.abs(smoothed.bdd))}` },
    { key: "diffuser", title: "Difusor", sub: "", value: () => "" },
    { key: "rearWing", title: "Alerón trasero", sub: "", value: () => `carga ${fmtKg(smoothed.rdd)} · drag ${fmtKg(smoothed.rd)}` },
  ];
  const labelEls = LABELS.map((l) => {
    const el = document.createElement("div");
    el.className = "callout";
    if (l.key === "frontWing" || l.key === "rearWing") {
      const part: Part = l.key === "frontWing" ? "front" : "rear";
      el.classList.add("pickable");
      // pointerdown, because the label is re-rendered every frame and a click could be lost.
      el.addEventListener("pointerdown", (e) => {
        const step = (e.target as HTMLElement).closest<HTMLElement>("[data-step]");
        e.stopPropagation();
        const mount = $<HTMLInputElement>(part === "front" ? "frontOn" : "rearOn");
        if (!mount.checked || (e.target as HTMLElement).closest("[data-eject]")) { mount.click(); return; }
        if (!step) { openPicker(part); return; }
        const input = $<HTMLInputElement>(part);
        if (input.disabled) return;
        const v = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + Number(step.dataset.step)));
        if (String(v) === input.value) return;
        input.value = String(v);
        input.dispatchEvent(new Event("input"));
      });
    }
    labelHost.appendChild(el);
    return el;
  });

  const safeArea = () => {
    const c = $("controls").getBoundingClientRect();
    const t = $("telemetry").getBoundingClientRect();
    const narrow = window.innerWidth < 760;
    return {
      left: narrow ? 8 : c.right + 8,
      right: narrow ? window.innerWidth - 8 : t.left - 8,
      top: 90,
      bottom: window.innerHeight - (narrow ? 110 : 220),
    };
  };
  const project = (vp: Float32Array, p: readonly number[]): [number, number] | null => {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (w < 0.1) return null;
    return [((x / w + 1) / 2) * window.innerWidth, ((1 - y / w) / 2) * window.innerHeight];
  };

  let lastCam: ReturnType<typeof orbitCamera> | null = null;
  function pickPart(cx: number, cy: number): Part | null {
    if (!lastCam || !isRaceCar(shapeCur.kind)) return null;
    const cam = lastCam;
    const a = f1Anchors(shapeCur.rideH);
    const b = shapeCur.rideH;
    const ndcX = (cx / window.innerWidth) * 2 - 1;
    const ndcY = 1 - (cy / window.innerHeight) * 2;
    const t = Math.tan(cam.fovY / 2);
    const aspect = window.innerWidth / window.innerHeight;
    const dir = [0, 1, 2].map((i) => cam.fwd[i] + ndcX * t * aspect * cam.right[i] + ndcY * t * cam.up[i]);
    const boxes: [Part, number[], number[]][] = shapeCur.kind === ShapeKind.W17 ? [
      ["front", w17Place(shapeCur, -0.3, 0.12, -0.72), w17Place(shapeCur, 0.65, 0.52, 0.72)],
      ["rear", w17Place(shapeCur, 4.5, 0.6, -0.6), w17Place(shapeCur, 5.2, 1.06, 0.6)],
    ] : [
      ["front", [-0.1, 0.02, -0.94], [0.62, a.yw + 0.4, 0.94]],
      ["rear", [4.55, b + 0.3, -0.51], [5.42, b + 1.12, 0.51]],
      ["nose", [0.0, b + 0.05, -0.2], [1.25, b + 0.5, 0.2]],
      ["cover", [2.85, b + 0.42, -0.3], [4.45, b + 1.0, 0.3]],
      ["sidepod", [2.1, b + 0.08, 0.24], [4.05, b + 0.68, 0.8]],
      ["sidepod", [2.1, b + 0.08, -0.8], [4.05, b + 0.68, -0.24]],
    ];
    let best: Part | null = null;
    let bestT = Infinity;
    for (const [part, mn, mx] of boxes) {
      if (shapeCur.kind === ShapeKind.W17 && part !== "front" && part !== "rear") continue;
      let t0 = 0, t1 = Infinity;
      for (let i = 0; i < 3; i++) {
        const inv = 1 / (dir[i] || 1e-9);
        let ta = (mn[i] - cam.pos[i]) * inv, tb = (mx[i] - cam.pos[i]) * inv;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 < bestT) { bestT = t0; best = part; }
    }
    return best;
  }

  function updateLabels(vp: Float32Array) {
    const show = labelsOn && isRaceCar(shapeCur.kind);
    labelHost.hidden = !show;
    if (!show) return;
    const a = carAnchors(shapeCur);
    const center = project(vp, a.center);
    let lines = "";
    LABELS.forEach((l, i) => {
      const el = labelEls[i];
      const p = project(vp, a[l.key]);
      if (!p || !center) { el.style.display = "none"; return; }
      let dx = p[0] - center[0], dy = p[1] - center[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      if (l.key === "floor") { dx = 0; dy = 1; }
      const reach = Math.min(window.innerWidth, window.innerHeight) * 0.14;
      const safe = safeArea();
      const lx = Math.min(safe.right - 20, Math.max(safe.left + 20, p[0] + dx * reach));
      const ly = Math.min(safe.bottom - 20, Math.max(safe.top + 20, p[1] + dy * reach * 0.8));
      if (lx - safe.left < 140) dx = 1; else if (safe.right - lx < 140) dx = -1;
      lines += `<line x1="${p[0]}" y1="${p[1]}" x2="${lx}" y2="${ly}" /><circle cx="${p[0]}" cy="${p[1]}" r="3.5" />`;
      el.style.display = "block";
      el.style.transform = `translate(${lx}px, ${ly}px) translate(${dx < -0.3 ? "-100%" : dx > 0.3 ? "0" : "-50%"}, ${dy > 0.3 ? "4px" : dy < -0.3 ? "calc(-100% - 4px)" : "-50%"})`;
      const value = recent.length > 0 ? l.value() : "";
      const pickable = isRaceCar(shapeCur.kind) && (l.key === "frontWing" || l.key === "rearWing");
      el.classList.toggle("pickable", pickable);
      const wingInput = l.key === "frontWing" ? "front" : "rear";
      const model = !pickable ? "" : shapeCur.kind === ShapeKind.W17
        ? `ala ${$<HTMLInputElement>(wingInput).value}`
        : partDef(wingInput).items[l.key === "frontWing" ? shapeCur.frontWing : shapeCur.rearWing]?.name ?? "";
      const title = straightMode && (l.key === "rearWing" || l.key === "frontWing") ? `${l.title} · abierto` : l.title;
      const fitted = l.key === "frontWing" ? shapeTarget.frontWingOn : l.key === "rearWing" ? shapeTarget.rearWingOn : true;
      const locked = straightMode;
      const adjust = !pickable ? "" : !fitted ? `<i class="cl-mount">fuera del auto · <span class="cl-go">montar ▸</span></i>` : shapeCur.kind === ShapeKind.W17
        ? `<span class="cl-adj${locked ? " locked" : ""}"><button data-step="-1" aria-label="Menos">−</button><i>${model}</i><button data-step="1" aria-label="Más">+</button><button class="cl-eject" data-eject="1" title="Quitar alerón" aria-label="Quitar alerón"><svg viewBox="0 0 24 24"><path d="M12 5 5 13h14z" /><path d="M5 18h14" /></svg></button></span>`
        : `<i>${model} · ajustar ▸</i>`;
      const html = `<b>${title}</b>${l.sub ? `<span>${l.sub}</span>` : ""}${value && fitted ? `<em>${value}</em>` : ""}${adjust}`;
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    });

    svg.innerHTML = lines;
  }

  // ---------- Car model ----------
  const decodeImage = async (bytes: Uint8Array, mime: string): Promise<DecodedImage> => {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const data = new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
    return { width: bitmap.width, height: bitmap.height, data };
  };
  const loadCarModel = async () => {
    const base = import.meta.env.BASE_URL;
    const get = (name: string) => fetch(`${base}models/${name}`).then((r) => {
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return r;
    });
    const withProgress = async (r: Response) => {
      const total = Number(r.headers.get("content-length")) || 0;
      if (!total || !r.body) return r.arrayBuffer();
      const out = new Uint8Array(total);
      const reader = r.body.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.set(value, got);
        got += value.length;
        const pct = Math.round((got / total) * 85);
        $("loadingBar").style.width = `${pct}%`;
        $("loadingPct").textContent = `${pct}%`;
      }
      return out.buffer;
    };
    const [glb, sdf, parts, rigBin, rig] = await Promise.all([
      get("w17.glb").then(withProgress),
      get("w17.sdf.bin").then((r) => r.arrayBuffer()),
      get("w17.parts.bin").then((r) => r.arrayBuffer()),
      get("w17.rig.bin").then((r) => r.arrayBuffer()),
      get("w17.rig.json").then((r) => r.json() as Promise<RigData>),
    ]);
    rigData = rig;
    startWingSolver(rig);
    $("loadingText").textContent = "Preparando texturas";
    $("loadingPct").textContent = "90%";
    $("loadingBar").style.width = "90%";
    const mesh = await MeshCar.load(V, gpu, glb, new Uint8Array(rigBin), decodeImage, rig.wings.rear[rig.wings.rear.length - 1]);
    $("loadingBar").style.width = "100%";
    $("loadingPct").textContent = "100%";
    engine.setCarModel(mesh, new Uint16Array(sdf), new Uint16Array(parts), rig);
    view.flowMode = flowAfterLoad;
    engine.setView(view);
    if (shapeCur.kind === ShapeKind.Empty) setKind(ShapeKind.W17);
    $("loading").classList.add("done");
    window.setTimeout(setReference, 9000);
  };
  loadCarModel().catch((err) => {
    console.error("car model failed to load", err);
    $("loading").classList.add("done");
    view.flowMode = flowAfterLoad;
    engine.setView(view);
    if (shapeCur.kind === ShapeKind.Empty) setKind(ShapeKind.F1);
  });

  // ---------- Frame loop ----------
  let steps = 6;
  let last = performance.now();
  let emaDt = 16.7;
  let frames = 0;
  let fpsAcc = 0;
  let fpsShown = 0;
  let failed = false;
  let renderScale = 0.8;
  let scaleCheck = 0;
  engine.setRenderScale(renderScale);

  const animKeys = ["frontFlapDeg", "rearFlapDeg", "rearMainDeg", "rideH", "rearRideH", "aoaDeg", "customWidth"] as const;

  const tick = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    emaDt += (dt - emaDt) * 0.05;
    frames++;
    fpsAcc += dt;
    if (fpsAcc > 500) {
      fpsShown = (frames * 1000) / fpsAcc;
      frames = 0;
      fpsAcc = 0;
      $("perf").textContent = `${Math.round(fpsShown)} fps`;
      if (emaDt > 21 && steps > 2) steps -= 2;
      else if (emaDt < 17.6 && steps < 12) steps += 2;
      if (++scaleCheck % 4 === 0) {
        if (fpsShown < 45 && renderScale > 0.6) renderScale = Math.max(0.6, renderScale - 0.1);
        else if (fpsShown > 58 && renderScale < 1) renderScale = Math.min(1, renderScale + 0.05);
        engine.setRenderScale(renderScale);
      }
    }

    let changed = false;
    for (const k of animKeys) {
      const d = shapeTarget[k] - shapeCur[k];
      if (Math.abs(d) > 1e-3) {
        shapeCur[k] = Math.abs(d) < 0.02 ? shapeTarget[k] : shapeCur[k] + d * 0.18;
        changed = true;
      }
    }
    if (changed) { engine.setShape(shapeCur); requestWingLoads(); }

    const k = 1 - Math.pow(0.001, dt / 1000);
    orbit.yaw += (orbitGoal.yaw - orbit.yaw) * k;
    orbit.pitch += (orbitGoal.pitch - orbit.pitch) * k;
    orbit.distance += (orbitGoal.distance - orbit.distance) * k;
    for (let i = 0; i < 3; i++) orbit.target[i] += (orbitGoal.target[i] - orbit.target[i]) * k;

    const size = surf.size;
    const cam = orbitCamera(orbit, size[0] / size[1]);
    try {
      engine.frame(surf, cam, steps, dt / 1000);
    } catch (err) {
      if (!failed) console.error(err);
      failed = true;
    }
    lastCam = cam;
    updateLabels(cam.viewProj);
    if (view.colorField === ColorField.Temperature && frames % 30 === 0) updateLegend();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

boot();
