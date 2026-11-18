import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "../src/lib/db";
import { actOnTicket, listKitchenTickets } from "../src/lib/kitchen";
import {
  acknowledgeWaiter,
  callWaiter,
  clearTable,
  createOrder,
  getSnapshot,
  releaseTable,
  reserveTable,
  resetDemo,
  resolveWaiter,
  saveLayout,
  seatTable,
  transitionOrder,
} from "../src/lib/repository";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

function memoryDb() {
  const db = openDatabase(":memory:");
  resetDemo(db, CTX);
  return db;
}

test("orders, waiter calls, and layout survive a reopened database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-"));
  const file = path.join(dir, "atelier.db");
  const db = openDatabase(file);
  resetDemo(db, CTX);
  const menu = getSnapshot(db, CTX).menu;
  const coffee = menu.find((item) => item.name === "Cappuccino");
  const pizza = menu.find((item) => item.name === "Margherita");
  assert.ok(coffee && pizza);

  const created = createOrder(db, {
    tableId: "T07",
    items: [
      { menuItemId: coffee.id, qty: 1 },
      { menuItemId: pizza.id, qty: 1 },
    ],
  }, NOW);
  assert.equal(created.order.status, "NEW");
  assert.equal(created.order.total, 335);
  assert.equal(created.order.tableId, "T07");
  assert.ok(created.events.some((event) => event.type === "order.submitted"));

  const accepted = transitionOrder(db, created.order.id, "ACCEPTED", NOW + 1000);
  const preparing = transitionOrder(db, created.order.id, "PREPARING", NOW + 2000);
  for (const ticket of listKitchenTickets(db).filter((entry) => entry.orderId === created.order.id)) {
    actOnTicket(db, ticket.id, "accept", { now: NOW + 2500 });
    actOnTicket(db, ticket.id, "start", { now: NOW + 2600 });
    for (const line of ticket.items) actOnTicket(db, ticket.id, "complete_item", { itemId: line.id, now: NOW + 2700 });
    actOnTicket(db, ticket.id, "complete", { now: NOW + 2800 });
  }
  const ready = { order: getSnapshot(db, CTX).orders.find((order) => order.id === created.order.id)! };
  const served = transitionOrder(db, created.order.id, "SERVED", NOW + 4000);
  assert.equal(accepted.order.status, "ACCEPTED");
  assert.equal(preparing.order.status, "PREPARING");
  assert.equal(ready.order.status, "READY");
  assert.equal(served.order.status, "SERVED");
  assert.throws(() => transitionOrder(db, created.order.id, "CANCELLED"), /SERVED/);

  const call = callWaiter(db, "T09", NOW + 5000);
  assert.equal(call.call.status, "ACTIVE");
  assert.throws(() => callWaiter(db, "T09"), /active waiter/);
  const acknowledged = acknowledgeWaiter(db, call.call.id, NOW + 8000);
  assert.equal(acknowledged.call.status, "ACKNOWLEDGED");
  const resolved = resolveWaiter(db, call.call.id, NOW + 9000);
  assert.equal(resolved.call.status, "RESOLVED");
  const again = callWaiter(db, "T09", NOW + 10_000);
  assert.equal(again.call.status, "ACTIVE");

  const seated = seatTable(db, "T12", 3, NOW + 11_000);
  assert.equal(seated.table.status, "OCCUPIED");
  assert.equal(seated.table.occupiedSeatCount, 3);
  const reserved = reserveTable(db, "T13");
  assert.equal(reserved.table.status, "RESERVED");
  const released = releaseTable(db, "T08");
  assert.equal(released.table.status, "AVAILABLE");
  const cleared = clearTable(db, "T12", NOW + 12_000);
  assert.equal(cleared.table.status, "AVAILABLE");
  assert.equal(cleared.table.occupiedSeatCount, 0);
  assert.equal(cleared.events[0]?.type, "table.cleared");

  const before = getSnapshot(db, CTX).tables;
  const moved = before.map((table) =>
    table.id === "T07"
      ? { id: table.id, x: table.x + 0.4, y: table.y, rotation: table.rotation, shape: table.shape, capacity: table.capacity, zone: table.zone }
      : { id: table.id, x: table.x, y: table.y, rotation: table.rotation, shape: table.shape, capacity: table.capacity, zone: table.zone },
  );
  const saved = saveLayout(db, moved);
  assert.equal(saved.tables.find((table) => table.id === "T07")?.x, before.find((table) => table.id === "T07")!.x + 0.4);
  assert.ok(saved.journal.some((event) => event.type === "TABLE_MOVED" && event.tableId === "T07"));
  assert.throws(() => saveLayout(db, moved.map((table) => (table.id === "T07" ? { ...table, x: 40 } : table))), /outside/);

  db.close();
  const reopened = new Database(file);
  const snap = getSnapshot(reopened, CTX);
  const stored = snap.orders.find((order) => order.id === created.order.id);
  assert.equal(stored?.status, "SERVED");
  assert.equal(stored?.items.length, 2);
  assert.equal(snap.waiterCalls.find((item) => item.id === again.call.id)?.status, "ACTIVE");
  assert.ok(snap.events.some((event) => event.orderId === created.order.id && event.type === "order.served"));
  const seedServed = snap.orders.filter((order) => order.id.startsWith("ord-seed-") && order.status === "SERVED").reduce((sum, order) => sum + order.total, 0);
  assert.equal(seedServed, 2110);
  assert.equal(snap.revenue, snap.orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0));
  assert.equal(snap.orders.find((order) => order.id === created.order.id)?.total, 335);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reset restores the seed and drops later orders", () => {
  const db = memoryDb();
  const menu = getSnapshot(db, CTX).menu;
  const espresso = menu.find((item) => item.id === "menu-espresso");
  assert.ok(espresso);
  createOrder(db, { tableId: "T07", items: [{ menuItemId: espresso.id, qty: 2 }] });
  const restored = resetDemo(db, CTX);
  assert.equal(restored.tables.length, 16);
  assert.equal(restored.orders.some((order) => order.tableId === "T07" && order.status === "NEW"), false);
  assert.equal(
    restored.orders.filter((order) => order.id.startsWith("ord-seed-") && order.status === "SERVED").reduce((sum, order) => sum + order.total, 0),
    2110,
  );
  assert.ok(restored.revenue > 2110);
  db.close();
});
