import type { RigData } from "./car-model";
import { w17WingLoads, type W17WingSetup } from "./vlm";

let rig: RigData | null = null;

self.onmessage = (e: MessageEvent<{ id: number; rig?: RigData; setup: W17WingSetup; speed: number }>) => {
  if (e.data.rig) rig = e.data.rig;
  if (!rig) return;
  const loads = w17WingLoads(rig, e.data.setup, e.data.speed);
  (self as unknown as Worker).postMessage({ id: e.data.id, loads });
};
