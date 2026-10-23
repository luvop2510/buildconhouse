import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Run the actual provider with controlled hooks and deferred external work,
// following test-stock-floor-races. All identities/credentials are fixtures.
// An optional source path supports a before-fix negative control.
const source = readFileSync(process.argv[2] || new URL('../src/state/auth.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const staff = (id, custom = false) => ({ id, role: custom ? 'worker' : 'owner', floor_ids: ['first-floor'], custom_access: custom });
const customer = id => ({ id, tier: 'retail' });
const loginResponse = kind => kind === 'staff'
  ? { access_token: 'fixture-new-credential', user: staff('new-staff') }
  : { access_token: 'fixture-new-credential', customer: customer('new-customer') };

function provider(platform, options = {}) {
  const hooks = [], effects = [], gets = [], posts = [], writes = [];
  const timers = new Map();
  const listeners = new Map();
  const events = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  const document = { ...events, visibilityState: 'visible' };
  let timerId = 0;
  let index = 0, dirty = false, state, draftClears = 0, tokenClears = 0, stateWrites = 0, floorReads = 0, mounted = true;
  let token = 'fixture-old-credential', storedToken = token, kind = options.initialKind || 'staff';
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createContext: () => ({ Provider: 'AuthProvider' }),
    useState(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, value => {
        stateWrites++;
        const next = typeof value === 'function' ? value(hooks[slot].value) : value;
        if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const slot = index++; return hooks[slot] ||= { current: initial }; },
    useCallback(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback, deps };
      return hooks[slot].value;
    },
    useMemo(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) hooks[slot] = { value: callback(), deps };
      return hooks[slot].value;
    },
    useEffect(callback, deps) {
      const slot = index++;
      if (!same(hooks[slot]?.deps, deps)) {
        const cleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps, setup: callback };
        effects.push(() => { cleanup?.(); hooks[slot].cleanup = callback(); });
      }
    },
  };
  const modules = {
    '@/src/lib/backend-startup': { ensureBackendReady: async () => {} },
    react,
    'react/jsx-runtime': { jsx: (_type, props) => ({ props }) },
    'react-native': { Platform: { OS: platform }, AppState: { addEventListener: (name, listener) => { listeners.set(name, listener); return { remove() { listeners.delete(name); } }; } } },
    '@/src/components/quotation/helpers/draftStorage': {
      clearBuilderDrafts: async () => { draftClears++; await options.draftCleanup?.promise; },
      ensureBuilderDraftReset: async () => { await options.startupDraftReset?.promise; },
    },
    '@/src/api/client': {
      getTokenKind: async () => kind,
      getToken: async () => token,
      setToken: async (value, nextKind) => {
        writes.push(nextKind); token = value; kind = nextKind;
        if (options.abortHydrationOnLogin) gets[0].reject(new DOMException('Fixture cancelled', 'AbortError'));
        storedToken = value;
      },
      clearToken: async () => {
        tokenClears++; token = null; kind = null;
        await options.credentialDeletion?.promise;
        storedToken = null;
      },
      api: {
        get: path => { const work = deferred(); gets.push({ path, ...work }); return work.promise; },
        post: path => { const work = deferred(); posts.push({ path, ...work }); return work.promise; },
      },
    },
    '@/src/hooks/use-floor-access': {
      resetFloorAccess: () => {}, getSelectedFloorId: async () => 'first-floor',
      getFloorAccess: async () => { floorReads++; return options.floorAccess ? options.floorAccess.promise : { floor_ids: ['first-floor'] }; }, setSelectedFloorId: async () => {},
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, Error, window: events, document, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id), require: name => {
    assert.ok(modules[name], `Unexpected provider dependency: ${name}`);
    return modules[name];
  } });
  const render = () => {
    index = 0; dirty = false;
    state = exports.AuthProvider({ children: null }).props.value;
    while (effects.length) effects.shift()();
    return state;
  };
  const fixture = {
    gets, posts, writes,
    get pendingRetries() { return timers.size; },
    foreground() { if (platform === 'web') listeners.get('online')?.(); else listeners.get('change')?.('active'); },
    retryAutomatically() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1](); },
    get state() { return state; },
    get draftClears() { return draftClears; },
    get tokenClears() { return tokenClears; },
    get stateWrites() { return stateWrites; },
    get floorReads() { return floorReads; },
    get hasStoredCredential() { return storedToken === 'fixture-new-credential'; },
    get hasCredential() { return token === 'fixture-new-credential'; },
    render,
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); },
    replayEffects() {
      // React StrictMode replays effects on the SAME hook/ref/state instance.
      // Do not construct another provider or reset hooks to simulate it.
      const activeEffects = hooks.filter(hook => typeof hook.setup === 'function');
      for (const hook of activeEffects) hook.cleanup?.();
      for (const hook of activeEffects) hook.cleanup = hook.setup();
    },
    async settle() { for (let i = 0; i < 24; i++) { await Promise.resolve(); if (dirty && mounted) render(); } },
    async beginLogin(nextKind) {
      const promise = state[nextKind === 'staff' ? 'loginStaff' : 'loginCustomer']('fixture@example.invalid', 'fixture-password');
      await fixture.settle();
      posts.at(-1).resolve(loginResponse(nextKind));
      return promise;
    },
  };
  render();
  return fixture;
}

function assertLogin(fixture, kind) {
  assert.equal(fixture.state.kind, kind);
  assert.equal(fixture.state[kind]?.id, `new-${kind}`);
  assert.equal(fixture.state[kind === 'staff' ? 'customer' : 'staff'], null);
  assert.equal(fixture.state.loading, false);
  assert.equal(fixture.hasCredential, true, 'new credentials survive obsolete hydration');
  assert.equal(fixture.hasStoredCredential, true, 'new persisted credentials survive obsolete hydration');
}

for (const platform of ['web', 'ios', 'android']) {
  for (const first of ['floor', 'grants']) {
    test(`${platform}: delegated login loads floors and grants together, waiting for ${first === 'floor' ? 'grants' : 'floors'} before publishing identity`, async () => {
      const floorAccess = deferred();
      const fixture = provider(platform, { floorAccess });
      await fixture.settle();
      const login = fixture.state.loginStaff('fixture', 'fixture-password');
      await fixture.settle();
      fixture.posts[0].resolve({ access_token: 'fixture-new-credential', user: staff('new-staff', true) });
      await fixture.settle();
      assert.equal(fixture.floorReads, 1);
      assert.equal(fixture.gets[1].path, '/settings/access-grants/me', 'grants transport starts before floor transport finishes');
      const finishFloor = () => floorAccess.resolve({ floor_ids: ['first-floor'] });
      const finishGrants = () => fixture.gets[1].resolve({ grants: [{ resource: 'quotations' }] });
      if (first === 'floor') finishFloor(); else finishGrants();
      await fixture.settle();
      assert.equal(fixture.state.loading, true);
      assert.equal(fixture.state.kind, null);
      if (first === 'floor') finishGrants(); else finishFloor();
      await login; await fixture.settle();
      assertLogin(fixture, 'staff');
      assert.equal(fixture.state.staff.access_grants[0].resource, 'quotations');
    });
  }

  test(`${platform}: logout supersedes both overlapping delegated-login reads`, async () => {
    const floorAccess = deferred();
    const fixture = provider(platform, { floorAccess });
    await fixture.settle();
    const login = fixture.state.loginStaff('fixture', 'fixture-password');
    await fixture.settle();
    fixture.posts[0].resolve({ access_token: 'fixture-new-credential', user: staff('new-staff', true) });
    await fixture.settle();
    const logout = fixture.state.logout();
    fixture.posts[1].resolve({}); await logout; await fixture.settle();
    floorAccess.resolve({ floor_ids: ['first-floor'] });
    fixture.gets[1].resolve({ grants: [{ resource: 'quotations' }] });
    await login; await fixture.settle();
    assert.equal(fixture.state.kind, null);
    assert.equal(fixture.state.staff, null);
    assert.equal(fixture.state.loading, false);
    assert.equal(fixture.tokenClears, 1);
  });

  test(`${platform}: floor-settings outage retains delegated login fallback without skipping grants`, async () => {
    const floorAccess = deferred();
    const fixture = provider(platform, { floorAccess });
    await fixture.settle();
    const login = fixture.state.loginStaff('fixture', 'fixture-password');
    await fixture.settle();
    fixture.posts[0].resolve({ access_token: 'fixture-new-credential', user: staff('new-staff', true) });
    await fixture.settle();
    floorAccess.reject(Object.assign(new Error('Fixture temporary outage'), { status: 503 }));
    fixture.gets[1].resolve({ grants: [{ resource: 'quotations' }] });
    await login; await fixture.settle();
    assertLogin(fixture, 'staff');
  });

  test(`${platform}: owner hydration clears legacy delegation and password restrictions`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    fixture.gets[0].resolve({ ...staff('owner'), custom_access: true, access_profile: 'sanitary_purchases', access_grants: [], floor_ids: [], must_change_password: true });
    await fixture.settle();
    assert.equal(fixture.gets.length, 1, 'owner never waits on delegated grant lookup');
    assert.equal(fixture.state.staff.custom_access, false);
    assert.equal(fixture.state.staff.access_profile, null);
    assert.equal(fixture.state.staff.access_grants, undefined);
    assert.equal(fixture.state.staff.must_change_password, false);
    assert.equal(fixture.state.loading, false);
  });

  test(`${platform}: member hydration clears obsolete force-change requirement`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    fixture.gets[0].resolve({ ...staff('member'), role: 'worker', must_change_password: true });
    await fixture.settle();
    assert.equal(fixture.state.staff.must_change_password, false);
    assert.equal(fixture.state.staff.role, 'worker');
    assert.equal(fixture.state.loading, false);
  });

  for (const failure of [
    { label: 'canceled', error: () => new DOMException('Fixture canceled transport', 'AbortError') },
    { label: 'temporarily unavailable', error: () => Object.assign(new Error('Fixture server outage'), { status: 503 }) },
    { label: 'network failure', error: () => new TypeError('Fixture network failure') },
  ]) {
    test(`${platform}: ${failure.label} hydration preserves session storage without publishing identity`, async () => {
      const fixture = provider(platform);
      await fixture.settle();
      fixture.gets[0].reject(failure.error());
      await fixture.settle();
      assert.equal(fixture.tokenClears, 0, 'a transport failure must not erase another document’s stored session');
      assert.equal(fixture.draftClears, 0, 'a transport failure is not an account revocation');
      assert.equal(fixture.state.kind, null);
      assert.equal(fixture.state.staff, null);
      assert.equal(fixture.state.loading, false);
    });
  }

  test(`${platform}: authoritative forbidden hydration still revokes credentials`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    fixture.gets[0].reject(Object.assign(new Error('Not a staff token'), { status: 403 }));
    await fixture.settle();
    assert.equal(fixture.tokenClears, 1);
    assert.equal(fixture.draftClears, 1);
    assert.equal(fixture.state.kind, null);
    assert.equal(fixture.state.loading, false);
  });

  test(`${platform}: floor/grant forbidden response preserves credentials for recovery`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    fixture.gets[0].reject(Object.assign(new Error('You do not have access to this floor'), { status: 403 }));
    await fixture.settle();
    assert.equal(fixture.tokenClears, 0);
    assert.equal(fixture.draftClears, 0);
    assert.ok(fixture.state.sessionError);
    assert.equal(fixture.state.kind, null);
    const retry = fixture.state.retrySession();
    await fixture.settle();
    assert.ok(fixture.state.sessionError, 'recovery gate stays closed during retry');
    fixture.gets[1].resolve(staff('restored'));
    await retry; await fixture.settle();
    assert.equal(fixture.state.staff.id, 'restored');
    assert.equal(fixture.state.sessionError, null);
    assert.equal(fixture.pendingRetries, 0);
  });

  test(`${platform}: deploy outage retries twice then waits for explicit recovery without clearing credentials`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    for (let attempt = 0; attempt < 3; attempt++) {
      fixture.gets[attempt].reject(Object.assign(new Error('Deploy unavailable'), { status: 503 }));
      await fixture.settle();
      assert.ok(fixture.state.sessionError);
      assert.equal(fixture.tokenClears, 0);
      if (attempt < 2) { fixture.retryAutomatically(); await fixture.settle(); }
    }
    assert.equal(fixture.pendingRetries, 0, 'background retries are bounded');
    const retry = fixture.state.retrySession();
    await fixture.settle();
    fixture.gets[3].resolve(staff('restored'));
    await retry; await fixture.settle();
    assert.equal(fixture.state.staff.id, 'restored');
    assert.equal(fixture.state.sessionError, null);
    assert.equal(fixture.draftClears, 0);
  });

  test(`${platform}: online or native foreground automatically recovers a retained session`, async () => {
    const fixture = provider(platform);
    await fixture.settle();
    fixture.gets[0].reject(new TypeError('Offline'));
    await fixture.settle();
    fixture.foreground();
    await fixture.settle();
    fixture.gets[1].resolve(staff('foreground-restored'));
    await fixture.settle();
    assert.equal(fixture.state.staff.id, 'foreground-restored');
    assert.equal(fixture.state.sessionError, null);
    assert.equal(fixture.tokenClears, 0);
    assert.equal(fixture.pendingRetries, 0);
  });

  test(`${platform}: startup draft reset gates identity hydration and newer login`, async () => {
    const startupDraftReset = deferred();
    const fixture = provider(platform, { startupDraftReset });
    await fixture.settle();
    assert.equal(fixture.gets.length, 0);
    assert.equal(fixture.state.loading, true);
    const login = fixture.state.loginStaff('fixture@example.invalid', 'fixture-password');
    await fixture.settle();
    assert.equal(fixture.posts.length, 0);
    startupDraftReset.resolve(); await fixture.settle();
    assert.equal(fixture.gets.length, 0, 'superseded startup cannot hydrate after reset finishes');
    assert.equal(fixture.posts.length, 1);
    fixture.posts[0].resolve(loginResponse('staff')); await login; await fixture.settle();
    assertLogin(fixture, 'staff');
  });

  test(`${platform}: unmount during startup reset cannot publish an identity`, async () => {
    const startupDraftReset = deferred();
    const fixture = provider(platform, { startupDraftReset });
    await fixture.settle();
    const previousWrites = fixture.stateWrites;
    fixture.unmount(); startupDraftReset.resolve(); await fixture.settle();
    assert.equal(fixture.gets.length, 0);
    assert.equal(fixture.stateWrites, previousWrites);
    assert.equal(fixture.tokenClears, 0);
  });
  for (const nextKind of ['staff', 'customer']) {
    test(`${platform}: aborted hydration cannot clear newer ${nextKind} login`, async () => {
      const fixture = provider(platform, { abortHydrationOnLogin: true });
      await fixture.settle(); assert.equal(fixture.gets[0].path, '/auth/me');
      await fixture.beginLogin(nextKind); await fixture.settle();
      assertLogin(fixture, nextKind);
      assert.equal(fixture.draftClears, 0); assert.equal(fixture.tokenClears, 0);
    });

    test(`${platform}: late successful hydration cannot overwrite newer ${nextKind} identity`, async () => {
      const fixture = provider(platform); await fixture.settle();
      await fixture.beginLogin(nextKind); await fixture.settle();
      fixture.gets[0].resolve({ ...staff('old-staff'), must_change_password: true });
      await fixture.settle(); assertLogin(fixture, nextKind);
    });

    test(`${platform}: newer ${nextKind} login wins during obsolete draft cleanup`, async () => {
      const draftCleanup = deferred();
      const fixture = provider(platform, { draftCleanup }); await fixture.settle();
      fixture.gets[0].reject(Object.assign(new Error('Fixture invalid session'), { status: 401 })); await fixture.settle();
      assert.equal(fixture.draftClears, 1); assert.equal(fixture.tokenClears, 0);
      await fixture.beginLogin(nextKind); await fixture.settle();
      draftCleanup.resolve(); await fixture.settle();
      assertLogin(fixture, nextKind); assert.equal(fixture.tokenClears, 0);
    });

    test(`${platform}: delayed credential deletion finishes before newer ${nextKind} write`, async () => {
      const credentialDeletion = deferred();
      const fixture = provider(platform, { credentialDeletion }); await fixture.settle();
      fixture.gets[0].reject(Object.assign(new Error('Fixture invalid session'), { status: 401 })); await fixture.settle();
      assert.equal(fixture.tokenClears, 1);
      const login = fixture.beginLogin(nextKind); await fixture.settle();
      assert.equal(fixture.writes.length, 0, 'new credential write waits for already-started deletion');
      assert.equal(fixture.state.loading, true);
      credentialDeletion.resolve(); await login; await fixture.settle();
      assertLogin(fixture, nextKind); assert.equal(fixture.tokenClears, 1);
    });
  }

  test(`${platform}: obsolete hydration cannot publish identity or finish a pending login`, async () => {
    const fixture = provider(platform); await fixture.settle();
    const login = fixture.state.loginCustomer('fixture@example.invalid', 'fixture-password');
    fixture.gets[0].resolve(staff('old-staff')); await fixture.settle();
    assert.equal(fixture.state.loading, true); assert.equal(fixture.state.kind, null);
    assert.equal(fixture.state.staff, null);
    fixture.posts[0].resolve(loginResponse('customer')); await login; await fixture.settle();
    assertLogin(fixture, 'customer');
  });

  test(`${platform}: obsolete hydration failure cannot finalize pending logout`, async () => {
    const fixture = provider(platform); await fixture.settle();
    const logout = fixture.state.logout();
    fixture.gets[0].reject(new DOMException('Fixture cancelled', 'AbortError')); await fixture.settle();
    assert.equal(fixture.state.loading, true); assert.equal(fixture.draftClears, 0);
    assert.equal(fixture.tokenClears, 0);
    fixture.posts[0].resolve({}); await logout; await fixture.settle();
    assert.equal(fixture.state.loading, false); assert.equal(fixture.state.kind, null);
    assert.equal(fixture.draftClears, 1); assert.equal(fixture.tokenClears, 1);
  });

  test(`${platform}: current invalid hydration still revokes credentials and drafts`, async () => {
    const fixture = provider(platform); await fixture.settle();
    fixture.gets[0].reject(Object.assign(new Error('Fixture expired session'), { status: 401 })); await fixture.settle();
    assert.equal(fixture.state.kind, null); assert.equal(fixture.state.staff, null);
    assert.equal(fixture.state.customer, null); assert.equal(fixture.state.loading, false);
    assert.equal(fixture.draftClears, 1); assert.equal(fixture.tokenClears, 1);
  });

  test(`${platform}: late personal-grant hydration cannot restore old account after logout`, async () => {
    const fixture = provider(platform); await fixture.settle();
    fixture.gets[0].resolve(staff('old-staff', true)); await fixture.settle();
    assert.equal(fixture.gets[1].path, '/settings/access-grants/me');
    const logout = fixture.state.logout(); fixture.posts[0].resolve({});
    await logout; await fixture.settle();
    fixture.gets[1].resolve({ grants: [{ resource: 'quotations', floor_ids: ['first-floor'] }] });
    await fixture.settle();
    assert.equal(fixture.state.kind, null); assert.equal(fixture.state.staff, null);
    assert.equal(fixture.state.loading, false); assert.equal(fixture.tokenClears, 1);
  });

  test(`${platform}: current staff hydration publishes identity only after personal grants`, async () => {
    const fixture = provider(platform); await fixture.settle();
    fixture.gets[0].resolve(staff('current-staff', true)); await fixture.settle();
    assert.equal(fixture.state.kind, null); assert.equal(fixture.state.loading, true);
    fixture.gets[1].resolve({ grants: [{ resource: 'quotations' }] }); await fixture.settle();
    assert.equal(fixture.state.kind, 'staff'); assert.equal(fixture.state.staff.id, 'current-staff');
    assert.equal(fixture.state.staff.access_grants[0].resource, 'quotations');
    assert.equal(fixture.state.customer, null); assert.equal(fixture.state.loading, false);
    assert.equal(fixture.tokenClears, 0); assert.equal(fixture.draftClears, 0);
  });

  test(`${platform}: current customer hydration still restores the customer session`, async () => {
    const fixture = provider(platform, { initialKind: 'customer' }); await fixture.settle();
    assert.equal(fixture.gets[0].path, '/auth/customer/me');
    fixture.gets[0].resolve(customer('current-customer')); await fixture.settle();
    assert.equal(fixture.state.kind, 'customer'); assert.equal(fixture.state.customer.id, 'current-customer');
    assert.equal(fixture.state.staff, null); assert.equal(fixture.state.loading, false);
    assert.equal(fixture.tokenClears, 0); assert.equal(fixture.draftClears, 0);
  });

  for (const oldOutcome of ['success', 'failure']) {
    test(`${platform}: held hydration ${oldOutcome} after unmount has no state or credential side effects`, async () => {
      const fixture = provider(platform); await fixture.settle();
      assert.equal(fixture.gets[0].path, '/auth/me');
      const writesBeforeUnmount = fixture.stateWrites;
      const stateBeforeUnmount = fixture.state;
      fixture.unmount();
      if (oldOutcome === 'success') fixture.gets[0].resolve(staff('unmounted-staff'));
      else fixture.gets[0].reject(new Error('Fixture invalid session after unmount'));
      await fixture.settle();
      assert.equal(fixture.stateWrites, writesBeforeUnmount, 'obsolete hydration must not invoke state setters after cleanup');
      assert.equal(fixture.state, stateBeforeUnmount);
      assert.equal(fixture.tokenClears, 0); assert.equal(fixture.draftClears, 0);
    });

    for (const oldFinishesFirst of [true, false]) {
      test(`${platform}: StrictMode replay ignores old hydration ${oldOutcome} finishing ${oldFinishesFirst ? 'before' : 'after'} latest hydration`, async () => {
        const fixture = provider(platform); await fixture.settle();
        assert.equal(fixture.gets.length, 1);
        fixture.replayEffects(); await fixture.settle();
        assert.equal(fixture.gets.length, 2, 'effect setup is replayed with the original provider refs and state');
        const finishOld = () => oldOutcome === 'success'
          ? fixture.gets[0].resolve({ ...staff('obsolete-strictmode-staff'), must_change_password: true })
          : fixture.gets[0].reject(new Error('Fixture obsolete session failure'));
        if (oldFinishesFirst) {
          const writesBeforeOld = fixture.stateWrites;
          finishOld(); await fixture.settle();
          assert.equal(fixture.stateWrites, writesBeforeOld, 'obsolete success/catch/finally must not publish or finalize latest hydration');
          assert.equal(fixture.state.kind, null); assert.equal(fixture.state.staff, null);
          assert.equal(fixture.state.loading, true);
        }
        fixture.gets[1].resolve(staff('latest-strictmode-staff')); await fixture.settle();
        assert.equal(fixture.state.kind, 'staff'); assert.equal(fixture.state.staff.id, 'latest-strictmode-staff');
        assert.equal(fixture.state.loading, false);
        if (!oldFinishesFirst) {
          const writesBeforeOld = fixture.stateWrites;
          finishOld(); await fixture.settle();
          assert.equal(fixture.stateWrites, writesBeforeOld, 'obsolete hydration cannot overwrite or revoke the replayed session');
          assert.equal(fixture.state.staff.id, 'latest-strictmode-staff');
        }
        assert.equal(fixture.tokenClears, 0); assert.equal(fixture.draftClears, 0);
      });
    }
  }
}
