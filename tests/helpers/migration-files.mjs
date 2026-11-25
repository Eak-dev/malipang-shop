import {readdirSync} from 'node:fs';

// migrations/ is what Production applies; migrations-draft/ keeps the local-only
// serial schema from #350 (0068-0079). Tests load both by default. Setting
// MALIPANG_TEST_SCHEMA=release loads the release schema alone.
const mode=process.env.MALIPANG_TEST_SCHEMA;
if(mode!==undefined&&mode!=='release')throw Error(`MALIPANG_TEST_SCHEMA must be "release" when set: ${mode}`);
export const releaseSchemaOnly=mode==='release';
export const RELEASE_DIR=new URL('../../migrations/',import.meta.url);
export const DRAFT_DIR=new URL('../../migrations-draft/',import.meta.url);

/** Ordered migration files as {name,url}; draft files follow the release ones by number. */
export function migrationFiles({draft=!releaseSchemaOnly}={}){
  const dirs=draft?[RELEASE_DIR,DRAFT_DIR]:[RELEASE_DIR];
  const files=dirs.flatMap(dir=>readdirSync(dir).filter(name=>name.endsWith('.sql')).map(name=>({name,url:new URL(name,dir)})));
  return files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}
