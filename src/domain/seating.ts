import { DomainError } from "@/domain/errors";
import type { RestaurantTable, ZoneName } from "@/types";

export const ADJACENCY_METERS = 3.45;
export const DEFAULT_HOLD_MINUTES = 90;
export const DEFAULT_DURATION_MINUTES = 90;

export const RESERVATION_STATUSES = ["CONFIRMED", "SEATED", "CANCELLED", "COMPLETED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface Reservation {
  id: string;
  partySize: number;
  start: string;
  end: string;
  tableId: string | null;
  groupId: string | null;
  status: ReservationStatus;
  createdAt: string;
}

export interface TableGroup {
  id: string;
  status: "ACTIVE" | "DISSOLVED";
  tableIds: string[];
  createdAt: string;
  dissolvedAt: string | null;
}

export interface SeatingRequest {
  partySize: number;
  start: string;
  durationMinutes?: number;
  zone?: ZoneName | null;
}

export interface SeatingSuggestion {
  tableIds: string[];
  zone: string;
  capacity: number;
  waste: number;
  score: number;
  reasons: string[];
}

const BLOCKING: ReservationStatus[] = ["CONFIRMED", "SEATED"];

export function tablesAreAdjacent(a: RestaurantTable, b: RestaurantTable): boolean {
  if (a.zone !== b.zone) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= ADJACENCY_METERS;
}

export function suggestSeating(
  tables: RestaurantTable[],
  reservations: Reservation[],
  groups: TableGroup[],
  request: SeatingRequest,
  now: number,
): SeatingSuggestion[] {
  if (!Number.isInteger(request.partySize) || request.partySize < 1 || request.partySize > 24) return [];
  const start = Date.parse(request.start);
  if (Number.isNaN(start)) return [];
  const duration = request.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const end = start + duration * 60_000;
  const activeGroups = groups.filter((group) => group.status === "ACTIVE");
  const grouped = new Set(activeGroups.flatMap((group) => group.tableIds));
  const free = (table: RestaurantTable) => !isBusy(table, start, end, now, reservations, activeGroups);
  const suggestions: SeatingSuggestion[] = [];

  for (const table of tables) {
    if (grouped.has(table.id) || table.capacity < request.partySize || !free(table)) continue;
    suggestions.push(scoreSuggestion([table], request));
  }

  for (const group of activeGroups) {
    const members = group.tableIds.map((id) => tables.find((table) => table.id === id)).filter((table): table is RestaurantTable => Boolean(table));
    if (members.length < 2 || !sameZone(members) || !connected(members)) continue;
    const capacity = members.reduce((sum, table) => sum + table.capacity, 0);
    if (capacity < request.partySize || members.some((table) => !free(table))) continue;
    suggestions.push(scoreSuggestion(members, request, "Existing group"));
  }

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i]!;
      const b = tables[j]!;
      if (grouped.has(a.id) || grouped.has(b.id) || !tablesAreAdjacent(a, b)) continue;
      if (a.capacity + b.capacity < request.partySize || !free(a) || !free(b)) continue;
      suggestions.push(scoreSuggestion([a, b], request));
    }
  }

  return suggestions
    .sort((a, b) => a.score - b.score || a.tableIds.join().localeCompare(b.tableIds.join()))
    .slice(0, 6);
}

export function assertBookable(
  tables: RestaurantTable[],
  reservations: Reservation[],
  groups: TableGroup[],
  tableIds: string[],
  request: SeatingRequest,
  now: number,
): void {
  const unique = [...new Set(tableIds)];
  if (unique.length === 0) throw new DomainError("invalid_booking", "Choose at least one table");
  const selected = unique.map((id) => {
    const table = tables.find((item) => item.id === id);
    if (!table) throw new DomainError("not_found", `Table ${id} was not found`, 404);
    return table;
  });
  if (!sameZone(selected)) throw new DomainError("across_zones", "Tables cannot be grouped across zones", 409);
  if (selected.length > 1 && !connected(selected)) {
    throw new DomainError("not_adjacent", "Only adjacent tables in the same zone can be grouped", 409);
  }
  const start = Date.parse(request.start);
  const end = start + (request.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000;
  const activeGroups = groups.filter((group) => group.status === "ACTIVE");
  const split = groupSplit(unique, activeGroups);
  if (split) throw new DomainError("group_conflict", split, 409);
  for (const table of selected) {
    if (isBusy(table, start, end, now, reservations, activeGroups)) {
      throw new DomainError("table_conflict", `${table.id} is not free for that time`, 409);
    }
  }
  const capacity = selected.reduce((sum, table) => sum + table.capacity, 0);
  if (capacity < request.partySize) throw new DomainError("too_small", "Those tables cannot seat the party", 409);
}

function scoreSuggestion(members: RestaurantTable[], request: SeatingRequest, extra?: string): SeatingSuggestion {
  const sorted = [...members].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  const capacity = sorted.reduce((sum, table) => sum + table.capacity, 0);
  const waste = capacity - request.partySize;
  const zone = sorted[0]!.zone;
  const preferred = !request.zone || request.zone === zone;
  const score = waste * 10 + (preferred ? 0 : 1000) + (sorted.length > 1 ? 50 : 0) + sorted[0]!.number / 1000;
  const reasons = [
    `Seats ${capacity} for a party of ${request.partySize}`,
    waste === 0 ? "No empty seats" : `Waste ${waste} seat${waste === 1 ? "" : "s"}`,
    preferred && request.zone ? `Matches preferred zone ${zone}` : `In ${zone}`,
  ];
  if (sorted.length > 1) reasons.push(`${extra ?? "Adjacent group"} ${sorted.map((table) => table.id).join(" + ")}`);
  return { tableIds: sorted.map((table) => table.id), zone, capacity, waste, score, reasons };
}

function sameZone(tables: RestaurantTable[]): boolean {
  return tables.every((table) => table.zone === tables[0]?.zone);
}

function connected(tables: RestaurantTable[]): boolean {
  if (tables.length <= 1) return true;
  const remaining = new Set(tables.map((table) => table.id));
  const queue = [tables[0]!.id];
  remaining.delete(tables[0]!.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const current = tables.find((table) => table.id === id)!;
    for (const other of tables) {
      if (!remaining.has(other.id) || !tablesAreAdjacent(current, other)) continue;
      remaining.delete(other.id);
      queue.push(other.id);
    }
  }
  return remaining.size === 0;
}

function groupSplit(tableIds: string[], groups: TableGroup[]): string | null {
  const involved = groups.filter((group) => group.tableIds.some((id) => tableIds.includes(id)));
  if (involved.length > 1) return "Those tables belong to different groups";
  const group = involved[0];
  if (!group) return null;
  const same = group.tableIds.length === tableIds.length && group.tableIds.every((id) => tableIds.includes(id));
  return same ? null : "Book the whole group, or dissolve it before using one table";
}

function isBusy(table: RestaurantTable, start: number, end: number, now: number, reservations: Reservation[], groups: TableGroup[]): boolean {
  if ((table.status === "OCCUPIED" || table.status === "RESERVED") && start < now + DEFAULT_HOLD_MINUTES * 60_000 && end > now) {
    return true;
  }
  return reservations.some((reservation) => {
    if (!BLOCKING.includes(reservation.status)) return false;
    const reservationTables = reservation.groupId
      ? groups.find((group) => group.id === reservation.groupId)?.tableIds ?? []
      : reservation.tableId
        ? [reservation.tableId]
        : [];
    if (!reservationTables.includes(table.id)) return false;
    return Date.parse(reservation.start) < end && Date.parse(reservation.end) > start;
  });
}
