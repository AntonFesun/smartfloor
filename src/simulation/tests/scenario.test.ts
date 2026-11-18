import { describe, expect, it } from "vitest";
import {
  SimulationConfigError,
  createDefaultLayout,
  createSimulationScenario,
  loadScenario,
  serializeScenario,
  withOverrides,
} from "../index";
import { baseInput, scenario } from "./helpers";

describe("scenario creation", () => {
  it("accepts a plain layout array and fills defaults", () => {
    const layout = [
      { id: "a", number: 1, zoneId: "z1", x: 0, y: 0, capacity: 2, shape: "round" },
      { id: "b", number: 2, zoneId: "z2", x: 5, y: 0, capacity: 4, shape: "square" },
    ];
    const sc = createSimulationScenario({ seed: 1, layout, waiterCount: 2 });
    expect(sc.zones).toEqual(["z1", "z2"]);
    expect(sc.waiters).toHaveLength(2);
    expect(sc.durationSeconds).toBe(4 * 3600);
    expect(sc.stationCapacity).toEqual({ hot: 6, cold: 2, bar: 2 });
  });

  it("distributes waiters over zones and honours explicit per-zone staffing", () => {
    const even = createSimulationScenario(baseInput({ waiterCount: 3 }));
    expect(even.waiters).toHaveLength(3);
    expect(new Set(even.waiters.map((w) => w.zoneId)).size).toBe(3);
    const explicit = createSimulationScenario(baseInput({ waitersPerZone: { "zone-1": 3, "zone-2": 0, "zone-3": 1 } }));
    expect(explicit.waiters.filter((w) => w.zoneId === "zone-1")).toHaveLength(3);
    expect(explicit.waiters.filter((w) => w.zoneId === "zone-2")).toHaveLength(0);
  });

  it("supports duration presets", () => {
    expect(scenario({ duration: "1h" }).durationSeconds).toBe(3600);
    expect(scenario({ duration: "4h" }).durationSeconds).toBe(14400);
    expect(scenario({ duration: "shift" }).durationSeconds).toBe(28800);
  });

  it("reports every problem at once", () => {
    const layout = createDefaultLayout();
    try {
      createSimulationScenario({
        seed: "",
        layout: [...layout, { ...layout[0]! }],
        waiterCount: 0,
        arrivalsPerHour: -1,
        barCapacity: 0,
        repeatOrderProbability: 2,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SimulationConfigError);
      const issues = (e as SimulationConfigError).issues.join("\n");
      expect(issues).toMatch(/duplicate table id/);
      expect(issues).toMatch(/waiterCount/);
      expect(issues).toMatch(/arrivalsPerHour/);
      expect(issues).toMatch(/station bar/);
      expect(issues).toMatch(/repeatOrderProbability/);
      expect(issues).toMatch(/seed is required/);
    }
    expect(() => createSimulationScenario({ seed: 1, layout: [] })).toThrow(SimulationConfigError);
    expect(() => createSimulationScenario({ seed: 1, layout, waitersPerZone: { nowhere: 2 } })).toThrow(/unknown zone/);
  });

  it("round-trips through JSON and the id tracks content, not the name", () => {
    const sc = scenario({ seed: "abc", name: "first" });
    const loaded = loadScenario(serializeScenario(sc));
    expect(loaded).toEqual(sc);
    expect(scenario({ seed: "abc", name: "renamed" }).id).toBe(sc.id);
    expect(scenario({ seed: "abd" }).id).not.toBe(sc.id);
    expect(withOverrides(sc, { waiterCount: 5 }).waiters).toHaveLength(5);
    expect(withOverrides(sc, { waiterCount: 5 }).seed).toBe("abc");
    expect(() => loadScenario(JSON.stringify({ ...sc, schemaVersion: 2 }))).toThrow(SimulationConfigError);
  });
});
