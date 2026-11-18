import assert from "node:assert/strict";
import test from "node:test";
import { layoutFromRestaurant } from "../src/domain/simulation-layout";
import { openDatabase } from "../src/lib/db";
import { getEvents } from "../src/lib/journal";
import { getSnapshot, resetDemo } from "../src/lib/repository";
import { listSimulationScenarios, saveSimulationScenario } from "../src/lib/simulation-store";
import { createSimulationScenario, runSimulation } from "../src/simulation";

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const CTX = {
  now: NOW,
  publicUrl: "http://10.0.0.8:3000",
  thresholds: { waiterMs: 180_000, prepMs: 1_200_000, readyMs: 480_000, occupancyMs: 5_400_000 },
};

test("a simulation run does not change live orders or the journal", () => {
  const database = openDatabase(":memory:");
  resetDemo(database, CTX);
  const before = getSnapshot(database, CTX);
  const journalBefore = getEvents(database).events.map((event) => event.id);
  const ordersBefore = before.orders.map((order) => [order.id, order.status, order.total]);
  const ticketsBefore = before.tickets.length;
  const tasksBefore = before.waiterTasks.length;
  const scenario = createSimulationScenario({
    name: "Isolation",
    seed: 7,
    layout: layoutFromRestaurant(before.tables),
    waiterCount: 3,
    kitchenCapacity: { hot: 2, cold: 1 },
    barCapacity: 1,
    arrivalsPerHour: 12,
    durationSeconds: 20 * 60,
  });
  const result = runSimulation(scenario);
  assert.ok(result.events.length > 0);
  assert.equal(result.events.some((event) => event.type === "GUEST_ARRIVAL"), true);
  assert.equal(result.metrics.kind, "simulation");
  saveSimulationScenario(database, scenario);
  const after = getSnapshot(database, CTX);
  assert.deepEqual(after.orders.map((order) => [order.id, order.status, order.total]), ordersBefore);
  assert.deepEqual(getEvents(database).events.map((event) => event.id), journalBefore);
  assert.equal(after.tickets.length, ticketsBefore);
  assert.equal(after.waiterTasks.length, tasksBefore);
  assert.equal(getEvents(database).events.some((event) => event.type === "ORDER_CREATED" && event.payload.simulated === true), false);
  assert.equal(listSimulationScenarios(database).length, 1);
  assert.equal(listSimulationScenarios(database)[0]?.name, "Isolation");
  database.close();
});
