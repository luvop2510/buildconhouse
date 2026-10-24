import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./verify-authenticated-release.mjs', import.meta.url), 'utf8');
const marker = 'function createStartupDeadlineObserver(';
const start = source.indexOf(marker);
assert.notEqual(start, -1, 'Verifier must keep the tested startup observer inline');
const bodyStart = source.indexOf(') {', start) + 2;
let depth = 0, end = -1;
for (let index = bodyStart; index < source.length; index++) {
  if (source[index] === '{') depth++;
  if (source[index] === '}' && --depth === 0) { end = index + 1; break; }
}
assert.ok(end > start, 'Could not extract the startup observer from the verifier');
const createStartupDeadlineObserver = vm.runInNewContext(`(${source.slice(start, end)})`, {});

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimer = id => this.timers.delete(id);
  tick(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.time = timer.at;
      this.timers.delete(id);
      timer.callback();
    }
    this.time = target;
  }
  observer(options = {}) {
    return createStartupDeadlineObserver({
      origin: 'https://candidate.example', now: this.now,
      setTimer: this.setTimer, clearTimer: this.clearTimer, ...options,
    });
  }
}
const health = 'https://candidate.example/api/health/ready';
const identity = 'https://candidate.example/api/auth/me';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

// A real app can spend most of its allowed wake window on bounded readiness probes.
{
  const clock = new FakeClock(), observer = clock.observer();
  const ready = observer.waitReady(), auth = observer.waitIdentity();
  let releaseContent;
  const content = observer.waitForContent(() => new Promise(resolve => { releaseContent = resolve; }), 25000);
  observer.request(health);
  clock.tick(45000);
  observer.request(health);
  observer.response(health, 503, null);
  clock.tick(1000);
  observer.response(health, 200, { status: 'ok' });
  await flush();
  assert.equal(await ready, 46000);
  observer.request(identity);
  clock.tick(1000);
  observer.response(identity, 200, {});
  await flush();
  assert.equal(await auth, 47000);
  assert.equal(observer.remainingContentMs(25000), 24000);
  releaseContent();
  await content;
  observer.dispose();
  assert.equal(clock.timers.size, 0, 'successful navigation must clear its timers');
}

// Repeated failed probes cannot restart the original 60 second wake budget.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  let settled = false;
  ready.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < 56000; elapsed += 4000) {
    clock.tick(4000);
    observer.request(health);
    observer.response(health, 503, null);
  }
  clock.tick(3999);
  await flush();
  assert.equal(settled, false, 'the full wake window remains available to readiness probes');
  clock.tick(2);
  await assert.rejects(ready, /60 second wake window/);
  observer.dispose();
}

// Root mounting has its own bound before the app starts readiness probes.
{
  const clock = new FakeClock(), observer = clock.observer();
  const ready = observer.waitReady();
  clock.tick(25000);
  await assert.rejects(ready, /root mount deadline/);
  observer.dispose();
}

// Identity has its own 20 second deadline from its actual browser request.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  const auth = observer.waitIdentity();
  observer.response(health, 200, { status: 'ok' });
  await ready;
  observer.request(identity);
  clock.tick(20001);
  await assert.rejects(auth, /20 second deadline/);
  observer.dispose();
}

// The first auth response must be HTTP 200; transport failure and other statuses fail immediately.
for (const fail of [
  observer => observer.response(identity, 503, {}),
  observer => observer.requestFailed(identity),
]) {
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  const auth = observer.waitIdentity();
  fail(observer);
  await assert.rejects(auth, /Authenticated identity/);
  observer.dispose();
}

// Identity time is included in the absolute content deadline from readiness.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  observer.response(health, 200, { status: 'ok' });
  await ready;
  let releaseContent;
  const content = observer.waitForContent(() => new Promise(resolve => { releaseContent = resolve; }), 25000);
  await flush();
  observer.request(identity);
  clock.tick(18000);
  observer.response(identity, 200, {});
  await flush();
  assert.equal(observer.remainingContentMs(25000), 7000);
  clock.tick(7001);
  await assert.rejects(content, /25,?000 millisecond readiness deadline/);
  observer.dispose();
}

// A late body completion after navigation cleanup must not restart or settle old phase timers.
{
  const clock = new FakeClock(), observer = clock.observer();
  const ready = observer.waitReady();
  observer.request(health);
  observer.dispose();
  observer.response(health, 200, { status: 'ok' });
  observer.request(identity);
  await flush();
  assert.equal(clock.timers.size, 0);
  let settled = false;
  ready.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'disposed observer ignores late readiness results');
}

// Visible content does not mask an identity wait already in progress past the shared startup deadline.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  observer.response(health, 200, { status: 'ok' });
  await ready;
  clock.tick(6000);
  observer.request(identity);
  const content = observer.waitForContent(async () => {}, 25000);
  await flush();
  await content;
  clock.tick(19000);
  await assert.rejects(observer.waitIdentity(), /25,?000 millisecond readiness deadline/);
  observer.dispose();
}

// Even visible content cannot substitute for the required authenticated identity request.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  observer.response(health, 200, { status: 'ok' });
  await ready;
  const content = observer.waitForContent(async () => {}, 25000);
  const auth = observer.waitIdentity();
  await flush();
  await content;
  clock.tick(25000);
  await assert.rejects(auth, /25,?000 millisecond readiness deadline/);
  observer.dispose();
}

// Terminal UI errors race the phase waits immediately, including after readiness.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(health);
  const ready = observer.waitReady();
  observer.response(health, 200, { status: 'ok' });
  await ready;
  const content = observer.waitForContent(() => new Promise(() => {}), 25000);
  observer.request(identity);
  observer.response(identity, 200, {});
  await flush();
  observer.terminal('Application font readiness failed');
  await assert.rejects(content, /font readiness failed/i);
  observer.dispose();
}

console.log('Authenticated release startup observer: 45-second wake, fixed wake budget, identity/content deadlines, missing phases and terminal failure passed.');
