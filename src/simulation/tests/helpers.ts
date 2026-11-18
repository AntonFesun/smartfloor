import { createGridLayout, createSimulationScenario, type SimulationScenario, type SimulationScenarioInput } from "../index";

/** Busy-but-plausible baseline: 24 tables, generous kitchen, so tests isolate one constraint at a time. */
export function baseInput(overrides: Partial<SimulationScenarioInput> = {}): SimulationScenarioInput {
  return {
    seed: 7,
    layout: createGridLayout({ tables: 24, zones: 3, columns: 6 }),
    waiterCount: 4,
    kitchenCapacity: { hot: 20, cold: 8 },
    barCapacity: 8,
    arrivalsPerHour: 20,
    duration: "4h",
    ...overrides,
  };
}

export function scenario(overrides: Partial<SimulationScenarioInput> = {}): SimulationScenario {
  return createSimulationScenario(baseInput(overrides));
}
