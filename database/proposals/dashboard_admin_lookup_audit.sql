-- UNAPPLIED PROPOSAL ONLY: not a migration-catalog entry or runtime action.
-- Held 0012 Board and 0013 document-operation proposals remain unchanged.
-- Only a separately reviewed, sequenced owner transaction may apply this delta.
-- This fixture adds no role, policy, grant, ownership or retention decision.
-- A temporary parser reference verifies exact predecessor/candidate constraints;
-- it is dropped before return and is not a new retained destination.
-- Current native operator/proof/epoch policy remains the application boundary.
-- Existing audit RLS binds its supplied native context; it is not a proof of
-- operator purpose. The canonical outer event hash is verified by the writer.
DO $proposal$
DECLARE
    baseline_payload text; candidate_payload text; baseline_expression text;
    baseline_type text; candidate_type text; installed_payload text;
    installed_type text; installed_type_name text; type_matches integer;
    lookup_expression text; phase_index regclass; expected_index regclass;
BEGIN
    CREATE TEMPORARY TABLE nf_dashboard_admin_lookup_contract
        (LIKE nofries.dashboard_runtime_audit) ON COMMIT DROP;
    ALTER TABLE pg_temp.nf_dashboard_admin_lookup_contract
        ADD CONSTRAINT expected_payload_predecessor CHECK ((payload->'schemaVersion'='1'::jsonb
        AND payload->>'eventId'=event_id::text AND payload->>'eventType'=event_type
        AND payload->>'requestId'=request_id::text AND payload->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND ((event_type='dashboard.runtime'
          AND jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt', 'actorSubjectKey', 'scope', 'action', 'outcome', 'resourceKey', 'operationId'] AND payload - ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt', 'actorSubjectKey', 'scope', 'action', 'outcome', 'resourceKey', 'operationId']='{}'::jsonb
          AND payload->'scope'=scope_json AND payload->'operationId'=COALESCE(to_jsonb(operation_id),'null'::jsonb)
          AND (payload->'actorSubjectKey'='null'::jsonb OR (jsonb_typeof(payload->'actorSubjectKey')='string'
            AND payload->>'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
          AND payload->>'outcome' IN ('succeeded','denied','failed')
          AND ((payload->>'action'='initializeOperatorSession' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='activateCustomerSession' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='recordProofAndActivateDiscovery' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='selectBinding' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='revokeSession' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='publishAdmissionDecision' AND payload->>'resourceKey'='admission')
            OR (payload->>'action'='withdrawAdmissionDecision' AND payload->>'resourceKey'='admission')
            OR (payload->>'action'='createCase' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='approveCase' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='revokeCase' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='denyCase' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='expireCase' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='acceptStagedOnboarding' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='publishExistingMembershipBinding' AND payload->>'resourceKey'='binding')
            OR (payload->>'action'='initializeRuntimeInstance' AND payload->>'resourceKey'='instance')
            OR (payload->>'action'='fenceRestoreEpoch' AND payload->>'resourceKey'='instance')
            OR (payload->>'action'='enableRuntimeIngress' AND payload->>'resourceKey'='instance')
            OR (payload->>'action'='readSession' AND payload->>'resourceKey'='session')
            OR (payload->>'action'='discoverBindings' AND payload->>'resourceKey'='binding')
            OR (payload->>'action'='readOnboardingStatus' AND payload->>'resourceKey'='case')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:overview')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:ai_governance')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:cyber_security')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:it_optimisation')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:improvement_plan')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:evidence')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:board_reports')
            OR (payload->>'action'='readDashboardAdmission' AND payload->>'resourceKey'='module:services')
            OR (payload->>'action'='readDashboardBootstrap' AND payload->>'resourceKey'='bootstrap')
            OR (payload->>'action'='readDashboardAsset' AND payload->>'resourceKey'='asset:app.js')
            OR (payload->>'action'='readDashboardAsset' AND payload->>'resourceKey'='asset:dashboard.css')
            OR (payload->>'action'='readDashboardReadiness' AND payload->>'resourceKey'='readiness'))
          AND ((operation_id IS NOT NULL AND payload->>'action' IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','createCase','approveCase','revokeCase','denyCase','expireCase','acceptStagedOnboarding','publishExistingMembershipBinding','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress') AND payload->>'outcome'='succeeded')
            OR (operation_id IS NULL AND payload->>'action' IN ('readSession','discoverBindings','readOnboardingStatus','readDashboardAdmission','readDashboardBootstrap','readDashboardAsset','readDashboardReadiness'))))
        OR (event_type='dashboard.operation'
          AND jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt'] AND payload - ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt']='{}'::jsonb
          AND operation_id IS NULL AND tenant_id IS NOT NULL
          AND payload->>'tenantId'=tenant_id AND payload->>'organisationId'=organisation_id
          AND payload->>'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND jsonb_typeof(payload->'action')='string' AND jsonb_typeof(payload->'module')='string'
          AND payload->>'result' IN ('succeeded','denied','failed'))))
    IS TRUE);
    ALTER TABLE pg_temp.nf_dashboard_admin_lookup_contract
        ADD CONSTRAINT expected_type_predecessor CHECK (event_type IN ('dashboard.operation','dashboard.runtime'));
    ALTER TABLE pg_temp.nf_dashboard_admin_lookup_contract
        ADD CONSTRAINT expected_type_candidate CHECK (event_type IN ('dashboard.operation','dashboard.runtime','dashboard.admin.lookup'));
    SELECT pg_get_constraintdef(oid),pg_get_expr(conbin,conrelid)
        INTO baseline_payload,baseline_expression FROM pg_constraint
        WHERE conrelid='pg_temp.nf_dashboard_admin_lookup_contract'::regclass
          AND conname='expected_payload_predecessor';
    SELECT pg_get_constraintdef(oid) INTO baseline_type FROM pg_constraint
        WHERE conrelid='pg_temp.nf_dashboard_admin_lookup_contract'::regclass
          AND conname='expected_type_predecessor';
    SELECT pg_get_constraintdef(oid) INTO candidate_type FROM pg_constraint
        WHERE conrelid='pg_temp.nf_dashboard_admin_lookup_contract'::regclass
          AND conname='expected_type_candidate';

    lookup_expression := $lookup$(
        event_type='dashboard.admin.lookup'
        AND session_sha256 IS NOT NULL AND authority_id IS NULL AND operation_id IS NULL
        AND tenant_id IS NOT NULL AND organisation_id IS NOT NULL
        AND jsonb_typeof(payload)='object'
        AND payload ?& ARRAY['schemaVersion','eventType','eventId','requestId','lookupRequestId','occurredAt','actorSubjectKey','scope','category','targetSha256','phase','outcome']
        AND payload - ARRAY['schemaVersion','eventType','eventId','requestId','lookupRequestId','occurredAt','actorSubjectKey','scope','category','targetSha256','phase','outcome']='{}'::jsonb
        AND jsonb_typeof(payload->'schemaVersion')='number' AND payload->'schemaVersion'='1'::jsonb
        AND jsonb_typeof(payload->'eventType')='string' AND payload->>'eventType'=event_type
        AND jsonb_typeof(payload->'eventId')='string' AND payload->>'eventId'=event_id::text
        AND jsonb_typeof(payload->'requestId')='string' AND payload->>'requestId'=request_id::text
        AND jsonb_typeof(payload->'lookupRequestId')='string'
        AND payload->>'lookupRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(payload->'occurredAt')='string'
        AND payload->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND jsonb_typeof(payload->'actorSubjectKey')='string'
        AND payload->>'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(payload->'scope')='object'
        AND payload->'scope'=scope_json
        AND scope_json=jsonb_build_object('tenantId',tenant_id,'organisationId',organisation_id)
        AND jsonb_typeof(payload->'category')='string' AND payload->>'category'='dashboard_admin_read'
        AND jsonb_typeof(payload->'targetSha256')='string' AND payload->>'targetSha256' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(payload->'phase')='string' AND jsonb_typeof(payload->'outcome')='string'
        AND ((payload->>'phase'='attempt' AND payload->>'outcome'='attempt')
          OR (payload->>'phase'='terminal' AND payload->>'outcome' IN ('found','not_found','unavailable')))
    )$lookup$;
    EXECUTE format('ALTER TABLE pg_temp.nf_dashboard_admin_lookup_contract ADD CONSTRAINT expected_payload_candidate CHECK (((%s) OR (%s)) IS TRUE)',
        baseline_expression,lookup_expression);
    SELECT pg_get_constraintdef(oid) INTO candidate_payload FROM pg_constraint
        WHERE conrelid='pg_temp.nf_dashboard_admin_lookup_contract'::regclass
          AND conname='expected_payload_candidate';
    SELECT pg_get_constraintdef(oid) INTO installed_payload FROM pg_constraint
        WHERE conrelid='nofries.dashboard_runtime_audit'::regclass
          AND contype='c' AND conname='dashboard_audit_payload';
    SELECT count(*),min(c.conname),min(pg_get_constraintdef(c.oid))
        INTO type_matches,installed_type_name,installed_type FROM pg_constraint c
        WHERE c.conrelid='nofries.dashboard_runtime_audit'::regclass AND c.contype='c'
          AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute
              WHERE attrelid=c.conrelid AND attname='event_type')]::smallint[];
    IF installed_payload IS NULL OR installed_payload NOT IN (baseline_payload,candidate_payload)
        OR type_matches<>1 OR installed_type NOT IN (baseline_type,candidate_type)
        OR (installed_payload=baseline_payload) <> (installed_type=baseline_type)
    THEN RAISE EXCEPTION 'dashboard_admin_audit_constraint_drift'; END IF;

    CREATE UNIQUE INDEX nf_dashboard_admin_lookup_expected_phase
        ON pg_temp.nf_dashboard_admin_lookup_contract
        (instance_id, session_sha256, request_id,
         (payload->>'lookupRequestId'), (payload->>'phase'))
        WHERE event_type='dashboard.admin.lookup';
    expected_index := 'pg_temp.nf_dashboard_admin_lookup_expected_phase'::regclass;
    phase_index := to_regclass('nofries.dashboard_audit_admin_lookup_phase');
    IF phase_index IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_index actual JOIN pg_index expected ON expected.indexrelid=expected_index
        WHERE actual.indexrelid=phase_index AND actual.indrelid='nofries.dashboard_runtime_audit'::regclass
          AND actual.indisunique AND actual.indisvalid AND actual.indisready
          AND NOT actual.indnullsnotdistinct AND actual.indnkeyatts=5 AND actual.indnatts=5
          AND pg_get_expr(actual.indpred,actual.indrelid)=pg_get_expr(expected.indpred,expected.indrelid)
          AND ARRAY(SELECT pg_get_indexdef(actual.indexrelid,n,true) FROM generate_series(1,5) AS n)
            =ARRAY(SELECT pg_get_indexdef(expected.indexrelid,n,true) FROM generate_series(1,5) AS n)
    ) THEN RAISE EXCEPTION 'dashboard_admin_audit_index_drift'; END IF;
    IF installed_payload=candidate_payload AND phase_index IS NULL
    THEN RAISE EXCEPTION 'dashboard_admin_audit_index_missing'; END IF;
    IF installed_payload=baseline_payload AND phase_index IS NOT NULL
    THEN RAISE EXCEPTION 'dashboard_admin_audit_partial_schema'; END IF;

    IF installed_payload=baseline_payload THEN
        EXECUTE format('ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT %I',installed_type_name);
        ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_event_type
            CHECK (event_type IN ('dashboard.operation','dashboard.runtime','dashboard.admin.lookup'));
        ALTER TABLE nofries.dashboard_runtime_audit DROP CONSTRAINT dashboard_audit_payload;
        EXECUTE format('ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_payload CHECK (((%s) OR (%s)) IS TRUE)',
            baseline_expression,lookup_expression);
        CREATE UNIQUE INDEX dashboard_audit_admin_lookup_phase ON nofries.dashboard_runtime_audit
            (instance_id, session_sha256, request_id,
             (payload->>'lookupRequestId'), (payload->>'phase'))
            WHERE event_type='dashboard.admin.lookup';
    END IF;
    DROP TABLE pg_temp.nf_dashboard_admin_lookup_contract;
END
$proposal$;
