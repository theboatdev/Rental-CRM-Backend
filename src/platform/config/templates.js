const { TenantConfigSchema } = require('./schema');

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const CONFIG_TEMPLATES = {
  base: {
    label: 'Base (international)',
    description: 'USD, UTC, generic ID and license documents. WhatsApp digest and guest portal off.',
    config: TenantConfigSchema.parse(require('./templates/base.json'))
  },
  'sri-lanka': {
    label: 'Sri Lanka',
    description: 'LKR, Asia/Colombo, NIC / DL / Passport / IDP / DMT permit compliance, all modules on.',
    config: TenantConfigSchema.parse(require('./templates/sri-lanka.json'))
  }
};

const CONFIG_TEMPLATE_KEYS = Object.keys(CONFIG_TEMPLATES);

/** Recursively merges `patch` into `target`. Arrays and primitives in `patch` replace the target value. */
function deepMerge(target, patch) {
  if (patch === undefined) return target;
  if (!isPlainObject(target) || !isPlainObject(patch)) return patch;
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = deepMerge(result[key], value);
  }
  return result;
}

/** Builds a validated config from a template plus overrides (e.g. the tenant's name and limits). */
function createConfigFromTemplate(key, overrides) {
  const template = CONFIG_TEMPLATES[key];
  if (!template) throw new Error(`Unknown config template: ${key}`);
  return TenantConfigSchema.parse(deepMerge(structuredClone(template.config), overrides));
}

module.exports = { CONFIG_TEMPLATES, CONFIG_TEMPLATE_KEYS, deepMerge, createConfigFromTemplate };
