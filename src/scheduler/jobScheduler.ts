import cron, { ScheduledTask } from 'node-cron';
import dayjs from 'dayjs';
import config from '../config';
import transferEngine from '../transfer/transferEngine';
import logger from '../utils/logger';
import { SchedulerStatus, TransferType } from '../types';

class JobScheduler {
  private jobs: Record<string, ScheduledTask> = {};
  private nextRuns: Record<string, string | null> = {};

  start(): void {
    const tablesConfig = config.getTablesConfig();

    // Schedule Basic tables transfer - runs at configured time
    if (tablesConfig.basic.enabled) {
      this.scheduleJob('basic', tablesConfig.basic.schedule, async () => {
        const now = dayjs().format('DD/MM/YYYY HH:mm:ss');
        logger.info(`[SCHEDULER] ⏰ ${now} - เริ่มโอนข้อมูล Basic (ข้อมูลพื้นฐาน)`);
        await transferEngine.transferBasic({ workerId: 'scheduler-basic', source: 'scheduler', smartSync: true } as any);
        logger.info(`[SCHEDULER] ✅ ${dayjs().format('HH:mm:ss')} - โอนข้อมูล Basic เสร็จสิ้น`);
      });
    }

    // Schedule OPD tables transfer - runs at configured interval
    // Fetches VN from configured opdDaysBack (default: 7 days ago) to today
    if (tablesConfig.opd.enabled) {
      this.scheduleJob('opd', tablesConfig.opd.schedule, async () => {
        const now = dayjs();
        const opdDaysBack = tablesConfig.opd.opdDaysBack || 7;
        
        // Calculate start date VN prefix (opdDaysBack ago)
        const startDay = now.subtract(opdDaysBack, 'day');
        const startBuddhistYear = (startDay.year() + 543) % 100;
        const fromPrefix = `${startBuddhistYear.toString().padStart(2, '0')}${startDay.format('MMDD')}`;

        // Calculate end date VN prefix (today)
        const endBuddhistYear = (now.year() + 543) % 100;
        const toPrefix = `${endBuddhistYear.toString().padStart(2, '0')}${now.format('MMDD')}`;
        
        logger.info(`[SCHEDULER] ⏰ ${now.format('DD/MM/YYYY HH:mm:ss')} - เริ่มโอนข้อมูล OPD (VN ย้อนหลัง ${opdDaysBack} วัน: ${fromPrefix} ถึง ${toPrefix})`);
        await transferEngine.transferOpd({ from: fromPrefix, to: toPrefix, workerId: 'scheduler-opd', source: 'scheduler', smartSync: true } as any);
        logger.info(`[SCHEDULER] ✅ ${dayjs().format('HH:mm:ss')} - โอนข้อมูล OPD เสร็จสิ้น`);
      });
    }

    // Schedule IPD tables transfer - runs at configured interval
    // Fetches AN where dchdate >= configured days ago, finds min AN, then fetches AN >= min AN
    if (tablesConfig.ipd.enabled) {
      this.scheduleJob('ipd', tablesConfig.ipd.schedule, async () => {
        const now = dayjs();
        const ipdDaysBack = (tablesConfig.ipd as { ipdDaysBack?: number }).ipdDaysBack || 45;
        logger.info(`[SCHEDULER] ⏰ ${now.format('DD/MM/YYYY HH:mm:ss')} - เริ่มโอนข้อมูล IPD (dchdate >= ${ipdDaysBack} วัน)`);
        await transferEngine.transferIpd({ ipdDaysBack, workerId: 'scheduler-ipd', source: 'scheduler', smartSync: true } as any);
        logger.info(`[SCHEDULER] ✅ ${dayjs().format('HH:mm:ss')} - โอนข้อมูล IPD เสร็จสิ้น`);
      });
    }

    logger.info(`[SCHEDULER] 🚀 Scheduler เริ่มทำงาน - Basic: ${tablesConfig.basic.schedule}, OPD: ${tablesConfig.opd.schedule}, IPD: ${tablesConfig.ipd.schedule}`);
  }

  private scheduleJob(name: string, cronExpression: string, task: () => Promise<void>): void {
    if (this.jobs[name]) {
      this.jobs[name].stop();
    }

    const job = cron.schedule(cronExpression, async () => {
      this.updateNextRun(name, cronExpression);
      // Run independently without lock
      try {
        await task();
      } catch (error) {
        const err = error as Error;
        logger.error(`Scheduled job ${name} failed: ${err.message}`);
      }
    });

    this.jobs[name] = job;
    this.updateNextRun(name, cronExpression);
    
    logger.info(`Scheduled job: ${name}`, { schedule: cronExpression });
  }

  private updateNextRun(name: string, cronExpression: string): void {
    // Calculate next run time using cron-parser v5
    try {
      const { CronExpressionParser } = require('cron-parser');
      const interval = CronExpressionParser.parse(cronExpression);
      const nextDate = interval.next().toDate();
      // Format as local time string
      this.nextRuns[name] = dayjs(nextDate).format('YYYY-MM-DDTHH:mm:ss');
    } catch (error) {
      const err = error as Error;
      logger.error(`Failed to parse cron expression for ${name}`, { error: err.message });
      this.nextRuns[name] = null;
    }
  }

  getNextRuns(): Record<string, string | null> {
    return { ...this.nextRuns };
  }

  getStatus(): SchedulerStatus {
    const tablesConfig = config.getTablesConfig();
    return {
      basic: {
        enabled: tablesConfig.basic.enabled,
        schedule: tablesConfig.basic.schedule,
        description: tablesConfig.basic.description,
        nextRun: this.nextRuns.basic || null,
      },
      opd: {
        enabled: tablesConfig.opd.enabled,
        schedule: tablesConfig.opd.schedule,
        description: tablesConfig.opd.description,
        nextRun: this.nextRuns.opd || null,
      },
      ipd: {
        enabled: tablesConfig.ipd.enabled,
        schedule: tablesConfig.ipd.schedule,
        description: tablesConfig.ipd.description,
        nextRun: this.nextRuns.ipd || null,
      },
    };
  }

  stop(): void {
    Object.values(this.jobs).forEach(job => job.stop());
    this.jobs = {};
    this.nextRuns = {};
    logger.info('Scheduler stopped');
  }

  restart(): void {
    logger.info('[SCHEDULER] 🔄 Reloading scheduler with new config...');
    this.stop();
    this.start();
    logger.info('[SCHEDULER] ✅ Scheduler restarted successfully');
  }

  runNow(type: TransferType): Promise<unknown> {
    logger.info(`Manual trigger: ${type}`);
    switch (type) {
      case 'basic':
        return transferEngine.transferBasic({ smartSync: true });
      case 'opd': {
        const tablesConfig = config.getTablesConfig();
        const opdDaysBack = tablesConfig.opd?.opdDaysBack || 7;
        const now = dayjs();
        const startDay = now.subtract(opdDaysBack, 'day');
        const startBuddhistYear = (startDay.year() + 543) % 100;
        const fromPrefix = `${startBuddhistYear.toString().padStart(2, '0')}${startDay.format('MMDD')}`;
        const endBuddhistYear = (now.year() + 543) % 100;
        const toPrefix = `${endBuddhistYear.toString().padStart(2, '0')}${now.format('MMDD')}`;
        logger.info(`Manual OPD: VN prefix ${fromPrefix} ถึง ${toPrefix} (ย้อนหลัง ${opdDaysBack} วัน)`);
        return transferEngine.transferOpd({ from: fromPrefix, to: toPrefix, smartSync: true });
      }
      case 'ipd': {
        // Use discharge date based query - find min AN where dchdate >= configured days ago
        const tablesConfig = config.getTablesConfig();
        const ipdDaysBack = (tablesConfig.ipd as { ipdDaysBack?: number }).ipdDaysBack || 45;
        logger.info(`Manual IPD: ดึง AN ที่ dchdate >= ${ipdDaysBack} วันย้อนหลัง`);
        return transferEngine.transferIpd({ ipdDaysBack, smartSync: true });
      }
      case 'all':
        return transferEngine.transferAll({ smartSync: true });
      default:
        throw new Error(`Unknown type: ${type}`);
    }
  }
}

export default new JobScheduler();
