const { formatPath } = require('./path');

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Lists the leaf-level differences between two config documents as
 * `{ path, kind: 'added' | 'removed' | 'changed', before?, after? }`.
 * Arrays of equal length are compared item by item; arrays that grew or
 * shrank are reported as one change so reorders and inserts stay readable.
 */
function diffConfigs(before, after) {
  const changes = [];

  const walk = (a, b, segments) => {
    if (isEqual(a, b)) return;

    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        if (!(key in b)) changes.push({ path: formatPath([...segments, key]), kind: 'removed', before: a[key] });
        else if (!(key in a)) changes.push({ path: formatPath([...segments, key]), kind: 'added', after: b[key] });
        else walk(a[key], b[key], [...segments, key]);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((item, index) => walk(item, b[index], [...segments, index]));
      return;
    }

    changes.push({ path: formatPath(segments), kind: 'changed', before: a, after: b });
  };

  walk(before, after, []);
  return changes;
}

/**
 * List keys present in `before` but missing from `after`. Tenant records store
 * these keys, so removing one orphans existing data; deactivate it instead.
 */
function removedListKeys(before, after) {
  const removed = [];
  for (const [list, items] of Object.entries(before.lists)) {
    const remaining = new Set((after.lists?.[list] ?? []).map((item) => item.key));
    for (const item of items) if (!remaining.has(item.key)) removed.push({ list, key: item.key });
  }
  return removed;
}

/**
 * Custom field changes that affect values records already hold, as
 * `{ section, key, kind, ... }`: a field removed (records keep its values,
 * but nobody can see or edit them), its type changed (old values no longer
 * fit), or a select option removed. Deactivating avoids all three.
 */
function customFieldChanges(before, after) {
  const changes = [];
  for (const [section, { custom = [] } = {}] of Object.entries(before.fields ?? {})) {
    const remaining = new Map((after.fields?.[section]?.custom ?? []).map((field) => [field.key, field]));
    for (const field of custom) {
      const next = remaining.get(field.key);
      if (!next) changes.push({ section, key: field.key, kind: 'removed' });
      else if (next.type !== field.type) changes.push({ section, key: field.key, kind: 'typeChanged', before: field.type, after: next.type });
      else if (field.type === 'select') {
        const options = new Set(next.options.map((option) => option.key));
        for (const option of field.options) {
          if (!options.has(option.key)) changes.push({ section, key: field.key, kind: 'optionRemoved', option: option.key });
        }
      }
    }
  }
  return changes;
}

module.exports = { diffConfigs, removedListKeys, customFieldChanges };
