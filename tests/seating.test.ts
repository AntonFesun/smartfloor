import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { suggestSeating, tablesAreAdjacent } from "../src/domain/seating";
import { openDatabase } from "../src/lib/db";
import { getEvents } from "../src/lib/journal";
import { createOrder, getSnapshot, resetDemo } from "../src/lib/repository";
import { bookTables, dissolveGroup } from "../src/lib/seating";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const LATER = new Date(NOW + 5 * 60 * 60 * 1000).toISOString();
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

test("ranking is deterministic and explains the fit", () => {
  const database = fresh();
  const snap = getSnapshot(database, CTX);
  const first = suggestSeating(snap.tables, [], [], { partySize: 2, start: LATER, zone: "Main Hall" }, NOW);
  const second = suggestSeating(snap.tables, [], [], { partySize: 2, start: LATER, zone: "Main Hall" }, NOW);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.zone, "Main Hall");
  assert.ok(first[0]?.reasons.some((reason) => reason.includes("Matches preferred zone")));
  assert.ok(first.every((item, index) => index === 0 || first[index - 1]!.score <= item.score));
  const occupied = snap.tables.find((table) => table.id === "T07")!;
  const terrace = snap.tables.find((table) => table.id === "T09")!;
  assert.equal(tablesAreAdjacent(occupied, terrace), false);
  database.close();
});

test("occupied and cross-zone tables are rejected, adjacent groups keep table ids", () => {
  const database = fresh();
  assert.throws(() => bookTables(database, { tableIds: ["T07"], partySize: 2, start: new Date(NOW + 30 * 60_000).toISOString() }, NOW), /not free/);
  assert.throws(() => bookTables(database, { tableIds: ["T07", "T09"], partySize: 8, start: LATER }, NOW), /across zones/);
  const before = getSnapshot(database, CTX).tables.map((table) => table.id);
  const floor = (database.prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM restaurant_events").get() as { s: number }).s;
  const booked = bookTables(database, { tableIds: ["T05", "T06"], partySize: 8, start: LATER, durationMinutes: 90 }, NOW);
  assert.equal(booked.group?.status, "ACTIVE");
  assert.deepEqual(booked.group?.tableIds, ["T05", "T06"]);
  assert.deepEqual(getSnapshot(database, CTX).tables.map((table) => table.id), before);
  assert.equal(booked.reservation.groupId, booked.group?.id);
  assert.equal(booked.reservation.tableId, null);
  const written = getEvents(database, { afterSequence: floor, limit: 20 }).events;
  assert.ok(written.some((event) => event.type === "TABLE_GROUP_CREATED"));
  assert.ok(written.some((event) => event.type === "RESERVATION_CREATED"));
  assert.throws(() => bookTables(database, { tableIds: ["T05"], partySize: 2, start: LATER }, NOW), /whole group/);
  assert.throws(() => bookTables(database, { tableIds: ["T05", "T06"], partySize: 8, start: LATER }, NOW), /not free/);
  const water = getSnapshot(database, CTX).menu.find((item) => item.name === "Still water");
  assert.ok(water);
  createOrder(database, { tableId: "T05", items: [{ menuItemId: water.id, qty: 1 }] }, NOW);
  assert.throws(() => dissolveGroup(database, booked.group!.id, NOW), /open orders/);
  database.close();
});

test("a second manager cannot book a table the first manager just took", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-"));
  const file = path.join(dir, "seat.db");
  const primary = openDatabase(file);
  resetDemo(primary, CTX);
  const start = LATER;
  bookTables(primary, { tableIds: ["T01"], partySize: 2, start }, NOW);
  const other = new Database(file);
  other.pragma("busy_timeout = 200");
  primary.exec("BEGIN IMMEDIATE");
  let blocked = false;
  try {
    other.exec("BEGIN IMMEDIATE");
  } catch {
    blocked = true;
  }
  assert.equal(blocked, true);
  primary.exec("ROLLBACK");
  assert.throws(() => bookTables(other, { tableIds: ["T01"], partySize: 2, start }, NOW), /not free/);
  other.close();
  primary.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
