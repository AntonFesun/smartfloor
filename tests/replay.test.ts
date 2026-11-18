import assert from "node:assert/strict";
import test from "node:test";
import type { RestaurantEvent } from "../src/domain/journal";
import { activeCalls, measureSpans, replayAt, tableJournal } from "../src/domain/replay";
import { openDatabase } from "../src/lib/db";
import { listAllEvents } from "../src/lib/journal";
import { callWaiter, createOrder, getSnapshot, resetDemo, resolveWaiter } from "../src/lib/repository";
import type { Order, RestaurantTable, WaiterCall } from "../src/types";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

function table(patch: Partial<RestaurantTable> = {}): RestaurantTable {
  return {
    id: "T07",
    number: 7,
    zone: "Main Hall",
    shape: "circle",
    x: 5,
    y: 5,
    rotation: 0,
    capacity: 4,
    occupiedSeatCount: 3,
    status: "OCCUPIED",
    ...patch,
  };
}

function event(partial: Pick<RestaurantEvent, "id" | "sequence" | "type" | "occurredAt"> & Partial<RestaurantEvent>): RestaurantEvent {
  return {
    restaurantId: "atelier",
    tableId: "T07",
    orderId: null,
    waiterId: null,
    zoneId: "Main Hall",
    sessionId: null,
    payload: {},
    schemaVersion: 1,
    idempotencyKey: null,
    commandId: "cmd",
    ...partial,
  };
}

function order(status: Order["status"] = "NEW"): Order {
  return {
    id: "ord-1",
    tableId: "T07",
    status,
    items: [{ id: "line-1", menuItemId: "menu-espresso", name: "Espresso", qty: 1, price: 70 }],
    total: 70,
    createdAt: "2026-11-15T18:01:00.000Z",
    updatedAt: "2026-11-15T18:01:00.000Z",
  };
}

function call(): WaiterCall {
  return {
    id: "call-1",
    tableId: "T07",
    status: "ACTIVE",
    createdAt: "2026-11-15T18:05:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
  };
}

test("replay shows the journaled state at one sequence and ignores pre-journal rows", () => {
  const live = table();
  const events = [
    event({
      id: "e1",
      sequence: 2,
      type: "TABLE_OCCUPIED",
      occurredAt: "2026-11-15T18:00:00.000Z",
      payload: { occupiedSeatCount: 2 },
    }),
    event({
      id: "e2",
      sequence: 3,
      type: "ORDER_CREATED",
      occurredAt: "2026-11-15T18:01:00.000Z",
      orderId: "ord-1",
      payload: { order: order("NEW") },
    }),
    event({
      id: "e3",
      sequence: 4,
      type: "ORDER_ACCEPTED",
      occurredAt: "2026-11-15T18:02:00.000Z",
      orderId: "ord-1",
      payload: { orderId: "ord-1" },
    }),
    event({
      id: "e4",
      sequence: 7,
      type: "ORDER_SERVED",
      occurredAt: "2026-11-15T18:10:00.000Z",
      orderId: "ord-1",
      payload: { orderId: "ord-1" },
    }),
  ];

  const before = replayAt([live], events, 1);
  assert.equal(before.orders.length, 0);
  assert.equal(before.tables[0]?.status, "AVAILABLE");
  assert.equal(before.tables[0]?.occupiedSeatCount, 0);
  assert.equal(live.status, "OCCUPIED");
  assert.equal(live.occupiedSeatCount, 3);

  const created = replayAt([live], events, 3);
  assert.equal(created.orders.length, 1);
  assert.equal(created.orders[0]?.status, "NEW");
  assert.equal(created.tables[0]?.status, "OCCUPIED");
  assert.equal(created.tables[0]?.occupiedSeatCount, 2);

  const accepted = replayAt([live], events, 4);
  assert.equal(accepted.orders[0]?.status, "ACCEPTED");

  const jumped = replayAt([live], events, 7);
  assert.equal(jumped.orders[0]?.status, "SERVED");
  assert.notEqual(created.orders[0]?.status, jumped.orders[0]?.status);
});

test("an active call is visible until its recorded resolution", () => {
  const events = [
    event({
      id: "c1",
      sequence: 5,
      type: "WAITER_CALLED",
      occurredAt: "2026-11-15T18:05:00.000Z",
      payload: { call: call() },
    }),
    event({
      id: "c2",
      sequence: 6,
      type: "WAITER_CALL_RESOLVED",
      occurredAt: "2026-11-15T18:06:00.000Z",
      payload: { callId: "call-1" },
    }),
  ];
  const during = replayAt([table()], events, 5);
  assert.equal(activeCalls(during.waiterCalls).length, 1);
  assert.equal(activeCalls(during.waiterCalls)[0]?.status, "ACTIVE");
  const after = replayAt([table()], events, 6);
  assert.equal(activeCalls(after.waiterCalls).length, 0);
  assert.equal(after.waiterCalls[0]?.status, "RESOLVED");
});

test("recorded table positions follow the move, and earlier sequences keep from", () => {
  const events = [
    event({
      id: "m1",
      sequence: 8,
      type: "TABLE_MOVED",
      occurredAt: "2026-11-15T18:08:00.000Z",
      payload: {
        from: { x: 0.4, y: -2.4, rotation: 0, shape: "circle", capacity: 4, zone: "Main Hall" },
        to: { x: 1.2, y: -2.1, rotation: 15, shape: "circle", capacity: 4, zone: "Main Hall" },
      },
    }),
  ];
  const before = replayAt([table()], events, 7);
  assert.equal(before.tables[0]?.x, 0.4);
  assert.equal(before.tables[0]?.y, -2.4);
  const after = replayAt([table()], events, 8);
  assert.equal(after.tables[0]?.x, 1.2);
  assert.equal(after.tables[0]?.y, -2.1);
  assert.equal(after.tables[0]?.rotation, 15);
});

test("a table with no journal events has an empty history", () => {
  const events = [
    event({
      id: "e2",
      sequence: 3,
      type: "ORDER_CREATED",
      occurredAt: "2026-11-15T18:01:00.000Z",
      orderId: "ord-1",
      payload: { order: order() },
    }),
  ];
  assert.equal(tableJournal(events, "T02", "all").length, 0);
  assert.equal(tableJournal([], "T07", "orders").length, 0);
  const past = replayAt([table({ id: "T02", number: 2, status: "OCCUPIED", occupiedSeatCount: 4 })], [], 0);
  assert.equal(past.orders.length, 0);
  assert.equal(past.waiterCalls.length, 0);
  assert.equal(past.tables[0]?.status, "AVAILABLE");
});

test("timeline filters and durations come from recorded timestamps", () => {
  const events = [
    event({ id: "o1", sequence: 1, type: "ORDER_CREATED", occurredAt: "2026-11-15T18:00:00.000Z", orderId: "ord-1", payload: { order: order() } }),
    event({ id: "o2", sequence: 2, type: "ORDER_ACCEPTED", occurredAt: "2026-11-15T18:00:05.000Z", orderId: "ord-1" }),
    event({ id: "g1", sequence: 3, type: "GUEST_SEATED", occurredAt: "2026-11-15T18:00:00.000Z", payload: { occupiedSeatCount: 2 } }),
    event({ id: "p1", sequence: 4, type: "PAYMENT_RECORDED", occurredAt: "2026-11-15T18:20:00.000Z", orderId: "ord-1" }),
  ];
  assert.deepEqual(tableJournal(events, "T07", "orders").map((item) => item.type), ["ORDER_CREATED", "ORDER_ACCEPTED"]);
  assert.deepEqual(tableJournal(events, "T07", "payments").map((item) => item.type), ["PAYMENT_RECORDED"]);
  assert.equal(tableJournal(events, "T07", "calls").length, 0);
  const spans = measureSpans(events);
  assert.equal(spans.find((span) => span.label === "Create to accept")?.ms, 5000);
});

test("replay does not write, and the live snapshot is unchanged", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const menu = getSnapshot(database, CTX).menu.find((item) => item.name === "Espresso");
  assert.ok(menu);
  const created = createOrder(database, { tableId: "T01", items: [{ menuItemId: menu.id, qty: 1 }] }, NOW);
  const called = callWaiter(database, "T01", NOW + 1000);
  resolveWaiter(database, called.call.id, NOW + 2000);
  const before = getSnapshot(database, CTX);
  const events = listAllEvents(database);
  const createdAt = events.find((item) => item.type === "ORDER_CREATED" && item.orderId === created.order.id)?.sequence ?? 0;
  const resolvedAt = events.find((item) => item.type === "WAITER_CALL_RESOLVED" && item.payload.callId === called.call.id)?.sequence ?? 0;
  const rewound = replayAt(before.tables, events, createdAt - 1);
  assert.equal(rewound.orders.some((item) => item.id === created.order.id), false);
  const atOrder = replayAt(before.tables, events, createdAt);
  assert.equal(atOrder.orders.find((item) => item.id === created.order.id)?.status, "NEW");
  const atResolve = replayAt(before.tables, events, resolvedAt);
  assert.equal(activeCalls(atResolve.waiterCalls).some((item) => item.id === called.call.id), false);
  const seeded = before.tables.find((item) => item.id === "T14");
  assert.equal(tableJournal(events, "T14", "all").some((item) => JSON.stringify(item.payload).includes("call-seed-14")), false);
  assert.ok(tableJournal(events, "T14", "orders").length > 0);
  assert.equal(replayAt(before.tables, events, 0).waiterCalls.some((item) => item.tableId === "T14"), false);
  assert.ok(seeded);
  const after = getSnapshot(database, CTX);
  assert.equal(after.orders.find((item) => item.id === created.order.id)?.status, before.orders.find((item) => item.id === created.order.id)?.status);
  assert.equal(after.tables.find((item) => item.id === "T01")?.x, before.tables.find((item) => item.id === "T01")?.x);
  assert.equal(after.waiterCalls.find((item) => item.id === called.call.id)?.status, "RESOLVED");
  database.close();
});
