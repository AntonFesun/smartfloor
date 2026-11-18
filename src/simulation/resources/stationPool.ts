import type { MenuItemSpec, StationId } from "../models/types";
import { TimeWeightedStat } from "../metrics/stats";

export interface ItemRun {
  id: string;
  orderId: string;
  partyId: string;
  spec: MenuItemSpec;
  prepSeconds: number;
  enqueuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * A kitchen station or the bar: `capacity` parallel slots and a FIFO queue.
 * Prep time stretches only because items wait here for a slot.
 */
export class StationPool {
  private readonly queue: ItemRun[] = [];
  private readonly active = new Set<ItemRun>();
  private readonly queueStat = new TimeWeightedStat();
  private readonly busyStat = new TimeWeightedStat();

  constructor(
    readonly id: StationId,
    readonly capacity: number,
  ) {}

  get queued(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  enqueue(item: ItemRun, now: number): void {
    this.queue.push(item);
    this.queueStat.update(now, this.queue.length);
  }

  /** Moves as many queued items into free slots as capacity allows, in FIFO order. */
  startAvailable(now: number): ItemRun[] {
    const started: ItemRun[] = [];
    while (this.active.size < this.capacity && this.queue.length > 0) {
      const item = this.queue.shift() as ItemRun;
      item.startedAt = now;
      this.active.add(item);
      started.push(item);
    }
    if (started.length > 0) {
      this.queueStat.update(now, this.queue.length);
      this.busyStat.update(now, this.active.size);
    }
    return started;
  }

  release(item: ItemRun, now: number): void {
    if (!this.active.delete(item)) throw new Error(`Item ${item.id} is not active on station ${this.id}`);
    this.busyStat.update(now, this.active.size);
  }

  utilizationAt(now: number): number | null {
    if (now <= 0 || this.capacity <= 0) return null;
    return this.busyStat.areaAt(now) / (this.capacity * now);
  }

  queueAverageAt(now: number): number | null {
    return this.queueStat.averageAt(now);
  }

  get queueMax(): number {
    return this.queueStat.max;
  }

  queuedItems(): readonly ItemRun[] {
    return this.queue;
  }
}
