import { DomainError } from "@/domain/errors";
import type { TableStatus } from "@/types";

export type TableAction = "seat" | "reserve" | "clear" | "release";

export function nextTableStatus(status: TableStatus, action: TableAction): TableStatus {
  if (action === "seat" && (status === "AVAILABLE" || status === "RESERVED")) return "OCCUPIED";
  if (action === "reserve" && status === "AVAILABLE") return "RESERVED";
  if (action === "clear" && status === "OCCUPIED") return "AVAILABLE";
  if (action === "release" && status === "RESERVED") return "AVAILABLE";
  throw new DomainError("invalid_transition", `Cannot ${action} a ${status} table`, 409);
}

export function assertSeatCount(count: number, capacity: number): number {
  if (!Number.isInteger(count) || count < 1 || count > capacity) {
    throw new DomainError("invalid_seats", `Seat count must be between 1 and ${capacity}`);
  }
  return count;
}
