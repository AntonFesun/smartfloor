import type { Thresholds } from "@/types";

type Env = Record<string, string | undefined>;

function readNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readThresholds(env: Env = process.env): Thresholds {
  return {
    waiterMs: readNumber(env, "LONG_WAITER_MS", 3 * 60 * 1000),
    prepMs: readNumber(env, "LONG_PREP_MS", 20 * 60 * 1000),
    readyMs: readNumber(env, "LONG_READY_MS", 8 * 60 * 1000),
    occupancyMs: readNumber(env, "LONG_OCCUPANCY_MS", 90 * 60 * 1000),
  };
}
