'use strict';
const watchKeys=require('../package.json').pebble.messageKeys;
function watchReceive(p){const result={};Object.keys(p).forEach(k=>{assert(Object.prototype.hasOwnProperty.call(watchKeys,k),'Unknown outbound key '+k);result[watchKeys[k]===undefined?k:watchKeys[k]]=p[k];});return result;}

const assert = require('assert');
const core = require('../src/pkjs/core');
const {Store, KEYS} = require('../src/pkjs/storage');
const {Client} = require('../src/pkjs/api');
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
const now = Date.parse('2026-10-03T03:00:00Z');
const base = {month:'2026-10', basicMode:'month', basicRate:100, bandStart:'06:00', bandEnd:'18:00', rate1:10, rate2:30, fuelRate:-1, governmentRate:2, taxMode:'excluded', taxRate:10};
function readings(days) {
  const start = core.monthInfo(now).start, out = [];
  for(let t = start; t < start + days * core.DAY; t += core.HALF_HOUR) {
    out.push({startAt:new Date(t).toISOString(),endAt:new Date(t+core.HALF_HOUR).toISOString(),version:'v1',value:core.bandAt(t,base) === 0 ? 1/12 : 1/8});
  } return out;
}
function code(fn, expected) { assert.throws(fn, e => e.code === expected); }
test('TOU and complete-day forecast independent amounts', () => {
  const r=core.estimate(readings(2),base,now);
  assert(Math.abs(r.observed.bands[0]-4)<1e-10); assert(Math.abs(r.observed.bands[1]-6)<1e-10);
  assert.strictEqual(r.current.total,298); // (600*2/31 + 220 + 10*1.18)*1.1
  assert.strictEqual(r.forecast.total,4613); // (600 + 3410 + 155*1.18)*1.1
});
test('6kVA month/day and tax modes final ceil', () => {
  assert.strictEqual(core.charge([4,6],2,30,{...base,taxMode:'included'}).total,272);
  assert.strictEqual(core.charge([4,6],2,30,{...base,taxMode:'included',taxRate:99}).total,272);
  assert.strictEqual(core.charge([0,0],2,30,{...base,basicMode:'day',basicRate:0.1,taxMode:'included'}).total,2);
  assert.strictEqual(core.charge([0,0],30,30,{...base}).total,660);
});
test('TOU JST same-day and midnight crossing boundaries', () => {
  const band=(time,s=base)=>core.bandAt(Date.parse('2026-10-01T'+time+':00+09:00'),s);
  assert.strictEqual(band('06:00'),0); assert.strictEqual(band('18:00'),1);
  const overnight={...base,bandStart:'23:00',bandEnd:'07:00'};
  ['23:00','00:00','06:30'].forEach(t=>assert.strictEqual(band(t,overnight),0));
  assert.strictEqual(band('07:00',overnight),1);
  assert.strictEqual(core.monthInfo(Date.parse('2026-09-30T15:00:00Z')).month,'2026-10');
});
test('invalid settings and legacy rates rejected', () => {
  ['06:01','24:00','','6:00'].forEach(t=>code(()=>core.validate({...base,bandStart:t},base.month),'settings'));
  code(()=>core.validate({...base,bandEnd:'06:00'},base.month),'settings');
  code(()=>core.validate({...base,rate1:''},base.month),'settings');
  code(()=>core.validate({...base,month:'2026-09'},base.month),'month');
  code(()=>core.validate({month:base.month,basicMode:'month',taxMode:'included',rate:30},base.month),'settings');
  assert.strictEqual(core.validate({...base,rate1:0},base.month).rate1,0);
});
test('internal absence is zero; duplicate conflict and malformed interval', () => {
  let r=readings(2); r.splice(10,1); assert.strictEqual(core.aggregate(r,now,base).days,2);
  r=readings(2);r.push({...r[0]});assert.strictEqual(core.aggregate(r,now,base).days,2);
  r.push({...r[0],version:'v2'});assert.strictEqual(core.aggregate(r,now,base).days,2);
  r.push({...r[0],value:999,version:'v3'});code(()=>core.aggregate(r,now,base),'conflict');
  r=readings(2);r[0].endAt=new Date(Date.parse(r[0].startAt)+60000).toISOString();code(()=>core.aggregate(r,now,base),'data');
});
test('later invalid values and known-day malformed intervals preserve the valid prefix', () => {
  for(const mutation of [{value:-1},{value:'not a number'},{endAt:'invalid'},{endAt:'2026-10-02T00:01:00+09:00'}]) {
    const r=readings(2);r[48]={...r[48],...mutation};
    const observed=core.aggregate(r,now,base);
    assert.strictEqual(observed.days,1);assert.strictEqual(observed.missing,true);
    assert(observed.invalidSlots>=1);
  }
  const r=readings(2);r[48].startAt='unknown day';code(()=>core.aggregate(r,now,base),'data');
});
test('later positive readings classify an internal gap as zero without changing observed energy', () => {
  const all=readings(4), withGap=all.filter((r,i)=>i!==48+10);
  const later=Date.parse('2026-10-05T03:00:00Z');
  const observed=core.aggregate(withGap,later,base);
  assert.strictEqual(observed.days,4);
  assert.strictEqual(observed.end,core.monthInfo(later).midnight);
  assert(Math.abs(observed.kwh-(20-1/8))<1e-10);
  assert.strictEqual(observed.delayed,false);
  assert.strictEqual(observed.missing,false);
  assert.strictEqual(observed.missingSlots,0);
});
test('47-slot trailing day is excluded; complete zero day is included', () => {
  const r=readings(2);r.pop();
  assert.strictEqual(core.aggregate(r,now,base).days,1);
  assert.strictEqual(core.aggregate(r,now,base).missing,true);
  const zero=readings(2).map(x=>({...x,value:0}));
  assert.strictEqual(core.aggregate(zero,now,base).days,2);
  assert.strictEqual(core.aggregate(zero,now,base).kwh,0);
});
test('conflict after a complete day stops prefix without hiding earlier valid day', () => {
  const r=readings(2);r.push({...r[48],value:999,version:'v2'});
  const observed=core.aggregate(r,now,base);
  assert.strictEqual(observed.days,1);assert.strictEqual(observed.conflicts,1);
  assert.strictEqual(observed.missing,true);
});
test('wholly absent trailing day is delayed and is distinct from a partial missing day', () => {
  const observed=core.aggregate(readings(1),now,base);
  assert.strictEqual(observed.days,1);assert.strictEqual(observed.delayed,true);
  assert.strictEqual(observed.missing,false);assert.strictEqual(observed.lagDays,1);
});
test('calendar day still in progress is excluded even if all its readings are supplied', () => {
  assert.strictEqual(core.aggregate(readings(3),now,base).days,2);
});
test('zero usage complete is valid and partial current day excluded', () => {
  const r=readings(2).map(x=>({...x,value:0}));
  r.push({startAt:'2026-10-03T00:00:00+09:00',endAt:'2026-10-03T00:30:00+09:00',value:999,version:'v1'});
  assert.strictEqual(core.aggregate(r,now,base).kwh,0);
});
test('credentials preserve blanks and explicit removal removes cache', () => {
  const mem={};const st=new Store({getItem:k=>mem[k]||null,setItem:(k,v)=>mem[k]=v,removeItem:k=>delete mem[k]});
  st.updateCredentials({email:'a@example.test',password:'secret'});st.updateCredentials({email:'',password:''});
  assert.deepStrictEqual(st.read('credentials'),{email:'a@example.test',password:'secret'});
  st.write('cache',{payload:'old'});st.updateCredentials({clearCredentials:true});
  assert.strictEqual(mem[KEYS.credentials],undefined);assert.strictEqual(mem[KEYS.cache],undefined);
});
test('API only mocked requests; cancel drops delayed response', () => {
  let xhr,called=0;
  const c=new Client(()=>xhr={open(){},setRequestHeader(){},send(){},abort(){if(this.onabort)this.onabort();}});
  c.readings({email:'a',password:'s'},0,1,()=>called++);
  c.cancel();xhr.status=200;xhr.responseText=JSON.stringify({data:{obtainKrakenToken:{token:'s'}}});xhr.onload();
  assert.strictEqual(called,0);
});
test('companion URL whitelist invalid-save and removal race mocked integration', () => {
  const vm=require('vm'), fs=require('fs'); const events={}, sent=[], mem={}, pending=[];let opened='';
  const localStorage={getItem:k=>mem[k]||null,setItem:(k,v)=>mem[k]=v,removeItem:k=>delete mem[k]};
  function Clay(definition, unused, opts) {
    assert.strictEqual(opts.autoHandleEvents,false);
    this.generateUrl=()=>{assert.strictEqual(mem['clay-settings'],undefined);return JSON.stringify(definition);};
    this.getSettings=response=>{const values=JSON.parse(response);mem['clay-settings']=response;return Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{value:v}]));};
  }
  function ApiClient() {this.readings=(c,f,t,cb)=>pending.push(cb);this.cancel=()=>{};}
  const fakeDate=class extends Date {static now(){return now;}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8'),{
    require:name=>name==='@rebble/clay'?Clay:name==='./api'?{Client:ApiClient}:require('../src/pkjs/'+name.replace('./','')),
    localStorage,Date:fakeDate,XMLHttpRequest:function(){},Pebble:{addEventListener:(n,f)=>events[n]=f,sendAppMessage:(p,ok)=>{sent.push(watchReceive(p));ok();},openURL:u=>opened=u}
  });
  mem[KEYS.settings]=JSON.stringify({...base,demo:false});mem[KEYS.credentials]=JSON.stringify({email:'private@example.test',password:'qa-password-secret'});
  mem['clay-settings']=mem[KEYS.credentials];events.showConfiguration();
  assert(!opened.includes('private@example.test'));assert(!opened.includes('qa-password-secret'));
  events.ready();assert.strictEqual(pending.length,1);
  pending[0](null,readings(1)); // Incomplete prefix leaves SELECT API path eligible.
  const detail=sent[sent.length-1][8];
  ['CURRENT BREAKDOWN','FORECAST BREAKDOWN','Base','Band 1','Band 2','Fuel','Govt','Renewable','Added tax','Total JPY'].forEach(label=>assert(detail.includes(label)));
  assert(detail.slice(detail.indexOf('FORECAST BREAKDOWN')).includes('Total JPY'));
  assert(/^[\x00-\x7f]*$/.test(detail)); assert(detail.length<=511);
  events.appmessage({payload:{7:1}});assert.strictEqual(pending.length,2);
  events.webviewclosed({response:JSON.stringify({...base,clearCredentials:true})});
  pending[1](null,readings(2));assert.strictEqual(mem[KEYS.credentials],undefined);assert.strictEqual(mem[KEYS.cache],undefined);
  sent.forEach(p=>{assert(['0,6','0,1,2,3,4,5,6,8,9,10'].includes(Object.keys(p).join(',')));assert(!JSON.stringify(p).includes('qa-password-secret'));});
  events.showConfiguration();events.webviewclosed({response:JSON.stringify({...base,bandStart:'bad'})});
  assert.strictEqual(mem[KEYS.settings],undefined);events.appmessage({payload:{7:1}});assert.strictEqual(sent[sent.length-1][1],'--');
  events.showConfiguration();
  events.webviewclosed({response:JSON.stringify({...base,basicRate:9999999,rate1:999999,rate2:999999,fuelRate:999999,governmentRate:999999,demo:true})});
  const large=sent[sent.length-1][8];
  assert(large.startsWith('DATA COVERAGE'));
  assert(large.slice(large.indexOf('FORECAST BREAKDOWN')).includes('Total JPY'), 'Large valid rate breakdown must retain forecast total');
});
test('valid JSON null API response is error without throwing', () => {
  let xhr,err;
  const c=new Client(()=>xhr={open(){},setRequestHeader(){},send(){}});
  c.request('query',{},null,e=>err=e);xhr.status=200;xhr.responseText='null';
  assert.doesNotThrow(()=>xhr.onload());assert.strictEqual(err.code,'data');
});
test('AppMessage maximum ASCII payload fits 1024 and C caches only short fields', () => {
  const sizes=[63,31,31,31,31,31,63,511,31,31];
  // Dictionary header + 7-byte tuple header + terminating NUL per string.
  assert.strictEqual(1+sizes.reduce((sum,size)=>sum+7+size+1,0),935);
  const fs=require('fs'),source=fs.readFileSync(require.resolve('../src/c/main.c'),'utf8');
  assert(source.includes('s_keys[i]'));
  assert(source.includes('KEY_BAND1, KEY_BAND2, KEY_BREAKDOWN'));
  assert(source.includes('cache_version == 2 ? 7'));
  assert(source.includes('app_message_open(1024, 64)'));
  assert(source.includes('static char s_breakdown[512]'));
  assert(source.includes('ARRAY_LENGTH(s_fields) - 1'));
});
console.log(count + ' independent QA checks passed');
