import { DomainError } from "@/domain/errors";
import type { EventType, OrderStatus } from "@/types";

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: [],
  CANCELLED: [],
};

export function nextOrderStatus(current: OrderStatus, target: OrderStatus): OrderStatus {
  if (!ALLOWED[current].includes(target)) {
    throw new DomainError("invalid_transition", `Cannot move an order from ${current} to ${target}`, 409);
  }
  return target;
}

export function eventForOrderStatus(status: OrderStatus): EventType | null {
  switch (status) {
    case "ACCEPTED":
      return "order.accepted";
    case "PREPARING":
      return "order.prep_started";
    case "READY":
      return "order.ready";
    case "SERVED":
      return "order.served";
    default:
      return null;
  }
}

export function primaryOrderAction(status: OrderStatus): { status: OrderStatus; label: string } | null {
  switch (status) {
    case "NEW":
      return { status: "ACCEPTED", label: "Accept" };
    case "ACCEPTED":
      return { status: "PREPARING", label: "Start prep" };
    case "PREPARING":
      return { status: "READY", label: "Mark ready" };
    case "READY":
      return { status: "SERVED", label: "Mark served" };
    default:
      return null;
  }
}

export function isOpenOrder(status: OrderStatus): boolean {
  return status !== "SERVED" && status !== "CANCELLED";
}
