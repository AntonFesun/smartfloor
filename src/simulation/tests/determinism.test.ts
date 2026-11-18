import { describe, expect, it } from "vitest";
import {
  createSeededRng,
  createSimulation,
  loadScenario,
  resetSimulation,
  runSimulation,
  serializeScenario,
  stepSimulation,
  type Rng,
} from "../index";
import { scenario } from "./helpers";

describe("determinism", () => {
  it("same seed and inputs give identical metrics and event logs", () => {
    const a = runSimulation(scenario({ seed: 123 }));
    const b = runSimulation(scenario({ seed: 123 }));
    expect(b.metrics).toEqual(a.metrics);
    expect(JSON.stringify(b.metrics)).toBe(JSON.stringify(a.metrics));
    expect(b.eventChecksum).toBe(a.eventChecksum);
    expect(b.events.length).toBe(a.events.length);
    expect(a.events.length).toBeGreaterThan(200);
  });

  it("different seeds give different results", () => {
    const a = runSimulation(scenario({ seed: 1 }));
    const b = runSimulation(scenario({ seed: 2 }));
    expect(b.eventChecksum).not.toBe(a.eventChecksum);
    expect(b.metrics.guests.arrived).not.toBe(a.metrics.guests.arrived);
  });

  it("survives save and load of a scenario", () => {
    const original = scenario({ seed: "night-shift" });
    const loaded = loadScenario(serializeScenario(original));
    expect(loaded.id).toBe(original.id);
    expect(runSimulation(loaded).eventChecksum).toBe(runSimulation(original).eventChecksum);
  });

  it("stepping event by event reaches the same result as a straight run", () => {
    const sc = scenario({ seed: 55, duration: "1h" });
    const full = runSimulation(sc);
    const sim = createSimulation(sc);
    let guard = 0;
    while (!stepSimulation(sim).done && guard++ < 100000) {
      /* keep stepping */
    }
    // The last step may have been the finishing no-op; make sure the run is complete.
    stepSimulation(sim, { untilTime: sc.durationSeconds });
    expect(sim.getMetrics()).toEqual(full.metrics);
    expect(sim.events.length).toBe(full.events.length);
  });

  it("capturing frames does not change the outcome", () => {
    const sc = scenario({ seed: 9, duration: "1h" });
    expect(runSimulation(sc, { frameIntervalSeconds: 30 }).eventChecksum).toBe(runSimulation(sc).eventChecksum);
  });

  it("reset replays the identical run, and a new seed changes it", () => {
    const sim = createSimulation(scenario({ seed: 5, duration: "1h" }));
    const first = runSimulation(sim);
    const firstChecksum = first.eventChecksum;
    const firstMetrics = (JSON.parse(JSON.stringify(first.metrics)) as typeof first.metrics);
    resetSimulation(sim);
    expect(sim.status).toBe("idle");
    expect(sim.now).toBe(0);
    expect(sim.events).toHaveLength(0);
    const second = runSimulation(sim);
    expect(second.eventChecksum).toBe(firstChecksum);
    expect(second.metrics).toEqual(firstMetrics);
    resetSimulation(sim, { seed: 6 });
    expect(runSimulation(sim).eventChecksum).not.toBe(firstChecksum);
  });

  it("accepts an injected PRNG factory", () => {
    const labels: string[] = [];
    const rng = (seed: string | number): Rng => {
      labels.push(String(seed));
      return createSeededRng(`custom:${seed}`);
    };
    const sc = scenario({ seed: 3, duration: "1h" });
    const injected = runSimulation(sc, { rng });
    expect(labels.some((l) => l.endsWith("|arrivals"))).toBe(true);
    expect(labels.some((l) => l.includes("|party|0"))).toBe(true);
    expect(injected.eventChecksum).not.toBe(runSimulation(sc).eventChecksum);
    expect(runSimulation(sc, { rng }).eventChecksum).toBe(injected.eventChecksum);
  });

  it("demand is identical across staffing changes with the same seed (common random numbers)", () => {
    const a = runSimulation(scenario({ seed: 11, waiterCount: 3 }), { recordEvents: true });
    const b = runSimulation(scenario({ seed: 11, waiterCount: 8 }), { recordEvents: true });
    const arrivals = (events: typeof a.events) =>
      events.filter((e) => e.type === "GUEST_ARRIVAL").map((e) => `${e.time}:${String(e.data?.size)}`);
    expect(arrivals(b.events)).toEqual(arrivals(a.events));
  });
});
