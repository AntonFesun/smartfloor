import type { Distribution, PartySizeWeight } from "../models/types";

/** Anything that yields uniform numbers in [0, 1). Inject your own for tests. */
export interface Rng {
  next(): number;
}

/** Builds an independent deterministic stream for a seed or a derived label. */
export type RngFactory = (seed: string | number) => Rng;

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** SFC32 seeded through a string hash. Identical on every JS engine. */
export const createSeededRng: RngFactory = (seed) => {
  const hash = xmur3(String(seed));
  let a = hash();
  let b = hash();
  let c = hash();
  let d = hash();
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return { next };
};

export function sampleDistribution(dist: Distribution, rng: Rng): number {
  switch (dist.kind) {
    case "fixed":
      return dist.value;
    case "uniform":
      return dist.min + (dist.max - dist.min) * rng.next();
    case "triangular": {
      const { min, mode, max } = dist;
      const u = rng.next();
      if (max === min) return min;
      const f = (mode - min) / (max - min);
      return u < f ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    case "exponential":
      return -dist.mean * Math.log(1 - rng.next());
    case "normal":
      return clamp(dist.mean + dist.sd * standardNormal(rng), dist.min ?? 0, dist.max ?? Number.POSITIVE_INFINITY);
    case "lognormal": {
      const sigma2 = Math.log(1 + (dist.sd * dist.sd) / (dist.mean * dist.mean));
      const mu = Math.log(dist.mean) - sigma2 / 2;
      return clamp(Math.exp(mu + Math.sqrt(sigma2) * standardNormal(rng)), dist.min ?? 0, dist.max ?? Number.POSITIVE_INFINITY);
    }
  }
}

/** Always consumes exactly two uniforms so stream positions stay predictable. */
function standardNormal(rng: Rng): number {
  const u1 = 1 - rng.next();
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One uniform draw, weights need not be normalised. */
export function pickWeighted<T>(items: readonly T[], weightOf: (item: T) => number, rng: Rng): T {
  let total = 0;
  for (const item of items) total += weightOf(item);
  let threshold = rng.next() * total;
  for (const item of items) {
    threshold -= weightOf(item);
    if (threshold < 0) return item;
  }
  return items[items.length - 1] as T;
}

export function sampleInt(min: number, max: number, rng: Rng): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

export function samplePartySize(sizes: readonly PartySizeWeight[], rng: Rng): number {
  return pickWeighted(sizes, (s) => s.weight, rng).size;
}

export function validateDistribution(dist: Distribution, label: string, issues: string[]): void {
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  switch (dist.kind) {
    case "fixed":
      if (!finite(dist.value) || dist.value < 0) issues.push(`${label}: fixed value must be >= 0`);
      return;
    case "uniform":
      if (!finite(dist.min) || !finite(dist.max) || dist.min < 0 || dist.max < dist.min) issues.push(`${label}: uniform needs 0 <= min <= max`);
      return;
    case "triangular":
      if (![dist.min, dist.mode, dist.max].every(finite) || dist.min < 0 || dist.mode < dist.min || dist.max < dist.mode)
        issues.push(`${label}: triangular needs 0 <= min <= mode <= max`);
      return;
    case "exponential":
      if (!finite(dist.mean) || dist.mean <= 0) issues.push(`${label}: exponential mean must be > 0`);
      return;
    case "normal":
      if (!finite(dist.mean) || !finite(dist.sd) || dist.sd < 0) issues.push(`${label}: normal needs finite mean and sd >= 0`);
      return;
    case "lognormal":
      if (!finite(dist.mean) || dist.mean <= 0 || !finite(dist.sd) || dist.sd < 0) issues.push(`${label}: lognormal needs mean > 0 and sd >= 0`);
      return;
    default:
      issues.push(`${label}: unknown distribution kind`);
  }
}
