-- Additive canonical NCSC storage. No legacy migration, live selection or cutover.
-- The migration runner supplies transactionality and checksum idempotence.
CREATE TABLE nofries.dashboard_ncsc_assessment_revisions (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    assessment_id text NOT NULL,
    revision integer NOT NULL,
    schema_version integer NOT NULL,
    payload_sha256 text NOT NULL,
    parent_revision integer,
    parent_sha256 text,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, assessment_id, revision),
    UNIQUE (tenant_id, organisation_id, assessment_id, revision, payload_sha256),
    FOREIGN KEY (tenant_id, organisation_id)
        REFERENCES nofries.dashboard_organisations (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, organisation_id, assessment_id, parent_revision, parent_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
            (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND organisation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND assessment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
    CHECK (schema_version = 1 AND revision BETWEEN 0 AND 128),
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK ((revision = 0 AND parent_revision IS NULL AND parent_sha256 IS NULL)
        OR (revision > 0 AND parent_revision IS NOT NULL
            AND parent_revision = revision - 1 AND parent_sha256 IS NOT NULL
            AND parent_sha256 ~ '^[a-f0-9]{64}$')),
    CHECK (octet_length(payload::text) <= 262144),
    CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','tenantId','organisationId','assessmentId','revision','state','scopePopulation','rationales','evidence','risk','submission']
        AND payload - ARRAY['schemaVersion','tenantId','organisationId','assessmentId','revision','state','scopePopulation','rationales','evidence','risk','submission'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND payload ->> 'tenantId' = tenant_id
        AND payload ->> 'organisationId' = organisation_id
        AND payload ->> 'assessmentId' = assessment_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'state') = 'object'
        AND payload -> 'state' ->> 'tenantId' = tenant_id
        AND payload -> 'state' ->> 'organisationId' = organisation_id
        AND payload -> 'state' ->> 'assessmentId' = assessment_id
        AND payload -> 'state' -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'rationales') = 'array'
    ) IS TRUE)
);

CREATE TABLE nofries.dashboard_ncsc_assessments (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    assessment_id text NOT NULL,
    schema_version integer NOT NULL,
    revision integer NOT NULL,
    payload_sha256 text NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, assessment_id),
    FOREIGN KEY (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
            (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (schema_version = 1 AND revision BETWEEN 0 AND 128),
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE nofries.dashboard_ncsc_assessment_receipts (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    assessment_id text NOT NULL,
    idempotency_key text NOT NULL,
    schema_version integer NOT NULL,
    intent_sha256 text NOT NULL,
    result_sha256 text NOT NULL,
    result_revision integer NOT NULL,
    version_sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, assessment_id, idempotency_key),
    FOREIGN KEY (tenant_id, organisation_id, assessment_id, result_revision, version_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
            (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (schema_version = 1 AND result_revision BETWEEN 0 AND 128),
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
    CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'
        AND result_sha256 ~ '^[a-f0-9]{64}$' AND version_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (octet_length(payload::text) <= 1048576),
    CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload -> 'schemaVersion' = to_jsonb(schema_version)
        AND payload ->> 'tenantId' = tenant_id
        AND payload ->> 'organisationId' = organisation_id
        AND payload ->> 'assessmentId' = assessment_id
        AND payload ->> 'idempotencyKey' = idempotency_key
        AND payload ->> 'intentSha256' = intent_sha256
        AND payload ->> 'resultSha256' = result_sha256
        AND payload -> 'resultRevision' = to_jsonb(result_revision)
        AND payload ->> 'versionSha256' = version_sha256
        AND jsonb_typeof(payload -> 'event') = 'object'
        AND payload -> 'event' ->> 'tenantId' = tenant_id
        AND payload -> 'event' ->> 'organisationId' = organisation_id
    ) IS TRUE)
);

ALTER TABLE nofries.dashboard_ncsc_assessment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_ncsc_assessment_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_ncsc_assessment_revisions_tenant ON nofries.dashboard_ncsc_assessment_revisions
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_ncsc_assessment_revisions FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT
    ON nofries.dashboard_ncsc_assessment_revisions TO nofries_runtime;

ALTER TABLE nofries.dashboard_ncsc_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_ncsc_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_ncsc_assessments_tenant ON nofries.dashboard_ncsc_assessments
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_ncsc_assessments FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT, UPDATE
    ON nofries.dashboard_ncsc_assessments TO nofries_runtime;

ALTER TABLE nofries.dashboard_ncsc_assessment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_ncsc_assessment_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_ncsc_assessment_receipts_tenant ON nofries.dashboard_ncsc_assessment_receipts
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_ncsc_assessment_receipts FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT
    ON nofries.dashboard_ncsc_assessment_receipts TO nofries_runtime;

