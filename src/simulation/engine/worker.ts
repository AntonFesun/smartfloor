/**
 * Web Worker entry. Host usage (Next.js / Vite / webpack 5):
 *
 *   const worker = new Worker(new URL("./simulation/engine/worker.ts", import.meta.url), { type: "module" });
 *   worker.postMessage({ type: "init", scenario });
 *   worker.postMessage({ type: "play" });
 *   worker.onmessage = (e) => handle(e.data as WorkerResponse);
 *
 * The file has no DOM or Node imports; it only needs `postMessage` and `onmessage`.
 */
import { SimulationWorkerController } from "./workerController";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
const controller = new SimulationWorkerController((message) => scope.postMessage(message));
scope.onmessage = (event) => controller.handle(event.data);
