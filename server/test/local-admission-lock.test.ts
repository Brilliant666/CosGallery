import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { LOCAL_ADMISSION_LOCK_KEY, runAdmissionExclusive, runWithAdmissionBarrier } from '../src/services/local-admission-lock.js';

it('excludes unrelated admissions, allows its scoped index and releases after interruption',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schemaSql);
 try {
  await runAdmissionExclusive(db,async()=>{
   await runWithAdmissionBarrier(db,async()=>expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY)).toBeTruthy());
   await expect(runAdmissionExclusive(db,async()=>undefined)).rejects.toThrow('active');
  });
  await expect(runAdmissionExclusive(db,async()=>{throw Error('interrupted');})).rejects.toThrow('interrupted');
  expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY)).toBeUndefined();
 } finally {db.close();}
});

it('rejects a live foreign process and recovers only after that process exits',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schemaSql);
 const child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true});
 await once(child,'spawn');
 try {
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(LOCAL_ADMISSION_LOCK_KEY,JSON.stringify({pid:child.pid,token:'foreign',kind:'admission'}));
  await expect(runAdmissionExclusive(db,async()=>undefined)).rejects.toThrow('active');
  const ended=once(child,'exit');child.stdin.end();await ended;
  await runAdmissionExclusive(db,async()=>expect(JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY) as {value:string}).value).pid).toBe(process.pid));
  expect(db.prepare('SELECT value FROM app_settings WHERE key=?').get(LOCAL_ADMISSION_LOCK_KEY)).toBeUndefined();
 } finally {if(child.exitCode===null)child.kill();db.close();}
});
