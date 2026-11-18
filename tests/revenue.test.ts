import assert from "node:assert/strict";
import test from "node:test";
import type { RestaurantEvent } from "../src/domain/journal";
import { getRevenueMap, revenueColor, type PaymentRecord, type RevenueOrder } from "../src/domain/revenue";
import { openDatabase } from "../src/lib/db";
import { createOrder, getSnapshot, recordPayment, resetDemo, transitionOrder } from "../src/lib/repository";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};
const TABLES = [
  { id: "T05", zone: "Main Hall", number: 5 },
  { id: "T06", zone: "Main Hall", number: 6 },
  { id: "T01", zone: "Main Hall", number: 1 },
];

function order(partial: Partial<RevenueOrder> & Pick<RevenueOrder, "id" | "tableId" | "status" | "total">): RevenueOrder {
  return { createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(), ...partial };
}

function payment(partial: Partial<PaymentRecord> & Pick<PaymentRecord, "id" | "orderId" | "tableId" | "amount">): PaymentRecord {
  return { paidAt: new Date(NOW - 20 * 60 * 1000).toISOString(), note: "test", ...partial };
}

function event(partial: Pick<RestaurantEvent, "id" | "sequence" | "type" | "occurredAt"> & Partial<RestaurantEvent>): RestaurantEvent {
  return {
    restaurantId: "atelier",
    tableId: "T05",
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

test("unpaid and cancelled orders are not collected revenue", () => {
  const report = getRevenueMap({
    payments: [payment({ id: "pay-1", orderId: "ord-paid", tableId: "T01", amount: 200 })],
    orders: [
      order({ id: "ord-paid", tableId: "T01", status: "SERVED", total: 200 }),
      order({ id: "ord-open", tableId: "T01", status: "SERVED", total: 500 }),
      order({ id: "ord-cancel", tableId: "T01", status: "CANCELLED", total: 900 }),
    ],
    events: [],
    tables: TABLES,
    range: { kind: "today" },
    now: NOW,
  });
  const table = report.tables.find((item) => item.tableId === "T01");
  assert.ok(table);
  assert.equal(table.economics.recordedSales, 200);
  assert.equal(table.economics.orderCount, 2);
  assert.equal(table.economics.averageOrderValue, 200);
  assert.equal(report.restaurant.economics.recordedSales, 200);
  assert.equal(table.economics.salesPerOccupiedHour, null);
  assert.equal(table.economics.occupiedMinutes, null);
});

test("a grouped table does not receive a second copy of the payment", () => {
  const report = getRevenueMap({
    payments: [payment({ id: "pay-1", orderId: "ord-1", tableId: "T05", amount: 400 })],
    orders: [order({ id: "ord-1", tableId: "T05", status: "SERVED", total: 400 })],
    events: [],
    tables: TABLES,
    groups: [{ id: "grp-1", tableIds: ["T05", "T06"], status: "ACTIVE" }],
    range: { kind: "today" },
    now: NOW,
  });
  assert.equal(report.tables.find((item) => item.tableId === "T05")?.economics.recordedSales, 400);
  assert.equal(report.tables.find((item) => item.tableId === "T06")?.economics.recordedSales, null);
  assert.deepEqual(report.tables.find((item) => item.tableId === "T05")?.groupWith, ["T06"]);
  assert.equal(report.restaurant.economics.recordedSales, 400);
  assert.match(report.attribution, /counted once/);
});

test("sales per occupied hour is N/A when the denominator is zero and a rate when minutes exist", () => {
  const paid = [payment({ id: "pay-1", orderId: "ord-1", tableId: "T05", amount: 300 })];
  const orders = [order({ id: "ord-1", tableId: "T05", status: "SERVED", total: 300 })];
  const empty = getRevenueMap({ payments: paid, orders, events: [], tables: TABLES, range: { kind: "today" }, now: NOW });
  assert.equal(empty.tables.find((item) => item.tableId === "T05")?.economics.salesPerOccupiedHour, null);
  const stayed = getRevenueMap({
    payments: paid,
    orders,
    events: [
      event({ id: "s", sequence: 1, type: "GUEST_SEATED", occurredAt: new Date(NOW - 30 * 60 * 1000).toISOString() }),
      event({ id: "e", sequence: 2, type: "TABLE_RELEASED", occurredAt: new Date(NOW - 0).toISOString() }),
    ],
    tables: TABLES,
    range: { kind: "today" },
    now: NOW,
  });
  const economics = stayed.tables.find((item) => item.tableId === "T05")?.economics;
  assert.ok(economics);
  assert.equal(economics.completedSeatings, 1);
  assert.ok(Math.abs((economics.occupiedMinutes ?? 0) - 30) < 0.01);
  assert.ok(Math.abs((economics.salesPerOccupiedHour ?? 0) - 600) < 0.01);
});

test("high sales use a positive palette and a small sale is not red", () => {
  assert.equal(revenueColor(null), null);
  assert.equal(revenueColor(10), "#d9f99d");
  assert.equal(revenueColor(1500), "#a16207");
  assert.notEqual(revenueColor(10), "#ef4444");
  assert.notEqual(revenueColor(1500), "#ef4444");
});

test("demo payments persist across reset and do not invent journal rows", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const first = getSnapshot(database, CTX);
  assert.ok(first.payments.length > 3);
  for (const orderId of ["ord-seed-01", "ord-seed-06", "ord-seed-03"]) {
    assert.equal(first.payments.filter((payment) => payment.orderId === orderId).length, 1);
  }
  assert.equal(first.payments.some((payment) => payment.orderId === "ord-seed-05"), false);
  assert.equal(first.orders.find((order) => order.id === "ord-seed-05")?.status, "SERVED");
  const paidIds = new Set(first.payments.map((payment) => payment.orderId));
  const collected = first.orders.filter((order) => paidIds.has(order.id)).reduce((sum, order) => sum + order.total, 0);
  const served = first.orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0);
  assert.ok(collected < served);
  assert.equal(first.revenue, served);
  const before = (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events").get() as { c: number }).c;
  const map = getRevenueMap({
    payments: first.payments,
    orders: first.orders,
    events: first.journal,
    tables: first.tables,
    groups: first.tableGroups,
    range: { kind: "today" },
    now: NOW,
  });
  const seedPaid = first.orders
    .filter((order) => order.id === "ord-seed-01" || order.id === "ord-seed-06" || order.id === "ord-seed-03")
    .reduce((sum, order) => sum + order.total, 0);
  assert.ok((map.restaurant.economics.recordedSales ?? 0) >= seedPaid);
  resetDemo(database, CTX);
  assert.equal(getSnapshot(database, CTX).payments.length, first.payments.length);
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM restaurant_events").get() as { c: number }).c, before);
  database.close();
});

test("recording a payment rejects a cancelled order and does not duplicate", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const menu = getSnapshot(database, CTX).menu.find((item) => item.name === "Espresso");
  assert.ok(menu);
  const created = createOrder(database, { tableId: "T09", items: [{ menuItemId: menu.id, qty: 1 }] }, NOW);
  transitionOrder(database, created.order.id, "CANCELLED", NOW + 1000);
  assert.throws(() => recordPayment(database, { orderId: created.order.id, now: NOW + 2000 }), /cancelled/);
  const open = createOrder(database, { tableId: "T12", items: [{ menuItemId: menu.id, qty: 2 }] }, NOW + 3000);
  const paid = recordPayment(database, { orderId: open.order.id, now: NOW + 4000, idempotencyKey: "pay-1" });
  const again = recordPayment(database, { orderId: open.order.id, now: NOW + 5000, idempotencyKey: "pay-1" });
  assert.equal(again.idempotentReplay, true);
  assert.equal(again.payment.id, paid.payment.id);
  assert.equal(getSnapshot(database, CTX).payments.filter((payment) => payment.orderId === open.order.id).length, 1);
  assert.equal(paid.journal[0]?.type, "PAYMENT_RECORDED");
  database.close();
});
