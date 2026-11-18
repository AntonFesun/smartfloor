import { hashString, stableStringify } from "../engine/hash";
import { validateDistribution } from "../engine/random";
import {
  DURATION_PRESET_SECONDS,
  STATION_IDS,
  type LayoutTable,
  type SimulationScenario,
  type SimulationScenarioInput,
  type SimulationWaiterSpec,
  type StationId,
} from "../models/types";
import { DEFAULT_MENU, DEFAULT_PARTY_SIZES, DEFAULT_TASK_DURATIONS } from "./defaults";

export class SimulationConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid simulation scenario:\n- ${issues.join("\n- ")}`);
    this.name = "SimulationConfigError";
  }
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const isFinite_ = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Validates input, fills defaults, resolves waiters and stations. Pure and deterministic. */
export function createSimulationScenario(input: SimulationScenarioInput): SimulationScenario {
  const issues: string[] = [];

  const layout: LayoutTable[] = (input.layout ?? []).map((t) => ({
    id: t.id,
    number: t.number,
    zoneId: t.zoneId,
    x: t.x,
    y: t.y,
    capacity: t.capacity,
    shape: t.shape,
  }));
  if (layout.length === 0) issues.push("layout must contain at least one table");
  const seen = new Set<string>();
  for (const t of layout) {
    if (typeof t.id !== "string" || t.id === "") issues.push("every table needs a non-empty id");
    else if (seen.has(t.id)) issues.push(`duplicate table id ${t.id}`);
    seen.add(t.id);
    if (!isInt(t.capacity) || t.capacity < 1) issues.push(`table ${t.id}: capacity must be an integer >= 1`);
    if (!isFinite_(t.x) || !isFinite_(t.y)) issues.push(`table ${t.id}: x and y must be finite numbers`);
    if (typeof t.zoneId !== "string" || t.zoneId === "") issues.push(`table ${t.id}: zoneId required`);
    if (!isFinite_(t.number)) issues.push(`table ${t.id}: number must be finite`);
  }

  const zones: string[] = [];
  for (const t of layout) if (!zones.includes(t.zoneId)) zones.push(t.zoneId);

  const layoutUnitsPerMeter = input.layoutUnitsPerMeter ?? 1;
  if (!isFinite_(layoutUnitsPerMeter) || layoutUnitsPerMeter <= 0) issues.push("layoutUnitsPerMeter must be > 0");
  const walkingSpeed = input.walkingSpeedMetersPerSecond ?? 1.2;
  if (!isFinite_(walkingSpeed) || walkingSpeed <= 0) issues.push("walkingSpeedMetersPerSecond must be > 0");

  const waiterCounts = resolveWaiterCounts(input, layout, zones, issues);

  const kitchen = typeof input.kitchenCapacity === "number" ? { hot: input.kitchenCapacity, cold: input.kitchenCapacity } : input.kitchenCapacity;
  const stationCapacity: Record<StationId, number> = {
    hot: kitchen?.hot ?? 6,
    cold: kitchen?.cold ?? 2,
    bar: input.barCapacity ?? 2,
  };
  for (const s of STATION_IDS) if (!isInt(stationCapacity[s]) || stationCapacity[s] < 1) issues.push(`station ${s}: capacity must be an integer >= 1`);

  const arrivalsPerHour = input.arrivalsPerHour ?? 24;
  if (!isFinite_(arrivalsPerHour) || arrivalsPerHour < 0) issues.push("arrivalsPerHour must be >= 0");

  const partySizes = (input.partySizes ?? DEFAULT_PARTY_SIZES).map((p) => ({ size: p.size, weight: p.weight }));
  if (partySizes.length === 0 || partySizes.some((p) => !isInt(p.size) || p.size < 1 || !isFinite_(p.weight) || p.weight < 0) || !(partySizes.reduce((s, p) => s + p.weight, 0) > 0))
    issues.push("partySizes needs entries with integer size >= 1 and weights >= 0 that sum to > 0");

  const menu = (input.menu ?? DEFAULT_MENU).map((m) => ({ ...m }));
  if (menu.length === 0) issues.push("menu must not be empty");
  const menuIds = new Set<string>();
  for (const m of menu) {
    if (menuIds.has(m.id)) issues.push(`duplicate menu item ${m.id}`);
    menuIds.add(m.id);
    if (!STATION_IDS.includes(m.station)) issues.push(`menu item ${m.id}: unknown station ${String(m.station)}`);
    if (!isFinite_(m.price) || m.price < 0) issues.push(`menu item ${m.id}: price must be >= 0`);
    if (!isFinite_(m.probability) || m.probability < 0) issues.push(`menu item ${m.id}: probability must be >= 0`);
    validateDistribution(m.prep, `menu item ${m.id} prep`, issues);
  }
  if (menu.length > 0 && !(menu.reduce((s, m) => s + m.probability, 0) > 0)) issues.push("menu probabilities must sum to > 0");

  const taskDurations = { ...DEFAULT_TASK_DURATIONS, ...input.taskDurations };
  validateDistribution(taskDurations.takeOrder, "taskDurations.takeOrder", issues);
  validateDistribution(taskDurations.deliverOrder, "taskDurations.deliverOrder", issues);
  validateDistribution(taskDurations.clearTable, "taskDurations.clearTable", issues);

  const diningDuration = input.diningDuration ?? { kind: "normal" as const, mean: 2400, sd: 600, min: 900 };
  validateDistribution(diningDuration, "diningDuration", issues);
  const guestPatience = input.guestPatience ?? { kind: "normal" as const, mean: 900, sd: 300, min: 120 };
  validateDistribution(guestPatience, "guestPatience", issues);

  const itemsPerGuest = input.itemsPerGuest ?? { min: 1, max: 2 };
  if (!isInt(itemsPerGuest.min) || !isInt(itemsPerGuest.max) || itemsPerGuest.min < 1 || itemsPerGuest.max < itemsPerGuest.min)
    issues.push("itemsPerGuest needs integers with 1 <= min <= max");

  const repeatOrderProbability = input.repeatOrderProbability ?? 0.25;
  if (!isFinite_(repeatOrderProbability) || repeatOrderProbability < 0 || repeatOrderProbability > 1) issues.push("repeatOrderProbability must be in [0, 1]");

  const maxQueueLength = input.maxQueueLength ?? 12;
  if (!isInt(maxQueueLength) || maxQueueLength < 0) issues.push("maxQueueLength must be an integer >= 0");

  const durationSeconds = input.durationSeconds ?? DURATION_PRESET_SECONDS[input.duration ?? "4h"];
  if (!isFinite_(durationSeconds) || durationSeconds <= 0) issues.push("duration must be > 0 seconds");

  const sla = {
    seatingWaitSeconds: input.sla?.seatingWaitSeconds ?? 600,
    waiterResponseSeconds: input.sla?.waiterResponseSeconds ?? 120,
    prepSeconds: input.sla?.prepSeconds ?? 900,
    deliverySeconds: input.sla?.deliverySeconds ?? 120,
  };
  for (const [k, v] of Object.entries(sla)) if (!isFinite_(v) || v < 0) issues.push(`sla.${k} must be >= 0`);

  const xs = layout.map((t) => t.x);
  const ys = layout.map((t) => t.y);
  const servicePoint = input.servicePoint ?? {
    x: xs.length ? Math.min(...xs) - layoutUnitsPerMeter : 0,
    y: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0,
  };

  if (input.seed === undefined || input.seed === null || String(input.seed) === "") issues.push("seed is required");

  if (issues.length > 0) throw new SimulationConfigError(issues);

  const waiters: SimulationWaiterSpec[] = [];
  for (const zoneId of zones) {
    const inZone = layout.filter((t) => t.zoneId === zoneId);
    const home = {
      x: inZone.reduce((s, t) => s + t.x, 0) / inZone.length,
      y: inZone.reduce((s, t) => s + t.y, 0) / inZone.length,
    };
    for (let k = 1; k <= (waiterCounts.get(zoneId) ?? 0); k++) waiters.push({ id: `w-${zoneId}-${k}`, zoneId, homeX: home.x, homeY: home.y });
  }

  const body = {
    schemaVersion: 1 as const,
    seed: String(input.seed),
    layout,
    zones,
    waiters,
    stationCapacity,
    arrivalsPerHour,
    partySizes,
    diningDuration,
    itemsPerGuest: { ...itemsPerGuest },
    repeatOrderProbability,
    menu,
    taskDurations,
    walkingSpeedMetersPerSecond: walkingSpeed,
    layoutUnitsPerMeter,
    servicePoint: { ...servicePoint },
    sla,
    durationSeconds,
    maxQueueLength,
    guestPatience,
    crossZoneAssistance: input.crossZoneAssistance ?? true,
  };

  return { ...body, id: hashString(stableStringify(body)), name: input.name ?? "Untitled scenario" };
}

function resolveWaiterCounts(input: SimulationScenarioInput, layout: LayoutTable[], zones: string[], issues: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (zones.length === 0) return counts;
  if (input.waitersPerZone) {
    for (const [zone, n] of Object.entries(input.waitersPerZone)) {
      if (!zones.includes(zone)) issues.push(`waitersPerZone references unknown zone ${zone}`);
      else if (!isInt(n) || n < 0) issues.push(`waitersPerZone.${zone} must be an integer >= 0`);
      else counts.set(zone, n);
    }
  } else {
    const total = input.waiterCount ?? 3;
    if (!isInt(total) || total < 1) {
      issues.push("waiterCount must be an integer >= 1");
      return counts;
    }
    const tableCount = new Map(zones.map((z) => [z, layout.filter((t) => t.zoneId === z).length]));
    const ranked = [...zones].sort((a, b) => (tableCount.get(b) ?? 0) - (tableCount.get(a) ?? 0) || zones.indexOf(a) - zones.indexOf(b));
    const totalTables = layout.length || 1;
    let assigned = 0;
    const remainders: { zone: string; rem: number }[] = [];
    for (const zone of ranked) {
      const exact = (total * (tableCount.get(zone) ?? 0)) / totalTables;
      const base = Math.floor(exact);
      counts.set(zone, base);
      assigned += base;
      remainders.push({ zone, rem: exact - base });
    }
    remainders.sort((a, b) => b.rem - a.rem || ranked.indexOf(a.zone) - ranked.indexOf(b.zone));
    for (let i = 0; assigned < total; i++, assigned++) {
      const zone = (remainders[i % remainders.length] as { zone: string }).zone;
      counts.set(zone, (counts.get(zone) ?? 0) + 1);
    }
  }
  const sum = [...counts.values()].reduce((s, n) => s + n, 0);
  if (sum < 1 && issues.length === 0) issues.push("at least one waiter is required");
  return counts;
}

export function serializeScenario(scenario: SimulationScenario): string {
  return JSON.stringify(scenario, null, 2);
}

/**
 * Loads a saved scenario. Accepts a JSON string or object. The scenario is
 * revalidated, so hand-edited files fail loudly instead of corrupting a run.
 */
export function loadScenario(source: string | SimulationScenario): SimulationScenario {
  const parsed: SimulationScenario = typeof source === "string" ? (JSON.parse(source) as SimulationScenario) : source;
  if (parsed.schemaVersion !== 1) throw new SimulationConfigError([`unsupported scenario schemaVersion ${String(parsed.schemaVersion)}`]);
  const waitersPerZone: Record<string, number> = {};
  for (const z of parsed.zones) waitersPerZone[z] = parsed.waiters.filter((w) => w.zoneId === z).length;
  const rebuilt = createSimulationScenario({
    name: parsed.name,
    seed: parsed.seed,
    layout: parsed.layout,
    waitersPerZone,
    kitchenCapacity: { hot: parsed.stationCapacity.hot, cold: parsed.stationCapacity.cold },
    barCapacity: parsed.stationCapacity.bar,
    arrivalsPerHour: parsed.arrivalsPerHour,
    partySizes: parsed.partySizes,
    diningDuration: parsed.diningDuration,
    itemsPerGuest: parsed.itemsPerGuest,
    repeatOrderProbability: parsed.repeatOrderProbability,
    menu: parsed.menu,
    taskDurations: parsed.taskDurations,
    walkingSpeedMetersPerSecond: parsed.walkingSpeedMetersPerSecond,
    layoutUnitsPerMeter: parsed.layoutUnitsPerMeter,
    servicePoint: parsed.servicePoint,
    sla: parsed.sla,
    durationSeconds: parsed.durationSeconds,
    maxQueueLength: parsed.maxQueueLength,
    guestPatience: parsed.guestPatience,
    crossZoneAssistance: parsed.crossZoneAssistance,
  });
  return rebuilt;
}

/** Same scenario with some inputs replaced, e.g. `withOverrides(a, { waiterCount: 5 })` for A/B. */
export function scenarioToInput(scenario: SimulationScenario): SimulationScenarioInput {
  const waitersPerZone: Record<string, number> = {};
  for (const z of scenario.zones) waitersPerZone[z] = scenario.waiters.filter((w) => w.zoneId === z).length;
  return {
    name: scenario.name,
    seed: scenario.seed,
    layout: scenario.layout,
    waitersPerZone,
    kitchenCapacity: { hot: scenario.stationCapacity.hot, cold: scenario.stationCapacity.cold },
    barCapacity: scenario.stationCapacity.bar,
    arrivalsPerHour: scenario.arrivalsPerHour,
    partySizes: scenario.partySizes,
    diningDuration: scenario.diningDuration,
    itemsPerGuest: scenario.itemsPerGuest,
    repeatOrderProbability: scenario.repeatOrderProbability,
    menu: scenario.menu,
    taskDurations: scenario.taskDurations,
    walkingSpeedMetersPerSecond: scenario.walkingSpeedMetersPerSecond,
    layoutUnitsPerMeter: scenario.layoutUnitsPerMeter,
    servicePoint: scenario.servicePoint,
    sla: scenario.sla,
    durationSeconds: scenario.durationSeconds,
    maxQueueLength: scenario.maxQueueLength,
    guestPatience: scenario.guestPatience,
    crossZoneAssistance: scenario.crossZoneAssistance,
  };
}

export function withOverrides(scenario: SimulationScenario, overrides: Partial<SimulationScenarioInput>): SimulationScenario {
  const base = scenarioToInput(scenario);
  const next: SimulationScenarioInput = { ...base, ...overrides };
  if (overrides.waiterCount !== undefined && overrides.waitersPerZone === undefined) delete next.waitersPerZone;
  return createSimulationScenario(next);
}
