import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {receiptReferenceKey,receiptFactsFromDocument,storedReceiptFacts,inspectReceiptCandidates} from '../dist/expense/receipt-identity.js';

const item=(overrides={})=>({quantity:1,unitPriceSatang:10000,discountSatang:0,lineTotalSatang:10000,vatSatang:0,...overrides});
const facts=(overrides={})=>({vendor:'Fixture Store',legalVendorName:'',documentNumber:'INV-120',documentDate:'2026-10-01',paymentDate:'2026-10-01',amountSatang:10000,items:[item()],...overrides});
function harness(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
  const queries=[];
  const DB={prepare(sql){
    queries.push(sql);assert.doesNotMatch(sql,/\bai_json\b/i,'receipt identity never reads raw OCR evidence');
    return{args:[],bind(...args){this.args=args;return this;},async all(){return{results:sqlite.prepare(sql).all(...this.args),meta:{changes:0}};}};
  }};
  const now='2026-10-01T00:00:00.000Z';
  function expense(id,status='WAITING_CONFIRM'){
    sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at) VALUES(?,?,?,'edited expense text',10000,'cash','CASH_DRAWER','ingredients','2026-10-02',?,?)`).run(id,`msg_${id}`,'synthetic_actor',status,now);
  }
  function document(id,input=facts(),{status='WAITING_CONFIRM',expenseId=null,referenceKey=null}={}){
    sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,vendor_name,legal_vendor_name,document_number,document_date,payment_date,final_paid_satang,reference_key,expense_id) VALUES(?,?,?,'RECEIPT',?,?,?,?,?,?,?,?,?,?)`).run(id,`msg_${id}`,'synthetic_actor',status,now,input.vendor,input.legalVendorName,input.documentNumber,input.documentDate,input.paymentDate,input.amountSatang,referenceKey,expenseId);
    input.items.forEach((value,index)=>sqlite.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,unit_price_satang,discount_satang,line_total_satang,vat_satang,created_at,updated_at) VALUES(?,?,?,'synthetic item',?,?,?,?,?,?,?)`).run(`${id}_${index}`,id,expenseId,value.quantity,value.unitPriceSatang,value.discountSatang,value.lineTotalSatang,value.vatSatang,now,now));
  }
  return{sqlite,env:{DB},queries,expense,document,close(){assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');sqlite.close();}};
}

test('receipt identity normalizes formatting and fallback issuer but preserves punctuation and vendor',async()=>{
  const expected=await receiptReferenceKey(facts());
  assert.match(expected,/^receipt:v1:[a-f0-9]{64}$/);
  assert.equal(await receiptReferenceKey(facts({vendor:'  fixture\u00a0  store  ',documentNumber:'ｉｎｖ-１２０'})),expected);
  assert.equal(await receiptReferenceKey(facts({vendor:'irrelevant trade name',legalVendorName:'Fixture Store'})),expected);
  assert.notEqual(await receiptReferenceKey(facts({documentNumber:'INV120'})),expected);
  assert.notEqual(await receiptReferenceKey(facts({vendor:'Other Store'})),expected);
  assert.notEqual(await receiptReferenceKey(facts({documentNumber:'INV-121'})),expected);
});

test('blank identifiers produce no hard key and no amount-only duplicate decision',async()=>{
  const h=harness();try{
    for(const input of [facts({vendor:'',legalVendorName:''}),facts({documentNumber:''})]){
      assert.equal(await receiptReferenceKey(input),'');
      assert.deepEqual(await inspectReceiptCandidates(h.env,input),{kind:'NONE',matches:[]});
    }
    assert.equal(h.queries.length,0);
  }finally{h.close();}
});

test('SQLite: legacy empty legal vendor exact identity matches even with a different edited date/amount',async()=>{
  const h=harness();try{
    h.document('legacy',facts({vendor:'  fixture store ',documentNumber:'inv-120',documentDate:'2026-09-30',amountSatang:9000}));
    const result=await inspectReceiptCandidates(h.env,facts());
    assert.equal(result.kind,'EXACT');assert.deepEqual(result.matches,[{documentId:'legacy',expenseId:null,status:'WAITING_CONFIRM'}]);
  }finally{h.close();}
});

test('SQLite: reproduces legacy fallback-issuer collision and detects both existing receipts',async()=>{
  const h=harness();try{
    h.document('legacy_a',facts());h.document('legacy_b',facts());
    // The old lookup searched the fallback vendor in legal_vendor_name only;
    // the legacy partial unique index also excludes the empty legal issuer.
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents WHERE legal_vendor_name=? AND document_number=?').get('Fixture Store','INV-120').n,0);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents').get().n,2);
    const result=await inspectReceiptCandidates(h.env,facts());
    assert.equal(result.kind,'EXACT');assert.equal(result.matches.length,2);
  }finally{h.close();}
});

test('SQLite: existing unique reference_key atomically rejects a concurrent normalized identity',async()=>{
  const h=harness();try{
    const key=await receiptReferenceKey(facts());h.document('winner',facts(),{referenceKey:key});
    h.sqlite.exec('BEGIN');
    try{
      h.expense('loser');h.document('loser_document',facts({documentNumber:'inv-120'}),{expenseId:'loser'});
      assert.throws(()=>h.sqlite.prepare('UPDATE expense_documents SET reference_key=? WHERE document_id=?').run(key,'loser_document'),/UNIQUE/);
    }finally{h.sqlite.exec('ROLLBACK');}
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_events').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_document_items').get().n,1);
  }finally{h.close();}
});

test('SQLite: receipt claim namespace remains separate from bank slip reference keys',async()=>{
  const h=harness();try{
    const key=await receiptReferenceKey(facts());h.document('receipt',facts(),{referenceKey:key});
    h.document('bank_placeholder',facts({documentNumber:'other'}),{referenceKey:'BANK|INV120'});
    h.sqlite.prepare("UPDATE expense_documents SET document_type='BANK_SLIP' WHERE document_id='bank_placeholder'").run();
    assert.equal((await inspectReceiptCandidates(h.env,facts())).matches.length,1);
  }finally{h.close();}
});

test('SQLite: exact and suspicious candidates remain visible in every status',async()=>{
  for(const status of ['WAITING_CONFIRM','WAITING_REVIEW','CONFIRMED','CANCELLED']){
    const h=harness();try{
      h.document('candidate',facts({documentNumber:'INV-12O'}),{status});
      const result=await inspectReceiptCandidates(h.env,facts());
      assert.equal(result.kind,'REVIEW');assert.equal(result.matches[0].status,status);
    }finally{h.close();}
  }
});

test('SQLite: OCR-near receipt is REVIEW only; weak evidence and legitimate different invoices are not hard merged',async()=>{
  for(const [overrides,expected] of [
    [{documentNumber:'INV-12O'},'REVIEW'],
    [{documentNumber:'INV-121'},'REVIEW'],
    [{documentNumber:'INV-1120'},'REVIEW'],
    [{documentNumber:'INV-2200'},'NONE'],
    [{documentNumber:'OTHER-120'},'NONE'],
    [{documentNumber:'INV-12O',vendor:'Other Store'},'NONE'],
    [{documentNumber:'INV-12O',documentDate:'2026-10-02'},'NONE'],
    [{documentNumber:'INV-12O',amountSatang:9900},'NONE'],
    [{documentNumber:'INV-12O',items:[]},'NONE'],
    [{documentNumber:'INV-12O',items:[item({quantity:null})]},'NONE'],
    [{documentNumber:'INV-12O',items:[item({lineTotalSatang:9900})]},'NONE'],
    [{documentNumber:'INV-12O',items:[item({unitPriceSatang:9900})]},'NONE'],
    [{documentNumber:'INV-12O',items:[item({discountSatang:100})]},'NONE']
  ]){
    const h=harness();try{h.document('candidate',facts(overrides));assert.equal((await inspectReceiptCandidates(h.env,facts())).kind,expected,JSON.stringify(overrides));}finally{h.close();}
  }
});

test('SQLite: uncertain OCR VAT cannot bypass a review-only hold for matching paid line economics',async()=>{
  for(const vatSatang of [null,654,700]){
    const h=harness();try{
      h.document('vat_candidate',facts({documentNumber:'INV-12O',items:[item({vatSatang})]}));
      const before=JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_document_items').all());
      assert.equal((await inspectReceiptCandidates(h.env,facts())).kind,'REVIEW');
      assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM expense_document_items').all()),before);
    }finally{h.close();}
  }
});

test('SQLite: monetary multiset retains repeated identical items and ignores line ordering',async()=>{
  const h=harness();try{
    h.document('two_boxes',facts({documentNumber:'INV-12O',amountSatang:20000,items:[item(),item()]}));
    assert.equal((await inspectReceiptCandidates(h.env,facts({amountSatang:20000,items:[item()]}))).kind,'NONE');
    assert.equal((await inspectReceiptCandidates(h.env,facts({amountSatang:20000,items:[item(),item()]}))).kind,'REVIEW');
    h.sqlite.prepare('DELETE FROM expense_document_items').run();h.sqlite.prepare('DELETE FROM expense_documents').run();
    h.document('mixed',facts({documentNumber:'INV-12O',amountSatang:15000,items:[item(),item({lineTotalSatang:5000,unitPriceSatang:5000})]}));
    assert.equal((await inspectReceiptCandidates(h.env,facts({amountSatang:15000,items:[item({lineTotalSatang:5000,unitPriceSatang:5000}),item()]}))).kind,'REVIEW');
  }finally{h.close();}
});

test('SQLite: excludes own primary and supporting links but not another Expense',async()=>{
  const h=harness();try{
    h.expense('own');h.expense('other');
    h.document('primary',facts(),{expenseId:'own'});h.document('support',facts());
    h.sqlite.prepare("INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link','own','support','SUPPORTING_DOCUMENT','EXACT_IDENTIFIER','2026-10-01')").run();
    assert.deepEqual(await inspectReceiptCandidates(h.env,facts(),{excludeExpenseId:'own'}),{kind:'NONE',matches:[]});
    h.document('other_primary',facts(),{expenseId:'other'});
    const result=await inspectReceiptCandidates(h.env,facts(),{excludeExpenseId:'own'});
    assert.equal(result.kind,'EXACT');assert.deepEqual(result.matches.map(x=>x.expenseId),['other']);
    assert.equal((await inspectReceiptCandidates(h.env,facts(),{excludeExpenseId:'own',excludeDocumentId:'other_primary'})).kind,'NONE');
  }finally{h.close();}
});

test('SQLite: simultaneous drafts each see the other before confirmation',async()=>{
  const h=harness();try{
    h.expense('a');h.expense('b');h.document('doc_a',facts(),{expenseId:'a'});h.document('doc_b',facts({documentNumber:'INV-12O'}),{expenseId:'b'});
    const [a,b]=await Promise.all([
      inspectReceiptCandidates(h.env,await storedReceiptFacts(h.env,'a'),{excludeExpenseId:'a'}),
      inspectReceiptCandidates(h.env,await storedReceiptFacts(h.env,'b'),{excludeExpenseId:'b'})
    ]);
    assert.equal(a.kind,'REVIEW');assert.equal(b.kind,'REVIEW');
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM expense_events WHERE status='WAITING_CONFIRM'").get().n,2);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM sync_jobs').get().n,0);
  }finally{h.close();}
});

test('SQLite: stored facts use document date/items and ignore mutable Expense description/date',async()=>{
  const h=harness();try{
    h.expense('target');h.document('original',facts(),{expenseId:'target'});
    const stored=await storedReceiptFacts(h.env,'target');
    assert.equal(stored.documentDate,'2026-10-01');assert.deepEqual(stored.items,[item()]);assert.equal(stored.vendor,'Fixture Store');
    assert.equal(await storedReceiptFacts(h.env,'text_only'),null);
    h.document('inconsistent_second_primary',facts({documentNumber:'OTHER'}),{expenseId:'target'});
    await assert.rejects(storedReceiptFacts(h.env,'target'),/RECEIPT_PRIMARY_IDENTITY_AMBIGUOUS/);
  }finally{h.close();}
});

test('SQLite: candidate overflow and oversized item lists fail closed without raw evidence reads',async()=>{
  const h=harness();try{
    for(let n=0;n<101;n++)h.document(`d${n}`,facts({vendor:`Store ${n}`,documentNumber:`NO-${n}`,items:[]}));
    assert.deepEqual(await inspectReceiptCandidates(h.env,facts()),{kind:'LIMIT',matches:[]});
    assert.deepEqual(await inspectReceiptCandidates(h.env,facts({itemsTruncated:true})),{kind:'LIMIT',matches:[]});
    assert.ok(h.queries.every(sql=>/SELECT/.test(sql)));
  }finally{h.close();}
});

test('SQLite: oversized stored receipt items fail closed instead of comparing a truncated multiset',async()=>{
  const h=harness();try{
    h.expense('large');h.document('large_document',facts({documentNumber:'INV-12O',items:Array.from({length:201},()=>item())}),{expenseId:'large'});
    assert.equal((await storedReceiptFacts(h.env,'large')).itemsTruncated,true);
    assert.deepEqual(await inspectReceiptCandidates(h.env,facts()),{kind:'LIMIT',matches:[]});
  }finally{h.close();}
});

test('purchase facts conversion preserves satang and duplicates without modifying source',()=>{
  const purchase={vendor:'Fixture',legalVendorName:'',documentNumber:'A',documentDate:'2026-10-01',paymentDate:'',finalPaidAmountBaht:2.02,items:[{quantity:1,unitPriceBaht:1.01,discountBaht:0,lineTotalBaht:1.01,vatBaht:null},{quantity:1,unitPriceBaht:1.01,discountBaht:0,lineTotalBaht:1.01,vatBaht:null}]};
  const before=JSON.stringify(purchase),converted=receiptFactsFromDocument(purchase);
  assert.equal(converted.amountSatang,202);assert.equal(converted.items.length,2);assert.equal(converted.items[0].lineTotalSatang,101);assert.equal(converted.items[0].vatSatang,null);assert.equal(JSON.stringify(purchase),before);
});
