import type { LayoutTable, MenuItemSpec, PartySizeWeight, SimulationScenarioInput, TaskDurations } from "../models/types";

export const DEFAULT_PARTY_SIZES: PartySizeWeight[] = [
  { size: 1, weight: 0.1 },
  { size: 2, weight: 0.4 },
  { size: 3, weight: 0.15 },
  { size: 4, weight: 0.2 },
  { size: 5, weight: 0.05 },
  { size: 6, weight: 0.1 },
];

/** Prep times in seconds. Station = which pool of cooks/bartenders makes it. */
export const DEFAULT_MENU: MenuItemSpec[] = [
  { id: "pizza", name: "Pizza", station: "hot", price: 14, probability: 0.2, prep: { kind: "triangular", min: 480, mode: 660, max: 960 } },
  { id: "pasta", name: "Pasta", station: "hot", price: 13, probability: 0.16, prep: { kind: "triangular", min: 420, mode: 600, max: 840 } },
  { id: "burger", name: "Burger", station: "hot", price: 15, probability: 0.1, prep: { kind: "triangular", min: 420, mode: 600, max: 900 } },
  { id: "steak", name: "Steak", station: "hot", price: 26, probability: 0.06, prep: { kind: "triangular", min: 600, mode: 840, max: 1200 } },
  { id: "salad", name: "Salad", station: "cold", price: 9, probability: 0.1, prep: { kind: "triangular", min: 180, mode: 300, max: 480 } },
  { id: "dessert", name: "Dessert", station: "cold", price: 7, probability: 0.06, prep: { kind: "triangular", min: 120, mode: 240, max: 420 } },
  { id: "coffee", name: "Coffee", station: "bar", price: 3.5, probability: 0.14, prep: { kind: "triangular", min: 90, mode: 150, max: 240 } },
  { id: "cappuccino", name: "Cappuccino", station: "bar", price: 4.5, probability: 0.1, prep: { kind: "triangular", min: 120, mode: 180, max: 300 } },
  { id: "cocktail", name: "Cocktail", station: "bar", price: 11, probability: 0.08, prep: { kind: "triangular", min: 180, mode: 270, max: 420 } },
];

export const DEFAULT_TASK_DURATIONS: TaskDurations = {
  takeOrder: { kind: "triangular", min: 45, mode: 90, max: 180 },
  deliverOrder: { kind: "triangular", min: 20, mode: 40, max: 90 },
  clearTable: { kind: "triangular", min: 60, mode: 120, max: 240 },
};

/** 12 tables in three zones on a 24 x 14 m floor. A stand-in until the real layout is wired. */
export function createDefaultLayout(): LayoutTable[] {
  const tables: LayoutTable[] = [];
  const zones: { id: string; x0: number; caps: number[] }[] = [
    { id: "main", x0: 4, caps: [2, 2, 4, 4, 6] },
    { id: "window", x0: 12, caps: [2, 2, 4, 4] },
    { id: "patio", x0: 19, caps: [4, 4, 6] },
  ];
  let number = 1;
  for (const zone of zones) {
    zone.caps.forEach((capacity, i) => {
      tables.push({
        id: `T${number}`,
        number,
        zoneId: zone.id,
        x: zone.x0 + (i % 2) * 3,
        y: 2 + Math.floor(i / 2) * 4,
        capacity,
        shape: capacity >= 6 ? "rectangle" : capacity === 2 ? "round" : "square",
      });
      number++;
    });
  }
  return tables;
}

/** Regular grid of tables spread over `zones` vertical bands. Handy for load scenarios and demos. */
export function createGridLayout(options: { tables: number; zones?: number; columns?: number; spacing?: number; capacities?: number[] }): LayoutTable[] {
  const { tables: count, zones = 3, columns = 6, spacing = 3, capacities = [2, 4, 4, 6] } = options;
  const out: LayoutTable[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const capacity = capacities[i % capacities.length] as number;
    out.push({
      id: `T${i + 1}`,
      number: i + 1,
      zoneId: `zone-${Math.min(zones - 1, Math.floor((col * zones) / columns)) + 1}`,
      x: 3 + col * spacing,
      y: 2 + row * spacing,
      capacity,
      shape: capacity >= 6 ? "rectangle" : capacity === 2 ? "round" : "square",
    });
  }
  return out;
}

export function createDefaultScenarioInput(overrides: Partial<SimulationScenarioInput> = {}): SimulationScenarioInput {
  return {
    name: "Default dinner service",
    seed: 1,
    layout: createDefaultLayout(),
    waiterCount: 3,
    kitchenCapacity: { hot: 6, cold: 2 },
    barCapacity: 2,
    arrivalsPerHour: 12,
    duration: "4h",
    ...overrides,
  };
}
