import type { SimulationWaiterSpec, WaiterTaskType } from "../models/types";

export interface Point {
  x: number;
  y: number;
}

export interface Leg {
  from: Point;
  to: Point;
  t0: number;
  t1: number;
}

export interface WaiterRuntime {
  spec: SimulationWaiterSpec;
  position: Point;
  busy: boolean;
  taskId: string | null;
  taskType: WaiterTaskType | null;
  tableId: string | null;
  taskStartedAt: number;
  legs: Leg[];
  walkEndsAt: number;
  busySeconds: number;
  tasksCompleted: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class WaiterPool {
  private readonly ordered: WaiterRuntime[];
  private readonly byId = new Map<string, WaiterRuntime>();

  constructor(specs: readonly SimulationWaiterSpec[]) {
    this.ordered = specs.map((spec) => {
      const runtime: WaiterRuntime = {
        spec,
        position: { x: spec.homeX, y: spec.homeY },
        busy: false,
        taskId: null,
        taskType: null,
        tableId: null,
        taskStartedAt: 0,
        legs: [],
        walkEndsAt: 0,
        busySeconds: 0,
        tasksCompleted: 0,
      };
      this.byId.set(spec.id, runtime);
      return runtime;
    });
  }

  all(): readonly WaiterRuntime[] {
    return this.ordered;
  }

  get(id: string): WaiterRuntime {
    const w = this.byId.get(id);
    if (!w) throw new Error(`Unknown waiter ${id}`);
    return w;
  }

  idle(): WaiterRuntime[] {
    return this.ordered.filter((w) => !w.busy);
  }

  busyCount(): number {
    let n = 0;
    for (const w of this.ordered) if (w.busy) n++;
    return n;
  }

  begin(
    waiter: WaiterRuntime,
    task: { id: string; type: WaiterTaskType; tableId: string },
    legs: Leg[],
    now: number,
  ): void {
    if (waiter.busy) throw new Error(`Waiter ${waiter.spec.id} is already busy with ${waiter.taskId}`);
    waiter.busy = true;
    waiter.taskId = task.id;
    waiter.taskType = task.type;
    waiter.tableId = task.tableId;
    waiter.taskStartedAt = now;
    waiter.legs = legs;
    waiter.walkEndsAt = legs.length > 0 ? (legs[legs.length - 1] as Leg).t1 : now;
  }

  finish(waiter: WaiterRuntime, endPosition: Point, now: number): void {
    waiter.busySeconds += now - waiter.taskStartedAt;
    waiter.tasksCompleted++;
    waiter.busy = false;
    waiter.taskId = null;
    waiter.taskType = null;
    waiter.tableId = null;
    waiter.legs = [];
    waiter.position = { ...endPosition };
  }

  busySecondsAt(waiter: WaiterRuntime, now: number): number {
    return waiter.busySeconds + (waiter.busy ? now - waiter.taskStartedAt : 0);
  }

  /** Position at `time`, interpolating along the current walking legs. */
  positionAt(waiter: WaiterRuntime, time: number): Point {
    if (!waiter.busy) return { ...waiter.position };
    let last: Point = waiter.position;
    for (const leg of waiter.legs) {
      if (time < leg.t1) {
        if (leg.t1 <= leg.t0 || time <= leg.t0) return { ...leg.from };
        const f = (time - leg.t0) / (leg.t1 - leg.t0);
        return { x: leg.from.x + (leg.to.x - leg.from.x) * f, y: leg.from.y + (leg.to.y - leg.from.y) * f };
      }
      last = leg.to;
    }
    return { ...last };
  }
}
