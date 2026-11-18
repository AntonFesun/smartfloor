import { describe, expect, it } from "vitest";
import { compareMetricValues, compareSimulationMetrics, demandSignature, runABComparison, runSimulation } from "../index";
import { scenario } from "./helpers";

describe("A/B comparison", () => {
  const heavy = { seed: 71, arrivalsPerHour: 30 } as const;

  it("3 versus 5 waiters with the same seed: more staff cuts waiter response", () => {
    const a = scenario({ ...heavy, waiterCount: 3 });
    const b = scenario({ ...heavy, waiterCount: 5 });
    const result = runABComparison(a, b);
    const { comparison } = result;

    expect(a.waiters).toHaveLength(3);
    expect(b.waiters).toHaveLength(5);
    expect(comparison.demandIdentical).toBe(true);
    expect(comparison.warnings).toEqual([]);
    expect(demandSignature(a)).toBe(demandSignature(b));

    const row = comparison.rows.find((r) => r.key === "avgWaiterResponse")!;
    expect(row.a).toBe(result.a.metrics.waits.waiterResponse.mean);
    expect(row.b).toBe(result.b.metrics.waits.waiterResponse.mean);
    expect(row.b!).toBeLessThan(row.a!);
    expect(row.diff).toBeCloseTo(row.b! - row.a!, 10);
    expect(row.percentDiff).toBeCloseTo(((row.b! - row.a!) / row.a!) * 100, 10);
    expect(row.verdict).toBe("better");
    expect(result.b.metrics.utilization.waiters!).toBeLessThan(result.a.metrics.utilization.waiters!);
  });

  it("insights are computed from the results, not hardcoded", () => {
    const a = scenario({ ...heavy, waiterCount: 3 });
    const b5 = runABComparison(a, scenario({ ...heavy, waiterCount: 5 }));
    const b8 = runABComparison(a, scenario({ ...heavy, waiterCount: 8 }));

    const cap5 = b5.comparison.insights.find((i) => i.id === "capacity:waiters")!;
    const cap8 = b8.comparison.insights.find((i) => i.id === "capacity:waiters")!;
    expect(cap5).toBeDefined();
    expect(cap5.data.responseA).toBe(b5.a.metrics.waits.waiterResponse.mean);
    expect(cap5.data.responseB).toBe(b5.b.metrics.waits.waiterResponse.mean);
    expect(cap5.data.waitersB).toBe(5);
    expect(cap8.data.waitersB).toBe(8);
    expect(cap5.text).not.toBe(cap8.text);
    expect(cap5.text).toContain("3 to 5 waiters");

    const improvement = b5.comparison.insights.find((i) => i.id === "improvement:avgWaiterResponse");
    expect(improvement).toBeDefined();
    const pct = Math.abs(improvement!.data.percentDiff as number).toFixed(0);
    expect(improvement!.text).toContain(`${pct}%`);

    const same = runABComparison(a, a);
    expect(same.comparison.insights.some((i) => i.kind === "improvement" || i.kind === "regression")).toBe(false);
    expect(same.comparison.rows.every((r) => r.diff === 0 || r.diff === null)).toBe(true);
  });

  it("percent difference is null (N/A) when the baseline is zero; missing values are n/a", () => {
    expect(compareMetricValues(0, 5, "lower_is_better")).toEqual({ diff: 5, percentDiff: null, verdict: "worse" });
    expect(compareMetricValues(null, 5, "lower_is_better")).toEqual({ diff: null, percentDiff: null, verdict: "n/a" });
    expect(compareMetricValues(10, 5, "higher_is_better")).toEqual({ diff: -5, percentDiff: -50, verdict: "worse" });
    expect(compareMetricValues(10, 5, "neutral").verdict).toBe("same");
    expect(compareMetricValues(4, 4, "lower_is_better").verdict).toBe("same");
  });

  it("warns when seeds or demand differ", () => {
    const a = scenario({ seed: 1, arrivalsPerHour: 20 });
    const diffSeed = scenario({ seed: 2, arrivalsPerHour: 20 });
    const diffDemand = scenario({ seed: 1, arrivalsPerHour: 40 });
    const m = (s: typeof a) => runSimulation(s, { recordEvents: false }).metrics;
    const seedCmp = compareSimulationMetrics(m(a), m(diffSeed), { scenarioA: a, scenarioB: diffSeed });
    expect(seedCmp.demandIdentical).toBe(false);
    expect(seedCmp.warnings[0]).toMatch(/Seeds differ/);
    const demandCmp = compareSimulationMetrics(m(a), m(diffDemand), { scenarioA: a, scenarioB: diffDemand });
    expect(demandCmp.demandIdentical).toBe(false);
    expect(demandCmp.warnings.join(" ")).toMatch(/Demand parameters differ/);
  });
});
