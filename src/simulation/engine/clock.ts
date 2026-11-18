/** Virtual simulation clock. Never reads wall time; the host drives it. */
export class VirtualClock {
  private current = 0;
  private speedFactor = 1;

  get now(): number {
    return this.current;
  }

  get speed(): number {
    return this.speedFactor;
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("speed must be a positive finite number");
    this.speedFactor = speed;
  }

  advanceTo(time: number): void {
    if (time < this.current) throw new RangeError(`clock cannot move backwards (${time} < ${this.current})`);
    this.current = time;
  }

  /** Simulated seconds that correspond to `realDeltaMs` of wall time at the current speed. */
  realToSimulated(realDeltaMs: number): number {
    return (Math.max(0, realDeltaMs) / 1000) * this.speedFactor;
  }

  reset(): void {
    this.current = 0;
  }
}

export const SIMULATION_SPEEDS = [1, 10, 60, 300] as const;
