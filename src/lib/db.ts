import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate, seedIfEmpty } from "@/lib/repository";

const globalForDb = globalThis as unknown as { __atelierDb?: Database.Database };

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  migrate(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__atelierDb) {
    const dir = path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const db = openDatabase(path.join(dir, "atelier.db"));
    seedIfEmpty(db);
    globalForDb.__atelierDb = db;
  }
  return globalForDb.__atelierDb;
}
