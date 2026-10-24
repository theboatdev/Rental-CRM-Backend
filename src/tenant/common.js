const { z } = require('zod');
const { isObjectIdOrHexString } = require('mongoose');
const { invalid, notFound } = require('../platform/errors');
const { zodIssues } = require('../platform/config/path');

/**
 * Helpers shared by the tenant operations (vehicles, renters, rentals,
 * payments, costs). Calendar dates such as a rental's start travel as
 * "YYYY-MM-DD" strings and are stored as UTC midnight; "today" is always the
 * tenant's today, in its config's timezone.
 */

const DAY_MS = 86_400_000;

const iso = (date) => (date ? new Date(date).toISOString() : null);
const toDate = (dateString) => new Date(`${dateString}T00:00:00.000Z`);
const dateString = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);
const addDays = (dateString_, days) => dateString(new Date(toDate(dateString_).getTime() + days * DAY_MS));
const daysBetween = (start, end) => Math.round((toDate(end) - toDate(start)) / DAY_MS);

/** Today's date in a timezone, as YYYY-MM-DD. */
const todayIn = (timeZone, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use the YYYY-MM-DD format' })
  .refine((value) => dateString(toDate(value)) === value, { error: 'Not a real date' });

const IdSchema = z.string().refine(isObjectIdOrHexString, { error: 'Unknown id' });

/** A key from one of the config's lists that is still active, e.g. a payment method. */
const activeListKey = (config, list) =>
  z.string().refine((key) => config.lists[list].some((item) => item.key === key && item.active), { error: 'Pick one of the listed options' });

/** Parses input with a Zod schema, or throws a 422 with the field issues. */
function parse(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw invalid('Check the highlighted fields', zodIssues(result.error));
  return result.data;
}

/** A document by id, or a 404 naming `label`. Ids that aren't ObjectIds never reach the query. */
async function findOr404(Model, id, label, { session, populate } = {}) {
  let query = isObjectIdOrHexString(id) ? Model.findById(id).session(session ?? null) : null;
  if (query && populate) for (const [path, select] of Object.entries(populate)) query = query.populate(path, select);
  const document = query ? await query.lean() : null;
  if (!document) throw notFound(`${label} not found`);
  return document;
}

/** Runs `fn(session)` in a transaction on the tenant's database (Mongoose retries transient conflicts). */
const inTransaction = (ctx, fn) => ctx.models.Counter.db.transaction(fn);

/**
 * Inside a transaction, bumps a lock document so that concurrent transactions
 * on the same thing (a vehicle's bookings, the Owners) conflict, and Mongoose
 * retries the later one against the committed data.
 */
const lock = (ctx, key, session) =>
  ctx.models.Counter.updateOne({ _id: `lock:${key}` }, { $inc: { seq: 1 } }, { upsert: true, session });

/** The next human-readable code, e.g. RNT-2026-0042 (with a year) or SR-0146 (without). */
async function nextCode(ctx, { prefix, sequence, year, session }) {
  const seq = await ctx.models.Counter.next(year ? `${sequence}:${year}` : sequence, { session });
  return year ? `${prefix}-${year}-${String(seq).padStart(4, '0')}` : `${prefix}-${String(seq).padStart(4, '0')}`;
}

const actorOf = (actor) => (actor ? { id: actor.id, name: actor.name } : null);

const can = (ctx, permission) => ctx.permissions.has(permission);
const moduleOn = (ctx, moduleKey) => ctx.config.modules[moduleKey].enabled;

module.exports = {
  DAY_MS,
  iso,
  toDate,
  dateString,
  addDays,
  daysBetween,
  todayIn,
  DateStringSchema,
  IdSchema,
  activeListKey,
  parse,
  findOr404,
  inTransaction,
  lock,
  nextCode,
  actorOf,
  can,
  moduleOn
};
