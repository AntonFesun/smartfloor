import type Database from "better-sqlite3";
import { JOURNAL_SCHEMA_VERSION, RESTAURANT_ID } from "@/domain/journal";
import { buildMonthHistory, type HistoryTable } from "@/domain/month-history";
import type { KitchenStation } from "@/domain/kitchen";
import type { MenuItem, OrderStatus } from "@/types";

const LIVE_TICKET_STATUS: Record<OrderStatus, string> = {
  NEW: "NEW",
  ACCEPTED: "ACCEPTED",
  PREPARING: "PREPARING",
  READY: "READY",
  SERVED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

export function persistMonthHistory(db: Database.Database, now: number): void {
  const tables = db.prepare("SELECT id, number, zone, capacity FROM tables ORDER BY number ASC").all() as HistoryTable[];
  const menu = db.prepare("SELECT id, name, category, price, description, sort, station FROM menu_items").all() as MenuItem[];
  const service = db.prepare("SELECT table_id, timestamp, type FROM events").all() as { table_id: string; timestamp: string; type: string }[];
  const history = buildMonthHistory({ now, tables, menu, busy: busyIntervals(service, now) });

  const insertOrder = db.prepare(
    `INSERT INTO orders (id, table_id, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (id, order_id, menu_item_id, name, qty, price) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCall = db.prepare(
    `INSERT INTO waiter_calls (id, table_id, status, created_at, acknowledged_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (id, order_id, table_id, amount, paid_at, note) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertTicket = db.prepare(
    `INSERT INTO kitchen_tickets (
      id, number, order_id, table_id, station, status, priority, notes, created_at, accepted_at, started_at, ready_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
  );
  const insertTicketItem = db.prepare(
    `INSERT INTO kitchen_ticket_items (id, ticket_id, menu_item_id, name, qty, notes, done) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO waiter_tasks (
      id, type, order_id, table_id, call_id, status, priority, created_at, acknowledged_at, completed_at, assigned_waiter_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReservation = db.prepare(
    `INSERT INTO reservation_intervals (id, party_size, start_at, end_at, table_id, group_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGroup = db.prepare(
    `INSERT INTO table_groups (id, status, created_at, dissolved_at) VALUES (?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(`INSERT INTO table_group_members (group_id, table_id) VALUES (?, ?)`);
  const insertShift = db.prepare(
    `INSERT INTO waiter_shifts (id, waiter_id, started_at, ended_at) VALUES (?, ?, ?, ?)`,
  );
  const insertService = db.prepare(
    `INSERT INTO events (id, table_id, timestamp, type, order_id, call_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertJournal = db.prepare(
    `INSERT INTO restaurant_events (
      id, restaurant_id, table_id, order_id, waiter_id, zone_id, session_id,
      type, occurred_at, payload, schema_version, idempotency_key, command_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );

  for (const order of history.orders) {
    insertOrder.run(order.id, order.tableId, order.status, order.total, order.createdAt, order.updatedAt);
    for (const item of order.items) insertItem.run(item.id, item.orderId, item.menuItemId, item.name, item.qty, item.price);
  }
  for (const call of history.calls) {
    insertCall.run(call.id, call.tableId, call.status, call.createdAt, call.acknowledgedAt, call.resolvedAt);
  }
  for (const payment of history.payments) {
    insertPayment.run(payment.id, payment.orderId, payment.tableId, payment.amount, payment.paidAt, payment.note);
  }
  for (const ticket of history.tickets) {
    insertTicket.run(
      ticket.id,
      ticket.number,
      ticket.orderId,
      ticket.tableId,
      ticket.station,
      ticket.status,
      ticket.createdAt,
      ticket.acceptedAt,
      ticket.startedAt,
      ticket.readyAt,
      ticket.completedAt,
    );
    for (const item of ticket.items) insertTicketItem.run(item.id, item.ticketId, item.menuItemId, item.name, item.qty, item.done);
  }
  for (const task of history.tasks) {
    insertTask.run(
      task.id,
      task.type,
      task.orderId,
      task.tableId,
      task.callId,
      task.status,
      task.priority,
      task.createdAt,
      task.acknowledgedAt,
      task.completedAt,
      task.assignedWaiterId,
    );
  }
  for (const group of history.groups) {
    insertGroup.run(group.id, group.status, group.createdAt, group.dissolvedAt);
    for (const tableId of group.tableIds) insertMember.run(group.id, tableId);
  }
  for (const reservation of history.reservations) {
    insertReservation.run(
      reservation.id,
      reservation.partySize,
      reservation.startAt,
      reservation.endAt,
      reservation.tableId,
      reservation.groupId,
      reservation.status,
      reservation.createdAt,
    );
  }
  for (const shift of history.shifts) insertShift.run(shift.id, shift.waiterId, shift.startedAt, shift.endedAt);
  for (const event of history.serviceEvents) {
    insertService.run(event.id, event.tableId, event.timestamp, event.type, event.orderId, event.callId, JSON.stringify(event.metadata));
  }
  for (const event of history.journal) {
    insertJournal.run(
      event.id,
      RESTAURANT_ID,
      event.tableId,
      event.orderId,
      event.waiterId,
      event.zoneId,
      event.sessionId,
      event.type,
      event.occurredAt,
      JSON.stringify(event.payload),
      JOURNAL_SCHEMA_VERSION,
      event.commandId,
    );
  }
  writeLiveKitchenTickets(db);
}

function busyIntervals(events: { table_id: string; timestamp: string; type: string }[], now: number): { tableId: string; start: number; end: number }[] {
  const grouped = new Map<string, { timestamp: string; type: string }[]>();
  for (const event of events) {
    if (event.type !== "guests.seated" && event.type !== "table.cleared") continue;
    const list = grouped.get(event.table_id) ?? [];
    list.push(event);
    grouped.set(event.table_id, list);
  }
  const intervals: { tableId: string; start: number; end: number }[] = [];
  for (const [tableId, list] of grouped) {
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let open: number | null = null;
    for (const event of sorted) {
      const time = Date.parse(event.timestamp);
      if (event.type === "guests.seated" && open == null) open = time;
      if (event.type === "table.cleared" && open != null) {
        intervals.push({ tableId, start: open, end: time });
        open = null;
      }
    }
    if (open != null) intervals.push({ tableId, start: open, end: now + 60 * 60 * 1000 });
  }
  return intervals;
}

function writeLiveKitchenTickets(db: Database.Database): void {
  const orders = db.prepare("SELECT id, table_id, status, created_at, updated_at FROM orders WHERE id LIKE 'ord-seed-%'").all() as {
    id: string;
    table_id: string;
    status: OrderStatus;
    created_at: string;
    updated_at: string;
  }[];
  const insertTicket = db.prepare(
    `INSERT INTO kitchen_tickets (
      id, number, order_id, table_id, station, status, priority, notes, created_at, accepted_at, started_at, ready_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO kitchen_ticket_items (id, ticket_id, menu_item_id, name, qty, notes, done) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  let number = (db.prepare("SELECT COALESCE(MAX(number), 100) AS n FROM kitchen_tickets").get() as { n: number }).n;
  let itemNo = 0;
  for (const order of orders) {
    const lines = db
      .prepare(
        `SELECT order_items.menu_item_id, order_items.name, order_items.qty, menu_items.station
         FROM order_items JOIN menu_items ON menu_items.id = order_items.menu_item_id
         WHERE order_items.order_id = ?`,
      )
      .all(order.id) as { menu_item_id: string; name: string; qty: number; station: KitchenStation | null }[];
    const stamps = db.prepare("SELECT type, timestamp FROM events WHERE order_id = ?").all(order.id) as { type: string; timestamp: string }[];
    const at = (type: string) => stamps.find((event) => event.type === type)?.timestamp ?? null;
    const status = LIVE_TICKET_STATUS[order.status];
    const createdAt = at("order.submitted") ?? order.created_at;
    const acceptedAt = status === "NEW" ? null : at("order.accepted") ?? order.updated_at;
    const startedAt = status === "PREPARING" || status === "READY" || status === "COMPLETED" ? at("order.prep_started") ?? acceptedAt : null;
    const readyAt = status === "READY" || status === "COMPLETED" ? at("order.ready") ?? order.updated_at : null;
    const completedAt = status === "COMPLETED" ? at("order.served") ?? order.updated_at : status === "CANCELLED" ? order.updated_at : null;
    const done = status === "READY" || status === "COMPLETED" ? 1 : 0;
    const groups = new Map<KitchenStation, typeof lines>();
    for (const line of lines) {
      if (!line.station) continue;
      const list = groups.get(line.station) ?? [];
      list.push(line);
      groups.set(line.station, list);
    }
    for (const station of ["Hot Kitchen", "Cold Kitchen", "Bar"] as const) {
      const group = groups.get(station);
      if (!group || group.length === 0) continue;
      number += 1;
      const ticketId = `tkt-seed-${order.id}-${station.replace(/\s+/g, "-").toLowerCase()}`;
      insertTicket.run(ticketId, number, order.id, order.table_id, station, status, createdAt, acceptedAt, startedAt, readyAt, completedAt);
      for (const line of group) {
        itemNo += 1;
        insertItem.run(`tki-seed-${itemNo}`, ticketId, line.menu_item_id, line.name, line.qty, done);
      }
    }
  }
}
