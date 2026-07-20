interface D1Result<T = unknown> { results?: T[]; success?: boolean; meta: { changes?: number } }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
interface R2HttpMetadata { contentType?: string }
interface R2PutOptions { httpMetadata?: R2HttpMetadata; customMetadata?: Record<string,string> }
interface R2ObjectBody { body: ReadableStream; httpEtag: string; writeHttpMetadata(headers: Headers): void }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}
interface QueueSendOptions {}
interface Queue<T> { send(body: T, options?: QueueSendOptions): Promise<void>; sendBatch(messages: Array<{body:T}>): Promise<void> }
interface Message<T> { body: T; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface MessageBatch<T> { queue: string; messages: Message<T>[] }
interface DurableObjectId {}
interface DurableObjectStub { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub }
interface DurableObjectStorageTransaction { get<T>(key:string): Promise<T|undefined>; put<T>(key:string,value:T): Promise<void> }
interface DurableObjectStorage { transaction<T>(closure:(txn:DurableObjectStorageTransaction)=>Promise<T>): Promise<T> }
interface DurableObjectState { storage: DurableObjectStorage; blockConcurrencyWhile<T>(callback:()=>Promise<T>):Promise<T> }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }
interface ScheduledController { scheduledTime: number; cron: string }
interface ExportedHandler<Env = unknown, QueueBody = unknown> {
  fetch?: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  queue?: (batch: MessageBatch<QueueBody>, env: Env, ctx: ExecutionContext) => void | Promise<void>;
  scheduled?: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void | Promise<void>;
}
