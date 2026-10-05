(function initWatchWriteBarrier(global) {
  // Storage operations only: callers must check the captured token again after
  // network/read awaits, immediately before starting any local write.
  function create() {
    let epoch = 0;
    let closed = false;
    let clearPromise = null;
    const tokens = new WeakMap();
    const writers = new Set();
    function current(token) {
      return !closed && token !== null && typeof token === 'object'
        && tokens.has(token) && tokens.get(token) === epoch;
    }
    return Object.freeze({
      capture() {
        if (closed) throw new Error('write_barrier_closed');
        const token = Object.freeze({});
        tokens.set(token, epoch);
        return token;
      },
      current,
      invalidate() { epoch++; },
      write(token, operation) {
        if (!current(token)) throw new Error('write_binding_changed');
        if (typeof operation !== 'function') throw new Error('write_operation_invalid');
        // Register synchronously, before invoking a producer. Reentrant clear
        // must observe this writer even if its callback starts clear itself.
        let resolve;
        let reject;
        const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
        writers.add(pending);
        pending.then(() => writers.delete(pending), () => writers.delete(pending));
        try { Promise.resolve(operation()).then(resolve, reject); }
        catch (error) { reject(error); }
        return pending;
      },
      closeAndClear(clear) {
        if (clearPromise !== null) return clearPromise;
        if (typeof clear !== 'function') throw new Error('write_operation_invalid');
        closed = true;
        epoch++;
        clearPromise = Promise.allSettled([...writers]).then(() => clear());
        return clearPromise;
      },
    });
  }
  global.AniRekoWatchWriteBarrier = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : self);
