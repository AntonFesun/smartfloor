import { describe, expect, it } from "vitest";
import {
  createSimulation,
  getSimulationMetrics,
  pauseSimulation,
  resumeSimulation,
  runSimulation,
  setSimulationSpeed,
  stepSimulation,
  tickSimulation,
  SIMULATION_SPEEDS,
  VirtualClock,
} from "../index";
import { scenario } from "./helpers";

describe("controls and virtual clock", () => {
  it("steps one queue event at a time and reports what happened", () => {
    const sim = createSimulation(scenario({ seed: 81, duration: "1h" }));
    const first = stepSimulation(sim);
    expect(first.processed).toBe(1);
    expect(first.events[0]?.type).toBe("GUEST_ARRIVAL");
    expect(first.time).toBeGreaterThan(0);
    expect(first.frame.counters.arrived).toBe(1);
    const batch = stepSimulation(sim, { events: 10 });
    expect(batch.processed).toBe(10);
    const until = stepSimulation(sim, { untilTime: 1800 });
    expect(until.time).toBe(1800);
    expect(until.frame.time).toBe(1800);
    const rest = stepSimulation(sim, { advanceSeconds: 5000 });
    expect(rest.done).toBe(true);
    expect(sim.status).toBe("completed");
    expect(stepSimulation(sim).processed).toBe(0);
  });

  it("pause stops real-time ticking, resume continues it", () => {
    const sim = createSimulation(scenario({ seed: 82, duration: "1h" }));
    setSimulationSpeed(sim, 60);
    expect(tickSimulation(sim, 1000).advanced).toBe(false);
    expect(sim.now).toBe(0);

    expect(resumeSimulation(sim)).toBe("running");
    const t1 = tickSimulation(sim, 1000);
    expect(t1.advanced).toBe(true);
    expect(sim.now).toBe(60);

    expect(pauseSimulation(sim)).toBe("paused");
    tickSimulation(sim, 5000);
    expect(sim.now).toBe(60);

    stepSimulation(sim, { events: 1 });
    expect(sim.now).toBeGreaterThanOrEqual(60);

    resumeSimulation(sim);
    const before = sim.now;
    tickSimulation(sim, 1000);
    expect(sim.now).toBe(before + 60);
  });

  it("speed multiplies simulated time per wall time and a run can finish through ticks", () => {
    for (const speed of SIMULATION_SPEEDS) {
      const clock = new VirtualClock();
      clock.setSpeed(speed);
      expect(clock.realToSimulated(2000)).toBe(2 * speed);
    }
    const sim = createSimulation(scenario({ seed: 83, duration: "1h" }));
    setSimulationSpeed(sim, 300);
    resumeSimulation(sim);
    let ticks = 0;
    while (!tickSimulation(sim, 500).done && ticks++ < 1000) {
      /* tick */
    }
    expect(sim.status).toBe("completed");
    expect(sim.now).toBe(3600);
    expect(ticks).toBeGreaterThan(10);
    expect(sim.getMetrics()).toEqual(runSimulation(scenario({ seed: 83, duration: "1h" })).metrics);
  });

  it("rejects invalid speeds and backwards clocks", () => {
    const clock = new VirtualClock();
    expect(() => clock.setSpeed(0)).toThrow();
    expect(() => clock.setSpeed(Number.NaN)).toThrow();
    clock.advanceTo(10);
    expect(() => clock.advanceTo(5)).toThrow();
  });

  it("metrics mid-run reflect the current virtual time and never mutate state", () => {
    const sim = createSimulation(scenario({ seed: 84, duration: "1h" }));
    stepSimulation(sim, { untilTime: 1200 });
    const a = getSimulationMetrics(sim);
    const b = getSimulationMetrics(sim);
    expect(a).toEqual(b);
    expect(a.simulatedSeconds).toBe(1200);
    expect(a.completed).toBe(false);
    stepSimulation(sim, { untilTime: 3600 });
    expect(getSimulationMetrics(sim).completed).toBe(true);
  });
});
