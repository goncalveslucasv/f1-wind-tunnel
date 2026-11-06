import { readFileSync } from "node:fs";
import { w17WingLoads } from "../src/engine/vlm";
const rig = JSON.parse(readFileSync("public/models/w17.rig.json", "utf8"));
const v = 250 / 3.6, kg = (n: number) => Math.round(n / 9.81);
const cases: [string, number, number, number][] = [["base", 0, 0, 0], ["recta", -12, -28, 0], ["front alta", 7, 0, 0], ["front baja", -9, 0, 0], ["rear alta", 0, 9, 3], ["rear baja", 0, -13, -4]];
cases.push(["gurney", 0, 0, 0], ["cuchara", 0, 0, 0], ["tablon", 0, 0, 0], ["finos", 0, 0, 0]);
for (const [name, f, rf, rm] of cases) {
  const t = performance.now();
  const r = w17WingLoads(rig, { frontDeg: f, rearFlapDeg: rf, rearMainDeg: rm, rideH: 0.12, rearRideH: 0.14, gurney: name === "gurney", frontOn: true, rearOn: true, rearTwistDeg: name === "cuchara" ? -16 : name === "tablon" ? 6 : 0, flapScale: name === "finos" ? 0.72 : 1 }, v);
  console.log(name.padEnd(11), "front", kg(r.front.downforceN), "kg /", kg(r.front.dragN), "kg drag cop", r.front.copX.toFixed(2), "| rear", kg(r.rear.downforceN), "kg /", kg(r.rear.dragN), "kg drag cop", r.rear.copX.toFixed(2), `  (${(performance.now() - t).toFixed(0)} ms)`);
}
