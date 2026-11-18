import type { WaiterTaskType } from "../models/types";

export interface WaiterTask {
  id: string;
  seq: number;
  type: WaiterTaskType;
  /** Lower number is served first. */
  priority: number;
  tableId: string;
  zoneId: string;
  partyId: string;
  orderId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  waiterId: string | null;
  /** Hands-on service seconds, excluding walking. */
  serviceSeconds: number;
}

/**
 * Pending waiter tasks ordered by priority then creation sequence.
 * A sorted array rather than a heap: dispatch must be able to skip tasks that
 * no waiter may take (e.g. cross-zone help disabled) without disturbing order.
 */
export class TaskQueue {
  private readonly items: WaiterTask[] = [];

  get size(): number {
    return this.items.length;
  }

  add(task: WaiterTask): void {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.items[mid] as WaiterTask;
      if (other.priority < task.priority || (other.priority === task.priority && other.seq < task.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, task);
  }

  /** Snapshot in service order. */
  list(): readonly WaiterTask[] {
    return this.items;
  }

  remove(task: WaiterTask): void {
    const index = this.items.indexOf(task);
    if (index >= 0) this.items.splice(index, 1);
  }

  clear(): void {
    this.items.length = 0;
  }
}
