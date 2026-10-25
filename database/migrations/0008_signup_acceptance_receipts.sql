-- Canonical accepted pilot terms are decision proof under GOV-007's seven-year
-- schedule. Runtime may append and reconcile exact receipts, never update/delete.
CREATE TABLE nofries.signup_acceptance_receipts (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    receipt_id text NOT NULL,
    invitation_id text NOT NULL,
    subject_key text NOT NULL,
    terms_version text NOT NULL,
    terms_digest text NOT NULL,
    accepted_at bigint NOT NULL,
    retention_policy_id text NOT NULL,
    delete_after bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, receipt_id),
    UNIQUE (tenant_id, organisation_id, invitation_id),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_organisations
        (tenant_id, organisation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (length(receipt_id) BETWEEN 1 AND 180 AND receipt_id = btrim(receipt_id) AND receipt_id !~ '[[:cntrl:]]'),
    CHECK (length(invitation_id) BETWEEN 1 AND 180 AND invitation_id = btrim(invitation_id) AND invitation_id !~ '[[:cntrl:]]'),
    CHECK (subject_key ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
    CHECK (length(terms_version) BETWEEN 1 AND 180 AND terms_version = btrim(terms_version) AND terms_version !~ '[[:cntrl:]]'),
    CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
    CHECK (accepted_at BETWEEN 0 AND 9007199254740991
        AND delete_after = round(extract(epoch FROM (
            ((to_timestamp(accepted_at / 1000.0) AT TIME ZONE 'UTC') + interval '7 years') AT TIME ZONE 'UTC'
        )) * 1000)::bigint),
    CHECK (retention_policy_id = 'gov-007-issued-decision-proof-7y-v1'),
    CHECK (octet_length(payload::text) <= 16384),
    CHECK ((jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','retentionPolicyId','deleteAfter','receipt']
        AND payload - ARRAY['schemaVersion','retentionPolicyId','deleteAfter','receipt'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND payload ->> 'retentionPolicyId' = retention_policy_id
        AND payload -> 'deleteAfter' = to_jsonb(delete_after)
        AND jsonb_typeof(payload -> 'receipt') = 'object'
        AND payload -> 'receipt' ?& ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
            'termsVersion','termsDigest','acceptedAt','status','dashboardAccess']
        AND (payload -> 'receipt') - ARRAY['receiptId','invitationId','subjectKey','tenantId','organisationId',
            'termsVersion','termsDigest','acceptedAt','status','dashboardAccess'] = '{}'::jsonb
        AND payload -> 'receipt' ->> 'tenantId' = tenant_id
        AND payload -> 'receipt' ->> 'organisationId' = organisation_id
        AND payload -> 'receipt' ->> 'receiptId' = receipt_id
        AND payload -> 'receipt' ->> 'invitationId' = invitation_id
        AND payload -> 'receipt' ->> 'subjectKey' = subject_key
        AND payload -> 'receipt' ->> 'termsVersion' = terms_version
        AND payload -> 'receipt' ->> 'termsDigest' = terms_digest
        AND payload -> 'receipt' -> 'acceptedAt' = to_jsonb(accepted_at)
        AND payload -> 'receipt' ->> 'status' = 'pending_admission'
        AND payload -> 'receipt' -> 'dashboardAccess' = 'false'::jsonb) IS TRUE)
);

ALTER TABLE nofries.signup_acceptance_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.signup_acceptance_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY signup_acceptance_receipts_tenant_select ON nofries.signup_acceptance_receipts
    FOR SELECT TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY signup_acceptance_receipts_tenant_insert ON nofries.signup_acceptance_receipts
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.signup_acceptance_receipts FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.signup_acceptance_receipts TO nofries_runtime;
