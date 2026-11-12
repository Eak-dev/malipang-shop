// Issue 248 release checks: SHA-256 written in SQLite SQL, so identifiers are
// hashed and compared INSIDE D1 and only counts leave the provider. Same
// construction as scripts/issue248-canary-source-digest.mjs (left unchanged there
// because that exact statement passed the D1 provider self-test), extended to many
// messages: every message row carries its own id (mid) through the recursion.
const M=4294967295;
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const IV=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
// SQLite gives << >> & | one precedence level, so every operation is parenthesized.
// Values stay in [0, 2^32); XOR is (a|b)-(a&b).
const rotr=(x,n)=>`((${x}>>${n})|((${x}<<${32-n})&${M}))`;
const xor=(a,b)=>`((${a}|${b})-(${a}&${b}))`,xor3=(a,b,c)=>xor(xor(a,b),c);
const S0=xor3(rotr('a',2),rotr('a',13),rotr('a',22)),S1=xor3(rotr('e',6),rotr('e',11),rotr('e',25));
const s0=xor3(rotr('w1',7),rotr('w1',18),'(w1>>3)'),s1=xor3(rotr('w14',17),rotr('w14',19),'(w14>>10)');
// p is the padded message as a BLOB of hex digits (O(1) substr); 65 steps per 64-byte block,
// step 64 adds the block result into h0..h7; w0..w15 hold the last 16 schedule words.
const nibble=j=>`(instr('0123456789ABCDEF',substr(p,((s/65)*16+(s%65))*8+${j},1))-1)`;
const wt=`(CASE WHEN (s%65)<16 THEN (${[1,2,3,4,5,6,7,8].map(j=>`${nibble(j)}*${16**(8-j)}`).join('+')}) ELSE ((${s1}+w9+${s0}+w0)&${M}) END)`;
const t1=`((h+${S1}+((e&f)|((~e)&g))+(SELECT v FROM sha_k WHERE t=(s%65))+${wt})&${M})`,t2=`((${S0}+((a&b)|(a&c)|(b&c)))&${M})`;
const W=Array.from({length:16},(_,i)=>'w'+i),at64=(x,i)=>`CASE WHEN (s%65)=64 THEN ((h${i}+${x})&${M}) ELSE `;
const STEP=['mid','p','n','s+1',`${at64('a',0)}((${t1}+${t2})&${M}) END`,`${at64('b',1)}a END`,`${at64('c',2)}b END`,`${at64('d',3)}c END`,
 `${at64('e',4)}((d+${t1})&${M}) END`,`${at64('f',5)}e END`,`${at64('g',6)}f END`,`${at64('h',7)}g END`,
 ...[...'abcdefgh'].map((x,i)=>`${at64(x,i)}h${i} END`),...W.slice(1),`CASE WHEN (s%65)=64 THEN 0 ELSE ${wt} END`];
export const SHA_K_CTE=`sha_k(t,v) AS (VALUES ${K.map((x,i)=>`(${i},${x})`).join(',')})`;
// messagesSelect yields (mid, x): an integer id and the upper-case hex of the message bytes.
// Defines <name>_digest(mid, d), d the lower-case hex SHA-256; needs SHA_K_CTE in the same WITH RECURSIVE.
export const sha256Ctes=(name,messagesSelect)=>`${name}_msg(mid,x) AS (${messagesSelect}),
${name}_pad(mid,p,n) AS (SELECT mid,CAST(x||'80'||hex(zeroblob((119-(length(x)/2)%64)%64))||printf('%016X',length(x)*4) AS BLOB),(length(x)/2+9+(119-(length(x)/2)%64)%64)/64 FROM ${name}_msg),
${name}(mid,p,n,s,a,b,c,d,e,f,g,h,h0,h1,h2,h3,h4,h5,h6,h7,${W.join(',')}) AS (SELECT mid,p,n,0,${IV.join(',')},${IV.join(',')},${W.map(()=>0).join(',')} FROM ${name}_pad UNION ALL SELECT ${STEP.join(',')} FROM ${name} WHERE s<n*65),
${name}_digest(mid,d) AS (SELECT mid,printf('%08x%08x%08x%08x%08x%08x%08x%08x',h0,h1,h2,h3,h4,h5,h6,h7) FROM ${name} WHERE s=n*65)`;
