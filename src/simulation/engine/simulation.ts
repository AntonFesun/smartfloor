import { MetricsCollector, type RejectReason } from "../metrics/collector";
import { TimeWeightedStat } from "../metrics/stats";
import {
  STATION_IDS,
  type FrameStation,
  type FrameTable,
  type FrameWaiter,
  type SimulationEvent,
  type SimulationEventType,
  type SimulationFrame,
  type SimulationMetrics,
  type SimulationScenario,
  type SimulationStatus,
  type StationId,
  type WaiterTaskType,
} from "../models/types";
import { StationPool, type ItemRun } from "../resources/stationPool";
import { TablePool } from "../resources/tablePool";
import { WaiterPool, distance, type Leg, type Point, type WaiterRuntime } from "../resources/waiterPool";
import { EventQueue } from "../scheduling/eventQueue";
import { TaskQueue, type WaiterTask } from "../scheduling/taskQueue";
import { VirtualClock } from "./clock";
import { createSeededRng, pickWeighted, sampleDistribution, sampleInt, samplePartySize, type Rng, type RngFactory } from "./random";

type InternalEvent =
  | { kind: "arrival"; index: number }
  | { kind: "patience"; partyId: string }
  | { kind: "taskDone"; taskId: string }
  | { kind: "prepDone"; itemId: string }
  | { kind: "depart"; partyId: string }
  | { kind: "repeatOrder"; partyId: string };

type EventData = NonNullable<SimulationEvent["data"]>;

interface Party {
  id: string;
  size: number;
  arrivalTime: number;
  patienceSeconds: number;
  diningSeconds: number;
  rng: Rng;
  state: "waiting" | "seated" | "departed" | "rejected";
  tableId: string | null;
  inFlight: number;
  awaiting: "waiter" | "food" | null;
  departDeferred: boolean;
  firstServed: boolean;
}

interface Order {
  id: string;
  partyId: string;
  tableId: string;
  placedAt: number;
  items: ItemRun[];
  remaining: number;
  readyAt: number | null;
  servedAt: number | null;
  value: number;
}

export interface SimulationOptions {
  /** Inject a different PRNG family. Defaults to a seeded SFC32 stream. */
  rng?: RngFactory;
  /** Keep the full emitted event log in memory. Default true. */
  recordEvents?: boolean;
  /** Keep a trace of every queue pop (time, seq, kind). Default false. */
  recordTrace?: boolean;
  /** Hard cap for run loops, protects against runaway scenarios. Default 5,000,000. */
  maxEvents?: number;
}

export interface QueueTraceEntry {
  time: number;
  seq: number;
  kind: InternalEvent["kind"];
}

export interface StepOutcome {
  /** False when the run is complete and nothing was processed. */
  advanced: boolean;
  /** Log entries emitted while handling the processed queue event. */
  events: SimulationEvent[];
}

const PRIORITY: Record<WaiterTaskType, number> = { deliver_order: 0, take_order: 1, clear_table: 2 };
const EAT_TAIL_FRACTION = 0.25;
const REPEAT_ORDER_FRACTION = 0.5;

/**
 * The discrete-event core. Mutable and single-threaded by design; the functional
 * API in `api.ts` is a thin wrapper. Contains no timers and never reads wall time.
 */
export class Simulation {
  scenario: SimulationScenario;
  readonly clock = new VirtualClock();
  status: SimulationStatus = "idle";
  readonly options: Required<Pick<SimulationOptions, "recordEvents" | "recordTrace" | "maxEvents">> & { rng: RngFactory };

  events: SimulationEvent[] = [];
  trace: QueueTraceEntry[] = [];
  processedCount = 0;

  private queue = new EventQueue<InternalEvent>();
  private tables!: TablePool;
  private waiters!: WaiterPool;
  private stations!: Record<StationId, StationPool>;
  private taskQueue = new TaskQueue();
  private collector!: MetricsCollector;
  private seatingQueueStat = new TimeWeightedStat();
  private taskQueueStat = new TimeWeightedStat();
  private arrivalRng!: Rng;

  private parties = new Map<string, Party>();
  private waiting: Party[] = [];
  private tasks = new Map<string, WaiterTask>();
  private orders = new Map<string, Order>();
  private items = new Map<string, ItemRun>();

  private nextEventId = 1;
  private partySeq = 0;
  private taskSeq = 0;
  private orderSeq = 0;
  private itemSeq = 0;
  private currentSeq = 0;
  private emitted: SimulationEvent[] = [];
  private finished = false;

  constructor(scenario: SimulationScenario, options: SimulationOptions = {}) {
    this.scenario = scenario;
    this.options = {
      rng: options.rng ?? createSeededRng,
      recordEvents: options.recordEvents ?? true,
      recordTrace: options.recordTrace ?? false,
      maxEvents: options.maxEvents ?? 5_000_000,
    };
    this.initialize();
  }

  /** Back to t = 0 with the same (or a replacement) scenario. Speed is kept. */
  reset(scenario: SimulationScenario = this.scenario): void {
    this.scenario = scenario;
    this.initialize();
  }

  get now(): number {
    return this.clock.now;
  }

  get isComplete(): boolean {
    return this.finished;
  }

  /** Processes exactly one queue event (and everything it causes at that instant). */
  step(): StepOutcome {
    if (this.finished) return { advanced: false, events: [] };
    const next = this.queue.peek();
    if (!next || next.time > this.scenario.durationSeconds) {
      this.finish();
      return { advanced: false, events: [] };
    }
    this.queue.pop();
    this.emitted = [];
    this.clock.advanceTo(next.time);
    this.currentSeq = next.seq;
    this.processedCount++;
    if (this.options.recordTrace) this.trace.push({ time: next.time, seq: next.seq, kind: next.payload.kind });
    this.handle(next.payload);
    return { advanced: true, events: this.emitted };
  }

  /** Time of the next queue event, or null when none remains inside the horizon. */
  peekNextTime(): number | null {
    if (this.finished) return null;
    const next = this.queue.peek();
    if (!next || next.time > this.scenario.durationSeconds) return null;
    return next.time;
  }

  /** Processes all events with time <= `time`, then moves the clock to `time`. */
  advanceTo(time: number, collect?: SimulationEvent[]): void {
    const target = Math.min(time, this.scenario.durationSeconds);
    let guard = 0;
    for (;;) {
      const t = this.peekNextTime();
      if (t === null || t > target) break;
      const out = this.step();
      if (collect) collect.push(...out.events);
      if (++guard > this.options.maxEvents) throw new Error(`Simulation exceeded maxEvents (${this.options.maxEvents})`);
    }
    if (this.peekNextTime() === null && target >= this.scenario.durationSeconds) this.finish();
    else if (target > this.clock.now) this.clock.advanceTo(target);
  }

  runToEnd(): void {
    this.advanceTo(this.scenario.durationSeconds);
  }

  getMetrics(): SimulationMetrics {
    const now = this.clock.now;
    const pendingTaskCreatedAt = this.taskQueue.list().map((t) => t.createdAt);
    return this.collector.build({
      now,
      completed: this.finished,
      scenario: this.scenario,
      tables: this.tables,
      waiters: this.waiters,
      stations: this.stations,
      seatingQueueStat: this.seatingQueueStat,
      taskQueueStat: this.taskQueueStat,
      waitingPartyArrivals: this.waiting.map((p) => p.arrivalTime),
      pendingTaskCreatedAt,
      openOrderPlacedAt: [...this.orders.values()].filter((o) => o.readyAt === null).map((o) => o.placedAt),
      openDeliveryReadyAt: [...this.orders.values()].filter((o) => o.readyAt !== null && o.servedAt === null).map((o) => o.readyAt as number),
    });
  }

  /** Visual snapshot. Waiter positions are interpolated to `atTime` (defaults to the clock). */
  getFrame(atTime: number = this.clock.now): SimulationFrame {
    const sla = this.scenario.sla;
    const pendingByTable = new Map<string, WaiterTask>();
    for (const task of this.taskQueue.list()) if (!pendingByTable.has(task.tableId)) pendingByTable.set(task.tableId, task);
    const pendingByZone = new Map<string, number>();
    for (const task of this.taskQueue.list()) pendingByZone.set(task.zoneId, (pendingByZone.get(task.zoneId) ?? 0) + 1);

    const tables: FrameTable[] = this.tables.all().map((t) => {
      const party = t.partyId ? this.parties.get(t.partyId) : undefined;
      const pending = pendingByTable.get(t.spec.id);
      const waited = pending ? Math.max(0, atTime - pending.createdAt) : 0;
      let phase: FrameTable["phase"] = "free";
      if (t.state === "dirty") phase = "needs_cleaning";
      else if (t.state === "occupied") {
        phase = party?.awaiting === "waiter" ? "waiting_for_waiter" : party?.awaiting === "food" ? "waiting_for_food" : "dining";
      }
      return {
        id: t.spec.id,
        number: t.spec.number,
        zoneId: t.spec.zoneId,
        x: t.spec.x,
        y: t.spec.y,
        capacity: t.spec.capacity,
        shape: t.spec.shape,
        state: t.state,
        phase,
        partyId: t.partyId,
        partySize: t.partySize,
        fill: t.state === "occupied" ? t.partySize / t.spec.capacity : 0,
        waitingForWaiter: pending ? { taskType: pending.type, waitedSeconds: waited, overdue: waited > sla.waiterResponseSeconds } : null,
      };
    });

    const waiters: FrameWaiter[] = this.waiters.all().map((w) => {
      const position = this.waiters.positionAt(w, atTime);
      let state: FrameWaiter["state"] = "idle";
      if (w.busy) state = atTime < w.walkEndsAt ? "walking" : "working";
      return {
        id: w.spec.id,
        zoneId: w.spec.zoneId,
        x: position.x,
        y: position.y,
        state,
        taskId: w.taskId,
        taskType: w.taskType,
        tableId: w.tableId,
        route: this.routeOf(w, position, atTime),
      };
    });

    const stations = {} as Record<StationId, FrameStation>;
    for (const id of STATION_IDS) {
      const s = this.stations[id];
      stations[id] = { capacity: s.capacity, active: s.activeCount, queued: s.queued };
    }

    return {
      scenarioId: this.scenario.id,
      seed: this.scenario.seed,
      time: atTime,
      status: this.status,
      tables,
      waiters,
      zones: this.scenario.zones.map((id) => ({ id, occupiedTables: this.tables.occupiedInZone(id), pendingTasks: pendingByZone.get(id) ?? 0 })),
      queues: { seating: this.waiting.length, waiterTasks: this.taskQueue.size, stations },
      counters: this.collector.counters(),
    };
  }

  private routeOf(w: WaiterRuntime, position: Point, atTime: number): Point[] {
    if (!w.busy) return [];
    const route: Point[] = [position];
    for (const leg of w.legs) if (atTime < leg.t1) route.push({ ...leg.to });
    return route.length > 1 ? route : [];
  }

  private initialize(): void {
    const s = this.scenario;
    this.clock.reset();
    this.status = "idle";
    this.finished = false;
    this.queue = new EventQueue<InternalEvent>();
    this.tables = new TablePool(s.layout);
    this.waiters = new WaiterPool(s.waiters);
    this.stations = {
      hot: new StationPool("hot", s.stationCapacity.hot),
      cold: new StationPool("cold", s.stationCapacity.cold),
      bar: new StationPool("bar", s.stationCapacity.bar),
    };
    this.taskQueue = new TaskQueue();
    this.collector = new MetricsCollector(s);
    this.seatingQueueStat = new TimeWeightedStat();
    this.taskQueueStat = new TimeWeightedStat();
    this.parties.clear();
    this.waiting = [];
    this.tasks.clear();
    this.orders.clear();
    this.items.clear();
    this.events = [];
    this.trace = [];
    this.processedCount = 0;
    this.nextEventId = 1;
    this.partySeq = 0;
    this.taskSeq = 0;
    this.orderSeq = 0;
    this.itemSeq = 0;
    this.currentSeq = 0;
    this.emitted = [];
    this.arrivalRng = this.options.rng(`${s.seed}|arrivals`);
    this.scheduleArrival(0, 0);
  }

  private finish(): void {
    if (this.finished) return;
    this.clock.advanceTo(this.scenario.durationSeconds);
    this.finished = true;
    this.status = "completed";
  }

  private scheduleArrival(index: number, after: number): void {
    const rate = this.scenario.arrivalsPerHour;
    if (rate <= 0) return;
    const gap = (-Math.log(1 - this.arrivalRng.next()) * 3600) / rate;
    const time = after + gap;
    if (time <= this.scenario.durationSeconds) this.queue.schedule(time, { kind: "arrival", index });
  }

  private emit(type: SimulationEventType, fields: Partial<Omit<SimulationEvent, "id" | "causeSeq" | "time" | "type">> = {}): void {
    const event: SimulationEvent = { id: this.nextEventId++, causeSeq: this.currentSeq, time: this.clock.now, type, ...fields };
    this.emitted.push(event);
    if (this.options.recordEvents) this.events.push(event);
  }

  private handle(ev: InternalEvent): void {
    switch (ev.kind) {
      case "arrival":
        return this.onArrival(ev.index);
      case "patience":
        return this.onPatience(ev.partyId);
      case "taskDone":
        return this.onTaskDone(ev.taskId);
      case "prepDone":
        return this.onPrepDone(ev.itemId);
      case "depart":
        return this.onDepartureDue(ev.partyId);
      case "repeatOrder":
        return this.onRepeatOrder(ev.partyId);
    }
  }

  private onArrival(index: number): void {
    const now = this.clock.now;
    const s = this.scenario;
    const rng = this.options.rng(`${s.seed}|party|${index}`);
    const party: Party = {
      id: `P${++this.partySeq}`,
      size: samplePartySize(s.partySizes, rng),
      arrivalTime: now,
      patienceSeconds: sampleDistribution(s.guestPatience, rng),
      diningSeconds: sampleDistribution(s.diningDuration, rng),
      rng,
      state: "waiting",
      tableId: null,
      inFlight: 0,
      awaiting: null,
      departDeferred: false,
      firstServed: false,
    };
    this.parties.set(party.id, party);
    this.collector.onArrival(party.size);
    this.emit("GUEST_ARRIVAL", { partyId: party.id, data: { size: party.size } });
    this.scheduleArrival(index + 1, now);

    if (party.size > this.tables.maxCapacity) {
      this.reject(party, "no_fitting_table");
      return;
    }
    const table = this.tables.pickBest(party.size);
    if (table) {
      this.seat(party, table.spec.id);
    } else if (this.waiting.length >= s.maxQueueLength) {
      this.reject(party, "queue_full");
    } else {
      this.waiting.push(party);
      this.seatingQueueStat.update(now, this.waiting.length);
      this.queue.schedule(now + party.patienceSeconds, { kind: "patience", partyId: party.id });
    }
    this.dispatch();
  }

  private onPatience(partyId: string): void {
    const party = this.parties.get(partyId);
    if (!party || party.state !== "waiting") return;
    this.removeWaiting(party);
    this.reject(party, "abandoned");
  }

  private removeWaiting(party: Party): void {
    const i = this.waiting.indexOf(party);
    if (i >= 0) this.waiting.splice(i, 1);
    this.seatingQueueStat.update(this.clock.now, this.waiting.length);
  }

  private reject(party: Party, reason: RejectReason): void {
    party.state = "rejected";
    this.collector.onRejected(party.size, reason);
    this.emit("PARTY_REJECTED", { partyId: party.id, data: { reason, size: party.size } });
  }

  private seat(party: Party, tableId: string): void {
    const now = this.clock.now;
    this.tables.seat(tableId, party.id, party.size, now);
    party.state = "seated";
    party.tableId = tableId;
    const wait = now - party.arrivalTime;
    this.collector.onSeated(party.size, wait);
    this.emit("PARTY_SEATED", { partyId: party.id, tableId, data: { size: party.size, waitSeconds: wait } });
    this.createTask("take_order", party, null);
  }

  private seatWaiting(): void {
    let i = 0;
    while (i < this.waiting.length) {
      const party = this.waiting[i] as Party;
      const table = this.tables.pickBest(party.size);
      if (!table) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.seatingQueueStat.update(this.clock.now, this.waiting.length);
      this.seat(party, table.spec.id);
    }
  }

  private createTask(type: WaiterTaskType, party: Party, orderId: string | null): WaiterTask {
    const s = this.scenario;
    const dist = type === "take_order" ? s.taskDurations.takeOrder : type === "deliver_order" ? s.taskDurations.deliverOrder : s.taskDurations.clearTable;
    const tableId = party.tableId as string;
    const table = this.tables.get(tableId);
    const task: WaiterTask = {
      id: `T${++this.taskSeq}`,
      seq: this.taskSeq,
      type,
      priority: PRIORITY[type],
      tableId,
      zoneId: table.spec.zoneId,
      partyId: party.id,
      orderId,
      createdAt: this.clock.now,
      startedAt: null,
      completedAt: null,
      waiterId: null,
      serviceSeconds: sampleDistribution(dist, party.rng),
    };
    this.tasks.set(task.id, task);
    this.taskQueue.add(task);
    this.taskQueueStat.update(this.clock.now, this.taskQueue.size);
    if (type === "take_order") {
      party.inFlight++;
      party.awaiting = "waiter";
    }
    return task;
  }

  /** Assigns pending tasks to idle waiters in priority order. Busy waiters are never touched. */
  private dispatch(): void {
    let idle = this.waiters.idle();
    if (idle.length === 0 || this.taskQueue.size === 0) return;
    for (const task of [...this.taskQueue.list()]) {
      if (idle.length === 0) break;
      const waiter = this.chooseWaiter(task, idle);
      if (!waiter) continue;
      this.taskQueue.remove(task);
      this.taskQueueStat.update(this.clock.now, this.taskQueue.size);
      idle = idle.filter((w) => w !== waiter);
      this.startTask(task, waiter);
    }
  }

  private taskPath(task: WaiterTask): Point[] {
    const table = this.tables.get(task.tableId).spec;
    const target = { x: table.x, y: table.y };
    return task.type === "deliver_order" ? [{ ...this.scenario.servicePoint }, target] : [target];
  }

  private chooseWaiter(task: WaiterTask, idle: WaiterRuntime[]): WaiterRuntime | null {
    const path = this.taskPath(task);
    let best: WaiterRuntime | null = null;
    let bestKey: [number, number] = [0, 0];
    for (const w of idle) {
      const sameZone = w.spec.zoneId === task.zoneId;
      if (!sameZone && !this.scenario.crossZoneAssistance) continue;
      let dist = 0;
      let from = w.position;
      for (const p of path) {
        dist += distance(from, p);
        from = p;
      }
      const key: [number, number] = [sameZone ? 0 : 1, dist];
      if (
        best === null ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && w.spec.id < best.spec.id)))
      ) {
        best = w;
        bestKey = key;
      }
    }
    return best;
  }

  private startTask(task: WaiterTask, waiter: WaiterRuntime): void {
    const now = this.clock.now;
    const s = this.scenario;
    const metersPerSecond = s.walkingSpeedMetersPerSecond * s.layoutUnitsPerMeter;
    const legs: Leg[] = [];
    let from: Point = { ...waiter.position };
    let t = now;
    for (const to of this.taskPath(task)) {
      const duration = distance(from, to) / metersPerSecond;
      legs.push({ from, to, t0: t, t1: t + duration });
      t += duration;
      from = to;
    }
    const walkSeconds = t - now;
    task.startedAt = now;
    task.waiterId = waiter.spec.id;
    this.waiters.begin(waiter, { id: task.id, type: task.type, tableId: task.tableId }, legs, now);
    const waited = now - task.createdAt;
    this.collector.onTaskStarted(task.type, waited);
    this.emit("WAITER_TASK_STARTED", {
      waiterId: waiter.spec.id,
      taskId: task.id,
      tableId: task.tableId,
      partyId: task.partyId,
      ...(task.orderId ? { orderId: task.orderId } : {}),
      data: { taskType: task.type, waitedSeconds: waited, walkSeconds, serviceSeconds: task.serviceSeconds },
    });
    this.queue.schedule(t + task.serviceSeconds, { kind: "taskDone", taskId: task.id });
  }

  private onTaskDone(taskId: string): void {
    const now = this.clock.now;
    const task = this.tasks.get(taskId) as WaiterTask;
    const waiter = this.waiters.get(task.waiterId as string);
    const table = this.tables.get(task.tableId);
    task.completedAt = now;
    this.waiters.finish(waiter, { x: table.spec.x, y: table.spec.y }, now);
    this.emit("WAITER_TASK_COMPLETED", {
      waiterId: waiter.spec.id,
      taskId: task.id,
      tableId: task.tableId,
      partyId: task.partyId,
      ...(task.orderId ? { orderId: task.orderId } : {}),
      data: { taskType: task.type, durationSeconds: now - (task.startedAt as number) },
    });
    const party = this.parties.get(task.partyId) as Party;
    if (task.type === "take_order") this.placeOrder(party);
    else if (task.type === "deliver_order") this.serveOrder(task);
    else this.cleanTable(task);
    this.tasks.delete(task.id);
    this.dispatch();
  }

  private placeOrder(party: Party): void {
    const now = this.clock.now;
    const s = this.scenario;
    const order: Order = {
      id: `O${++this.orderSeq}`,
      partyId: party.id,
      tableId: party.tableId as string,
      placedAt: now,
      items: [],
      remaining: 0,
      readyAt: null,
      servedAt: null,
      value: 0,
    };
    for (let guest = 0; guest < party.size; guest++) {
      const count = sampleInt(s.itemsPerGuest.min, s.itemsPerGuest.max, party.rng);
      for (let k = 0; k < count; k++) {
        const spec = pickWeighted(s.menu, (m) => m.probability, party.rng);
        const item: ItemRun = {
          id: `I${++this.itemSeq}`,
          orderId: order.id,
          partyId: party.id,
          spec,
          prepSeconds: sampleDistribution(spec.prep, party.rng),
          enqueuedAt: now,
          startedAt: null,
          completedAt: null,
        };
        order.items.push(item);
        order.value += spec.price;
        this.items.set(item.id, item);
      }
    }
    order.remaining = order.items.length;
    this.orders.set(order.id, order);
    party.awaiting = "food";
    this.collector.onOrderPlaced();
    this.emit("ORDER_PLACED", {
      partyId: party.id,
      tableId: order.tableId,
      orderId: order.id,
      data: { items: order.items.length, value: order.value },
    });
    for (const item of order.items) this.stations[item.spec.station].enqueue(item, now);
    for (const id of STATION_IDS) this.startStation(id);
  }

  private startStation(id: StationId): void {
    const now = this.clock.now;
    for (const item of this.stations[id].startAvailable(now)) {
      const queued = now - item.enqueuedAt;
      this.collector.onItemStarted(id, queued);
      this.emit("KITCHEN_PREPARATION_STARTED", {
        partyId: item.partyId,
        orderId: item.orderId,
        itemId: item.id,
        station: id,
        data: { menuItem: item.spec.id, queueSeconds: queued, prepSeconds: item.prepSeconds },
      });
      this.queue.schedule(now + item.prepSeconds, { kind: "prepDone", itemId: item.id });
    }
  }

  private onPrepDone(itemId: string): void {
    const now = this.clock.now;
    const item = this.items.get(itemId) as ItemRun;
    const order = this.orders.get(item.orderId) as Order;
    item.completedAt = now;
    this.stations[item.spec.station].release(item, now);
    this.collector.onItemCompleted(now - (item.startedAt as number));
    this.emit("KITCHEN_PREPARATION_COMPLETED", {
      partyId: item.partyId,
      orderId: item.orderId,
      itemId: item.id,
      station: item.spec.station,
      data: { menuItem: item.spec.id },
    });
    this.startStation(item.spec.station);
    order.remaining--;
    if (order.remaining === 0) {
      order.readyAt = now;
      this.collector.onOrderReady(now - order.placedAt);
      this.createTask("deliver_order", this.parties.get(order.partyId) as Party, order.id);
    }
    this.dispatch();
  }

  private serveOrder(task: WaiterTask): void {
    const now = this.clock.now;
    const order = this.orders.get(task.orderId as string) as Order;
    const party = this.parties.get(order.partyId) as Party;
    order.servedAt = now;
    const deliverySeconds = now - (order.readyAt as number);
    this.collector.onOrderServed(deliverySeconds, now - order.placedAt, order.items.length, order.value);
    this.emit("ORDER_SERVED", {
      partyId: party.id,
      tableId: order.tableId,
      orderId: order.id,
      waiterId: task.waiterId as string,
      data: { deliverySeconds, orderToServeSeconds: now - order.placedAt, value: order.value },
    });
    party.inFlight--;
    if (party.inFlight === 0) party.awaiting = null;
    if (!party.firstServed) {
      party.firstServed = true;
      this.collector.onFirstServe(party.size);
      this.queue.schedule(now + party.diningSeconds, { kind: "depart", partyId: party.id });
      if (party.rng.next() < this.scenario.repeatOrderProbability) {
        this.queue.schedule(now + party.diningSeconds * REPEAT_ORDER_FRACTION, { kind: "repeatOrder", partyId: party.id });
      }
    } else if (party.departDeferred && party.inFlight === 0) {
      party.departDeferred = false;
      this.queue.schedule(now + party.diningSeconds * EAT_TAIL_FRACTION, { kind: "depart", partyId: party.id });
    }
  }

  private onRepeatOrder(partyId: string): void {
    const party = this.parties.get(partyId);
    if (!party || party.state !== "seated") return;
    this.createTask("take_order", party, null);
    this.dispatch();
  }

  private onDepartureDue(partyId: string): void {
    const party = this.parties.get(partyId);
    if (!party || party.state !== "seated") return;
    if (party.inFlight > 0) {
      party.departDeferred = true;
      return;
    }
    const now = this.clock.now;
    const tableId = party.tableId as string;
    const seatedAt = this.tables.get(tableId).stateSince;
    this.tables.markDirty(tableId, now);
    party.state = "departed";
    this.collector.onDeparted();
    this.emit("PARTY_DEPARTED", { partyId: party.id, tableId, data: { dwellSeconds: now - seatedAt, size: party.size } });
    this.createTask("clear_table", party, null);
    this.dispatch();
  }

  private cleanTable(task: WaiterTask): void {
    this.tables.clean(task.tableId, this.clock.now);
    this.emit("TABLE_CLEANED", { tableId: task.tableId, waiterId: task.waiterId as string, taskId: task.id });
    this.seatWaiting();
  }
}
