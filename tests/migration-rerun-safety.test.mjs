// R2 (#296): migrations 0048 and 0055 are made re-runnable except their
// ALTER TABLE ... ADD COLUMN statements, with a forward-fix for a partial apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {forwardFixSql,alteredColumns,SUPPORTED} from '../scripts/migration-forward-fix.mjs';

const dir=new URL('../migrations/',import.meta.url);
const names=readdirSync(dir).filter(n=>n.endsWith('.sql')).sort();
const read=n=>readFileSync(new URL(n,dir),'utf8');
// Pinned from main b9c3e00 (before this change) so CI needs no git history:
// the other migration files byte for byte, and the schema all files produced.
const OTHERS_SHA256='04e039d567183e3f17454361b6eee507835939ce3de70bb4ab8bb617d69b0e17';
const ORIGINAL_SCHEMA_SHA256='9a96b564624cc4574782d58ec6105fc15183d5cba3228d26a44147d5b60911b9';
const sha=s=>createHash('sha256').update(s).digest('hex');
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>({type:r.type,name:r.name,tbl_name:r.tbl_name,sql:normalise(r.sql)}));
// IF NOT EXISTS is not kept by SQLite in sqlite_master, but normalise anyway.
const normalise=sql=>sql===null?null:sql.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim();
const columns=(db,table)=>db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r=>r.name);
const build=(source,upto=names.length)=>{const db=new DatabaseSync(':memory:');for(const n of names.slice(0,upto))db.exec(source(n));return db;};

test('every migration other than 0048 and 0055 is byte-identical to main b9c3e00',()=>{
  assert.equal(sha(names.filter(n=>!SUPPORTED.includes(n)).map(n=>n+'\n'+read(n)).join('\n')),OTHERS_SHA256);
});

test('a clean apply of the edited files yields exactly the original schema and seed rows',()=>{
  const edited=build(read);
  assert.equal(sha(JSON.stringify(schema(edited))),ORIGINAL_SCHEMA_SHA256);
  assert.deepEqual(edited.prepare('SELECT * FROM continuous_financial_journal_revision').all().map(r=>({...r})),[{singleton:1,revision:0}]);
});

test('each edited file can be re-applied once its ALTER statements are skipped, without changing anything',()=>{
  const db=build(read),snapshot=schema(db),rows=db.prepare('SELECT * FROM continuous_financial_journal_revision').all();
  for(const n of SUPPORTED){
    // The plain re-run still stops at the column addition, as documented.
    assert.throws(()=>db.exec(read(n)),/duplicate column/i,n);
    const existing=Object.fromEntries(alteredColumns(read(n)).map(({table})=>[table,columns(db,table)]));
    const {sql,skipped}=forwardFixSql(n,read(n),existing);
    assert.equal(skipped.length,alteredColumns(read(n)).length,n);
    db.exec(sql);db.exec(sql);
  }
  assert.deepEqual(schema(db),snapshot);
  assert.deepEqual(db.prepare('SELECT * FROM continuous_financial_journal_revision').all(),rows);
});

test('a partial apply that stopped after the column addition is completed by the forward-fix',()=>{
  const full=schema(build(read));
  for(const n of SUPPORTED){
    const index=names.indexOf(n),db=build(read,index),sql=read(n);
    // Simulate a stop right after the ALTER: run the file up to and including it.
    const cut=sql.search(/^ALTER TABLE [^\n]*;[ \t]*$/m),end=sql.indexOf('\n',cut);
    db.exec(sql.slice(0,end));
    const existing=Object.fromEntries(alteredColumns(sql).map(({table})=>[table,columns(db,table)]));
    db.exec(forwardFixSql(n,sql,existing).sql);
    for(const later of names.slice(index+1))db.exec(read(later));
    assert.deepEqual(schema(db),full,n);
  }
});

test('the forward-fix keeps missing columns and refuses unsupported or incomplete input',()=>{
  const n='0048_continuous_notice_dispatch_owner.sql',sql=read(n);
  const kept=forwardFixSql(n,sql,{continuous_notice_dispatches:['dispatch_id']});
  assert.deepEqual(kept.skipped,[]);assert.match(kept.sql,/^ALTER TABLE continuous_notice_dispatches ADD COLUMN owner_token/m);
  assert.throws(()=>forwardFixSql('0001_initial.sql',sql,{}),/UNSUPPORTED/);
  assert.throws(()=>forwardFixSql(n,sql,{}),/COLUMNS_MISSING/);
});
