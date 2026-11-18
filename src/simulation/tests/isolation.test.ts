import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "tests" ? [] : sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("isolation from the host app", () => {
  it("imports only relative files: no React, Three, Next, database or network libraries", () => {
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specifiers) expect(spec.startsWith("."), `${file} imports ${spec}`).toBe(true);
    }
  });

  it("never uses timers, wall-clock time or Math.random inside the engine (the worker controller is the only pacing code)", () => {
    for (const file of sourceFiles(root)) {
      if (file.endsWith("workerController.ts")) continue;
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/setTimeout|setInterval|Math\.random|Date\.now|new Date\(\)|performance\.now/);
    }
  });
});
