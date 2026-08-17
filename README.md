# PostgreSQL to MySQL Data Transfer System

ระบบถ่ายโอนข้อมูลอัตโนมัติจาก PostgreSQL (HOSxP) ไปยัง MySQL พร้อม Real-time Web UI Dashboard และ AI Diagnostic Engine

## Features

- ✅ **Auto Transfer**: รันอัตโนมัติตาม schedule (cron)
- ✅ **Manual Transfer**: Web UI สำหรับเลือกตาราง/ช่วงเวลา
- ✅ **4-Layer Smart Classification Architecture**: จัดกลุ่มตารางอัตโนมัติ (Basic/OPD/IPD) **แบบไม่มีตารางซ้ำซ้อน (0% Overlaps)**
- ✅ **Smart Change Detector**: เช็คการเปลี่ยนแปลงข้อมูลใน PostgreSQL ก่อนย้าย ข้ามตารางที่ไม่เปลี่ยนแปลงใน $0.0\text{s}$
- ✅ **Anti-Freeze & Performance Tuning**: 
  - ยกเลิกการใช้ `_last_sync` 100% ช่วยขจัดปัญหา Full Table Scan และแก้ปัญหา MySQL ค้าง
  - เพิ่ม **Batch Throttling (`TRANSFER_THROTTLE_MS = 150ms`)** เว้นจังหวะพัก ไม่แย่ง CPU/Disk I/O ของเซิร์ฟเวอร์
  - สร้าง Index อัตโนมัติ (`idx_vn`, `idx_an`) เพื่อให้คิวรี่ช่วงเวลาได้รวดเร็ว
- ✅ **🤖 AI Diagnostic Engine**: วิเคราะห์สาเหตุของ Error ระหว่างย้ายข้อมูลอัตโนมัติ (รองรับ Gemini API, OpenAI API และ Offline Rule Engine)
- ✅ **Real-time Monitoring**: แสดงความคืบหน้าแบบ real-time ผ่าน Socket.io
- ✅ **Multi-tab Support**: รองรับเปิดหลาย tab ทำงานพร้อมกัน (Worker ID)
- ✅ **Secure Config via .env**: โหลดและบันทึกการตั้งค่าผ่านไฟล์ `.env` โดยตรง ปลอดภัย ไร้การหลุดของรหัสผ่าน
- ✅ **Auto Schema Sync**: สร้างตารางและเพิ่มคอลัมน์อัตโนมัติใน MySQL 
- ✅ **Incremental Transfer**: OPD ใช้ VN prefix, IPD ใช้ AN range
- ✅ **Read-Only Source**: PostgreSQL เชื่อมต่อแบบ read-only เพื่อความปลอดภัยสูงสุด
- ✅ **Connection Retry**: auto-reconnect เมื่อ connection หลุดระหว่าง transfer

---

## Installation

```bash
pnpm install
```

---

## Configuration

### 1. Database Connection (.env)

คัดลอก `.env.example` เป็น `.env` แล้วแก้ไขค่าการเชื่อมต่อ:

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
PORT=3030

# Transfer Settings & Anti-Freeze Throttling
BATCH_SIZE=500
TRANSFER_THROTTLE_MS=150

# Optional AI Diagnostic Keys
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
```

> การตั้งค่าเชื่อมต่อฐานข้อมูลทั้งหมดถูกจัดการผ่านไฟล์ `.env` เพื่อความปลอดภัย

---

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
    "schedule": "*/25 * * * *",
    "enabled": true,
    "description": "ข้อมูล OPD - ทุก 25 นาที",
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

---

## Table Classification Architecture

ระบบใช้ **4-Layer Smart Classification Architecture** เพื่อจัดกลุ่มตารางใน HOSxP (กว่า 6,400 ตาราง) ให้เข้าสังกัดเพียง 1 กลุ่มเด็ดขาด **(0% Overlaps)**:

```
PostgreSQL Tables (6,400+ Tables)
  ├── Layer 1: Explicit Overrides (ระบุเฉพาะใน config/tables.json -> tableConfigs)
  ├── Layer 2: IPD Domain Patterns (ipt%, an_%, ipd_%, ward%, bed%, %_ipd) -> IPD Group
  ├── Layer 3: Contains Column 'vn' -> OPD Group (รวมถึง lab_head, xray_head, opitemrece)
  ├── Layer 4: Fallback Column 'an' -> IPD Group
  └── Default: Setup & Reference Tables -> Basic Group
```

| กลุ่ม | รายละเอียดการทำงาน | ตัวอย่างตาราง |
|-------|---------------------|---------------|
| **Basic** | ตารางพื้นฐาน/ตั้งค่าที่ไม่มีคอลัมน์ `vn` หรือ `an` (ซิงค์แบบ Smart Sync วันละ 1 ครั้ง ตี 2) | `patient`, `doctor`, `sys_var`, `drugitems` |
| **OPD** | ตารางที่มีคอลัมน์ `vn` รวมถึงตารางสั่งการกลาง (ซิงค์ทุก 25 นาที ย้อนหลัง 7 วัน) | `ovst`, `opdscreen`, `lab_head`, `xray_head`, `opitemrece` |
| **IPD** | ตารางผู้ป่วยในโดยเฉพาะ (ซิงค์ทุก 1 ชั่วโมง ย้อนหลัง 45 วัน) | `ipt`, `iptdiag`, `an_stat`, `iptadm`, `ipd_doctor_order` |

---

## Transfer Strategy

| ประเภท | Strategy | รายละเอียด |
|--------|----------|------------|
| **Basic** (มี PK) | Safe Upsert | `INSERT ON DUPLICATE KEY UPDATE` (อัปเดตเฉพาะคอลัมน์ที่มีใน PG) |
| **Basic** (ไม่มี PK) | Truncate + Insert | ลบข้อมูลเก่าทั้งหมดแล้วโอนใหม่ |
| **OPD** | Upsert by VN prefix | ใช้ VN prefix filter (ปี พ.ศ. YYMMDD) |
| **IPD** (Manual) | Upsert by AN range | ใช้ AN range ที่ผู้ใช้กำหนด |
| **IPD** (Scheduler) | Upsert by AN from an_stat | หา MIN(an) จาก `an_stat` ที่ dchdate ≥ N วัน |

---

## 🤖 AI Diagnostic Engine

ระบบฝังเครื่องมือวิเคราะห์ข้อผิดพลาดด้วย AI อัตโนมัติ (`src/ai/aiDiagnoser.ts`):
- **วิเคราะห์ Error อัตโนมัติ**: เมื่อเกิดปัญหาในการย้ายข้อมูล (เช่น Connection Timeout, SQL Syntax, Data Truncation) AI จะทำการวิเคราะห์สาเหตุและแสดงทางแก้ไขผ่าน Web UI Dashboard ทันที
- **Multi-Engine Support**: รองรับ **Gemini API**, **OpenAI API** และมีระบบ **Offline Rule Engine** สำรองทำงานอัตโนมัติหากไม่มี API Key

---

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

เปิด browser ไปที่ `http://localhost:3030` (หรือ Port ที่ตั้งไว้ใน `.env`)

---

## Deployment via aaPanel / Linux Server

1. ติดตั้ง `Node.js project manager` ใน aaPanel (เลือก Node.js v20/v22)
2. วางโฟลเดอร์ไว้ที่ `/www/wwwroot/postgres-to-mysql`
3. ตั้งค่าไฟล์ `.env`
4. สั่ง `pnpm install` และ `npm run build`
5. ใน aaPanel: เพิ่ม Node Project ให้ชี้รันที่ `dist/server.js` บน Port `3030`
6. ปลดล็อค Firewall Port `3030` ในเมนู Security ของ aaPanel

---

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
| GET | `/api/config/database` | อ่านค่า database config จาก `.env` |
| POST | `/api/config/database` | บันทึก database config ลง `.env` |
| POST | `/api/config/test` | ทดสอบ database connection |
| GET | `/api/ai/status` | เช็คสถานะ AI Diagnostic Engine |
| POST | `/api/ai/diagnose` | ส่ง error log ให้ AI ช่วยวิเคราะห์ |
| GET | `/api/logs` | ดู logs ล่าสุด |

---

## Project Structure

```
postgres-to-mysql/
├── config/
│   └── tables.json            # Schedule & table filter config
├── public/
│   ├── index.html             # Web UI Dashboard
│   ├── css/styles.css         # Tailwind source
│   ├── css/output.css         # Compiled CSS
│   └── js/app.js              # Frontend logic
├── src/
│   ├── ai/
│   │   ├── aiDiagnoser.ts     # AI Diagnostic Engine (Gemini / OpenAI / Offline)
│   │   └── schemaTranslator.ts# PostgreSQL to MySQL DDL Translator
│   ├── api/routes.ts          # REST API endpoints
│   ├── classifiers/
│   │   └── tableClassifier.ts # 4-Layer Smart Classification Architecture
│   ├── config/index.ts        # App configuration loader
│   ├── connectors/
│   │   ├── postgres.ts        # PostgreSQL connector (read-only, with retry)
│   │   └── mysql.ts           # MySQL connector (write, safe upsert, no _last_sync)
│   ├── scheduler/
│   │   └── jobScheduler.ts    # Cron job scheduler
│   ├── transfer/
│   │   ├── transferEngine.ts  # Data transfer engine (throttling, auto indexing)
│   │   └── transferHistory.ts # Transfer history tracking
│   ├── types.ts               # TypeScript type definitions
│   └── utils/
│       ├── pgChangeDetector.ts# Smart Change Detection engine
│       ├── logger.ts          # Winston logger
│       └── retry.ts           # Connection retry utility
├── server.ts                  # Express server entry point
├── .env                       # Environment variables
├── .env.example               # Environment template
├── package.json
└── tsconfig.json
```

---

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
| `PORT` | `3030` | Web server port |
| `BATCH_SIZE` | `500` | Rows fetched per batch from PostgreSQL |
| `TRANSFER_THROTTLE_MS` | `150` | Throttle delay between batches (ms) |
| `GEMINI_API_KEY` | - | Optional Gemini API key |
| `OPENAI_API_KEY` | - | Optional OpenAI API key |

---

## License

MIT
