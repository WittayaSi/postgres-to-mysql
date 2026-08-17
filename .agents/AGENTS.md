# AGENTS.md - Workspace Rules for AI Assistant (postgres-to-mysql)

This document contains rules, architecture guidelines, and system conventions for AI agents (such as Antigravity) working on the `postgres-to-mysql` project.

---

## 1. System Overview & Architecture

`postgres-to-mysql` is a high-performance Node.js / TypeScript data synchronization system designed to transfer data from a PostgreSQL database (e.g., HOSxP Hospital Database) to a MySQL database with a real-time Web UI Dashboard.

### Tech Stack
- **Language & Runtime**: Node.js, TypeScript (`ts-node`, `tsc`)
- **Databases**: PostgreSQL (`pg`), MySQL (`mysql2`)
- **API & Realtime**: Express.js, Socket.io
- **Scheduler**: `node-cron`, `cron-parser`
- **UI & Frontend**: HTML, Next.js, Tailwind CSS

---

## 2. Directory & Module Structure

- **`config/tables.json`**: Primary configuration file defining sync schedules, included/excluded tables, and per-table overrides (`tableConfigs`).
- **`src/config/index.ts`**: Configuration loader (`getTablesConfig()`) reading directly from `config/tables.json` and `.env`.
- **`src/connectors/postgres.ts`**: PostgreSQL connection pool and query helpers (table metadata, row counts, VN/AN filtering).
- **`src/connectors/mysql.ts`**: MySQL connection pool, table creation, batch inserts, batch upserts, and orphan row deletion (`deleteOrphanRows`).
- **`src/classifiers/tableClassifier.ts`**: Auto-classifies PostgreSQL tables into 3 categories:
  - **`basic`**: Tables without `vn` or `an` columns (daily scheduled full sync).
  - **`opd`**: Tables containing `vn` column (syncs recent $N$ days via `opdDaysBack`).
  - **`ipd`**: Tables containing `an` column (syncs recent $N$ days via `ipdDaysBack`).
- **`src/transfer/transferEngine.ts`**: Core sync execution engine. Handles worker threads, batching, throttle delays, upserts/truncates, and orphan row cleanups.
- **`src/scheduler/jobScheduler.ts`**: Cron scheduler orchestrating automated background sync jobs based on `tables.json`.
- **`src/api/routes.ts`**: REST API endpoints for Web UI, table classification summaries, manual sync triggers, and log streaming.
- **`server.ts`**: Server entry point starting Express, Socket.io, and background schedulers.

---

## 3. Table Classification & Config Rules

### Table Groups
1. `basic`: Synced on schedule (default `00 02 * * *`). Uses `upsert` if Primary Key exists, or `truncate+insert` if no Primary Key.
2. `opd`: Synced on schedule (default `*/25 * * * *`). Uses `vn` column filtering for incremental sync (`opdDaysBack`).
3. `ipd`: Synced on schedule (default `0 */1 * * *`). Uses `an` column filtering for incremental sync (`ipdDaysBack`).

### Per-Table Overrides (`tableConfigs`)
Specific table behavior can be customized inside `tableConfigs` under the group block in `config/tables.json`:
```json
{
  "basic": {
    "schedule": "00 02 * * *",
    "enabled": true,
    "tables": { "include": ["*"], "exclude": ["*log*"] },
    "tableConfigs": {
      "sys_var": {
        "skipOrphanCleanup": true
      }
    }
  }
}
```
Available flags in `TableSpecificConfig` ([src/types.ts](file:///d:/Development-Zone/postgres-to-mysql/src/types.ts)):
- `skipOrphanCleanup?: boolean`: Skips deleting rows in MySQL that no longer exist in PostgreSQL.

---

## 4. Development & AI Safety Guidelines

1. **Always Validate JSON Syntax**:
   After making any edits to [config/tables.json](file:///d:/Development-Zone/postgres-to-mysql/config/tables.json), ALWAYS validate the JSON syntax using Node:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('config/tables.json'))"
   ```
2. **Preserve Real-time Socket.io Logging**:
   When modifying `transferEngine.ts` or `jobScheduler.ts`, ensure `addLog(...)` and Socket.io events are preserved to maintain live Web UI monitoring.
3. **Primary Key & Upsert Safety**:
   `transferEngine.ts` relies on PostgreSQL Primary Keys to perform MySQL `UPSERT` operations. Never assume a table has a Primary Key without querying `postgres.getPrimaryKey(tableName)`.
4. **Environment Variables**:
   Database credentials (`PG_HOST`, `PG_USER`, `MYSQL_HOST`, etc.) are loaded from `.env`. Do not hardcode database connection string values in source files.
