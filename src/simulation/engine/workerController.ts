import { runABComparison } from "../metrics/compare";
import {
  createSimulation,
  getSimulationMetrics,
  pauseSimulation,
  resetSimulation,
  resumeSimulation,
  runSimulation,
  setSimulationSpeed,
  stepSimulation,
  tickSimulation,
} from "./api";
import type { Simulation } from "./simulation";
import { createSimulationScenario, scenarioToInput } from "../scenarios/createScenario";
import type { SimulationScenario } from "../models/types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

export interface WorkerScheduler {
  /** Wall clock in ms. */
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface TimerGlobals {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const timers = globalThis as unknown as TimerGlobals;

export const defaultScheduler: WorkerScheduler = {
  now: () => Date.now(),
  setInterval: (fn, ms) => timers.setInterval(fn, ms),
  clearInterval: (h) => timers.clearInterval(h),
};

const TICK_MS = 50;

/**
 * Message-driven wrapper around one simulation. It is the only place that
 * touches timers: the pacing loop calls `tickSimulation` with real elapsed time,
 * and the engine itself stays purely event-driven. Testable without a Worker.
 */
export class SimulationWorkerController {
  private sim: Simulation | null = null;
  private timer: unknown = null;
  private lastWall = 0;

  constructor(
    private readonly post: (message: WorkerResponse) => void,
    private readonly scheduler: WorkerScheduler = defaultScheduler,
  ) {}

  handle(request: WorkerRequest): void {
    try {
      this.dispatch(request);
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.stopTimer();
  }

  private requireSim(): Simulation {
    if (!this.sim) throw new Error("Simulation not initialised; send an init message first");
    return this.sim;
  }

  private dispatch(request: WorkerRequest): void {
    switch (request.type) {
      case "init": {
        this.stopTimer();
        this.sim = createSimulation(request.scenario, { recordEvents: false });
        if (request.speed !== undefined) setSimulationSpeed(this.sim, request.speed);
        this.post({ type: "ready", scenario: this.sim.scenario, frame: this.sim.getFrame() });
        this.postStatus();
        return;
      }
      case "play": {
        const sim = this.requireSim();
        resumeSimulation(sim);
        this.startTimer();
        this.postStatus();
        return;
      }
      case "pause": {
        pauseSimulation(this.requireSim());
        this.stopTimer();
        this.postStatus();
        return;
      }
      case "step": {
        const sim = this.requireSim();
        const result = stepSimulation(sim, { events: request.events ?? 1 });
        this.post({ type: "frame", frame: result.frame, events: result.events });
        if (result.done) this.finishRun();
        return;
      }
      case "reset": {
        const sim = this.requireSim();
        this.stopTimer();
        resetSimulation(sim, { ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(request.scenario ? { scenario: request.scenario } : {}) });
        this.post({ type: "ready", scenario: sim.scenario, frame: sim.getFrame() });
        this.postStatus();
        return;
      }
      case "setSpeed": {
        const sim = this.requireSim();
        setSimulationSpeed(sim, request.speed);
        this.postStatus();
        return;
      }
      case "getMetrics": {
        this.post({ type: "metrics", metrics: getSimulationMetrics(this.requireSim()) });
        return;
      }
      case "runToEnd": {
        const sim = this.requireSim();
        this.stopTimer();
        const result = runSimulation(sim, { ...(request.frameIntervalSeconds ? { frameIntervalSeconds: request.frameIntervalSeconds } : {}) });
        this.post({ type: "complete", metrics: result.metrics, frames: result.frames, eventChecksum: result.eventChecksum });
        this.postStatus();
        return;
      }
      case "compare": {
        const a: SimulationScenario = createSimulationScenario(scenarioToInput(request.a));
        const b: SimulationScenario = createSimulationScenario(scenarioToInput(request.b));
        const result = runABComparison(a, b);
        this.post({ type: "comparison", a: result.a.metrics, b: result.b.metrics, comparison: result.comparison });
        return;
      }
    }
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.lastWall = this.scheduler.now();
    this.timer = this.scheduler.setInterval(() => this.onTick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
  }

  private onTick(): void {
    const sim = this.sim;
    if (!sim) return;
    const wall = this.scheduler.now();
    const delta = wall - this.lastWall;
    this.lastWall = wall;
    const result = tickSimulation(sim, delta);
    this.post({ type: "frame", frame: result.frame, events: result.events });
    if (result.done) this.finishRun();
  }

  private finishRun(): void {
    this.stopTimer();
    const sim = this.requireSim();
    this.post({ type: "complete", metrics: getSimulationMetrics(sim), frames: [], eventChecksum: "" });
    this.postStatus();
  }

  private postStatus(): void {
    const sim = this.requireSim();
    this.post({ type: "status", status: sim.status, speed: sim.clock.speed });
  }
}
