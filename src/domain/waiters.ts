export const TASK_TYPES = ["respond_to_call", "deliver_order", "clear_table", "seat_guests", "general_assistance"] as const;
export type WaiterTaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ["OPEN", "ACKNOWLEDGED", "COMPLETED"] as const;
export type WaiterTaskStatus = (typeof TASK_STATUSES)[number];

export interface Waiter {
  id: string;
  name: string;
}

export interface WaiterShift {
  id: string;
  waiterId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface WaiterZoneAssignment {
  id: string;
  waiterId: string;
  zone: string;
}

export interface WaiterTask {
  id: string;
  type: WaiterTaskType;
  tableId: string;
  orderId: string | null;
  callId: string | null;
  assignedWaiterId: string | null;
  status: WaiterTaskStatus;
  priority: number;
  createdAt: string;
  acknowledgedAt: string | null;
  completedAt: string | null;
}

export function isActiveTask(status: string): boolean {
  return status === "OPEN" || status === "ACKNOWLEDGED";
}

export function chooseWaiter(input: {
  zone: string;
  now: string;
  waiters: { id: string }[];
  shifts: { waiterId: string; startedAt: string; endedAt: string | null }[];
  assignments: { waiterId: string; zone: string }[];
  tasks: { assignedWaiterId: string | null; status: string }[];
}): string | null {
  const onDuty = new Set(
    input.shifts
      .filter((shift) => shift.startedAt <= input.now && (shift.endedAt == null || shift.endedAt > input.now))
      .map((shift) => shift.waiterId),
  );
  const eligible = input.waiters
    .map((waiter) => waiter.id)
    .filter((id) => onDuty.has(id) && input.assignments.some((assignment) => assignment.waiterId === id && assignment.zone === input.zone))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (eligible.length === 0) return null;
  const load = new Map(eligible.map((id) => [id, 0]));
  for (const task of input.tasks) {
    if (!task.assignedWaiterId || !isActiveTask(task.status) || !load.has(task.assignedWaiterId)) continue;
    load.set(task.assignedWaiterId, (load.get(task.assignedWaiterId) ?? 0) + 1);
  }
  return [...eligible].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

export interface WaiterLoadMetrics {
  avgResponseMs: number | null;
  avgCompletionMs: number | null;
  active: number;
  completed: number;
  overdue: number;
}

export function waiterLoadMetrics(tasks: WaiterTask[], now: number, responseThresholdMs: number): WaiterLoadMetrics {
  const response = tasks.flatMap((task) => {
    if (!task.acknowledgedAt) return [];
    const ms = Date.parse(task.acknowledgedAt) - Date.parse(task.createdAt);
    return Number.isFinite(ms) && ms >= 0 ? [ms] : [];
  });
  const completion = tasks.flatMap((task) => {
    if (!task.completedAt) return [];
    const ms = Date.parse(task.completedAt) - Date.parse(task.createdAt);
    return Number.isFinite(ms) && ms >= 0 ? [ms] : [];
  });
  const active = tasks.filter((task) => isActiveTask(task.status));
  return {
    avgResponseMs: response.length === 0 ? null : response.reduce((sum, value) => sum + value, 0) / response.length,
    avgCompletionMs: completion.length === 0 ? null : completion.reduce((sum, value) => sum + value, 0) / completion.length,
    active: active.length,
    completed: tasks.filter((task) => task.status === "COMPLETED").length,
    overdue: active.filter((task) => now - Date.parse(task.createdAt) > responseThresholdMs).length,
  };
}
