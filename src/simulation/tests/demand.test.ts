import { describe, expect, it } from "vitest";
import { runSimulation } from "../index";
import { scenario } from "./helpers";

describe("demand versus fixed capacity", () => {
  it("more arrivals with the same staff and tables increases waits", () => {
    const run = (arrivalsPerHour: number) =>
      runSimulation(scenario({ seed: 51, waiterCount: 3, kitchenCapacity: { hot: 6, cold: 2 }, barCapacity: 2, arrivalsPerHour }), { recordEvents: false }).metrics;
    const low = run(8);
    const mid = run(24);
    const high = run(48);

    expect(high.guests.arrived).toBeGreaterThan(mid.guests.arrived);
    expect(mid.guests.arrived).toBeGreaterThan(low.guests.arrived);

    expect(mid.waits.seating.mean!).toBeGreaterThan(low.waits.seating.mean!);
    expect(high.waits.seating.mean!).toBeGreaterThan(mid.waits.seating.mean!);
    expect(high.waits.waiterResponse.mean!).toBeGreaterThan(low.waits.waiterResponse.mean!);
    expect(high.waits.prep.mean!).toBeGreaterThan(low.waits.prep.mean!);
    expect(high.waits.orderToServe.mean!).toBeGreaterThan(low.waits.orderToServe.mean!);

    expect(high.parties.rejected).toBeGreaterThan(low.parties.rejected);
    expect(high.utilization.waiters!).toBeGreaterThan(low.utilization.waiters!);
    expect(high.queues.seating.max).toBeGreaterThan(low.queues.seating.max);
  });

  it("zero arrivals produces an empty but valid run with null (not fake) averages", () => {
    const { metrics } = runSimulation(scenario({ arrivalsPerHour: 0, duration: "1h" }));
    expect(metrics.parties.arrived).toBe(0);
    expect(metrics.waits.seating.mean).toBeNull();
    expect(metrics.waits.prep.mean).toBeNull();
    expect(metrics.bottleneck.primary).toBeNull();
    expect(metrics.bottleneck.shares).toBeNull();
    expect(metrics.turnover.perTable).toBe(0);
    expect(metrics.completed).toBe(true);
  });

  it("parties larger than every table are rejected and counted", () => {
    const { metrics } = runSimulation(scenario({ seed: 52, partySizes: [{ size: 9, weight: 1 }], arrivalsPerHour: 10, duration: "1h" }));
    expect(metrics.parties.arrived).toBeGreaterThan(0);
    expect(metrics.parties.rejectedByReason.no_fitting_table).toBe(metrics.parties.arrived);
    expect(metrics.parties.seated).toBe(0);
  });
});
