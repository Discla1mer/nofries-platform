-- UNAPPLIED PROPOSAL ONLY. Not a migration-catalog entry and never auto-run.
-- Reserved/held 0012 Board and 0013 document operations are unchanged. A release
-- coordinator must sequence, review and apply a future numbered migration only
-- after SQL/PITR/recovery/legal/release gates are satisfied.
-- Execute through an owner transaction on a separately approved database. This
-- proposal changes no retained preparation/offer/acceptance/activation bytes,
-- does not extend an account, adds no grants and preserves force-RLS policies.
-- New plan selection remains disabled in source defaults until this schema and
-- the exact terms archive are verified. Read-only post-expiry authentication is
-- a separate unresolved policy; this proposal does not weaken expiry guards.

-- Locate only the original closed-plan CHECK, without assuming the generated
-- ordinal of its constraint name. Refuse drift or an absent/duplicate guard.
DO $proposal$
DECLARE old_constraint text; matches integer;
BEGIN
    SELECT count(*),min(conname) INTO matches,old_constraint FROM pg_constraint
      WHERE conrelid='nofries.dashboard_starter_scopes'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%nf-starter-2026-09-r1%';
    IF matches<>1 THEN RAISE EXCEPTION 'starter_trial_constraint_drift'; END IF;
    EXECUTE format('ALTER TABLE nofries.dashboard_starter_scopes DROP CONSTRAINT %I',old_constraint);
END
$proposal$;
ALTER TABLE nofries.dashboard_starter_scopes ADD CONSTRAINT dashboard_starter_scopes_versioned_contract CHECK ((
    preparation->>'planId' IN ('nf-starter-2026-09-r1','nf-starter-2026-10-r2')
    AND preparation->'scope'=jsonb_build_object('tenantId',tenant_id,'organisationId',organisation_id)
    AND preparation->>'subjectKey'=subject_key AND preparation->>'accountType'=account_type
    AND preparation->>'kind'=CASE WHEN ordinal=0 THEN 'own' ELSE 'client' END
    AND (preparation->>'planId'='nf-starter-2026-09-r1'
      OR (preparation#>>'{source,offerInput,planId}'='nf-starter-2026-10-r2'
        AND preparation->>'planSha256'='52b690a1c36613938a50b86faa95a6cc1a01d6aafb3c42f0438eee3871e06024'
        AND preparation#>>'{terms,termsVersion}'='nf-dashboard-2026-10-r3'
        AND preparation#>>'{terms,termsDigest}'='441ae6d803002238cb742349e0789617ba141c2e8cc9c83c524c83015c89bf87'))
) IS TRUE);

CREATE OR REPLACE FUNCTION nofries.guard_starter_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, nofries AS $guard$
DECLARE start_at timestamptz; stop_at timestamptz; actual_at timestamptz;
    a jsonb; grant_value jsonb; membership_value jsonb; consent jsonb; usage_value jsonb;
    parent_preparation jsonb; parent_activation jsonb; selected_plan text;
    expected_terms text; expected_digest text; expected_plan_sha text; expected_limits jsonb;
BEGIN
    IF (to_jsonb(NEW)-'activation') IS DISTINCT FROM (to_jsonb(OLD)-'activation')
        OR OLD.activation IS NOT NULL OR NEW.activation IS NULL THEN
        RAISE EXCEPTION 'starter_scope_transition_invalid';
    END IF;
    a := NEW.activation;
    SELECT activated_at INTO start_at FROM nofries.dashboard_starter_accounts
        WHERE account_id = NEW.account_id AND subject_key = NEW.subject_key FOR SHARE;
    selected_plan := NEW.preparation->>'planId';
    CASE selected_plan
      WHEN 'nf-starter-2026-09-r1' THEN
        stop_at := start_at + interval '336 hours';
        expected_terms := 'nf-dashboard-2026-09-r2';
        expected_digest := '257fdd66a5359392428c0e5f16734a7ac64ff886e9b359218e4e87b4c7f68acc';
        expected_plan_sha := '171183757f61a1c7ce51667ff33a782558ae509cbb1d398538e22e95567c1ffb';
        expected_limits := '{"assessment_runs":5,"memberships":1,"ai_requests":0,"evidence_bytes":0,"report_exports":0}'::jsonb;
      WHEN 'nf-starter-2026-10-r2' THEN
        -- PostgreSQL month arithmetic clamps month ends. The explicit UTC
        -- conversion prevents session timezone or daylight-saving changes.
        stop_at := ((start_at AT TIME ZONE 'UTC') + interval '3 months') AT TIME ZONE 'UTC';
        expected_terms := 'nf-dashboard-2026-10-r3';
        expected_digest := '441ae6d803002238cb742349e0789617ba141c2e8cc9c83c524c83015c89bf87';
        expected_plan_sha := '52b690a1c36613938a50b86faa95a6cc1a01d6aafb3c42f0438eee3871e06024';
        expected_limits := '{"assessment_runs":null,"memberships":1,"ai_requests":0,"evidence_bytes":0,"report_exports":0}'::jsonb;
      ELSE RAISE EXCEPTION 'starter_plan_unknown';
    END CASE;
    IF NEW.ordinal > 0 THEN
        SELECT preparation,activation INTO parent_preparation,parent_activation
            FROM nofries.dashboard_starter_scopes WHERE account_id=NEW.account_id AND ordinal=0 FOR SHARE;
        IF NOT (parent_preparation->>'planId'=selected_plan
            AND parent_preparation->>'planSha256'=expected_plan_sha
            AND parent_activation->>'planId'=selected_plan
            AND (parent_activation->>'validFrom')::timestamptz=start_at
            AND (parent_activation->>'validUntil')::timestamptz=stop_at) IS TRUE THEN
            RAISE EXCEPTION 'starter_parent_invalid';
        END IF;
        -- Share the exact persisted original end, never restart a client trial.
        stop_at := (parent_activation->>'validUntil')::timestamptz;
    END IF;
    actual_at := (a->>'occurredAt')::timestamptz;
    IF NOT (start_at IS NOT NULL AND actual_at >= date_trunc('milliseconds',transaction_timestamp()) AND actual_at <= clock_timestamp()
        AND actual_at >= start_at AND actual_at < stop_at
        AND a->>'planId' = selected_plan
        AND NEW.preparation->>'planSha256'=expected_plan_sha
        AND a#>>'{intent,planId}'=selected_plan AND a#>>'{intent,planSha256}'=expected_plan_sha
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
        AND consent->>'termsVersion' = expected_terms
        AND consent->>'termsDigest' = expected_digest
        AND consent->>'scheduleId' = NEW.preparation#>>'{schedule,scheduleId}'
        AND consent->>'scheduleDigest' = NEW.preparation#>>'{schedule,scheduleDigest}'
        AND consent->>'status' = 'pending_admission' AND consent->'dashboardAccess' = 'false'::jsonb
        AND usage_value = '{"assessment_runs":0,"memberships":1,"ai_requests":0,"evidence_bytes":0,"report_exports":0}'::jsonb
        AND grant_value#>>'{0,grantId}' = NEW.preparation#>>'{slot,grantId}'
        AND grant_value#>>'{0,agreementRef}' = consent->>'scheduleId'
        AND grant_value#>>'{0,code}' = 'dashboard_score' AND grant_value#>>'{0,status}' = 'active'
        AND (grant_value#>>'{0,validFrom}')::timestamptz = start_at
        AND (grant_value#>>'{0,validUntil}')::timestamptz = stop_at
        AND grant_value#>'{0,limits}' = expected_limits
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

-- INSERT has no same-table subquery (which would recursively re-enter RLS).
-- The activation trigger independently verifies parent version and exact end.
DROP POLICY starter_scopes_new ON nofries.dashboard_starter_scopes;
CREATE POLICY starter_scopes_new ON nofries.dashboard_starter_scopes FOR INSERT TO nofries_runtime
    WITH CHECK (subject_key=NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')
        AND activation IS NULL
        AND NOT EXISTS (SELECT 1 FROM nofries.dashboard_tenants t WHERE t.tenant_id=dashboard_starter_scopes.tenant_id)
        AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a WHERE a.account_id=dashboard_starter_scopes.account_id
            AND (ordinal=0 AND a.activated_at IS NULL OR ordinal>0 AND a.activated_at<=clock_timestamp()
                AND clock_timestamp()<CASE dashboard_starter_scopes.preparation->>'planId'
                    WHEN 'nf-starter-2026-09-r1' THEN a.activated_at+interval '336 hours'
                    WHEN 'nf-starter-2026-10-r2' THEN ((a.activated_at AT TIME ZONE 'UTC')+interval '3 months') AT TIME ZONE 'UTC'
                    ELSE NULL END)));
