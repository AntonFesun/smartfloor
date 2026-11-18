import type { Order, OrderStatus, RestaurantTable, WaiterCall, WaiterStatus } from "@/types";

export const RESTAURANT_ID = "atelier";
export const RESTAURANT_TIME_ZONE = "Europe/Kyiv";
export const JOURNAL_SCHEMA_VERSION = 1;

export const JOURNAL_EVENT_TYPES = [
  "TABLE_OCCUPIED",
  "TABLE_RELEASED",
  "TABLE_MOVED",
  "TABLE_STATUS_CHANGED",
  "GUEST_SEATED",
  "GUEST_LEFT",
  "ORDER_CREATED",
  "ORDER_ACCEPTED",
  "ORDER_PREPARING",
  "ORDER_READY",
  "ORDER_SERVED",
  "ORDER_CANCELLED",
  "KITCHEN_TICKET_CREATED",
  "KITCHEN_TICKET_STARTED",
  "KITCHEN_TICKET_READY",
  "WAITER_CALLED",
  "WAITER_CALL_ACKNOWLEDGED",
  "WAITER_CALL_RESOLVED",
  "WAITER_ASSIGNED",
  "WAITER_TASK_CREATED",
  "WAITER_TASK_COMPLETED",
  "RESERVATION_CREATED",
  "RESERVATION_UPDATED",
  "RESERVATION_CANCELLED",
  "TABLE_GROUP_CREATED",
  "TABLE_GROUP_DISSOLVED",
  "PAYMENT_RECORDED",
] as const;

export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

export type TimeRangeKind = "last_hour" | "today" | "yesterday" | "last_7_days" | "custom";

export interface TimeRange {
  kind: TimeRangeKind;
  from?: string;
  to?: string;
}

export interface RestaurantEvent {
  id: string;
  sequence: number;
  restaurantId: string;
  tableId: string | null;
  orderId: string | null;
  waiterId: string | null;
  zoneId: string | null;
  sessionId: string | null;
  type: JournalEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
  idempotencyKey: string | null;
  commandId: string;
}

export interface RestaurantBaseline {
  sequence: number;
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
}

export interface ProjectedRestaurantState {
  sequence: number;
  tables: RestaurantTable[];
  orders: Order[];
  waiterCalls: WaiterCall[];
}

const ORDER_STATUS_BY_EVENT: Partial<Record<JournalEventType, OrderStatus>> = {
  ORDER_ACCEPTED: "ACCEPTED",
  ORDER_PREPARING: "PREPARING",
  ORDER_READY: "READY",
  ORDER_SERVED: "SERVED",
  ORDER_CANCELLED: "CANCELLED",
};

export function isJournalEventType(value: string): value is JournalEventType {
  return (JOURNAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function resolveTimeRange(range: TimeRange, now: number, timeZone = RESTAURANT_TIME_ZONE): { from: string; to: string } {
  if (range.kind === "custom") {
    if (!range.from || !range.to) throw new Error("Custom range needs from and to");
    return { from: range.from, to: range.to };
  }
  if (range.kind === "last_hour") {
    return { from: new Date(now - 60 * 60 * 1000).toISOString(), to: new Date(now + 1).toISOString() };
  }
  const { year, month, day } = zonedYmd(now, timeZone);
  const startToday = zonedMidnightUtc(year, month, day, timeZone);
  if (range.kind === "today") {
    return { from: new Date(startToday).toISOString(), to: new Date(addZonedDays(year, month, day, 1, timeZone)).toISOString() };
  }
  if (range.kind === "yesterday") {
    const start = addZonedDays(year, month, day, -1, timeZone);
    return { from: new Date(start).toISOString(), to: new Date(startToday).toISOString() };
  }
  const start = addZonedDays(year, month, day, -6, timeZone);
  return { from: new Date(start).toISOString(), to: new Date(addZonedDays(year, month, day, 1, timeZone)).toISOString() };
}

export function projectRestaurantState(
  baseline: RestaurantBaseline,
  orderedEvents: RestaurantEvent[],
  targetSequence: number,
): ProjectedRestaurantState {
  const tables = new Map(baseline.tables.map((table) => [table.id, { ...table }]));
  const orders = new Map(baseline.orders.map((order) => [order.id, { ...order, items: order.items.map((item) => ({ ...item })) }]));
  const waiterCalls = new Map(baseline.waiterCalls.map((call) => [call.id, { ...call }]));
  const events = [...orderedEvents].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const event of events) {
    if (event.sequence <= baseline.sequence || event.sequence > targetSequence) continue;
    applyEvent(tables, orders, waiterCalls, event);
  }
  return {
    sequence: targetSequence,
    tables: [...tables.values()].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id)),
    orders: [...orders.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    waiterCalls: [...waiterCalls.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

function applyEvent(
  tables: Map<string, RestaurantTable>,
  orders: Map<string, Order>,
  waiterCalls: Map<string, WaiterCall>,
  event: RestaurantEvent,
): void {
  const table = event.tableId ? tables.get(event.tableId) : undefined;
  const orderStatus = ORDER_STATUS_BY_EVENT[event.type];
  if (orderStatus) {
    const order = event.orderId ? orders.get(event.orderId) : undefined;
    if (order) {
      order.status = orderStatus;
      order.updatedAt = event.occurredAt;
    }
    return;
  }
  switch (event.type) {
    case "TABLE_OCCUPIED":
      if (table) {
        table.status = "OCCUPIED";
        const seats = payloadNumber(event.payload, "occupiedSeatCount");
        if (seats != null) table.occupiedSeatCount = seats;
      }
      return;
    case "GUEST_SEATED":
      if (table) {
        table.status = "OCCUPIED";
        const seats = payloadNumber(event.payload, "occupiedSeatCount");
        if (seats != null) table.occupiedSeatCount = seats;
      }
      return;
    case "GUEST_LEFT":
      if (table) table.occupiedSeatCount = 0;
      return;
    case "TABLE_RELEASED":
      if (table) {
        table.status = "AVAILABLE";
        table.occupiedSeatCount = 0;
      }
      return;
    case "TABLE_STATUS_CHANGED": {
      if (!table) return;
      const status = payloadString(event.payload, "to");
      if (status === "AVAILABLE" || status === "OCCUPIED" || status === "RESERVED") table.status = status;
      const seats = payloadNumber(event.payload, "occupiedSeatCount");
      if (seats != null) table.occupiedSeatCount = seats;
      return;
    }
    case "TABLE_MOVED": {
      if (!table) return;
      const to = event.payload.to;
      if (!to || typeof to !== "object") return;
      const next = to as Record<string, unknown>;
      if (typeof next.x === "number") table.x = next.x;
      if (typeof next.y === "number") table.y = next.y;
      if (typeof next.rotation === "number") table.rotation = next.rotation;
      if (next.shape === "circle" || next.shape === "rect") table.shape = next.shape;
      if (next.capacity === 2 || next.capacity === 4 || next.capacity === 6 || next.capacity === 8) table.capacity = next.capacity;
      if (next.zone === "Main Hall" || next.zone === "Terrace" || next.zone === "Bar Lounge") table.zone = next.zone;
      return;
    }
    case "ORDER_CREATED": {
      const raw = event.payload.order;
      if (!raw || typeof raw !== "object") return;
      const order = raw as Order;
      if (!order.id) return;
      orders.set(order.id, { ...order, items: Array.isArray(order.items) ? order.items.map((item) => ({ ...item })) : [] });
      return;
    }
    case "WAITER_CALLED": {
      const raw = event.payload.call;
      if (!raw || typeof raw !== "object") return;
      const call = raw as WaiterCall;
      if (!call.id) return;
      waiterCalls.set(call.id, { ...call });
      return;
    }
    case "WAITER_CALL_ACKNOWLEDGED":
      setCall(waiterCalls, event, "ACKNOWLEDGED");
      return;
    case "WAITER_CALL_RESOLVED":
      setCall(waiterCalls, event, "RESOLVED");
      return;
    default:
      return;
  }
}

function setCall(waiterCalls: Map<string, WaiterCall>, event: RestaurantEvent, status: WaiterStatus): void {
  const callId = event.payload.callId;
  const call = typeof callId === "string" ? waiterCalls.get(callId) : undefined;
  if (!call) return;
  call.status = status;
  if (status === "ACKNOWLEDGED") call.acknowledgedAt = event.occurredAt;
  if (status === "RESOLVED") call.resolvedAt = event.occurredAt;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function zonedYmd(now: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const hour = parts.hour === "24" ? 0 : Number(parts.hour);
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
    const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
    const delta = asUtc - desired;
    if (delta === 0) return utc;
    utc -= delta;
  }
  return utc;
}

function addZonedDays(year: number, month: number, day: number, days: number, timeZone: string): number {
  const start = zonedMidnightUtc(year, month, day, timeZone);
  const shifted = zonedYmd(start + days * 24 * 60 * 60 * 1000, timeZone);
  return zonedMidnightUtc(shifted.year, shifted.month, shifted.day, timeZone);
}
