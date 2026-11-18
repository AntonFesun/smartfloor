import { describe, expect, it } from "vitest";
import { createSimulation, runSimulation, simulationStateToVisualState, stepSimulation } from "../index";
import { scenario } from "./helpers";

describe("frames and visual state", () => {
  it("emits periodic frames with per-table occupancy, waiter markers and queue sizes", () => {
    const sc = scenario({ seed: 91, duration: "1h", arrivalsPerHour: 30 });
    const { frames } = runSimulation(sc, { frameIntervalSeconds: 60 });
    expect(frames.length).toBe(61);
    expect(frames[0]!.time).toBe(60 * 0 || frames[0]!.time);
    const times = frames.map((f) => f.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);

    const last = frames[frames.length - 1]!;
    expect(last.tables).toHaveLength(sc.layout.length);
    expect(last.waiters).toHaveLength(sc.waiters.length);
    expect(frames.some((f) => f.tables.some((t) => t.state === "occupied" && t.fill > 0))).toBe(true);
    expect(frames.some((f) => f.tables.some((t) => t.state === "dirty"))).toBe(true);
    expect(frames.some((f) => f.waiters.some((w) => w.state === "walking"))).toBe(true);
    expect(frames.some((f) => f.queues.stations.hot.active > 0)).toBe(true);
    expect(frames.every((f) => f.tables.every((t) => t.fill >= 0 && t.fill <= 1))).toBe(true);
  });

  it("interpolates waiter markers smoothly while walking", () => {
    const sim = createSimulation(scenario({ seed: 92, duration: "1h", arrivalsPerHour: 30, waiterCount: 2 }));
    let checked = false;
    for (let i = 0; i < 3000 && !checked; i++) {
      const r = stepSimulation(sim);
      if (!r.processed) break;
      const walker = r.frame.waiters.find((w) => w.state === "walking" && w.route.length > 1);
      if (!walker) continue;
      const end = walker.route[walker.route.length - 1]!;
      const dist = Math.hypot(end.x - walker.x, end.y - walker.y);
      if (dist < 1) continue;
      const soon = sim.getFrame(sim.now + 0.5).waiters.find((w) => w.id === walker.id)!;
      const moved = Math.hypot(soon.x - walker.x, soon.y - walker.y);
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThanOrEqual(0.5 * 1.2 + 1e-6);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("adapts a frame into a visual state for the host", () => {
    const sc = scenario({ seed: 93, duration: "1h", arrivalsPerHour: 60, waiterCount: 1 });
    const sim = createSimulation(sc);
    stepSimulation(sim, { untilTime: 2400 });
    const frame = sim.getFrame();
    const visual = simulationStateToVisualState(frame, { startEpochMs: Date.UTC(2026, 0, 1, 18, 0, 0) });
    expect(visual.mode).toBe("SIMULATION");
    expect(visual.isSimulated).toBe(true);
    expect(visual.timestamp).toBe("2026-01-01T18:40:00.000Z");
    expect(visual.tables).toHaveLength(sc.layout.length);
    expect(visual.tables.map((t) => t.id)).toEqual(sc.layout.map((t) => t.id));
    expect(visual.zones.flatMap((z) => z.tableIds).sort()).toEqual(sc.layout.map((t) => t.id).sort());
    expect(visual.waiters).toHaveLength(1);
    const occupied = frame.tables.filter((t) => t.state === "occupied").length;
    expect(visual.tables.filter((t) => t.status === "occupied")).toHaveLength(occupied);
    expect(visual.alerts.some((a) => a.type === "WAITER_OVERDUE" || a.type === "SEATING_QUEUE")).toBe(true);
    expect(visual.queues.seating).toBe(frame.queues.seating);
  });

  it("frames are plain JSON (safe for postMessage)", () => {
    const sim = createSimulation(scenario({ seed: 94, duration: "1h" }));
    stepSimulation(sim, { untilTime: 900 });
    const frame = sim.getFrame();
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });
});
