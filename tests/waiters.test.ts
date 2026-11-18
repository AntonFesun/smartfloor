import assert from "node:assert/strict";
import test from "node:test";
import { chooseWaiter } from "../src/domain/waiters";
import { openDatabase } from "../src/lib/db";
import { listDeliveryTasks } from "../src/lib/kitchen";
import { createOrder, getSnapshot, resetDemo, resolveWaiter, transitionOrder } from "../src/lib/repository";
import { actOnTicket } from "../src/lib/kitchen";
import { getEvents } from "../src/lib/journal";
import { callWaiter } from "../src/lib/repository";
import { reassignTask, setShift } from "../src/lib/waiters";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

test("tie-break prefers the stable waiter id when the load is equal", () => {
  const picked = chooseWaiter({
    zone: "Main Hall",
    now: new Date(NOW).toISOString(),
    waiters: [{ id: "waiter-sofia" }, { id: "waiter-marta" }],
    shifts: [
      { waiterId: "waiter-sofia", startedAt: new Date(NOW - 1000).toISOString(), endedAt: null },
      { waiterId: "waiter-marta", startedAt: new Date(NOW - 1000).toISOString(), endedAt: null },
    ],
    assignments: [
      { waiterId: "waiter-sofia", zone: "Main Hall" },
      { waiterId: "waiter-marta", zone: "Main Hall" },
    ],
    tasks: [],
  });
  assert.equal(picked, "waiter-marta");
  const busier = chooseWaiter({
    zone: "Main Hall",
    now: new Date(NOW).toISOString(),
    waiters: [{ id: "waiter-marta" }, { id: "waiter-sofia" }],
    shifts: [
      { waiterId: "waiter-marta", startedAt: new Date(NOW - 1000).toISOString(), endedAt: null },
      { waiterId: "waiter-sofia", startedAt: new Date(NOW - 1000).toISOString(), endedAt: null },
    ],
    assignments: [
      { waiterId: "waiter-marta", zone: "Main Hall" },
      { waiterId: "waiter-sofia", zone: "Main Hall" },
    ],
    tasks: [{ assignedWaiterId: "waiter-marta", status: "OPEN" }],
  });
  assert.equal(busier, "waiter-sofia");
  assert.equal(
    chooseWaiter({
      zone: "Terrace",
      now: new Date(NOW).toISOString(),
      waiters: [{ id: "waiter-marta" }],
      shifts: [{ waiterId: "waiter-marta", startedAt: new Date(NOW - 1000).toISOString(), endedAt: null }],
      assignments: [{ waiterId: "waiter-marta", zone: "Main Hall" }],
      tasks: [],
    }),
    null,
  );
});

test("a guest call assigns one on-duty waiter and resolve completes that task", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const called = callWaiter(database, "T07", NOW);
  assert.equal(called.unassigned, false);
  assert.equal(called.task?.type, "respond_to_call");
  assert.equal(called.task?.assignedWaiterId, "waiter-marta");
  assert.throws(() => callWaiter(database, "T07", NOW + 1000), /active waiter/);
  assert.equal(getSnapshot(database, CTX).waiterTasks.filter((task) => task.callId === called.call.id && task.status !== "COMPLETED").length, 1);
  const before = (database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE type = 'WAITER_TASK_COMPLETED'").get() as { c: number }).c;
  const resolved = resolveWaiter(database, called.call.id, NOW + 2000);
  assert.equal(resolved.task?.status, "COMPLETED");
  assert.equal((database.prepare("SELECT COUNT(*) AS c FROM restaurant_events WHERE type = 'WAITER_TASK_COMPLETED'").get() as { c: number }).c, before + 1);
  database.close();
});

test("no on-duty waiter leaves the call task unassigned", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  for (const id of ["waiter-marta", "waiter-sofia"]) setShift(database, id, "end", NOW - 1000);
  const called = callWaiter(database, "T07", NOW);
  assert.equal(called.unassigned, true);
  assert.equal(called.task?.assignedWaiterId, null);
  const moved = reassignTask(database, called.task!.id, "waiter-oleh", NOW + 500);
  assert.equal(moved.task.assignedWaiterId, "waiter-oleh");
  assert.equal(moved.journal[0]?.type, "WAITER_ASSIGNED");
  database.close();
});

test("delivery uses the same fewest-task rule", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const deliveriesBefore = listDeliveryTasks(database).length;
  const water = getSnapshot(database, CTX).menu.find((item) => item.name === "Still water");
  assert.ok(water);
  const created = createOrder(database, { tableId: "T07", items: [{ menuItemId: water.id, qty: 1 }] }, NOW);
  transitionOrder(database, created.order.id, "ACCEPTED", NOW + 1000);
  transitionOrder(database, created.order.id, "PREPARING", NOW + 2000);
  const ready = transitionOrder(database, created.order.id, "READY", NOW + 3000);
  assert.equal(ready.task?.assignedWaiterId, "waiter-marta");
  const pizza = getSnapshot(database, CTX).menu.find((item) => item.name === "Margherita");
  assert.ok(pizza);
  const cooked = createOrder(database, { tableId: "T02", items: [{ menuItemId: pizza.id, qty: 1 }] }, NOW + 4000);
  const ticket = cooked.tickets[0];
  assert.ok(ticket);
  actOnTicket(database, ticket.id, "accept", { now: NOW + 5000 });
  actOnTicket(database, ticket.id, "start", { now: NOW + 6000 });
  actOnTicket(database, ticket.id, "complete_item", { itemId: ticket.items[0]?.id, now: NOW + 7000 });
  const done = actOnTicket(database, ticket.id, "complete", { now: NOW + 8000 });
  assert.equal(done.task?.type, "deliver_order");
  assert.equal(done.task?.assignedWaiterId, "waiter-sofia");
  assert.equal(listDeliveryTasks(database).length, deliveriesBefore + 2);
  database.close();
});
