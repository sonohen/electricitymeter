'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('shipped C persistent cache helper preserves snapshots while reducing duplicate writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'electricity-qa-cache-'));
 try {
  const executable=path.join(dir,'cache-test');
  const compile=spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror',path.join(__dirname,'qa-watch-cache.c'),'-o',executable],{encoding:'utf8'});
  assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(executable,[],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/PASS actual C cache helper/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
