'use strict';
// One phone-to-watch message at a time; keep only the newest queued state.
function Sender(pebble, timers, report) {
  this.pebble = pebble;
  this.report = report || function() {};
  // Android uses WebView's native globals. Calling a borrowed setTimeout as
  // timers.set() gives it the wrong receiver (Illegal invocation).
  this.timers = timers || {
    set: function(callback, delay) { return setTimeout(callback, delay); },
    clear: function(id) { clearTimeout(id); }
  };
  this.sending = false;
  this.pending = null;
}
Sender.prototype.send = function(payload) {
  if (this.sending) { this.pending = payload; return; }
  var self = this, finished = false, timer;
  self.sending = true;
  self.report('SENDING');
  function next() {
    if (finished) { return; }
    finished = true;
    self.sending = false;
    if (timer !== undefined) {
      try { self.timers.clear(timer); }
      catch (e) { self.report('THREW / timer clear'); }
    }
    if (self.pending) {
      var queued = self.pending; self.pending = null; self.send(queued);
    }
  }
  // A lost native ACK must not block all future manual refreshes.
  try { timer = self.timers.set(function(){ if (!finished) self.report('NO ACK'); next(); }, 10000); }
  catch (e) {
    // Do not dispatch without an ACK deadline or strand the sender lock.
    self.report('THREW / timer start'); next(); return;
  }
  if (timer && typeof timer.unref === 'function') { timer.unref(); }
  try { self.pebble.sendAppMessage(payload, function(){ if (!finished) self.report('ACK'); next(); }, function(e){ if (!finished) self.report('FAILED / ' + require('./diagnostics').deliveryError(e)); next(); }); }
  catch (e) { self.report('THREW / ' + require('./diagnostics').deliveryError(e)); next(); }
};
module.exports = { Sender: Sender };
