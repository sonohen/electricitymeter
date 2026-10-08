'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const version=require('../package.json').version;
const source=fs.readFileSync(require.resolve('../src/pkjs/index'),'utf8');
function boot(fail){
 const events={},sent=[],loaded=[];
 const context={require:n=>{loaded.push(n);if(n===fail)throw Error('secret-exception-password');return require('../src/pkjs/'+n.replace('./',''));},Date,XMLHttpRequest:function(){},localStorage:{getItem:()=>null,removeItem(){},setItem(){}},Pebble:{addEventListener:(n,cb)=>events[n]=cb,sendAppMessage:(p,ok)=>{sent.push(p);if(ok)ok();},openURL(){}},setTimeout,clearTimeout};
 vm.runInNewContext(source,context);return {events,sent,loaded};
}
const expected={'./core':'CORE','./api':'API','./storage':'STORAGE','./transport':'MESSAGES'};
Object.entries(expected).forEach(([module,stage])=>{
 const b=boot(module);assert.equal(typeof b.events.ready,'function');b.events.ready();b.events.appmessage({payload:{REFRESH:1}});
 assert.equal(b.sent.length,2);b.sent.forEach(p=>{assert.equal(p.STATUS,'Phone error');assert(p.DETAIL.endsWith(stage));assert(!JSON.stringify(p).includes('secret-exception'));});
});
const healthy=boot('@rebble/clay');assert(!healthy.loaded.includes('@rebble/clay'));assert(!healthy.loaded.includes('./config'));
healthy.events.ready();assert(healthy.sent.some(p=>p.DETAIL==='Phone v'+version+': READY'));assert(healthy.sent.some(p=>p.STATUS==='Unavailable'));
console.log('PASS module failure stage/safe event diagnostics, lazy Clay and READY before settings validation');

healthy.events.showConfiguration();assert(healthy.sent.some(p=>p.STATUS==='Phone error'&&p.DETAIL==='Phone v'+version+' settings failed'));
assert(!JSON.stringify(healthy.sent).includes('secret-exception'));
const {Client}=require('../src/pkjs/api');
for(const factory of [()=>{throw Error('secret-constructor');},()=>null,()=>({})]){
 let calls=0;const client=new Client(factory);client.request('query',{},null,error=>{calls++;assert.equal(error.code,'http_unavailable');assert.equal(error.message,'http_unavailable');});assert.equal(calls,1);assert.equal(client.timer,null);assert.equal(client.active,null);
}
console.log('PASS Clay configuration exception safety and XHR construction/unusable factory fixed callback');
