-- Dormant synthetic-verifiable metadata storage; no runtime selection or bytes.
CREATE TABLE nofries.dashboard_evidence_revisions (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    artefact_id text NOT NULL,
    revision integer NOT NULL CHECK (revision BETWEEN 0 AND 127),
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    parent_revision integer,
    parent_sha256 text,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, artefact_id, revision),
    UNIQUE (tenant_id, organisation_id, artefact_id, revision, payload_sha256),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_organisations
        (tenant_id, organisation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, organisation_id, artefact_id, parent_revision, parent_sha256)
        REFERENCES nofries.dashboard_evidence_revisions
        (tenant_id, organisation_id, artefact_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK ((revision = 0 AND parent_revision IS NULL AND parent_sha256 IS NULL)
        OR (revision > 0 AND parent_revision IS NOT NULL AND parent_revision = revision - 1
            AND parent_sha256 IS NOT NULL AND parent_sha256 ~ '^[a-f0-9]{64}$')),
    CHECK (length(artefact_id) BETWEEN 1 AND 180 AND artefact_id = btrim(artefact_id)
        AND artefact_id !~ '[[:cntrl:]]'),
    -- JSONB adds whitespace; canonical domain validation retains the 262144-byte
    -- public representation bound without imposing a smaller SQL-text boundary.
    CHECK (octet_length(payload::text) <= 2097152),
    CHECK ((jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','tenantId','organisationId','artefactId','revision','createdAt','createdBy','updatedAt','updatedBy','currentVersionId','versions']
        AND payload - ARRAY['schemaVersion','tenantId','organisationId','artefactId','revision','createdAt','createdBy','updatedAt','updatedBy','currentVersionId','versions'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND payload ->> 'tenantId' = tenant_id
        AND payload ->> 'organisationId' = organisation_id
        AND payload ->> 'artefactId' = artefact_id
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'versions') = 'array'
        AND jsonb_array_length(payload -> 'versions') = revision + 1) IS TRUE)
);
CREATE TABLE nofries.dashboard_evidence_heads (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    artefact_id text NOT NULL,
    revision integer NOT NULL,
    payload_sha256 text NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, artefact_id),
    FOREIGN KEY (tenant_id, organisation_id, artefact_id, revision, payload_sha256)
        REFERENCES nofries.dashboard_evidence_revisions
        (tenant_id, organisation_id, artefact_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE nofries.dashboard_evidence_receipts (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    artefact_id text NOT NULL,
    operation_id text NOT NULL,
    intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
    result_revision integer NOT NULL,
    version_sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, artefact_id, operation_id),
    UNIQUE (tenant_id, organisation_id, artefact_id, result_revision),
    FOREIGN KEY (tenant_id, organisation_id, artefact_id, result_revision, version_sha256)
        REFERENCES nofries.dashboard_evidence_revisions
        (tenant_id, organisation_id, artefact_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (length(operation_id) BETWEEN 1 AND 180 AND operation_id = btrim(operation_id)
        AND operation_id !~ '[[:cntrl:]]'),
    CHECK (octet_length(payload::text) <= 2097152),
    CHECK ((jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','command','event']
        AND payload - ARRAY['schemaVersion','command','event'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND jsonb_typeof(payload -> 'command') = 'object'
        AND payload -> 'command' ->> 'tenantId' = tenant_id
        AND payload -> 'command' ->> 'organisationId' = organisation_id
        AND payload -> 'command' ->> 'artefactId' = artefact_id
        AND payload -> 'command' ->> 'idempotencyKey' = operation_id
        AND jsonb_typeof(payload -> 'event') = 'object') IS TRUE)
);

ALTER TABLE nofries.dashboard_evidence_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_evidence_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_evidence_revisions_tenant ON nofries.dashboard_evidence_revisions
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_evidence_revisions FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_evidence_revisions TO nofries_runtime;

ALTER TABLE nofries.dashboard_evidence_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_evidence_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_evidence_heads_tenant ON nofries.dashboard_evidence_heads
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_evidence_heads FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT, UPDATE ON nofries.dashboard_evidence_heads TO nofries_runtime;

ALTER TABLE nofries.dashboard_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_evidence_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_evidence_receipts_tenant ON nofries.dashboard_evidence_receipts
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
REVOKE ALL ON nofries.dashboard_evidence_receipts FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_evidence_receipts TO nofries_runtime;
