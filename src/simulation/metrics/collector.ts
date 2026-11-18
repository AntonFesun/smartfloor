import {
  STATION_IDS,
  WAITER_TASK_TYPES,
  type BottleneckId,
  type SimulationMetrics,
  type SimulationScenario,
  type StationId,
  type WaiterTaskType,
} from "../models/types";
import type { StationPool } from "../resources/stationPool";
import type { TablePool } from "../resources/tablePool";
import type { WaiterPool } from "../resources/waiterPool";
import { summarize, type TimeWeightedStat } from "./stats";

export const SIMULATION_DISCLAIMER =
  "Simulation output from synthetic demand. Order values are estimates, not recorded or guaranteed revenue.";

export type RejectReason = "no_fitting_table" | "queue_full" | "abandoned";

export interface MetricsContext {
  now: number;
  completed: boolean;
  scenario: SimulationScenario;
  tables: TablePool;
  waiters: WaiterPool;
  stations: Record<StationId, StationPool>;
  seatingQueueStat: TimeWeightedStat;
  taskQueueStat: TimeWeightedStat;
  /** Arrival times of parties still waiting for a table. */
  waitingPartyArrivals: number[];
  /** Creation times of tasks no waiter has picked up yet. */
  pendingTaskCreatedAt: number[];
  /** Placement times of orders whose items are not all ready yet. */
  openOrderPlacedAt: number[];
  /** Ready times of orders waiting for a waiter to deliver them. */
  openDeliveryReadyAt: number[];
}

/** Accumulates raw measurements while the engine runs. Holds no engine state itself. */
export class MetricsCollector {
  private arrivedParties = 0;
  private arrivedGuests = 0;
  private seatedParties = 0;
  private seatedGuests = 0;
  private servedParties = 0;
  private servedGuests = 0;
  private departedParties = 0;
  private rejectedParties = 0;
  private rejectedGuests = 0;
  private rejectedByReason = { no_fitting_table: 0, queue_full: 0, abandoned: 0 };
  private ordersPlaced = 0;
  private ordersServed = 0;
  private itemsServed = 0;
  private orderValue = 0;

  private seatingWaits: number[] = [];
  private responseWaits: number[] = [];
  private responseByType: Record<WaiterTaskType, number[]> = { take_order: [], deliver_order: [], clear_table: [] };
  private kitchenQueueWaits: number[] = [];
  private cookTimes: number[] = [];
  private prepTimes: number[] = [];
  private deliveryDelays: number[] = [];
  private orderToServe: number[] = [];

  private slaViolations = { seatingWait: 0, waiterResponse: 0, prep: 0, delivery: 0 };
  private stationQueueDelay: Record<StationId, number> = { hot: 0, cold: 0, bar: 0 };

  constructor(private readonly scenario: SimulationScenario) {}

  onArrival(size: number): void {
    this.arrivedParties++;
    this.arrivedGuests += size;
  }

  onSeated(size: number, waitSeconds: number): void {
    this.seatedParties++;
    this.seatedGuests += size;
    this.seatingWaits.push(waitSeconds);
    if (waitSeconds > this.scenario.sla.seatingWaitSeconds) this.slaViolations.seatingWait++;
  }

  onRejected(size: number, reason: RejectReason): void {
    this.rejectedParties++;
    this.rejectedGuests += size;
    this.rejectedByReason[reason]++;
  }

  onDeparted(): void {
    this.departedParties++;
  }

  onTaskStarted(type: WaiterTaskType, waitSeconds: number): void {
    this.responseWaits.push(waitSeconds);
    this.responseByType[type].push(waitSeconds);
    if (waitSeconds > this.scenario.sla.waiterResponseSeconds) this.slaViolations.waiterResponse++;
  }

  onOrderPlaced(): void {
    this.ordersPlaced++;
  }

  onItemStarted(station: StationId, queueSeconds: number): void {
    this.kitchenQueueWaits.push(queueSeconds);
    this.stationQueueDelay[station] += queueSeconds;
  }

  onItemCompleted(cookSeconds: number): void {
    this.cookTimes.push(cookSeconds);
  }

  onOrderReady(prepSeconds: number): void {
    this.prepTimes.push(prepSeconds);
    if (prepSeconds > this.scenario.sla.prepSeconds) this.slaViolations.prep++;
  }

  onFirstServe(partySize: number): void {
    this.servedParties++;
    this.servedGuests += partySize;
  }

  onOrderServed(deliverySeconds: number, orderToServeSeconds: number, items: number, value: number): void {
    this.ordersServed++;
    this.itemsServed += items;
    this.orderValue += value;
    this.deliveryDelays.push(deliverySeconds);
    this.orderToServe.push(orderToServeSeconds);
    if (deliverySeconds > this.scenario.sla.deliverySeconds) this.slaViolations.delivery++;
  }

  counters(): { arrived: number; seated: number; served: number; departed: number; rejected: number } {
    return {
      arrived: this.arrivedParties,
      seated: this.seatedParties,
      served: this.servedParties,
      departed: this.departedParties,
      rejected: this.rejectedParties,
    };
  }

  build(ctx: MetricsContext): SimulationMetrics {
    const { now, scenario } = ctx;
    const tableCount = ctx.tables.count();
    const waiterCount = ctx.waiters.all().length;

    const waiterBusy = ctx.waiters.all().map((w) => ctx.waiters.busySecondsAt(w, now));
    const totalBusy = waiterBusy.reduce((s, v) => s + v, 0);
    const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

    const stationUtil = {} as Record<StationId, number | null>;
    const stationQueues = {} as SimulationMetrics["queues"]["stations"];
    for (const id of STATION_IDS) {
      const s = ctx.stations[id];
      stationUtil[id] = s.utilizationAt(now);
      stationQueues[id] = { max: s.queueMax, timeAverage: s.queueAverageAt(now), stillQueued: s.queued };
    }

    const stillWaitingSeating = ctx.waitingPartyArrivals.reduce((s, t) => s + (now - t), 0);
    const stillPendingTasks = ctx.pendingTaskCreatedAt.reduce((s, t) => s + (now - t), 0);
    const delaySeconds: Record<BottleneckId, number> = {
      seating: this.seatingWaits.reduce((s, v) => s + v, 0) + stillWaitingSeating,
      waiters: this.responseWaits.reduce((s, v) => s + v, 0) + stillPendingTasks,
      hot: this.stationQueueDelay.hot,
      cold: this.stationQueueDelay.cold,
      bar: this.stationQueueDelay.bar,
    };
    for (const id of STATION_IDS) {
      for (const item of ctx.stations[id].queuedItems()) delaySeconds[id] += now - item.enqueuedAt;
    }
    const totalDelay = Object.values(delaySeconds).reduce((s, v) => s + v, 0);
    let shares: Record<BottleneckId, number> | null = null;
    let primary: BottleneckId | null = null;
    if (totalDelay > 0) {
      shares = { seating: 0, waiters: 0, hot: 0, cold: 0, bar: 0 };
      let best = -1;
      for (const id of ["seating", "waiters", "hot", "cold", "bar"] as const) {
        shares[id] = delaySeconds[id] / totalDelay;
        if (delaySeconds[id] > best) {
          best = delaySeconds[id];
          primary = id;
        }
      }
    }

    const over = (times: number[], threshold: number): number => times.filter((t) => now - t > threshold).length;
    const sla = {
      seatingWait: this.slaViolations.seatingWait + over(ctx.waitingPartyArrivals, scenario.sla.seatingWaitSeconds),
      waiterResponse: this.slaViolations.waiterResponse + over(ctx.pendingTaskCreatedAt, scenario.sla.waiterResponseSeconds),
      prep: this.slaViolations.prep + over(ctx.openOrderPlacedAt, scenario.sla.prepSeconds),
      delivery: this.slaViolations.delivery + over(ctx.openDeliveryReadyAt, scenario.sla.deliverySeconds),
    };

    const byType = {} as Record<WaiterTaskType, ReturnType<typeof summarize>>;
    for (const type of WAITER_TASK_TYPES) byType[type] = summarize(this.responseByType[type]);

    return {
      kind: "simulation",
      disclaimer: SIMULATION_DISCLAIMER,
      scenarioId: scenario.id,
      seed: scenario.seed,
      simulatedSeconds: now,
      completed: ctx.completed,
      parties: {
        arrived: this.arrivedParties,
        seated: this.seatedParties,
        served: this.servedParties,
        departed: this.departedParties,
        rejected: this.rejectedParties,
        rejectedByReason: { ...this.rejectedByReason },
        stillWaiting: ctx.waitingPartyArrivals.length,
      },
      guests: { arrived: this.arrivedGuests, seated: this.seatedGuests, served: this.servedGuests, rejected: this.rejectedGuests },
      orders: { placed: this.ordersPlaced, served: this.ordersServed, itemsServed: this.itemsServed, estimatedOrderValue: this.orderValue },
      waits: {
        seating: summarize(this.seatingWaits),
        waiterResponse: summarize(this.responseWaits),
        waiterResponseByType: byType,
        kitchenQueue: summarize(this.kitchenQueueWaits),
        cook: summarize(this.cookTimes),
        prep: summarize(this.prepTimes),
        delivery: summarize(this.deliveryDelays),
        orderToServe: summarize(this.orderToServe),
      },
      open: {
        seatingWait: summarize(ctx.waitingPartyArrivals.map((t) => now - t)),
        waiterResponse: summarize(ctx.pendingTaskCreatedAt.map((t) => now - t)),
        kitchenQueue: summarize(STATION_IDS.flatMap((id) => ctx.stations[id].queuedItems().map((i) => now - i.enqueuedAt))),
        prep: summarize(ctx.openOrderPlacedAt.map((t) => now - t)),
        delivery: summarize(ctx.openDeliveryReadyAt.map((t) => now - t)),
      },
      utilization: {
        waiters: ratio(totalBusy, waiterCount * now),
        tables: ratio(ctx.tables.occupiedSecondsAt(now), tableCount * now),
        tablesIncludingCleaning: ratio(ctx.tables.occupiedSecondsAt(now) + ctx.tables.dirtySecondsAt(now), tableCount * now),
        stations: stationUtil,
      },
      waiters: ctx.waiters.all().map((w, i) => ({
        id: w.spec.id,
        zoneId: w.spec.zoneId,
        busySeconds: waiterBusy[i] as number,
        utilization: ratio(waiterBusy[i] as number, now),
        tasksCompleted: w.tasksCompleted,
      })),
      turnover: {
        departures: this.departedParties,
        perTable: ratio(this.departedParties, tableCount),
        perTablePerHour: ratio(this.departedParties, tableCount * (now / 3600)),
      },
      queues: {
        seating: { max: ctx.seatingQueueStat.max, timeAverage: ctx.seatingQueueStat.averageAt(now) },
        waiterTasks: { max: ctx.taskQueueStat.max, timeAverage: ctx.taskQueueStat.averageAt(now), stillPending: ctx.pendingTaskCreatedAt.length },
        stations: stationQueues,
      },
      sla: { thresholds: { ...scenario.sla }, ...sla, total: sla.seatingWait + sla.waiterResponse + sla.prep + sla.delivery },
      bottleneck: { delaySeconds, shares, primary },
    };
  }
}

