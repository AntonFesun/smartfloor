import type Database from "better-sqlite3";
import { DomainError } from "@/domain/errors";
import { findOpenSpot, layoutErrorMessage, layoutIssues, normalizeRotation, roundCoord } from "@/domain/layout";
import { computeMetrics } from "@/domain/metrics";
import { eventForOrderStatus, isOpenOrder, nextOrderStatus } from "@/domain/orders";
import { buildSeed } from "@/domain/seed-data";
import { assertSeatCount, nextTableStatus } from "@/domain/tables";
import { assertCanCall, isActiveWaiter, nextWaiterStatus } from "@/domain/waiter";
import type { RestaurantEvent } from "@/domain/journal";
import { nid } from "@/lib/ids";
import { appendCommandEvent, listAllEvents, migrateJournal, startCommand, type JournalCommand, type JournalDraft } from "@/lib/journal";
import {
  assertTicketsAllowReady,
  cancelOrderTickets,
  createTicketsForOrder,
  listDeliveryTasks,
  listKitchenTickets,
  migrateKitchen,
  settleReadyOrder,
  settleServedOrder,
} from "@/lib/kitchen";
import { acknowledgeCallTask, completeCallTask, createAssignedTask, listShifts, listWaiters, listWaiterTasks, listZoneAssignments, migrateWaiters, seedStaff } from "@/lib/waiters";
import { DEMO_PAID_ORDER_IDS, type PaymentRecord } from "@/domain/revenue";
import { persistMonthHistory } from "@/lib/month-history";
import { migrateSimulationStore } from "@/lib/simulation-store";
import { listReservations, listTableGroups, migrateSeating } from "@/lib/seating";
import type {
  Capacity,
  EventType,
  LayoutPatch,
  MenuItem,
  Order,
  OrderItem,
  OrderStatus,
  RestaurantTable,
  ServiceEvent,
  Snapshot,
  TableShape,
  TableStatus,
  Thresholds,
  WaiterCall,
  WaiterStatus,
  ZoneName,
} from "@/types";
import { RESTAURANT_NAME } from "@/types";

// 2 reloads the live floor plus about 30 days of Europe/Kyiv history on reset.
const SCHEMA_VERSION = "2";

interface SnapshotContext {
  now?: number;
  publicUrl: string;
  thresholds: Thresholds;
}

interface TableRow {
  id: string;
  number: number;
  zone: ZoneName;
  shape: TableShape;
  x: number;
  y: number;
  rotation: number;
  capacity: Capacity;
  occupied_seat_count: number;
  status: TableStatus;
}

interface MenuRow {
  id: string;
  name: string;
  category: MenuItem["category"];
  price: number;
  description: string;
  sort: number;
  station: MenuItem["station"];
}

interface OrderRow {
  id: string;
  table_id: string;
  status: OrderStatus;
  total: number;
  created_at: string;
  updated_at: string;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  menu_item_id: string;
  name: string;
  qty: number;
  price: number;
}

interface CallRow {
  id: string;
  table_id: string;
  status: WaiterStatus;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface EventRow {
  id: string;
  table_id: string;
  timestamp: string;
  type: EventType;
  order_id: string | null;
  call_id: string | null;
  metadata: string;
}

function mapTable(row: TableRow): RestaurantTable {
  return {
    id: row.id,
    number: row.number,
    zone: row.zone,
    shape: row.shape,
    x: row.x,
    y: row.y,
    rotation: row.rotation,
    capacity: row.capacity,
    occupiedSeatCount: row.occupied_seat_count,
    status: row.status,
  };
}

function mapMenu(row: MenuRow): MenuItem {
  return row;
}

function mapCall(row: CallRow): WaiterCall {
  return {
    id: row.id,
    tableId: row.table_id,
    status: row.status,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

function mapEvent(row: EventRow): ServiceEvent {
  return {
    id: row.id,
    tableId: row.table_id,
    timestamp: row.timestamp,
    type: row.type,
    orderId: row.order_id,
    callId: row.call_id,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      zone TEXT NOT NULL,
      shape TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      rotation REAL NOT NULL,
      capacity INTEGER NOT NULL,
      occupied_seat_count INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT NOT NULL,
      sort INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      menu_item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waiter_calls (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      order_id TEXT,
      call_id TEXT,
      metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
    CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_calls_table ON waiter_calls(table_id);
    CREATE INDEX IF NOT EXISTS idx_events_table ON events(table_id);
  `);
  migrateJournal(db);
  migrateKitchen(db);
  migrateWaiters(db);
  migrateSeating(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      table_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      paid_at TEXT NOT NULL,
      note TEXT NOT NULL
    );
  `);
  ensureDemoPayments(db);
  migrateSimulationStore(db);
}

function readTables(db: Database.Database): RestaurantTable[] {
  return (db.prepare("SELECT * FROM tables ORDER BY number ASC").all() as TableRow[]).map(mapTable);
}

function readMenu(db: Database.Database): MenuItem[] {
  return (db.prepare("SELECT * FROM menu_items ORDER BY sort ASC, name ASC").all() as MenuRow[]).map(mapMenu);
}

function readOrders(db: Database.Database): Order[] {
  const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all() as OrderRow[];
  const items = db.prepare("SELECT * FROM order_items").all() as OrderItemRow[];
  const byOrder = new Map<string, OrderItem[]>();
  for (const item of items) {
    const line: OrderItem = {
      id: item.id,
      menuItemId: item.menu_item_id,
      name: item.name,
      qty: item.qty,
      price: item.price,
    };
    const list = byOrder.get(item.order_id);
    if (list) list.push(line);
    else byOrder.set(item.order_id, [line]);
  }
  return orders.map((order) => ({
    id: order.id,
    tableId: order.table_id,
    status: order.status,
    items: byOrder.get(order.id) ?? [],
    total: order.total,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  }));
}

function readCalls(db: Database.Database): WaiterCall[] {
  return (db.prepare("SELECT * FROM waiter_calls ORDER BY created_at DESC").all() as CallRow[]).map(mapCall);
}

function readEvents(db: Database.Database): ServiceEvent[] {
  return (
    db.prepare("SELECT * FROM events ORDER BY timestamp ASC, id ASC").all() as EventRow[]
  ).map(mapEvent);
}

function requireTable(db: Database.Database, id: string): RestaurantTable {
  const row = db.prepare("SELECT * FROM tables WHERE id = ?").get(id) as TableRow | undefined;
  if (!row) throw new DomainError("not_found", "Table not found", 404);
  return mapTable(row);
}

function requireOrder(db: Database.Database, id: string): Order {
  const order = readOrders(db).find((item) => item.id === id);
  if (!order) throw new DomainError("not_found", "Order not found", 404);
  return order;
}

function requireCall(db: Database.Database, id: string): WaiterCall {
  const row = db.prepare("SELECT * FROM waiter_calls WHERE id = ?").get(id) as CallRow | undefined;
  if (!row) throw new DomainError("not_found", "Waiter call not found", 404);
  return mapCall(row);
}

function insertEvent(
  db: Database.Database,
  input: {
    tableId: string;
    timestamp: string;
    type: EventType;
    orderId?: string | null;
    callId?: string | null;
    metadata?: Record<string, unknown>;
  },
): ServiceEvent {
  const event: ServiceEvent = {
    id: nid("evt"),
    tableId: input.tableId,
    timestamp: input.timestamp,
    type: input.type,
    orderId: input.orderId ?? null,
    callId: input.callId ?? null,
    metadata: input.metadata ?? {},
  };
  db.prepare(
    `INSERT INTO events (id, table_id, timestamp, type, order_id, call_id, metadata)
     VALUES (@id, @tableId, @timestamp, @type, @orderId, @callId, @metadata)`,
  ).run({ ...event, metadata: JSON.stringify(event.metadata) });
  return event;
}

function writeTable(db: Database.Database, table: RestaurantTable): void {
  db.prepare(
    `UPDATE tables
     SET zone = @zone, shape = @shape, x = @x, y = @y, rotation = @rotation,
         capacity = @capacity, occupied_seat_count = @occupiedSeatCount, status = @status
     WHERE id = @id`,
  ).run(table);
}

export function seed(db: Database.Database, now = Date.now()): void {
  const bundle = buildSeed(now);
  const tx = db.transaction(() => {
    db.exec("DELETE FROM restaurant_state_snapshots; DELETE FROM restaurant_events; DELETE FROM payments; DELETE FROM reservation_intervals; DELETE FROM table_group_members; DELETE FROM table_groups; DELETE FROM kitchen_ticket_items; DELETE FROM kitchen_tickets; DELETE FROM waiter_tasks; DELETE FROM waiter_zone_assignments; DELETE FROM waiter_shifts; DELETE FROM waiters; DELETE FROM events; DELETE FROM order_items; DELETE FROM orders; DELETE FROM waiter_calls; DELETE FROM tables; DELETE FROM menu_items;");
    const sequence = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
    if (sequence) db.prepare("DELETE FROM sqlite_sequence WHERE name = 'restaurant_events'").run();
    const insertTable = db.prepare(
      `INSERT INTO tables (id, number, zone, shape, x, y, rotation, capacity, occupied_seat_count, status)
       VALUES (@id, @number, @zone, @shape, @x, @y, @rotation, @capacity, @occupiedSeatCount, @status)`,
    );
    const insertMenu = db.prepare(
      `INSERT INTO menu_items (id, name, category, price, description, sort, station)
       VALUES (@id, @name, @category, @price, @description, @sort, @station)`,
    );
    const insertOrder = db.prepare(
      `INSERT INTO orders (id, table_id, status, total, created_at, updated_at)
       VALUES (@id, @tableId, @status, @total, @createdAt, @updatedAt)`,
    );
    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, menu_item_id, name, qty, price)
       VALUES (@id, @orderId, @menuItemId, @name, @qty, @price)`,
    );
    const insertCall = db.prepare(
      `INSERT INTO waiter_calls (id, table_id, status, created_at, acknowledged_at, resolved_at)
       VALUES (@id, @tableId, @status, @createdAt, @acknowledgedAt, @resolvedAt)`,
    );
    const insertSeedEvent = db.prepare(
      `INSERT INTO events (id, table_id, timestamp, type, order_id, call_id, metadata)
       VALUES (@id, @tableId, @timestamp, @type, @orderId, @callId, @metadata)`,
    );
    for (const table of bundle.tables) insertTable.run(table);
    for (const item of bundle.menu) insertMenu.run(item);
    for (const order of bundle.orders) {
      insertOrder.run(order);
      for (const item of order.items) insertItem.run({ ...item, orderId: order.id });
    }
    for (const call of bundle.calls) insertCall.run(call);
    for (const event of bundle.events) insertSeedEvent.run({ ...event, metadata: JSON.stringify(event.metadata) });
    ensureDemoPayments(db);
    seedStaff(db, now);
    persistMonthHistory(db, now);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      SCHEMA_VERSION,
    );
  });
  tx();
}

export function seedIfEmpty(db: Database.Database): void {
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
  const count = db.prepare("SELECT COUNT(*) AS c FROM tables").get() as { c: number };
  if (!version || version.value !== SCHEMA_VERSION || count.c === 0) seed(db);
}

export function getSnapshot(db: Database.Database, context: SnapshotContext): Snapshot {
  const now = context.now ?? Date.now();
  const tables = readTables(db);
  const orders = readOrders(db);
  const waiterCalls = readCalls(db);
  const events = readEvents(db);
  const menu = readMenu(db);
  const tickets = listKitchenTickets(db);
  const deliveryTasks = listDeliveryTasks(db);
  const waiters = listWaiters(db);
  const shifts = listShifts(db);
  const zoneAssignments = listZoneAssignments(db);
  const waiterTasks = listWaiterTasks(db);
  const reservations = listReservations(db);
  const tableGroups = listTableGroups(db);
  const payments = listPayments(db);
  const revenue = orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0);
  return {
    restaurant: { name: RESTAURANT_NAME },
    tables,
    orders,
    waiterCalls,
    events,
    menu,
    tickets,
    deliveryTasks,
    waiters,
    shifts,
    zoneAssignments,
    waiterTasks,
    reservations,
    tableGroups,
    payments,
    journal: listAllEvents(db),
    revenue,
    publicUrl: context.publicUrl,
    generatedAt: new Date(now).toISOString(),
    metrics: computeMetrics({ events, tables, orders, waiterCalls, now, thresholds: context.thresholds }),
  };
}

export function resetDemo(db: Database.Database, context: SnapshotContext): Snapshot {
  seed(db, context.now ?? Date.now());
  return getSnapshot(db, context);
}

function summaryOf(items: { name: string; qty: number }[]): string {
  return items.map((item) => `${item.name} × ${item.qty}`).join(", ");
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

const DEMO_PAYMENT_NOTE = "Demo payment. Not a card processor.";

export function ensureDemoPayments(db: Database.Database): void {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM payments").get() as { c: number };
  if (existing.c > 0) return;
  const ids = [...DEMO_PAID_ORDER_IDS];
  const rows = db.prepare(
    `SELECT id, table_id, total, updated_at, status FROM orders WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as { id: string; table_id: string; total: number; updated_at: string; status: string }[];
  const insert = db.prepare("INSERT INTO payments (id, order_id, table_id, amount, paid_at, note) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    if (row.status !== "SERVED") continue;
    insert.run(`pay-${row.id}`, row.id, row.table_id, row.total, row.updated_at, DEMO_PAYMENT_NOTE);
  }
}

export function listPayments(db: Database.Database): PaymentRecord[] {
  return (db.prepare("SELECT id, order_id, table_id, amount, paid_at, note FROM payments ORDER BY paid_at ASC, id ASC").all() as {
    id: string;
    order_id: string;
    table_id: string;
    amount: number;
    paid_at: string;
    note: string;
  }[]).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    tableId: row.table_id,
    amount: row.amount,
    paidAt: row.paid_at,
    note: row.note,
  }));
}

export function recordPayment(
  db: Database.Database,
  input: { orderId: string; amount?: number; now?: number; idempotencyKey?: string },
): { payment: PaymentRecord; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, input.idempotencyKey);
    if (started.replay) {
      const recorded = started.replay.find((event) => event.type === "PAYMENT_RECORDED");
      const paymentId = recorded?.payload.paymentId;
      if (typeof paymentId !== "string") throw new DomainError("idempotency_conflict", "Stored payment could not be replayed", 409);
      return { payment: requirePayment(db, paymentId), journal: started.replay, idempotentReplay: true };
    }
    const order = requireOrder(db, input.orderId);
    if (order.status === "CANCELLED") throw new DomainError("cancelled", "A cancelled order is not a completed sale", 409);
    const duplicate = db.prepare("SELECT id FROM payments WHERE order_id = ?").get(order.id) as { id: string } | undefined;
    if (duplicate) throw new DomainError("already_paid", "This order already has a recorded payment", 409);
    const amount = input.amount ?? order.total;
    if (!Number.isInteger(amount) || amount < 0) throw new DomainError("amount", "Payment amount must be a whole number of hryvnias", 400);
    const paidAt = new Date(input.now ?? Date.now()).toISOString();
    const id = nid("pay");
    db.prepare("INSERT INTO payments (id, order_id, table_id, amount, paid_at, note) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      order.id,
      order.tableId,
      amount,
      paidAt,
      "Recorded payment. Not a card processor.",
    );
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "PAYMENT_RECORDED",
      occurredAt: paidAt,
      tableId: order.tableId,
      orderId: order.id,
      payload: { paymentId: id, orderId: order.id, tableId: order.tableId, amount, paidAt },
    });
    return { payment: requirePayment(db, id), journal, idempotentReplay: false };
  })();
}

function requirePayment(db: Database.Database, id: string): PaymentRecord {
  const payment = listPayments(db).find((item) => item.id === id);
  if (!payment) throw new DomainError("not_found", "Payment was not found", 404);
  return payment;
}

export function createOrder(
  db: Database.Database,
  input: { tableId: string; items: { menuItemId: string; qty: number }[]; idempotencyKey?: string },
  now = Date.now(),
): { order: Order; table: RestaurantTable; events: ServiceEvent[]; journal: RestaurantEvent[]; tickets: import("@/domain/kitchen").KitchenTicket[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, input.idempotencyKey);
    if (started.replay) {
      const created = started.replay.find((event) => event.type === "ORDER_CREATED");
      if (!created?.orderId || !created.tableId) {
        throw new DomainError("idempotency_conflict", "Stored order could not be replayed", 409);
      }
      return {
        order: requireOrder(db, created.orderId),
        table: requireTable(db, created.tableId),
        events: [],
        journal: started.replay,
        tickets: [],
        idempotentReplay: true,
      };
    }
    const journal: RestaurantEvent[] = [];
    const occurredAt = new Date(now).toISOString();
    const table = requireTable(db, input.tableId);
    const merged = new Map<string, number>();
    for (const item of input.items) {
      merged.set(item.menuItemId, (merged.get(item.menuItemId) ?? 0) + item.qty);
    }
    const menu = new Map(readMenu(db).map((item) => [item.id, item]));
    const lines: OrderItem[] = [];
    for (const [menuItemId, qty] of merged) {
      const item = menu.get(menuItemId);
      if (!item) throw new DomainError("bad_item", "Unknown menu item");
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
        throw new DomainError("bad_qty", "Quantity must be between 1 and 20");
      }
      lines.push({ id: nid("line"), menuItemId, name: item.name, qty, price: item.price });
    }
    if (lines.length === 0) throw new DomainError("empty_order", "Add at least one item");

    const events: ServiceEvent[] = [];
    let current = table;
    let clock = now;
    const stamp = () => {
      const value = new Date(clock).toISOString();
      clock += 1;
      return value;
    };

    if (table.status !== "OCCUPIED") {
      const occupiedSeatCount = Math.min(table.capacity, Math.max(table.occupiedSeatCount, 2));
      current = { ...table, status: "OCCUPIED", occupiedSeatCount };
      writeTable(db, current);
      events.push(
        insertEvent(db, {
          tableId: table.id,
          timestamp: stamp(),
          type: "guests.seated",
          metadata: { summary: `Party of ${occupiedSeatCount}` },
        }),
      );
      writeJournal(db, started.command, journal, {
        type: "TABLE_OCCUPIED",
        occurredAt,
        tableId: table.id,
        zoneId: table.zone,
        payload: { tableId: table.id, occupiedSeatCount, previousStatus: table.status },
      });
      writeJournal(db, started.command, journal, {
        type: "GUEST_SEATED",
        occurredAt,
        tableId: table.id,
        zoneId: table.zone,
        payload: { tableId: table.id, occupiedSeatCount },
      });
    }

    const createdAt = stamp();
    const orderId = nid("ord");
    const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    db.prepare(
      `INSERT INTO orders (id, table_id, status, total, created_at, updated_at)
       VALUES (?, ?, 'NEW', ?, ?, ?)`,
    ).run(orderId, table.id, total, createdAt, createdAt);
    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, menu_item_id, name, qty, price)
       VALUES (@id, @orderId, @menuItemId, @name, @qty, @price)`,
    );
    for (const line of lines) insertItem.run({ ...line, orderId });
    events.push(
      insertEvent(db, {
        tableId: table.id,
        timestamp: createdAt,
        type: "order.submitted",
        orderId,
        metadata: { summary: summaryOf(lines), total },
      }),
    );
    const order = requireOrder(db, orderId);
    writeJournal(db, started.command, journal, {
      type: "ORDER_CREATED",
      occurredAt,
      tableId: table.id,
      orderId,
      zoneId: current.zone,
      payload: { order },
    });
    const tickets = createTicketsForOrder(db, started.command, journal, {
      orderId,
      tableId: table.id,
      occurredAt,
      lines: lines.map((line) => ({
        menuItemId: line.menuItemId,
        name: line.name,
        qty: line.qty,
        category: menu.get(line.menuItemId)?.category ?? "",
      })),
    });
    return { order, table: current, events, journal, tickets, idempotentReplay: false };
  })();
}

export function transitionOrder(
  db: Database.Database,
  orderId: string,
  target: OrderStatus,
  now = Date.now(),
  idempotencyKey?: string,
): {
    order: Order;
    events: ServiceEvent[];
    journal: RestaurantEvent[];
    tickets: import("@/domain/kitchen").KitchenTicket[];
    task: import("@/domain/kitchen").DeliveryTask | null;
    idempotentReplay: boolean;
  } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) {
      return { order: requireOrder(db, orderId), events: [], journal: started.replay, tickets: [], task: null, idempotentReplay: true };
    }
    const current = requireOrder(db, orderId);
    if (target === "READY") assertTicketsAllowReady(db, orderId);
    nextOrderStatus(current.status, target);
    const updatedAt = new Date(now).toISOString();
    const journal: RestaurantEvent[] = [];
    const info = db
      .prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(target, updatedAt, orderId, current.status);
    if (info.changes !== 1) {
      throw new DomainError("conflict", "Order was already updated", 409);
    }
    const events: ServiceEvent[] = [];
    const type = eventForOrderStatus(target);
    if (type) {
      events.push(
        insertEvent(db, {
          tableId: current.tableId,
          timestamp: updatedAt,
          type,
          orderId,
          metadata: { summary: summaryOf(current.items) },
        }),
      );
    }
    const order = requireOrder(db, orderId);
    const journalType = journalTypeForOrder(target);
    if (journalType) {
      writeJournal(db, started.command, journal, {
        type: journalType,
        occurredAt: updatedAt,
        tableId: current.tableId,
        orderId,
        zoneId: requireTable(db, current.tableId).zone,
        payload: { orderId, tableId: current.tableId, from: current.status, to: target },
      });
    }
    let task: import("@/domain/kitchen").DeliveryTask | null = null;
    let tickets = listKitchenTickets(db).filter((ticket) => ticket.orderId === orderId);
    if (target === "READY") {
      const delivery = settleReadyOrder(db, started.command, journal, { id: orderId, tableId: current.tableId }, updatedAt);
      task = delivery.created ? delivery.task : null;
    }
    if (target === "SERVED") {
      const settled = settleServedOrder(db, started.command, journal, orderId, updatedAt);
      task = settled.task;
      tickets = settled.tickets;
    }
    if (target === "CANCELLED") tickets = cancelOrderTickets(db, orderId, updatedAt);
    return { order, events, journal, tickets, task, idempotentReplay: false };
  })();
}

export function callWaiter(
  db: Database.Database,
  tableId: string,
  now = Date.now(),
  idempotencyKey?: string,
): {
    call: WaiterCall;
    events: ServiceEvent[];
    journal: RestaurantEvent[];
    task: import("@/domain/waiters").WaiterTask | null;
    unassigned: boolean;
    idempotentReplay: boolean;
  } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) {
      const called = started.replay.find((event) => event.type === "WAITER_CALLED");
      const stored = called?.payload.call;
      const callId = stored && typeof stored === "object" && "id" in stored ? String((stored as { id: string }).id) : "";
      if (!callId) throw new DomainError("idempotency_conflict", "Stored waiter call could not be replayed", 409);
      return { call: requireCall(db, callId), events: [], journal: started.replay, task: null, unassigned: false, idempotentReplay: true };
    }
    const table = requireTable(db, tableId);
    const existing = db
      .prepare("SELECT id FROM waiter_calls WHERE table_id = ? AND status IN ('ACTIVE', 'ACKNOWLEDGED')")
      .get(tableId) as { id: string } | undefined;
    assertCanCall(Boolean(existing));
    const timestamp = new Date(now).toISOString();
    const id = nid("call");
    db.prepare(
      `INSERT INTO waiter_calls (id, table_id, status, created_at, acknowledged_at, resolved_at)
       VALUES (?, ?, 'ACTIVE', ?, NULL, NULL)`,
    ).run(id, tableId, timestamp);
    const events = [insertEvent(db, { tableId, timestamp, type: "waiter.called", callId: id })];
    const call = requireCall(db, id);
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "WAITER_CALLED",
      occurredAt: timestamp,
      tableId,
      zoneId: table.zone,
      payload: { call },
    });
    const assigned = createAssignedTask(db, started.command, journal, {
      type: "respond_to_call",
      tableId,
      zone: table.zone,
      callId: id,
      priority: 2,
      occurredAt: timestamp,
    });
    return { call, events, journal, task: assigned.task, unassigned: assigned.unassigned, idempotentReplay: false };
  })();
}

export function acknowledgeWaiter(
  db: Database.Database,
  callId: string,
  now = Date.now(),
  idempotencyKey?: string,
): { call: WaiterCall; events: ServiceEvent[]; journal: RestaurantEvent[]; task: import("@/domain/waiters").WaiterTask | null; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { call: requireCall(db, callId), events: [], journal: started.replay, task: null, idempotentReplay: true };
    const current = requireCall(db, callId);
    nextWaiterStatus(current.status, "acknowledge");
    const timestamp = new Date(now).toISOString();
    const info = db
      .prepare("UPDATE waiter_calls SET status = 'ACKNOWLEDGED', acknowledged_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .run(timestamp, callId);
    if (info.changes !== 1) throw new DomainError("conflict", "Waiter call was already updated", 409);
    const events = [insertEvent(db, { tableId: current.tableId, timestamp, type: "waiter.acknowledged", callId })];
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "WAITER_CALL_ACKNOWLEDGED",
      occurredAt: timestamp,
      tableId: current.tableId,
      zoneId: requireTable(db, current.tableId).zone,
      payload: { callId, tableId: current.tableId, from: current.status, to: "ACKNOWLEDGED" },
    });
    const task = acknowledgeCallTask(db, callId, timestamp);
    return { call: requireCall(db, callId), events, journal, task, idempotentReplay: false };
  })();
}

export function resolveWaiter(
  db: Database.Database,
  callId: string,
  now = Date.now(),
  idempotencyKey?: string,
): { call: WaiterCall; events: ServiceEvent[]; journal: RestaurantEvent[]; task: import("@/domain/waiters").WaiterTask | null; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { call: requireCall(db, callId), events: [], journal: started.replay, task: null, idempotentReplay: true };
    const current = requireCall(db, callId);
    nextWaiterStatus(current.status, "resolve");
    const timestamp = new Date(now).toISOString();
    const info = db
      .prepare(
        "UPDATE waiter_calls SET status = 'RESOLVED', resolved_at = ?, acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ? AND status IN ('ACTIVE', 'ACKNOWLEDGED')",
      )
      .run(timestamp, timestamp, callId);
    if (info.changes !== 1) throw new DomainError("conflict", "Waiter call was already updated", 409);
    const events = [insertEvent(db, { tableId: current.tableId, timestamp, type: "waiter.resolved", callId })];
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "WAITER_CALL_RESOLVED",
      occurredAt: timestamp,
      tableId: current.tableId,
      zoneId: requireTable(db, current.tableId).zone,
      payload: { callId, tableId: current.tableId, from: current.status, to: "RESOLVED" },
    });
    const task = completeCallTask(db, started.command, journal, callId, timestamp);
    return { call: requireCall(db, callId), events, journal, task, idempotentReplay: false };
  })();
}

export function seatTable(
  db: Database.Database,
  tableId: string,
  occupiedSeatCount: number,
  now = Date.now(),
  idempotencyKey?: string,
): { table: RestaurantTable; events: ServiceEvent[]; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { table: requireTable(db, tableId), events: [], journal: started.replay, idempotentReplay: true };
    const table = requireTable(db, tableId);
    nextTableStatus(table.status, "seat");
    const seats = assertSeatCount(occupiedSeatCount, table.capacity);
    const next = { ...table, status: "OCCUPIED" as const, occupiedSeatCount: seats };
    writeTable(db, next);
    const timestamp = new Date(now).toISOString();
    const events = [
      insertEvent(db, {
        tableId,
        timestamp,
        type: "guests.seated",
        metadata: { summary: `Party of ${seats}` },
      }),
    ];
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "TABLE_OCCUPIED",
      occurredAt: timestamp,
      tableId,
      zoneId: table.zone,
      payload: { tableId, occupiedSeatCount: seats, previousStatus: table.status },
    });
    writeJournal(db, started.command, journal, {
      type: "GUEST_SEATED",
      occurredAt: timestamp,
      tableId,
      zoneId: table.zone,
      payload: { tableId, occupiedSeatCount: seats },
    });
    return { table: next, events, journal, idempotentReplay: false };
  })();
}

export function reserveTable(
  db: Database.Database,
  tableId: string,
  idempotencyKey?: string,
): { table: RestaurantTable; events: ServiceEvent[]; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { table: requireTable(db, tableId), events: [], journal: started.replay, idempotentReplay: true };
    const table = requireTable(db, tableId);
    nextTableStatus(table.status, "reserve");
    const next = { ...table, status: "RESERVED" as const, occupiedSeatCount: 0 };
    writeTable(db, next);
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "TABLE_STATUS_CHANGED",
      occurredAt: new Date().toISOString(),
      tableId,
      zoneId: table.zone,
      payload: { tableId, from: table.status, to: "RESERVED", occupiedSeatCount: 0 },
    });
    return { table: next, events: [], journal, idempotentReplay: false };
  })();
}

export function releaseTable(
  db: Database.Database,
  tableId: string,
  idempotencyKey?: string,
): { table: RestaurantTable; events: ServiceEvent[]; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { table: requireTable(db, tableId), events: [], journal: started.replay, idempotentReplay: true };
    const table = requireTable(db, tableId);
    nextTableStatus(table.status, "release");
    const next = { ...table, status: "AVAILABLE" as const, occupiedSeatCount: 0 };
    writeTable(db, next);
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "TABLE_STATUS_CHANGED",
      occurredAt: new Date().toISOString(),
      tableId,
      zoneId: table.zone,
      payload: { tableId, from: table.status, to: "AVAILABLE", occupiedSeatCount: 0 },
    });
    return { table: next, events: [], journal, idempotentReplay: false };
  })();
}

export function clearTable(
  db: Database.Database,
  tableId: string,
  now = Date.now(),
  idempotencyKey?: string,
): { table: RestaurantTable; events: ServiceEvent[]; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { table: requireTable(db, tableId), events: [], journal: started.replay, idempotentReplay: true };
    const table = requireTable(db, tableId);
    nextTableStatus(table.status, "clear");
    const next = { ...table, status: "AVAILABLE" as const, occupiedSeatCount: 0 };
    writeTable(db, next);
    const timestamp = new Date(now).toISOString();
    const events = [insertEvent(db, { tableId, timestamp, type: "table.cleared" })];
    const journal: RestaurantEvent[] = [];
    writeJournal(db, started.command, journal, {
      type: "GUEST_LEFT",
      occurredAt: timestamp,
      tableId,
      zoneId: table.zone,
      payload: { tableId, previousOccupiedSeatCount: table.occupiedSeatCount },
    });
    writeJournal(db, started.command, journal, {
      type: "TABLE_RELEASED",
      occurredAt: timestamp,
      tableId,
      zoneId: table.zone,
      payload: { tableId, from: table.status },
    });
    return { table: next, events, journal, idempotentReplay: false };
  })();
}

export function saveLayout(
  db: Database.Database,
  patches: LayoutPatch[],
  idempotencyKey?: string,
): { tables: RestaurantTable[]; journal: RestaurantEvent[]; idempotentReplay: boolean } {
  return db.transaction(() => {
    const started = startCommand(db, idempotencyKey);
    if (started.replay) return { tables: readTables(db), journal: started.replay, idempotentReplay: true };
    const existing = readTables(db);
    if (patches.length !== existing.length) {
      throw new DomainError("layout_mismatch", "Layout must include every table");
    }
    const byId = new Map(patches.map((patch) => [patch.id, patch]));
    if (byId.size !== patches.length) throw new DomainError("layout_mismatch", "Duplicate table in layout");
    const nextTables = existing.map((table) => {
      const patch = byId.get(table.id);
      if (!patch) throw new DomainError("layout_mismatch", "Layout must include every table");
      if (table.occupiedSeatCount > patch.capacity) {
        throw new DomainError(
          "capacity",
          `${table.id} is seating ${table.occupiedSeatCount}, which is more than ${patch.capacity}`,
        );
      }
      return {
        ...table,
        x: roundCoord(patch.x),
        y: roundCoord(patch.y),
        rotation: roundCoord(normalizeRotation(patch.rotation)),
        shape: patch.shape,
        capacity: patch.capacity,
        zone: patch.zone,
      };
    });
    const issues = layoutIssues(nextTables);
    if (issues.length > 0) throw new DomainError("layout_invalid", layoutErrorMessage(issues));
    for (const table of nextTables) writeTable(db, table);
    const occurredAt = new Date().toISOString();
    const journal: RestaurantEvent[] = [];
    for (const table of nextTables) {
      const previous = existing.find((item) => item.id === table.id);
      if (!previous) continue;
      const moved =
        previous.x !== table.x ||
        previous.y !== table.y ||
        previous.rotation !== table.rotation ||
        previous.shape !== table.shape ||
        previous.capacity !== table.capacity ||
        previous.zone !== table.zone;
      if (!moved) continue;
      writeJournal(db, started.command, journal, {
        type: "TABLE_MOVED",
        occurredAt,
        tableId: table.id,
        zoneId: table.zone,
        payload: {
          tableId: table.id,
          from: { x: previous.x, y: previous.y, rotation: previous.rotation, shape: previous.shape, capacity: previous.capacity, zone: previous.zone },
          to: { x: table.x, y: table.y, rotation: table.rotation, shape: table.shape, capacity: table.capacity, zone: table.zone },
        },
      });
    }
    return { tables: readTables(db), journal, idempotentReplay: false };
  })();
}

export function addTable(
  db: Database.Database,
  input: { zone: ZoneName; shape: TableShape; capacity: Capacity },
): { table: RestaurantTable; tables: RestaurantTable[] } {
  return db.transaction(() => {
    const tables = readTables(db);
    const spot = findOpenSpot(tables, input.capacity, input.shape);
    if (!spot) throw new DomainError("no_space", "No free space on the floor");
    const number = (db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM tables").get() as { n: number }).n + 1;
    const table: RestaurantTable = {
      id: `T${String(number).padStart(2, "0")}`,
      number,
      zone: input.zone,
      shape: input.shape,
      capacity: input.capacity,
      x: spot.x,
      y: spot.y,
      rotation: 0,
      occupiedSeatCount: 0,
      status: "AVAILABLE",
    };
    const issues = layoutIssues([...tables, table]);
    if (issues.length > 0) throw new DomainError("layout_invalid", layoutErrorMessage(issues));
    db.prepare(
      `INSERT INTO tables (id, number, zone, shape, x, y, rotation, capacity, occupied_seat_count, status)
       VALUES (@id, @number, @zone, @shape, @x, @y, @rotation, @capacity, @occupiedSeatCount, @status)`,
    ).run(table);
    return { table, tables: readTables(db) };
  })();
}

export function removeTable(db: Database.Database, tableId: string): { tables: RestaurantTable[] } {
  return db.transaction(() => {
    requireTable(db, tableId);
    const open = db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE table_id = ? AND status NOT IN ('SERVED', 'CANCELLED')")
      .get(tableId) as { c: number };
    if (open.c > 0) throw new DomainError("table_busy", "Finish or cancel open orders before removing this table", 409);
    const active = db
      .prepare("SELECT COUNT(*) AS c FROM waiter_calls WHERE table_id = ? AND status IN ('ACTIVE', 'ACKNOWLEDGED')")
      .get(tableId) as { c: number };
    if (active.c > 0) throw new DomainError("table_busy", "Resolve the waiter call before removing this table", 409);
    db.prepare("DELETE FROM tables WHERE id = ?").run(tableId);
    return { tables: readTables(db) };
  })();
}

export function activeCallFor(calls: WaiterCall[], tableId: string): WaiterCall | undefined {
  return calls.find((call) => call.tableId === tableId && isActiveWaiter(call.status));
}

export function openOrdersFor(orders: Order[], tableId: string): Order[] {
  return orders.filter((order) => order.tableId === tableId && isOpenOrder(order.status));
}
