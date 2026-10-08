'use strict';
var ENDPOINT = 'https://api.oejp-kraken.energy/v1/graphql/';
var QUERIES = {
  auth: 'mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }',
  viewer: 'query accountViewer { viewer { accounts { number } } }',
  readings: 'query halfHourlyReadings($accountNumber: String!, $fromDatetime: DateTime, $toDatetime: DateTime) {' +
    ' account(accountNumber: $accountNumber) { properties { electricitySupplyPoints {' +
    ' halfHourlyReadings(fromDatetime: $fromDatetime, toDatetime: $toDatetime) { startAt endAt version value } } } } }'
};
function error(code) { var e = new Error(code); e.code = code; return e; }
function Client(xhrFactory) { this.factory = xhrFactory; this.active = null; this.timer = null; this.generation = 0; }
Client.prototype.cancel = function() {
  this.generation++;
  if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  if (this.active) { this.active.abort(); this.active = null; }
};
Client.prototype.request = function(query, variables, token, callback) {
  var self = this, generation = self.generation, xhr, finished = false;
  try {
    xhr = self.factory();
    if (!xhr || typeof xhr.open !== 'function' || typeof xhr.send !== 'function') { throw new Error('http_unavailable'); }
  } catch (e) { callback(error('http_unavailable')); return; }
  self.active = xhr;
  function done(err, data) {
    if (finished || generation !== self.generation) { return; }
    finished = true;
    if (self.timer !== null) { clearTimeout(self.timer); self.timer = null; }
    self.active = null; callback(err, data);
  }
  xhr.onload = function() {
    if (xhr.status === 401 || xhr.status === 403) { done(error('auth')); return; }
    if (xhr.status < 200 || xhr.status >= 300) { done(error('http')); return; }
    var body;
    try { body = JSON.parse(xhr.responseText); } catch (e) { done(error('data')); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { done(error('data')); return; }
    if (body.errors && body.errors.length) { done(error(query === QUERIES.auth ? 'auth' : 'graphql')); return; }
    if (!body.data) { done(error('data')); return; }
    done(null, body.data);
  };
  xhr.onerror = function() { done(error('network')); };
  xhr.ontimeout = function() { done(error('timeout')); };
  xhr.onabort = function() { done(error('cancelled')); };
  // Some phone runtimes do not dispatch the native XHR timeout reliably.
  self.timer = setTimeout(function() {
    done(error('timeout'));
    try { xhr.abort(); } catch (e) { /* Request is already completed. */ }
  }, 20000);
  if (self.timer && typeof self.timer.unref === 'function') { self.timer.unref(); }
  try {
  xhr.open('POST', ENDPOINT, true);
  xhr.timeout = 20000;
  xhr.setRequestHeader('Content-Type', 'application/json');
  if (token) { xhr.setRequestHeader('Authorization', 'JWT ' + token); }
    xhr.send(JSON.stringify({ query: query, variables: variables }));
  }
  catch (e) { done(error('network')); }
};
Client.prototype.readings = function(credentials, from, to, callback, progress) {
  var self = this;
  if (progress) { progress('AUTH'); }
  self.request(QUERIES.auth, { input: { email: credentials.email, password: credentials.password } }, null, function(err, data) {
    if (err) { callback(err); return; }
    var token = data.obtainKrakenToken && data.obtainKrakenToken.token;
    if (typeof token !== 'string' || !token) { callback(error('auth')); return; }
    if (progress) { progress('ACCOUNT'); }
    self.request(QUERIES.viewer, {}, token, function(err, data) {
      if (err) { callback(err); return; }
      var accounts = data.viewer && data.viewer.accounts;
      if (!Array.isArray(accounts) || !accounts.length) { callback(error('no_data')); return; }
      if (accounts.length !== 1) { callback(error('multiple')); return; }
      if (!accounts[0] || typeof accounts[0].number !== 'string' || !accounts[0].number) { callback(error('data')); return; }
      if (progress) { progress('USAGE'); }
      self.request(QUERIES.readings, { accountNumber: accounts[0].number,
        fromDatetime: new Date(from).toISOString(), toDatetime: new Date(to).toISOString() }, token, function(err, data) {
        token = null;
        if (err) { callback(err); return; }
        var properties = data.account && data.account.properties, points = [];
        if (!Array.isArray(properties)) { callback(error('data')); return; }
        properties.forEach(function(p) {
          if (p && Array.isArray(p.electricitySupplyPoints)) { points = points.concat(p.electricitySupplyPoints); }
        });
        if (!points.length) { callback(error('no_data')); return; }
        if (points.length !== 1) { callback(error('multiple')); return; }
        if (!points[0] || !Array.isArray(points[0].halfHourlyReadings)) { callback(error('data')); return; }
        callback(null, points[0].halfHourlyReadings);
      });
    });
  });
};
module.exports = { Client: Client, ENDPOINT: ENDPOINT, QUERIES: QUERIES };
