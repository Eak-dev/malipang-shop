import { findMonthBlocks } from './daily-expense';
import { expectedHelperFormulae } from './daily-stable-row-writes';

/**
 * Planning only: a row number returned here is an observation, never durable
 * identity or authority to write. Google Sheets has no compare-and-swap for
 * a row, so the live writer must remain disabled until its atomicity and old
 * writer cutover are independently proven.
 *
 * Column X is a proposed, not yet deployed, protected business key. It must
 * move with the entire row and is deliberately not inferred for legacy data.
 */
export const DAILY_ID_COLUMN = 23; // zero based: X
const PREFIX = 'MALIPANG_EXPENSE:';
// User-maintained context must also be preserved. The five omitted columns
// are row-relative formulas that may legitimately adjust on row insertion.
const INPUT_COLUMNS = [0,1,2,3,4,5,6,7,10,11,12,13,14,15,16,19,21,22,DAILY_ID_COLUMN,24] as const;
const WRITE_COLUMNS = [1,2,3,5,6,7,10,11,12,13,14,15,16,21,22,DAILY_ID_COLUMN] as const;
const AMOUNT_COLUMNS = [5,6,7,10,11,12,13,14,15,16] as const;

export interface StableDailyRowRequest {
  expenseId: string;
  postingMonth: number;
  /** TRUE only for a transaction proven never to have been projected. */
  allowCreate: boolean;
  /** Previous values, obtained from trusted operation evidence, not the new D1 state. */
  expectedPrevious?: readonly unknown[];
  /** Same D1 version already projected: verify only; never dispatch a write. */
  verifyOnly?: boolean;
}
export type StableDailyRowPlan =
  | { status: 'FOUND'; observedRow: number }
  | { status: 'APPEND'; observedRow: number; formulaColumnsMissing: string[] }
  | { status: 'CAPACITY_REQUIRED'; observedTotalRow: number }
  | { status: 'REVIEW'; reason: string };

const cell = (row: readonly unknown[], index: number): unknown => row[index] ?? null;
const blank = (value: unknown): boolean => value === null || value === undefined || value === '';
const sameCell = (left: unknown, right: unknown): boolean => (blank(left) && blank(right)) || left === right;

/** The returned key is opaque; never use vendor/date/amount as a substitute. */
export function stableDailyExpenseKey(expenseId: string): string {
  if (!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)) throw new Error('INVALID_DAILY_EXPENSE_ID');
  return PREFIX + expenseId;
}

/**
 * Identify a current row or the first row after the last populated input in a
 * month. `body` must be a complete, current formula-rendered snapshot through
 * column Y (not a truncated A:D read). No Sheets or D1 mutations happen here.
 */
export function planStableDailyExpenseRow(body: readonly (readonly unknown[])[], request: StableDailyRowRequest): StableDailyRowPlan {
  const key = stableDailyExpenseKey(request.expenseId);
  if (!Number.isInteger(request.postingMonth) || request.postingMonth < 1 || request.postingMonth > 12) return {status:'REVIEW', reason:'INVALID_POSTING_MONTH'};
  const blocks = findMonthBlocks(body.map(row=>Array.from(row))).filter(block=>block.month===request.postingMonth);
  if (blocks.length !== 1) return {status:'REVIEW', reason:'MONTH_BLOCK_NOT_UNIQUE'};
  const block = blocks[0]!;
  const matches:number[] = [];
  for (let index=0;index<body.length;index++) if (cell(body[index]!, DAILY_ID_COLUMN) === key) matches.push(index+1);
  if (matches.length > 1) return {status:'REVIEW', reason:'DUPLICATE_STABLE_ID'};
  if (matches.length === 1) {
    const row = matches[0]!;
    if (row <= block.headerRow || row >= block.totalRow) return {status:'REVIEW', reason:'IDENTITY_OUTSIDE_POSTING_MONTH'};
    if (!request.expectedPrevious || request.expectedPrevious.length < 25) return {status:'REVIEW', reason:'MISSING_TRUSTED_PREIMAGE'};
    const observed = body[row-1]!;
    if (INPUT_COLUMNS.some(index=>!sameCell(cell(observed,index),cell(request.expectedPrevious!,index)))) return {status:'REVIEW', reason:'IDENTITY_PREIMAGE_MISMATCH'};
    if(WRITE_COLUMNS.some(index=>typeof cell(observed,index)==='string'&&String(cell(observed,index)).startsWith('=')))return {status:'REVIEW',reason:'INPUT_CONTAINS_FORMULA'};
    const amounts=AMOUNT_COLUMNS.map(index=>cell(observed,index)).filter(value=>!blank(value));
    if(amounts.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0)||amounts.filter(value=>(value as number)>0).length!==1)return {status:'REVIEW',reason:'MULTIPLE_OR_INVALID_AMOUNT_CELLS'};
    return {status:'FOUND', observedRow:row};
  }
  if (!request.allowCreate) return {status:'REVIEW', reason:'LEGACY_OR_MISSING_ID_UNVERIFIED'};
  let lastUsed = block.headerRow;
  for (let row=block.headerRow+1;row<block.totalRow;row++) {
    const values=body[row-1] ?? [];
    if (INPUT_COLUMNS.some(index=>!blank(cell(values,index)))) lastUsed=row;
  }
  const next=lastUsed+1;
  if (next >= block.totalRow) return {status:'CAPACITY_REQUIRED', observedTotalRow:block.totalRow};
  const candidate=body[next-1] ?? [];
  if (INPUT_COLUMNS.some(index=>!blank(cell(candidate,index)))) return {status:'REVIEW', reason:'APPEND_ROW_NOT_EMPTY'};
  const formulaColumns = [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']] as const;
  const accepted=expectedHelperFormulae(block.headerRow,next);
  if(formulaColumns.some(([index,name])=>!blank(cell(candidate,index))&&cell(candidate,index)!==accepted[name]))return {status:'REVIEW',reason:'APPEND_HELPER_FORMULA_UNVERIFIED'};
  return {status:'APPEND', observedRow:next, formulaColumnsMissing:formulaColumns.filter(([index])=>blank(cell(candidate,index))).map(([,column])=>column)};
}
