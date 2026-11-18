import { DomainError } from "@/domain/errors";
import type { MenuCategory } from "@/types";

export const KITCHEN_STATIONS = ["Hot Kitchen", "Cold Kitchen", "Bar"] as const;
export type KitchenStation = (typeof KITCHEN_STATIONS)[number];

export const TICKET_STATUSES = ["NEW", "ACCEPTED", "PREPARING", "READY", "COMPLETED", "CANCELLED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_ACTIONS = ["accept", "start", "complete_item", "complete", "bump"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

export interface KitchenTicketItem {
  id: string;
  menuItemId: string;
  name: string;
  qty: number;
  notes: string | null;
  done: boolean;
}

export interface KitchenTicket {
  id: string;
  number: number;
  orderId: string;
  tableId: string;
  station: KitchenStation;
  status: TicketStatus;
  priority: number;
  notes: string | null;
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  items: KitchenTicketItem[];
}

export interface DeliveryTask {
  id: string;
  type: "deliver_order";
  orderId: string;
  tableId: string;
  status: "OPEN" | "COMPLETED";
  priority: number;
  createdAt: string;
  completedAt: string | null;
  assignedWaiterId: string | null;
}

export const ORDER_READY_RULE =
  "An order becomes READY only when every required kitchen ticket is READY or COMPLETED. Soft drinks and other items with no station create no ticket. The first transition into READY creates one deliver_order task for the waiter. A ticket can be marked ready only after each of its items is done.";

export function stationForMenuItem(item: { id: string; name: string; category: MenuCategory | string }): KitchenStation | null {
  if (item.category === "Soft drinks") return null;
  if (item.category === "Coffee") return "Bar";
  if (item.category === "Pizza" || item.category === "Mains" || item.id === "menu-soup") return "Hot Kitchen";
  if (item.category === "Starters" || item.category === "Desserts") return "Cold Kitchen";
  return null;
}

export function nextTicketStatus(status: TicketStatus, action: TicketAction): TicketStatus {
  if (action === "accept" && status === "NEW") return "ACCEPTED";
  if (action === "start" && status === "ACCEPTED") return "PREPARING";
  if (action === "complete" && status === "PREPARING") return "READY";
  if (action === "bump" && status === "READY") return "COMPLETED";
  throw new DomainError("invalid_transition", `Cannot ${action} a ${status} ticket`, 409);
}

export function unfinishedItems(items: KitchenTicketItem[]): KitchenTicketItem[] {
  return items.filter((item) => !item.done);
}

export function ticketsBlockReady(tickets: Pick<KitchenTicket, "status">[]): boolean {
  return tickets.some((ticket) => ticket.status !== "CANCELLED" && ticket.status !== "READY" && ticket.status !== "COMPLETED");
}

export interface KitchenMetrics {
  avgPrepMs: number | null;
  prepSamples: number;
  activeTickets: number;
  overThreshold: number;
  byStation: { station: KitchenStation; active: number; avgPrepMs: number | null; samples: number }[];
  byItem: { name: string; avgPrepMs: number; samples: number }[];
}

export function kitchenMetrics(tickets: KitchenTicket[], now: number, prepThresholdMs: number): KitchenMetrics {
  const finished = tickets.flatMap((ticket) => {
    if (!ticket.startedAt || !ticket.readyAt) return [];
    const ms = Date.parse(ticket.readyAt) - Date.parse(ticket.startedAt);
    if (!Number.isFinite(ms) || ms < 0) return [];
    return [{ station: ticket.station, ms, items: ticket.items.map((item) => item.name) }];
  });
  const active = tickets.filter((ticket) => ticket.status === "NEW" || ticket.status === "ACCEPTED" || ticket.status === "PREPARING");
  const runningLong = active.filter(
    (ticket) => ticket.status === "PREPARING" && ticket.startedAt != null && now - Date.parse(ticket.startedAt) > prepThresholdMs,
  ).length;
  const finishedLong = finished.filter((sample) => sample.ms > prepThresholdMs).length;
  const byItem = new Map<string, number[]>();
  for (const sample of finished) {
    for (const name of sample.items) {
      const list = byItem.get(name) ?? [];
      list.push(sample.ms);
      byItem.set(name, list);
    }
  }
  return {
    avgPrepMs: finished.length === 0 ? null : finished.reduce((sum, sample) => sum + sample.ms, 0) / finished.length,
    prepSamples: finished.length,
    activeTickets: active.length,
    overThreshold: runningLong + finishedLong,
    byStation: KITCHEN_STATIONS.map((station) => {
      const samples = finished.filter((sample) => sample.station === station);
      return {
        station,
        active: active.filter((ticket) => ticket.station === station).length,
        samples: samples.length,
        avgPrepMs: samples.length === 0 ? null : samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length,
      };
    }),
    byItem: [...byItem.entries()].map(([name, samples]) => ({
      name,
      samples: samples.length,
      avgPrepMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    })),
  };
}
