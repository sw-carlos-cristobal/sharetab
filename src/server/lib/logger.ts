type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

// ─── In-memory log buffer (ring buffer) ───────────────────

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

const LOG_BUFFER_SIZE = 1000;
const logBuffer: LogEntry[] = [];
let logCounter = 0;

function bufferLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: ++logCounter,
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(data ? { data } : {}),
  };

  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Get recent log entries from the in-memory buffer.
 * Supports filtering by level (minimum) and text search.
 */
export function getRecentLogs(options?: {
  minLevel?: LogLevel;
  search?: string;
  limit?: number;
  afterId?: number;
}): { entries: LogEntry[]; latestId: number } {
  const { minLevel, search, limit = 200, afterId } = options ?? {};

  let entries = logBuffer;

  if (afterId) {
    entries = entries.filter((e) => e.id > afterId);
  }

  if (minLevel) {
    const minOrder = LEVEL_ORDER[minLevel];
    entries = entries.filter((e) => LEVEL_ORDER[e.level] >= minOrder);
  }

  if (search) {
    const lower = search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.msg.toLowerCase().includes(lower) ||
        (e.data && JSON.stringify(e.data).toLowerCase().includes(lower))
    );
  }

  // Return the most recent entries (tail)
  const result = entries.slice(-limit);

  return {
    entries: result,
    latestId: logCounter,
  };
}

// ─── Core log function ────────────────────────────────────

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  // Always buffer for admin UI (even debug when min level filters console)
  bufferLog(level, message, data);

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
