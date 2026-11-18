import type { Server } from "socket.io";

const globalForIo = globalThis as unknown as { __atelierIo?: Server };

export function setIo(io: Server): void {
  globalForIo.__atelierIo = io;
}

export function getIo(): Server | null {
  return globalForIo.__atelierIo ?? null;
}
