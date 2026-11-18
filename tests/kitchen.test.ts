import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_READY_RULE, stationForMenuItem } from "../src/domain/kitchen";
import { openDatabase } from "../src/lib/db";
import { actOnTicket, listDeliveryTasks, listKitchenTickets } from "../src/lib/kitchen";
import { createOrder, getSnapshot, resetDemo, transitionOrder } from "../src/lib/repository";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

function fresh() {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  return database;
}

function item(database: ReturnType<typeof fresh>, name: string) {
  const found = getSnapshot(database, CTX).menu.find((entry) => entry.name === name);
  assert.ok(found);
  return found;
}

test("stations route pizza to hot, coffee to bar, and drinks nowhere", () => {
  assert.equal(stationForMenuItem({ id: "menu-margherita", name: "Margherita", category: "Pizza" }), "Hot Kitchen");
  assert.equal(stationForMenuItem({ id: "menu-cappuccino", name: "Cappuccino", category: "Coffee" }), "Bar");
  assert.equal(stationForMenuItem({ id: "menu-espresso", name: "Espresso", category: "Coffee" }), "Bar");
  assert.equal(stationForMenuItem({ id: "menu-water", name: "Still water", category: "Soft drinks" }), null);
  assert.match(ORDER_READY_RULE, /every required kitchen ticket/i);
});

test("a mixed order creates one ticket per station and ignores soft drinks", () => {
  const database = fresh();
  const created = createOrder(
    database,
    {
      tableId: "T07",
      items: [
        { menuItemId: item(database, "Margherita").id, qty: 1 },
        { menuItemId: item(database, "Cappuccino").id, qty: 2 },
        { menuItemId: item(database, "Still water").id, qty: 1 },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    created.tickets.map((ticket) => ticket.station).sort(),
    ["Bar", "Hot Kitchen"],
  );
  const names = created.tickets.flatMap((ticket) => ticket.items.map((line) => line.name));
  assert.equal(names.includes("Still water"), false);
  assert.equal(names.includes("Margherita"), true);
  assert.equal(created.tickets.find((ticket) => ticket.station === "Bar")?.items[0]?.qty, 2);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE type = 'KITCHEN_TICKET_CREATED' AND order_id = ?").get(created.order.id) as { c: number }).c,
    2,
  );
  database.close();
});

test("the order becomes ready only after every required ticket is ready", () => {
  const database = fresh();
  const created = createOrder(
    database,
    {
      tableId: "T07",
      items: [
        { menuItemId: item(database, "Diavola").id, qty: 1 },
        { menuItemId: item(database, "Espresso").id, qty: 1 },
      ],
    },
    NOW,
  );
  const hot = created.tickets.find((ticket) => ticket.station === "Hot Kitchen");
  const bar = created.tickets.find((ticket) => ticket.station === "Bar");
  assert.ok(hot && bar);
  assert.throws(() => actOnTicket(database, hot.id, "start", { now: NOW + 1000 }), /NEW/);
  assert.equal(listKitchenTickets(database).find((ticket) => ticket.id === hot.id)?.status, "NEW");

  const accepted = actOnTicket(database, hot.id, "accept", { now: NOW + 1000 });
  assert.equal(accepted.order?.status, "ACCEPTED");
  const started = actOnTicket(database, hot.id, "start", { now: NOW + 2000 });
  assert.equal(started.order?.status, "PREPARING");
  assert.throws(() => actOnTicket(database, hot.id, "complete", { now: NOW + 3000 }), /every item/);
  actOnTicket(database, hot.id, "complete_item", { itemId: hot.items[0]?.id, now: NOW + 3000 });
  const hotReady = actOnTicket(database, hot.id, "complete", { now: NOW + 4000 });
  assert.equal(hotReady.ticket.status, "READY");
  assert.equal(hotReady.order, null);
  assert.equal(getSnapshot(database, CTX).orders.find((order) => order.id === created.order.id)?.status, "PREPARING");
  assert.throws(() => transitionOrder(database, created.order.id, "READY", NOW + 4500), /every required ticket/);

  actOnTicket(database, bar.id, "accept", { now: NOW + 5000 });
  actOnTicket(database, bar.id, "start", { now: NOW + 6000 });
  actOnTicket(database, bar.id, "complete_item", { itemId: bar.items[0]?.id, now: NOW + 7000 });
  const barReady = actOnTicket(database, bar.id, "complete", { now: NOW + 8000 });
  assert.equal(barReady.order?.status, "READY");
  assert.equal(barReady.task?.type, "deliver_order");
  assert.equal(barReady.task?.status, "OPEN");
  assert.equal(listDeliveryTasks(database).filter((task) => task.orderId === created.order.id).length, 1);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'KITCHEN_TICKET_STARTED'").get(created.order.id) as { c: number }).c,
    2,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'KITCHEN_TICKET_READY'").get(created.order.id) as { c: number }).c,
    2,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'WAITER_TASK_CREATED'").get(created.order.id) as { c: number }).c,
    1,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'ORDER_READY'").get(created.order.id) as { c: number }).c,
    1,
  );

  const served = transitionOrder(database, created.order.id, "SERVED", NOW + 9000);
  assert.equal(served.task?.status, "COMPLETED");
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE order_id = ? AND type = 'WAITER_TASK_COMPLETED'").get(created.order.id) as { c: number }).c,
    1,
  );
  database.close();
});

test("an order with no kitchen items can be marked ready and still gets one delivery task", () => {
  const database = fresh();
  const created = createOrder(database, { tableId: "T07", items: [{ menuItemId: item(database, "Still water").id, qty: 1 }] }, NOW);
  assert.equal(created.tickets.length, 0);
  transitionOrder(database, created.order.id, "ACCEPTED", NOW + 1000);
  transitionOrder(database, created.order.id, "PREPARING", NOW + 2000);
  const ready = transitionOrder(database, created.order.id, "READY", NOW + 3000);
  assert.equal(ready.order.status, "READY");
  assert.equal(ready.task?.status, "OPEN");
  assert.equal(listDeliveryTasks(database).filter((task) => task.orderId === created.order.id).length, 1);
  database.close();
});
