/**
 * Plain data models for the restaurant simulation engine.
 * Everything in this file is JSON-serialisable so scenarios can be saved,
 * loaded and posted to a Web Worker with structured clone.
 *
 * Time convention: all simulated times and durations are in SECONDS.
 * Distances are in layout units; `layoutUnitsPerMeter` converts to metres.
 */

export type TableShape = "round" | "square" | "rectangle" | "oval" | (string & {});

/** Layout input. The real app layout can be mapped onto this 1:1. */
export interface LayoutTable {
  id: string;
  number: number;
  zoneId: string;
  x: number;
  y: number;
  capacity: number;
  shape: TableShape;
}

export const STATION_IDS = ["hot", "cold", "bar"] as const;
export type StationId = (typeof STATION_IDS)[number];

export type Distribution =
  | { kind: "fixed"; value: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "exponential"; mean: number }
  | { kind: "normal"; mean: number; sd: number; min?: number; max?: number }
  | { kind: "lognormal"; mean: number; sd: number; min?: number; max?: number };

export interface MenuItemSpec {
  id: string;
  name: string;
  station: StationId;
  /** Used only for the "estimated order value" metric. */
  price: number;
  /** Relative weight; need not sum to 1. */
  probability: number;
  /** Preparation time in seconds once a station slot is free. */
  prep: Distribution;
}

export interface PartySizeWeight {
  size: number;
  weight: number;
}

export interface SlaThresholds {
  /** Arrival -> seated. */
  seatingWaitSeconds: number;
  /** Waiter task created -> waiter dispatched. */
  waiterResponseSeconds: number;
  /** Order placed -> all items ready. */
  prepSeconds: number;
  /** Order ready -> served. */
  deliverySeconds: number;
}

export type SimulationDurationPreset = "1h" | "4h" | "shift";
export const DURATION_PRESET_SECONDS: Record<SimulationDurationPreset, number> = {
  "1h": 3600,
  "4h": 4 * 3600,
  shift: 8 * 3600,
};

export type WaiterTaskType = "take_order" | "deliver_order" | "clear_table";
export const WAITER_TASK_TYPES: readonly WaiterTaskType[] = ["take_order", "deliver_order", "clear_table"];

export interface TaskDurations {
  takeOrder: Distribution;
  deliverOrder: Distribution;
  clearTable: Distribution;
}

export interface ItemsPerGuest {
  min: number;
  max: number;
}

/** What the integrator passes in. Everything except `seed` and `layout` is optional. */
export interface SimulationScenarioInput {
  name?: string;
  seed: number | string;
  layout: LayoutTable[];
  /** Explicit waiters per zone. Wins over `waiterCount`. */
  waitersPerZone?: Record<string, number>;
  /** Total waiters, distributed over zones proportionally to their table count. */
  waiterCount?: number;
  kitchenCapacity?: number | { hot?: number; cold?: number };
  barCapacity?: number;
  /** Party arrivals per hour (Poisson process). */
  arrivalsPerHour?: number;
  partySizes?: PartySizeWeight[];
  /** Seconds a party spends eating after its first order is served. */
  diningDuration?: Distribution;
  itemsPerGuest?: ItemsPerGuest;
  /** Probability that a party places a second order while dining. */
  repeatOrderProbability?: number;
  menu?: MenuItemSpec[];
  taskDurations?: Partial<TaskDurations>;
  walkingSpeedMetersPerSecond?: number;
  layoutUnitsPerMeter?: number;
  /** Kitchen/bar pass where waiters pick up orders. Defaults to the left edge of the layout. */
  servicePoint?: { x: number; y: number };
  sla?: Partial<SlaThresholds>;
  duration?: SimulationDurationPreset;
  /** Overrides `duration` when provided. */
  durationSeconds?: number;
  /** Max parties waiting for a table. Further arrivals are rejected. */
  maxQueueLength?: number;
  /** Seconds a waiting party tolerates before leaving. */
  guestPatience?: Distribution;
  /** Idle waiters may help in other zones. */
  crossZoneAssistance?: boolean;
}

export interface SimulationWaiterSpec {
  id: string;
  zoneId: string;
  homeX: number;
  homeY: number;
}

/** Fully resolved, validated, JSON-serialisable scenario. */
export interface SimulationScenario {
  schemaVersion: 1;
  /** Deterministic content hash of every field below except `name`. */
  id: string;
  name: string;
  seed: string;
  layout: LayoutTable[];
  zones: string[];
  waiters: SimulationWaiterSpec[];
  stationCapacity: Record<StationId, number>;
  arrivalsPerHour: number;
  partySizes: PartySizeWeight[];
  diningDuration: Distribution;
  itemsPerGuest: ItemsPerGuest;
  repeatOrderProbability: number;
  menu: MenuItemSpec[];
  taskDurations: TaskDurations;
  walkingSpeedMetersPerSecond: number;
  layoutUnitsPerMeter: number;
  servicePoint: { x: number; y: number };
  sla: SlaThresholds;
  durationSeconds: number;
  maxQueueLength: number;
  guestPatience: Distribution;
  crossZoneAssistance: boolean;
}

export type SimulationEventType =
  | "GUEST_ARRIVAL"
  | "PARTY_SEATED"
  | "PARTY_REJECTED"
  | "ORDER_PLACED"
  | "KITCHEN_PREPARATION_STARTED"
  | "KITCHEN_PREPARATION_COMPLETED"
  | "WAITER_TASK_STARTED"
  | "WAITER_TASK_COMPLETED"
  | "ORDER_SERVED"
  | "PARTY_DEPARTED"
  | "TABLE_CLEANED";

/** Simulation log entry. Never shares an id space or storage with the live journal. */
export interface SimulationEvent {
  /** Emission order, strictly increasing. */
  id: number;
  /** Sequence of the queue event whose handling emitted this entry. */
  causeSeq: number;
  time: number;
  type: SimulationEventType;
  partyId?: string;
  tableId?: string;
  waiterId?: string;
  orderId?: string;
  taskId?: string;
  itemId?: string;
  station?: StationId;
  data?: Record<string, number | string | boolean | null>;
}

export type SimulationStatus = "idle" | "running" | "paused" | "completed";

export type TableVisualPhase = "free" | "waiting_for_waiter" | "waiting_for_food" | "dining" | "needs_cleaning";

export interface FrameTable {
  id: string;
  number: number;
  zoneId: string;
  x: number;
  y: number;
  capacity: number;
  shape: TableShape;
  state: "free" | "occupied" | "dirty";
  phase: TableVisualPhase;
  partyId: string | null;
  partySize: number;
  /** partySize / capacity, 0 when free. */
  fill: number;
  waitingForWaiter: { taskType: WaiterTaskType; waitedSeconds: number; overdue: boolean } | null;
}

export interface FrameWaiter {
  id: string;
  zoneId: string;
  x: number;
  y: number;
  state: "idle" | "walking" | "working";
  taskId: string | null;
  taskType: WaiterTaskType | null;
  tableId: string | null;
  /** Remaining polyline (current position first) for navigation path rendering. */
  route: { x: number; y: number }[];
}

export interface FrameStation {
  capacity: number;
  active: number;
  queued: number;
}

export interface SimulationFrame {
  scenarioId: string;
  seed: string;
  /** Simulated seconds since the start of the run. */
  time: number;
  status: SimulationStatus;
  tables: FrameTable[];
  waiters: FrameWaiter[];
  zones: { id: string; occupiedTables: number; pendingTasks: number }[];
  queues: {
    seating: number;
    waiterTasks: number;
    stations: Record<StationId, FrameStation>;
  };
  counters: {
    arrived: number;
    seated: number;
    served: number;
    departed: number;
    rejected: number;
  };
}

export interface Stat {
  count: number;
  sum: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
}

export type BottleneckId = "seating" | "waiters" | StationId;

export interface SimulationMetrics {
  kind: "simulation";
  disclaimer: string;
  scenarioId: string;
  seed: string;
  simulatedSeconds: number;
  completed: boolean;
  parties: {
    arrived: number;
    seated: number;
    served: number;
    departed: number;
    rejected: number;
    rejectedByReason: { no_fitting_table: number; queue_full: number; abandoned: number };
    stillWaiting: number;
  };
  guests: { arrived: number; seated: number; served: number; rejected: number };
  orders: {
    placed: number;
    served: number;
    itemsServed: number;
    /** Sum of menu prices of served orders. Simulation estimate only. */
    estimatedOrderValue: number;
  };
  waits: {
    seating: Stat;
    waiterResponse: Stat;
    waiterResponseByType: Record<WaiterTaskType, Stat>;
    kitchenQueue: Stat;
    cook: Stat;
    /** Order placed -> all items ready (queueing + cooking). */
    prep: Stat;
    /** Order ready -> served. */
    delivery: Stat;
    orderToServe: Stat;
  };
  /**
   * Elapsed waiting time of entities still unserved when the metrics were taken.
   * Completed-only averages in `waits` are biased low when a backlog builds up;
   * combine both with `meanIncludingOpen` for a censoring-aware view.
   */
  open: { seatingWait: Stat; waiterResponse: Stat; kitchenQueue: Stat; prep: Stat; delivery: Stat };
  utilization: {
    waiters: number | null;
    tables: number | null;
    tablesIncludingCleaning: number | null;
    stations: Record<StationId, number | null>;
  };
  waiters: { id: string; zoneId: string; busySeconds: number; utilization: number | null; tasksCompleted: number }[];
  turnover: { departures: number; perTable: number | null; perTablePerHour: number | null };
  queues: {
    seating: { max: number; timeAverage: number | null };
    waiterTasks: { max: number; timeAverage: number | null; stillPending: number };
    stations: Record<StationId, { max: number; timeAverage: number | null; stillQueued: number }>;
  };
  /** Violation counts include completed cases and still-open ones that already exceed the threshold. */
  sla: {
    thresholds: SlaThresholds;
    seatingWait: number;
    waiterResponse: number;
    prep: number;
    delivery: number;
    total: number;
  };
  bottleneck: {
    /** Seconds of queueing delay attributed to each resource, including entities still waiting. */
    delaySeconds: Record<BottleneckId, number>;
    shares: Record<BottleneckId, number> | null;
    primary: BottleneckId | null;
  };
}
