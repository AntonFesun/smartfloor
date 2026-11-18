import type { EventType, OrderStatus, TableStatus } from "@/types";

export const EVENT_LABEL: Record<EventType, string> = {
  "guests.seated": "Guests seated",
  "order.submitted": "Order submitted",
  "order.accepted": "Order accepted",
  "order.prep_started": "Prep started",
  "order.ready": "Order ready",
  "order.served": "Order served",
  "waiter.called": "Waiter called",
  "waiter.acknowledged": "Waiter acknowledged",
  "waiter.resolved": "Waiter resolved",
  "table.cleared": "Table cleared",
};

export const ORDER_LABEL: Record<OrderStatus, string> = {
  NEW: "New",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  SERVED: "Served",
  CANCELLED: "Cancelled",
};

export const TABLE_LABEL: Record<TableStatus, string> = {
  AVAILABLE: "Available",
  OCCUPIED: "Occupied",
  RESERVED: "Reserved",
};

export const STATUS_COLOR: Record<TableStatus, string> = {
  AVAILABLE: "#22c55e",
  OCCUPIED: "#3b82f6",
  RESERVED: "#f59e0b",
};

export function eventSummary(metadata: Record<string, unknown>): string | null {
  const summary = metadata.summary;
  return typeof summary === "string" && summary.length > 0 ? summary : null;
}
