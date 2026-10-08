'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/pkjs/core');
const rates = {month:'2026-10', basicMode:'month', basicRate:100, bandStart:'06:00', bandEnd:'18:00', rate1:10, rate2:30, fuelRate:-1, governmentRate:2, taxMode:'excluded', taxRate:10};
const now = Date.parse('2026-10-04T00:19:00+09:00');
function day(date) {
 const start=Date.parse(date+'T00:00:00+09:00');
 return Array.from({length:48},(_,i)=>({startAt:new Date(start+i*core.HALF_HOUR).toISOString(),endAt:new Date(start+(i+1)*core.HALF_HOUR).toISOString(),value:i>=12&&i<36?1/12:1/8}));
}
function error(fn, code) { assert.throws(fn,e=>e.code===code); }
test('Oct 3 supply start excludes pre-contract absence from prices, warnings and 29-day forecast',()=>{
 const result=core.estimate(day('2026-10-03'),{...rates,contractStartDate:'2026-10-03'},now);
 const o=result.observed;
 assert.equal(o.days,1); assert.equal(o.forecastDays,29); assert.equal(o.monthDays,31);
 assert.equal(o.start,Date.parse('2026-10-03T00:00:00+09:00'));
 assert.equal(o.end,Date.parse('2026-10-04T00:00:00+09:00'));
 assert.equal(o.missing,false); assert.equal(o.delayed,false); assert.equal(o.missingSlots,0);
 assert(Math.abs(o.kwh-5)<1e-10); assert(Math.abs(o.forecastKwh-145)<1e-10);
 assert.equal(result.current.total,149); assert.equal(result.forecast.total,4315);
 assert(Math.abs(result.current.basic-600/31)<1e-10);
 assert(Math.abs(result.forecast.basic-600*29/31)<1e-10);
 const daily=core.estimate(day('2026-10-03'),{...rates,basicMode:'day',basicRate:1,contractStartDate:'2026-10-03'},now);
 assert.equal(daily.current.basic,6); assert.equal(daily.forecast.basic,174);
});
test('unspecified or cleared start counts earlier empty days as zero when later usage exists',()=>{
 for(const contractStartDate of [undefined,'']) { const r=core.estimate(day('2026-10-03'),{...rates,contractStartDate},now); assert.equal(r.observed.days,3); assert(Math.abs(r.observed.kwh-5)<1e-10); }
});
test('contract scope uses later positive evidence for absence but retains trailing and invalid protection',()=>{
 const later=Date.parse('2026-10-06T12:00:00+09:00'), s={...rates,contractStartDate:'2026-10-03'};
 assert.equal(core.estimate([...day('2026-10-03').slice(1),...day('2026-10-04')],s,later).observed.days,2);
 const r=core.estimate([...day('2026-10-03'),...day('2026-10-05')],s,later);
 assert.equal(r.observed.days,3); assert.equal(r.observed.missing,false); assert.equal(r.observed.lagDays,0);
 assert.equal(r.current.total,Math.ceil((600*3/31+220+11.8)*1.1));
 const bad=day('2026-10-03'); bad[2].value=-1;
 error(()=>core.estimate(bad,s,now),'data');
});
test('old start reverts to month first in later months; invalid and future starts do not price',()=>{
 const s={...rates,contractStartDate:'2026-09-03'};
 assert.equal(core.estimate([...day('2026-10-01'),...day('2026-10-02'),...day('2026-10-03')],s,now).observed.forecastDays,31);
 const november=Date.parse('2026-11-02T00:19:00+09:00');
 const r=core.estimate(day('2026-11-01'),{...rates,month:'2026-11',contractStartDate:'2026-10-03'},november);
 assert.equal(r.observed.forecastDays,30); assert.equal(r.observed.start,Date.parse('2026-11-01T00:00:00+09:00'));
 for(const date of ['2026-02-30','2026-13-01','2026-10-3','x',1]) error(()=>core.validate({...rates,contractStartDate:date},'2026-10'),'contract_date');
 assert.equal(core.validate({...rates,contractStartDate:' 2026-10-03 '},'2026-10').contractStartDate,'2026-10-03');
 assert.equal(core.validate({...rates,contractStartDate:'2024-02-29'},'2026-10').contractStartDate,'2024-02-29');
 error(()=>core.estimate([],{...rates,contractStartDate:'2026-11-01'},now),'not_started');
 error(()=>core.estimate(day('2026-10-04'),{...rates,contractStartDate:'2026-10-04'},now),'insufficient');
});
test('month-end one-day supply, zero use, and pre-start invalid values retain exact scope',()=>{
 const next=Date.parse('2026-10-31T23:59:00+09:00');
 const rows=day('2026-10-30').map(r=>({...r,value:0}));
 const r=core.estimate([...day('2026-10-01').map(r=>({...r,value:-1})),...rows],{...rates,contractStartDate:'2026-10-30'},next);
 assert.equal(r.observed.days,1); assert.equal(r.observed.forecastDays,2); assert.equal(r.observed.invalidSlots,0);
 assert.equal(r.current.total,22); assert.equal(r.forecast.total,43);
 const emptyStart=core.estimate([...day('2026-10-03'),...day('2026-10-04')],{...rates,contractStartDate:'2026-10-03'},Date.parse('2026-10-05T00:19:00+09:00'));
 assert.equal(emptyStart.observed.days,2);
});
