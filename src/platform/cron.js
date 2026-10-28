/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * as `modules.whatsappDigest.cron` holds them, evaluated in a time zone.
 * Fields take `*`, numbers, ranges, steps and lists: `0 8 * * 1`,
 * `*\/15 9-17 * * 1-5`. Day of week 0 and 7 are Sunday. As in Vixie cron, when
 * both day fields are restricted, a day matching either one counts.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 }
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Can't read the ${name} field "${text}"`);
    const [, range, from, to, step] = match;
    const start = range === '*' ? min : Number(from);
    const end = range === '*' ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step !== undefined ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1) throw new Error(`The ${name} field "${text}" is out of range (${min}–${max})`);
    for (let value = start; value <= end; value += by) values.add(value);
  }
  return values;
}

/** Throws on an expression it can't read, naming the field. */
function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`"${expression}" isn't a 5-field cron expression`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) => parseField(field, FIELDS[index]));
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return { minute, hour, dayOfMonth, month, dayOfWeek, anyDayOfMonth: fields[2].startsWith('*'), anyDayOfWeek: fields[4].startsWith('*') };
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock minute, hour, day, month and weekday of an instant in a time zone. */
function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAYS[parts.weekday] };
}

function matches(cron, { minute, hour, day, month, weekday }) {
  if (!cron.minute.has(minute) || !cron.hour.has(hour) || !cron.month.has(month)) return false;
  const dayOfMonth = cron.dayOfMonth.has(day);
  const dayOfWeek = cron.dayOfWeek.has(weekday);
  if (cron.anyDayOfMonth || cron.anyDayOfWeek) return dayOfMonth && dayOfWeek;
  return dayOfMonth || dayOfWeek;
}

const MINUTE_MS = 60_000;

/**
 * The latest minute at or before `now`, at most `lookbackMinutes` back, at
 * which the expression fires in `timeZone`, or null. A scheduler ticking
 * every minute uses it to find the run that's due, and to catch up on one it
 * missed while it was down.
 */
function lastScheduledMinute(expression, timeZone, now, lookbackMinutes = 60) {
  const cron = parseCron(expression);
  const start = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let back = 0; back <= lookbackMinutes; back += 1) {
    const at = new Date(start - back * MINUTE_MS);
    if (matches(cron, zonedParts(at, timeZone))) return at;
  }
  return null;
}

module.exports = { parseCron, lastScheduledMinute };
