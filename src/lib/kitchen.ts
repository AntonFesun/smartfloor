import type Database from "better-sqlite3";
import { DomainError } from "@/domain/errors";
import {
  kitchenMetrics,
  nextTicketStatus,
  stationForMenuItem,
  ticketsBlockReady,
  unfinishedItems,
  type DeliveryTask,
  type KitchenStation,
  type KitchenTicket,
  type KitchenTicketItem,
  type TicketAction,
  type TicketStatus,
} from "@/domain/kitchen";
import type { RestaurantEvent } from "@/domain/journal";
import { eventForOrderStatus, nextOrderStatus } from "@/domain/orders";
import type { JournalCommand, JournalDraft } from "@/lib/journal";
import { appendCommandEvent, startCommand } from "@/lib/journal";
import { nid } from "@/lib/ids";
import { assignForZone } from "@/lib/waiters";
import type { EventType, Order, OrderStatus } from "@/types";

export interface KitchenMutation {
  ticket: KitchenTicket;
  order: Order | null;
  events: ServiceEventRow[];
  journal: RestaurantEvent[];
  task: DeliveryTask | null;
  taskEvent: "created" | "updated" | null;
  idempotentReplay: boolean;
}

interface ServiceEventRow {
  id: string;
  tableId: string;
  timestamp: string;
  type: EventType;
  orderId: string | null;
  callId: string | null;
  metadata: Record<string, unknown>;
}

interface TicketRow {
  id: string;
  number: number;
  order_id: string;
  table_id: string;
  station: KitchenStation;
  status: TicketStatus;
  priority: number;
  notes: string | null;
  created_at: string;
  accepted_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
}

interface TicketItemRow {
  id: string;
  ticket_id: string;
  menu_item_id: string;
  name: string;
  qty: number;
  notes: string | null;
  done: number;
}

interface TaskRow {
  id: string;
  type: "deliver_order";
  order_id: string;
  table_id: string;
  status: "OPEN" | "COMPLETED";
  priority: number;
  created_at: string;
  completed_at: string | null;
  assigned_waiter_id: string | null;
}

const ORDER_STEPS: OrderStatus[] = ["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED"];

export function migrateKitchen(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(menu_items)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "station")) {
    db.exec("ALTER TABLE menu_items ADD COLUMN station TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_tickets (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      order_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      station TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      ready_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      notes TEXT,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_order ON kitchen_tickets(order_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_station ON kitchen_tickets(station, status);
    CREATE INDEX IF NOT EXISTS idx_ticket_items_ticket ON kitchen_ticket_items(ticket_id);
    CREATE TABLE IF NOT EXISTS waiter_tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      order_id TEXT,
      table_id TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      assigned_waiter_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_once ON waiter_tasks(order_id, type);
  `);
  const menu = db.prepare("SELECT id, name, category FROM menu_items").all() as { id: string; name: string; category: string }[];
  const update = db.prepare("UPDATE menu_items SET station = ? WHERE id = ?");
  for (const item of menu) update.run(stationForMenuItem(item), item.id);
}

export function listKitchenTickets(db: Database.Database): KitchenTicket[] {
  const tickets = db.prepare("SELECT * FROM kitchen_tickets ORDER BY number ASC").all() as TicketRow[];
  const items = db.prepare("SELECT * FROM kitchen_ticket_items").all() as TicketItemRow[];
  return tickets.map((ticket) => mapTicket(ticket, items.filter((item) => item.ticket_id === ticket.id)));
}

export function listDeliveryTasks(db: Database.Database): DeliveryTask[] {
  return (db.prepare("SELECT * FROM waiter_tasks WHERE type = 'deliver_order' ORDER BY created_at ASC").all() as TaskRow[]).map(mapTask);
}

export function createTicketsForOrder(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  input: {
    orderId: string;
    tableId: string;
    occurredAt: string;
    lines: { menuItemId: string; name: string; qty: number; category: string }[];
  },
): KitchenTicket[] {
  const groups = new Map<KitchenStation, typeof input.lines>();
  for (const line of input.lines) {
    const station = stationForMenuItem({ id: line.menuItemId, name: line.name, category: line.category });
    if (!station) continue;
    const list = groups.get(station) ?? [];
    list.push(line);
    groups.set(station, list);
  }
  const created: KitchenTicket[] = [];
  for (const station of ["Hot Kitchen", "Cold Kitchen", "Bar"] as const) {
    const lines = groups.get(station);
    if (!lines || lines.length === 0) continue;
    const number = ((db.prepare("SELECT COALESCE(MAX(number), 100) AS n FROM kitchen_tickets").get() as { n: number }).n ?? 100) + 1;
    const id = nid("tkt");
    db.prepare(
      `INSERT INTO kitchen_tickets (
        id, number, order_id, table_id, station, status, priority, notes, created_at, accepted_at, started_at, ready_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'NEW', 1, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(id, number, input.orderId, input.tableId, station, input.occurredAt);
    const insertItem = db.prepare(
      `INSERT INTO kitchen_ticket_items (id, ticket_id, menu_item_id, name, qty, notes, done) VALUES (?, ?, ?, ?, ?, NULL, 0)`,
    );
    for (const line of lines) insertItem.run(nid("tki"), id, line.menuItemId, line.name, line.qty);
    const ticket = requireTicket(db, id);
    journal.push(
      appendCommandEvent(db, command, {
        type: "KITCHEN_TICKET_CREATED",
        occurredAt: input.occurredAt,
        tableId: input.tableId,
        orderId: input.orderId,
        payload: { ticket },
      }),
    );
    created.push(ticket);
  }
  return created;
}

export function assertTicketsAllowReady(db: Database.Database, orderId: string): void {
  const tickets = listKitchenTickets(db).filter((ticket) => ticket.orderId === orderId);
  if (ticketsBlockReady(tickets)) {
    throw new DomainError("tickets_open", "Order becomes READY only when every required ticket is ready", 409);
  }
}

export function settleReadyOrder(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  order: { id: string; tableId: string },
  occurredAt: string,
): { task: DeliveryTask; created: boolean } {
  return ensureDeliveryTask(db, command, journal, order, occurredAt);
}

export function settleServedOrder(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  orderId: string,
  occurredAt: string,
): { task: DeliveryTask | null; tickets: KitchenTicket[] } {
  const existing = db.prepare("SELECT * FROM waiter_tasks WHERE order_id = ? AND type = 'deliver_order'").get(orderId) as TaskRow | undefined;
  let task: DeliveryTask | null = null;
  if (existing && existing.status !== "COMPLETED") {
    db.prepare("UPDATE waiter_tasks SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(occurredAt, existing.id);
    task = mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(existing.id) as TaskRow);
    journal.push(
      appendCommandEvent(db, command, {
        type: "WAITER_TASK_COMPLETED",
        occurredAt,
        tableId: task.tableId,
        orderId,
        payload: { task },
      }),
    );
  }
  db.prepare("UPDATE kitchen_tickets SET status = 'COMPLETED', completed_at = ? WHERE order_id = ? AND status = 'READY'").run(occurredAt, orderId);
  return { task, tickets: listKitchenTickets(db).filter((ticket) => ticket.orderId === orderId) };
}

export function cancelOrderTickets(db: Database.Database, orderId: string, occurredAt: string): KitchenTicket[] {
  db.prepare(
    "UPDATE kitchen_tickets SET status = 'CANCELLED', completed_at = ? WHERE order_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')",
  ).run(occurredAt, orderId);
  return listKitchenTickets(db).filter((ticket) => ticket.orderId === orderId);
}

export function actOnTicket(
  db: Database.Database,
  ticketId: string,
  action: TicketAction,
  options: { itemId?: string; now?: number; idempotencyKey?: string } = {},
): KitchenMutation {
  const now = options.now ?? Date.now();
  return db.transaction(() => {
    const started = startCommand(db, options.idempotencyKey);
    if (started.replay) {
      return {
        ticket: requireTicket(db, ticketId),
        order: null,
        events: [],
        journal: started.replay,
        task: null,
        taskEvent: null,
        idempotentReplay: true,
      };
    }
    const journal: RestaurantEvent[] = [];
    const events: ServiceEventRow[] = [];
    let ticket = requireTicket(db, ticketId);
    const occurredAt = new Date(now).toISOString();
    if (action === "complete_item") {
      if (ticket.status !== "PREPARING") {
        throw new DomainError("invalid_transition", "Items can be completed only while the ticket is preparing", 409);
      }
      const item = ticket.items.find((entry) => entry.id === options.itemId);
      if (!item) throw new DomainError("not_found", "Ticket item not found", 404);
      if (!item.done) db.prepare("UPDATE kitchen_ticket_items SET done = 1 WHERE id = ?").run(item.id);
      ticket = requireTicket(db, ticketId);
      return { ticket, order: null, events, journal, task: null, taskEvent: null, idempotentReplay: false };
    }
    if (action === "complete" && unfinishedItems(ticket.items).length > 0) {
      throw new DomainError("items_open", "Finish every item before the ticket can be ready", 409);
    }
    const next = nextTicketStatus(ticket.status, action);
    const stampColumn =
      next === "ACCEPTED" ? "accepted_at" : next === "PREPARING" ? "started_at" : next === "READY" ? "ready_at" : "completed_at";
    db.prepare(`UPDATE kitchen_tickets SET status = ?, ${stampColumn} = ? WHERE id = ?`).run(next, occurredAt, ticket.id);
    ticket = requireTicket(db, ticketId);
    if (next === "PREPARING") {
      writeJournal(db, started.command, journal, {
        type: "KITCHEN_TICKET_STARTED",
        occurredAt,
        tableId: ticket.tableId,
        orderId: ticket.orderId,
        payload: { ticketId: ticket.id, station: ticket.station },
      });
    }
    if (next === "READY") {
      writeJournal(db, started.command, journal, {
        type: "KITCHEN_TICKET_READY",
        occurredAt,
        tableId: ticket.tableId,
        orderId: ticket.orderId,
        payload: { ticketId: ticket.id, station: ticket.station },
      });
    }
    let order: Order | null = null;
    let task: DeliveryTask | null = null;
    let taskEvent: "created" | "updated" | null = null;
    if (next === "ACCEPTED") order = advanceParent(db, started.command, journal, events, ticket.orderId, "ACCEPTED", occurredAt);
    if (next === "PREPARING") order = advanceParent(db, started.command, journal, events, ticket.orderId, "PREPARING", occurredAt);
    if (next === "READY") {
      const siblings = listKitchenTickets(db).filter((entry) => entry.orderId === ticket.orderId);
      if (!ticketsBlockReady(siblings)) {
        order = advanceParent(db, started.command, journal, events, ticket.orderId, "READY", occurredAt);
        const delivery = ensureDeliveryTask(db, started.command, journal, { id: ticket.orderId, tableId: ticket.tableId }, occurredAt);
        task = delivery.task;
        taskEvent = delivery.created ? "created" : null;
      }
    }
    return { ticket, order, events, journal, task, taskEvent, idempotentReplay: false };
  })();
}

export { kitchenMetrics };

function advanceParent(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  events: ServiceEventRow[],
  orderId: string,
  target: OrderStatus,
  occurredAt: string,
): Order | null {
  let order = readOrder(db, orderId);
  const targetIndex = ORDER_STEPS.indexOf(target);
  let changed = false;
  while (ORDER_STEPS.indexOf(order.status) < targetIndex) {
    const step = ORDER_STEPS[ORDER_STEPS.indexOf(order.status) + 1];
    if (!step) break;
    nextOrderStatus(order.status, step);
    db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(step, occurredAt, order.id, order.status);
    const type = eventForOrderStatus(step);
    if (type) {
      events.push(
        insertServiceEvent(db, {
          tableId: order.tableId,
          timestamp: occurredAt,
          type,
          orderId: order.id,
          metadata: { summary: order.items.map((item) => `${item.name} × ${item.qty}`).join(", ") },
        }),
      );
    }
    const journalType = journalTypeForOrder(step);
    if (journalType) {
      writeJournal(db, command, journal, {
        type: journalType,
        occurredAt,
        tableId: order.tableId,
        orderId: order.id,
        payload: { orderId: order.id, tableId: order.tableId, to: step },
      });
    }
    order = readOrder(db, orderId);
    changed = true;
  }
  return changed ? order : null;
}

function ensureDeliveryTask(
  db: Database.Database,
  command: JournalCommand,
  journal: RestaurantEvent[],
  order: { id: string; tableId: string },
  occurredAt: string,
): { task: DeliveryTask; created: boolean } {
  const existing = db.prepare("SELECT * FROM waiter_tasks WHERE order_id = ? AND type = 'deliver_order'").get(order.id) as TaskRow | undefined;
  if (existing) return { task: mapTask(existing), created: false };
  const zone = (db.prepare("SELECT zone FROM tables WHERE id = ?").get(order.tableId) as { zone: string } | undefined)?.zone ?? "";
  const assignedWaiterId = assignForZone(db, zone, occurredAt);
  const id = nid("task");
  db.prepare(
    `INSERT INTO waiter_tasks (id, type, order_id, table_id, status, priority, created_at, completed_at, assigned_waiter_id)
     VALUES (?, 'deliver_order', ?, ?, 'OPEN', 1, ?, NULL, ?)`,
  ).run(id, order.id, order.tableId, occurredAt, assignedWaiterId);
  const task = mapTask(db.prepare("SELECT * FROM waiter_tasks WHERE id = ?").get(id) as TaskRow);
  writeJournal(db, command, journal, {
    type: "WAITER_TASK_CREATED",
    occurredAt,
    tableId: order.tableId,
    orderId: order.id,
    payload: { task, unassigned: assignedWaiterId == null },
  });
  return { task, created: true };
}

function requireTicket(db: Database.Database, id: string): KitchenTicket {
  const row = db.prepare("SELECT * FROM kitchen_tickets WHERE id = ?").get(id) as TicketRow | undefined;
  if (!row) throw new DomainError("not_found", "Ticket not found", 404);
  const items = db.prepare("SELECT * FROM kitchen_ticket_items WHERE ticket_id = ?").all(id) as TicketItemRow[];
  return mapTicket(row, items);
}

function readOrder(db: Database.Database, id: string): Order {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
    | { id: string; table_id: string; status: OrderStatus; total: number; created_at: string; updated_at: string }
    | undefined;
  if (!row) throw new DomainError("not_found", "Order not found", 404);
  const items = db.prepare("SELECT id, menu_item_id, name, qty, price FROM order_items WHERE order_id = ?").all(id) as {
    id: string;
    menu_item_id: string;
    name: string;
    qty: number;
    price: number;
  }[];
  return {
    id: row.id,
    tableId: row.table_id,
    status: row.status,
    total: row.total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({ id: item.id, menuItemId: item.menu_item_id, name: item.name, qty: item.qty, price: item.price })),
  };
}

function insertServiceEvent(
  db: Database.Database,
  input: { tableId: string; timestamp: string; type: EventType; orderId?: string | null; metadata?: Record<string, unknown> },
): ServiceEventRow {
  const event: ServiceEventRow = {
    id: nid("evt"),
    tableId: input.tableId,
    timestamp: input.timestamp,
    type: input.type,
    orderId: input.orderId ?? null,
    callId: null,
    metadata: input.metadata ?? {},
  };
  db.prepare(
    `INSERT INTO events (id, table_id, timestamp, type, order_id, call_id, metadata) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(event.id, event.tableId, event.timestamp, event.type, event.orderId, JSON.stringify(event.metadata));
  return event;
}

function writeJournal(db: Database.Database, command: JournalCommand, journal: RestaurantEvent[], draft: JournalDraft): void {
  journal.push(appendCommandEvent(db, command, draft));
}

function journalTypeForOrder(status: OrderStatus): JournalDraft["type"] | null {
  switch (status) {
    case "ACCEPTED":
      return "ORDER_ACCEPTED";
    case "PREPARING":
      return "ORDER_PREPARING";
    case "READY":
      return "ORDER_READY";
    case "SERVED":
      return "ORDER_SERVED";
    case "CANCELLED":
      return "ORDER_CANCELLED";
    default:
      return null;
  }
}

function mapTicket(row: TicketRow, items: TicketItemRow[]): KitchenTicket {
  return {
    id: row.id,
    number: row.number,
    orderId: row.order_id,
    tableId: row.table_id,
    station: row.station,
    status: row.status,
    priority: row.priority,
    notes: row.notes,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    completedAt: row.completed_at,
    items: items.map(mapItem),
  };
}

function mapItem(row: TicketItemRow): KitchenTicketItem {
  return {
    id: row.id,
    menuItemId: row.menu_item_id,
    name: row.name,
    qty: row.qty,
    notes: row.notes,
    done: row.done === 1,
  };
}

function mapTask(row: TaskRow): DeliveryTask {
  return {
    id: row.id,
    type: "deliver_order",
    orderId: row.order_id,
    tableId: row.table_id,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    assignedWaiterId: row.assigned_waiter_id ?? null,
  };
}
