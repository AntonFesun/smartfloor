import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/domain/errors";

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
  }
  console.error(error);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export function ok(data: unknown): NextResponse {
  return NextResponse.json(data);
}

export function readIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) return undefined;
  if (value.length > 200) throw new DomainError("bad_idempotency_key", "Idempotency key is too long");
  return value;
}
