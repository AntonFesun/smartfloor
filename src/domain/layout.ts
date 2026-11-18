import type { Capacity, RestaurantTable, TableShape } from "@/types";

export const FLOOR = {
  minX: -9,
  maxX: 9,
  minY: -6,
  maxY: 6,
} as const;

export interface Footprint {
  w: number;
  h: number;
}

export interface LayoutIssue {
  id: string;
  kind: "bounds" | "collision";
  with?: string;
}

type Sized = { id?: string; shape: TableShape; capacity: Capacity; x: number; y: number };

export function tableFootprint(table: { shape: TableShape; capacity: Capacity }): Footprint {
  const circle: Record<Capacity, Footprint> = {
    2: { w: 0.95, h: 0.95 },
    4: { w: 1.28, h: 1.28 },
    6: { w: 1.6, h: 1.6 },
    8: { w: 1.9, h: 1.9 },
  };
  const rect: Record<Capacity, Footprint> = {
    2: { w: 1.15, h: 0.72 },
    4: { w: 1.55, h: 0.92 },
    6: { w: 1.95, h: 1.02 },
    8: { w: 2.35, h: 1.12 },
  };
  return table.shape === "rect" ? rect[table.capacity] : circle[table.capacity];
}

export function tableRadius(table: { shape: TableShape; capacity: Capacity }): number {
  const { w, h } = tableFootprint(table);
  return Math.hypot(w, h) / 2;
}

export function chairSlots(table: { shape: TableShape; capacity: Capacity }): { x: number; y: number }[] {
  const { w, h } = tableFootprint(table);
  const cap = table.capacity;
  if (table.shape === "circle" || cap <= 2) {
    const r = Math.max(w, h) / 2 + 0.34;
    return Array.from({ length: cap }, (_, i) => {
      const a = (Math.PI * 2 * i) / cap - Math.PI / 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
  }
  const insetX = w / 2 + 0.3;
  const insetY = h / 2 + 0.3;
  if (cap === 4) {
    return [
      { x: -insetX, y: 0 },
      { x: insetX, y: 0 },
      { x: 0, y: -insetY },
      { x: 0, y: insetY },
    ];
  }
  if (cap === 6) {
    return [
      { x: -insetX * 0.55, y: -insetY },
      { x: insetX * 0.55, y: -insetY },
      { x: -insetX * 0.55, y: insetY },
      { x: insetX * 0.55, y: insetY },
      { x: -insetX, y: 0 },
      { x: insetX, y: 0 },
    ];
  }
  return [
    { x: -insetX * 0.7, y: -insetY },
    { x: 0, y: -insetY },
    { x: insetX * 0.7, y: -insetY },
    { x: -insetX * 0.7, y: insetY },
    { x: 0, y: insetY },
    { x: insetX * 0.7, y: insetY },
    { x: -insetX, y: 0 },
    { x: insetX, y: 0 },
  ];
}

export function rotatePoint(x: number, y: number, degrees: number): { x: number; y: number } {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

export function normalizeRotation(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function layoutIssues(tables: Sized[]): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  tables.forEach((table, index) => {
    const radius = tableRadius(table);
    const id = table.id ?? `#${index}`;
    if (
      table.x - radius < FLOOR.minX ||
      table.x + radius > FLOOR.maxX ||
      table.y - radius < FLOOR.minY ||
      table.y + radius > FLOOR.maxY
    ) {
      issues.push({ id, kind: "bounds" });
    }
    for (let otherIndex = index + 1; otherIndex < tables.length; otherIndex += 1) {
      const other = tables[otherIndex]!;
      const gap = Math.hypot(table.x - other.x, table.y - other.y);
      const minGap = tableRadius(table) + tableRadius(other) - 0.05;
      if (gap < minGap) {
        issues.push({ id, kind: "collision", with: other.id ?? `#${otherIndex}` });
      }
    }
  });
  return issues;
}

export function layoutErrorMessage(issues: LayoutIssue[]): string {
  const first = issues[0];
  if (!first) return "Layout is invalid";
  if (first.kind === "bounds") return `${first.id} is outside the floor`;
  return `${first.id} overlaps ${first.with ?? "another table"}`;
}

export function findOpenSpot(tables: RestaurantTable[], capacity: Capacity, shape: TableShape): { x: number; y: number } | null {
  for (let y = -4.8; y <= 4.8; y += 1.15) {
    for (let x = -7.6; x <= 7.6; x += 1.15) {
      const candidate = { id: "NEW", x: roundCoord(x), y: roundCoord(y), capacity, shape };
      const issues = layoutIssues([...tables, candidate]).filter((issue) => issue.id === "NEW" || issue.with === "NEW");
      if (issues.length === 0) return { x: candidate.x, y: candidate.y };
    }
  }
  return null;
}
