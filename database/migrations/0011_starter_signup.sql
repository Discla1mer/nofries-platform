-- A separate, bounded new-customer lane. It cannot amend or withdraw existing
-- admission decisions, create staff roles, reset a trial or reclaim a client slot.
CREATE TABLE nofries.dashboard_starter_accounts (
    account_id uuid PRIMARY KEY,
    email_sha256 text NOT NULL UNIQUE CHECK (email_sha256 ~ '^[a-f0-9]{64}$'),
    subject_key text NOT NULL UNIQUE CHECK (subject_key ~ '^[a-f0-9-]{36}:[a-f0-9-]{36}$'),
    account_type text NOT NULL CHECK (account_type IN ('company','consultant')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    UNIQUE (account_id, account_type, subject_key),
    CHECK (activated_at IS NULL OR activated_at >= created_at)
);
CREATE TABLE nofries.dashboard_starter_scopes (
    tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-f0-9-]{36}$'),
    organisation_id text NOT NULL UNIQUE CHECK (organisation_id ~ '^[a-f0-9-]{36}$'),
    account_id uuid NOT NULL,
    account_type text NOT NULL,
    subject_key text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 3 AND (account_type = 'consultant' OR ordinal = 0)),
    authority_id uuid NOT NULL UNIQUE,
    binding_id uuid NOT NULL UNIQUE,
    preparation jsonb NOT NULL CHECK (jsonb_typeof(preparation) = 'object' AND octet_length(preparation::text) <= 131072),
    activation jsonb CHECK (activation IS NULL OR jsonb_typeof(activation) = 'object' AND octet_length(activation::text) <= 262144),
    UNIQUE (account_id, ordinal),
    UNIQUE (tenant_id, organisation_id),
    FOREIGN KEY (account_id, account_type, subject_key)
        REFERENCES nofries.dashboard_starter_accounts (account_id, account_type, subject_key)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((preparation->>'planId' = 'nf-starter-2026-09-r1'
        AND preparation->'scope' = jsonb_build_object('tenantId',tenant_id,'organisationId',organisation_id)
        AND preparation->>'subjectKey' = subject_key
        AND preparation->>'accountType' = account_type
        AND preparation->>'kind' = CASE WHEN ordinal = 0 THEN 'own' ELSE 'client' END) IS TRUE)
);

-- These guards are invoker functions with a fixed search path. Neither confers
-- maintenance rights. Registration identity is immutable; activation is set once.
CREATE FUNCTION nofries.guard_starter_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, nofries AS $guard$
BEGIN
    IF (to_jsonb(NEW)-'activated_at') IS DISTINCT FROM (to_jsonb(OLD)-'activated_at')
        OR OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.activated_at IS NULL
        OR NEW.activated_at < date_trunc('milliseconds',transaction_timestamp()) OR NEW.activated_at > clock_timestamp() THEN
        RAISE EXCEPTION 'starter_account_transition_invalid';
    END IF;
    RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION nofries.guard_starter_account() FROM PUBLIC, nofries_runtime;
CREATE TRIGGER starter_account_guard BEFORE UPDATE ON nofries.dashboard_starter_accounts
    FOR EACH ROW EXECUTE FUNCTION nofries.guard_starter_account();

CREATE FUNCTION nofries.guard_starter_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, nofries AS $guard$
DECLARE start_at timestamptz; stop_at timestamptz; actual_at timestamptz; a jsonb; grant_value jsonb; membership_value jsonb; consent jsonb; usage_value jsonb;
BEGIN
    IF (to_jsonb(NEW)-'activation') IS DISTINCT FROM (to_jsonb(OLD)-'activation')
        OR OLD.activation IS NOT NULL OR NEW.activation IS NULL THEN
        RAISE EXCEPTION 'starter_scope_transition_invalid';
    END IF;
    a := NEW.activation;
    SELECT activated_at INTO start_at FROM nofries.dashboard_starter_accounts
        WHERE account_id = NEW.account_id AND subject_key = NEW.subject_key FOR SHARE;
    stop_at := start_at + interval '336 hours';
    actual_at := (a->>'occurredAt')::timestamptz;
    IF NOT (start_at IS NOT NULL AND actual_at >= date_trunc('milliseconds',transaction_timestamp()) AND actual_at <= clock_timestamp()
        AND actual_at >= start_at AND actual_at < stop_at
        AND a->>'planId' = 'nf-starter-2026-09-r1'
        AND a->>'subjectKey' = NEW.subject_key
        AND a->>'bindingId' = NEW.binding_id::text
        AND a->'scope' = jsonb_build_object('tenantId',NEW.tenant_id,'organisationId',NEW.organisation_id)
        AND (a->>'validFrom')::timestamptz = start_at AND (a->>'validUntil')::timestamptz = stop_at
        AND a#>>'{admission,authorityId}' = NEW.authority_id::text
        AND a#>>'{admission,payload,decision}' = 'eligible'
        AND a#>'{admission,revision}' = '0'::jsonb
        AND a#>>'{admission,payload,actorSubjectKey}' = NEW.subject_key
        AND a#>'{admission,scope}' = a->'scope'
        AND (a#>>'{admission,payload,validFrom}')::timestamptz = actual_at
        AND (a#>>'{admission,payload,validUntil}')::timestamptz = stop_at) IS TRUE THEN
        RAISE EXCEPTION 'starter_activation_invalid';
    END IF;
    -- Independently bound the canonical product being admitted by this lane.
    SELECT payload->'grants' INTO grant_value FROM nofries.dashboard_entitlement_states
        WHERE tenant_id = NEW.tenant_id AND organisation_id = NEW.organisation_id;
    SELECT payload->'memberships' INTO membership_value FROM nofries.dashboard_membership_states
        WHERE tenant_id = NEW.tenant_id AND organisation_id = NEW.organisation_id;
    SELECT payload->'receipt' INTO consent FROM nofries.signup_acceptance_receipts
        WHERE tenant_id = NEW.tenant_id AND organisation_id = NEW.organisation_id
        AND invitation_id = NEW.preparation->>'invitationId' AND subject_key = NEW.subject_key;
    SELECT payload->'counters' INTO usage_value FROM nofries.dashboard_usage
        WHERE tenant_id = NEW.tenant_id AND organisation_id = NEW.organisation_id
        AND grant_id = NEW.preparation#>>'{slot,grantId}';
    IF NOT (jsonb_array_length(grant_value) = 1
        AND consent = a->'acceptance'
        AND consent->>'termsVersion' = 'nf-dashboard-2026-09-r2'
        AND consent->>'termsDigest' = '257fdd66a5359392428c0e5f16734a7ac64ff886e9b359218e4e87b4c7f68acc'
        AND consent->>'scheduleId' = NEW.preparation#>>'{schedule,scheduleId}'
        AND consent->>'scheduleDigest' = NEW.preparation#>>'{schedule,scheduleDigest}'
        AND consent->>'status' = 'pending_admission' AND consent->'dashboardAccess' = 'false'::jsonb
        AND usage_value = '{"assessment_runs":0,"memberships":1,"ai_requests":0,"evidence_bytes":0,"report_exports":0}'::jsonb
        AND grant_value#>>'{0,grantId}' = NEW.preparation#>>'{slot,grantId}'
        AND grant_value#>>'{0,agreementRef}' = consent->>'scheduleId'
        AND grant_value#>>'{0,code}' = 'dashboard_score' AND grant_value#>>'{0,status}' = 'active'
        AND (grant_value#>>'{0,validFrom}')::timestamptz = start_at
        AND (grant_value#>>'{0,validUntil}')::timestamptz = stop_at
        AND grant_value#>'{0,limits}' = '{"assessment_runs":5,"memberships":1,"ai_requests":0,"evidence_bytes":0,"report_exports":0}'::jsonb
        AND grant_value#>'{0,modules}' @> '["overview","cyber_security","improvement_plan"]'::jsonb
        AND jsonb_array_length(grant_value#>'{0,modules}') = 3
        AND grant_value#>'{0,actions}' = '[]'::jsonb AND grant_value#>'{0,coverage}' = '[]'::jsonb
        AND jsonb_array_length(membership_value) = 1
        AND membership_value#>>'{0,subjectKey}' = NEW.subject_key
        AND membership_value#>>'{0,status}' = 'active'
        AND membership_value#>'{0,roles}' = '["admin"]'::jsonb
        AND (membership_value#>>'{0,validFrom}')::timestamptz = actual_at
        AND (membership_value#>>'{0,validUntil}')::timestamptz = stop_at) IS TRUE THEN
        RAISE EXCEPTION 'starter_product_invalid';
    END IF;
    RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION nofries.guard_starter_scope() FROM PUBLIC, nofries_runtime;
CREATE TRIGGER starter_scope_guard BEFORE UPDATE ON nofries.dashboard_starter_scopes
    FOR EACH ROW EXECUTE FUNCTION nofries.guard_starter_scope();

ALTER TABLE nofries.dashboard_starter_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_starter_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_starter_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_starter_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY starter_accounts_subject ON nofries.dashboard_starter_accounts TO nofries_runtime
    USING (subject_key = NULLIF(current_setting('nofries.subject_key',true),''))
    WITH CHECK (subject_key = NULLIF(current_setting('nofries.subject_key',true),''));
CREATE POLICY starter_scopes_subject_read ON nofries.dashboard_starter_scopes FOR SELECT TO nofries_runtime
    USING (subject_key = NULLIF(current_setting('nofries.subject_key',true),''));
CREATE POLICY starter_scopes_new ON nofries.dashboard_starter_scopes FOR INSERT TO nofries_runtime
    WITH CHECK (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'')
        AND activation IS NULL
        AND NOT EXISTS (SELECT 1 FROM nofries.dashboard_tenants t WHERE t.tenant_id = dashboard_starter_scopes.tenant_id)
        AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a WHERE a.account_id = dashboard_starter_scopes.account_id
            AND (ordinal = 0 AND a.activated_at IS NULL OR ordinal > 0 AND a.activated_at <= clock_timestamp()
                AND clock_timestamp() < a.activated_at + interval '336 hours')));
CREATE POLICY starter_scopes_activate ON nofries.dashboard_starter_scopes FOR UPDATE TO nofries_runtime
    USING (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'') AND activation IS NULL)
    WITH CHECK (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'') AND activation IS NOT NULL);
REVOKE ALL ON nofries.dashboard_starter_accounts, nofries.dashboard_starter_scopes FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_starter_accounts, nofries.dashboard_starter_scopes TO nofries_runtime;
GRANT UPDATE (activated_at) ON nofries.dashboard_starter_accounts TO nofries_runtime;
GRANT UPDATE (activation) ON nofries.dashboard_starter_scopes TO nofries_runtime;

CREATE POLICY starter_authority_insert ON nofries.dashboard_admission_authorities FOR INSERT TO nofries_runtime
    WITH CHECK (head_revision = 0 AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_scopes s
        WHERE s.authority_id = dashboard_admission_authorities.authority_id
        AND s.tenant_id = dashboard_admission_authorities.tenant_id AND s.organisation_id = dashboard_admission_authorities.organisation_id
        AND s.subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND s.activation#>>'{admission,decisionSha256}' = dashboard_admission_authorities.head_sha256));
CREATE POLICY starter_admission_insert ON nofries.dashboard_admission_decisions FOR INSERT TO nofries_runtime
    WITH CHECK (revision = 0 AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_scopes s
        WHERE s.authority_id = dashboard_admission_decisions.authority_id
        AND s.tenant_id = dashboard_admission_decisions.tenant_id AND s.organisation_id = dashboard_admission_decisions.organisation_id
        AND s.subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND s.activation#>>'{admission,decisionSha256}' = dashboard_admission_decisions.decision_sha256
        AND s.activation#>'{admission,payload}' = dashboard_admission_decisions.payload));
GRANT INSERT ON nofries.dashboard_admission_authorities, nofries.dashboard_admission_decisions TO nofries_runtime;
-- No runtime UPDATE/DELETE on admission tables and no maintenance-role membership.
