import { describe, expect, it } from "vitest";
import { createSimulation, runSimulation, stepSimulation } from "../index";
import { scenario } from "./helpers";

describe("waiter contention", () => {
  it("queues tasks while every waiter is busy (observed live via stepping)", () => {
    const sim = createSimulation(scenario({ seed: 31, waiterCount: 1, arrivalsPerHour: 60, duration: "1h" }));
    let observed = false;
    for (let i = 0; i < 5000 && !observed; i++) {
      const r = stepSimulation(sim);
      if (!r.processed) break;
      const waiter = r.frame.waiters[0]!;
      if (waiter.state !== "idle" && r.frame.queues.waiterTasks >= 1) observed = true;
    }
    expect(observed).toBe(true);
  });

  it("a single waiter serialises work: waits emerge and tasks never overlap", () => {
    const { metrics, events } = runSimulation(scenario({ seed: 32, waiterCount: 1, arrivalsPerHour: 40, duration: "4h" }));
    expect(metrics.queues.waiterTasks.max).toBeGreaterThanOrEqual(2);
    expect(metrics.waits.waiterResponse.max).toBeGreaterThan(0);
    expect(metrics.waits.waiterResponse.mean).toBeGreaterThan(0);

    const started = events.filter((e) => e.type === "WAITER_TASK_STARTED");
    expect(started.some((e) => Number(e.data?.waitedSeconds) > 0)).toBe(true);

    const busyUntil = new Map<string, number>();
    for (const e of events) {
      if (e.type === "WAITER_TASK_STARTED") {
        const until = busyUntil.get(e.waiterId!) ?? -1;
        expect(e.time).toBeGreaterThanOrEqual(until);
        busyUntil.set(e.waiterId!, Number.POSITIVE_INFINITY);
      } else if (e.type === "WAITER_TASK_COMPLETED") {
        expect(busyUntil.get(e.waiterId!)).toBe(Number.POSITIVE_INFINITY);
        busyUntil.set(e.waiterId!, e.time);
      }
    }
  });

  it("with ample staff the same demand sees (near) zero response delay", () => {
    const lonely = runSimulation(scenario({ seed: 32, waiterCount: 1, arrivalsPerHour: 40 })).metrics;
    const crowd = runSimulation(scenario({ seed: 32, waiterCount: 12, arrivalsPerHour: 40 })).metrics;
    expect(crowd.waits.waiterResponse.mean!).toBeLessThan(lonely.waits.waiterResponse.mean!);
    expect(crowd.queues.waiterTasks.max).toBeLessThan(lonely.queues.waiterTasks.max);
  });

  it("serves deliveries before clearing when both wait (priority order)", () => {
    const { events } = runSimulation(scenario({ seed: 33, waiterCount: 1, arrivalsPerHour: 50 }));
    const byTask = new Map<string, { type: string; waited: number }>();
    for (const e of events) if (e.type === "WAITER_TASK_STARTED") byTask.set(e.taskId!, { type: String(e.data?.taskType), waited: Number(e.data?.waitedSeconds) });
    const avg = (type: string) => {
      const xs = [...byTask.values()].filter((t) => t.type === type).map((t) => t.waited);
      return xs.reduce((s, v) => s + v, 0) / xs.length;
    };
    expect(avg("deliver_order")).toBeLessThan(avg("clear_table"));
  });

  it("zone staffing is honoured and cross-zone help can be disabled", () => {
    const sc = scenario({ seed: 34, waitersPerZone: { "zone-1": 2, "zone-2": 1, "zone-3": 1 }, crossZoneAssistance: false, arrivalsPerHour: 24 });
    expect(sc.waiters.filter((w) => w.zoneId === "zone-1")).toHaveLength(2);
    const { events } = runSimulation(sc);
    const zoneOfTable = new Map(sc.layout.map((t) => [t.id, t.zoneId]));
    const zoneOfWaiter = new Map(sc.waiters.map((w) => [w.id, w.zoneId]));
    const started = events.filter((e) => e.type === "WAITER_TASK_STARTED");
    expect(started.length).toBeGreaterThan(20);
    for (const e of started) expect(zoneOfWaiter.get(e.waiterId!)).toBe(zoneOfTable.get(e.tableId!));
  });
});
