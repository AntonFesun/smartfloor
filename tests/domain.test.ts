import assert from "node:assert/strict";
import test from "node:test";
import { layoutIssues } from "../src/domain/layout";
import { computeMetrics } from "../src/domain/metrics";
import { nextOrderStatus } from "../src/domain/orders";
import { buildSeed } from "../src/domain/seed-data";
import { nextTableStatus } from "../src/domain/tables";
import { assertCanCall, nextWaiterStatus } from "../src/domain/waiter";
import { resolvePublicUrl } from "../src/lib/public-url";
import { readThresholds } from "../src/lib/thresholds";
import type { Order, RestaurantTable, ServiceEvent, WaiterCall } from "../src/types";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const THRESHOLDS = { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 };

test("table transitions follow the service rules", () => {
  assert.equal(nextTableStatus("AVAILABLE", "seat"), "OCCUPIED");
  assert.equal(nextTableStatus("RESERVED", "seat"), "OCCUPIED");
  assert.equal(nextTableStatus("AVAILABLE", "reserve"), "RESERVED");
  assert.equal(nextTableStatus("RESERVED", "release"), "AVAILABLE");
  assert.equal(nextTableStatus("OCCUPIED", "clear"), "AVAILABLE");
  assert.throws(() => nextTableStatus("OCCUPIED", "reserve"), /OCCUPIED/);
  assert.throws(() => nextTableStatus("AVAILABLE", "clear"), /AVAILABLE/);
});

test("order lifecycle rejects skips and terminal moves", () => {
  assert.equal(nextOrderStatus("NEW", "ACCEPTED"), "ACCEPTED");
  assert.equal(nextOrderStatus("ACCEPTED", "PREPARING"), "PREPARING");
  assert.equal(nextOrderStatus("PREPARING", "READY"), "READY");
  assert.equal(nextOrderStatus("READY", "SERVED"), "SERVED");
  assert.equal(nextOrderStatus("NEW", "CANCELLED"), "CANCELLED");
  assert.throws(() => nextOrderStatus("NEW", "READY"), /NEW/);
  assert.throws(() => nextOrderStatus("SERVED", "CANCELLED"), /SERVED/);
  assert.throws(() => nextOrderStatus("CANCELLED", "ACCEPTED"), /CANCELLED/);
});

test("waiter calls cannot duplicate and only move forward", () => {
  assert.doesNotThrow(() => assertCanCall(false));
  assert.throws(() => assertCanCall(true), /active waiter/);
  assert.equal(nextWaiterStatus("ACTIVE", "acknowledge"), "ACKNOWLEDGED");
  assert.equal(nextWaiterStatus("ACKNOWLEDGED", "resolve"), "RESOLVED");
  assert.equal(nextWaiterStatus("ACTIVE", "resolve"), "RESOLVED");
  assert.throws(() => nextWaiterStatus("RESOLVED", "acknowledge"), /RESOLVED/);
  assert.throws(() => nextWaiterStatus("ACKNOWLEDGED", "acknowledge"), /ACKNOWLEDGED/);
});

test("metrics come only from paired timestamps", () => {
  const tables = [{ id: "T01", zone: "Main Hall", number: 1 }] as RestaurantTable[];
  const events: ServiceEvent[] = [
    event("e1", "guests.seated", "T01", 0),
    event("e2", "order.submitted", "T01", 1_000, { orderId: "o1" }),
    event("e3", "order.accepted", "T01", 4_000, { orderId: "o1" }),
    event("e4", "order.prep_started", "T01", 5_000, { orderId: "o1" }),
    event("e5", "order.ready", "T01", 10_000, { orderId: "o1" }),
    event("e6", "order.served", "T01", 16_000, { orderId: "o1" }),
    event("e7", "waiter.called", "T01", 2_000, { callId: "c1" }),
    event("e8", "waiter.acknowledged", "T01", 5_000, { callId: "c1" }),
    event("e9", "table.cleared", "T01", 20_000),
    event("e10", "guests.seated", "T01", 50_000),
  ];
  const metrics = computeMetrics({
    events,
    tables,
    orders: [],
    waiterCalls: [],
    now: NOW,
    thresholds: THRESHOLDS,
  });
  assert.equal(metrics.submitToAccept.avgMs, 3_000);
  assert.equal(metrics.acceptToReady.avgMs, 6_000);
  assert.equal(metrics.readyToServed.avgMs, 6_000);
  assert.equal(metrics.waiterResponse.avgMs, 3_000);
  assert.equal(metrics.occupancy.avgMs, 20_000);
  assert.equal(metrics.turnover.avgMs, 50_000);
  const empty = computeMetrics({
    events: [],
    tables,
    orders: [],
    waiterCalls: [],
    now: NOW,
    thresholds: THRESHOLDS,
  });
  assert.equal(empty.submitToAccept.avgMs, null);
  assert.equal(empty.longestUnresolved, null);
});

test("seed floor is valid and metrics are populated", () => {
  const seed = buildSeed(NOW);
  assert.equal(seed.tables.length, 16);
  assert.ok(seed.menu.length >= 15);
  assert.equal(new Set(seed.tables.map((table) => table.zone)).size, 3);
  assert.equal(layoutIssues(seed.tables).length, 0);
  assert.ok(seed.tables.some((table) => table.id === "T07" && table.status === "OCCUPIED"));
  const revenue = seed.orders.filter((order) => order.status === "SERVED").reduce((sum, order) => sum + order.total, 0);
  assert.equal(revenue, 2110);
  const metrics = computeMetrics({
    events: seed.events,
    tables: seed.tables,
    orders: seed.orders,
    waiterCalls: seed.calls,
    now: NOW,
    thresholds: THRESHOLDS,
  });
  assert.ok((metrics.waiterResponse.count ?? 0) >= 2);
  assert.ok((metrics.occupancy.count ?? 0) >= 2);
  assert.equal(metrics.turnover.count, 1);
  assert.ok(metrics.longestUnresolved);
  assert.ok(metrics.delaysByZone.some((zone) => zone.prep + zone.waiter + zone.ready + zone.occupancy > 0));
});

test("public URL prefers APP_PUBLIC_URL and otherwise a LAN address", () => {
  assert.equal(
    resolvePublicUrl({
      env: { APP_PUBLIC_URL: "http://192.168.1.20:3000/" },
      interfaces: { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never] },
    }),
    "http://192.168.1.20:3000",
  );
  assert.equal(
    resolvePublicUrl({
      env: {},
      port: "3000",
      interfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
        en0: [{ address: "10.0.0.8", family: "IPv4", internal: false } as never],
      },
    }),
    "http://10.0.0.8:3000",
  );
  assert.equal(readThresholds({ LONG_WAITER_MS: "5000" }).waiterMs, 5000);
  assert.equal(readThresholds({}).prepMs, 20 * 60 * 1000);
});

function event(
  id: string,
  type: ServiceEvent["type"],
  tableId: string,
  delta: number,
  extra?: { orderId?: string; callId?: string },
): ServiceEvent {
  return {
    id,
    tableId,
    timestamp: new Date(NOW + delta).toISOString(),
    type,
    orderId: extra?.orderId ?? null,
    callId: extra?.callId ?? null,
    metadata: {},
  };
}

void 0 as unknown as Order;
void 0 as unknown as WaiterCall;
