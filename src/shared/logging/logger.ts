type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 50,
  silent: 99,
};

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = process.env.AGENT_LOG_LEVEL || process.env.FLIGHT_AGENT_LOG_LEVEL || 'info';
  const activeLevel = LEVELS[configuredLevel as LogLevel] ?? LEVELS.info;
  return LEVELS[level] >= activeLevel;
}

function sanitize(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  return JSON.parse(
    JSON.stringify(value, (key, nestedValue) => {
      if (/api[_-]?key|authorization|token|secret/i.test(key)) {
        return '[redacted]';
      }
      return nestedValue;
    }),
  );
}

export function log(
  level: LogLevel,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...(sanitize(details) as Record<string, unknown>),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
