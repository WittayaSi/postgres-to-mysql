---
name: sync-diagnostics
description: Diagnostic procedures for troubleshooting data sync issues, missing primary keys, orphan row cleanup, and classification mismatches.
---

# Sync Diagnostics Skill

Use this skill when investigating data sync errors, missing rows in MySQL, primary key detection issues, or orphan row cleanup behavior.

---

## Key Diagnostic Steps

### 1. Check Primary Key Detection
`transferEngine.ts` uses `postgres.getPrimaryKey(tableName)` to decide whether to use **`upsert`** or **`truncate+insert`**:
- **With Primary Key**: Performs batch `UPSERT` + optional orphan cleanup (`deleteOrphanRows`).
- **Without Primary Key**: Performs `truncateTable` + `insertBatch`.

If a table is truncating unexpectedly, verify if PostgreSQL has a primary key defined for that table.

### 2. Inspect Orphan Cleanup Logs
If rows in MySQL are being unexpectedly deleted (or preserved):
- Check [tables.json](file:///d:/Development-Zone/postgres-to-mysql/config/tables.json) for `tableConfigs.<tableName>.skipOrphanCleanup`.
- Review [transferEngine.ts](file:///d:/Development-Zone/postgres-to-mysql/src/transfer/transferEngine.ts#L705-L714) for the orphan cleanup decision logic.

### 3. Check Table Classification
If a table is not syncing under the expected schedule (`basic`, `opd`, or `ipd`):
- Tables with a `vn` column are assigned to `opd`.
- Tables with an `an` column are assigned to `ipd`.
- Tables without `vn` or `an` are assigned to `basic`.
- Check [tableClassifier.ts](file:///d:/Development-Zone/postgres-to-mysql/src/classifiers/tableClassifier.ts) for column detection logic.

### 4. Run Quick Verification Script
To test table queries or database connections safely, inspect or execute scratch scripts in `scratch/check_stats.ts`.
