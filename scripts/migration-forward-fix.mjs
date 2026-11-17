// Forward-fix for a migration whose apply is suspected to have stopped midway.
// Every statement in the supported files is re-runnable except
// `ALTER TABLE <t> ADD COLUMN <c>`, which SQLite cannot make conditional. This
// prints the migration with each such statement removed when the column is
// already present, so the remainder can be applied with
// `wrangler d1 execute <db> --remote --file=<output>` after owner approval.
//
// Usage: node scripts/migration-forward-fix.mjs <migration file> <columns.json>
//   columns.json: {"<table>": ["<column>", ...]} read from
//   `SELECT name FROM pragma_table_info('<table>')` for each altered table.
// It never connects to a database and never decides that a fix is needed.
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';

export const SUPPORTED=Object.freeze(['0048_continuous_notice_dispatch_owner.sql','0055_cancelled_financial_journal_fence.sql']);
const ALTER=/^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)\b[^;\n]*;[ \t]*$/gm;

/** Columns each ALTER in the file would add, in order. */
export function alteredColumns(sql){return [...sql.matchAll(ALTER)].map(m=>({table:m[1],column:m[2]}));}

/** The migration text minus ALTER statements whose column already exists. */
export function forwardFixSql(name,sql,existing){
  if(!SUPPORTED.includes(name))throw Error('FORWARD_FIX_UNSUPPORTED_MIGRATION');
  const alters=alteredColumns(sql);
  if(!alters.length)throw Error('FORWARD_FIX_NO_ALTER');
  for(const {table} of alters)if(!Array.isArray(existing?.[table]))throw Error('FORWARD_FIX_COLUMNS_MISSING');
  const skipped=[];
  const out=sql.replace(ALTER,(line,table,column)=>{
    if(!existing[table].includes(column))return line;
    skipped.push(`${table}.${column}`);return `-- forward-fix: skipped, ${table}.${column} already present`;
  });
  return {sql:out,skipped};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const [file,columnsFile]=process.argv.slice(2);
  if(!file||!columnsFile){console.error('usage: migration-forward-fix.mjs <migration> <columns.json>');process.exit(2);}
  const {sql,skipped}=forwardFixSql(basename(file),readFileSync(file,'utf8'),JSON.parse(readFileSync(columnsFile,'utf8')));
  console.error(`skipped: ${skipped.length?skipped.join(', '):'none'}`);
  process.stdout.write(sql);
}
