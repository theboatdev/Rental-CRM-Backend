const { z } = require('zod');
const { BUILT_IN_FIELDS } = require('../platform/config/fields');
const { DEFAULT_FIELDS } = require('../platform/config/schema');
const { invalid } = require('../platform/errors');
const { zodIssues } = require('../platform/config/path');
const { DateStringSchema } = require('./common');

/**
 * The config's fields for vehicles, renters, rentals, payments and costs
 * (`fields.<section>`), applied to what the API takes in.
 *
 * - Built-in fields (`builtIn`): one that's off is dropped from the input,
 *   one that's required needs a value. Core fields are always on and their
 *   rules live in each record's input schema.
 * - Custom fields (`custom`): a record keeps their values in its
 *   `customFields` object, keyed by field key: text as strings, dates as
 *   YYYY-MM-DD, selects as the option key.
 *
 * A field that's off takes no values, and records keep the values they have.
 */

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** The section's field settings. A config that no longer validates may lack them, so they fall back to the defaults. */
const fieldsOf = (config, section) => config.fields?.[section] ?? DEFAULT_FIELDS[section];

/** Whether a built-in field takes values: it's on, and a second-currency rate needs a second currency. */
function builtInOn(config, section, field) {
  const settings = fieldsOf(config, section).builtIn[field.key] ?? DEFAULT_FIELDS[section].builtIn[field.key];
  return settings.active && !(field.secondaryCurrencyOnly && !config.locale.secondaryCurrency) ? settings : null;
}

/**
 * The issues the section's built-in field settings find in raw `input`, and
 * the keys of the fields that are off. On create, a required field needs a
 * value; on update, only a value that's sent counts, so it can't be cleared.
 * `prefix` is the input's path in the request, e.g. `advance.` for a booking's advance.
 */
function builtInRules(config, section, input, { update = false, prefix = '' } = {}) {
  const issues = [];
  const off = [];
  for (const field of BUILT_IN_FIELDS[section]) {
    if (field.core) continue;
    const settings = builtInOn(config, section, field);
    if (!settings) off.push(field.key);
    else if (settings.required) {
      const value = input[field.key];
      const blank = isBlank(value) || (field.type === 'contact' && isBlank(value?.name));
      if (update ? value !== undefined && blank : blank) issues.push({ path: `${prefix}${field.key}`, message: 'Required' });
    }
  }
  return { issues, off };
}

/**
 * Parses a record's input with its Zod `schema` and the section's built-in
 * field settings: fields that are off are dropped, required ones need a
 * value. `nested` applies another section's settings to an object in the
 * input, e.g. `{ advance: 'payments' }` for a booking's advance. Throws a
 * 422 listing every issue.
 */
function parseRecord(schema, input, config, section, { update = false, nested = {} } = {}) {
  const raw = input ?? {};
  const result = schema.safeParse(raw);
  const issues = result.success ? [] : zodIssues(result.error);
  const parts = [{ key: null, section, input: raw }];
  for (const [key, nestedSection] of Object.entries(nested)) {
    if (raw[key] && typeof raw[key] === 'object') parts.push({ key, section: nestedSection, input: raw[key] });
  }
  const dropped = parts.map((part) => {
    const rules = builtInRules(config, part.section, part.input, { update, prefix: part.key ? `${part.key}.` : '' });
    issues.push(...rules.issues.filter((issue) => !issues.some((other) => other.path === issue.path)));
    return { key: part.key, off: rules.off };
  });
  if (issues.length) throw invalid('Check the highlighted fields', issues);
  const data = { ...result.data };
  for (const { key, off } of dropped) {
    const target = key ? (data[key] = { ...data[key] }) : data;
    for (const field of off) delete target[field];
  }
  return data;
}

function valueSchema(field) {
  switch (field.type) {
    case 'text':
    case 'longText':
      return z.string().trim().max(field.maxLength);
    case 'number': {
      let schema = z.number({ error: 'Enter a number' });
      if (field.min != null) schema = schema.min(field.min);
      if (field.max != null) schema = schema.max(field.max);
      return schema;
    }
    case 'date':
      return DateStringSchema;
    case 'boolean':
      return field.required ? z.literal(true, { error: 'Must be ticked' }) : z.boolean();
    case 'select':
      return z.string().refine((key) => field.options.some((option) => option.key === key && option.active), { error: 'Pick one of the listed options' });
    default:
      throw new Error(`Unknown custom field type: ${field.type}`);
  }
}

/**
 * The `customFields` part of a record's input schema, for one section.
 *
 * - On create (the default), the output is `{ key: value }`. Blank values
 *   are left out, and every required field needs a value.
 * - With `update`, only the fields sent change. The output is
 *   `{ set: { key: value }, unset: [key] }`; a blank value (null or '')
 *   clears a field, unless it's required.
 *
 * Values for fields that are off are ignored; keys that aren't fields of the section are rejected.
 */
function customFieldsInput(config, section, { update = false } = {}) {
  const fields = new Map(fieldsOf(config, section).custom.map((field) => [field.key, field]));

  return z
    .record(z.string(), z.unknown())
    .prefault({})
    .transform((input, ctx) => {
      const issue = (key, message) => ctx.addIssue({ code: 'custom', message, path: [key], input });
      const set = {};
      const unset = [];

      for (const [key, value] of Object.entries(input)) {
        const field = fields.get(key);
        if (!field) issue(key, 'Not a field of this record');
        else if (!field.active) continue;
        else if (isBlank(value)) {
          if (update && field.required) issue(key, 'Required');
          else if (update) unset.push(key);
        } else {
          const result = valueSchema(field).safeParse(value);
          if (result.success) set[key] = result.data;
          else issue(key, result.error.issues[0].message);
        }
      }
      if (!update) {
        for (const field of fields.values()) {
          if (field.active && field.required && isBlank(input[field.key])) issue(field.key, 'Required');
        }
      }
      return update ? { set, unset } : set;
    });
}

/** MongoDB update operators that `$set` the record's `changes` and apply an update-mode `customFieldsInput` result. */
function updateWithCustomFields(changes, { set, unset }) {
  return {
    $set: { ...changes, ...Object.fromEntries(Object.entries(set).map(([key, value]) => [`customFields.${key}`, value])) },
    ...(unset.length ? { $unset: Object.fromEntries(unset.map((key) => [`customFields.${key}`, ''])) } : {})
  };
}

/** Keys of the custom fields an update-mode result actually changes on `record`. */
function changedCustomFields(record, { set, unset }) {
  const current = record.customFields ?? {};
  return [
    ...Object.keys(set).filter((key) => current[key] !== set[key]),
    ...unset.filter((key) => current[key] !== undefined)
  ];
}

module.exports = { fieldsOf, builtInRules, parseRecord, customFieldsInput, updateWithCustomFields, changedCustomFields };
