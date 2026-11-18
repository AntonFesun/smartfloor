import type { ABComparison } from "../metrics/compare";
import type { SimulationEvent, SimulationFrame, SimulationMetrics, SimulationScenario, SimulationScenarioInput, SimulationStatus } from "../models/types";

export type WorkerRequest =
  | { type: "init"; scenario: SimulationScenario | SimulationScenarioInput; speed?: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "step"; events?: number }
  | { type: "reset"; seed?: number | string; scenario?: SimulationScenario }
  | { type: "setSpeed"; speed: number }
  | { type: "getMetrics" }
  | { type: "runToEnd"; frameIntervalSeconds?: number }
  | { type: "compare"; a: SimulationScenario; b: SimulationScenario };

export type WorkerResponse =
  | { type: "ready"; scenario: SimulationScenario; frame: SimulationFrame }
  | { type: "frame"; frame: SimulationFrame; events: SimulationEvent[] }
  | { type: "status"; status: SimulationStatus; speed: number }
  | { type: "metrics"; metrics: SimulationMetrics }
  | { type: "complete"; metrics: SimulationMetrics; frames: SimulationFrame[]; eventChecksum: string }
  | { type: "comparison"; a: SimulationMetrics; b: SimulationMetrics; comparison: ABComparison }
  | { type: "error"; message: string };
