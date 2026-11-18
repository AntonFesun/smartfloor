/** Binary min-heap. `compare(a, b) < 0` means `a` is served first. */
export class PriorityQueue<T> {
  private readonly heap: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i] as T, this.heap[parent] as T) >= 0) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): T | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      let i = 0;
      const n = this.heap.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < n && this.compare(this.heap[l] as T, this.heap[best] as T) < 0) best = l;
        if (r < n && this.compare(this.heap[r] as T, this.heap[best] as T) < 0) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  clear(): void {
    this.heap.length = 0;
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a] as T;
    this.heap[a] = this.heap[b] as T;
    this.heap[b] = tmp;
  }
}
