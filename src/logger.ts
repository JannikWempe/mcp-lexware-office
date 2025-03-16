import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(import.meta.dirname, "mcp-server.log");

function formatMessage(level: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
}

export const logger = {
  log(message: string, data?: unknown) {
    const logMessage = formatMessage("INFO", message, data);
    appendFileSync(LOG_FILE, logMessage);
  },
  error(message: string, data?: unknown) {
    const logMessage = formatMessage("ERROR", message, data);
    appendFileSync(LOG_FILE, logMessage);
    // errors get also reported to the console (and thus to the mcp client via stdio)
    console.error(logMessage);
  },
};
