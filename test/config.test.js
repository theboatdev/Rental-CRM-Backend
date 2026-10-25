const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTenantConfig, withConfigDefaults, getTenantConfigJsonSchema } = require('../src/platform/config/schema');
const { CONFIG_TEMPLATES, CONFIG_TEMPLATE_KEYS, createConfigFromTemplate } = require('../src/platform/config/templates');
const { diffConfigs, removedListKeys, customFieldChanges } = require('../src/platform/config/diff');

const sriLanka = () => structuredClone(CONFIG_TEMPLATES['sri-lanka'].config);

function issuesFor(config) {
  const result = parseTenantConfig(config);
  assert.equal(result.success, false, 'expected config to be rejected');
  return result.issues;
}
const paths = (config) => issuesFor(config).map((issue) => issue.path);

describe('config templates', () => {
  for (const key of CONFIG_TEMPLATE_KEYS) {
    it(`${key} template is valid`, () => assert.equal(parseTenantConfig(CONFIG_TEMPLATES[key].config).success, true));
  }

  it('applies overrides on top of a template', () => {
    const config = createConfigFromTemplate('sri-lanka', {
      branding: { displayName: 'Shenaly Rent a Car', shortName: 'Shenaly', primaryColor: '#FF4F00' },
      rules: { codePrefixes: { renter: 'SR' } }
    });
    assert.equal(config.branding.displayName, 'Shenaly Rent a Car');
    assert.equal(config.rules.codePrefixes.renter, 'SR');
    assert.equal(config.rules.codePrefixes.rental, 'RNT');
    assert.equal(config.locale.currency, 'LKR');
  });

  it('does not mutate the template', () => {
    createConfigFromTemplate('base', { branding: { displayName: 'Changed' } });
    assert.equal(CONFIG_TEMPLATES.base.config.branding.displayName, 'New Rental Company');
  });
});

describe('config validation', () => {
  it('rejects unknown modules and keys', () => {
    const config = sriLanka();
    config.modules.telematics = { enabled: true };
    assert.ok(paths(config).includes('modules'));
  });

  it('rejects bad currency, time zone and colour', () => {
    const config = sriLanka();
    config.locale.currency = 'ABC';
    config.locale.timezone = 'Mars/Olympus';
    config.branding.primaryColor = 'orange';
    const found = paths(config);
    for (const path of ['locale.currency', 'locale.timezone', 'branding.primaryColor']) assert.ok(found.includes(path), path);
  });

  it('enforces module dependencies', () => {
    const config = sriLanka();
    config.modules.rentals.enabled = false;
    const found = paths(config);
    assert.ok(found.includes('modules.calendar.enabled'));
    assert.ok(found.includes('modules.payments.enabled'));
  });

  it('requires enabled tab modules to be in navigation', () => {
    const config = sriLanka();
    config.navigation = config.navigation.filter((item) => item.module !== 'payments');
    assert.deepEqual(
      issuesFor(config).find((issue) => issue.path === 'navigation'),
      { path: 'navigation', message: 'Payment Ledger is enabled but missing from navigation' }
    );
  });

  it('checks tourist permit keys against document types', () => {
    const config = sriLanka();
    config.rules.touristPermitDocumentKeys = ['IDP', 'VISA'];
    assert.ok(paths(config).includes('rules.touristPermitDocumentKeys[1]'));
  });

  it('rejects duplicate list keys', () => {
    const config = sriLanka();
    config.lists.paymentMethods.push({ key: 'CASH', label: 'Cash again', active: true });
    assert.ok(paths(config).includes('lists.paymentMethods[4].key'));
  });

  it('rejects a secondary currency equal to the main one', () => {
    const config = sriLanka();
    config.locale.secondaryCurrency = 'LKR';
    assert.ok(paths(config).includes('locale.secondaryCurrency'));
  });

  it('generates a JSON Schema for editors', () => {
    const schema = getTenantConfigJsonSchema();
    for (const key of ['branding', 'locale', 'modules', 'navigation', 'lists', 'rules', 'limits']) {
      assert.ok(key in schema.properties, key);
    }
  });
});

describe('diffConfigs', () => {
  it('lists leaf changes with readable paths', () => {
    const before = sriLanka();
    const after = sriLanka();
    after.branding.primaryColor = '#FF4F00';
    after.modules.fuelLogs.enabled = false;
    after.lists.paymentMethods.pop();
    const changes = diffConfigs(before, after);
    assert.deepEqual(changes.slice(0, 2), [
      { path: 'branding.primaryColor', kind: 'changed', before: '#2563EB', after: '#FF4F00' },
      { path: 'modules.fuelLogs.enabled', kind: 'changed', before: true, after: false }
    ]);
    assert.equal(changes[2].path, 'lists.paymentMethods');
    assert.equal(changes.length, 3);
  });

  it('returns nothing for identical configs', () => {
    assert.deepEqual(diffConfigs(sriLanka(), sriLanka()), []);
  });
});

describe('removedListKeys', () => {
  it('reports keys that disappeared from a list', () => {
    const before = sriLanka();
    const after = sriLanka();
    after.lists.costCategories = after.lists.costCategories.filter((c) => c.key !== 'SUSPENSION');
    assert.deepEqual(removedListKeys(before, after), [{ list: 'costCategories', key: 'SUSPENSION' }]);
  });
});

describe('fields', () => {
  const field = (overrides) => ({ key: 'insuranceExpiry', label: 'Insurance expiry', type: 'date', ...overrides });
  const colour = () => ({
    key: 'colour',
    label: 'Colour',
    type: 'select',
    options: [{ key: 'WHITE', label: 'White' }, { key: 'BLACK', label: 'Black' }]
  });
  const withCustom = (section, custom) => {
    const config = sriLanka();
    config.fields[section].custom = custom;
    return config;
  };

  it('lists every built-in field with its defaults, so older configs stay valid', () => {
    const config = sriLanka();
    delete config.fields;
    const { success, data } = parseTenantConfig(config);
    assert.equal(success, true);
    assert.deepEqual(Object.keys(data.fields), ['vehicles', 'renters', 'rentals', 'payments', 'costs']);
    assert.deepEqual(data.fields.vehicles.builtIn.plateNumber, { label: 'Registration plate', helpText: '', active: true, required: true, showInList: true });
    assert.deepEqual(data.fields.vehicles.builtIn.notes, { label: 'Notes', helpText: '', active: true, required: false, showInList: false });
    assert.equal(data.fields.vehicles.builtIn.year.required, true);
    assert.deepEqual(data.fields.costs.custom, []);
    assert.deepEqual(withConfigDefaults(config).fields.renters.builtIn.email.active, true);
  });

  it('fills in a built-in field left out of the config', () => {
    const config = sriLanka();
    config.fields.renters.builtIn = { email: { label: 'E-mail', required: true } };
    const { data } = parseTenantConfig(config);
    assert.deepEqual(data.fields.renters.builtIn.email, { label: 'E-mail', helpText: '', active: true, required: true, showInList: true });
    assert.equal(data.fields.renters.builtIn.fullName.label, 'Full legal name');
  });

  it('keeps core fields on and required, and rejects unknown built-in keys', () => {
    const config = sriLanka();
    config.fields.vehicles.builtIn.plateNumber.active = false;
    config.fields.payments.builtIn.amount.required = false;
    config.fields.rentals.builtIn.startDate.showInList = false;
    config.fields.costs.builtIn.mood = { label: 'Mood' };
    assert.deepEqual(paths(config).sort(), [
      'fields.costs.builtIn',
      'fields.payments.builtIn.amount.required',
      'fields.rentals.builtIn.startDate.showInList',
      'fields.vehicles.builtIn.plateNumber.active'
    ]);
  });

  it('fills in custom field defaults by type', () => {
    const { data } = parseTenantConfig(withCustom('vehicles', [{ key: 'gpsSerial', label: 'GPS serial', type: 'text' }, colour()]));
    assert.deepEqual(data.fields.vehicles.custom[0], {
      key: 'gpsSerial',
      label: 'GPS serial',
      type: 'text',
      required: false,
      active: true,
      showInList: false,
      helpText: '',
      maxLength: 200
    });
    assert.equal(data.fields.vehicles.custom[1].options[0].active, true);
  });

  it('rejects bad keys, built-in or duplicate keys, unknown types and settings of another type', () => {
    const config = sriLanka();
    config.fields.vehicles.custom = [field(), field({ label: 'Again' }), field({ key: 'Bad_Key' }), field({ key: 'profit', type: 'number' }), field({ key: 'mileage' })];
    config.fields.renters.custom = [field({ key: 'shoeSize', type: 'colour' }), field({ key: 'nickname', type: 'text', options: [] })];
    config.fields.rentals.custom = [field({ key: 'pax', type: 'number', min: 5, max: 2 }), { ...colour(), options: [] }];
    assert.deepEqual(paths(config).sort(), [
      'fields.rentals.custom[0].max',
      'fields.rentals.custom[1].options',
      'fields.renters.custom[0].type',
      'fields.renters.custom[1]',
      'fields.vehicles.custom[1].key',
      'fields.vehicles.custom[2].key',
      'fields.vehicles.custom[3].key',
      'fields.vehicles.custom[4].key'
    ]);
  });

  it('allows at most 20 custom fields per section', () => {
    const config = withCustom('costs', Array.from({ length: 21 }, (_, index) => field({ key: `field${index}` })));
    assert.deepEqual(paths(config), ['fields.costs.custom']);
  });

  it('warns about removed custom fields, type changes and removed options, but not deactivations', () => {
    const before = sriLanka();
    before.fields.vehicles.custom = [field(), colour(), field({ key: 'seats', type: 'number', min: null, max: null })];
    before.fields.costs.custom = [field({ key: 'garage', type: 'text', maxLength: 200 })];
    const after = structuredClone(before);
    after.fields.vehicles.custom[0].active = false;
    after.fields.vehicles.custom[1].options = [colour().options[0]];
    after.fields.vehicles.custom[2] = field({ key: 'seats', type: 'text', maxLength: 200 });
    after.fields.costs.custom = [];
    after.fields.vehicles.builtIn.notes.active = false;
    assert.deepEqual(customFieldChanges(before, after), [
      { section: 'vehicles', key: 'colour', kind: 'optionRemoved', option: 'BLACK' },
      { section: 'vehicles', key: 'seats', kind: 'typeChanged', before: 'number', after: 'text' },
      { section: 'costs', key: 'garage', kind: 'removed' }
    ]);
  });
});
