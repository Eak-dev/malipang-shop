-- Local draft only. The not-ready barrier remains installed. SHA and provider
-- readback rely on trusted Worker/D1/DDL and a separately proven external fence.
CREATE TRIGGER serial_pilot_verified_close_integrity BEFORE UPDATE OF state ON serial_pilot_rounds
WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED')
 AND ((SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
 'stable_source_revision_expense_events_insert','stable_source_revision_expense_events_update','stable_source_revision_expense_events_delete',
 'stable_source_revision_expense_documents_insert','stable_source_revision_expense_documents_update','stable_source_revision_expense_documents_delete',
 'stable_source_revision_expense_document_links_insert','stable_source_revision_expense_document_links_update','stable_source_revision_expense_document_links_delete',
 'stable_source_revision_expense_document_items_insert','stable_source_revision_expense_document_items_update','stable_source_revision_expense_document_items_delete',
 'stable_source_revision_owner_personal_transactions_insert','stable_source_revision_owner_personal_transactions_update','stable_source_revision_owner_personal_transactions_delete',
 'stable_source_revision_no_delete','stable_source_revision_no_replace','stable_source_revision_monotonic','stable_pre_cutover_no_delete','stable_pre_cutover_no_update','stable_pre_cutover_no_replace','stable_cutover_no_delete','stable_cutover_no_replace','stable_cutover_transition','stable_projection_no_delete','stable_projection_no_replace','stable_projection_transition'))<>27
 OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
 'stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace',
 'atomic_daily_marker_no_update','atomic_daily_marker_no_delete','atomic_daily_marker_no_replace',
 'continuous_daily_evidence_source','continuous_daily_evidence_no_update','continuous_daily_evidence_no_delete','continuous_daily_evidence_no_replace',
 'continuous_ledger_evidence_source','continuous_ledger_evidence_no_update','continuous_ledger_evidence_no_delete','continuous_ledger_evidence_no_replace',
 'serial_pilot_verified_evidence_insert','serial_pilot_verified_evidence_no_update','serial_pilot_verified_evidence_no_delete',
 'serial_pilot_fence_audit_no_replace','serial_pilot_fence_audit_no_update','serial_pilot_fence_audit_no_delete','serial_pilot_fence_result'))<>22
 OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
 'continuous_daily_cutover_prepared','continuous_daily_cutover_no_delete','continuous_daily_cutover_no_replace','continuous_daily_cutover_transition',
 'continuous_daily_snapshot_prepared','continuous_daily_snapshot_no_delete','continuous_daily_snapshot_no_update','continuous_daily_snapshot_no_replace',
 'continuous_daily_record_post_cutover','continuous_daily_post_no_delete','continuous_daily_post_no_update','continuous_daily_post_no_replace',
 'continuous_expense_projection_target_fence','continuous_expense_cutover_no_processing'))<>14
 OR EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_not_ready'))
BEGIN SELECT RAISE(ABORT,'verified close integrity unverified'); END;

CREATE TRIGGER serial_pilot_verified_close_guard BEFORE UPDATE OF state ON serial_pilot_rounds
WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results result WHERE result.round_id=OLD.round_id AND result.category='VERIFIED' AND NOT EXISTS(
 SELECT 1 FROM serial_pilot_verified_evidence v JOIN serial_pilot_round_bindings b ON b.round_id=v.round_id
 JOIN serial_pilot_round_items item ON item.round_id=v.round_id AND item.job_id=v.job_id
 JOIN admin_audit a ON a.id=v.audit_id AND a.entity_key=v.job_id AND a.reason=b.fingerprint
 JOIN stable_recovery_epochs ep ON ep.epoch_id=v.epoch_id AND ep.spreadsheet_id=b.spreadsheet_id AND ep.target_type='EXPENSE' AND ep.state='COMPLETE'
 JOIN sync_jobs job ON job.job_id=v.job_id AND job.entity_type='EXPENSE' AND job.entity_key=ep.target_key AND job.entity_version=ep.target_version AND job.status='COMPLETED' AND job.lease_token IS NULL AND job.lease_until IS NULL AND job.last_error IS NULL AND job.next_attempt_at IS NULL
 JOIN expense_events source ON source.expense_id=job.entity_key AND source.version=job.entity_version AND source.status='CONFIRMED'
 JOIN stable_source_revision revision ON revision.singleton=1 AND revision.revision=v.source_revision
 JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=b.spreadsheet_id AND cut.state='ACTIVE'
 WHERE ((((v.round_id=result.round_id AND v.job_id=result.job_id) AND (v.proof_algorithm='pilot-finish-v2' AND json_extract(a.before_json,'$.book')=b.spreadsheet_id)) AND ((json_extract(a.after_json,'$.roundId')=v.round_id AND json_extract(a.after_json,'$.epoch')=ep.epoch_id) AND (json_extract(a.after_json,'$.version')=v.worker_version AND json_extract(v.proof_inputs,'$[0]') IS b.spreadsheet_id))) AND (((json_extract(v.proof_inputs,'$[1]') IS ep.epoch_id AND json_extract(v.proof_inputs,'$[3]') IS (SELECT json_array(source.expense_id,source.version,source.status,source.transaction_date,source.description,source.amount_satang,source.payment_key,source.source_wallet,source.category,source.branch_id,source.updated_at))) AND (json_extract(v.proof_inputs,'$[5]') IS a.id AND json_extract(v.proof_inputs,'$[6]') IS a.action)) AND ((json_extract(v.proof_inputs,'$[7]') IS v.round_id AND json_extract(v.proof_inputs,'$[8]') IS item.ordinal) AND (NOT EXISTS(SELECT 1 FROM stable_workbook_claims claim WHERE claim.spreadsheet_id=b.spreadsheet_id) AND (NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.job_key='EXPENSE:'||source.expense_id||':'||source.version) AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations op WHERE op.epoch_id=ep.epoch_id AND op.state<>'VERIFIED'))))))
 )) BEGIN SELECT RAISE(ABORT,'verified identity changed before close'); END;

CREATE TRIGGER serial_pilot_verified_close_journal BEFORE UPDATE OF state ON serial_pilot_rounds
WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results result JOIN serial_pilot_verified_evidence v ON v.round_id=result.round_id AND v.job_id=result.job_id
 JOIN serial_pilot_round_bindings b ON b.round_id=v.round_id JOIN stable_recovery_epochs ep ON ep.epoch_id=v.epoch_id
 JOIN sync_jobs job ON job.job_id=v.job_id JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=b.spreadsheet_id AND cut.state='ACTIVE'
 WHERE result.round_id=OLD.round_id AND result.category='VERIFIED' AND (
  json_type(v.proof_inputs,'$[9]') IS NOT 'array' OR json_valid(json_extract(v.proof_inputs,'$[9]')) IS NOT 1 OR json_type(json_extract(v.proof_inputs,'$[9]')) IS NOT 'array'
  OR json_array_length(json_extract(v.proof_inputs,'$[9]'))<>2+(SELECT count(*) FROM expense_document_items item WHERE item.expense_id=job.entity_key)
  OR (SELECT count(DISTINCT json_array(json_extract(entry.value,'$[0]'),json_extract(entry.value,'$[1]'))) FROM json_each(json_extract(v.proof_inputs,'$[9]')) entry)<>json_array_length(json_extract(v.proof_inputs,'$[9]'))
  OR EXISTS(SELECT 1 FROM json_each(json_extract(v.proof_inputs,'$[9]')) first JOIN json_each(json_extract(v.proof_inputs,'$[9]')) second ON CAST(first.key AS INTEGER)<CAST(second.key AS INTEGER) WHERE json_extract(first.value,'$[0]')>json_extract(second.value,'$[0]') OR (json_extract(first.value,'$[0]')=json_extract(second.value,'$[0]') AND json_extract(first.value,'$[1]')>=json_extract(second.value,'$[1]')))
  OR (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=b.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=job.entity_key OR substr(p.entity_id,1,length(job.entity_key)+1)=job.entity_key||'|'))<>json_array_length(json_extract(v.proof_inputs,'$[9]'))
  OR EXISTS(SELECT 1 FROM json_each(json_extract(v.proof_inputs,'$[9]')) entry WHERE json_type(entry.value) IS NOT 'array' OR json_array_length(entry.value) IS NOT 13 OR json_type(entry.value,'$[2]') IS NOT 'integer' OR json_type(entry.value,'$[4]') IS NOT 'integer' OR json_type(entry.value,'$[7]') IS NOT 'integer' OR NOT EXISTS(
   SELECT 1 FROM stable_projection_writes p JOIN stable_recovery_operations op ON op.epoch_id=ep.epoch_id AND op.operation_token=p.operation_token AND op.state='VERIFIED'
   JOIN stable_expense_projection_preimages pre ON pre.spreadsheet_id=p.spreadsheet_id AND pre.entity_type=p.entity_type AND pre.entity_id=p.entity_id AND pre.projection=p.projection AND pre.sheet_id=p.sheet_id AND pre.sheet_name=p.sheet_name AND pre.source_version=p.source_version AND pre.source_digest=p.source_digest
   JOIN atomic_daily_marker_reservations marker ON marker.spreadsheet_id=p.spreadsheet_id AND marker.sheet_id=p.sheet_id AND marker.entity_id=p.entity_id AND marker.source_version=p.source_version AND marker.operation_token=p.operation_token
   LEFT JOIN continuous_daily_write_evidence daily ON p.projection='DAILY' AND daily.spreadsheet_id=p.spreadsheet_id AND daily.sheet_id=p.sheet_id AND daily.sheet_name=p.sheet_name AND daily.entity_id=p.entity_id AND daily.source_version=p.source_version AND daily.source_digest=p.source_digest AND daily.operation_token=p.operation_token AND daily.marker=marker.marker
   LEFT JOIN continuous_ledger_write_evidence ledger ON p.projection IN ('EXPENSE_RAW','DETAIL') AND ledger.operation_kind='CONFIRM' AND ledger.spreadsheet_id=p.spreadsheet_id AND ledger.sheet_id=p.sheet_id AND ledger.sheet_name=p.sheet_name AND ledger.entity_id=p.entity_id AND ledger.source_version=p.source_version AND ledger.operation_token=p.operation_token
   WHERE ((((p.spreadsheet_id=b.spreadsheet_id AND p.entity_type='EXPENSE') AND (p.state='VERIFIED' AND p.source_version=job.entity_version)) AND ((p.entity_id IS json_extract(entry.value,'$[0]') AND p.projection IS json_extract(entry.value,'$[1]')) AND (p.sheet_id IS json_extract(entry.value,'$[2]') AND (p.sheet_name IS json_extract(entry.value,'$[3]') AND p.source_version IS json_extract(entry.value,'$[4]'))))) AND (((p.source_digest IS json_extract(entry.value,'$[5]') AND p.operation_token IS json_extract(entry.value,'$[6]')) AND (pre.preimage_width IS json_extract(entry.value,'$[7]') AND (pre.preimage_digest IS json_extract(entry.value,'$[8]') AND marker.marker IS json_extract(entry.value,'$[9]')))) AND ((COALESCE(daily.marker,ledger.marker) IS json_extract(entry.value,'$[10]') AND COALESCE(daily.before_digest,ledger.before_digest) IS json_extract(entry.value,'$[11]')) AND (COALESCE(daily.payload_digest,ledger.payload_digest) IS json_extract(entry.value,'$[12]') AND (p.source_digest IS json_extract(v.proof_inputs,'$[4]') AND ((p.projection='DAILY' AND p.entity_id=job.entity_key AND p.sheet_id=cut.continuous_sheet_id AND p.sheet_name=cut.continuous_sheet_name AND daily.marker IS NOT NULL AND p.operation_token IS json_extract(v.proof_inputs,'$[2]')) OR (p.projection='EXPENSE_RAW' AND p.entity_id=job.entity_key AND p.sheet_id=cut.raw_sheet_id AND p.sheet_name=cut.raw_sheet_name AND ledger.marker IS NOT NULL) OR (p.projection='DETAIL' AND p.sheet_id=cut.detail_sheet_id AND p.sheet_name=cut.detail_sheet_name AND ledger.marker IS NOT NULL AND EXISTS(SELECT 1 FROM expense_document_items item WHERE item.expense_id=job.entity_key AND p.entity_id=job.entity_key||'|'||item.item_id))))))))
 ))
 )) BEGIN SELECT RAISE(ABORT,'verified journal changed before close'); END;

CREATE TRIGGER serial_pilot_verified_close_chain BEFORE UPDATE OF state ON serial_pilot_rounds
WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND NEW.reason<>'MOCK_CLASSIFIED' AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED') AND (
 (SELECT count(*) FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED' AND r.evidence='VERIFIED_RECEIPT')<>OLD.selected_count OR
 (SELECT count(*) FROM admin_audit a WHERE a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(a.after_json,'$.roundId')=OLD.round_id)<>OLD.selected_count OR
 EXISTS(SELECT 1 FROM serial_pilot_round_items item JOIN serial_pilot_round_bindings b ON b.round_id=item.round_id
 LEFT JOIN serial_pilot_verified_evidence v ON v.round_id=item.round_id AND v.job_id=item.job_id
 LEFT JOIN serial_pilot_round_results result ON result.round_id=item.round_id AND result.job_id=item.job_id
 LEFT JOIN serial_pilot_round_items next ON next.round_id=item.round_id AND next.ordinal=item.ordinal+1
 LEFT JOIN admin_audit a ON a.id=v.audit_id LEFT JOIN serial_pilot_round_items prev ON prev.round_id=item.round_id AND prev.ordinal=item.ordinal-1
 LEFT JOIN serial_pilot_verified_evidence pv ON pv.round_id=prev.round_id AND pv.job_id=prev.job_id
 WHERE item.round_id=OLD.round_id AND (v.job_id IS NULL OR result.job_id IS NULL OR result.successor_job_id IS NOT next.job_id OR a.id IS NULL OR a.entity_key IS NOT item.job_id OR a.reason IS NOT b.fingerprint OR json_extract(a.before_json,'$.book') IS NOT b.spreadsheet_id OR json_extract(a.after_json,'$.roundId') IS NOT item.round_id OR json_extract(a.after_json,'$.epoch') IS NOT v.epoch_id OR json_extract(a.after_json,'$.version') IS NOT v.worker_version OR (item.ordinal=0 AND a.action<>'ISSUE296_PAUSED_NOTICE_HANDOVER') OR (item.ordinal>0 AND (prev.job_id IS NULL OR pv.job_id IS NULL OR a.action<>'ISSUE296_SERIAL_EXPENSE_HANDOVER' OR a.id IS NOT 'issue296:serial:'||prev.job_id OR json_extract(a.before_json,'$.predecessorJobId') IS NOT prev.job_id OR json_extract(a.before_json,'$.proof') IS NOT pv.proof))))
 ) BEGIN SELECT RAISE(ABORT,'verified round chain unverified'); END;

-- Mixed mock requires one exact immutable B hold -> signed handoff -> C receipt.
-- Neither the attestation digest nor a PARKED label is C completion proof.
CREATE TRIGGER serial_pilot_verified_close_mixed BEFORE UPDATE OF state ON serial_pilot_rounds
WHEN OLD.state='OPEN' AND NEW.state='CLOSED' AND NEW.reason='MOCK_CLASSIFIED'
 AND EXISTS(SELECT 1 FROM serial_pilot_round_fence_activation WHERE singleton=1)
 AND EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED') AND (
 (SELECT count(*) FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='PARKED' AND r.evidence='MOCK_ATTESTED_HANDOFF')<>1 OR
 (SELECT count(*) FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND r.category='VERIFIED' AND r.evidence='VERIFIED_RECEIPT')<>1 OR
 (SELECT count(*) FROM admin_audit a WHERE a.action IN ('ISSUE296_PAUSED_NOTICE_HANDOVER','ISSUE296_SERIAL_EXPENSE_HANDOVER') AND json_extract(a.after_json,'$.roundId')=OLD.round_id)<>2 OR
 EXISTS(SELECT 1 FROM serial_pilot_round_results r WHERE r.round_id=OLD.round_id AND (r.category NOT IN ('PARKED','VERIFIED','NOT_STARTED','RECONCILE') OR (r.category='NOT_STARTED' AND r.evidence<>'MOCK_NEVER_STARTED') OR (r.category='RECONCILE' AND r.evidence<>'UNVERIFIED') OR (r.category IN ('NOT_STARTED','RECONCILE','VERIFIED') AND r.successor_job_id IS NOT NULL))) OR
 NOT EXISTS(SELECT 1 FROM serial_pilot_round_bindings b JOIN serial_pilot_round_items bi ON bi.round_id=b.round_id
 JOIN serial_pilot_round_items ci ON ci.round_id=bi.round_id AND ci.ordinal=bi.ordinal+1
 JOIN serial_pilot_round_results br ON br.round_id=bi.round_id AND br.job_id=bi.job_id AND br.category='PARKED' AND br.evidence='MOCK_ATTESTED_HANDOFF' AND br.successor_job_id=ci.job_id
 JOIN serial_pilot_round_results cr ON cr.round_id=ci.round_id AND cr.job_id=ci.job_id AND cr.category='VERIFIED' AND cr.evidence='VERIFIED_RECEIPT' AND cr.successor_job_id IS NULL
 JOIN serial_pilot_hold_evidence hold ON hold.round_id=bi.round_id AND hold.job_id=bi.job_id AND hold.spreadsheet_id=b.spreadsheet_id AND hold.fingerprint=b.fingerprint
 JOIN serial_pilot_attested_handoffs h ON h.round_id=b.round_id AND h.spreadsheet_id=b.spreadsheet_id AND h.predecessor_job_id=bi.job_id AND h.successor_job_id=ci.job_id AND h.predecessor_epoch_id=hold.epoch_id
 JOIN serial_pilot_verified_evidence v ON v.round_id=ci.round_id AND v.job_id=ci.job_id AND v.epoch_id=h.successor_epoch_id AND v.worker_version=h.worker_version AND v.proof_algorithm='pilot-finish-v2'
 JOIN admin_audit root ON root.id=hold.audit_id AND root.action='ISSUE296_PAUSED_NOTICE_HANDOVER' AND root.entity_key=bi.job_id AND root.reason=b.fingerprint AND json_extract(root.before_json,'$.book')=b.spreadsheet_id AND json_extract(root.after_json,'$.roundId')=b.round_id AND json_extract(root.after_json,'$.epoch')=h.predecessor_epoch_id AND json_extract(root.after_json,'$.token')=h.claim_token AND json_extract(root.after_json,'$.version')=h.worker_version
 JOIN admin_audit edge ON edge.id=v.audit_id AND edge.id='issue296:serial:'||bi.job_id AND edge.action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND edge.entity_key=ci.job_id AND edge.reason=b.fingerprint AND json_extract(edge.before_json,'$.book')=b.spreadsheet_id AND json_extract(edge.before_json,'$.predecessorJobId')=bi.job_id AND json_extract(edge.before_json,'$.proof')=h.payload_digest AND json_extract(edge.after_json,'$.roundId')=b.round_id AND json_extract(edge.after_json,'$.epoch')=h.successor_epoch_id AND json_extract(edge.after_json,'$.token')=h.claim_token AND json_extract(edge.after_json,'$.version')=h.worker_version AND json_extract(edge.after_json,'$.attestationNonce')=h.nonce
 WHERE b.round_id=OLD.round_id AND bi.ordinal=0
 )
) BEGIN SELECT RAISE(ABORT,'mixed verified round chain unverified'); END;
