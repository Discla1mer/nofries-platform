-- An optional, immutable choice made when the paid assessment starts.
-- Legacy starts and later revisions carry no source. No backfill or new grants.
ALTER TABLE nofries.dashboard_framework_revisions
    ADD COLUMN ncsc_assessment_id text,
    ADD COLUMN ncsc_revision integer,
    ADD COLUMN ncsc_revision_sha256 text,
    ADD COLUMN ncsc_scope_sha256 text,
    ADD CONSTRAINT paid_start_ncsc_complete CHECK (
        num_nonnulls(ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256, ncsc_scope_sha256) = 0 OR
        (num_nonnulls(ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256, ncsc_scope_sha256) = 4
         AND revision = 0 AND record#>>'{state,status}' = 'created'
         AND record#>'{state,responses}' = '[]'::jsonb AND record#>'{state,submission}' = 'null'::jsonb
         AND ncsc_scope_sha256 ~ '^[a-f0-9]{64}$') IS TRUE
    ),
    ADD CONSTRAINT paid_start_ncsc_revision FOREIGN KEY
        (tenant_id, organisation_id, ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
        (tenant_id, organisation_id, assessment_id, revision, payload_sha256);

-- Invoker rights and both owner keys also apply to the source read. The NCSC
-- scope digest covers its owner, assessment and capture, alongside the body.
CREATE FUNCTION nofries.check_paid_start_ncsc_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND
        ROW(OLD.ncsc_assessment_id, OLD.ncsc_revision, OLD.ncsc_revision_sha256, OLD.ncsc_scope_sha256)
        IS DISTINCT FROM ROW(NEW.ncsc_assessment_id, NEW.ncsc_revision, NEW.ncsc_revision_sha256, NEW.ncsc_scope_sha256)
    THEN
        RAISE EXCEPTION 'paid start source is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.ncsc_assessment_id IS NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM nofries.dashboard_ncsc_assessment_revisions AS source
        WHERE NEW.tenant_id = nullif(current_setting('nofries.tenant_id', true), '')
          AND NEW.organisation_id = nullif(current_setting('nofries.organisation_id', true), '')
          AND NEW.record#>>'{state,updatedBy}' = nullif(current_setting('nofries.subject_key', true), '')
          AND source.tenant_id = NEW.tenant_id AND source.organisation_id = NEW.organisation_id
          AND source.assessment_id = NEW.ncsc_assessment_id AND source.revision = NEW.ncsc_revision
          AND source.payload_sha256 = NEW.ncsc_revision_sha256
          AND source.payload#>>'{state,status}' = 'submitted'
          AND source.payload#>'{state,submission,revision}' = to_jsonb(source.revision)
          AND source.payload#>>'{submission,evaluation,outputSha256}' ~ '^[a-f0-9]{64}$'
          AND source.payload#>>'{state,scopePopulationSha256}' = NEW.ncsc_scope_sha256
          AND source.payload#>>'{scopePopulation,sha256}' = NEW.ncsc_scope_sha256
          AND source.payload#>>'{submission,input,scopePopulationSha256}' = NEW.ncsc_scope_sha256
          AND jsonb_typeof(NEW.record->'scopePopulation') = 'object'
          AND source.payload#>'{scopePopulation,body}' = NEW.record->'scopePopulation'
    ) THEN
        RAISE EXCEPTION 'paid start source unavailable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION nofries.check_paid_start_ncsc_scope() FROM PUBLIC;
CREATE TRIGGER paid_start_ncsc_scope
    BEFORE INSERT OR UPDATE ON nofries.dashboard_framework_revisions
    FOR EACH ROW
    EXECUTE FUNCTION nofries.check_paid_start_ncsc_scope();
