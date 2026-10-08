'use strict';
const watchKeys=require('../package.json').pebble.messageKeys;
function watchReceive(p){const result={};Object.keys(p).forEach(k=>{assert(Object.prototype.hasOwnProperty.call(watchKeys,k),'Unknown outbound key '+k);result[watchKeys[k]===undefined?k:watchKeys[k]]=p[k];});return result;}

const assert=require('assert'),fs=require('fs'),vm=require('vm');
const {KEYS}=require('../src/pkjs/storage');
const core=require('../src/pkjs/core');
const now=Date.parse('2026-10-04T03:00:00Z');
const settings={month:'2026-10',basicMode:'month',basicRate:100,rate1:10,rate2:30,bandStart:'09:00',bandEnd:'21:00',fuelRate:-1,governmentRate:2,taxMode:'excluded',taxRate:10,demo:false};
const memory={[KEYS.settings]:JSON.stringify(settings),[KEYS.credentials]:JSON.stringify({email:'qa@example.test',password:'qa-refresh-secret'})};
const events={},sent=[],requests=[];
function Client(){this.cancel=()=>{};this.readings=(credentials,start,end,cb)=>requests.push({start,end,cb});}
const FakeDate=class extends Date {static now(){return now;}};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8'),{
 require:n=>n==='@rebble/clay'?function(){}:n==='./api'?{Client}:require('../src/pkjs/'+n.replace('./','')),
 Date:FakeDate,XMLHttpRequest:function(){},localStorage:{getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v,removeItem:k=>delete memory[k]},
 Pebble:{addEventListener:(n,cb)=>events[n]=cb,sendAppMessage:(p,ok)=>{sent.push(watchReceive(p));ok();},openURL:()=>{}}
});
// Do not trigger ready: this isolates SELECT's event from startup fetch.
events.appmessage({payload:{REFRESH:1}});
assert.strictEqual(requests.length,1,'Named REFRESH must start a request');
assert(sent[sent.length-1][0].includes('Updating'));
events.appmessage({payload:{REFRESH:1}});
events.appmessage({payload:{7:1}});
assert.strictEqual(requests.length,1,'Repeated SELECT must not overlap active update');
requests[0].cb(null,core.demoReadings(now).slice(0,48)); // Incomplete coverage must still retry.
assert(sent[sent.length-1][1].startsWith('JPY '));
assert(!sent[sent.length-1][0].includes('Updating'),'Completion must leave update state');
events.appmessage({payload:{REFRESH:1,7:1}});
assert.strictEqual(requests.length,2,'Alias plus numeric key must trigger once');
requests[1].cb({code:'timeout'});
assert(sent[sent.length-1][0].includes('Update failed'));
assert(sent[sent.length-1][1].startsWith('JPY '),'Failed refresh keeps labelled valid cache');
events.appmessage({payload:{7:1}});assert.strictEqual(requests.length,3,'Numeric legacy event remains accepted after timeout');
requests[2].cb(null,core.demoReadings(now));
const before=requests.length;events.appmessage({payload:{REFRESH:0}});events.appmessage({payload:{OTHER:1}});events.appmessage({});
assert.strictEqual(requests.length,before);
sent.forEach(p=>assert(!JSON.stringify(p).includes('qa-refresh-secret')));
console.log('PASS named/numeric SELECT, duplicate suppression, completion, timeout recovery, false/unknown event and secret exclusion');
// Exercise the actual API module with fake timers and XHR: no native timeout event.
const apiModule={exports:{}},timers=new Map();let nextTimer=0;
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/api'),'utf8'),{
 module:apiModule,setTimeout:(fn,delay)=>{assert.strictEqual(delay,20000);timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id)
});
let xhr,errors=[];
const api=new apiModule.exports.Client(()=>xhr={open(){},setRequestHeader(){},send(){},abort(){if(this.onabort)this.onabort();}});
api.request('query',{},null,error=>errors.push(error.code));
assert.strictEqual(timers.size,1);const timeout=[...timers.values()][0];timeout();
assert.deepStrictEqual(errors,['timeout']);assert.strictEqual(timers.size,0);
xhr.status=200;xhr.responseText=JSON.stringify({data:{done:true}});xhr.onload();assert.deepStrictEqual(errors,['timeout']);
api.request('query',{},null,error=>errors.push(error.code));api.cancel();assert.strictEqual(timers.size,0);assert.deepStrictEqual(errors,['timeout']);
const broken=new apiModule.exports.Client(()=>({open(){throw new Error('native open failed');},setRequestHeader(){},send(){}}));
broken.request('query',{},null,error=>errors.push(error.code));assert.deepStrictEqual(errors,['timeout','network']);assert.strictEqual(timers.size,0);
console.log('PASS explicit watchdog, delayed response suppression, timer cancellation and native open exception');
const queueEvents={},queueMessages=[],queueMemory={[KEYS.settings]:JSON.stringify({...settings,demo:true})};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8'),{
 require:n=>n==='@rebble/clay'?function(){}:n==='./api'?{Client}:require('../src/pkjs/'+n.replace('./','')),
 Date:FakeDate,XMLHttpRequest:function(){},localStorage:{getItem:k=>queueMemory[k]||null,setItem:(k,v)=>queueMemory[k]=v,removeItem:k=>delete queueMemory[k]},
 Pebble:{addEventListener:(n,cb)=>queueEvents[n]=cb,sendAppMessage:(payload,ok,fail)=>queueMessages.push({payload:watchReceive(payload),ok,fail}),openURL:()=>{}}
});
queueEvents.appmessage({payload:{REFRESH:1}});
assert.strictEqual(queueMessages.length,1,'Synchronous DEMO completion must wait for Updating ACK');
assert(queueMessages[0].payload[0].includes('Updating'));
queueEvents.appmessage({payload:{REFRESH:1}});
assert.strictEqual(queueMessages.length,1,'New update only replaces pending state while in flight');
queueMessages[0].ok();
assert.strictEqual(queueMessages.length,2);assert(queueMessages[1].payload[1].startsWith('JPY '));
queueMessages[0].fail();assert.strictEqual(queueMessages.length,2,'Duplicate late ACK must not send twice');
queueMessages[1].fail();
queueEvents.appmessage({payload:{REFRESH:1}});
assert.strictEqual(queueMessages.length,3,'Failed ACK permits later update transmission');
queueMessages[2].ok();assert.strictEqual(queueMessages.length,3, 'Complete same-day cache needs only its result message');
console.log('PASS delayed/failed/duplicate ACK, one message in flight and newest pending result');
const {Sender}=require('../src/pkjs/transport'), transportTimers=new Map(),transportMessages=[];let timerId=0;
const sender=new Sender({sendAppMessage:(payload,ok,fail)=>transportMessages.push({payload,ok,fail})},
 {set:(fn,ms)=>{assert.strictEqual(ms,10000);transportTimers.set(++timerId,fn);return timerId;},clear:id=>transportTimers.delete(id)});
sender.send({state:'updating'});sender.send({state:'intermediate'});sender.send({state:'latest result'});
assert.strictEqual(transportMessages.length,1);
const lostAckDeadline=[...transportTimers.values()][0];lostAckDeadline();
assert.strictEqual(transportMessages.length,2);assert.strictEqual(transportMessages[1].payload.state,'latest result');
transportMessages[0].ok();transportMessages[0].fail();assert.strictEqual(transportMessages.length,2);
transportMessages[1].fail();assert.strictEqual(transportTimers.size,0);assert.strictEqual(sender.sending,false);
sender.send({state:'new manual result'});assert.strictEqual(transportMessages.length,3);transportMessages[2].ok();
assert.strictEqual(transportTimers.size,0);
sender.send({state:'lost with no pending'});[...transportTimers.values()][0]();
assert.strictEqual(sender.sending,false);sender.send({state:'retry after lost'});assert.strictEqual(transportMessages.length,5);transportMessages[4].ok();
console.log('PASS lost ACK 10-second deadline, newest pending, late callback guard, failed ACK and later manual recovery');
