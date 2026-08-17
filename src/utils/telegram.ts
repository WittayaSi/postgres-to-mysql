import axios from 'axios';
import fs from 'fs';
import path from 'path';
import logger from './logger';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

const configPath = path.join(process.cwd(), 'config/telegram.json');

export function loadTelegramConfig(): TelegramConfig {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as TelegramConfig;
    }
  } catch (error) {
    const err = error as Error;
    logger.error('Error loading Telegram config', { error: err.message });
  }
  
  // Default empty config
  return {
    enabled: false,
    botToken: '',
    chatId: ''
  };
}

export function saveTelegramConfig(config: TelegramConfig): void {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    const err = error as Error;
    logger.error('Error saving Telegram config', { error: err.message });
  }
}

export async function sendTelegramMessage(message: string, config?: TelegramConfig): Promise<boolean> {
  const tgConfig = config || loadTelegramConfig();
  
  if (!tgConfig.enabled || !tgConfig.botToken || !tgConfig.chatId) {
    return false;
  }
  
  try {
    const url = `https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`;
    await axios.post(url, {
      chat_id: tgConfig.chatId,
      text: message,
      parse_mode: 'HTML' // Allow some basic formatting
    });
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to send Telegram message', { error: err.message });
    return false;
  }
}
