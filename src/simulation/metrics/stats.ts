import type { Stat } from "../models/types";

export function summarize(samples: readonly number[]): Stat {
  if (samples.length === 0) return { count: 0, sum: 0, mean: null, min: null, max: null, p50: null, p90: null };
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    sum,
    mean: sum / sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  };
}

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** Time-weighted average and max of a piecewise-constant level (queue length, busy slots). */
export class TimeWeightedStat {
  private lastTime = 0;
  private level = 0;
  private area = 0;
  private maxLevel = 0;

  update(time: number, level: number): void {
    this.area += this.level * (time - this.lastTime);
    this.lastTime = time;
    this.level = level;
    if (level > this.maxLevel) this.maxLevel = level;
  }

  get max(): number {
    return this.maxLevel;
  }

  /** Average over [0, now] without mutating state. */
  averageAt(now: number): number | null {
    if (now <= 0) return null;
    return (this.area + this.level * (now - this.lastTime)) / now;
  }

  areaAt(now: number): number {
    return this.area + this.level * (now - this.lastTime);
  }

  reset(): void {
    this.lastTime = 0;
    this.level = 0;
    this.area = 0;
    this.maxLevel = 0;
  }
}

/** Mean over completed plus still-open samples; null when there are none. */
export function meanIncludingOpen(completed: Stat, open: Stat): number | null {
  const count = completed.count + open.count;
  return count === 0 ? null : (completed.sum + open.sum) / count;
}
