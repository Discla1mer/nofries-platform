-- Extend only the fixed runtime read-event pairs. Existing payload validation,
-- mutation events and dashboard.operation evidence keep their original predicate.
ALTER TABLE nofries.dashboard_runtime_audit
    DROP CONSTRAINT dashboard_audit_payload;

ALTER TABLE nofries.dashboard_runtime_audit
    ADD CONSTRAINT dashboard_audit_payload CHECK ((payload->'schemaVersion'='1'::jsonb
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
