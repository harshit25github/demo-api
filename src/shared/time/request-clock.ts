export interface RequestClock {
  localDate: string;
  localDateTime: string;
  timeZone: string;
}

function formatterParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const remainder = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${remainder}`;
}

export function createRequestClock({
  now = new Date(),
  timeZone = process.env.FLIGHT_AGENT_TIMEZONE ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC',
}: { now?: Date | string | number; timeZone?: string } = {}): Readonly<RequestClock> {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw new Error('now must be a valid date or timestamp.');
  }

  let parts;
  try {
    parts = formatterParts(instant, timeZone);
  } catch {
    timeZone = 'UTC';
    parts = formatterParts(instant, timeZone);
  }

  const localDate = [parts.year, parts.month, parts.day]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, '0')))
    .join('-');
  const localTime = [parts.hour, parts.minute, parts.second]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  const representedUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const instantAtSecond = Math.floor(instant.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((representedUtcMs - instantAtSecond) / 60000);

  return Object.freeze({
    localDate,
    localDateTime: `${localDate}T${localTime}${formatOffset(offsetMinutes)}`,
    timeZone,
  });
}
