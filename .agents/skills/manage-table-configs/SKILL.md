---
name: manage-table-configs
description: Guidelines and workflow for modifying table inclusion/exclusion, cron schedules, and per-table configs in config/tables.json
---

# Manage Table Configurations Skill

Use this skill when adding new tables, modifying exclude patterns, changing cron schedules, or setting per-table overrides (such as `skipOrphanCleanup`) in [config/tables.json](file:///d:/Development-Zone/postgres-to-mysql/config/tables.json).

---

## Configuration Structure Overview

[config/tables.json](file:///d:/Development-Zone/postgres-to-mysql/config/tables.json) defines three table categories:

1. **`basic`**: Standard tables without `vn`/`an` column filters.
2. **`opd`**: Outpatient tables filtered by `vn` column.
3. **`ipd`**: Inpatient tables filtered by `an` column.

Each group supports:
- `schedule`: Cron expression (e.g., `00 02 * * *` for daily at 02:00).
- `enabled`: Boolean enabling/disabling automated sync for this group.
- `tables.include`: Array of wildcard patterns (e.g. `["*"]`).
- `tables.exclude`: Array of wildcard patterns (e.g. `["*log*", "*_log"]`).
- `tableConfigs`: Map of table names to custom configuration objects.

---

## Workflow for Updating `config/tables.json`

### Step 1: Read Existing Configuration
View [config/tables.json](file:///d:/Development-Zone/postgres-to-mysql/config/tables.json) to inspect the current structure.

### Step 2: Apply Edits Carefully
Ensure proper JSON formatting:
- Place commas `,` between JSON object properties.
- Ensure closing braces `}` match opening braces `{`.
- Put per-table configs (e.g., `skipOrphanCleanup: true`) inside `tableConfigs` under the appropriate group:

```json
"tableConfigs": {
  "sys_var": {
    "skipOrphanCleanup": true
  }
}
```

### Step 3: Validate JSON Syntax
Always run the syntax check command after editing:
```bash
node -e "JSON.parse(require('fs').readFileSync('config/tables.json'))"
```

### Step 4: Clear Cache / Reload (If API Server is Running)
If the API server is active, clear table classifier cache by calling the API or reloading the configuration.
