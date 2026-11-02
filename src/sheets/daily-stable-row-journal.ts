import type {Env} from '../types';

/** Stores a stable metadata ID, never a Google Sheets row number. */
export class StableDailyJournal {
  constructor(private readonly env:Env,private readonly spreadsheetId:string,private readonly expenseId:string,private readonly version:number){}
  private check():void{
    if(this.env.RUNTIME_MODE!=='shadow'||this.env.DAILY_STABLE_ID_PROTOTYPE_ENABLED!=='true'||!this.spreadsheetId||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(this.expenseId)||!Number.isSafeInteger(this.version)||this.version<1)throw new Error('DAILY_STABLE_JOURNAL_DISABLED');
  }
  async get():Promise<{metadataId:number;state:'IN_FLIGHT'|'VERIFIED'}|null>{
    this.check();const row=await this.env.DB.prepare(`SELECT metadata_id,state FROM daily_stable_row_intents WHERE spreadsheet_id=? AND expense_id=?`).bind(this.spreadsheetId,this.expenseId).first<{metadata_id:number;state:'IN_FLIGHT'|'VERIFIED'}>();
    return row?{metadataId:Number(row.metadata_id),state:row.state}:null;
  }
  /** A held prior attempt is never reclaimed on timeout or missing Sheet marker. */
  async reserve():Promise<number>{
    this.check();if(await this.get())throw new Error('DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW');
    for(let attempt=0;attempt<8;attempt++){
      const number=new Uint32Array(1);crypto.getRandomValues(number);const id=(number[0]!&0x7fffffff)||1,now=new Date().toISOString();
      const result=await this.env.DB.prepare(`INSERT OR IGNORE INTO daily_stable_row_intents(spreadsheet_id,expense_id,metadata_id,state,expense_version,created_at,updated_at)
        SELECT ?,?,?,'IN_FLIGHT',?,?,? WHERE EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND version=? AND status='CONFIRMED')`).bind(this.spreadsheetId,this.expenseId,id,this.version,now,now,this.expenseId,this.version).run();
      if(Number(result.meta.changes||0)===1)return id;
      if(await this.get())throw new Error('DAILY_STABLE_PRIOR_INTENT_REQUIRES_REVIEW');
    }
    throw new Error('DAILY_STABLE_METADATA_RESERVATION_FAILED');
  }
  async matchesReserved(id:number):Promise<boolean>{const row=await this.get();return !!row&&row.metadataId===id&&row.state==='IN_FLIGHT';}
  async finish(id:number):Promise<boolean>{
    this.check();const result=await this.env.DB.prepare(`UPDATE daily_stable_row_intents SET state='VERIFIED',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND expense_version=? AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND version=? AND status='CONFIRMED')`).bind(new Date().toISOString(),this.spreadsheetId,this.expenseId,id,this.version,this.expenseId,this.version).run();return Number(result.meta.changes||0)===1;
  }
}
