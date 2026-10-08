'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const core = require('../src/pkjs/core');
const Api = require('../src/pkjs/api');
const storage = require('../src/pkjs/storage');
const now = Date.parse('2026-10-03T12:00:00+09:00');
const rates = { month: '2026-10', basicMode: 'month', basicRate: '100', rate1: '10', rate2: '30',
  bandStart: '09:00', bandEnd: '21:00', fuelRate: '-1', governmentRate: '2', taxMode: 'excluded', taxRate: '10' };
function watchPayload(payload) {
  const keys = require('../package.json').pebble.messageKeys;
  return Object.fromEntries(Object.entries(payload).map(([key,value]) => [keys[key] === undefined ? key : keys[key],value]));
}
function memory() {
  const data = {};
  return { data, getItem(k) { return data[k] || null; }, setItem(k,v) { data[k] = String(v); }, removeItem(k) { delete data[k]; } };
}
function app(autoAck = true, appNow = now, restoredStorage = null) {
  const localStorage = restoredStorage || memory(), events = {}, sent = [], requests = [], urls = [], acknowledgements = [];
  let clockNow = appNow;
  class FakeDate extends Date { static now() { return clockNow; } }
  class Clay {
    constructor(config, custom, options) { assert.equal(options.autoHandleEvents, false); this.config = config; }
    generateUrl() { assert.equal(localStorage.getItem('clay-settings'), null); return JSON.stringify(this.config); }
    getSettings(response) {
      const result = JSON.parse(response); localStorage.setItem('clay-settings', response); return result;
    }
  }
  class XHR {
    constructor() { this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k,v) { this.headers[k] = v; }
    send(body) { this.body = JSON.parse(body); }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    reply(data, status = 200) { this.status = status; this.responseText = JSON.stringify(data); this.onload(); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), {
    Date: FakeDate, localStorage, XMLHttpRequest: XHR,
    require(name) { if (name === '@rebble/clay') return Clay; return require('../src/pkjs/' + name.slice(2)); },
    Pebble: { addEventListener(k,fn) { events[k] = fn; }, sendAppMessage(p,ok) { sent.push(watchPayload(p)); if (autoAck) ok(); else acknowledgements.push(ok); }, openURL(url) { urls.push(url); } }
  });
  const store = new storage.Store(localStorage);
  function save(values) {
    events.showConfiguration();
    const raw = {};
    Object.keys(values).forEach(k => { raw[k] = { value: values[k] }; });
    events.webviewclosed({ response: JSON.stringify(raw) });
  }
  return { events, sent, requests, urls, store, localStorage, save, acknowledgements, setNow(value) { clockNow = value; } };
}
test('settings use Clay value wrappers, retain blank credentials and whitelist watch messages', () => {
  const a = app();
  a.save(Object.assign({}, rates, { email: 'example@example.invalid', password: 'test-only-secret', demo: true }));
  assert.equal(a.store.read('credentials').password, 'test-only-secret');
  assert.match(a.sent.at(-1)[0], /DEMO/);
  assert.equal(a.localStorage.getItem('clay-settings'), null);
  a.save(Object.assign({}, rates, { email: '', password: '', demo: true }));
  assert.equal(a.store.read('credentials').password, 'test-only-secret');
  assert.ok(!JSON.stringify(a.sent).includes('test-only-secret'));
  assert.ok(!JSON.stringify(a.urls).includes('test-only-secret'));
  a.sent.forEach(p => assert.deepEqual(Object.keys(p), ['0','1','2','3','4','5','6','8','9','10']));
  assert.match(a.sent.at(-1)[8], /FORECAST BREAKDOWN/);
});
test('real API auth, viewer and readings flow, update overlap is suppressed', () => {
  const a = app();
  a.save(Object.assign({}, rates, { email: 'example@example.invalid', password: 'test-only-secret' }));
  assert.equal(a.requests.length, 1);
  a.events.appmessage({ payload: { 7: 1 } });
  assert.equal(a.requests.length, 1);
  a.requests[0].reply({ data: { obtainKrakenToken: { token: 'fake-token' } } });
  assert.equal(a.requests[1].headers.Authorization, 'JWT fake-token');
  a.requests[1].reply({ data: { viewer: { accounts: [{ number: 'test-account' }] } } });
  a.requests[2].reply({ data: { account: { properties: [{ electricitySupplyPoints: [{ halfHourlyReadings: core.demoReadings(now) }] }] } } });
  assert.equal(a.sent.at(-1)[0], 'Estimate');
  assert.ok(a.sent.at(-1)[1].startsWith('JPY '));
  assert.ok(!JSON.stringify(a.sent).includes('fake-token'));
});
test('mid-month supply starts persist in Clay and narrow real API path before watch delivery', () => {
  const later = Date.parse('2026-10-04T00:19:00+09:00'), a = app(true, later);
  a.save(Object.assign({}, rates, { contractStartDate: '2026-10-03', email: 'example@example.invalid', password: 'test-only-secret' }));
  assert.equal(a.store.read('settings').contractStartDate, '2026-10-03');
  assert.equal(a.store.read('draft').contractStartDate, '2026-10-03');
  a.requests[0].reply({ data: { obtainKrakenToken: { token: 'fake-token' } } });
  a.requests[1].reply({ data: { viewer: { accounts: [{ number: 'test-account' }] } } });
  assert.equal(a.requests[2].body.variables.fromDatetime, '2026-10-02T15:00:00.000Z');
  assert.equal(a.requests[2].body.variables.toDatetime, '2026-10-03T15:19:00.000Z');
  const day = core.demoReadings(later).slice(96);
  a.requests[2].reply({ data: { account: { properties: [{ electricitySupplyPoints: [{ halfHourlyReadings: day }] }] } } });
  const expected = core.estimate(day, {...rates, contractStartDate: '2026-10-03'}, later);
  const p = a.sent.at(-1);
  assert.equal(p[0], 'Estimate');
  assert.equal(p[1], 'JPY ' + expected.current.total);
  assert.equal(p[2], 'JPY ' + expected.forecast.total);
  assert.equal(p[4], '10/03-10/03 / 1 day');
  assert.match(p[6], /From 10\/03; Through 10\/03/);
  assert.match(p[8], /Missing slots 0/);
  a.events.showConfiguration();
  assert.match(a.urls.at(-1), /"messageKey":"contractStartDate"[^}]*"defaultValue":"2026-10-03"/);
  a.events.appmessage({ payload: { REFRESH: 1 } });
  assert.equal(a.requests.length, 3, 'same-day complete result now reuses cache');
});
test('future supply starts avoid API calls and invalid dates clear old estimates', () => {
  const a = app();
  a.save({...rates, contractStartDate:'2026-11-01', demo:true});
  assert.equal(a.sent.at(-1)[1], '--');
  assert.equal(a.sent.at(-1)[6], 'Supply not started');
  assert.equal(a.requests.length, 0);
  a.save({...rates, contractStartDate:'2026-10-02', demo:true});
  assert.notEqual(a.sent.at(-1)[1], '--');
  a.save({...rates, contractStartDate:'2026-02-30', demo:true});
  assert.equal(a.store.read('cache'), null);
  assert.equal(a.store.read('settings'), null);
  assert.equal(a.sent.at(-1)[6], 'Check supply start date');
});
test('clear credentials cancels active request, delayed reply cannot restore cache', () => {
  const a = app();
  a.save(Object.assign({}, rates, { email: 'example@example.invalid', password: 'test-only-secret' }));
  const pending = a.requests[0];
  a.save(Object.assign({}, rates, { clearCredentials: true }));
  assert.equal(pending.aborted, true);
  pending.reply({ data: { obtainKrakenToken: { token: 'late-token' } } });
  assert.equal(a.store.read('credentials'), null);
  assert.equal(a.store.read('cache'), null);
  assert.equal(a.requests.length, 1);
  assert.equal(a.sent.at(-1)[0], 'Login removed');
});
test('invalid saved time removes old rates and cannot produce old amounts on refresh', () => {
  const a = app();
  a.save(Object.assign({}, rates, { demo: true }));
  a.save(Object.assign({}, rates, { bandStart: '09:15', demo: true }));
  assert.equal(a.store.read('settings'), null);
  a.events.appmessage({ payload: { 7: 1 } });
  assert.equal(a.sent.at(-1)[1], '--');
  assert.equal(a.store.read('cache'), null);
});
test('partially completed Clay form survives reopen without making rates valid or exposing credentials', () => {
  const a = app();
  a.save(Object.assign({}, rates, { bandStart: '', email: 'example@example.invalid', password: 'draft-secret', demo: true }));
  assert.equal(a.store.read('settings'), null);
  assert.equal(a.store.read('draft').basicRate, '100');
  assert.equal(a.store.read('draft').bandStart, '');
  assert.equal(a.store.read('draft').password, undefined);
  a.events.showConfiguration();
  const definition = JSON.parse(a.urls.at(-1));
  const fields = definition.flatMap(section => section.items || [section]);
  assert.equal(fields.find(item => item.messageKey === 'basicRate').defaultValue, '100');
  assert.equal(fields.find(item => item.messageKey === 'bandEnd').defaultValue, '21:00');
  assert.equal(fields.find(item => item.messageKey === 'password').defaultValue, '');
  assert.ok(!a.urls.at(-1).includes('draft-secret'));
  a.events.appmessage({ payload: { 7: 1 } });
  assert.equal(a.sent.at(-1)[1], '--');
});
test('Clay response is saved even if companion restarted without a Clay instance', () => {
  const a = app();
  const raw = {};
  Object.keys(rates).forEach(k => { raw[k] = { value: rates[k] }; });
  raw.demo = { value: true };
  a.events.webviewclosed({ response: encodeURIComponent(JSON.stringify(raw)) });
  assert.equal(a.store.read('settings').rate1, 10);
  assert.equal(a.store.read('draft').rate2, '30');
  assert.match(a.sent.at(-1)[0], /DEMO/);
});
test('cancelled and malformed callbacks preserve the previously saved form', () => {
  const a = app();
  a.save(Object.assign({}, rates, { demo: true }));
  const before = JSON.stringify(a.store.read('settings'));
  const draft = JSON.stringify(a.store.read('draft'));
  a.events.webviewclosed({ response: '' });
  a.events.webviewclosed({ response: '%invalid' });
  assert.equal(JSON.stringify(a.store.read('settings')), before);
  assert.equal(JSON.stringify(a.store.read('draft')), draft);
});
test('API malformed null, HTTP, GraphQL and timeout states complete', () => {
  ['null', 'http', 'graphql', 'timeout'].forEach(kind => {
    const a = app();
    a.save(Object.assign({}, rates, { email: 'example@example.invalid', password: 'test-only-secret' }));
    if (kind === 'null') a.requests[0].reply(null);
    if (kind === 'http') a.requests[0].reply({}, 500);
    if (kind === 'graphql') a.requests[0].reply({ errors: [{ message: 'secret response must stay private' }] });
    if (kind === 'timeout') a.requests[0].ontimeout();
    assert.equal(a.sent.at(-1)[0], 'Unavailable');
    a.events.appmessage({ payload: { 7: 1 } });
    assert.equal(a.requests.length, 2);
    assert.ok(!JSON.stringify(a.sent).includes('secret response'));
  });
});
test('SDK bundled companion and real Clay generate local configuration without saved secrets', () => {
  const events = {}, sent = [], urls = [], localStorage = memory();
  new storage.Store(localStorage).write('credentials', { email: 'example@example.invalid', password: 'bundled-test-secret' });
  const context = { localStorage, console: { log() {}, error() {}, warn() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    Pebble: { platform: 'ios', addEventListener(k,f) { events[k] = f; }, openURL(u) { urls.push(u); }, sendAppMessage(p,ok) { sent.push(watchPayload(p)); ok(); },
      getActiveWatchInfo() { return { platform: 'basalt' }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../build/pebble-js-app.js'), 'utf8'), context);
  const raw = Object.fromEntries(Object.entries(Object.assign({}, rates, { bandStart: '', demo: true })).map(([key,value]) => [key,{value}]));
  events.webviewclosed({ response: encodeURIComponent(JSON.stringify(raw)) });
  assert.equal(new storage.Store(localStorage).read('draft').basicRate, '100');
  assert.equal(new storage.Store(localStorage).read('settings'), null);
  events.showConfiguration();
  assert.ok(urls[0].startsWith('data:text/html'));
  assert.ok(!decodeURIComponent(urls[0]).includes('bundled-test-secret'));
  assert.ok(decodeURIComponent(urls[0]).includes('type="password"') || decodeURIComponent(urls[0]).includes('password'));
});
test('partial coverage sends usable amounts with inclusive dates and keeps warnings during failed refresh', () => {
  const a = app();
  a.save({...rates, email: 'example@example.invalid', password: 'test-only-secret'});
  a.requests[0].reply({ data: { obtainKrakenToken: { token: 'fake-token' } } });
  a.requests[1].reply({ data: { viewer: { accounts: [{ number: 'test-account' }] } } });
  const readings = core.demoReadings(now);
  readings.pop(); // Day 2 final slot has no later positive evidence; day 1 remains usable.
  a.requests[2].reply({ data: { account: { properties: [{ electricitySupplyPoints: [{ halfHourlyReadings: readings }] }] } } });
  const result = a.sent.at(-1);
  assert.equal(result[0], 'Estimate / missing / delayed data');
  assert.match(result[1], /^JPY \d+$/);
  assert.match(result[2], /^JPY \d+$/);
  assert.equal(result[4], '2026-10 / 1 days');
  assert.equal(result[6], 'Through 10/01; 1d behind; missing 10/02');
  assert.match(result[8], /Missing slots 1/);
  a.events.appmessage({payload:{7:1}});
  assert.match(a.sent.at(-1)[0] || a.sent.at(-1).STATUS, /Updating.*missing.*delayed/);
  a.requests[3].ontimeout();
  assert.match(a.sent.at(-1)[0], /Update failed.*missing.*delayed/);
  assert.equal(a.sent.at(-1)[1], result[1]);
  assert.match(a.sent.at(-1)[6], /^Through 10\/01/);
});
test('October 4 at 00:19 uses October 3 as last day, or October 2 if its final slot is late', () => {
  const at = Date.parse('2026-10-04T00:19:00+09:00');
  const readings = core.demoReadings(at);
  let result = core.estimate(readings, rates, at);
  assert.equal(result.observed.days, 3);
  assert.equal(new Date(result.observed.end - core.DAY).toISOString(), '2026-10-02T15:00:00.000Z');
  assert.equal(result.observed.delayed, false);
  readings.pop();
  result = core.estimate(readings, rates, at);
  assert.equal(result.observed.days, 2);
  assert.equal(result.observed.missing, true);
  assert.equal(result.observed.lagDays, 1);
  assert.ok(result.current.total > 0);
  assert.ok(result.forecast.total > 0);
});

test('fast completion waits for the Updating message acknowledgement before transmission', () => {
  const a = app(false);
  a.save({...rates, demo: true});
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0][0], /Updating/);
  a.acknowledgements.shift()();
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1][0], /DEMO - sample usage/);
  a.acknowledgements.shift()();
  a.setNow(now + core.DAY); // Move past the complete-cache JST boundary.
  a.events.appmessage({payload:{REFRESH:1}});
  assert.equal(a.sent.length, 3);
  assert.match(a.sent[2][0], /Updating/);
  a.acknowledgements.shift()();
  assert.equal(a.sent.length, 4);
  assert.match(a.sent[3][0], /DEMO - sample usage/);
});

test('So far band usage uses adopted actual prefix, retaining it with cached prices after failed refresh', () => {
  const t=Date.parse('2026-10-06T00:19:00+09:00'), a=app(true,t);
  function day(date,value) {
    const start=Date.parse(date+'T00:00:00+09:00');
    return Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:typeof value==='function'?value(i):value}));
  }
  a.save({...rates,contractStartDate:'2026-10-03',email:'qa@example.invalid',password:'private-only'});
  a.requests[0].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
  a.requests[1].reply({data:{viewer:{accounts:[{number:'account'}]}}});
  // Adopt only Oct 3: band1=2,band2=3. Oct 4 is invalid and Oct 5 is huge.
  const readings=[...day('2026-10-03',i=>i>=18&&i<42?2/24:3/24),...day('2026-10-04',i=>i===0?-1:0),...day('2026-10-05',100)];
  a.requests[2].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:readings}]}]}}});
  const p=a.sent.at(-1);
  assert.equal(p[9],'2.00');assert.equal(p[10],'3.00');
  assert.equal(p[4],'10/03-10/03 / 1 day');assert.match(p[0],/missing/);
  assert.match(p[8],/Complete days 1/);
  a.events.appmessage({payload:{REFRESH:1}});
  const updating=a.sent.findLast(p=>p[1]===a.store.read('cache').payload[1] && /Updating/.test(p[0]));
  assert.equal(updating[9],'2.00');assert.equal(updating[10],'3.00');
  a.requests[3].reply({},503);
  const failed=a.sent.at(-1);
  assert.equal(failed[1],p[1]);assert.equal(failed[4],p[4]);
  assert.equal(failed[9],p[9]);assert.equal(failed[10],p[10]);assert.match(failed[0],/Cached/);
  a.save({...rates,contractStartDate:'not-a-date',demo:true});
  assert.equal(a.sent.at(-1)[1],'--');assert.equal(a.sent.at(-1)[9],'--');assert.equal(a.sent.at(-1)[10],'--');
});

test('complete zero bands are numeric zero, while legacy phone cache has unknown band usage',()=>{
 const a=app(true,Date.parse('2026-10-04T00:19:00+09:00'));
 a.store.write('settings',{...rates,contractStartDate:'2026-10-03'});
 a.store.write('credentials',{email:'qa@example.invalid',password:'private-only'});
 a.store.write('cache',{month:'2026-10',demo:false,payload:{0:'Estimate',1:'JPY 149',2:'JPY 4315',3:'5.00 kWh',4:'10/03-10/03 / 1 day',5:'10/04 00:00 JST',6:'Through 10/03',8:'legacy'}});
 a.events.ready();
 const legacy=a.sent.findLast(p=>p[1]==='JPY 149');
 assert.equal(legacy[9],'--');assert.equal(legacy[10],'--');
 a.requests[0].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
 a.requests[1].reply({data:{viewer:{accounts:[{number:'account'}]}}});
 const start=Date.parse('2026-10-03T00:00:00+09:00');
 const zero=Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:0}));
 a.requests[2].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:zero}]}]}}});
 assert.equal(a.sent.at(-1)[9],'0.00');assert.equal(a.sent.at(-1)[10],'0.00');
 assert.notEqual(a.sent.at(-1)[1],'--');
 a.events.appmessage({payload:{REFRESH:1}});assert.equal(a.requests.length,3,'a complete zero-use day is a valid cache hit');
});

test('overnight bands remain actual kWh at boundaries and refresh despite equal prices and totals',()=>{
 const t=Date.parse('2026-10-04T00:19:00+09:00'),a=app(true,t);
 a.save({...rates,contractStartDate:'2026-10-03',bandStart:'22:00',bandEnd:'06:00',rate1:10,rate2:10,email:'qa@example.invalid',password:'private-only'});
 function finish(first,second,offset) {
  a.requests[offset].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
  a.requests[offset+1].reply({data:{viewer:{accounts:[{number:'account'}]}}});
  const start=Date.parse('2026-10-03T00:00:00+09:00');
  const readings=Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:i<12||i>=44?first/16:second/32}));
  a.requests[offset+2].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:readings}]}]}}});
  return a.sent.at(-1);
 }
 const old=finish(1,2,0);
 assert.equal(old[9],'1.00');assert.equal(old[10],'2.00');
 a.setNow(t+core.DAY); // Force a new required day, preserving equal adopted totals.
 a.events.appmessage({payload:{REFRESH:1}});
 const updated=finish(2,1,3);
 assert.equal(updated[1],old[1]);assert.equal(updated[3],old[3]);assert.equal(updated[4],old[4]);
 assert.equal(updated[9],'2.00');assert.equal(updated[10],'1.00');
});

function completeCacheApp() {
 const t=Date.parse('2026-10-04T00:19:00+09:00'),a=app(true,t);
 a.save({...rates,contractStartDate:'2026-10-03',email:'qa@example.invalid',password:'private-only'});
 a.requests[0].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
 a.requests[1].reply({data:{viewer:{accounts:[{number:'account'}]}}});
 const start=Date.parse('2026-10-03T00:00:00+09:00');
 const readings=Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:0.15}));
 a.requests[2].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:readings}]}]}}});
 return {a,t,payload:a.sent.at(-1)};
}
test('complete cache skips API on SELECT and phone restart while preserving fetched timestamp and all result fields',()=>{
 const {a,t,payload}=completeCacheApp();
 const persisted=a.localStorage.getItem(storage.KEYS.cache);
 a.setNow(t+3600000);
 a.events.appmessage({payload:{REFRESH:1}});
 assert.equal(a.requests.length,3);
 assert.match(a.sent.at(-1)[0],/cache/i);
 for(const k of [1,2,3,4,5,8,9,10]) assert.equal(a.sent.at(-1)[k],payload[k]);
 const restarted=app(true,t+7200000,a.localStorage);
 restarted.events.ready();
 assert.equal(restarted.requests.length,0);
 assert.equal(restarted.sent.length,1,'hit must not send READY/Updating stages before cached result');
 assert.match(restarted.sent[0][0],/cache/i);
 for(const k of [1,2,3,4,5,8,9,10]) assert.equal(restarted.sent[0][k],payload[k]);
 restarted.events.appmessage({payload:{7:1}});
 assert.equal(restarted.requests.length,0);
 assert.equal(restarted.sent.at(-1)[5],payload[5]);
 assert.equal(restarted.localStorage.getItem(storage.KEYS.cache),persisted,'hit does not rewrite the acquired snapshot');
});
test('cache day boundary is JST midnight, not UTC midnight, and incomplete prefixes still retry',()=>{
 const {a}=completeCacheApp();
 for(const t of ['2026-10-03T23:59:00Z','2026-10-04T00:01:00Z']) {
  a.setNow(Date.parse(t));a.events.appmessage({payload:{REFRESH:1}});assert.equal(a.requests.length,3);
 }
 a.setNow(Date.parse('2026-10-05T00:00:00+09:00'));
 a.events.appmessage({payload:{REFRESH:1}});assert.equal(a.requests.length,4);
 a.requests[3].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
 a.requests[4].reply({data:{viewer:{accounts:[{number:'account'}]}}});
 // Oct 4 now required but absent: first day remains valid, result is delayed.
 const start=Date.parse('2026-10-03T00:00:00+09:00');
 const day=Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:0}));
 a.requests[5].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:day}]}]}}});
 a.events.appmessage({payload:{REFRESH:1}});assert.equal(a.requests.length,7);
});
test('saving even identical settings forces API refresh and credential removal invalidates complete cache',()=>{
 const {a}=completeCacheApp();
 a.save({...rates,contractStartDate:'2026-10-03',email:'',password:''});
 assert.equal(a.requests.length,4);
 assert.equal(a.store.read('cache'),null);
 a.save({...rates,contractStartDate:'2026-10-03',clearCredentials:true});
 assert.equal(a.store.read('cache'),null);assert.equal(a.store.read('credentials'),null);
 assert.equal(a.sent.at(-1)[1],'--');assert.equal(a.sent.at(-1)[9],'--');
 a.events.appmessage({payload:{REFRESH:1}});
 assert.equal(a.requests.length,4);assert.equal(a.sent.at(-1)[1],'--');
});
test('invalid complete cache metadata or result fields never skips authentication request',()=>{
 const {a,t}=completeCacheApp(),snapshot=a.store.read('cache');
 const mutations=[
  c=>delete c.schema,c=>c.schema=1,c=>c.schema=999,c=>delete c.settingsKey,c=>c.settingsKey='different',
  c=>c.fetchedAt=t+60000,c=>c.fetchedAt=0,c=>c.start+=86400000,c=>c.end-=86400000,
  c=>c.demo=true,c=>delete c.complete,c=>c.complete=false,c=>delete c.payload[9],c=>delete c.payload[8],c=>delete c.payload[4],
  c=>c.payload[10]='NaN',c=>c.payload[10]='0x10',c=>c.payload[1]='JPY -1',c=>c.payload[1]='JPY '+ '9'.repeat(100),c=>c.payload[0]='Estimate / missing',
  c=>c.payload[4]='--',c=>c.payload[4]='',c=>c.payload[5]='--',c=>c.payload[5]='',c=>c.payload[6]='--',c=>c.payload[8]='',c=>c.payload[8]='corrupt'
 ];
 for(const mutate of mutations) {
  const restored=memory();Object.assign(restored.data,a.localStorage.data);
  const cache=JSON.parse(JSON.stringify(snapshot));mutate(cache);
  const b=app(true,t,restored);b.store.write('cache',cache);b.events.ready();
  assert.equal(b.requests.length,1,'invalid cache must enter real API path: '+mutate.toString());
  b.requests[0].reply({},503);
 }
 const restored=memory();Object.assign(restored.data,a.localStorage.data);
 const b=app(true,t,restored);b.store.write('settings',{...b.store.read('settings'),rate1:11});b.events.ready();
 assert.equal(b.requests.length,1,'changed normalized rates must miss despite same month/end');
 b.requests[0].reply({},503);
});

test('new JST month and changed supply start cannot reuse an old complete snapshot',()=>{
 const {a,t}=completeCacheApp();
 const restored=memory();Object.assign(restored.data,a.localStorage.data);
 const b=app(true,Date.parse('2026-11-02T00:19:00+09:00'),restored);
 b.store.write('settings',{...b.store.read('settings'),month:'2026-11'});
 b.events.ready();assert.equal(b.requests.length,1);
 b.requests[0].reply({data:{obtainKrakenToken:{token:'fake-token'}}});
 b.requests[1].reply({data:{viewer:{accounts:[{number:'account'}]}}});
 assert.equal(b.requests[2].body.variables.fromDatetime,'2026-10-31T15:00:00.000Z');
 b.requests[2].reply({},503);
 const c=app(true,t,a.localStorage);
 c.store.write('settings',{...c.store.read('settings'),contractStartDate:'2026-10-05'});
 c.events.ready();assert.equal(c.requests.length,0);assert.equal(c.sent.at(-1)[1],'--');
 assert.equal(c.sent.at(-1)[6],'Supply not started');
});

test('real API today evidence resolves previous-day gaps, retains zero-inference disclosure and fits watch payload',()=>{
 const at=Date.parse('2026-10-05T13:00:00+09:00'),a=app(true,at);
 const day=date=>{const start=Date.parse(date+'T00:00:00+09:00');return Array.from({length:48},(_,i)=>({startAt:new Date(start+i*core.HALF_HOUR).toISOString(),endAt:new Date(start+(i+1)*core.HALF_HOUR).toISOString(),value:1}));};
 a.save({...rates,contractStartDate:'2026-10-03',email:'qa@example.invalid',password:'not-for-watch'});
 a.requests[0].reply({data:{obtainKrakenToken:{token:'fake'}}});a.requests[1].reply({data:{viewer:{accounts:[{number:'fake'}]}}});
 assert.equal(a.requests[2].body.variables.toDatetime,new Date(at).toISOString());
 const readings=[...day('2026-10-03'),...day('2026-10-04').slice(0,47),...day('2026-10-05').slice(0,12).map(r=>({...r,value:1000}))];
 a.requests[2].reply({data:{account:{properties:[{electricitySupplyPoints:[{halfHourlyReadings:readings}]}]}}});
 const p=a.sent.at(-1);assert.equal(p[3],'95.00 kWh');assert.match(p[8],/Zero inferred 1/);assert.match(p[8],/FORECAST BREAKDOWN/);assert.match(p[8],/Total JPY \d+$/);
 const bounds={0:63,1:31,2:31,3:31,4:31,5:31,6:63,8:511,9:31,10:31};
 Object.entries(bounds).forEach(([key,bound])=>{assert(p[key].length<=bound);assert(/^[\x00-\x7f]*$/.test(p[key]));});
 assert(1+Object.values(p).reduce((sum,v)=>sum+8+v.length,0)<=1024);
 assert(!JSON.stringify(p).includes('not-for-watch'));assert.equal(a.store.read('cache').schema,2);
 a.events.appmessage({payload:{REFRESH:1}});assert.equal(a.requests.length,3);assert.equal(a.sent.at(-1)[0],'Complete cache');
});
