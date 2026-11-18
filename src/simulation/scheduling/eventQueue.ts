import { PriorityQueue } from "./priorityQueue";

export interface ScheduledEvent<P> {
  /** Simulated time in seconds. */
  time: number;
  /** Monotonic insertion sequence; breaks ties between equal times. */
  seq: number;
  payload: P;
}

/** Discrete-event queue ordered by simulated time, then insertion sequence. */
export class EventQueue<P> {
  private readonly queue = new PriorityQueue<ScheduledEvent<P>>((a, b) => a.time - b.time || a.seq - b.seq);
  private nextSeq = 1;

  get size(): number {
    return this.queue.size;
  }

  schedule(time: number, payload: P): ScheduledEvent<P> {
    if (!Number.isFinite(time) || time < 0) throw new RangeError(`invalid event time: ${time}`);
    const event: ScheduledEvent<P> = { time, seq: this.nextSeq++, payload };
    this.queue.push(event);
    return event;
  }

  peek(): ScheduledEvent<P> | undefined {
    return this.queue.peek();
  }

  pop(): ScheduledEvent<P> | undefined {
    return this.queue.pop();
  }

  clear(): void {
    this.queue.clear();
    this.nextSeq = 1;
  }
}
