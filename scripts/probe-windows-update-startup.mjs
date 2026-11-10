import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const root = mkdtempSync(join(tmpdir(), 'leaflogue-launch-probe-'));
const source = readFileSync('apps/desktop/src/main/update-native.ts','utf8');
const helper = /WINDOWS_UPDATE_HELPER = String.raw`([\s\S]*?)`;/u.exec(source)[1];
try { console.log('baseline',execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',"Write-Output 'baseline works'"],{encoding:'utf8',timeout:10000}).trim()); }
catch(error) { console.log('baseline failure',error.message); }
for (const [name,actual,detached,stream,hidden] of [
 ['minimal-detached-ignore',false,true,'ignore',true],
 ['minimal-detached-log',false,true,'log',true],
 ['minimal-attached-pipe',false,false,'pipe',true],
 ['minimal-detached-console',false,true,'pipe',false],
 ['actual-detached-log',true,true,'log',true],
 ['actual-attached-log',true,false,'log',true],
 ['actual-attached-pipe',true,false,'pipe',true],
]) {
 const script=join(root,name+'.ps1'),ready=join(root,'state.txt'),config=join(root,name+'.json'),log=join(root,name+'.log');
 writeFileSync(script,actual?helper:'param([string]$ReadyPath)\n[IO.File]::WriteAllText($ReadyPath,"ready")\nWrite-Output "started"\n');
 writeFileSync(config,JSON.stringify({parent:process.pid,work:root,installer:process.execPath,executable:process.execPath,directory:dirname(process.execPath),args:[]}));
 const fd=stream==='log'?openSync(log,'wx',0o600):undefined;
 let output='',error='',exited=false,exitCode,spawnError;
 const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,actual?config:ready],{detached,windowsHide:hidden,stdio:stream==='log'?['ignore',fd,fd]:stream==='pipe'?['ignore','pipe','pipe']:'ignore'});
 child.stdout?.on('data',x=>output+=x.toString());child.stderr?.on('data',x=>error+=x.toString());
 child.on('error',x=>spawnError=x.message);child.on('exit',code=>{exited=true;exitCode=code;});
 child.unref();
 if(fd!==undefined) closeSync(fd);
 let state;
 for(let n=0;n<50;n++) {
  if(existsSync(ready)) {state=readFileSync(ready,'utf8').trim();break;}
  if(exited||spawnError)break;
  await delay(100);
 }
 if(!exited)child.kill();
 await delay(300);
 if(stream==='log')output=readFileSync(log,'utf8');
 console.log(JSON.stringify({name,state,exited,exitCode,spawnError,output:output.slice(-3000),error:error.slice(-3000)}));
 if(existsSync(ready)) {const {unlinkSync}=await import('node:fs');unlinkSync(ready);}
}
