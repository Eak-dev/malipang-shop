import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const directory=new URL('../migrations/',import.meta.url),migration=readFileSync(new URL('0054_daily_reviewed_release.sql',directory),'utf8');
test('reviewed release migration splits correctly and rejects unsupported resolutions',()=>{const db=new DatabaseSync(':memory:');try{for(const n of readdirSync(directory).filter(n=>/^\d+.*\.sql$/.test(n)&&n<'0054').sort())db.exec(readFileSync(new URL(n,directory),'utf8'));const {unstable_splitSqlQuery}=createRequire(import.meta.url)('wrangler');db.exec('BEGIN');for(const stmt of unstable_splitSqlQuery(migration))db.exec(stmt);db.exec('COMMIT');assert.throws(()=>db.exec("INSERT INTO daily_reviewed_resolutions VALUES('action','book','daily','window','witness','exp_a',1,1,44,'notice','mutation','outer','generation','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,'ADMIN_TOKEN','now')"),/evidence changed/);assert.equal(db.prepare('SELECT count(*) n FROM daily_reviewed_resolutions').get().n,0);}finally{db.close();}});
