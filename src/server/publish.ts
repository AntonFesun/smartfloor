import type { DeliveryTask, KitchenTicket } from "@/domain/kitchen";
import type { Reservation, TableGroup } from "@/domain/seating";
import type { RestaurantEvent } from "@/domain/journal";
import { getIo } from "@/server/io";
import type { Order, RestaurantTable, ServiceEvent, Snapshot, WaiterCall } from "@/types";

function emit(event: string, payload: unknown): void {
  getIo()?.emit(event, payload);
}

function publishTimeline(events: ServiceEvent[]): void {
  for (const event of events) emit("timeline.event", { event });
}

function publishJournal(result: { journal?: RestaurantEvent[]; idempotentReplay?: boolean }): void {
  if (result.idempotentReplay) return;
  for (const event of result.journal ?? []) emit("restaurant.event.created", { event });
}

export function publishOrderCreated(result: {
  order: Order;
  table: RestaurantTable;
  events: ServiceEvent[];
  journal?: RestaurantEvent[];
  tickets?: KitchenTicket[];
  idempotentReplay?: boolean;
}): void {
  if (result.idempotentReplay) return;
  emit("order.created", result);
  for (const ticket of result.tickets ?? []) emit("kitchen.ticket.created", { ticket });
  if (result.events.some((event) => event.type === "guests.seated")) {
    emit("table.updated", {
      table: result.table,
      events: result.events.filter((event) => event.type === "guests.seated"),
    });
  }
  publishTimeline(result.events);
  publishJournal(result);
}

export function publishOrderUpdated(result: {
  order: Order;
  events: ServiceEvent[];
  journal?: RestaurantEvent[];
  tickets?: KitchenTicket[];
  task?: DeliveryTask | null;
  idempotentReplay?: boolean;
}): void {
  if (result.idempotentReplay) return;
  emit("order.updated", result);
  publishTimeline(result.events);
  publishJournal(result);
  for (const ticket of result.tickets ?? []) emit("kitchen.ticket.updated", { ticket });
  if (result.task) emit(result.task.status === "OPEN" ? "waiter.task.created" : "waiter.task.updated", { task: result.task });
}

export function publishWaiter(
  name: "waiter.called" | "waiter.acknowledged" | "waiter.resolved",
  result: {
    call: WaiterCall;
    events: ServiceEvent[];
    journal?: RestaurantEvent[];
    task?: { status: string; assignedWaiterId: string | null } | null;
    idempotentReplay?: boolean;
  },
): void {
  if (result.idempotentReplay) return;
  emit(name, result);
  publishTimeline(result.events);
  publishJournal(result);
  const task = "task" in result ? result.task : null;
  if (task) {
    emit(task.status === "COMPLETED" || task.status === "ACKNOWLEDGED" ? "waiter.task.updated" : "waiter.task.created", {
      task,
      unassigned: task.assignedWaiterId == null,
    });
  }
}

export function publishTable(result: { table: RestaurantTable; events: ServiceEvent[]; journal?: RestaurantEvent[]; idempotentReplay?: boolean }): void {
  if (result.idempotentReplay) return;
  emit("table.updated", result);
  publishTimeline(result.events);
  publishJournal(result);
}

export function publishLayout(result: { tables: RestaurantTable[]; journal?: RestaurantEvent[]; idempotentReplay?: boolean }): void {
  if (result.idempotentReplay) return;
  emit("layout.updated", { tables: result.tables });
  publishJournal(result);
}

export function publishKitchen(result: {
  ticket: KitchenTicket;
  order: Order | null;
  events: ServiceEvent[];
  journal?: RestaurantEvent[];
  task: DeliveryTask | null;
  taskEvent: "created" | "updated" | null;
  idempotentReplay?: boolean;
}): void {
  if (result.idempotentReplay) return;
  emit("kitchen.ticket.updated", { ticket: result.ticket });
  if (result.order) {
    emit("order.updated", { order: result.order, events: result.events });
    publishTimeline(result.events);
  }
  publishJournal(result);
  if (result.task && result.taskEvent) {
    emit(result.taskEvent === "created" ? "waiter.task.created" : "waiter.task.updated", { task: result.task });
  }
}

export function publishTask(task: { assignedWaiterId: string | null; tableId: string; status: string }, kind: "created" | "updated"): void {
  emit(kind === "created" ? "waiter.task.created" : "waiter.task.updated", {
    task,
    unassigned: task.assignedWaiterId == null,
  });
  if (kind === "updated") emit("waiter.assignment.updated", { task });
}

export function publishSeating(result: { reservation?: Reservation | null; group?: TableGroup | null; journal?: RestaurantEvent[] }): void {
  publishJournal(result);
  if (result.reservation) emit("reservation.updated", { reservation: result.reservation });
  if (result.group) emit("table.group.updated", { group: result.group });
}

export function publishReset(snapshot: Snapshot): void {
  emit("demo.reset", snapshot);
}
