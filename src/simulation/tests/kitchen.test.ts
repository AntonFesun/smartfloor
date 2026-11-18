import { describe, expect, it } from "vitest";
import { meanIncludingOpen, runSimulation, type SimulationEvent, type SimulationMetrics, type StationId } from "../index";
import { scenario } from "./helpers";

describe("kitchen contention", () => {
  it("kitchen saturation raises prep time while cooking time stays the same", () => {
    const runFull = (hot: number) =>
      runSimulation(scenario({ seed: 41, waiterCount: 10, arrivalsPerHour: 24, kitchenCapacity: { hot, cold: 8 }, barCapacity: 8 }));
    const tightRun = runFull(1);
    const looseRun = runFull(20);
    const run = (hot: number) => (hot === 1 ? tightRun : hot === 20 ? looseRun : runFull(hot)).metrics;
    const tight = run(1);
    const mid = run(3);
    const loose = run(20);
    const hotCook = (events: SimulationEvent[]) => {
      const xs = events.filter((e) => e.type === "KITCHEN_PREPARATION_COMPLETED" && e.station === "hot").length;
      const started = events.filter((e) => e.type === "KITCHEN_PREPARATION_STARTED" && e.station === "hot");
      return { n: xs, mean: started.reduce((s, e) => s + Number(e.data?.prepSeconds), 0) / started.length };
    };
    // Completed-only means are biased low once a backlog builds (slow orders never finish), so compare
    // with still-open orders included. Both views must agree on the direction between mid and loose.
    const prep = (m: SimulationMetrics) => meanIncludingOpen(m.waits.prep, m.open.prep)!;
    expect(prep(tight)).toBeGreaterThan(prep(mid));
    expect(prep(mid)).toBeGreaterThan(prep(loose));
    expect(mid.waits.prep.mean!).toBeGreaterThan(loose.waits.prep.mean!);
    expect(tight.open.prep.count).toBeGreaterThan(loose.open.prep.count);
    expect(tight.waits.kitchenQueue.mean!).toBeGreaterThan(loose.waits.kitchenQueue.mean! + 60);
    expect(tight.bottleneck.primary).toBe("hot");
    // Hands-on cook time of a hot dish is unaffected by capacity; only queueing grows.
    expect(Math.abs(hotCook(tightRun.events).mean - hotCook(looseRun.events).mean) / hotCook(looseRun.events).mean).toBeLessThan(0.15);
    expect(tight.sla.prep).toBeGreaterThan(loose.sla.prep);
    expect(tight.utilization.stations.hot!).toBeGreaterThan(0.9);
  });

  it("never runs more items on a station than its capacity", () => {
    const capacity: Record<StationId, number> = { hot: 2, cold: 1, bar: 1 };
    const { events } = runSimulation(scenario({ seed: 42, arrivalsPerHour: 30, kitchenCapacity: capacity, barCapacity: capacity.bar }));
    const active: Record<StationId, number> = { hot: 0, cold: 0, bar: 0 };
    let sawFull = false;
    const apply = (e: SimulationEvent) => {
      const st = e.station!;
      if (e.type === "KITCHEN_PREPARATION_STARTED") active[st]++;
      if (e.type === "KITCHEN_PREPARATION_COMPLETED") active[st]--;
      expect(active[st]).toBeLessThanOrEqual(capacity[st]);
      expect(active[st]).toBeGreaterThanOrEqual(0);
      if (active[st] === capacity[st]) sawFull = true;
    };
    for (const e of events) if (e.station) apply(e);
    expect(sawFull).toBe(true);
  });

  it("routes items to the station named on the menu", () => {
    const { events } = runSimulation(scenario({ seed: 43, arrivalsPerHour: 20 }));
    const started = events.filter((e) => e.type === "KITCHEN_PREPARATION_STARTED");
    const stationOf = (item: string) => new Set(started.filter((e) => e.data?.menuItem === item).map((e) => e.station));
    expect(stationOf("pizza")).toEqual(new Set(["hot"]));
    expect(stationOf("coffee")).toEqual(new Set(["bar"]));
    expect(stationOf("salad")).toEqual(new Set(["cold"]));
  });

  it("an order is only delivered after all of its items are ready", () => {
    const { events } = runSimulation(scenario({ seed: 44, arrivalsPerHour: 20 }));
    const placed = events.filter((e) => e.type === "ORDER_PLACED");
    for (const p of placed) {
      const items = events.filter((e) => e.type === "KITCHEN_PREPARATION_COMPLETED" && e.orderId === p.orderId);
      const served = events.find((e) => e.type === "ORDER_SERVED" && e.orderId === p.orderId);
      if (!served) continue;
      expect(items.length).toBe(Number(p.data?.items));
      for (const i of items) expect(i.time).toBeLessThanOrEqual(served.time);
    }
  });
});
