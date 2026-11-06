import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Client module is a browser artifact: it registers itself into
 * `window.__ModuleLoader__` and receives `react` plus the Cordis client context
 * from the host. These tests load it with stubs and assert what it declares, so
 * a manifest/slot mistake fails here instead of blanking the settings page.
 */

/** Monotonic cache-buster for the per-test artifact import. */
let counter = 0;

/** Capture the module the artifact registers. */
async function loadClient() {
  const registered = [];
  const previous = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        registered.push(definition);
      },
    },
  };
  try {
    // The artifact registers on import, and ESM caches by resolved URL. A
    // per-call cache-buster keeps each test's registration observable.
    const url = new URL('../client.js', import.meta.url);
    url.search = `?v=${counter++}`;
    await import(url.href);
  } finally {
    globalThis.window = previous;
  }
  assert.equal(registered.length, 1, 'exactly one module is registered');
  return registered[0];
}

/** A minimal React stand-in that only has to support what the module calls. */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
};

test('the module registers under the package name', async () => {
  const definition = await loadClient();
  assert.equal(definition.id, 'dsh-feishu-only');
  assert.equal(typeof definition.factory, 'function');
});

test('the module requires only react from the browser module table', async () => {
  const definition = await loadClient();
  const required = [];
  const module = definition.factory((name) => {
    required.push(name);
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected module: ${name}`);
  });
  assert.deepEqual(required, ['react']);
  assert.equal(typeof module.apply, 'function');
});

test('the client declares the services it needs', async () => {
  const definition = await loadClient();
  const module = definition.factory(() => fakeReact);
  assert.deepEqual(module.inject, ['slots', 'locale']);
});

test('the module registers a settings.section and nothing else', async () => {
  const definition = await loadClient();
  const module = definition.factory(() => fakeReact);

  const registrations = [];
  const dictionaries = [];
  const effects = [];

  const ctx = {
    // The real Cordis context runs an effect body immediately and keeps its
    // returned disposer; recording without invoking would hide the
    // registrations the body performs.
    effect(fn) {
      effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'settings.section');
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);

  assert.equal(registrations.length, 1, 'one page is contributed');
  assert.equal(registrations[0].options.name, 'settings.section');
  assert.equal(registrations[0].options.id, 'dsh-feishu-only');
  assert.equal(typeof registrations[0].options.order, 'number');
  assert.equal(registrations[0].options.locale, 'dsh-feishu-only');
  assert.equal(typeof registrations[0].component, 'function');

  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, 'dsh-feishu-only');
  assert.ok(dictionaries[0].dicts.zh);
  assert.ok(dictionaries[0].dicts.en);
  assert.ok(effects.length >= 1, 'styles and dictionaries are effects');
});

test('the nav label is a thunk so it follows the active locale', async () => {
  const definition = await loadClient();
  const module = definition.factory(() => fakeReact);
  let captured;
  module.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: () => () => {},
      bind: () => (key) => `T:${key}`,
    },
    slots: {
      inject: (_owner, callback) => callback(),
      register: (options) => {
        captured = options;
        return () => {};
      },
    },
  });
  assert.equal(typeof captured.label, 'function', 'a thunk re-reads the locale');
  assert.equal(captured.label(), 'T:title');
});

test('both locale dictionaries cover the same keys', async () => {
  const definition = await loadClient();
  const module = definition.factory(() => fakeReact);
  let dicts;
  module.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: (_ns, value) => {
        dicts = value;
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: { inject: (_o, cb) => cb(), register: () => () => {} },
  });
  const zh = Object.keys(dicts.zh).sort();
  const en = Object.keys(dicts.en).sort();
  assert.deepEqual(zh, en, 'a missing translation would fall back to a raw key');
  for (const [key, value] of Object.entries(dicts.zh)) {
    assert.ok(typeof value === 'string' && value.length > 0, `zh.${key} is populated`);
  }
  for (const [key, value] of Object.entries(dicts.en)) {
    assert.ok(typeof value === 'string' && value.length > 0, `en.${key} is populated`);
  }
});

test('the page component renders without throwing', async () => {
  const definition = await loadClient();
  const module = definition.factory(() => fakeReact);
  let Page;
  module.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_o, cb) => cb(),
      register: (_options, component) => {
        Page = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof Page, 'function');
  // The registered component is a zero-arg wrapper that binds `t`.
  const element = Page();
  assert.ok(element, 'the page produced an element tree');
});