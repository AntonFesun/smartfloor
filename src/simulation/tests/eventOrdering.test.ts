import { describe, expect, it } from "vitest";
import { EventQueue, createSeededRng, createSimulation, runSimulation, type SimulationEventType } from "../index";
import { scenario } from "./helpers";

describe("event ordering", () => {
  it("pops by simulated time, then by insertion sequence", () => {
    const q = new EventQueue<string>();
    q.schedule(10, "c1");
    q.schedule(5, "a");
    q.schedule(10, "c2");
    q.schedule(7, "b");
    q.schedule(10, "c3");
    q.schedule(0, "first");
    const order: string[] = [];
    let e = q.pop();
    while (e) {
      order.push(e.payload);
      e = q.pop();
    }
    expect(order).toEqual(["first", "a", "b", "c1", "c2", "c3"]);
  });

  it("holds the ordering invariant over many random inserts with heavy time ties", () => {
    const rng = createSeededRng("queue-property");
    const q = new EventQueue<number>();
    for (let i = 0; i < 2000; i++) q.schedule(Math.floor(rng.next() * 50), i);
    let prev: { time: number; seq: number } | null = null;
    let count = 0;
    for (let e = q.pop(); e; e = q.pop()) {
      if (prev) expect(e.time > prev.time || (e.time === prev.time && e.seq > prev.seq)).toBe(true);
      prev = e;
      count++;
    }
    expect(count).toBe(2000);
  });

  it("rejects invalid times", () => {
    const q = new EventQueue<string>();
    expect(() => q.schedule(Number.NaN, "x")).toThrow();
    expect(() => q.schedule(-1, "x")).toThrow();
  });

  it("the simulation processes its queue in (time, seq) order and logs in that order", () => {
    const sim = createSimulation(scenario({ seed: 21, duration: "1h" }), { recordTrace: true });
    const result = runSimulation(sim);
    const trace = sim.trace;
    expect(trace.length).toBeGreaterThan(100);
    for (let i = 1; i < trace.length; i++) {
      const p = trace[i - 1]!;
      const c = trace[i]!;
      expect(c.time).toBeGreaterThanOrEqual(p.time);
      if (c.time === p.time) expect(c.seq).toBeGreaterThan(p.seq);
    }
    const traceIndex = new Map(trace.map((t, i) => [t.seq, i]));
    for (let i = 1; i < result.events.length; i++) {
      const p = result.events[i - 1]!;
      const c = result.events[i]!;
      expect(c.id).toBe(p.id + 1);
      expect(c.time).toBeGreaterThanOrEqual(p.time);
      expect(traceIndex.get(c.causeSeq)!).toBeGreaterThanOrEqual(traceIndex.get(p.causeSeq)!);
    }
  });

  it("each party's lifecycle events appear in causal order", () => {
    const { events } = runSimulation(scenario({ seed: 4, arrivalsPerHour: 12, duration: "4h" }));
    const departed = events.filter((e) => e.type === "PARTY_DEPARTED");
    expect(departed.length).toBeGreaterThan(5);
    for (const d of departed) {
      const mine = events.filter((e) => e.partyId === d.partyId);
      const idx = (type: SimulationEventType) => mine.findIndex((e) => e.type === type);
      const lastIdx = (type: SimulationEventType) => mine.map((e) => e.type).lastIndexOf(type);
      expect(idx("GUEST_ARRIVAL")).toBe(0);
      expect(idx("GUEST_ARRIVAL")).toBeLessThan(idx("PARTY_SEATED"));
      expect(idx("PARTY_SEATED")).toBeLessThan(idx("ORDER_PLACED"));
      expect(idx("ORDER_PLACED")).toBeLessThan(idx("KITCHEN_PREPARATION_STARTED"));
      expect(idx("KITCHEN_PREPARATION_STARTED")).toBeLessThan(idx("KITCHEN_PREPARATION_COMPLETED"));
      expect(idx("KITCHEN_PREPARATION_COMPLETED")).toBeLessThan(idx("ORDER_SERVED"));
      expect(lastIdx("ORDER_SERVED")).toBeLessThan(idx("PARTY_DEPARTED"));
      const cleaned = events.find((e) => e.type === "TABLE_CLEANED" && e.tableId === d.tableId && e.time >= d.time);
      expect(cleaned).toBeDefined();
    }
  });
});
