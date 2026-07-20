import fs from 'node:fs';
const required=['package-lock.json','wrangler.jsonc','migrations/0001_initial.sql','.dev.vars.example'];
const missing=required.filter(file=>!fs.existsSync(file));
const config=fs.readFileSync('wrangler.jsonc','utf8');
if(config.includes('REPLACE_D1_DATABASE_ID'))missing.push('D1 database_id in wrangler.jsonc');
if(missing.length){console.error('Setup is not ready:\n- '+missing.join('\n- '));process.exitCode=1;}else console.log('Static setup check passed. Next: npm run check');
