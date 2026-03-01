// lib/db/index.ts
// Single swap-point for the database implementation.
// Change this import to switch from SQLite to Postgres.

import { SQLiteRepository } from "./sqlite-repository";

export const db = new SQLiteRepository(
  process.env.SQLITE_PATH || "./data/app.sqlite"
);

export type { IRepository } from "./repository";
