const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function barrier() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/watch-write-barrier.js'), 'utf8'), context);
  return context.AniRekoWatchWriteBarrier.create();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('invalidation rejects captured old callbacks before a storage write starts', () => {
  const gate = barrier();
  const old = gate.capture();
  gate.invalidate();
  let writes = 0;
  assert.throws(() => gate.write(old, () => { writes++; }), /write_binding_changed/);
  assert.equal(writes, 0);
  assert.equal(gate.current(old), false);
  assert.equal(gate.current(gate.capture()), true);
});

test('tokens cannot cross independent controller instances', () => {
  const first = barrier();
  const second = barrier();
  assert.throws(() => second.write(first.capture(), () => {}), /write_binding_changed/);
  assert.equal(second.current({}), false);
});

test('clear closes admission synchronously and drains already started writers', async () => {
  const gate = barrier();
  const old = gate.capture();
  const paused = deferred();
  const storage = new Map();
  const write = gate.write(old, () => paused.promise.then(() => storage.set('resume', 1)));
  let cleared = false;
  const clear = gate.closeAndClear(() => { storage.clear(); cleared = true; });
  assert.equal(gate.current(old), false);
  assert.throws(() => gate.write(old, () => storage.set('late', 1)), /write_binding_changed/);
  assert.throws(() => gate.capture(), /write_barrier_closed/);
  await Promise.resolve();
  assert.equal(cleared, false);
  paused.resolve();
  await write;
  await clear;
  assert.equal(cleared, true);
  assert.equal(storage.size, 0);
});

test('rejected writer still drains and repeated clear joins one operation', async () => {
  const gate = barrier();
  const paused = deferred();
  const write = gate.write(gate.capture(), () => paused.promise.then(() => { throw Error('storage_failed'); }));
  const rejected = assert.rejects(write, /storage_failed/);
  let clears = 0;
  const first = gate.closeAndClear(() => { clears++; });
  const second = gate.closeAndClear(() => { clears++; });
  assert.equal(first, second);
  paused.resolve();
  await rejected;
  await first;
  assert.equal(clears, 1);
});

test('failed clear stays failed and never silently reopens the old controller', async () => {
  const gate = barrier();
  const token = gate.capture();
  const clear = gate.closeAndClear(() => { throw Error('clear_failed'); });
  await assert.rejects(clear, /clear_failed/);
  assert.equal(gate.closeAndClear(() => {}), clear);
  assert.equal(gate.current(token), false);
  assert.throws(() => gate.capture(), /write_barrier_closed/);
});

test('writer is registered before a reentrant clear captures its drain set', async () => {
  const gate = barrier();
  const paused = deferred();
  const order = [];
  let clear;
  const write = gate.write(gate.capture(), () => {
    clear = gate.closeAndClear(() => order.push('clear'));
    return paused.promise.then(() => order.push('write'));
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  paused.resolve();
  await write;
  await clear;
  assert.deepEqual(order, ['write', 'clear']);
});

test('synchronous storage failure is a tracked rejected operation, not a leak', async () => {
  const gate = barrier();
  const write = gate.write(gate.capture(), () => { throw Error('sync_failed'); });
  await assert.rejects(write, /sync_failed/);
  let cleared = false;
  await gate.closeAndClear(() => { cleared = true; });
  assert.equal(cleared, true);
});
