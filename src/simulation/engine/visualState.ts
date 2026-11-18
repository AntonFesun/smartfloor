import type { FrameTable, SimulationFrame, TableShape, WaiterTaskType } from "../models/types";

/**
 * Minimal host-agnostic visual state. Field names mirror the unified
 * RestaurantVisualState (mode, tables, zones, waiters, alerts, navigationPaths,
 * timestamp) so the real adapter is a field-by-field mapping.
 */
export interface SimulationVisualState {
  mode: "SIMULATION";
  /** ISO timestamp = options.startEpochMs + simulated seconds. */
  timestamp: string;
  simulatedSeconds: number;
  isSimulated: true;
  tables: {
    id: string;
    number: number;
    zoneId: string;
    x: number;
    y: number;
    capacity: number;
    shape: TableShape;
    status: "available" | "occupied" | "needs_cleaning";
    phase: FrameTable["phase"];
    partySize: number;
    occupancyRatio: number;
  }[];
  zones: { id: string; tableIds: string[]; occupiedTables: number; pendingTasks: number }[];
  waiters: { id: string; zoneId: string; x: number; y: number; state: "idle" | "walking" | "working"; taskType: WaiterTaskType | null; tableId: string | null }[];
  alerts: {
    id: string;
    type: "WAITER_OVERDUE" | "SEATING_QUEUE" | "KITCHEN_BACKLOG";
    severity: "warning" | "critical";
    tableId?: string;
    zoneId?: string;
    station?: string;
    value: number;
  }[];
  navigationPaths: { waiterId: string; points: { x: number; y: number }[] }[];
  queues: SimulationFrame["queues"];
  counters: SimulationFrame["counters"];
}

export interface VisualStateOptions {
  /** Wall-clock epoch (ms) that simulated t = 0 maps to. Default 0. */
  startEpochMs?: number;
}

export function simulationStateToVisualState(frame: SimulationFrame, options: VisualStateOptions = {}): SimulationVisualState {
  const alerts: SimulationVisualState["alerts"] = [];
  for (const t of frame.tables) {
    if (t.waitingForWaiter?.overdue) {
      alerts.push({ id: `overdue:${t.id}`, type: "WAITER_OVERDUE", severity: "warning", tableId: t.id, zoneId: t.zoneId, value: t.waitingForWaiter.waitedSeconds });
    }
  }
  if (frame.queues.seating > 0) alerts.push({ id: "seating-queue", type: "SEATING_QUEUE", severity: "warning", value: frame.queues.seating });
  for (const [station, s] of Object.entries(frame.queues.stations)) {
    if (s.queued > 0) {
      alerts.push({ id: `backlog:${station}`, type: "KITCHEN_BACKLOG", severity: s.queued >= s.capacity * 2 ? "critical" : "warning", station, value: s.queued });
    }
  }
  return {
    mode: "SIMULATION",
    timestamp: new Date((options.startEpochMs ?? 0) + frame.time * 1000).toISOString(),
    simulatedSeconds: frame.time,
    isSimulated: true,
    tables: frame.tables.map((t) => ({
      id: t.id,
      number: t.number,
      zoneId: t.zoneId,
      x: t.x,
      y: t.y,
      capacity: t.capacity,
      shape: t.shape,
      status: t.state === "free" ? "available" : t.state === "occupied" ? "occupied" : "needs_cleaning",
      phase: t.phase,
      partySize: t.partySize,
      occupancyRatio: t.fill,
    })),
    zones: frame.zones.map((z) => ({ ...z, tableIds: frame.tables.filter((t) => t.zoneId === z.id).map((t) => t.id) })),
    waiters: frame.waiters.map((w) => ({ id: w.id, zoneId: w.zoneId, x: w.x, y: w.y, state: w.state, taskType: w.taskType, tableId: w.tableId })),
    alerts,
    navigationPaths: frame.waiters.filter((w) => w.route.length > 1).map((w) => ({ waiterId: w.id, points: w.route })),
    queues: frame.queues,
    counters: frame.counters,
  };
}
