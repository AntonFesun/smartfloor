import type { MenuItem, RestaurantTable, ZoneName } from "@/types";
import type { LayoutTable, MenuItemSpec, SimulationVisualState } from "@/simulation";

export function layoutFromRestaurant(tables: readonly RestaurantTable[]): LayoutTable[] {
  return tables.map((table) => ({
    id: table.id,
    number: table.number,
    zoneId: table.zone,
    x: table.x,
    y: table.y,
    capacity: table.capacity,
    shape: table.shape === "circle" ? "round" : "rectangle",
  }));
}

export function menuFromRestaurant(items: readonly MenuItem[]): MenuItemSpec[] {
  return items.flatMap((item) => {
    const station = item.station === "Hot Kitchen" ? "hot" : item.station === "Cold Kitchen" ? "cold" : item.station === "Bar" ? "bar" : null;
    if (!station) return [];
    return [{
      id: item.id,
      name: item.name,
      station,
      price: item.price,
      probability: 1,
      prep: station === "hot"
        ? { kind: "triangular" as const, min: 420, mode: 660, max: 960 }
        : station === "cold"
          ? { kind: "triangular" as const, min: 120, mode: 240, max: 420 }
          : { kind: "triangular" as const, min: 90, mode: 150, max: 240 },
    }];
  });
}

export function visualTables(state: SimulationVisualState, rotation: ReadonlyMap<string, number>): RestaurantTable[] {
  return state.tables.map((table) => ({
    id: table.id,
    number: table.number,
    zone: table.zoneId as ZoneName,
    shape: table.shape === "round" || table.shape === "circle" ? "circle" : "rect",
    x: table.x,
    y: table.y,
    rotation: rotation.get(table.id) ?? 0,
    capacity: (table.capacity === 2 || table.capacity === 4 || table.capacity === 6 || table.capacity === 8 ? table.capacity : 4),
    occupiedSeatCount: Math.min(table.capacity, table.partySize),
    status: table.status === "occupied" ? "OCCUPIED" : table.status === "needs_cleaning" ? "RESERVED" : "AVAILABLE",
  }));
}
