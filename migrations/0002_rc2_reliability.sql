CREATE TABLE failed_jobs_rc2(
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(queue_name,trace_id,job_key)
);

INSERT INTO failed_jobs_rc2(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at,resolved_at)
SELECT id,queue_name,trace_id,'LEGACY',payload_json,error,status,attempt_count,created_at,updated_at,resolved_at FROM failed_jobs;

DROP TABLE failed_jobs;
ALTER TABLE failed_jobs_rc2 RENAME TO failed_jobs;
