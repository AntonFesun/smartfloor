import assert from "node:assert/strict";
import test from "node:test";
import type { RestaurantEvent } from "../src/domain/journal";
import {
  colorsFor,
  compareToRestaurant,
  getRestaurantMetrics,
  getServiceHeatmap,
  getTableMetrics,
  getZoneMetrics,
  heatBand,
  heatColor,
  zonedLocalToUtc,
} from "../src/domain/analytics";
import { useHeatmapStore } from "../src/store/heatmap-store";
import type { Thresholds } from "../src/types";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const THRESHOLDS: Thresholds = { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 };
const TABLES = [
  { id: "T07", zone: "Main Hall", number: 7 },
  { id: "T02", zone: "Main Hall", number: 2 },
  { id: "T09", zone: "Terrace", number: 9 },
];

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

function query(events: RestaurantEvent[], now = NOW, range: { kind: "today" | "yesterday" | "last_hour" | "last_7_days" | "custom"; from?: string; to?: string } = { kind: "today" }) {
  return { events, tables: TABLES, range, now, thresholds: THRESHOLDS };
}

test("a table with no journal events is No data, not zero", () => {
  const tables = getTableMetrics(query([]));
  const empty = tables.find((table) => table.tableId === "T02");
  assert.ok(empty);
  for (const reading of Object.values(empty.metrics)) {
    assert.equal(reading.value, null);
    assert.equal(reading.observations, 0);
    assert.equal(reading.normalized, null);
    assert.equal(heatColor(reading.normalized, reading.direction), null);
    assert.equal(heatBand(reading.normalized, reading.direction), "no-data");
  }
  assert.equal(getRestaurantMetrics(query([])).metrics.ack.value, null);
  assert.equal(compareToRestaurant(empty.metrics.ack, getRestaurantMetrics(query([])).metrics.ack), "No data");
});

test("an unresolved waiter call changes ack time and color", () => {
  const events = [
    event({
      id: "c1",
      sequence: 1,
      type: "WAITER_CALLED",
      occurredAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      payload: { call: { id: "call-1" } },
    }),
  ];
  const reading = getTableMetrics(query(events)).find((table) => table.tableId === "T07")?.metrics.ack;
  assert.ok(reading);
  assert.equal(reading.value, 10 * 60 * 1000);
  assert.equal(reading.observations, 1);
  assert.ok(reading.normalized != null && reading.normalized > 0.5);
  assert.equal(heatBand(reading.normalized, reading.direction), "critical");
  assert.equal(heatColor(reading.normalized, "higher-worse"), "#ef4444");

  const fast = getTableMetrics(query([
    event({ id: "c1", sequence: 1, type: "WAITER_CALLED", occurredAt: new Date(NOW - 20_000).toISOString(), payload: { call: { id: "call-1" } } }),
    event({ id: "c2", sequence: 2, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 10_000).toISOString(), payload: { callId: "call-1" } }),
  ])).find((table) => table.tableId === "T07")?.metrics.ack;
  assert.ok(fast);
  assert.equal(fast.value, 10_000);
  assert.equal(heatBand(fast.normalized, fast.direction), "healthy");
  assert.notEqual(heatColor(reading.normalized, "higher-worse"), heatColor(fast.normalized, "higher-worse"));
});

test("completed durations, counts, and SLA violations stay separate", () => {
  const start = new Date(NOW - 30 * 60 * 1000).toISOString();
  const events = [
    event({ id: "o1", sequence: 1, type: "ORDER_CREATED", occurredAt: start, orderId: "ord-1" }),
    event({ id: "o2", sequence: 2, type: "ORDER_PREPARING", occurredAt: start, orderId: "ord-1" }),
    event({ id: "o3", sequence: 3, type: "ORDER_READY", occurredAt: new Date(NOW - 20 * 60 * 1000).toISOString(), orderId: "ord-1" }),
    event({ id: "o4", sequence: 4, type: "ORDER_SERVED", occurredAt: new Date(NOW - 10 * 60 * 1000).toISOString(), orderId: "ord-1" }),
    event({ id: "g1", sequence: 5, type: "GUEST_SEATED", occurredAt: new Date(NOW - 40 * 60 * 1000).toISOString() }),
    event({ id: "g2", sequence: 6, type: "TABLE_RELEASED", occurredAt: new Date(NOW - 5 * 60 * 1000).toISOString() }),
    event({ id: "c1", sequence: 7, type: "WAITER_CALLED", occurredAt: new Date(NOW - 8 * 60 * 1000).toISOString(), payload: { call: { id: "call-9" } } }),
    event({ id: "c2", sequence: 8, type: "WAITER_CALL_RESOLVED", occurredAt: new Date(NOW - 60 * 1000).toISOString(), payload: { callId: "call-9" } }),
  ];
  const metrics = getTableMetrics(query(events)).find((table) => table.tableId === "T07")?.metrics;
  assert.ok(metrics);
  assert.equal(metrics.prep.value, 10 * 60 * 1000);
  assert.equal(metrics.delivery.value, 10 * 60 * 1000);
  assert.equal(metrics.occupancy.value, 35 * 60 * 1000);
  assert.equal(metrics.orders.value, 1);
  assert.equal(metrics.orders.direction, "activity");
  assert.equal(metrics.calls.value, 1);
  assert.equal(metrics.calls.direction, "activity");
  assert.equal(heatBand(1, "activity"), "very-busy");
  assert.notEqual(heatBand(1, "activity"), "critical");
  assert.equal(metrics.resolution.value, 7 * 60 * 1000);
  assert.ok((metrics.sla.value ?? 0) >= 1);
  assert.ok((metrics.sla.observations ?? 0) >= 1);
});

test("zero violations are a real zero and call volume is not a failure color", () => {
  const events = [
    event({ id: "c1", sequence: 1, type: "WAITER_CALLED", occurredAt: new Date(NOW - 20_000).toISOString(), payload: { call: { id: "call-1" } } }),
    event({ id: "c2", sequence: 2, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 10_000).toISOString(), payload: { callId: "call-1" } }),
    event({ id: "c3", sequence: 3, type: "WAITER_CALL_RESOLVED", occurredAt: new Date(NOW - 5_000).toISOString(), payload: { callId: "call-1" } }),
  ];
  const metrics = getTableMetrics(query(events)).find((table) => table.tableId === "T07")?.metrics;
  assert.ok(metrics);
  assert.equal(metrics.sla.value, 0);
  assert.equal(metrics.sla.observations, 2);
  assert.equal(metrics.sla.normalized, 0);
  assert.equal(metrics.calls.normalized, 1 / 8);
  assert.equal(heatColor(metrics.calls.normalized, metrics.calls.direction), "#64748b");
});

test("ranges keep yesterday, the last hour, and a custom window apart", () => {
  const yesterdayEvent = event({
    id: "y",
    sequence: 1,
    type: "ORDER_CREATED",
    occurredAt: "2026-11-14T18:00:00.000Z",
    orderId: "ord-y",
  });
  const recent = event({
    id: "n",
    sequence: 2,
    type: "ORDER_CREATED",
    occurredAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    orderId: "ord-n",
  });
  const old = event({
    id: "o",
    sequence: 3,
    type: "ORDER_CREATED",
    occurredAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    orderId: "ord-o",
  });
  const yesterday = getTableMetrics(query([yesterdayEvent, recent], NOW, { kind: "yesterday" })).find((table) => table.tableId === "T07");
  const hour = getTableMetrics(query([yesterdayEvent, recent, old], NOW, { kind: "last_hour" })).find((table) => table.tableId === "T07");
  assert.equal(yesterday?.metrics.orders.value, 1);
  assert.equal(hour?.metrics.orders.value, 1);
  const custom = getTableMetrics(query([yesterdayEvent, recent], NOW, {
    kind: "custom",
    from: "2026-11-14T00:00:00.000Z",
    to: "2026-11-15T00:00:00.000Z",
  })).find((table) => table.tableId === "T07");
  assert.equal(custom?.metrics.orders.value, 1);
});

test("zone and restaurant averages pool samples, and a table can be compared", () => {
  const events = [
    event({ id: "a1", sequence: 1, type: "WAITER_CALLED", occurredAt: new Date(NOW - 60_000).toISOString(), tableId: "T07", payload: { call: { id: "a" } } }),
    event({ id: "a2", sequence: 2, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 50_000).toISOString(), tableId: "T07", payload: { callId: "a" } }),
    event({ id: "b1", sequence: 3, type: "WAITER_CALLED", occurredAt: new Date(NOW - 40_000).toISOString(), tableId: "T02", payload: { call: { id: "b" } } }),
    event({ id: "b2", sequence: 4, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 10_000).toISOString(), tableId: "T02", payload: { callId: "b" } }),
    event({ id: "c1", sequence: 5, type: "WAITER_CALLED", occurredAt: new Date(NOW - 20_000).toISOString(), tableId: "T09", zoneId: "Terrace", payload: { call: { id: "c" } } }),
    event({ id: "c2", sequence: 6, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 10_000).toISOString(), tableId: "T09", payload: { callId: "c" } }),
  ];
  const input = query(events);
  const tables = getTableMetrics(input);
  const zones = getZoneMetrics(input);
  const restaurant = getRestaurantMetrics(input);
  const hall = zones.find((zone) => zone.zone === "Main Hall");
  assert.equal(hall?.metrics.ack.value, 20_000);
  assert.equal(hall?.metrics.ack.observations, 2);
  assert.equal(restaurant.metrics.ack.value, (10_000 + 30_000 + 10_000) / 3);
  const terrace = zones.find((zone) => zone.zone === "Terrace");
  assert.equal(terrace?.metrics.ack.observations, 1);
  const t07 = tables.find((table) => table.tableId === "T07");
  assert.ok(t07);
  assert.match(compareToRestaurant(t07.metrics.ack, restaurant.metrics.ack), /faster than the restaurant average/);
  assert.equal(restaurant.metrics.calls.value, 1);
  assert.equal(restaurant.metrics.calls.observations, 3);
});

test("an open call outside the selected window is not invented there", () => {
  const events = [
    event({
      id: "c1",
      sequence: 1,
      type: "WAITER_CALLED",
      occurredAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
      payload: { call: { id: "call-1" } },
    }),
  ];
  const yesterday = getTableMetrics(query(events, NOW, { kind: "yesterday" })).find((table) => table.tableId === "T07");
  assert.equal(yesterday?.metrics.ack.value, null);
  const today = getTableMetrics(query(events)).find((table) => table.tableId === "T07");
  assert.equal(today?.metrics.ack.value, 30 * 60 * 1000);
});

test("Kyiv local time converts to UTC and the heatmap keeps its dataset when the metric changes", () => {
  assert.equal(zonedLocalToUtc("2026-11-15T20:00"), "2026-11-15T18:00:00.000Z");
  const report = getServiceHeatmap(query([
    event({ id: "c1", sequence: 1, type: "WAITER_CALLED", occurredAt: new Date(NOW - 20_000).toISOString(), payload: { call: { id: "call-1" } } }),
    event({ id: "c2", sequence: 2, type: "WAITER_CALL_ACKNOWLEDGED", occurredAt: new Date(NOW - 10_000).toISOString(), payload: { callId: "call-1" } }),
  ]));
  useHeatmapStore.setState({ mode: "heatmap", metric: "ack", report, colors: colorsFor(report, "ack"), error: null });
  useHeatmapStore.getState().setMetric("calls");
  assert.equal(useHeatmapStore.getState().report, report);
  assert.equal(useHeatmapStore.getState().metric, "calls");
  assert.equal(useHeatmapStore.getState().colors.T07, heatColor(report.tables.find((table) => table.tableId === "T07")?.metrics.calls.normalized ?? null, "activity"));
  useHeatmapStore.setState({ mode: "operations", metric: "ack", report: null, colors: {}, error: null, rangeKind: "today", customFrom: "", customTo: "" });
});
