'use strict';
var Clay, config, core, Api, Store, store, client, transport, cache;
var journal = new (require('./diagnostics').Journal)(localStorage);
function phase(name) { journal.record('phase', name); }
var bootStage = 'CORE', bootError = false;
function reportBootError() {
  phase('BOOT FAILED ' + bootStage);
  // Only fixed stage/version names. Never include exception messages or settings.
  Pebble.sendAppMessage({ STATUS: 'Phone error', DETAIL: 'Phone v1.0.8 boot failed: ' + bootStage }, function(){}, function(){});
}
try {
  core = require('./core');
  bootStage = 'CACHE'; cache = require('./cache');
  bootStage = 'API'; Api = require('./api');
  bootStage = 'STORAGE'; Store = require('./storage').Store; store = new Store(localStorage);
  bootStage = 'MESSAGES'; transport = new (require('./transport').Sender)(Pebble, null, function(state) { journal.record('delivery', state); });
  bootStage = 'CLIENT'; client = new Api.Client(function() { return new XMLHttpRequest(); });
} catch (e) { bootError = true; }
var clay;
var busy = false;
var revision = 0;
var last = null;

var labels = { settings: 'Check phone settings', month: 'Set rates for this month', auth: 'Re-enter login on phone',
  contract_date: 'Check supply start date', not_started: 'Supply not started',
  http_unavailable: 'Phone HTTP unavailable', no_data: 'No usage data', data: 'Invalid API data', multiple: 'Multiple supply points',
  http: 'API HTTP error', graphql: 'API query error', network: 'Network unavailable', timeout: 'API timeout',
  insufficient: 'Need one complete day', missing: 'Missing half-hour data', conflict: 'Conflicting readings',
  calculation: 'Check rates / calculation', cancelled: 'Update cancelled', storage: 'Phone storage error' };
function clockText(ms) {
  var d = new Date(ms + 9 * 3600000);
  function pad(n) { return ('0' + n).slice(-2); }
  return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' JST';
}
function send(payload) {
  var safe = {}, limits = { 0: 63, 1: 31, 2: 31, 3: 31, 4: 31, 5: 31, 6: 63, 8: 511, 9: 31, 10: 31 };
  var names = { 0: 'STATUS', 1: 'CURRENT', 2: 'FORECAST', 3: 'USAGE', 4: 'PERIOD', 5: 'UPDATED', 6: 'DETAIL', 8: 'BREAKDOWN', 9: 'BAND1', 10: 'BAND2' };
  Object.keys(limits).forEach(function(key) { safe[names[key]] = String(payload[key] == null ? '--' : payload[key]).slice(0, limits[key]); });
  // This whitelist is the only phone-to-watch path. Configuration and secrets never enter it.
  transport.send(safe);
}
function blank(status, detail) {
  send({ 0: status, 1: '--', 2: '--', 3: '--', 4: core.monthInfo(Date.now()).month,
    5: '--', 6: detail || 'Open settings on phone', 8: '--' });
}
function coverageStatus(payload) {
  var status = String(payload[0] || '');
  return (status.indexOf('missing') >= 0 ? ' / missing' : '') +
    (status.indexOf('delayed') >= 0 ? ' / delayed data' : '');
}
function failure(code) {
  phase('ERROR ' + (labels[code] ? code : 'settings'));
  busy = false;
  if (last && last.month === core.monthInfo(Date.now()).month &&
      ['http', 'graphql', 'network', 'timeout', 'auth'].indexOf(code) >= 0) {
    var old = last.payload;
    send({ 0: (last.demo ? 'DEMO / Cached / Update failed' : 'Cached / Update failed') + coverageStatus(old), 1: old[1], 2: old[2], 3: old[3],
      4: old[4], 5: old[5], 6: old[6] + '; ' + (labels[code] || 'Update failed'), 8: old[8], 9: old[9], 10: old[10] });
  } else { blank('Unavailable', labels[code] || 'Check phone settings'); }
}
function signal(stage) {
  phase(stage);
  transport.send({ STATUS: (last ? 'Cached / ' : '') + 'Updating / ' + stage + (last ? coverageStatus(last.payload) : ''),
    DETAIL: ('Phone v1.0.8: ' + stage + (last ? '; ' + last.payload[6] : '')).slice(0,63) });
}
function update(startup) {
  if (busy) { return; }
  phase('UPDATE RECEIVED');
  var settings = store.read('settings'), now = Date.now(), info = core.monthInfo(now), version = revision;
  var from;
  try {
    var validated = core.validate(settings, info.month);
    from = core.collectionStart(info, validated);
    if (from > info.midnight) { if (startup) signal('READY'); failure('not_started'); return; }
    if (from === info.midnight) { if (startup) signal('READY'); failure('insufficient'); return; }
  } catch (e) { if (startup) signal('READY'); failure(e.code); return; }
  phase('RATES OK');
  validated.demo = settings.demo === true;
  var credentials = store.read('credentials');
  if (cache.complete(last, validated, info, from, now) &&
      (settings.demo === true || (credentials && credentials.email && credentials.password))) {
    var reused = {};
    Object.keys(last.payload).forEach(function(key) { reused[key] = last.payload[key]; });
    reused[0] = last.demo ? 'DEMO / Complete cache' : 'Complete cache';
    phase('CACHE HIT');
    send(reused);
    return;
  }
  // READY is useful when an actual fetch is needed; a cache hit needs only the result.
  if (startup) signal('READY');
  busy = true;
  if (last) {
    var old = last.payload;
    send({ 0: (last.demo ? 'DEMO / Cached / Updating' : 'Cached / Updating') + coverageStatus(old), 1: old[1], 2: old[2], 3: old[3],
      4: old[4], 5: old[5], 6: old[6] + '; Updating', 8: old[8], 9: old[9], 10: old[10] });
  } else { blank(settings.demo ? 'DEMO / Updating' : 'Updating', 'Please wait'); }
  function completed(err, readings) {
    if (version !== revision) { return; }
    if (err) { failure(err.code); return; }
    try {
      var result = core.estimate(readings, settings, now), observed = result.observed;
      function breakdown(title, amount) {
        function money(n) { return Math.abs(n) < 1000000000 ? n.toFixed(2) : n.toExponential(2); }
        return title + '\nBase ' + money(amount.basic) + '\nBand 1 ' + money(amount.bandCharge1) +
          '\nBand 2 ' + money(amount.bandCharge2) + '\nFuel ' + money(amount.fuel) +
          '\nGovt ' + money(amount.government) + '\nRenewable ' + money(amount.renewable) +
          '\nAdded tax ' + money(amount.tax) + '\nTotal JPY ' + amount.total;
      }
      var quality = (observed.missing ? ' / missing' : '') + (observed.delayed ? ' / delayed data' : '');
      var through = clockText(observed.end - core.DAY).slice(0, 5);
      var first = clockText(observed.start).slice(0, 5);
      var partialMonth = observed.start > info.start;
      var detail = (partialMonth ? 'From ' + first + '; ' : '') + 'Through ' + through;
      if (observed.delayed) { detail += '; ' + observed.lagDays + 'd behind'; }
      if (observed.missing) { detail += '; missing ' + clockText(observed.firstMissingDay).slice(0, 5); }
      var coverage = 'DATA COVERAGE\nFrom ' + first + '\nComplete days ' + observed.days + '\nThrough ' + through +
        '\nDays behind ' + observed.lagDays + '\nMissing slots ' + observed.missingSlots +
        '\nZero inferred ' + observed.inferredZeroSlots + '\nConflicting slots ' + observed.conflicts + '\nInvalid slots ' + observed.invalidSlots;
      var fetchedAt = Date.now();
      var payload = { 0: (settings.demo ? 'DEMO - sample usage' : 'Estimate') + quality,
        1: 'JPY ' + result.current.total, 2: 'JPY ' + result.forecast.total,
        3: observed.kwh.toFixed(2) + ' kWh', 4: partialMonth ? first + '-' + through + ' / ' + observed.days + (observed.days === 1 ? ' day' : ' days') : observed.month + ' / ' + observed.days + ' days',
        5: clockText(fetchedAt), 6: detail,
        8: coverage + '\n\n' + breakdown('CURRENT BREAKDOWN', result.current) + '\n\n' + breakdown('FORECAST BREAKDOWN', result.forecast),
        9: observed.bands[0].toFixed(2), 10: observed.bands[1].toFixed(2) };
      last = { schema: 2, month: info.month, demo: settings.demo === true, payload: payload,
        start: observed.start, end: observed.end, complete: !observed.missing && !observed.delayed && observed.end === info.midnight,
        settingsKey: cache.settingsKey(validated), fetchedAt: fetchedAt };
      store.write('cache', last);
      busy = false; phase('COMPLETE'); send(payload);
    } catch (e) { failure(e.code || 'calculation'); }
  }
  if (settings.demo === true) { completed(null, core.demoReadings(now)); return; }
  if (!credentials || !credentials.email || !credentials.password) { failure('auth'); return; }
  client.readings(credentials, from, now, completed, signal);
}
function openConfiguration() {
  var previous = journal.summary();
  phase('SETTINGS OPEN');
  // Clay is needed only for settings, not for starting the phone companion.
  Clay = Clay || require('@rebble/clay');
  config = config || require('./config');
  var settings = store.read('draft') || store.read('settings') || {};
  // Recreate Clay without restored credentials. Never put saved secrets in the opening URL.
  var definition = JSON.parse(JSON.stringify(config));
  definition.splice(1, 0, { type: 'text', defaultValue: '診断 v1.0.8\n' + previous });
  function populate(items) {
    items.forEach(function(item) {
      if (item.items) { populate(item.items); }
      if (item.messageKey && ['email', 'password', 'clearCredentials'].indexOf(item.messageKey) < 0 &&
          settings[item.messageKey] !== undefined) { item.defaultValue = settings[item.messageKey]; }
      if (item.messageKey === 'month' && !settings.month) { item.defaultValue = core.monthInfo(Date.now()).month; }
    });
  }
  populate(definition);
  clay = new Clay(definition, null, { autoHandleEvents: false });
  // Clear Clay's own stored values: our separate store controls credentials and configuration.
  localStorage.removeItem('clay-settings');
  Pebble.openURL(clay.generateUrl());
}
if (bootError) {
  Pebble.addEventListener('ready', reportBootError);
  Pebble.addEventListener('appmessage', reportBootError);
  Pebble.addEventListener('showConfiguration', reportBootError);
} else {
Pebble.addEventListener('ready', function() {
  last = store.read('cache');
  if (!cache.snapshot(last) || last.month !== core.monthInfo(Date.now()).month) { last = null; }
  update(true);
});
Pebble.addEventListener('appmessage', function(e) { if (e.payload && (e.payload.REFRESH || e.payload[7])) { phase('WATCH REQUEST'); update(); } });
Pebble.addEventListener('showConfiguration', function() {
  try { openConfiguration(); }
  catch (e) { blank('Phone error', 'Phone v1.0.8 settings failed'); }
});
Pebble.addEventListener('webviewclosed', function(e) {
  phase('SAVE CALLBACK');
  journal.record('save', 'CALLBACK RECEIVED');
  if (!e.response) { phase('SAVE EMPTY / CANCELLED'); journal.record('save', 'EMPTY / CANCELLED'); return; }
  revision++; client.cancel(); busy = false; last = null;
  var received = false;
  try {
    // The companion may restart while the settings WebView is open. Parse its
    // documented Clay response without depending on the previous Clay instance.
    var response = e.response.charAt(0) === '{' ? e.response : decodeURIComponent(e.response);
    var raw = JSON.parse(response), input = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new Error('settings'); }
    Object.keys(raw).forEach(function(key) {
      input[key] = raw[key] && typeof raw[key] === 'object' ? raw[key].value : raw[key];
    });
    received = true;
    phase('SAVE PARSED');
    journal.record('save', 'PARSED');
    // Disable persistence by Clay; only our explicit storage keys retain credentials.
    localStorage.removeItem('clay-settings');
    store.updateCredentials(input);
    store.removeCache();
    store.saveDraft(input);
    var settings = core.validate(input, core.monthInfo(Date.now()).month);
    settings.demo = input.demo === true;
    store.write('settings', settings);
    phase('SAVE VALID');
    journal.record('save', 'VALID');
    if (input.clearCredentials === true) { blank('Login removed', 'Login again in phone settings'); }
    else { update(); }
  } catch (err) {
    journal.record('save', received ? 'FAILED AFTER PARSE' : 'PARSE FAILED');
    localStorage.removeItem('clay-settings');
    if (received) { store.removeSettings(); }
    failure(err.code || 'settings');
  }
});

}
