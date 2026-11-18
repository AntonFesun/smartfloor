import type Database from "better-sqlite3";
import { loadScenario, serializeScenario, type SimulationScenario } from "@/simulation";

export function migrateSimulationStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS simulation_scenarios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      document TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function saveSimulationScenario(db: Database.Database, scenario: SimulationScenario): { id: string; name: string } {
  const checked = loadScenario(scenario);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO simulation_scenarios (id, name, document, created_at, updated_at)
     VALUES (@id, @name, @document, @created, @updated)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       document = excluded.document,
       updated_at = excluded.updated_at`,
  ).run({
    id: checked.id,
    name: checked.name,
    document: serializeScenario(checked),
    created: now,
    updated: now,
  });
  return { id: checked.id, name: checked.name };
}

export function listSimulationScenarios(db: Database.Database): { id: string; name: string; updatedAt: string }[] {
  return (db.prepare("SELECT id, name, updated_at FROM simulation_scenarios ORDER BY updated_at DESC, name ASC").all() as {
    id: string;
    name: string;
    updated_at: string;
  }[]).map((row) => ({ id: row.id, name: row.name, updatedAt: row.updated_at }));
}

export function readSimulationScenario(db: Database.Database, id: string): SimulationScenario | null {
  const row = db.prepare("SELECT document FROM simulation_scenarios WHERE id = ?").get(id) as { document: string } | undefined;
  if (!row) return null;
  return loadScenario(row.document);
}
