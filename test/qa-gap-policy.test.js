'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),core=require('../src/pkjs/core');
const settings={month:'2026-10',contractStartDate:'2026-10-03',basicMode:'day',basicRate:10.25,bandStart:'06:00',bandEnd:'18:00',rate1:10,rate2:30,fuelRate:0,governmentRate:0,taxMode:'included',taxRate:10};
const now=Date.parse('2026-10-05T13:00:00+09:00');
function row(date,time,value){const start=Date.parse(date+'T'+time+':00+09:00');return{startAt:new Date(start).toISOString(),endAt:new Date(start+core.HALF_HOUR).toISOString(),value};}
function day(date,value=1){const start=Date.parse(date+'T00:00:00+09:00');return Array.from({length:48},(_,i)=>({startAt:new Date(start+i*core.HALF_HOUR).toISOString(),endAt:new Date(start+(i+1)*core.HALF_HOUR).toISOString(),value}));}
test('later strictly positive usage resolves a two-slot internal gap and retains exact two-band totals',()=>{
 const rows=[...day('2026-10-03'),...day('2026-10-04').filter((r,i)=>i!==34&&i!==35)];
 const r=core.estimate(rows,settings,now);
 assert.equal(r.observed.days,2);assert.equal(r.observed.inferredZeroSlots,2);assert.equal(r.observed.missing,false);
 assert.deepEqual(r.observed.bands,[46,48]);assert.equal(r.observed.kwh,94);
 assert.equal(r.current.basic,123);assert.equal(r.current.total,Math.ceil(123+46*10+48*30+94*4.18));
});
test('today positive data resolves yesterday trailing absence but never contributes to either usage band or billing',()=>{
 const rows=[...day('2026-10-03'),...day('2026-10-04').slice(0,47),row('2026-10-05','06:00',999)];
 const r=core.estimate(rows,settings,now);
 assert.equal(r.observed.days,2);assert.equal(r.observed.inferredZeroSlots,1);assert.equal(r.observed.kwh,95);
 assert.deepEqual(r.observed.bands,[48,47]);assert.equal(r.current.basic,123);
 assert.equal(r.current.total,Math.ceil(123+480+1410+95*4.18));
});
test('zero today is insufficient evidence; future and in-progress positive readings cannot resolve yesterday',()=>{
 const prefix=[...day('2026-10-03'),...day('2026-10-04').slice(0,47)];
 for(const evidence of [row('2026-10-05','06:00',0),row('2026-10-05','13:00',99),row('2026-10-05','12:30',99)]){
  const at=evidence.startAt.includes('03:30')?Date.parse('2026-10-05T12:45:00+09:00'):now;
  const o=core.aggregate([...prefix,evidence],at,settings);
  assert.equal(o.days,1);assert.equal(o.inferredZeroSlots,0);assert.equal(o.missing,true);
 }
});
test('conflicting or malformed positive evidence cannot turn absence into zero',()=>{
 const prefix=[...day('2026-10-03'),...day('2026-10-04').slice(0,47)],positive=row('2026-10-05','06:00',2);
 for(const evidence of [[positive,{...positive,value:3}],[{...positive,endAt:positive.startAt}],[{...positive,value:'invalid'}]]){
  const o=core.aggregate([...prefix,...evidence],now,settings);assert.equal(o.days,1);assert.equal(o.inferredZeroSlots,0);
 }
});
test('explicit zero is valid, and trailing zero records do not fill a prior absent interval',()=>{
 const zeros=day('2026-10-04',0),prefix=day('2026-10-03',0);
 assert.equal(core.aggregate([...prefix,...zeros],now,settings).days,2);
 zeros.splice(10,1);
 const o=core.aggregate([...prefix,...zeros],now,settings);assert.equal(o.days,1);assert.equal(o.inferredZeroSlots,0);
});
