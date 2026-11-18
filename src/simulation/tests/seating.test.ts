import { describe, expect, it } from "vitest";
import { DoubleSeatingError, TablePool } from "../resources/tablePool";
import { createGridLayout, runSimulation } from "../index";
import { scenario } from "./helpers";

describe("seating", () => {
  it("never double-seats a table under heavy load", () => {
    const sc = scenario({ seed: 61, arrivalsPerHour: 90, waiterCount: 3, duration: "shift", layout: createGridLayout({ tables: 8, zones: 2, columns: 4 }) });
    const { events, metrics } = runSimulation(sc);
    const capacity = new Map(sc.layout.map((t) => [t.id, t.capacity]));
    const state = new Map<string, "free" | "occupied" | "dirty">(sc.layout.map((t) => [t.id, "free"]));
    let seatings = 0;
    for (const e of events) {
      if (e.type === "PARTY_SEATED") {
        expect(state.get(e.tableId!)).toBe("free");
        expect(Number(e.data?.size)).toBeLessThanOrEqual(capacity.get(e.tableId!)!);
        state.set(e.tableId!, "occupied");
        seatings++;
      } else if (e.type === "PARTY_DEPARTED") {
        expect(state.get(e.tableId!)).toBe("occupied");
        state.set(e.tableId!, "dirty");
      } else if (e.type === "TABLE_CLEANED") {
        expect(state.get(e.tableId!)).toBe("dirty");
        state.set(e.tableId!, "free");
      }
    }
    expect(seatings).toBeGreaterThan(50);
    expect(metrics.queues.seating.max).toBeGreaterThan(0);
    expect(metrics.parties.rejectedByReason.abandoned + metrics.parties.rejectedByReason.queue_full).toBeGreaterThan(0);
  });

  it("the pool itself refuses to seat on a non-free table", () => {
    const pool = new TablePool(createGridLayout({ tables: 2 }));
    pool.seat("T1", "P1", 2, 0);
    expect(() => pool.seat("T1", "P2", 2, 1)).toThrow(DoubleSeatingError);
    pool.markDirty("T1", 5);
    expect(() => pool.seat("T1", "P3", 2, 6)).toThrow(DoubleSeatingError);
    pool.clean("T1", 7);
    expect(pool.seat("T1", "P3", 2, 8).partyId).toBe("P3");
  });

  it("picks the smallest sufficient table and breaks ties deterministically", () => {
    const pool = new TablePool([
      { id: "a", number: 3, zoneId: "z", x: 0, y: 0, capacity: 6, shape: "round" },
      { id: "b", number: 2, zoneId: "z", x: 1, y: 0, capacity: 4, shape: "round" },
      { id: "c", number: 1, zoneId: "z", x: 2, y: 0, capacity: 4, shape: "round" },
    ]);
    expect(pool.pickBest(3)?.spec.id).toBe("c");
    expect(pool.pickBest(5)?.spec.id).toBe("a");
    expect(pool.pickBest(7)).toBeNull();
  });
});
