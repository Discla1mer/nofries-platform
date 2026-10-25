-- Canonical dashboard identity is independent of the legacy service-desk and
-- lifecycle tenant keys. No identity is inferred, migrated or dual-written here.
-- The migration runner owns transactionality, ordering and checksum idempotence.

CREATE TABLE IF NOT EXISTS nofries.dashboard_tenants (
    tenant_id text PRIMARY KEY,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT dashboard_tenants_identifier CHECK (
        length(tenant_id) BETWEEN 1 AND 180 AND tenant_id = btrim(tenant_id)
        AND tenant_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT dashboard_tenants_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_tenants_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_tenants_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'displayName', 'recordStatus', 'revision']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'displayName', 'recordStatus', 'revision'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'displayName') = 'string'
        AND length(btrim(payload ->> 'displayName')) > 0
        AND jsonb_typeof(payload -> 'recordStatus') = 'string'
        AND payload ->> 'recordStatus' IN ('active', 'suspended', 'closed')
        AND payload -> 'revision' = to_jsonb(revision)
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_organisations (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id),
    CONSTRAINT dashboard_organisations_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES nofries.dashboard_tenants (tenant_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_organisations_identifier CHECK (
        length(organisation_id) BETWEEN 1 AND 180 AND organisation_id = btrim(organisation_id)
        AND organisation_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT dashboard_organisations_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_organisations_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_organisations_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'organisationId', 'displayName', 'domains', 'recordStatus', 'revision']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'organisationId', 'displayName', 'domains', 'recordStatus', 'revision'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND jsonb_typeof(payload -> 'displayName') = 'string'
        AND length(btrim(payload ->> 'displayName')) > 0
        AND jsonb_typeof(payload -> 'domains') = 'array'
        AND jsonb_typeof(payload -> 'recordStatus') = 'string'
        AND payload ->> 'recordStatus' IN ('active', 'suspended', 'closed')
        AND payload -> 'revision' = to_jsonb(revision)
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_membership_states (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id),
    CONSTRAINT dashboard_membership_states_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_membership_states_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_membership_states_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_membership_states_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'organisationId', 'revision', 'updatedAt', 'invitations', 'memberships']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'organisationId', 'revision', 'updatedAt', 'invitations', 'memberships'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'updatedAt') = 'string'
        AND payload ->> 'updatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND jsonb_typeof(payload -> 'invitations') = 'array'
        AND jsonb_typeof(payload -> 'memberships') = 'array'
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_entitlement_states (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id),
    CONSTRAINT dashboard_entitlement_states_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_entitlement_states_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_entitlement_states_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_entitlement_states_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'organisationId', 'revision', 'grants']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'organisationId', 'revision', 'grants'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'grants') = 'array'
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_feature_flags (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id),
    CONSTRAINT dashboard_feature_flags_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_feature_flags_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_feature_flags_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    -- Flags use their existing POR-004 shape, which has no schemaVersion field.
    CONSTRAINT dashboard_feature_flags_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['tenantId', 'organisationId', 'revision', 'enabled', 'frameworks']
        AND payload - ARRAY['tenantId', 'organisationId', 'revision', 'enabled', 'frameworks'] = '{}'::jsonb
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'enabled') = 'object'
        AND jsonb_typeof(payload -> 'frameworks') = 'array'
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_advisor_assignments (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    assignment_id text NOT NULL,
    subject_key text NOT NULL,
    membership_id text NOT NULL,
    status text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, assignment_id),
    CONSTRAINT dashboard_advisor_assignments_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_advisor_assignments_identifiers CHECK (
        length(assignment_id) BETWEEN 1 AND 180 AND assignment_id = btrim(assignment_id)
        AND assignment_id !~ '[[:cntrl:]]'
        AND length(membership_id) BETWEEN 1 AND 180 AND membership_id = btrim(membership_id)
        AND membership_id !~ '[[:cntrl:]]'
        AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    CONSTRAINT dashboard_advisor_assignments_status CHECK (status IN ('active', 'revoked')),
    CONSTRAINT dashboard_advisor_assignments_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_advisor_assignments_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_advisor_assignments_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'assignmentId', 'tenantId', 'organisationId', 'membershipId', 'subjectKey', 'status', 'validFrom', 'validUntil', 'modules', 'permissions', 'grantEvidenceId', 'revision', 'updatedAt']
        AND payload - ARRAY['schemaVersion', 'assignmentId', 'tenantId', 'organisationId', 'membershipId', 'subjectKey', 'status', 'validFrom', 'validUntil', 'modules', 'permissions', 'grantEvidenceId', 'revision', 'updatedAt'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND jsonb_typeof(payload -> 'assignmentId') = 'string'
        AND payload ->> 'assignmentId' = assignment_id
        AND jsonb_typeof(payload -> 'subjectKey') = 'string'
        AND payload ->> 'subjectKey' = subject_key
        AND jsonb_typeof(payload -> 'membershipId') = 'string'
        AND payload ->> 'membershipId' = membership_id
        AND jsonb_typeof(payload -> 'status') = 'string'
        AND payload ->> 'status' = status
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'validFrom') = 'string'
        AND jsonb_typeof(payload -> 'validUntil') = 'string'
        AND jsonb_typeof(payload -> 'updatedAt') = 'string'
        AND jsonb_typeof(payload -> 'modules') = 'array'
        AND jsonb_typeof(payload -> 'permissions') = 'array'
        AND jsonb_typeof(payload -> 'grantEvidenceId') = 'string'
        AND length(btrim(payload ->> 'grantEvidenceId')) > 0
    ) IS TRUE)
);

CREATE INDEX IF NOT EXISTS dashboard_advisor_assignments_subject_idx
    ON nofries.dashboard_advisor_assignments
        (tenant_id, organisation_id, subject_key, membership_id, status);

CREATE TABLE IF NOT EXISTS nofries.dashboard_usage (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    grant_id text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, grant_id),
    CONSTRAINT dashboard_usage_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_usage_identifier CHECK (
        length(grant_id) BETWEEN 1 AND 180 AND grant_id = btrim(grant_id)
        AND grant_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT dashboard_usage_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_usage_revision CHECK (revision BETWEEN 0 AND 9007199254740991),
    CONSTRAINT dashboard_usage_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'organisationId', 'grantId', 'revision', 'counters']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'organisationId', 'grantId', 'revision', 'counters'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND jsonb_typeof(payload -> 'grantId') = 'string'
        AND payload ->> 'grantId' = grant_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'counters') = 'object'
        AND (payload -> 'counters') - ARRAY['assessment_runs', 'report_exports', 'evidence_bytes', 'memberships', 'ai_requests'] = '{}'::jsonb
    ) IS TRUE),
    -- Missing counters remain missing; only explicit counters may be consumed.
    CONSTRAINT dashboard_usage_assessment_runs CHECK ((
        NOT (payload -> 'counters' ? 'assessment_runs') OR (
            jsonb_typeof(payload -> 'counters' -> 'assessment_runs') = 'number'
            AND payload -> 'counters' ->> 'assessment_runs' ~ '^[0-9]+$'
            AND (payload -> 'counters' ->> 'assessment_runs')::numeric BETWEEN 0 AND 9007199254740991
        )
    ) IS TRUE),
    CONSTRAINT dashboard_usage_report_exports CHECK ((
        NOT (payload -> 'counters' ? 'report_exports') OR (
            jsonb_typeof(payload -> 'counters' -> 'report_exports') = 'number'
            AND payload -> 'counters' ->> 'report_exports' ~ '^[0-9]+$'
            AND (payload -> 'counters' ->> 'report_exports')::numeric BETWEEN 0 AND 9007199254740991
        )
    ) IS TRUE),
    CONSTRAINT dashboard_usage_evidence_bytes CHECK ((
        NOT (payload -> 'counters' ? 'evidence_bytes') OR (
            jsonb_typeof(payload -> 'counters' -> 'evidence_bytes') = 'number'
            AND payload -> 'counters' ->> 'evidence_bytes' ~ '^[0-9]+$'
            AND (payload -> 'counters' ->> 'evidence_bytes')::numeric BETWEEN 0 AND 9007199254740991
        )
    ) IS TRUE),
    CONSTRAINT dashboard_usage_memberships CHECK ((
        NOT (payload -> 'counters' ? 'memberships') OR (
            jsonb_typeof(payload -> 'counters' -> 'memberships') = 'number'
            AND payload -> 'counters' ->> 'memberships' ~ '^[0-9]+$'
            AND (payload -> 'counters' ->> 'memberships')::numeric BETWEEN 0 AND 9007199254740991
        )
    ) IS TRUE),
    CONSTRAINT dashboard_usage_ai_requests CHECK ((
        NOT (payload -> 'counters' ? 'ai_requests') OR (
            jsonb_typeof(payload -> 'counters' -> 'ai_requests') = 'number'
            AND payload -> 'counters' ->> 'ai_requests' ~ '^[0-9]+$'
            AND (payload -> 'counters' ->> 'ai_requests')::numeric BETWEEN 0 AND 9007199254740991
        )
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS nofries.dashboard_operation_receipts (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    operation_id text NOT NULL,
    schema_version integer NOT NULL,
    intent_sha256 text NOT NULL,
    result_sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, operation_id),
    CONSTRAINT dashboard_operation_receipts_organisation_fk FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT dashboard_operation_receipts_identifier CHECK (
        length(operation_id) BETWEEN 1 AND 180 AND operation_id = btrim(operation_id)
        AND operation_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT dashboard_operation_receipts_schema CHECK (schema_version = 1),
    CONSTRAINT dashboard_operation_receipts_hashes CHECK (
        intent_sha256 ~ '^[0-9a-f]{64}$' AND result_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT dashboard_operation_receipts_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion', 'tenantId', 'organisationId', 'operationId', 'actorSubjectKey', 'operationType', 'intentSha256', 'resultSha256', 'occurredAt', 'expectedRevisions', 'resultRevisions', 'result', 'event']
        AND payload - ARRAY['schemaVersion', 'tenantId', 'organisationId', 'operationId', 'actorSubjectKey', 'operationType', 'intentSha256', 'resultSha256', 'occurredAt', 'expectedRevisions', 'resultRevisions', 'result', 'event'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND jsonb_typeof(payload -> 'tenantId') = 'string'
        AND payload ->> 'tenantId' = tenant_id
        AND jsonb_typeof(payload -> 'organisationId') = 'string'
        AND payload ->> 'organisationId' = organisation_id
        AND jsonb_typeof(payload -> 'operationId') = 'string'
        AND payload ->> 'operationId' = operation_id
        AND jsonb_typeof(payload -> 'actorSubjectKey') = 'string'
        AND payload ->> 'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(payload -> 'operationType') = 'string'
        AND length(btrim(payload ->> 'operationType')) > 0
        AND jsonb_typeof(payload -> 'intentSha256') = 'string'
        AND payload ->> 'intentSha256' = intent_sha256
        AND jsonb_typeof(payload -> 'resultSha256') = 'string'
        AND payload ->> 'resultSha256' = result_sha256
        AND jsonb_typeof(payload -> 'occurredAt') = 'string'
        AND payload ->> 'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND jsonb_typeof(payload -> 'expectedRevisions') = 'object'
        AND jsonb_typeof(payload -> 'resultRevisions') = 'object'
        AND jsonb_typeof(payload -> 'result') = 'object'
        AND jsonb_typeof(payload -> 'event') = 'object'
    ) IS TRUE)
);

ALTER TABLE nofries.dashboard_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_organisations FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_membership_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_membership_states FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_entitlement_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_entitlement_states FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_advisor_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_advisor_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_operation_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY dashboard_tenants_tenant_isolation ON nofries.dashboard_tenants
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_organisations_tenant_isolation ON nofries.dashboard_organisations
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_membership_states_tenant_isolation ON nofries.dashboard_membership_states
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_entitlement_states_tenant_isolation ON nofries.dashboard_entitlement_states
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_feature_flags_tenant_isolation ON nofries.dashboard_feature_flags
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_advisor_assignments_tenant_isolation ON nofries.dashboard_advisor_assignments
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_usage_tenant_isolation ON nofries.dashboard_usage
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_operation_receipts_tenant_select ON nofries.dashboard_operation_receipts
    FOR SELECT TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
CREATE POLICY dashboard_operation_receipts_tenant_insert ON nofries.dashboard_operation_receipts
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));

-- Scope every grant/revoke to these new tables. Runtime cannot delete or truncate
-- historical receipts or their owner records, and cannot rewrite any receipt.
REVOKE ALL ON
    nofries.dashboard_tenants,
    nofries.dashboard_organisations,
    nofries.dashboard_membership_states,
    nofries.dashboard_entitlement_states,
    nofries.dashboard_feature_flags,
    nofries.dashboard_advisor_assignments,
    nofries.dashboard_usage,
    nofries.dashboard_operation_receipts
FROM PUBLIC, nofries_runtime;

GRANT SELECT, INSERT, UPDATE ON
    nofries.dashboard_tenants,
    nofries.dashboard_organisations,
    nofries.dashboard_membership_states,
    nofries.dashboard_entitlement_states,
    nofries.dashboard_feature_flags,
    nofries.dashboard_advisor_assignments,
    nofries.dashboard_usage
TO nofries_runtime;

GRANT SELECT, INSERT ON nofries.dashboard_operation_receipts TO nofries_runtime;
