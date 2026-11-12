-- Owner decision, 12 November 2026 (#151): a consultant can discard a draft
-- client organisation (nothing is deleted), and a client place is used at
-- activation, not when the draft is created. Forward-only, idempotent, and it
-- rewrites no rows. dashboard_starter_scopes gains discarded_at, set once by
-- the owning subject on an unactivated client draft; the 0011 ordinal check
-- (0 to 3) becomes dashboard_starter_scopes_ordinal_bound (0 to 12), with
-- UNIQUE (account_id, ordinal) kept. guard_starter_scope() keeps every 0017
-- check and adds: the discard transition, no activation of a discarded draft,
-- and for a client activation an account lock FOR UPDATE (was FOR SHARE),
-- READ COMMITTED only, and refusal past 3 activated, non-discarded clients.
-- The insert policy also requires discarded_at IS NULL. New policy
-- starter_scopes_discard and an UPDATE grant on discarded_at only.
-- Rollback, only while no row is discarded and no ordinal exceeds 3: restore
-- the 0017 guard and insert policy, drop starter_scopes_discard, revoke the
-- column grant, drop both new checks, re-add the 0011 ordinal check, drop
-- the column. Refuse if the unapplied three-calendar-month trial proposal was
-- applied by hand: replacing the guard below would silently undo its rules.
DO $precheck$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'nofries.dashboard_starter_scopes'::regclass
               AND conname = 'dashboard_starter_scopes_versioned_contract') THEN
        RAISE EXCEPTION 'starter_client_period_precondition: three-month trial proposal is applied; reconcile before 0019';
    END IF;
END
$precheck$;

ALTER TABLE nofries.dashboard_starter_scopes ADD COLUMN IF NOT EXISTS discarded_at timestamptz;

-- Replace only the 0011 ordinal check, found by its column set, not its name.
DO $ordinal$
DECLARE table_oid oid := 'nofries.dashboard_starter_scopes'::regclass; old_check text; matches integer;
BEGIN
    SELECT count(*), min(c.conname) INTO matches, old_check FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = table_oid AND c.contype = 'c' AND c.conname <> 'dashboard_starter_scopes_ordinal_bound'
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = table_oid AND a.attnum = ANY (c.conkey)) = ARRAY['account_type','ordinal'];
    IF matches > 1 OR matches = 1 AND pg_catalog.pg_get_constraintdef((SELECT oid FROM pg_catalog.pg_constraint
            WHERE conrelid = table_oid AND conname = old_check)) NOT LIKE '%ordinal <= 3%' THEN RAISE EXCEPTION 'starter_ordinal_check_drift';
    ELSIF matches = 1 THEN EXECUTE format('ALTER TABLE nofries.dashboard_starter_scopes DROP CONSTRAINT %I', old_check); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = table_oid AND conname = 'dashboard_starter_scopes_ordinal_bound') THEN
        ALTER TABLE nofries.dashboard_starter_scopes ADD CONSTRAINT dashboard_starter_scopes_ordinal_bound
            CHECK (ordinal BETWEEN 0 AND 12 AND (account_type = 'consultant' OR ordinal = 0));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = table_oid AND conname = 'dashboard_starter_scopes_discard_draft') THEN
        ALTER TABLE nofries.dashboard_starter_scopes ADD CONSTRAINT dashboard_starter_scopes_discard_draft
            CHECK (discarded_at IS NULL OR activation IS NULL AND ordinal > 0);
    END IF;
END
$ordinal$;

CREATE OR REPLACE FUNCTION nofries.guard_starter_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, nofries AS $guard$
DECLARE start_at timestamptz; stop_at timestamptz; actual_at timestamptz; a jsonb; grant_value jsonb; membership_value jsonb; consent jsonb; usage_value jsonb; used bigint;
BEGIN
    -- Discard: the only change is discarded_at, set once by the owning subject
    -- on a client draft that has not been activated.
    IF OLD.discarded_at IS NULL AND NEW.discarded_at IS NOT NULL THEN
        IF (to_jsonb(NEW)-'discarded_at') IS DISTINCT FROM (to_jsonb(OLD)-'discarded_at')
            OR OLD.activation IS NOT NULL OR OLD.ordinal < 1
            OR NOT (NEW.subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
                AND NEW.discarded_at >= date_trunc('milliseconds',transaction_timestamp())
                AND NEW.discarded_at <= clock_timestamp()) IS TRUE THEN
            RAISE EXCEPTION 'starter_scope_discard_invalid';
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-'activation') IS DISTINCT FROM (to_jsonb(OLD)-'activation')
        OR OLD.activation IS NOT NULL OR NEW.activation IS NULL THEN
        RAISE EXCEPTION 'starter_scope_transition_invalid';
    END IF;
    IF OLD.discarded_at IS NOT NULL THEN RAISE EXCEPTION 'starter_scope_discarded'; END IF;
    a := NEW.activation;
    -- Lock the account row before counting so two client activations of one
    -- account run one after the other. Under READ COMMITTED each statement in
    -- this function takes a new snapshot, so the count below sees any
    -- activation committed while this transaction waited for the lock. A
    -- REPEATABLE READ or SERIALIZABLE snapshot would not, so they are refused.
    SELECT activated_at INTO start_at FROM nofries.dashboard_starter_accounts
        WHERE account_id = NEW.account_id AND subject_key = NEW.subject_key FOR UPDATE;
    IF NEW.ordinal > 0 THEN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
            RAISE EXCEPTION 'starter_activation_isolation_invalid';
        END IF;
        -- Counts through starter_scopes_subject_read (all of the owner's scopes); a native test pins that policy.
        SELECT count(*) INTO used FROM nofries.dashboard_starter_scopes
            WHERE account_id = NEW.account_id AND ordinal > 0 AND activation IS NOT NULL AND discarded_at IS NULL;
        IF used >= 3 THEN RAISE EXCEPTION 'starter_client_limit'; END IF;
    END IF;
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
        AND activation IS NULL AND discarded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM nofries.dashboard_tenants t WHERE t.tenant_id = dashboard_starter_scopes.tenant_id)
        AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a WHERE a.account_id = dashboard_starter_scopes.account_id
            AND (ordinal = 0 AND a.activated_at IS NULL OR ordinal > 0 AND a.activated_at <= clock_timestamp())));

DROP POLICY IF EXISTS starter_scopes_discard ON nofries.dashboard_starter_scopes;
CREATE POLICY starter_scopes_discard ON nofries.dashboard_starter_scopes FOR UPDATE TO nofries_runtime
    USING (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'')
        AND ordinal > 0 AND activation IS NULL AND discarded_at IS NULL)
    WITH CHECK (subject_key = NULLIF(current_setting('nofries.subject_key',true),'')
        AND tenant_id = NULLIF(current_setting('nofries.tenant_id',true),'')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id',true),'')
        AND ordinal > 0 AND activation IS NULL AND discarded_at IS NOT NULL);
GRANT UPDATE (discarded_at) ON nofries.dashboard_starter_scopes TO nofries_runtime;
