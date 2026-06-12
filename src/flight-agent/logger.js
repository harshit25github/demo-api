import { flightAgentConfig } from './config.js';

const LEVELS = {
  debug: 10,
  info: 20,
  error: 50,
  silent: 99,
};

function shouldLog(level) {
  const activeLevel = LEVELS[flightAgentConfig.logLevel] ?? LEVELS.info;
  return LEVELS[level] >= activeLevel;
}

function sanitize(value) {
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

export function log(level, event, details = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...sanitize(details),
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
