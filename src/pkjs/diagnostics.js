'use strict';
var KEY = 'electricity.diagnostics.v1';
function Journal(storage) { this.storage = storage; }
Journal.prototype.read = function() {
  try { return JSON.parse(this.storage.getItem(KEY)) || {}; } catch (e) { return {}; }
};
Journal.prototype.record = function(field, value) {
  try { var data = this.read(); data[field] = value; this.storage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
};
Journal.prototype.summary = function() {
  var data = this.read();
  return '設定保存: ' + (data.save || '記録なし') + '\nスマートフォン処理: ' + (data.phase || '記録なし') + '\n時計への送信: ' + (data.delivery || '記録なし');
};
function deliveryError(e) {
  var raw = e && e.error !== undefined ? e.error : e;
  if (raw && typeof raw === 'object') raw = raw.message || raw.code;
  if (typeof raw === 'number' && isFinite(raw)) return 'code ' + raw;
  if (typeof raw === 'string') {
    var lower = raw.toLowerCase();
    if (lower.indexOf('key') >= 0) return 'key mapping';
    if (lower.indexOf('timeout') >= 0) return 'timeout';
    if (lower.indexOf('connect') >= 0) return 'connection';
    if (lower.indexOf('large') >= 0) return 'size';
    if (lower.indexOf('busy') >= 0) return 'busy';
    if (lower.indexOf('invalid') >= 0) return 'invalid message';
  }
  return 'unclassified';
}
module.exports = { Journal: Journal, deliveryError: deliveryError };
