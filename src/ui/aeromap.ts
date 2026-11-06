// Aero map: sweeps front × rear ride height in the tunnel and fills a heat map as it measures,
// like the ride-height maps teams build in a real wind tunnel.

export interface AeroMapHooks {
  setHeights: (front: number, rear: number) => void;
  getHeights: () => [number, number];
  /** Current front-axle share of the wing downforce, if known. */
  balance: () => number | undefined;
  onApply: (front: number, rear: number) => void;
}

type Metric = "down" | "eff" | "bal";
interface Cell { down: number; eff: number; bal: number }

const FRONT = [0.08, 0.11, 0.14, 0.17, 0.2];
const REAR = [0.1, 0.14, 0.18, 0.22, 0.26];
const SETTLE_MS = 1300;
const MEASURE_MS = 1900;
const KGF = 9.81;

const METRICS: Record<Metric, { label: string; unit: string; fmt: (v: number) => string; colors: [number, number, number][] }> = {
  down: { label: "Carga", unit: "kg", fmt: (v) => Math.round(v).toString(), colors: [[8, 22, 28], [0, 120, 112], [0, 210, 190], [190, 255, 246]] },
  eff: { label: "Eficiencia", unit: "L/D", fmt: (v) => v.toFixed(2), colors: [[14, 10, 30], [70, 50, 160], [160, 139, 255], [235, 228, 255]] },
  bal: { label: "Balance", unit: "% del.", fmt: (v) => Math.round(v * 100).toString(), colors: [[0, 160, 150], [28, 31, 34], [28, 31, 34], [255, 90, 95]] },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class AeroMap {
  private cells: (Cell | null)[][] = FRONT.map(() => REAR.map(() => null));
  private metric: Metric = "down";
  private running = false;
  private cancelled = false;
  private samples: { down: number; drag: number }[] | null = null;
  private current: [number, number] | null = null;
  private readonly canvas: HTMLCanvasElement;

  constructor(private hooks: AeroMapHooks) {
    this.canvas = $<HTMLCanvasElement>("mapCanvas");
    $("mapRun").addEventListener("click", () => (this.running ? this.cancel() : this.run()));
    $("mapClose").addEventListener("click", () => this.close());
    $("mapOpen").addEventListener("click", () => this.open());
    for (const b of document.querySelectorAll<HTMLElement>("#mapMetric button")) {
      b.addEventListener("click", () => {
        this.metric = b.dataset.m as Metric;
        for (const o of document.querySelectorAll<HTMLElement>("#mapMetric button")) o.classList.toggle("on", o === b);
        this.draw();
      });
    }
    this.canvas.addEventListener("click", (e) => this.pick(e));
    this.draw();
  }

  /** Feed every force reading; only used while a sweep point is being measured. */
  sample(downN: number, dragN: number) {
    this.samples?.push({ down: downN, drag: dragN });
  }

  open() {
    $("aeroMap").hidden = false;
    this.draw();
  }

  close() {
    if (this.running) this.cancel();
    $("aeroMap").hidden = true;
  }

  private cancel() {
    this.cancelled = true;
  }

  private async run() {
    this.running = true;
    this.cancelled = false;
    this.cells = FRONT.map(() => REAR.map(() => null));
    const restore = this.hooks.getHeights();
    $("mapRun").textContent = "Detener";
    const order: [number, number][] = [];
    FRONT.forEach((_, i) => {
      const cols = REAR.map((_, j) => j);
      if (i % 2) cols.reverse();
      for (const j of cols) order.push([i, j]);
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let k = 0; k < order.length && !this.cancelled; k++) {
      const [i, j] = order[k];
      this.current = [i, j];
      this.status(`Midiendo ${k + 1}/${order.length}`, k / order.length);
      this.hooks.setHeights(FRONT[i], REAR[j]);
      this.draw();
      await wait(SETTLE_MS);
      this.samples = [];
      await wait(MEASURE_MS);
      const s = this.samples;
      this.samples = null;
      if (!s.length || this.cancelled) continue;
      const down = s.reduce((a, x) => a + x.down, 0) / s.length;
      const drag = s.reduce((a, x) => a + x.drag, 0) / s.length;
      this.cells[i][j] = { down: down / KGF, eff: down / Math.max(drag, 1), bal: this.hooks.balance() ?? 0.5 };
      this.draw();
    }
    this.current = null;
    this.running = false;
    $("mapRun").textContent = "Repetir barrido";
    if (this.cancelled) {
      this.hooks.setHeights(restore[0], restore[1]);
      this.status("Barrido detenido", 0);
    } else {
      this.hooks.setHeights(restore[0], restore[1]);
      this.status("Tocá una celda para usar esas alturas", 1);
    }
    this.draw();
  }

  private status(text: string, progress: number) {
    $("mapStatus").textContent = text;
    $("mapProgress").style.width = `${Math.round(progress * 100)}%`;
  }

  private pick(e: MouseEvent) {
    if (this.running) return;
    const r = this.canvas.getBoundingClientRect();
    const { x0, y0, cw, ch } = this.layout();
    const scale = this.canvas.width / r.width;
    const px = (e.clientX - r.left) * scale, py = (e.clientY - r.top) * scale;
    const j = Math.floor((px - x0) / cw), i = FRONT.length - 1 - Math.floor((py - y0) / ch);
    if (i < 0 || j < 0 || i >= FRONT.length || j >= REAR.length || !this.cells[i][j]) return;
    this.hooks.onApply(FRONT[i], REAR[j]);
    this.draw();
  }

  private layout() {
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = 64, y0 = 12, x1 = W - 12, y1 = H - 52;
    return { W, H, x0, y0, cw: (x1 - x0) / REAR.length, ch: (y1 - y0) / FRONT.length };
  }

  private colorFor(v: number, lo: number, hi: number) {
    const stops = METRICS[this.metric].colors;
    const t = Math.min(1, Math.max(0, hi > lo ? (v - lo) / (hi - lo) : 0.5)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    const c = stops[k].map((a, n) => Math.round(a + (stops[k + 1][n] - a) * f));
    return `rgb(${c[0]} ${c[1]} ${c[2]})`;
  }

  private draw() {
    const ctx = this.canvas.getContext("2d")!;
    const { W, H, x0, y0, cw, ch } = this.layout();
    ctx.clearRect(0, 0, W, H);
    const m = METRICS[this.metric];
    const vals = this.cells.flat().filter((c): c is Cell => !!c).map((c) => c[this.metric]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (this.metric === "bal" && vals.length) {
      const mid = (lo + hi) / 2, span = Math.max(hi - lo, 0.02) / 2;
      lo = mid - span; hi = mid + span;
    }
    let best: [number, number] | null = null;
    if (vals.length && this.metric !== "bal") {
      let bv = -Infinity;
      this.cells.forEach((row, i) => row.forEach((c, j) => { if (c && c[this.metric] > bv) { bv = c[this.metric]; best = [i, j]; } }));
    }
    const [hf, hr] = this.hooks.getHeights();
    ctx.font = "600 22px 'Barlow Condensed', Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < FRONT.length; i++) {
      for (let j = 0; j < REAR.length; j++) {
        const x = x0 + j * cw, y = y0 + (FRONT.length - 1 - i) * ch;
        const c = this.cells[i][j];
        ctx.fillStyle = c ? this.colorFor(c[this.metric], lo, hi) : "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.roundRect(x + 3, y + 3, cw - 6, ch - 6, 8);
        ctx.fill();
        const isCurrent = this.current && this.current[0] === i && this.current[1] === j;
        const isSetup = !this.running && Math.abs(FRONT[i] - hf) < 0.005 && Math.abs(REAR[j] - hr) < 0.005;
        if (isCurrent || isSetup) {
          ctx.strokeStyle = isCurrent ? "#ffb23e" : "#ffffff";
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        if (c) {
          const bright = (c[this.metric] - lo) / Math.max(hi - lo, 1e-6) > 0.6 && this.metric !== "bal";
          ctx.fillStyle = bright ? "#03201d" : "#f2f4f5";
          ctx.fillText(m.fmt(c[this.metric]), x + cw / 2, y + ch / 2);
        }
        if (best && best[0] === i && best[1] === j) {
          ctx.fillStyle = "#ffb23e";
          ctx.fillText("★", x + cw - 18, y + 20);
        }
      }
    }
    ctx.fillStyle = "#8b9097";
    ctx.font = "600 20px 'Barlow Condensed', Inter, sans-serif";
    REAR.forEach((r, j) => ctx.fillText(`${Math.round(r * 100)}`, x0 + j * cw + cw / 2, H - 36));
    FRONT.forEach((f, i) => ctx.fillText(`${Math.round(f * 100)}`, 36, y0 + (FRONT.length - 1 - i) * ch + ch / 2));
    ctx.fillText("ALTURA TRASERA (cm)", x0 + (cw * REAR.length) / 2, H - 10);
    ctx.save();
    ctx.translate(12, y0 + (ch * FRONT.length) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("DELANTERA (cm)", 0, 0);
    ctx.restore();
    $("mapUnit").textContent = `${m.label} · ${m.unit}`;
  }
}
