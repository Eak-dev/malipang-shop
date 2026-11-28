-- Local development only; this bookkeeping grants no write or handover rights.
CREATE TABLE IF NOT EXISTS serial_pilot_rounds (
 round_id TEXT PRIMARY KEY,
 recovery_of TEXT REFERENCES serial_pilot_rounds(round_id),
 selected_count INTEGER NOT NULL CHECK(selected_count>=0),
 state TEXT NOT NULL CHECK(state IN ('PREPARING','OPEN','CLOSED')),
 created_at TEXT NOT NULL,
 closed_at TEXT,
 reason TEXT,
 CHECK((state IN ('PREPARING','OPEN') AND closed_at IS NULL AND reason IS NULL) OR
       (state='CLOSED' AND closed_at IS NOT NULL AND reason IS NOT NULL AND length(reason)>0))
);
CREATE TABLE IF NOT EXISTS serial_pilot_round_items (
 round_id TEXT NOT NULL REFERENCES serial_pilot_rounds(round_id),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 job_id TEXT NOT NULL,
 PRIMARY KEY(round_id,job_id), UNIQUE(round_id,ordinal)
);
-- Positive mock classifications remain impossible until every independent
-- proof guard is installed and the separate not-ready barrier is removed.
CREATE TABLE IF NOT EXISTS serial_pilot_classification_evidence (
 round_id TEXT NOT NULL,job_id TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('PARKED','NOT_STARTED')),
 evidence TEXT NOT NULL,successor_job_id TEXT,source_namespace TEXT NOT NULL,source_revision INTEGER NOT NULL,
 fence_digest TEXT NOT NULL CHECK(length(fence_digest)=64 AND fence_digest NOT GLOB '*[^0-9a-f]*'),fence_generation INTEGER NOT NULL CHECK(fence_generation>0),attestation_nonce TEXT NOT NULL,worker_version TEXT NOT NULL,
 CHECK((category='PARKED' AND evidence='MOCK_ATTESTED_HANDOFF' AND successor_job_id IS NOT NULL) OR (category='NOT_STARTED' AND evidence='MOCK_NEVER_STARTED' AND successor_job_id IS NULL)),
 PRIMARY KEY(round_id,job_id),FOREIGN KEY(round_id,job_id) REFERENCES serial_pilot_round_items(round_id,job_id)
);
CREATE TRIGGER IF NOT EXISTS serial_classification_not_ready BEFORE INSERT ON serial_pilot_classification_evidence BEGIN SELECT RAISE(ABORT,'classification not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_classification_unimplemented BEFORE INSERT ON serial_pilot_classification_evidence BEGIN SELECT RAISE(ABORT,'classification not implemented'); END;
CREATE TRIGGER IF NOT EXISTS serial_classification_no_replace BEFORE INSERT ON serial_pilot_classification_evidence WHEN EXISTS(SELECT 1 FROM serial_pilot_classification_evidence e WHERE e.rowid=NEW.rowid OR (e.round_id=NEW.round_id AND e.job_id=NEW.job_id)) BEGIN SELECT RAISE(ABORT,'classification evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_classification_no_update BEFORE UPDATE ON serial_pilot_classification_evidence BEGIN SELECT RAISE(ABORT,'classification evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_classification_no_delete BEFORE DELETE ON serial_pilot_classification_evidence BEGIN SELECT RAISE(ABORT,'classification evidence retained'); END;
CREATE TABLE IF NOT EXISTS serial_pilot_round_results (
 round_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('VERIFIED','PARKED','RECONCILE','NOT_STARTED')),
 evidence TEXT NOT NULL CHECK(length(evidence)>0),
 successor_job_id TEXT,
 PRIMARY KEY(round_id,job_id),
 FOREIGN KEY(round_id,job_id) REFERENCES serial_pilot_round_items(round_id,job_id)
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_round_insert BEFORE INSERT ON serial_pilot_rounds
 WHEN NEW.state<>'PREPARING' OR EXISTS(SELECT 1 FROM serial_pilot_rounds WHERE rowid=NEW.rowid OR round_id=NEW.round_id)
 OR (NEW.recovery_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM serial_pilot_rounds WHERE round_id=NEW.recovery_of AND state='CLOSED'))
 BEGIN SELECT RAISE(ABORT,'invalid round creation'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_items_insert BEFORE INSERT ON serial_pilot_round_items
 WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_rounds r WHERE r.round_id=NEW.round_id AND r.state='PREPARING' AND NEW.ordinal<r.selected_count)
 OR EXISTS(SELECT 1 FROM serial_pilot_round_items WHERE rowid=NEW.rowid OR (round_id=NEW.round_id AND (job_id=NEW.job_id OR ordinal=NEW.ordinal)))
 BEGIN SELECT RAISE(ABORT,'invalid round item'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_items_no_update BEFORE UPDATE ON serial_pilot_round_items BEGIN SELECT RAISE(ABORT,'round items immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_items_no_delete BEFORE DELETE ON serial_pilot_round_items BEGIN SELECT RAISE(ABORT,'round items retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_results_insert BEFORE INSERT ON serial_pilot_round_results
 WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_rounds r JOIN serial_pilot_round_items i ON i.round_id=r.round_id WHERE r.round_id=NEW.round_id AND i.job_id=NEW.job_id AND r.state='OPEN')
 OR EXISTS(SELECT 1 FROM serial_pilot_round_results WHERE rowid=NEW.rowid OR (round_id=NEW.round_id AND job_id=NEW.job_id))
 BEGIN SELECT RAISE(ABORT,'invalid round result'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_results_no_update BEFORE UPDATE ON serial_pilot_round_results BEGIN SELECT RAISE(ABORT,'round results immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_results_no_delete BEFORE DELETE ON serial_pilot_round_results BEGIN SELECT RAISE(ABORT,'round results retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_round_no_delete BEFORE DELETE ON serial_pilot_rounds BEGIN SELECT RAISE(ABORT,'round retained'); END;
-- A receipt currently lacks the immutable inputs needed to revalidate a
-- separately committed VERIFIED result at close. Keep every verified close
-- blocked until a later local draft installs and tests that complete proof.
CREATE TRIGGER IF NOT EXISTS serial_pilot_verified_close_not_ready BEFORE UPDATE OF state ON serial_pilot_rounds
 WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED')
 BEGIN SELECT RAISE(ABORT,'verified round close not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_round_transition BEFORE UPDATE ON serial_pilot_rounds
 WHEN NEW.round_id IS NOT OLD.round_id OR NEW.recovery_of IS NOT OLD.recovery_of OR NEW.selected_count IS NOT OLD.selected_count OR NEW.created_at IS NOT OLD.created_at OR
 (OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED') AND (EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_verified_close_not_ready') OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_verified_close_guard','serial_pilot_verified_close_integrity','serial_pilot_verified_close_chain','serial_pilot_verified_close_journal','serial_pilot_verified_close_mixed'))<>5)) OR
 (OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category IN ('PARKED','NOT_STARTED')) AND (EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_classification_not_ready','serial_classification_unimplemented')) OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_classification_parked_guard','serial_classification_not_started_guard','serial_classification_integrity_guard','serial_classification_no_replace','serial_classification_no_update','serial_classification_no_delete','serial_classification_close_parked','serial_classification_close_not_started','serial_classification_close_integrity'))<>9)) OR
 NOT ((OLD.state='PREPARING' AND NEW.state='OPEN' AND
  (SELECT count(*) FROM serial_pilot_round_items i WHERE i.round_id=OLD.round_id)=OLD.selected_count) OR
 (OLD.state='OPEN' AND NEW.state='CLOSED' AND
  (SELECT count(*) FROM serial_pilot_round_results x WHERE x.round_id=OLD.round_id)=OLD.selected_count))
 BEGIN SELECT RAISE(ABORT,'invalid round transition'); END;

-- Opt-in fence: activation is irreversible and must only occur in an approved
-- migration/release after old writers have been stopped. The local draft never
-- activates it. A closed observation does not settle an in-flight provider call.
CREATE TABLE IF NOT EXISTS serial_pilot_round_fence_activation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), activated_at TEXT NOT NULL
);
-- Draft barrier: remove only in a reviewed change after lineage, classifier,
-- provider-quiescence, end-to-end recovery and release gates are proven.
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_not_ready BEFORE INSERT ON serial_pilot_round_fence_activation
 BEGIN SELECT RAISE(ABORT,'serial round fence is not ready for activation'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_activation_no_update BEFORE UPDATE ON serial_pilot_round_fence_activation BEGIN SELECT RAISE(ABORT,'fence activation immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_activation_no_delete BEFORE DELETE ON serial_pilot_round_fence_activation BEGIN SELECT RAISE(ABORT,'fence activation retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_activation_no_replace BEFORE INSERT ON serial_pilot_round_fence_activation WHEN EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation) BEGIN SELECT RAISE(ABORT,'fence already activated'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_activation_no_open BEFORE INSERT ON serial_pilot_round_fence_activation WHEN EXISTS(SELECT 1 FROM serial_pilot_rounds WHERE state IN ('PREPARING','OPEN')) BEGIN SELECT RAISE(ABORT,'open rounds prevent activation'); END;
CREATE TABLE IF NOT EXISTS serial_pilot_round_bindings (
 round_id TEXT PRIMARY KEY REFERENCES serial_pilot_rounds(round_id),
 spreadsheet_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_bindings_insert BEFORE INSERT ON serial_pilot_round_bindings
 WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_rounds WHERE round_id=NEW.round_id AND state='PREPARING') OR EXISTS(SELECT 1 FROM serial_pilot_round_bindings WHERE rowid=NEW.rowid OR round_id=NEW.round_id)
 BEGIN SELECT RAISE(ABORT,'invalid round binding'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_bindings_no_update BEFORE UPDATE ON serial_pilot_round_bindings BEGIN SELECT RAISE(ABORT,'binding immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_bindings_no_delete BEFORE DELETE ON serial_pilot_round_bindings BEGIN SELECT RAISE(ABORT,'binding retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_open BEFORE UPDATE OF state ON serial_pilot_rounds
 WHEN NEW.state='OPEN' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND
 (EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_not_ready') OR NEW.recovery_of IS NOT NULL OR NOT EXISTS(SELECT 1 FROM serial_pilot_round_bindings b WHERE b.round_id=NEW.round_id) OR EXISTS(
  SELECT 1 FROM serial_pilot_round_bindings mine JOIN admin_audit prior ON prior.action='ISSUE296_PAUSED_NOTICE_HANDOVER' AND json_extract(prior.before_json,'$.book')=mine.spreadsheet_id WHERE mine.round_id=NEW.round_id) OR EXISTS(
  SELECT 1 FROM serial_pilot_round_bindings mine JOIN serial_pilot_round_bindings other ON other.spreadsheet_id=mine.spreadsheet_id AND other.round_id<>mine.round_id
  JOIN serial_pilot_rounds r ON r.round_id=other.round_id AND r.state='OPEN' WHERE mine.round_id=NEW.round_id))
 BEGIN SELECT RAISE(ABORT,'round fence not exclusive'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_reservation BEFORE INSERT ON admin_audit
 WHEN NEW.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER')
 AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND (EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_not_ready') OR NOT EXISTS(SELECT 1 FROM serial_pilot_rounds r JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id
  JOIN serial_pilot_round_items next ON next.round_id=r.round_id AND next.job_id=NEW.entity_key
  WHERE r.state='OPEN' AND r.round_id=json_extract(NEW.after_json,'$.roundId')
   AND b.spreadsheet_id=json_extract(NEW.before_json,'$.book') AND b.fingerprint=NEW.reason
   AND (NEW.action='ISSUE296_PAUSED_NOTICE_HANDOVER' AND next.ordinal=0 OR
    NEW.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND NEW.id='issue296:serial:'||json_extract(NEW.before_json,'$.predecessorJobId') AND EXISTS(SELECT 1 FROM serial_pilot_round_items prior
    JOIN admin_audit edge ON edge.entity_key=prior.job_id AND edge.reason=NEW.reason AND edge.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(edge.before_json,'$.book')=b.spreadsheet_id AND json_extract(edge.after_json,'$.roundId')=r.round_id
    WHERE prior.round_id=r.round_id AND prior.job_id=json_extract(NEW.before_json,'$.predecessorJobId') AND prior.ordinal+1=next.ordinal
     AND length(json_extract(NEW.before_json,'$.proof'))=64 AND json_extract(NEW.before_json,'$.proof') NOT GLOB '*[^0-9a-f]*'))))
 BEGIN SELECT RAISE(ABORT,'serial reservation outside open round'); END;
-- A conservative close records only unresolved observations. Check the exact
-- successor inside the closing transaction; stale readbacks abort the batch.
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_result BEFORE INSERT ON serial_pilot_round_results
 WHEN EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND (
 EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_not_ready') OR
 NOT ((NEW.category='RECONCILE' AND NEW.evidence='UNVERIFIED') OR
      (NEW.category='VERIFIED' AND NEW.evidence='VERIFIED_RECEIPT' AND EXISTS(SELECT 1 FROM serial_pilot_verified_evidence v WHERE v.round_id=NEW.round_id AND v.job_id=NEW.job_id)) OR
      (NEW.category IN ('PARKED','NOT_STARTED') AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_classification_not_ready','serial_classification_unimplemented')) AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_classification_parked_guard','serial_classification_not_started_guard','serial_classification_integrity_guard','serial_classification_no_replace','serial_classification_no_update','serial_classification_no_delete','serial_classification_close_parked','serial_classification_close_not_started','serial_classification_close_integrity'))=9 AND EXISTS(SELECT 1 FROM serial_pilot_classification_evidence e WHERE e.round_id=NEW.round_id AND e.job_id=NEW.job_id AND e.category=NEW.category AND e.evidence=NEW.evidence AND e.successor_job_id IS NEW.successor_job_id))) OR
 (SELECT count(*) FROM admin_audit a WHERE a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(a.after_json,'$.roundId')=NEW.round_id AND json_extract(a.before_json,'$.predecessorJobId')=NEW.job_id)>1 OR
 NEW.successor_job_id IS NOT (SELECT a.entity_key FROM admin_audit a WHERE a.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(a.after_json,'$.roundId')=NEW.round_id AND json_extract(a.before_json,'$.predecessorJobId')=NEW.job_id))
 BEGIN SELECT RAISE(ABORT,'round result changed or lacks proof'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_audit_no_replace BEFORE INSERT ON admin_audit
 WHEN EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND EXISTS(SELECT 1 FROM admin_audit WHERE (id=NEW.id OR rowid=NEW.rowid) AND action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER'))
 BEGIN SELECT RAISE(ABORT,'serial audit retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_audit_no_update BEFORE UPDATE ON admin_audit
 WHEN EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND (OLD.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') OR NEW.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER'))
 BEGIN SELECT RAISE(ABORT,'serial audit immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_fence_audit_no_delete BEFORE DELETE ON admin_audit
 WHEN EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) AND OLD.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER')
 BEGIN SELECT RAISE(ABORT,'serial audit retained'); END;

-- Month and Worker are captured from the source and pinned audit *inside* the
-- reservation transaction; callers cannot supply the month. Historical audits
-- are not backfilled and must be treated as UNVERIFIED.
CREATE TABLE IF NOT EXISTS serial_pilot_reservation_snapshots (
 audit_id TEXT PRIMARY KEY REFERENCES admin_audit(id),
 round_id TEXT NOT NULL REFERENCES serial_pilot_rounds(round_id),
 job_id TEXT NOT NULL,
 epoch_id TEXT NOT NULL UNIQUE,
 spreadsheet_id TEXT NOT NULL,
 transaction_date TEXT NOT NULL,
 worker_version TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>=0)
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_snapshot_insert_guard BEFORE INSERT ON serial_pilot_reservation_snapshots
 WHEN EXISTS(SELECT 1 FROM serial_pilot_reservation_snapshots WHERE rowid=NEW.rowid OR audit_id=NEW.audit_id OR epoch_id=NEW.epoch_id) OR NOT EXISTS(
  SELECT 1 FROM admin_audit a JOIN serial_pilot_rounds r ON r.round_id=NEW.round_id AND r.state='OPEN'
   JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id AND b.spreadsheet_id=NEW.spreadsheet_id AND b.fingerprint=a.reason
   JOIN sync_jobs j ON j.job_id=a.entity_key AND j.job_id=NEW.job_id AND j.entity_type='EXPENSE' AND j.entity_version=1
   JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version AND e.status='CONFIRMED'
   JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=NEW.source_revision
   WHERE a.id=NEW.audit_id AND a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER')
   AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation activation WHERE activation.singleton=1 AND julianday(a.created_at)>=julianday(activation.activated_at))
   AND json_extract(a.before_json,'$.book')=NEW.spreadsheet_id AND json_extract(a.after_json,'$.roundId')=NEW.round_id
   AND json_extract(a.after_json,'$.epoch')=NEW.epoch_id AND json_extract(a.after_json,'$.version')=NEW.worker_version
   AND e.transaction_date=NEW.transaction_date AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date)
 BEGIN SELECT RAISE(ABORT,'reservation snapshot collision'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_snapshot_no_update BEFORE UPDATE ON serial_pilot_reservation_snapshots BEGIN SELECT RAISE(ABORT,'reservation snapshot immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_snapshot_no_delete BEFORE DELETE ON serial_pilot_reservation_snapshots BEGIN SELECT RAISE(ABORT,'reservation snapshot retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_snapshot_audit AFTER INSERT ON admin_audit
 WHEN NEW.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 BEGIN
  INSERT INTO serial_pilot_reservation_snapshots(audit_id,round_id,job_id,epoch_id,spreadsheet_id,transaction_date,worker_version,source_revision)
  SELECT NEW.id,r.round_id,j.job_id,json_extract(NEW.after_json,'$.epoch'),b.spreadsheet_id,e.transaction_date,json_extract(NEW.after_json,'$.version'),rev.revision
   FROM serial_pilot_rounds r JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id
   JOIN sync_jobs j ON j.job_id=NEW.entity_key AND j.entity_type='EXPENSE' AND j.entity_version=1
   JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version AND e.status='CONFIRMED'
   JOIN stable_source_revision rev ON rev.singleton=1
   WHERE r.round_id=json_extract(NEW.after_json,'$.roundId') AND r.state='OPEN' AND b.spreadsheet_id=json_extract(NEW.before_json,'$.book') AND b.fingerprint=NEW.reason
   AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date
   AND length(json_extract(NEW.after_json,'$.epoch')) BETWEEN 8 AND 128
   AND length(json_extract(NEW.after_json,'$.version'))=36
   AND length(replace(json_extract(NEW.after_json,'$.version'),'-',''))=32
   AND substr(json_extract(NEW.after_json,'$.version'),9,1)='-' AND substr(json_extract(NEW.after_json,'$.version'),14,1)='-'
   AND substr(json_extract(NEW.after_json,'$.version'),19,1)='-' AND substr(json_extract(NEW.after_json,'$.version'),24,1)='-'
   AND replace(json_extract(NEW.after_json,'$.version'),'-','') NOT GLOB '*[^0-9a-f]*';
  SELECT CASE WHEN changes()=1 THEN 1 ELSE RAISE(ABORT,'reservation snapshot unavailable') END;
 END;

-- A verified receipt records the exact readback/CAS evidence, not permission to
-- advance. Provider readback and the complete predicate are rechecked by the
-- Worker before insert; later reservations must repeat their own proof.
CREATE TABLE IF NOT EXISTS serial_pilot_verified_evidence (
 round_id TEXT NOT NULL, job_id TEXT NOT NULL, audit_id TEXT NOT NULL,
 epoch_id TEXT NOT NULL, worker_version TEXT NOT NULL,
 proof TEXT NOT NULL CHECK(length(proof)=64 AND proof NOT GLOB '*[^0-9a-f]*'),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0), verified_at TEXT NOT NULL,
 proof_algorithm TEXT NOT NULL CHECK(proof_algorithm='pilot-finish-v2'),
 proof_inputs TEXT NOT NULL CHECK(json_valid(proof_inputs) AND json_type(proof_inputs)='array'),
 PRIMARY KEY(round_id,job_id),
 FOREIGN KEY(round_id,job_id) REFERENCES serial_pilot_round_items(round_id,job_id),
 FOREIGN KEY(audit_id) REFERENCES admin_audit(id)
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_verified_evidence_insert BEFORE INSERT ON serial_pilot_verified_evidence
 WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1) OR EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_not_ready') OR
 EXISTS(SELECT 1 FROM serial_pilot_verified_evidence WHERE rowid=NEW.rowid OR (round_id=NEW.round_id AND job_id=NEW.job_id)) OR
 NOT EXISTS(SELECT 1 FROM serial_pilot_rounds r JOIN serial_pilot_round_bindings b ON b.round_id=r.round_id
  JOIN admin_audit a ON a.id=NEW.audit_id AND a.entity_key=NEW.job_id AND a.reason=b.fingerprint
  JOIN stable_recovery_epochs ep ON ep.epoch_id=NEW.epoch_id AND ep.spreadsheet_id=b.spreadsheet_id AND ep.state='COMPLETE'
  JOIN sync_jobs j ON j.job_id=NEW.job_id AND j.entity_key=ep.target_key AND j.entity_version=ep.target_version AND j.status='COMPLETED' AND j.lease_token IS NULL AND j.lease_until IS NULL
  WHERE r.round_id=NEW.round_id AND r.state='OPEN' AND json_extract(a.before_json,'$.book')=b.spreadsheet_id
   AND json_extract(a.after_json,'$.roundId')=r.round_id AND json_extract(a.after_json,'$.epoch')=ep.epoch_id AND json_extract(a.after_json,'$.version')=NEW.worker_version
   AND EXISTS(SELECT 1 FROM stable_source_revision rev WHERE rev.singleton=1 AND rev.revision=NEW.source_revision)
   AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=b.spreadsheet_id)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations op WHERE op.epoch_id=ep.epoch_id AND op.state<>'VERIFIED'))
 BEGIN SELECT RAISE(ABORT,'verified round evidence not justified'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_verified_evidence_no_update BEFORE UPDATE ON serial_pilot_verified_evidence BEGIN SELECT RAISE(ABORT,'verified round evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_verified_evidence_no_delete BEFORE DELETE ON serial_pilot_verified_evidence BEGIN SELECT RAISE(ABORT,'verified round evidence retained'); END;
