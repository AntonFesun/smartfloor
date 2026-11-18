import { hashString, stableStringify } from "../engine/hash";
import { runSimulation } from "../engine/api";
import type { BottleneckId, SimulationMetrics, SimulationScenario } from "../models/types";

export type Direction = "lower_is_better" | "higher_is_better" | "neutral";
export type Verdict = "better" | "worse" | "same" | "n/a";

export interface ComparisonRow {
  key: string;
  label: string;
  unit: "seconds" | "count" | "ratio" | "currency";
  direction: Direction;
  a: number | null;
  b: number | null;
  /** b - a, null when either side has no value. */
  diff: number | null;
  /** (b - a) / |a| * 100, null when a is 0, missing or the diff is undefined. */
  percentDiff: number | null;
  verdict: Verdict;
}

export interface Insight {
  id: string;
  kind: "improvement" | "regression" | "bottleneck" | "capacity" | "throughput" | "warning";
  text: string;
  /** Raw numbers the text was computed from. */
  data: Record<string, number | string | null>;
}

export interface ABComparison {
  label: "simulation";
  rows: ComparisonRow[];
  insights: Insight[];
  /** True when both runs share seed and every demand parameter. */
  demandIdentical: boolean;
  warnings: string[];
}

export interface ABResult {
  a: { scenario: SimulationScenario; metrics: SimulationMetrics };
  b: { scenario: SimulationScenario; metrics: SimulationMetrics };
  comparison: ABComparison;
}

interface MetricDef {
  key: string;
  label: string;
  unit: ComparisonRow["unit"];
  direction: Direction;
  read: (m: SimulationMetrics) => number | null;
}

export const METRIC_DEFS: readonly MetricDef[] = [
  { key: "guestsServed", label: "Guests served", unit: "count", direction: "higher_is_better", read: (m) => m.guests.served },
  { key: "guestsRejected", label: "Guests rejected", unit: "count", direction: "lower_is_better", read: (m) => m.guests.rejected },
  { key: "avgSeatingWait", label: "Avg seating wait", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.seating.mean },
  { key: "avgWaiterResponse", label: "Avg waiter response", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.waiterResponse.mean },
  { key: "p90WaiterResponse", label: "P90 waiter response", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.waiterResponse.p90 },
  { key: "avgPrep", label: "Avg order prep time", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.prep.mean },
  { key: "avgKitchenQueue", label: "Avg kitchen queue wait", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.kitchenQueue.mean },
  { key: "avgDeliveryDelay", label: "Avg delivery delay", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.delivery.mean },
  { key: "avgOrderToServe", label: "Avg order to serve", unit: "seconds", direction: "lower_is_better", read: (m) => m.waits.orderToServe.mean },
  { key: "waiterUtilization", label: "Waiter utilization", unit: "ratio", direction: "neutral", read: (m) => m.utilization.waiters },
  { key: "tableUtilization", label: "Table utilization", unit: "ratio", direction: "neutral", read: (m) => m.utilization.tables },
  { key: "hotUtilization", label: "Hot kitchen utilization", unit: "ratio", direction: "neutral", read: (m) => m.utilization.stations.hot },
  { key: "coldUtilization", label: "Cold kitchen utilization", unit: "ratio", direction: "neutral", read: (m) => m.utilization.stations.cold },
  { key: "barUtilization", label: "Bar utilization", unit: "ratio", direction: "neutral", read: (m) => m.utilization.stations.bar },
  { key: "turnoverPerTable", label: "Turnover per table", unit: "ratio", direction: "higher_is_better", read: (m) => m.turnover.perTable },
  { key: "slaViolations", label: "SLA violations", unit: "count", direction: "lower_is_better", read: (m) => m.sla.total },
  { key: "estimatedOrderValue", label: "Estimated order value (simulated)", unit: "currency", direction: "higher_is_better", read: (m) => m.orders.estimatedOrderValue },
];

/** Hash of everything that shapes demand: same hash + same seed = same arriving parties and orders. */
export function demandSignature(s: SimulationScenario): string {
  return hashString(
    stableStringify({
      seed: s.seed,
      arrivalsPerHour: s.arrivalsPerHour,
      partySizes: s.partySizes,
      diningDuration: s.diningDuration,
      itemsPerGuest: s.itemsPerGuest,
      repeatOrderProbability: s.repeatOrderProbability,
      menu: s.menu,
      taskDurations: s.taskDurations,
      guestPatience: s.guestPatience,
      durationSeconds: s.durationSeconds,
    }),
  );
}

export function compareMetricValues(a: number | null, b: number | null, direction: Direction): Pick<ComparisonRow, "diff" | "percentDiff" | "verdict"> {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return { diff: null, percentDiff: null, verdict: "n/a" };
  const diff = b - a;
  const percentDiff = a !== 0 ? (diff / Math.abs(a)) * 100 : null;
  let verdict: Verdict = "same";
  if (diff !== 0) {
    if (direction === "neutral") verdict = "same";
    else verdict = (direction === "lower_is_better") === diff < 0 ? "better" : "worse";
  }
  return { diff, percentDiff, verdict };
}

export function compareSimulationMetrics(
  a: SimulationMetrics,
  b: SimulationMetrics,
  context: { scenarioA?: SimulationScenario; scenarioB?: SimulationScenario } = {},
): ABComparison {
  const rows: ComparisonRow[] = METRIC_DEFS.map((def) => {
    const va = def.read(a);
    const vb = def.read(b);
    return { key: def.key, label: def.label, unit: def.unit, direction: def.direction, a: va, b: vb, ...compareMetricValues(va, vb, def.direction) };
  });

  const warnings: string[] = [];
  let demandIdentical = a.seed === b.seed;
  if (a.seed !== b.seed) warnings.push(`Seeds differ (${a.seed} vs ${b.seed}); differences mix demand noise with the change under test.`);
  if (context.scenarioA && context.scenarioB && demandSignature(context.scenarioA) !== demandSignature(context.scenarioB)) {
    demandIdentical = false;
    if (a.seed === b.seed) warnings.push("Demand parameters differ between A and B; this is not a like-for-like staffing comparison.");
  }
  if (a.simulatedSeconds !== b.simulatedSeconds) warnings.push("Runs cover different simulated durations.");

  return { label: "simulation", rows, insights: buildInsights(rows, a, b, context), demandIdentical, warnings };
}

export function runABComparison(scenarioA: SimulationScenario, scenarioB: SimulationScenario): ABResult {
  const a = runSimulation(scenarioA, { recordEvents: false });
  const b = runSimulation(scenarioB, { recordEvents: false });
  return {
    a: { scenario: scenarioA, metrics: a.metrics },
    b: { scenario: scenarioB, metrics: b.metrics },
    comparison: compareSimulationMetrics(a.metrics, b.metrics, { scenarioA, scenarioB }),
  };
}

const fmt = {
  seconds: (v: number): string => (Math.abs(v) >= 120 ? `${(v / 60).toFixed(1)} min` : `${v.toFixed(0)} s`),
  count: (v: number): string => String(Math.round(v)),
  ratio: (v: number): string => (v <= 1.5 ? `${(v * 100).toFixed(0)}%` : v.toFixed(2)),
  currency: (v: number): string => v.toFixed(0),
};

function describeRow(row: ComparisonRow): string {
  const f = fmt[row.unit];
  const pct = row.percentDiff === null ? "" : ` (${row.percentDiff >= 0 ? "+" : ""}${row.percentDiff.toFixed(0)}%)`;
  return `${row.label.toLowerCase()} went from ${f(row.a as number)} to ${f(row.b as number)}${pct}`;
}

const BOTTLENECK_NAMES: Record<BottleneckId, string> = {
  seating: "table availability",
  waiters: "waiter capacity",
  hot: "the hot kitchen",
  cold: "the cold kitchen",
  bar: "the bar",
};

function buildInsights(
  rows: ComparisonRow[],
  a: SimulationMetrics,
  b: SimulationMetrics,
  context: { scenarioA?: SimulationScenario; scenarioB?: SimulationScenario },
): Insight[] {
  const insights: Insight[] = [];
  const scored = rows
    .filter((r) => r.verdict === "better" || r.verdict === "worse")
    .map((r) => ({ row: r, magnitude: r.percentDiff !== null ? Math.abs(r.percentDiff) : Number.POSITIVE_INFINITY }))
    .sort((x, y) => y.magnitude - x.magnitude || x.row.key.localeCompare(y.row.key));

  for (const { row } of scored.filter((s) => s.row.verdict === "better").slice(0, 3)) {
    insights.push({
      id: `improvement:${row.key}`,
      kind: "improvement",
      text: `In B, ${describeRow(row)}.`,
      data: { key: row.key, a: row.a, b: row.b, percentDiff: row.percentDiff },
    });
  }
  for (const { row } of scored.filter((s) => s.row.verdict === "worse").slice(0, 3)) {
    insights.push({
      id: `regression:${row.key}`,
      kind: "regression",
      text: `In B, ${describeRow(row)}, which is worse.`,
      data: { key: row.key, a: row.a, b: row.b, percentDiff: row.percentDiff },
    });
  }

  const pa = a.bottleneck.primary;
  const pb = b.bottleneck.primary;
  if (pa && pb) {
    const shareA = a.bottleneck.shares?.[pa] ?? 0;
    const shareB = b.bottleneck.shares?.[pb] ?? 0;
    insights.push({
      id: "bottleneck",
      kind: "bottleneck",
      text:
        pa === pb
          ? `${capitalize(BOTTLENECK_NAMES[pa])} is the main source of delay in both runs (${(shareA * 100).toFixed(0)}% of queueing delay in A, ${(shareB * 100).toFixed(0)}% in B).`
          : `The main source of delay moves from ${BOTTLENECK_NAMES[pa]} in A (${(shareA * 100).toFixed(0)}% of queueing delay) to ${BOTTLENECK_NAMES[pb]} in B (${(shareB * 100).toFixed(0)}%).`,
      data: { primaryA: pa, primaryB: pb, shareA, shareB },
    });
  } else if (pa !== pb) {
    insights.push({
      id: "bottleneck",
      kind: "bottleneck",
      text: pa ? `Run A queued mostly on ${BOTTLENECK_NAMES[pa]}; run B had no measurable queueing delay.` : `Run B queued mostly on ${BOTTLENECK_NAMES[pb as BottleneckId]}; run A had no measurable queueing delay.`,
      data: { primaryA: pa, primaryB: pb },
    });
  }

  const wa = context.scenarioA?.waiters.length;
  const wb = context.scenarioB?.waiters.length;
  const respA = a.waits.waiterResponse.mean;
  const respB = b.waits.waiterResponse.mean;
  const utilA = a.utilization.waiters;
  const utilB = b.utilization.waiters;
  if (wa !== undefined && wb !== undefined && wa !== wb && respA !== null && respB !== null && utilA !== null && utilB !== null) {
    const added = wb - wa;
    const perWaiter = (respA - respB) / added;
    insights.push({
      id: "capacity:waiters",
      kind: "capacity",
      text: `Going from ${wa} to ${wb} waiters changed average waiter response from ${fmt.seconds(respA)} to ${fmt.seconds(respB)} (${fmt.seconds(perWaiter)} per added waiter) while waiter utilization moved from ${fmt.ratio(utilA)} to ${fmt.ratio(utilB)}.`,
      data: { waitersA: wa, waitersB: wb, responseA: respA, responseB: respB, perAddedWaiter: perWaiter, utilizationA: utilA, utilizationB: utilB },
    });
  }

  const dGuests = b.guests.served - a.guests.served;
  const dValue = b.orders.estimatedOrderValue - a.orders.estimatedOrderValue;
  if (dGuests !== 0 || dValue !== 0) {
    insights.push({
      id: "throughput",
      kind: "throughput",
      text: `B served ${Math.abs(dGuests)} ${dGuests >= 0 ? "more" : "fewer"} guests (${a.guests.served} -> ${b.guests.served}); estimated order value differs by ${dValue >= 0 ? "+" : "-"}${Math.abs(dValue).toFixed(0)} in simulation, not guaranteed revenue.`,
      data: { guestsA: a.guests.served, guestsB: b.guests.served, valueA: a.orders.estimatedOrderValue, valueB: b.orders.estimatedOrderValue },
    });
  }

  for (const w of [a, b].map((m, i) => ({ m, side: i === 0 ? "A" : "B" })).filter(({ m }) => m.parties.stillWaiting > 0 || m.queues.waiterTasks.stillPending > 0)) {
    insights.push({
      id: `warning:backlog:${w.side}`,
      kind: "warning",
      text: `Run ${w.side} ended with ${w.m.parties.stillWaiting} parties still waiting for a table and ${w.m.queues.waiterTasks.stillPending} waiter tasks unstarted; averages exclude them, so real waits are longer.`,
      data: { side: w.side, stillWaiting: w.m.parties.stillWaiting, stillPending: w.m.queues.waiterTasks.stillPending },
    });
  }
  return insights;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
