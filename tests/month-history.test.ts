import assert from "node:assert/strict";
import test from "node:test";
import { MONTH_HISTORY_DAYS, MONTH_HISTORY_GAP_MS } from "../src/domain/month-history";
import { buildSeed } from "../src/domain/seed-data";
import { openDatabase } from "../src/lib/db";
import { resetDemo } from "../src/lib/repository";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

const COUNTED = [
  "tables",
  "menu_items",
  "orders",
  "order_items",
  "payments",
  "waiter_calls",
  "events",
  "kitchen_tickets",
  "kitchen_ticket_items",
  "waiter_tasks",
  "reservation_intervals",
  "table_groups",
  "table_group_members",
  "waiter_shifts",
  "waiters",
  "restaurant_events",
] as const;

test("reset reloads a Kyiv month without moving the live floor", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const counts = Object.fromEntries(COUNTED.map((name) => [name, count(database, name)])) as Record<(typeof COUNTED)[number], number>;
  const again = openDatabase(":memory:");
  resetDemo(again, CTX);
  for (const name of COUNTED) assert.equal(count(again, name), counts[name], name);

  const seed = buildSeed(NOW);
  const tables = database.prepare("SELECT id, x, y, rotation, zone, status, occupied_seat_count, capacity FROM tables ORDER BY number").all() as {
    id: string;
    x: number;
    y: number;
    rotation: number;
    zone: string;
    status: string;
    occupied_seat_count: number;
    capacity: number;
  }[];
  assert.equal(tables.length, 16);
  for (const table of tables) {
    const live = seed.tables.find((item) => item.id === table.id);
    assert.ok(live);
    assert.equal(table.x, live.x);
    assert.equal(table.y, live.y);
    assert.equal(table.rotation, live.rotation);
    assert.equal(table.zone, live.zone);
    assert.equal(table.status, live.status);
    assert.equal(table.occupied_seat_count, live.occupiedSeatCount);
    assert.equal(table.capacity, live.capacity);
  }

  assert.ok(counts.orders > seed.orders.length);
  assert.ok(counts.payments > 3);
  assert.ok(counts.waiter_calls > seed.calls.length);
  assert.ok(counts.kitchen_tickets > 8);
  assert.ok(counts.kitchen_ticket_items >= counts.kitchen_tickets);
  assert.ok(counts.reservation_intervals > 2);
  assert.ok(counts.table_groups > 0);
  assert.ok(counts.restaurant_events > 1000);
  assert.equal(counts.tables, 16);

  const zones = database.prepare("SELECT DISTINCT zone FROM tables").all() as { zone: string }[];
  assert.deepEqual(zones.map((row) => row.zone).sort(), ["Bar Lounge", "Main Hall", "Terrace"]);
  const orderZones = database.prepare(
    `SELECT DISTINCT tables.zone AS zone FROM orders JOIN tables ON tables.id = orders.table_id WHERE orders.id LIKE 'ord-m-%'`,
  ).all() as { zone: string }[];
  assert.equal(orderZones.length, 3);
  for (const table of tables) {
    const orders = countWhere(database, "orders", "table_id = ?", table.id);
    assert.ok(orders > 0, table.id);
  }

  const gap = new Date(NOW - MONTH_HISTORY_GAP_MS).toISOString();
  assert.equal(countWhere(database, "restaurant_events", "occurred_at >= ?", gap), 0);
  assert.equal(countWhere(database, "payments", "order_id = ?", "ord-seed-05"), 0);
  assert.equal(countWhere(database, "waiter_calls", "status != 'RESOLVED'", undefined), 1);
  const oldest = database.prepare("SELECT MIN(occurred_at) AS t FROM restaurant_events").get() as { t: string };
  const newest = database.prepare("SELECT MAX(occurred_at) AS t FROM restaurant_events").get() as { t: string };
  assert.ok(Date.parse(oldest.t) >= NOW - (MONTH_HISTORY_DAYS + 1) * 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(newest.t) < NOW - MONTH_HISTORY_GAP_MS);
  const dates = new Set(
    (database.prepare("SELECT occurred_at FROM restaurant_events WHERE type = 'GUEST_SEATED'").all() as { occurred_at: string }[]).map((row) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.occurred_at)),
    ),
  );
  assert.ok(dates.size >= MONTH_HISTORY_DAYS - 2, `kyiv days ${dates.size}`);
  const hours = (database.prepare("SELECT occurred_at FROM restaurant_events WHERE type = 'GUEST_SEATED'").all() as { occurred_at: string }[]).map((row) =>
    Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23" }).format(new Date(row.occurred_at))),
  );
  assert.ok(hours.every((hour) => (hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 21)));
  const mismatch = database.prepare(
    `SELECT COUNT(*) AS c FROM payments JOIN orders ON orders.id = payments.order_id WHERE payments.amount != orders.total OR orders.status = 'CANCELLED'`,
  ).get() as { c: number };
  assert.equal(mismatch.c, 0);
  const servedUnpaid = database.prepare(
    `SELECT COUNT(*) AS c FROM orders WHERE status = 'SERVED' AND id LIKE 'ord-m-%' AND id NOT IN (SELECT order_id FROM payments)`,
  ).get() as { c: number };
  assert.equal(servedUnpaid.c, 0);
  database.close();
  again.close();
});

function count(database: ReturnType<typeof openDatabase>, name: string): number {
  return (database.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c;
}

function countWhere(database: ReturnType<typeof openDatabase>, name: string, where: string, param: string | undefined): number {
  const sql = `SELECT COUNT(*) AS c FROM ${name} WHERE ${where}`;
  const row = param === undefined ? database.prepare(sql).get() : database.prepare(sql).get(param);
  return (row as { c: number }).c;
}
