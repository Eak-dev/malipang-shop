import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

class Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.args)??null;}
  async all(){return{results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  runSync(){
    const statement=this.db.sqlite.prepare(this.sql);
    if(/^\s*(SELECT|WITH)\b/i.test(this.sql))return{results:statement.all(...this.args),meta:{changes:0}};
    return{meta:{changes:Number(statement.run(...this.args).changes)}};
  }
  async run(){this.db.runs.push(this);return this.runSync();}
}
export function expenseSqlite(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  const directory=new URL('../../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  const DB={sqlite,runs:[],batches:[],failAt:null,failAfterCommit:false,
    prepare(sql){return new Statement(this,sql);},
    async batch(statements){
      this.batches.push(statements);sqlite.exec('BEGIN IMMEDIATE');let results;
      try{results=statements.map((statement,index)=>{if(index===this.failAt)throw new Error('fixture batch failure');return statement.runSync();});sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
      if(this.failAfterCommit)throw new Error('fixture crash after commit');
      return results;
    }
  };
  const queue=[];
  const env={DB,SHEETS_SYNC_ENABLED:'true',RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false',JOB_QUEUE:{async sendBatch(messages){queue.push(...messages);}}};
  return{sqlite,DB,env,queue,close(){sqlite.close();}};
}

export function receipt(overrides={}){
  return{documentType:'RECEIPT',vendor:'Synthetic supplier',legalVendorName:'',documentNumber:'TEST-100',orderId:'',
    documentDate:'2026-01-10',paymentDate:'2026-01-10',paymentTime:'10:00',currency:'THB',subtotalBaht:100,shippingBaht:0,
    discountBaht:0,subsidyBaht:0,vatBaht:0,grossAmountBaht:100,finalPaidAmountBaht:100,paymentMethod:'Cash',sourceWalletCandidate:'CASH_DRAWER',
    suggestedDescription:'Synthetic purchase',suggestedCategory:'ingredients',confidence:.99,needsReview:false,reviewReasons:[],
    items:[{sellerKey:'Synthetic supplier',productCode:'TEST-SKU',description:'Synthetic item',quantity:2,unit:'box',unitPriceBaht:50,discountBaht:0,lineTotalBaht:100,vatBaht:0,confidence:.99,needsReview:false}],...overrides};
}
export const imageEvent=(id,user='fixture_user')=>({source:{type:'user',userId:user},message:{id,type:'image'}});
export const receiptReading=document=>({kind:'RECEIPT',document,confidence:.99,raw:{},note:''});
