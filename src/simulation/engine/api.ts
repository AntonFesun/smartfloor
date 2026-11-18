import type { SimulationEvent, SimulationFrame, SimulationMetrics, SimulationScenario, SimulationScenarioInput, SimulationStatus } from "../models/types";
import { createSimulationScenario, loadScenario, withOverrides } from "../scenarios/createScenario";
import { hashString, stableStringify } from "./hash";
import { Simulation, type SimulationOptions } from "./simulation";

export { createSimulationScenario };

export interface RunOptions extends SimulationOptions {
  /** Capture a frame every N simulated seconds (plus the final one). Omit for headless runs. */
  frameIntervalSeconds?: number;
}

export interface SimulationRunResult {
  metrics: SimulationMetrics;
  events: SimulationEvent[];
  frames: SimulationFrame[];
  /** Checksum of the emitted event log; equal checksums mean identical runs. */
  eventChecksum: string;
  simulation: Simulation;
}

export interface StepOptions {
  /** Number of queue events to process. Default 1. */
  events?: number;
  /** Alternatively, process everything up to this simulated time. */
  untilTime?: number;
  /** Alternatively, advance by this many simulated seconds. */
  advanceSeconds?: number;
}

export interface StepResult {
  /** Queue events processed by this call. */
  processed: number;
  events: SimulationEvent[];
  time: number;
  status: SimulationStatus;
  done: boolean;
  frame: SimulationFrame;
}

export interface TickResult {
  advanced: boolean;
  events: SimulationEvent[];
  frame: SimulationFrame;
  done: boolean;
}

/** Creates a runnable simulation handle from a scenario (revalidated) or raw input. */
export function createSimulation(scenario: SimulationScenario | SimulationScenarioInput, options?: SimulationOptions): Simulation {
  const resolved = isScenario(scenario) ? loadScenario(scenario) : createSimulationScenario(scenario);
  return new Simulation(resolved, options);
}

function isScenario(value: SimulationScenario | SimulationScenarioInput): value is SimulationScenario {
  return (value as SimulationScenario).schemaVersion === 1 && typeof (value as SimulationScenario).id === "string";
}

/** Runs to the end of the scenario horizon. Accepts a fresh scenario or an existing (possibly partly run) handle. */
export function runSimulation(target: SimulationScenario | Simulation, options: RunOptions = {}): SimulationRunResult {
  const simulation = target instanceof Simulation ? target : new Simulation(target, options);
  const frames: SimulationFrame[] = [];
  const interval = options.frameIntervalSeconds;
  const horizon = simulation.scenario.durationSeconds;
  if (interval !== undefined && interval > 0) {
    let nextFrame = Math.ceil(simulation.now / interval) * interval;
    for (;;) {
      const nextEvent = simulation.peekNextTime();
      const limit = nextEvent === null ? horizon : Math.min(nextEvent, horizon);
      while (nextFrame < limit || (nextEvent === null && nextFrame <= horizon)) {
        frames.push(simulation.getFrame(nextFrame));
        nextFrame += interval;
      }
      if (nextEvent === null) break;
      simulation.step();
    }
    simulation.runToEnd();
    if (frames.length === 0 || (frames[frames.length - 1] as SimulationFrame).time !== horizon) frames.push(simulation.getFrame(horizon));
  } else {
    simulation.runToEnd();
  }
  return {
    metrics: simulation.getMetrics(),
    events: simulation.events,
    frames,
    eventChecksum: eventLogChecksum(simulation.events),
    simulation,
  };
}

/** Manual stepping. Works while paused; a completed run is a no-op. */
export function stepSimulation(simulation: Simulation, options: StepOptions = {}): StepResult {
  const events: SimulationEvent[] = [];
  const before = simulation.processedCount;
  if (options.untilTime !== undefined) {
    simulation.advanceTo(options.untilTime, events);
  } else if (options.advanceSeconds !== undefined) {
    simulation.advanceTo(simulation.now + options.advanceSeconds, events);
  } else {
    const n = Math.max(1, Math.floor(options.events ?? 1));
    for (let i = 0; i < n; i++) {
      const out = simulation.step();
      events.push(...out.events);
      if (!out.advanced) break;
    }
  }
  return {
    processed: simulation.processedCount - before,
    events,
    time: simulation.now,
    status: simulation.status,
    done: simulation.isComplete,
    frame: simulation.getFrame(),
  };
}

export function pauseSimulation(simulation: Simulation): SimulationStatus {
  if (simulation.status === "running" || simulation.status === "idle") simulation.status = "paused";
  return simulation.status;
}

/** Starts or continues real-time playback driven by `tickSimulation`. */
export function resumeSimulation(simulation: Simulation): SimulationStatus {
  if (simulation.status === "paused" || simulation.status === "idle") simulation.status = "running";
  return simulation.status;
}

/** Back to t = 0, status idle. Optionally swap the seed or the whole scenario. */
export function resetSimulation(simulation: Simulation, overrides: { seed?: number | string; scenario?: SimulationScenario } = {}): Simulation {
  let scenario = overrides.scenario ?? simulation.scenario;
  if (overrides.seed !== undefined) scenario = withOverrides(scenario, { seed: overrides.seed });
  simulation.reset(scenario);
  return simulation;
}

export function getSimulationMetrics(simulation: Simulation): SimulationMetrics {
  return simulation.getMetrics();
}

export function getSimulationFrame(simulation: Simulation): SimulationFrame {
  return simulation.getFrame();
}

export function setSimulationSpeed(simulation: Simulation, speed: number): void {
  simulation.clock.setSpeed(speed);
}

/**
 * Real-time driver step: advances the virtual clock by `realDeltaMs` of wall time
 * times the current speed. Does nothing unless the simulation is running.
 */
export function tickSimulation(simulation: Simulation, realDeltaMs: number): TickResult {
  if (simulation.status !== "running") return { advanced: false, events: [], frame: simulation.getFrame(), done: simulation.isComplete };
  const events: SimulationEvent[] = [];
  const target = simulation.now + simulation.clock.realToSimulated(realDeltaMs);
  simulation.advanceTo(target, events);
  return { advanced: true, events, frame: simulation.getFrame(), done: simulation.isComplete };
}

export function eventLogChecksum(events: readonly SimulationEvent[]): string {
  return hashString(stableStringify(events));
}
