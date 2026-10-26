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

// Root mounting may use its existing 25s bound; identity then starts directly.
{
  const clock = new FakeClock(), observer = clock.observer();
  const started = observer.waitStarted(), auth = observer.waitIdentity();
  let releaseContent;
  const content = observer.waitForContent(() => new Promise(resolve => { releaseContent = resolve; }), 25000);
  clock.tick(24000);
  observer.request(identity);
  assert.equal(await started, 24000);
  clock.tick(1000);
  observer.response(identity, 200);
  await flush();
  assert.equal(await auth, 25000);
  assert.equal(observer.remainingContentMs(25000), 24000);
  releaseContent();
  await content;
  observer.dispose();
  assert.equal(clock.timers.size, 0, 'successful navigation must clear its timers');
}

// Readiness and unrelated requests cannot satisfy or extend the root deadline.
{
  const clock = new FakeClock(), observer = clock.observer();
  const started = observer.waitStarted();
  for (let elapsed = 0; elapsed < 24000; elapsed += 4000) {
    clock.tick(4000);
    observer.request(health);
    observer.response(health, 200, { status: 'ok' });
    observer.request('https://other.example/api/auth/me');
    observer.response('https://other.example/api/auth/me', 200);
  }
  clock.tick(1000);
  await assert.rejects(started, /root mount deadline/);
  observer.dispose();
}

// Identity has its unchanged 20s deadline from the first actual request.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  const auth = observer.waitIdentity();
  clock.tick(19000);
  observer.request(identity);
  clock.tick(1000);
  await assert.rejects(auth, /20 second deadline/);
  observer.response(identity, 200);
  await assert.rejects(observer.waitFailure(), /20 second deadline/);
  observer.dispose();
}

// Only HTTP 200 satisfies identity; transport and other statuses fail immediately.
for (const fail of [
  observer => observer.response(identity, 401),
  observer => observer.response(identity, 403),
  observer => observer.response(identity, 503),
  observer => observer.requestFailed(identity),
]) {
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  const auth = observer.waitIdentity();
  fail(observer);
  await assert.rejects(auth, /Authenticated identity/);
  assert.equal(clock.timers.size, 0);
  observer.dispose();
}

// Identity time remains inside the absolute content budget from request start.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  let releaseContent;
  const content = observer.waitForContent(() => new Promise(resolve => { releaseContent = resolve; }), 25000);
  await flush();
  clock.tick(18000);
  observer.response(identity, 200);
  await observer.waitIdentity();
  assert.equal(observer.remainingContentMs(25000), 7000);
  clock.tick(7000);
  await assert.rejects(content, /25,?000 millisecond identity-start deadline/);
  releaseContent();
  observer.dispose();
}

// Registering a content wait later must not restart the content budget.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  observer.response(identity, 200);
  clock.tick(25001);
  await assert.rejects(observer.waitForContent(async () => {}, 25000), /identity-start deadline/);
  observer.dispose();
}

// Late events after navigation cleanup cannot restart or settle phase timers.
{
  const clock = new FakeClock(), observer = clock.observer();
  const started = observer.waitStarted();
  observer.dispose();
  observer.request(identity);
  observer.response(identity, 200);
  observer.requestFailed(identity);
  observer.terminal('Late terminal event');
  await flush();
  assert.equal(clock.timers.size, 0);
  let settled = false;
  started.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'disposed observer ignores late startup results');
}

// Content visible before HTTP 200 cannot mask a stalled authenticated identity.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  const content = observer.waitForContent(async () => {}, 25000);
  await content;
  clock.tick(20000);
  await assert.rejects(observer.waitIdentity(), /20 second deadline/);
  observer.dispose();
}

// A shorter existing route-content budget also bounds identity restoration.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  const content = observer.waitForContent(async () => {}, 5000);
  await content;
  clock.tick(5000);
  await assert.rejects(observer.waitIdentity(), /5000 millisecond identity-start deadline/);
  observer.dispose();
}

// HTTP 200 without the corresponding browser request cannot bypass root mount.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.response(identity, 200);
  clock.tick(25000);
  await assert.rejects(observer.waitIdentity(), /root mount deadline/);
  observer.dispose();
}

// A late response after request success must not undo the accepted identity.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  observer.response(identity, 200);
  observer.response(identity, 503);
  observer.requestFailed(identity);
  const content = observer.waitForContent(async () => {}, 25000);
  await Promise.all([content, observer.waitIdentity()]);
  assert.equal(clock.timers.size, 0);
  observer.dispose();
}

// Terminal UI errors race pending content immediately after identity succeeds.
{
  const clock = new FakeClock(), observer = clock.observer();
  observer.request(identity);
  observer.response(identity, 200);
  const content = observer.waitForContent(() => new Promise(() => {}), 25000);
  await flush();
  observer.terminal('Application font readiness failed');
  await assert.rejects(content, /font readiness failed/i);
  assert.equal(clock.timers.size, 0);
  observer.dispose();
}

console.log('Authenticated release startup observer: direct identity start/200, unchanged root/identity/content budgets, ignored health, failures and disposal passed.');
