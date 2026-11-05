import {SheetsHttpError,SheetsMutationOutcomeUnknownError} from './client';
import {OperationTimeoutError} from '../shared/async';

const code=(value:string):string|null=>/^[A-Z][A-Z0-9_]{2,79}$/.test(value)?value:null;

/** A short, non-sensitive cause for operators. Provider response bodies,
 * identifiers and free-form messages are never copied. */
export function stableFaultReason(error:unknown):string{
 if(error instanceof SheetsMutationOutcomeUnknownError){const cause=error.cause;return `SHEETS_MUTATION_OUTCOME_UNKNOWN:${cause instanceof SheetsHttpError?`HTTP_${cause.status}`:cause instanceof OperationTimeoutError?'TIMEOUT':'NETWORK'}`;}
 if(error instanceof SheetsHttpError)return `${code(error.message)??'SHEETS_HTTP'}:HTTP_${error.status}`;
 if(error instanceof OperationTimeoutError)return 'TIMEOUT';
 const message=error instanceof Error?error.message:'';
 if(/too many subrequests/i.test(message))return 'WORKER_SUBREQUEST_LIMIT';
 if(/too many api requests by single worker invocation/i.test(message))return 'D1_QUERY_LIMIT';
 const name=error instanceof Error?code(error.name.toUpperCase()):null;
 return code(message)??`UNCLASSIFIED_${name??'ERROR'}`;
}
