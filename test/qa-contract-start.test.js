'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/pkjs/core');
const { Store } = require('../src/pkjs/storage');
const settings = {month:'2026-10', contractStartDate:'2026-10-03', basicMode:'month',basicRate:100,rate1:10,rate2:30,bandStart:'06:00',bandEnd:'18:00',fuelRate:-1,governmentRate:2,taxMode:'excluded',taxRate:10};
function rows(date, value) {
 const start=Date.parse(date+'T00:00:00+09:00');
 return Array.from({length:48},(_,i)=>({startAt:new Date(start+i*1800000).toISOString(),endAt:new Date(start+(i+1)*1800000).toISOString(),value:typeof value==='function'?value(i):value}));
}
const now=Date.parse('2026-10-05T00:00:00+09:00');
const hasCode=code=>e=>e.code===code;
test('independent two-band oracle keeps calendar denominator and applies adjustments before final ceiling',()=>{
 // Day 3 has band totals 2/3 kWh; day 4 has 4/1 kWh. D=2,N=29,M=31.
 const readings=[...rows('2026-10-03',i=>i>=12&&i<36?2/24:3/24),...rows('2026-10-04',i=>i>=12&&i<36?4/24:1/24)];
 const r=core.estimate(readings,settings,now);
 const currentBase=600*2/31, forecastBase=600*29/31;
 // Energy 6*10+4*30=180; net usage adjustments (-1-2+4.18)*10=11.8.
 assert.equal(r.current.total,Math.ceil((currentBase+180+11.8)*1.1));
 assert.equal(r.forecast.total,Math.ceil((forecastBase+180*29/2+11.8*29/2)*1.1));
 assert(Math.abs(r.forecast.bandCharge1-870)<1e-9);
 assert(Math.abs(r.forecast.bandCharge2-1740)<1e-9);
 const included=core.estimate(readings,{...settings,taxMode:'included'},now);
 assert.equal(included.current.total,Math.ceil(currentBase+191.8));
});
test('unknown-day malformed data still rejects a complete post-contract prefix',()=>{
 const complete=rows('2026-10-03',0);
 for(const invalid of [null,{startAt:'not-a-date',endAt:'not-a-date',value:0},{startAt:'2026-10-01T00:00:00',value:0}]) {
  assert.throws(()=>core.estimate([...complete,invalid],settings,Date.parse('2026-10-04T00:00:00+09:00')),hasCode('data'));
 }
 // A located pre-contract invalid end/value is safely outside the scope.
 const pre={startAt:'2026-10-01T00:00:00+09:00',endAt:'bad',value:-1};
 assert.equal(core.estimate([...complete,pre],settings,Date.parse('2026-10-04T00:00:00+09:00')).observed.invalidSlots,0);
});
test('month-last-day contract cannot price today; next month restarts its scope',()=>{
 assert.throws(()=>core.estimate(rows('2026-10-31',0),{...settings,contractStartDate:'2026-10-31'},Date.parse('2026-10-31T23:59:59+09:00')),hasCode('insufficient'));
 const r=core.estimate([...rows('2026-10-31',999),...rows('2026-11-01',0)],{...settings,month:'2026-11',contractStartDate:'2026-10-31'},Date.parse('2026-11-02T00:00:00+09:00'));
 assert.equal(r.observed.days,1);assert.equal(r.observed.forecastDays,30);assert.equal(r.observed.kwh,0);
 assert.equal(r.current.total,22);assert.equal(r.forecast.total,660);
});
test('explicit clearing persists and restores month-first protection without retaining credentials in drafts',()=>{
 const memory={},storage={getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v,removeItem:k=>delete memory[k]},store=new Store(storage);
 store.saveDraft({...settings,email:'qa@example.invalid',password:'private-only'});
 store.write('settings',core.validate(settings,'2026-10'));
 store.saveDraft({...settings,contractStartDate:'',email:'qa@example.invalid',password:'private-only'});
 store.write('settings',core.validate({...settings,contractStartDate:''},'2026-10'));
 assert.equal(store.read('draft').contractStartDate,'');assert.equal(store.read('settings').contractStartDate,'');
 assert(!JSON.stringify(store.read('draft')).includes('private-only'));
 assert.throws(()=>core.estimate(rows('2026-10-03',0),store.read('settings'),now),hasCode('missing'));
});
