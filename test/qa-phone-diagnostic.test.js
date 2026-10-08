'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const {KEYS}=require('../src/pkjs/storage');
const diagnosticKey='electricity.diagnostics.v1';
const version=require('../package.json').version;
const memory={},urls=[];
const valid={month:'2026-10',basicMode:'month',basicRate:100,rate1:10,rate2:30,bandStart:'06:00',bandEnd:'18:00',fuelRate:-1,governmentRate:2,taxMode:'excluded',taxRate:10,demo:true};
const secret='QA-phone-private-password';
const FakeDate=class extends Date{static now(){return Date.parse('2026-10-04T03:00:00Z');}};
function boot(mode){
 const events={},pending=[];
 function Clay(def){this.generateUrl=()=>JSON.stringify(def);}
 function Client(){this.cancel=()=>{};this.readings=()=>{throw Error('No real API allowed');};}
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8'),{require:n=>n==='@rebble/clay'?Clay:n==='./api'?{Client}:require('../src/pkjs/'+n.replace('./','')),Date:FakeDate,XMLHttpRequest:function(){},localStorage:{getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v,removeItem:k=>delete memory[k]},Pebble:{addEventListener:(n,fn)=>events[n]=fn,sendAppMessage:(p,ok,fail)=>{if(mode==='fail')fail({error:'connection '+secret});else if(mode==='pending')pending.push({ok,fail});else ok();},openURL:u=>urls.push(u)}});
 return {events,pending};
}
function journal(){return JSON.parse(memory[diagnosticKey]);}
function reopen(b){const previous=journal();b.events.showConfiguration();const url=urls.at(-1);assert(url.includes('診断 v'+version));assert(url.includes(previous.phase));assert(url.includes(previous.save||'記録なし'));assert(url.includes(previous.delivery||'記録なし'));assert(!url.includes(secret));return url;}
let b=boot('fail');
b.events.webviewclosed({response:''});assert.equal(journal().phase,'SAVE EMPTY / CANCELLED');assert.equal(journal().save,'EMPTY / CANCELLED');reopen(b);
b.events.webviewclosed({response:JSON.stringify({...valid,email:'private@example.test',password:secret})});assert.equal(journal().phase,'COMPLETE');assert.equal(journal().save,'VALID');assert.equal(journal().delivery,'FAILED / connection');assert.equal(JSON.parse(memory[KEYS.credentials]).password,secret);reopen(b);
const before=memory[diagnosticKey];b=boot('fail');assert.equal(memory[diagnosticKey],before,'Module boot alone must not overwrite diagnostic');reopen(b);
b.events.webviewclosed({response:JSON.stringify({...valid,rate2:''})});assert.equal(journal().phase,'ERROR settings');assert.equal(journal().save,'FAILED AFTER PARSE');assert.equal(memory[KEYS.settings],undefined);reopen(b);
b.events.webviewclosed({response:'%invalid'});assert.equal(journal().phase,'ERROR settings');assert.equal(journal().save,'PARSE FAILED');reopen(b);
assert(!memory[diagnosticKey].includes(secret));assert(!memory[diagnosticKey].includes('private@example.test'));
const {Sender}=require('../src/pkjs/transport'),{Journal}=require('../src/pkjs/diagnostics');
let deadline;const j=new Journal({getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v});
const sender=new Sender({sendAppMessage(){}},{set:fn=>{deadline=fn;return 1;},clear(){}},state=>j.record('delivery',state));
sender.send({STATUS:'Updating'});assert.equal(journal().delivery,'SENDING');deadline();assert.equal(journal().delivery,'NO ACK');reopen(b);
console.log('PASS empty/valid/invalid callback phone-visible diagnostics, failure/no-ACK classification, reboot preservation and secret exclusion');
