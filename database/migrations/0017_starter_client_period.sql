-- Owner decision, 10 November 2026: remove the 14-day limit on adding client
-- organisations. Forward-only and idempotent: it replaces one trigger function
-- and one insert policy in place and rewrites no rows. Existing accounts,
-- scopes, activations, grants and memberships are untouched, and every
-- activation already stored satisfies the replaced guard unchanged.
--
-- guard_starter_scope(): the activation no longer has to fall inside the
-- account's first 336 hours. All other checks are kept, including exact
-- equality of every recorded validFrom/validUntil. Only the expected end moves
-- for a late activation: it cannot be the account's original end, because the
-- admission, binding and membership records start at the activation instant
-- and their own constraints (0005 dashboard_admission_payload,
-- dashboard_binding_interval) require start < end. The recorded end is data;
-- the application does not enforce it.
--
-- starter_scopes_new: the insert policy also refused a client scope after 336
-- hours, before the trigger was reached, so that one clause is removed.
--
-- Rollback: re-create both objects with the definitions in 0011_starter_signup.sql
-- (CREATE OR REPLACE FUNCTION; DROP POLICY IF EXISTS + CREATE POLICY). Scopes
-- activated after the original period while this version was live stay valid
-- stored rows; only new late activations would be refused again.
CREATE OR REPLACE FUNCTION nofries.guard_starter_scope() RETURNS trigger
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
    -- An organisation activated after the account's recorded period records the
    -- same 336-hour period from its own activation; before it, the shared end.
    IF actual_at >= stop_at THEN stop_at := actual_at + interval '336 hours'; END IF;
    IF NOT (start_at IS NOT NULL AND actual_at >= date_trunc('milliseconds',transaction_timestamp()) AND actual_at <= clock_timestamp()
        AND actual_at >= start_at
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

DROP POLICY IF EXISTS starter_scopes_new ON nofries.dashboard_starter_scopes;
CREATE POLICY starter_scopes_new ON nofries.dashboard_starter_scopes FOR INSERT TO nofries_runtime
    WITH CHECK (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'')
        AND activation IS NULL
        AND NOT EXISTS (SELECT 1 FROM nofries.dashboard_tenants t WHERE t.tenant_id = dashboard_starter_scopes.tenant_id)
        AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a WHERE a.account_id = dashboard_starter_scopes.account_id
            AND (ordinal = 0 AND a.activated_at IS NULL OR ordinal > 0 AND a.activated_at <= clock_timestamp())));
