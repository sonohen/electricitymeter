'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the shipped module, including its DEFAULT timer adapter. Previous
// tests injected an adapter or loaded transport through Node's permissive timers.
// This host rejects calling a global timer as an arbitrary object's method.
function nativeHost(options = {}) {
  const deadlines = new Map(), sent = [], states = [];
  let id = 0;
  const context = {
    module: { exports: {} },
    require: name => require('../src/pkjs/' + name.replace('./', '')),
    setTimeout: function(callback, ms) {
      assert(!this || !Object.hasOwn(this, 'set'), 'native timer received adapter as receiver');
      assert.equal(ms, 10000);
      if (options.startFailure) throw Error('private timer secret');
      deadlines.set(++id, callback); return id;
    },
    clearTimeout: function(timer) {
      assert(!this || !Object.hasOwn(this, 'clear'), 'native clear received adapter as receiver');
      if (options.clearFailure) throw Error('private clear secret');
      deadlines.delete(timer);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/transport'), 'utf8'), context);
  const sender = new context.module.exports.Sender({ sendAppMessage(payload, ok, fail) {
    sent.push({ payload, ok, fail });
  } }, null, state => states.push(state));
  return { sender, deadlines, sent, states };
}

test('default native timer adapter reaches delivery and recovers from an absent ACK', () => {
  const h = nativeHost();
  assert.doesNotThrow(() => h.sender.send({ STATUS: 'Updating' }));
  h.sender.send({ STATUS: 'Estimate' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.deadlines.size, 1);
  [...h.deadlines.values()][0]();
  assert(h.states.includes('NO ACK'));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].payload.STATUS, 'Estimate');
  h.sent[0].ok();
  assert.equal(h.sent.length, 2, 'late ACK must not release a newer transmission');
  h.sent[1].ok();
  assert.equal(h.sender.sending, false);
  assert.equal(h.deadlines.size, 0);
});


test('timer registration failure releases the queue for a later attempt', () => {
  const options = { startFailure: true }, h = nativeHost(options);
  assert.doesNotThrow(() => h.sender.send({ STATUS: 'Updating' }));
  assert.equal(h.sent.length, 0, 'never create an unbounded native attempt');
  assert.equal(h.sender.sending, false);
  assert(h.states.includes('THREW / timer start'));
  assert(!h.states.join(' ').includes('private'));
  options.startFailure = false;
  h.sender.send({ STATUS: 'Retry' });
  assert.equal(h.sent.length, 1);
  h.sent[0].ok();
  assert.equal(h.sender.sending, false);
});

test('timer cancellation failure does not strand acknowledged delivery', () => {
  const h = nativeHost({ clearFailure: true });
  h.sender.send({ STATUS: 'Updating' });
  assert.doesNotThrow(() => h.sent[0].ok());
  assert.equal(h.sender.sending, false);
  h.sender.send({ STATUS: 'Retry' });
  assert.equal(h.sent.length, 2);
  [...h.deadlines.values()][0]();
  assert.equal(h.sent.length, 2, 'uncancelled old deadline must remain harmless');
  assert(!h.states.join(' ').includes('private'));
});
