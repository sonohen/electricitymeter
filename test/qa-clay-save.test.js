'use strict';
const watchKeys=require('../package.json').pebble.messageKeys;
function watchReceive(p){const result={};Object.keys(p).forEach(k=>{assert(Object.prototype.hasOwnProperty.call(watchKeys,k),'Unknown outbound key '+k);result[watchKeys[k]===undefined?k:watchKeys[k]]=p[k];});return result;}

const assert=require('assert'),fs=require('fs'),vm=require('vm');
const {KEYS}=require('../src/pkjs/storage');
const memory={},sent=[],urls=[];
const valid={month:'2026-10',basicMode:'month',basicRate:'100',rate1:'10',rate2:'30',bandStart:'06:00',bandEnd:'18:00',fuelRate:'-1',governmentRate:'2',taxMode:'excluded',taxRate:'10',demo:true};
const localStorage={getItem:k=>memory[k]||null,setItem:(k,v)=>memory[k]=v,removeItem:k=>delete memory[k]};
const FakeDate=class extends Date { static now(){return Date.parse('2026-10-04T03:00:00Z');} };
function boot(){
 const events={};
 function Clay(def){this.generateUrl=()=>JSON.stringify(def);}
 function Client(){this.cancel=()=>{};this.readings=()=>{throw new Error('No real API permitted');};}
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8'),{require:n=>n==='@rebble/clay'?Clay:n==='./api'?{Client}:require('../src/pkjs/'+n.replace('./','')),localStorage,Date:FakeDate,XMLHttpRequest:function(){},Pebble:{addEventListener:(n,f)=>events[n]=f,sendAppMessage:(p,ok)=>{sent.push(watchReceive(p));ok();},openURL:u=>urls.push(u)}});
 return events;
}
function response(values){return encodeURIComponent(JSON.stringify(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{value:v}]))));}
function defaults(def,result={}){def.forEach(item=>{if(item.items)defaults(item.items,result);if(item.messageKey)result[item.messageKey]=item.defaultValue;});return result;}
let e=boot();
// A WebView return after companion restart, before showConfiguration, must save.
e.webviewclosed({response:response({...valid,email:'private@example.test',password:'qa-clay-secret'})});
assert.strictEqual(JSON.parse(memory[KEYS.settings]).rate1,10);
assert.strictEqual(JSON.parse(memory[KEYS.credentials]).password,'qa-clay-secret');
assert(sent[sent.length-1][1].startsWith('JPY '));
const incomplete={...valid,rate2:'',bandStart:'06:01',demo:false};
e.webviewclosed({response:response(incomplete)});
assert.strictEqual(memory[KEYS.settings],undefined);
assert.strictEqual(JSON.parse(memory[KEYS.draft]).rate2,'');
assert.strictEqual(JSON.parse(memory[KEYS.draft]).bandStart,'06:01');
assert(!memory[KEYS.draft].includes('qa-clay-secret'));
e=boot();e.showConfiguration();
const restored=defaults(JSON.parse(urls[urls.length-1]));
assert.strictEqual(restored.rate2,'');assert.strictEqual(restored.bandStart,'06:01');
assert.strictEqual(restored.basicRate,'100');assert.strictEqual(restored.email,'');assert.strictEqual(restored.password,'');
assert(!urls[urls.length-1].includes('private@example.test'));assert(!urls[urls.length-1].includes('qa-clay-secret'));
e.appmessage({payload:{7:1}});assert.strictEqual(sent[sent.length-1][1],'--');
const preserved=memory[KEYS.draft];e.webviewclosed({response:''});assert.strictEqual(memory[KEYS.draft],preserved);
e.webviewclosed({response:'%malformed'});assert.strictEqual(memory[KEYS.draft],preserved);
e.webviewclosed({response:response(valid)});assert.strictEqual(JSON.parse(memory[KEYS.settings]).rate2,30);
const saved=memory[KEYS.settings];e.webviewclosed({response:'null'});assert.strictEqual(memory[KEYS.settings],saved);
e.webviewclosed({response:response({...incomplete,clearCredentials:true})});
assert.strictEqual(memory[KEYS.credentials],undefined);assert.strictEqual(memory[KEYS.cache],undefined);
assert.strictEqual(JSON.parse(memory[KEYS.draft]).rate2,'');assert.strictEqual(memory['clay-settings'],undefined);
console.log('PASS restart save, invalid draft restoration, secret exclusion, cancellation, malformed response, corrected save and explicit credential deletion');
