-- Owner decision, 18 November 2026 (issue #409, plan stage 1): a dashboard
-- customer can ask No Fries to contact them. A dashboard account becomes a
-- sales lead only when the customer asks; nothing here is inferred from signup.
--
-- This migration only creates the table and its privileges. Nothing writes to
-- it until the request route arrives behind a default-off flag.
--
-- One row per request. It records who asked (the sign-in subject), for which
-- organisation, about what (their results or one listed service), the consent
-- wording version they saw, and when. It holds no assessment answers, no
-- message text and no email address: staff views resolve the address at read
-- time, as the lifecycle email sender does (0023).
--
-- Bounds enforced here rather than by the caller:
--   * topic and consent_version are closed lists;
--   * request_id is the caller's operation id, so a retry is the same row;
--   * one request per organisation, topic and NZ calendar day, and the day must
--     be the Pacific/Auckland date of requested_at, so the caller cannot pick it.
--
-- nofries_runtime may SELECT rows of the transaction's tenant, and INSERT only a
-- row for the transaction's own tenant, organisation and sign-in subject.
-- It has no UPDATE, DELETE or TRUNCATE. RLS is enabled and forced.
-- nofries_account_wipe may SELECT and DELETE rows of the tenant being wiped,
-- exactly as for the other tenant tables in 0025, so reset and delete remove
-- these rows with the rest of the organisation's data.
--
-- Forward-only. It refuses with dashboard_contact_requests_precondition if a
-- required role is missing or the table already exists outside the ledger.
--
-- Rollback: DROP TABLE nofries.dashboard_contact_requests (no other object
-- depends on it), then delete its schema_migrations row.
DO $precheck$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_runtime')
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_account_wipe')
        OR to_regclass('nofries.dashboard_contact_requests') IS NOT NULL THEN
        RAISE EXCEPTION 'dashboard_contact_requests_precondition';
    END IF;
END
$precheck$;

CREATE TABLE nofries.dashboard_contact_requests (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    request_id uuid NOT NULL,
    subject_key text NOT NULL CHECK (subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    topic text NOT NULL CHECK (topic IN ('results',
        'fractional_advisory', 'managed_endpoint', 'endpoint_security', 'tier1_support', 'managed_it_core',
        'work_file_backup', 'microsoft_365_admin', 'google_workspace_admin', 'supplier_coordination',
        'monthly_proof', 'customer_onboarding', 'ai_service_desk')),
    consent_version text NOT NULL CHECK (consent_version IN ('contact-request-v1')),
    requested_day date NOT NULL,
    requested_at timestamptz(3) NOT NULL CHECK (isfinite(requested_at)),
    PRIMARY KEY (tenant_id, request_id),
    CONSTRAINT dashboard_contact_requests_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_contact_requests_daily UNIQUE (tenant_id, organisation_id, topic, requested_day),
    CONSTRAINT dashboard_contact_requests_day CHECK (requested_day = (requested_at AT TIME ZONE 'Pacific/Auckland')::date)
);

ALTER TABLE nofries.dashboard_contact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_contact_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_contact_requests_tenant_select ON nofries.dashboard_contact_requests
    FOR SELECT TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_contact_requests_tenant_insert ON nofries.dashboard_contact_requests
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
-- Restrictive: the supplied ids are not trusted on their own. The row must be for
-- the organisation and sign-in subject bound to this transaction, as in 0021.
CREATE POLICY dashboard_contact_requests_runtime_insert ON nofries.dashboard_contact_requests
    AS RESTRICTIVE FOR INSERT TO nofries_runtime
    WITH CHECK (organisation_id = NULLIF(current_setting('nofries.organisation_id', true), '')
        AND subject_key = NULLIF(current_setting('nofries.subject_key', true), ''));
CREATE POLICY dashboard_contact_requests_account_wipe ON nofries.dashboard_contact_requests
    FOR ALL TO nofries_account_wipe
    USING (tenant_id::text = NULLIF(current_setting('nofries.wipe_tenant_id', true), ''))
    WITH CHECK (false);
REVOKE ALL ON nofries.dashboard_contact_requests FROM PUBLIC, nofries_runtime, nofries_account_wipe;
GRANT SELECT, INSERT ON nofries.dashboard_contact_requests TO nofries_runtime;
GRANT SELECT, DELETE ON nofries.dashboard_contact_requests TO nofries_account_wipe;
