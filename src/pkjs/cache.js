'use strict';
// This key includes calculation settings only, never credentials.
function settingsKey(settings) {
  var key = {};
  ['month', 'basicMode', 'basicRate', 'contractStartDate', 'bandStart', 'bandEnd',
    'rate1', 'rate2', 'fuelRate', 'governmentRate', 'taxMode', 'taxRate'].forEach(function(name) {
    key[name] = settings[name];
  });
  key.demo = settings.demo === true;
  return JSON.stringify(key);
}
function snapshot(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) ||
      !cache.payload || typeof cache.payload !== 'object' || Array.isArray(cache.payload)) return false;
  return [0, 1, 2, 3, 4, 5, 6, 8].every(function(key) { return typeof cache.payload[key] === 'string'; });
}
function complete(cache, settings, info, from, now) {
  if (!snapshot(cache) || cache.schema !== 2 || cache.complete !== true ||
      cache.month !== info.month || cache.start !== from || cache.end !== info.midnight ||
      from >= info.midnight || cache.settingsKey !== settingsKey(settings) ||
      cache.demo !== (settings.demo === true) ||
      typeof cache.fetchedAt !== 'number' || !isFinite(cache.fetchedAt) ||
      cache.fetchedAt < info.midnight || cache.fetchedAt > now) return false;
  var p = cache.payload;
  if (![1, 2].every(function(key) {
        return /^JPY (0|[1-9]\d*)$/.test(p[key]) && Number(p[key].slice(4)) <= 9007199254740991;
      }) ||
      p[0].indexOf('missing') >= 0 || p[0].indexOf('delayed') >= 0 ||
      !/ kWh$/.test(p[3])) return false;
  function dateText(ms) {
    var d = new Date(ms + 9 * 3600000);
    return ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2);
  }
  var first = dateText(from), through = dateText(cache.end - 86400000);
  var days = (cache.end - from) / 86400000;
  var period = from > info.start ? first + '-' + through + ' / ' + days + (days === 1 ? ' day' : ' days') : info.month + ' / ' + days + ' days';
  var detail = (from > info.start ? 'From ' + first + '; ' : '') + 'Through ' + through;
  var stamp = new Date(cache.fetchedAt + 9 * 3600000);
  var updated = dateText(cache.fetchedAt) + ' ' + ('0' + stamp.getUTCHours()).slice(-2) + ':' + ('0' + stamp.getUTCMinutes()).slice(-2) + ' JST';
  if (p[4] !== period || p[5] !== updated || p[6] !== detail ||
      p[0] !== (cache.demo ? 'DEMO - sample usage' : 'Estimate') ||
      p[8].indexOf('DATA COVERAGE\nFrom ' + first) !== 0 ||
      // Inferred zeros need fresh readings: later measurements may replace them.
      p[8].indexOf('\nZero inferred 0\n') < 0 ||
      p[8].indexOf('CURRENT BREAKDOWN\nBase ') < 0 ||
      p[8].indexOf('FORECAST BREAKDOWN\nBase ') < 0 ||
      p[8].indexOf('Total JPY ' + p[1].slice(4) + '\n') < 0 ||
      p[8].slice(-('Total JPY ' + p[2].slice(4)).length) !== 'Total JPY ' + p[2].slice(4)) return false;
  var usage = [p[3].slice(0, -4), p[9], p[10]];
  return usage.every(function(value) {
    return typeof value === 'string' && /^\d+(?:\.\d+)?(?:e\+\d+)?$/.test(value) &&
      isFinite(Number(value)) && Number(value) >= 0;
  });
}
module.exports = { settingsKey: settingsKey, snapshot: snapshot, complete: complete };
