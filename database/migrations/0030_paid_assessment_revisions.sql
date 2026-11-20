-- Each append is both a sealed revision and the receipt for one idempotent command.
-- Account reset/delete removes the scoped revision history under the existing wipe lock.
CREATE TABLE nofries.dashboard_framework_revisions (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    profile_id text NOT NULL,
    profile_version text NOT NULL,
    assessment_id text NOT NULL,
    revision integer NOT NULL CHECK (revision BETWEEN 0 AND 512),
    idempotency_key text NOT NULL,
    intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
    record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
    record jsonb NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision),
    UNIQUE (tenant_id, organisation_id, profile_id, profile_version, assessment_id, idempotency_key),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_organisations,
    CHECK (profile_id ~ '^[a-z0-9][a-z0-9._-]{0,119}$'
        AND profile_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
        AND assessment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
    CHECK ((jsonb_typeof(record) = 'object' AND octet_length(record::text) <= 1048576
        AND record#>>'{state,tenantId}' = tenant_id AND record#>>'{state,organisationId}' = organisation_id
        AND record#>>'{state,assessmentId}' = assessment_id AND record#>'{state,revision}' = to_jsonb(revision)
        AND record#>>'{state,moduleId}' = 'cyber_security'
        AND record#>>'{state,profileRef,profileId}' = profile_id
        AND record#>>'{state,profileRef,profileVersion}' = profile_version) IS TRUE)
);

ALTER TABLE nofries.dashboard_framework_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_framework_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY framework_runtime_scope ON nofries.dashboard_framework_revisions TO nofries_runtime
    USING (tenant_id = nullif(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = nullif(current_setting('nofries.organisation_id', true), ''))
    WITH CHECK (tenant_id = nullif(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = nullif(current_setting('nofries.organisation_id', true), '')
        AND record#>>'{state,updatedBy}' = nullif(current_setting('nofries.subject_key', true), ''));
CREATE POLICY framework_wipe_scope ON nofries.dashboard_framework_revisions TO nofries_account_wipe
    USING (tenant_id = nullif(current_setting('nofries.wipe_tenant_id', true), '')) WITH CHECK (false);
REVOKE ALL ON nofries.dashboard_framework_revisions FROM PUBLIC, nofries_runtime, nofries_account_wipe;
GRANT SELECT, INSERT ON nofries.dashboard_framework_revisions TO nofries_runtime;
GRANT SELECT, DELETE ON nofries.dashboard_framework_revisions TO nofries_account_wipe;
