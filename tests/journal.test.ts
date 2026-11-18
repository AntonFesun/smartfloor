import assert from "node:assert/strict";
import test from "node:test";
import { projectRestaurantState, resolveTimeRange, type RestaurantEvent } from "../src/domain/journal";
import { openDatabase } from "../src/lib/db";
import { appendCommandEvent, captureRestaurantSnapshot, getEvents, getEventsBetween, getEventsForTable, getEventsForZone, getRestaurantStateAt, startCommand } from "../src/lib/journal";
import { createOrder, getSnapshot, resetDemo, saveLayout, transitionOrder } from "../src/lib/repository";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

function db() {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  return database;
}

function journalCount(database: ReturnType<typeof db>): number {
  return (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events").get() as { c: number }).c;
}

function maxSequence(database: ReturnType<typeof db>): number {
  return (database.prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM restaurant_events").get() as { s: number }).s;
}

test("journal writes commit with the mutation and roll back with it", () => {
  const database = db();
  const menu = getSnapshot(database, CTX).menu.find((item) => item.name === "Cappuccino");
  assert.ok(menu);
  const before = journalCount(database);
  const floor = maxSequence(database);
  const created = createOrder(database, { tableId: "T07", items: [{ menuItemId: menu.id, qty: 1 }] }, NOW);
  assert.equal(created.journal[0]?.type, "ORDER_CREATED");
  assert.ok(created.journal.some((event) => event.type === "KITCHEN_TICKET_CREATED"));
  assert.equal(created.journal[0]?.sequence, floor + 1);
  assert.equal(journalCount(database), before + 2);

  assert.throws(() => {
    database.transaction(() => {
      const started = startCommand(database);
      appendCommandEvent(database, started.command, {
        type: "ORDER_CANCELLED",
        occurredAt: new Date(NOW).toISOString(),
        tableId: "T07",
        orderId: created.order.id,
        payload: { orderId: created.order.id },
      });
      throw new Error("boom");
    })();
  }, /boom/);
  assert.equal(journalCount(database), before + 2);

  assert.throws(() => saveLayout(database, getSnapshot(database, CTX).tables.map((table) => ({ ...table, x: table.id === "T07" ? 40 : table.x }))), /outside/);
  assert.equal(getEvents(database, { afterSequence: floor, limit: 500 }).events.filter((event) => event.type === "TABLE_MOVED").length, 0);
  database.close();
});

test("idempotent retry does not duplicate the order or the journal", () => {
  const database = db();
  const menu = getSnapshot(database, CTX).menu.find((item) => item.name === "Margherita");
  assert.ok(menu);
  const first = createOrder(database, { tableId: "T01", items: [{ menuItemId: menu.id, qty: 1 }], idempotencyKey: "order-1" }, NOW);
  const second = createOrder(database, { tableId: "T01", items: [{ menuItemId: menu.id, qty: 1 }], idempotencyKey: "order-1" }, NOW + 60_000);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(getSnapshot(database, CTX).orders.filter((order) => order.id === first.order.id).length, 1);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'ORDER_CREATED'").get(first.order.id) as { c: number }).c,
    1,
  );
  assert.deepEqual(
    first.journal.map((event) => event.type),
    ["TABLE_OCCUPIED", "GUEST_SEATED", "ORDER_CREATED", "KITCHEN_TICKET_CREATED"],
  );
  assert.equal(first.journal[0]?.occurredAt, first.journal[2]?.occurredAt);
  assert.ok((first.journal[2]?.sequence ?? 0) > (first.journal[0]?.sequence ?? 0));
  database.close();
});

test("seed reset restores the demo journal and drops later orders", () => {
  const database = db();
  const menu = getSnapshot(database, CTX).menu.find((item) => item.id === "menu-espresso");
  assert.ok(menu);
  const before = journalCount(database);
  const created = createOrder(database, { tableId: "T07", items: [{ menuItemId: menu.id, qty: 1 }] }, NOW);
  const restored = resetDemo(database, CTX);
  assert.equal(journalCount(database), before);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ?").get(created.order.id) as { c: number }).c,
    0,
  );
  assert.equal(restored.orders.some((order) => order.id === created.order.id), false);
  assert.ok(before > 0);
  database.close();
});

test("filters, pagination, and projection follow sequence", () => {
  const database = db();
  const tables = getSnapshot(database, CTX).tables;
  const snap = captureRestaurantSnapshot(database, { tables, orders: [], waiterCalls: [] }, NOW);
  const menu = getSnapshot(database, CTX).menu.find((item) => item.name === "Espresso");
  assert.ok(menu);
  const created = createOrder(database, { tableId: "T07", items: [{ menuItemId: menu.id, qty: 1 }] }, NOW + 1000);
  const accepted = transitionOrder(database, created.order.id, "ACCEPTED", NOW + 2000);
  const page = getEvents(database, { limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.nextCursor, page.events[0]?.sequence);
  const rest = getEvents(database, { afterSequence: snap.sequence, limit: 500 });
  assert.ok(rest.events.some((event) => event.type === "ORDER_ACCEPTED" && event.orderId === created.order.id));
  assert.equal(getEventsForZone(database, "Main Hall", { types: ["ORDER_CREATED"], from: new Date(NOW).toISOString(), limit: 500 }).events.length, 1);
  assert.equal(getEventsBetween(database, new Date(NOW + 1500).toISOString(), new Date(NOW + 3000).toISOString()).events.length, 1);
  assert.equal(getEvents(database, { range: { kind: "last_hour" }, now: NOW + 2000 }).events.length, 3);

  const events = rest.events;
  const partial = projectRestaurantState({ sequence: 0, tables, orders: [], waiterCalls: [] }, [...events].reverse(), 0);
  assert.equal(partial.orders.find((order) => order.id === created.order.id), undefined);
  const createdSequence = created.journal[0]?.sequence ?? 0;
  const atCreate = projectRestaurantState({ sequence: 0, tables, orders: [], waiterCalls: [] }, [...events].reverse(), createdSequence);
  assert.equal(atCreate.orders.find((order) => order.id === created.order.id)?.status, "NEW");
  const full = getRestaurantStateAt(database, { sequence: accepted.journal[0]?.sequence ?? 0 });
  assert.equal(full.orders.find((order) => order.id === created.order.id)?.status, "ACCEPTED");
  const earlier = getRestaurantStateAt(database, { at: new Date(NOW + 1000).toISOString() });
  assert.equal(earlier.orders.find((order) => order.id === created.order.id)?.status, "NEW");
  database.close();
});

test("projection applies equal timestamps in sequence order", () => {
  const occurredAt = new Date(NOW).toISOString();
  const base = {
    id: "T01",
    number: 1,
    zone: "Main Hall" as const,
    shape: "circle" as const,
    x: 0,
    y: 0,
    rotation: 0,
    capacity: 4 as const,
    occupiedSeatCount: 0,
    status: "AVAILABLE" as const,
  };
  const first = event(1, "TABLE_OCCUPIED", { occupiedSeatCount: 2 });
  const second = event(2, "GUEST_SEATED", { occupiedSeatCount: 4 });
  const projected = projectRestaurantState({ sequence: 0, tables: [base], orders: [], waiterCalls: [] }, [second, first], 2);
  assert.equal(projected.tables[0]?.occupiedSeatCount, 4);
  assert.equal(projected.tables[0]?.status, "OCCUPIED");
  const stopped = projectRestaurantState({ sequence: 0, tables: [base], orders: [], waiterCalls: [] }, [second, first], 1);
  assert.equal(stopped.tables[0]?.occupiedSeatCount, 2);
});

test("restaurant-local ranges start at local midnight", () => {
  const now = Date.parse("2026-11-15T22:30:00.000Z");
  const today = resolveTimeRange({ kind: "today" }, now);
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(today.from));
  assert.equal(formatted, "00:00");
  const week = resolveTimeRange({ kind: "last_7_days" }, now);
  assert.equal(Date.parse(week.to) - Date.parse(week.from), 7 * 24 * 60 * 60 * 1000);
});

function event(sequence: number, type: RestaurantEvent["type"], payload: Record<string, unknown>): RestaurantEvent {
  return {
    id: `rev-${sequence}`,
    sequence,
    restaurantId: "atelier",
    tableId: "T01",
    orderId: null,
    waiterId: null,
    zoneId: "Main Hall",
    sessionId: null,
    type,
    occurredAt: new Date(NOW).toISOString(),
    payload,
    schemaVersion: 1,
    idempotencyKey: null,
    commandId: "cmd",
  };
}
