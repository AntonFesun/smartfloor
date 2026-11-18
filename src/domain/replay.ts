import type { JournalEventType, RestaurantEvent } from "@/domain/journal";
import { projectRestaurantState } from "@/domain/journal";
import type { Capacity, Order, RestaurantTable, TableShape, WaiterCall, ZoneName } from "@/types";

export type ReplayMode = "LIVE" | "REPLAY";

export const TIMELINE_FILTERS = ["all", "orders", "guests", "calls", "payments", "reservations"] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

const FILTER_TYPES: Record<Exclude<TimelineFilter, "all">, readonly JournalEventType[]> = {
  orders: ["ORDER_CREATED", "ORDER_ACCEPTED", "ORDER_PREPARING", "ORDER_READY", "ORDER_SERVED", "ORDER_CANCELLED"],
  guests: ["GUEST_SEATED", "GUEST_LEFT", "TABLE_OCCUPIED", "TABLE_RELEASED", "TABLE_STATUS_CHANGED"],
  calls: ["WAITER_CALLED", "WAITER_CALL_ACKNOWLEDGED", "WAITER_CALL_RESOLVED"],
  payments: ["PAYMENT_RECORDED"],
  reservations: ["RESERVATION_CREATED", "RESERVATION_UPDATED", "RESERVATION_CANCELLED", "TABLE_GROUP_CREATED", "TABLE_GROUP_DISSOLVED"],
};

export interface ServiceSpan {
  label: string;
  ms: number;
  orderId: string | null;
  tableId: string | null;
}

/**
 * One projection to `targetSequence`. Scrubbing calls this once for the chosen
 * sequence. It does not walk or emit the frames in between.
 * Tables keep their physical identity. Service state starts empty, because rows
 * that predate the journal were never recorded. A recorded move uses its `from`
 * position until that event is inside the window.
 */
export function replayAt(
  liveTables: readonly RestaurantTable[],
  events: readonly RestaurantEvent[],
  targetSequence: number,
): { sequence: number; tables: RestaurantTable[]; orders: Order[]; waiterCalls: WaiterCall[] } {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const tables = liveTables.map((table) => {
    const firstMove = ordered.find((event) => event.type === "TABLE_MOVED" && event.tableId === table.id);
    return {
      ...table,
      ...(firstMove ? recordedGeometry(firstMove.payload.from) : {}),
      status: "AVAILABLE" as const,
      occupiedSeatCount: 0,
    };
  });
  return projectRestaurantState(
    { sequence: 0, tables, orders: [], waiterCalls: [] },
    ordered,
    targetSequence,
  );
}

export function activeCalls(calls: readonly WaiterCall[]): WaiterCall[] {
  return calls.filter((call) => call.status !== "RESOLVED");
}

export function tableJournal(
  events: readonly RestaurantEvent[],
  tableId: string,
  filter: TimelineFilter,
  throughSequence?: number,
): RestaurantEvent[] {
  const allowed = filter === "all" ? null : FILTER_TYPES[filter];
  return events
    .filter((event) => event.tableId === tableId)
    .filter((event) => throughSequence == null || event.sequence <= throughSequence)
    .filter((event) => allowed == null || allowed.includes(event.type))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function measureSpans(events: readonly RestaurantEvent[]): ServiceSpan[] {
  const spans: ServiceSpan[] = [];
  const byOrder = new Map<string, RestaurantEvent[]>();
  for (const event of events) {
    if (!event.orderId) continue;
    const list = byOrder.get(event.orderId) ?? [];
    list.push(event);
    byOrder.set(event.orderId, list);
  }
  for (const [orderId, list] of byOrder) {
    pair(spans, list, "ORDER_CREATED", "ORDER_ACCEPTED", "Create to accept", orderId);
    pair(spans, list, "ORDER_ACCEPTED", "ORDER_PREPARING", "Accept to prep", orderId);
    pair(spans, list, "ORDER_PREPARING", "ORDER_READY", "Prep", orderId);
    pair(spans, list, "ORDER_READY", "ORDER_SERVED", "Ready to served", orderId);
  }

  const byCall = new Map<string, RestaurantEvent[]>();
  for (const event of events) {
    const callId = callIdOf(event);
    if (!callId) continue;
    const list = byCall.get(callId) ?? [];
    list.push(event);
    byCall.set(callId, list);
  }
  for (const list of byCall.values()) {
    pair(spans, list, "WAITER_CALLED", "WAITER_CALL_ACKNOWLEDGED", "Waiter response", list[0]?.orderId ?? null);
  }

  spans.push(...occupancySpans(events));
  return spans.filter((span) => Number.isFinite(span.ms) && span.ms >= 0);
}

function pair(
  spans: ServiceSpan[],
  events: RestaurantEvent[],
  fromType: JournalEventType,
  toType: JournalEventType,
  label: string,
  orderId: string | null,
): void {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const from = ordered.find((event) => event.type === fromType);
  const to = from ? ordered.find((event) => event.type === toType && event.sequence > from.sequence) : undefined;
  if (!from || !to) return;
  spans.push({
    label,
    ms: Date.parse(to.occurredAt) - Date.parse(from.occurredAt),
    orderId,
    tableId: to.tableId ?? from.tableId,
  });
}

function occupancySpans(events: readonly RestaurantEvent[]): ServiceSpan[] {
  const result: ServiceSpan[] = [];
  const byTable = new Map<string, RestaurantEvent[]>();
  for (const event of events) {
    if (!event.tableId) continue;
    if (event.type !== "GUEST_SEATED" && event.type !== "TABLE_OCCUPIED" && event.type !== "GUEST_LEFT" && event.type !== "TABLE_RELEASED") continue;
    const list = byTable.get(event.tableId) ?? [];
    list.push(event);
    byTable.set(event.tableId, list);
  }
  for (const [tableId, list] of byTable) {
    const sorted = [...list].sort((a, b) => a.sequence - b.sequence);
    let open: RestaurantEvent | null = null;
    for (const event of sorted) {
      if ((event.type === "GUEST_SEATED" || event.type === "TABLE_OCCUPIED") && !open) open = event;
      if (open && (event.type === "GUEST_LEFT" || event.type === "TABLE_RELEASED") && event.sequence > open.sequence) {
        result.push({
          label: "Occupancy",
          ms: Date.parse(event.occurredAt) - Date.parse(open.occurredAt),
          orderId: null,
          tableId,
        });
        open = null;
      }
    }
  }
  return result;
}

function callIdOf(event: RestaurantEvent): string | null {
  if (typeof event.payload.callId === "string") return event.payload.callId;
  const call = event.payload.call;
  if (call && typeof call === "object" && typeof (call as { id?: unknown }).id === "string") return (call as { id: string }).id;
  return null;
}

function recordedGeometry(value: unknown): Partial<RestaurantTable> {
  if (!value || typeof value !== "object") return {};
  const next = value as Record<string, unknown>;
  const patch: Partial<RestaurantTable> = {};
  if (typeof next.x === "number") patch.x = next.x;
  if (typeof next.y === "number") patch.y = next.y;
  if (typeof next.rotation === "number") patch.rotation = next.rotation;
  if (next.shape === "circle" || next.shape === "rect") patch.shape = next.shape as TableShape;
  if (next.capacity === 2 || next.capacity === 4 || next.capacity === 6 || next.capacity === 8) patch.capacity = next.capacity as Capacity;
  if (next.zone === "Main Hall" || next.zone === "Terrace" || next.zone === "Bar Lounge") patch.zone = next.zone as ZoneName;
  return patch;
}
