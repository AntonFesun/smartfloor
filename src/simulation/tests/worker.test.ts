import { describe, expect, it } from "vitest";
import { SimulationWorkerController, type WorkerResponse, type WorkerScheduler } from "../index";
import { scenario } from "./helpers";

function harness() {
  const out: WorkerResponse[] = [];
  let wall = 0;
  let tick: (() => void) | null = null;
  const scheduler: WorkerScheduler = {
    now: () => wall,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  const controller = new SimulationWorkerController((m) => out.push(m), scheduler);
  return {
    out,
    controller,
    advanceWall: (ms: number) => {
      wall += ms;
      tick?.();
    },
    isTicking: () => tick !== null,
  };
}

describe("worker controller (the logic behind worker.ts)", () => {
  it("initialises, plays at speed, streams frames and pauses", () => {
    const h = harness();
    const sc = scenario({ seed: 101, duration: "1h", arrivalsPerHour: 30 });
    h.controller.handle({ type: "init", scenario: sc, speed: 60 });
    expect(h.out[0]?.type).toBe("ready");
    h.controller.handle({ type: "play" });
    expect(h.isTicking()).toBe(true);
    h.advanceWall(1000);
    h.advanceWall(1000);
    const frames = h.out.filter((m): m is Extract<WorkerResponse, { type: "frame" }> => m.type === "frame");
    expect(frames).toHaveLength(2);
    expect(frames[1]!.frame.time).toBe(120);
    h.controller.handle({ type: "pause" });
    expect(h.isTicking()).toBe(false);
    expect(h.out[h.out.length - 1]).toEqual({ type: "status", status: "paused", speed: 60 });
  });

  it("completes through ticks and reports final metrics", () => {
    const h = harness();
    h.controller.handle({ type: "init", scenario: scenario({ seed: 102, duration: "1h" }), speed: 300 });
    h.controller.handle({ type: "play" });
    for (let i = 0; i < 30 && h.isTicking(); i++) h.advanceWall(1000);
    const done = h.out.find((m) => m.type === "complete");
    expect(done).toBeDefined();
    expect(h.isTicking()).toBe(false);
    if (done?.type === "complete") expect(done.metrics.completed).toBe(true);
  });

  it("supports step, reset, runToEnd and A/B compare messages", () => {
    const h = harness();
    const sc = scenario({ seed: 103, duration: "1h" });
    h.controller.handle({ type: "init", scenario: sc });
    h.controller.handle({ type: "step", events: 3 });
    expect(h.out.some((m) => m.type === "frame")).toBe(true);
    h.controller.handle({ type: "runToEnd", frameIntervalSeconds: 600 });
    const complete = h.out.find((m): m is Extract<WorkerResponse, { type: "complete" }> => m.type === "complete")!;
    expect(complete.frames.length).toBeGreaterThan(5);
    h.controller.handle({ type: "reset" });
    expect(h.out.filter((m) => m.type === "ready")).toHaveLength(2);
    h.controller.handle({ type: "compare", a: scenario({ seed: 5, waiterCount: 3 }), b: scenario({ seed: 5, waiterCount: 5 }) });
    const cmp = h.out.find((m) => m.type === "comparison");
    expect(cmp).toBeDefined();
  });

  it("returns an error message instead of throwing", () => {
    const h = harness();
    h.controller.handle({ type: "play" });
    expect(h.out[0]).toEqual({ type: "error", message: expect.stringContaining("init") });
    h.controller.handle({ type: "init", scenario: { ...scenario(), seed: "" } });
    expect(h.out[1]?.type).toBe("error");
  });

  it("messages are structured-clone safe", () => {
    const h = harness();
    h.controller.handle({ type: "init", scenario: scenario({ seed: 104, duration: "1h" }) });
    h.controller.handle({ type: "runToEnd", frameIntervalSeconds: 900 });
    for (const m of h.out) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});
