import { DomainError } from "@/domain/errors";
import type { WaiterStatus } from "@/types";

export function assertCanCall(hasActive: boolean): void {
  if (hasActive) {
    throw new DomainError("duplicate_call", "This table already has an active waiter call", 409);
  }
}

export function nextWaiterStatus(current: WaiterStatus, action: "acknowledge" | "resolve"): WaiterStatus {
  if (action === "acknowledge" && current === "ACTIVE") return "ACKNOWLEDGED";
  if (action === "resolve" && (current === "ACTIVE" || current === "ACKNOWLEDGED")) return "RESOLVED";
  throw new DomainError("invalid_transition", `Cannot ${action} a ${current} waiter call`, 409);
}

export function isActiveWaiter(status: WaiterStatus): boolean {
  return status === "ACTIVE" || status === "ACKNOWLEDGED";
}
