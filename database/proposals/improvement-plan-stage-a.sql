-- REVIEW CANDIDATE ONLY: deliberately outside database/migrations.
-- Apply only to an explicitly disposable synthetic database for source tests.
-- Production promotion, migration numbering, runtime admission and recovery
-- remain separate release-owner review; this file activates no route or feature.
CREATE TABLE nofries.dashboard_improvement_revisions (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    plan_id text NOT NULL,
    revision integer NOT NULL CHECK (revision BETWEEN 0 AND 1024),
    operation_id text NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    parent_revision integer,
    parent_sha256 text,
    assessment_id text NOT NULL,
    assessment_revision integer NOT NULL CHECK (assessment_revision BETWEEN 0 AND 128),
    assessment_sha256 text NOT NULL CHECK (assessment_sha256 ~ '^[a-f0-9]{64}$'),
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, plan_id, revision),
    UNIQUE (tenant_id, organisation_id, plan_id, operation_id),
    UNIQUE (tenant_id, organisation_id, plan_id, revision, payload_sha256),
    FOREIGN KEY (tenant_id, organisation_id, assessment_id, assessment_revision, assessment_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
            (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, organisation_id, plan_id, parent_revision, parent_sha256)
        REFERENCES nofries.dashboard_improvement_revisions
            (tenant_id, organisation_id, plan_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND organisation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND assessment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
    CHECK ((revision = 0 AND parent_revision IS NULL AND parent_sha256 IS NULL)
        OR (revision > 0 AND parent_revision IS NOT NULL AND parent_revision = revision - 1
            AND parent_sha256 IS NOT NULL AND parent_sha256 ~ '^[a-f0-9]{64}$')),
    CHECK (octet_length(payload::text) <= 32768),
    CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','intent','at','source','command','resultSha256']
        AND payload - ARRAY['schemaVersion','intent','at','source','command','resultSha256'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND jsonb_typeof(payload -> 'intent') = 'object'
        AND payload -> 'intent' ?& ARRAY['tenantId','organisationId','actorSubjectKey','command']
        AND (payload -> 'intent') - ARRAY['tenantId','organisationId','actorSubjectKey','command'] = '{}'::jsonb
        AND payload -> 'intent' ->> 'tenantId' = tenant_id
        AND payload -> 'intent' ->> 'organisationId' = organisation_id
        AND payload -> 'intent' ->> 'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(payload -> 'intent' -> 'command') = 'object'
        AND payload -> 'intent' -> 'command' ?& ARRAY['planId','type','operationId','expectedRevision','actionId','payload']
        AND (payload -> 'intent' -> 'command') - ARRAY['planId','type','operationId','expectedRevision','actionId','payload'] = '{}'::jsonb
        AND payload -> 'intent' -> 'command' ->> 'planId' = plan_id
        AND payload -> 'intent' -> 'command' ->> 'operationId' = operation_id
        AND jsonb_typeof(payload -> 'intent' -> 'command' -> 'payload') = 'object'
        AND payload ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        AND jsonb_typeof(payload -> 'source') = 'object'
        AND payload -> 'source' ?& ARRAY['assessmentId','revision','revisionSha256']
        AND (payload -> 'source') - ARRAY['assessmentId','revision','revisionSha256'] = '{}'::jsonb
        AND payload -> 'source' ->> 'assessmentId' = assessment_id
        AND payload -> 'source' -> 'revision' = to_jsonb(assessment_revision)
        AND payload -> 'source' ->> 'revisionSha256' = assessment_sha256
        AND payload ->> 'resultSha256' ~ '^[a-f0-9]{64}$'
        AND ((revision = 0
                AND payload -> 'intent' -> 'command' ->> 'type' = 'generate'
                AND payload -> 'intent' -> 'command' -> 'expectedRevision' = 'null'::jsonb
                AND payload -> 'intent' -> 'command' -> 'actionId' = 'null'::jsonb
                AND payload -> 'command' = 'null'::jsonb)
            OR (revision > 0
                AND payload -> 'intent' -> 'command' ->> 'type' IN ('assign','start','block','complete','reopen')
                AND payload -> 'intent' -> 'command' -> 'expectedRevision' = to_jsonb(revision - 1)
                AND jsonb_typeof(payload -> 'intent' -> 'command' -> 'actionId') = 'string'
                AND jsonb_typeof(payload -> 'command') = 'object'
                AND payload -> 'command' ->> 'tenantId' = tenant_id
                AND payload -> 'command' ->> 'organisationId' = organisation_id
                AND payload -> 'command' ->> 'planId' = plan_id
                AND payload -> 'command' ->> 'operationId' = operation_id
                AND payload -> 'command' -> 'expectedRevision' = to_jsonb(revision - 1)
                AND payload -> 'command' ->> 'actorSubjectKey' = payload -> 'intent' ->> 'actorSubjectKey'
                AND payload -> 'command' ->> 'at' = payload ->> 'at'
                AND payload -> 'command' ->> 'type' = payload -> 'intent' -> 'command' ->> 'type'
                AND payload -> 'command' ->> 'actionId' = payload -> 'intent' -> 'command' ->> 'actionId'
                AND payload -> 'command' -> 'payload' = payload -> 'intent' -> 'command' -> 'payload'))
    ) IS TRUE)
);

CREATE TABLE nofries.dashboard_improvement_heads (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    plan_id text NOT NULL,
    revision integer NOT NULL,
    payload_sha256 text NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, plan_id),
    FOREIGN KEY (tenant_id, organisation_id, plan_id, revision, payload_sha256)
        REFERENCES nofries.dashboard_improvement_revisions
            (tenant_id, organisation_id, plan_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

ALTER TABLE nofries.dashboard_improvement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_improvement_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_improvement_revisions_tenant ON nofries.dashboard_improvement_revisions
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_improvement_revisions FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_improvement_revisions TO nofries_runtime;

ALTER TABLE nofries.dashboard_improvement_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_improvement_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_improvement_heads_tenant ON nofries.dashboard_improvement_heads
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_improvement_heads FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT, UPDATE ON nofries.dashboard_improvement_heads TO nofries_runtime;
