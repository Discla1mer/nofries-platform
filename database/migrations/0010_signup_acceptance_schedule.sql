-- Extend immutable acceptance receipts with the organisation schedule that was
-- displayed and accepted. Migration 0008 remains immutable for checksum safety.
ALTER TABLE nofries.signup_acceptance_receipts
    ADD COLUMN schedule_id text,
    ADD COLUMN schedule_digest text;

ALTER TABLE nofries.signup_acceptance_receipts
    ADD CONSTRAINT signup_acceptance_receipts_schedule_check
    CHECK ((schedule_id IS NULL AND schedule_digest IS NULL) OR
        (length(schedule_id) BETWEEN 1 AND 180 AND schedule_id = btrim(schedule_id)
            AND schedule_id !~ '[[:cntrl:]]' AND schedule_digest ~ '^[a-f0-9]{64}$'));

DO $migration$
DECLARE
    legacy_payload_shape_constraint text;
BEGIN
    SELECT constraint_row.conname
      INTO STRICT legacy_payload_shape_constraint
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS relation_row ON relation_row.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
     WHERE namespace_row.nspname = 'nofries'
       AND relation_row.relname = 'signup_acceptance_receipts'
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%jsonb_typeof(payload)%';

    EXECUTE format(
        'ALTER TABLE nofries.signup_acceptance_receipts DROP CONSTRAINT %I',
        legacy_payload_shape_constraint
    );
END
$migration$;

ALTER TABLE nofries.signup_acceptance_receipts
    ADD CONSTRAINT signup_acceptance_receipts_payload_shape_check
    CHECK ((jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','retentionPolicyId','deleteAfter','receipt']
        AND payload - ARRAY['schemaVersion','retentionPolicyId','deleteAfter','receipt'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND payload ->> 'retentionPolicyId' = retention_policy_id
        AND payload -> 'deleteAfter' = to_jsonb(delete_after)
        AND jsonb_typeof(payload -> 'receipt') = 'object'
        AND (((schedule_id IS NULL AND schedule_digest IS NULL)
            AND payload -> 'receipt' ?& ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
                'termsVersion','termsDigest','acceptedAt','status','dashboardAccess']
            AND (payload -> 'receipt') - ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
                'termsVersion','termsDigest','acceptedAt','status','dashboardAccess'] = '{}'::jsonb)
          OR (schedule_id IS NOT NULL AND schedule_digest IS NOT NULL
            AND payload -> 'receipt' ?& ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
                'termsVersion','termsDigest','scheduleId','scheduleDigest','acceptedAt','status','dashboardAccess']
            AND (payload -> 'receipt') - ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
                'termsVersion','termsDigest','scheduleId','scheduleDigest','acceptedAt','status','dashboardAccess'] = '{}'::jsonb
            AND payload -> 'receipt' ->> 'scheduleId' = schedule_id
            AND payload -> 'receipt' ->> 'scheduleDigest' = schedule_digest))
        AND payload -> 'receipt' ->> 'tenantId' = tenant_id
        AND payload -> 'receipt' ->> 'organisationId' = organisation_id
        AND payload -> 'receipt' ->> 'receiptId' = receipt_id
        AND payload -> 'receipt' ->> 'invitationId' = invitation_id
        AND payload -> 'receipt' ->> 'subjectKey' = subject_key
        AND payload -> 'receipt' ->> 'termsVersion' = terms_version
        AND payload -> 'receipt' ->> 'termsDigest' = terms_digest
        AND payload -> 'receipt' -> 'acceptedAt' = to_jsonb(accepted_at)
        AND payload -> 'receipt' ->> 'status' = 'pending_admission'
        AND payload -> 'receipt' -> 'dashboardAccess' = 'false'::jsonb) IS TRUE);
