# PostgreSQL to MySQL Data Transfer System

ระบบถ่ายโอนข้อมูลอัตโนมัติจาก PostgreSQL ไปยัง MySQL พร้อม Web UI

## Features

- ✅ **Auto Transfer**: รันอัตโนมัติตาม schedule (cron)
- ✅ **Manual Transfer**: Web UI สำหรับเลือกตาราง/ช่วงเวลา
- ✅ **Table Classification**: แบ่งตารางอัตโนมัติตาม column (Basic/OPD/IPD)
- ✅ **Real-time Progress**: แสดงความคืบหน้าแบบ real-time ผ่าน Socket.IO
- ✅ **Multi-tab Support**: รองรับเปิดหลาย tab ทำงานพร้อมกัน (Worker ID)
- ✅ **Configurable**: ตั้งค่า schedule, database, tables ผ่าน Web UI
- ✅ **Auto Schema Sync**: สร้างตารางอัตโนมัติใน MySQL + sync columns เพิ่มเติม
- ✅ **Incremental Transfer**: OPD ใช้ VN prefix, IPD ใช้ AN range (dchdate)
- ✅ **Read-Only Source**: PostgreSQL เชื่อมต่อแบบ read-only เพื่อความปลอดภัย
- ✅ **Upsert with Data Preservation**: Basic transfer ใช้ upsert รักษา column เฉพาะ MySQL
- ✅ **Orphan Row Cleanup**: ลบ row ที่ไม่มีใน PostgreSQL ด้วย `_last_sync` timestamp marker
- ✅ **Connection Retry**: auto-reconnect เมื่อ connection หลุดระหว่าง transfer
- ✅ **Performance Tuning**: Configurable bulk size + disable/enable indexes

## Installation

```bash
pnpm install
```

## Configuration

### 1. Database Connection

คัดลอก `.env.example` เป็น `.env` แล้วแก้ไข:

```env
# PostgreSQL (Source - Read Only)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=hospital_db
PG_USER=postgres
PG_PASSWORD=your_password

# MySQL (Destination - Write)
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=hospital_db
MYSQL_USER=root
MYSQL_PASSWORD=your_password

# Server
PORT=3000

# Transfer Settings
BATCH_SIZE=1000            # จำนวน rows ที่ดึงจาก PG ต่อ batch
MYSQL_BULK_SIZE=50         # จำนวน rows ที่ insert/upsert ต่อ SQL statement (default: 50)

# Connection Retry
DB_RETRY_COUNT=3           # จำนวนครั้งที่ retry เมื่อ connection หลุด (default: 3)
DB_RETRY_DELAY_MS=2000     # delay ระหว่าง retry (ms, เพิ่มขึ้นตาม attempt) (default: 2000)
```

หรือตั้งค่าผ่าน Web UI → ปุ่ม "กำหนดฐานข้อมูล" (บันทึกที่ `config/database.json`)

### 2. Schedule & Table Filter (config/tables.json)

```json
{
  "basic": {
    "schedule": "00 02 * * *",
    "enabled": true,
    "description": "ข้อมูลพื้นฐาน - ทุกวันเวลา 02:00",
    "tables": {
      "include": ["*"],
      "exclude": ["*log*", "*_log", "log_*", "xe_*", "asm_*"]
    }
  },
  "opd": {
    "schedule": "*/30 * * * *",
    "enabled": true,
    "description": "ข้อมูล OPD - ทุก 30 นาที",
    "tables": {
      "include": ["*"],
      "exclude": ["*log*", "*_log", "log_*", "xe_*", "asm_*"]
    }
  },
  "ipd": {
    "schedule": "0 */1 * * *",
    "enabled": true,
    "description": "ข้อมูล IPD - ทุก 1 ชั่วโมง",
    "ipdDaysBack": 45,
    "tables": {
      "include": ["*"],
      "exclude": ["*log*", "*_log", "log_*", "xe_*", "asm_*"]
    }
  }
}
```

> ตารางที่ตรงกับ `exclude` pattern จะไม่ถูก transfer และไม่ถูกสร้างใน MySQL

## Usage

### Development

```bash
# Start server
pnpm run dev

# Watch mode (auto-restart on file change)
pnpm run dev:watch
```

### Production

```bash
pnpm run build
pnpm start
```

เปิด browser ไปที่ http://localhost:3000

## Table Classification

| Column | ประเภท |
|--------|--------|
| ไม่มี vn, an | Basic (ตารางพื้นฐาน) |
| มี vn | OPD |
| มี an | IPD |

> ตารางที่มีทั้ง vn และ an จะปรากฏทั้งใน OPD และ IPD

## Transfer Strategy

| ประเภท | Strategy | รายละเอียด |
|--------|----------|------------|
| **Basic** (มี PK) | Upsert + Orphan Cleanup | INSERT ON DUPLICATE KEY UPDATE + ลบ row ที่ไม่มีใน PG (`_last_sync`) |
| **Basic** (ไม่มี PK) | Truncate + Insert | ลบข้อมูลเก่าทั้งหมดแล้วโอนใหม่ |
| **OPD** | Upsert by VN prefix | ใช้ VN prefix filter (Buddhist year YYMM) |
| **IPD** (Manual) | Upsert by AN range | ใช้ AN range ที่ผู้ใช้กำหนด |
| **IPD** (Scheduler) | Upsert by AN from an_stat | หา MIN(an) จาก an_stat ที่ dchdate ≥ N วัน |

### Basic Transfer Flow (Upsert Mode)

```
1. Sync schema (เพิ่ม column ที่ขาด + เพิ่ม _last_sync)
2. Disable indexes (เพิ่มความเร็ว)
3. Upsert ข้อมูล + set _last_sync = NOW()
4. ลบ orphan rows (WHERE _last_sync < เวลาเริ่ม transfer)
5. Enable indexes
```

**ข้อดี:**
- ✅ รักษา column ที่มีเฉพาะ MySQL (เช่น `nhso_adp_code`) — อัปเดตเฉพาะ column ที่มีใน PG
- ✅ ลบ row ที่ถูกลบจาก PostgreSQL อัตโนมัติ

### Schedule

- **Basic**: ทุกวัน ตี 2 (`00 02 * * *`) — Upsert + Orphan Cleanup
- **OPD**: ทุก 30 นาที (`*/30 * * * *`) — VN prefix filter
- **IPD**: ทุก 1 ชั่วโมง (`0 */1 * * *`) — AN ย้อนหลัง 45 วัน

## Connection Resilience

ระบบมีความทนทานต่อ connection ที่ไม่เสถียร:

- **Pool Keep-Alive**: ทั้ง PG และ MySQL เปิด keepalive ป้องกัน connection timeout
- **Auto Retry**: เมื่อ query ล้มเหลวจาก connection error จะ retry อัตโนมัติ (ค่า default 3 ครั้ง)
- **Exponential Backoff**: delay เพิ่มขึ้นในแต่ละรอบ retry (2s, 4s, 6s)
- **Pool Error Recovery**: PG pool ดัก error event ไม่ให้ process crash
- **Transfer Retry**: แต่ละตารางที่ transfer ล้มเหลวจะ retry สูงสุด 2 ครั้ง

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (สถานะ DB connections) |
| GET | `/api/tables` | รายการตารางทั้งหมด (summary) |
| GET | `/api/tables/classified` | ตารางแบ่งตามประเภท (detailed) |
| POST | `/api/tables/check-counts` | ตรวจสอบจำนวน rows ตาม filter |
| POST | `/api/tables/refresh` | Refresh classification cache |
| POST | `/api/transfer` | เริ่ม transfer |
| GET | `/api/transfer/status` | สถานะ transfer ทุก workers |
| GET | `/api/transfer/status/:workerId` | สถานะ transfer ของ worker |
| GET | `/api/schedule` | ดู schedule status |
| GET | `/api/config/database` | อ่านค่า database config |
| POST | `/api/config/database` | บันทึก database config |
| POST | `/api/config/test` | ทดสอบ database connection |
| GET | `/api/config/scheduler` | อ่านค่า scheduler config |
| POST | `/api/config/scheduler` | บันทึก scheduler config |
| GET | `/api/logs` | ดู logs ล่าสุด |

## Project Structure

```
postgres-to-mysql/
├── config/
│   ├── tables.json            # Schedule & table filter config
│   ├── database.json          # Database connection config (auto-created)
│   └── database.json.example
├── public/
│   ├── index.html             # Web UI
│   ├── css/styles.css         # Tailwind source
│   ├── css/output.css         # Compiled CSS
│   └── js/app.js              # Frontend logic
├── src/
│   ├── api/routes.ts          # REST API endpoints
│   ├── classifiers/
│   │   └── tableClassifier.ts # Table classification (Basic/OPD/IPD)
│   ├── config/index.ts        # App configuration
│   ├── connectors/
│   │   ├── postgres.ts        # PostgreSQL connector (read-only, with retry)
│   │   └── mysql.ts           # MySQL connector (write, with retry)
│   ├── scheduler/
│   │   └── jobScheduler.ts    # Cron job scheduler
│   ├── transfer/
│   │   ├── transferEngine.ts  # Data transfer engine (upsert + orphan cleanup)
│   │   └── transferHistory.ts # Transfer history tracking
│   ├── types.ts               # TypeScript type definitions
│   └── utils/
│       ├── logger.ts          # Winston logger
│       └── retry.ts           # Connection retry utility
├── server.ts                  # Express server entry point
├── .env                       # Environment variables
├── package.json
└── tsconfig.json
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_DATABASE` | `hospital_db` | PostgreSQL database |
| `PG_USER` | `postgres` | PostgreSQL user |
| `PG_PASSWORD` | - | PostgreSQL password |
| `MYSQL_HOST` | `localhost` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_DATABASE` | `hospital_db` | MySQL database |
| `MYSQL_USER` | `root` | MySQL user |
| `MYSQL_PASSWORD` | - | MySQL password |
| `PORT` | `3000` | Web server port |
| `BATCH_SIZE` | `1000` | Rows fetched per batch from PostgreSQL |
| `MYSQL_BULK_SIZE` | `50` | Rows per INSERT/UPSERT SQL statement |
| `DB_RETRY_COUNT` | `3` | Connection retry attempts |
| `DB_RETRY_DELAY_MS` | `2000` | Base delay between retries (ms) |

## License

MIT
