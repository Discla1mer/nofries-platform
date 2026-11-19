-- Held proposal on 0030. Application access to paid plans stays closed.
ALTER TABLE nofries.dashboard_framework_revisions
    ADD CONSTRAINT framework_revision_digest_key UNIQUE
        (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision, record_sha256);

ALTER TABLE nofries.dashboard_improvement_revisions
    ADD COLUMN paid_profile_id text,
    ADD COLUMN paid_profile_version text,
    ADD COLUMN paid_item_id text,
    ADD COLUMN ncsc_assessment_id text GENERATED ALWAYS AS
        (CASE WHEN paid_item_id IS NULL THEN assessment_id END) STORED,
    DROP CONSTRAINT dashboard_improvement_revisio_tenant_id_organisation_id_as_fkey,
    DROP CONSTRAINT dashboard_improvement_revisions_assessment_revision_check,
    ADD CONSTRAINT plan_ncsc_source FOREIGN KEY
        (tenant_id, organisation_id, ncsc_assessment_id, assessment_revision, assessment_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions
            (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    ADD CONSTRAINT plan_paid_source FOREIGN KEY
        (tenant_id, organisation_id, paid_profile_id, paid_profile_version, assessment_id, assessment_revision, assessment_sha256)
        REFERENCES nofries.dashboard_framework_revisions
            (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision, record_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    ADD CONSTRAINT plan_source_shape CHECK (
        (num_nonnulls(paid_profile_id, paid_profile_version, paid_item_id) = 0 AND assessment_revision BETWEEN 0 AND 128)
        OR (num_nonnulls(paid_profile_id, paid_profile_version, paid_item_id) = 3
            AND assessment_revision BETWEEN 1 AND 512 AND paid_item_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
            AND (revision > 0 OR (payload#>'{intent,command,payload}') = jsonb_build_object(
                'assessmentId', assessment_id, 'assessmentRevision', assessment_revision,
                'assessmentRevisionSha256', assessment_sha256, 'paidGap', jsonb_build_object(
                    'profileId', paid_profile_id, 'profileVersion', paid_profile_version, 'itemId', paid_item_id)
            ))));

-- Verify a real answer in the submitted source on generation. Later commands
-- must retain the same gap and assessment as the preceding plan revision.
CREATE FUNCTION nofries.check_plan_gap_source() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $guard$
DECLARE
    parent record;
    source jsonb;
    gap_options text[];
BEGIN
    IF NEW.revision > 0 THEN
        SELECT paid_profile_id, paid_profile_version, paid_item_id, assessment_id, assessment_revision, assessment_sha256
        INTO parent FROM nofries.dashboard_improvement_revisions
        WHERE (tenant_id, organisation_id, plan_id, revision, payload_sha256) =
              (NEW.tenant_id, NEW.organisation_id, NEW.plan_id, NEW.parent_revision, NEW.parent_sha256);
        IF NOT FOUND THEN
            RAISE EXCEPTION 'plan parent unavailable' USING ERRCODE = '23503';
        END IF;
        IF (NEW.paid_item_id IS NOT NULL OR parent.paid_item_id IS NOT NULL) AND
           (NEW.paid_profile_id, NEW.paid_profile_version, NEW.paid_item_id, NEW.assessment_id, NEW.assessment_revision, NEW.assessment_sha256)
           IS DISTINCT FROM
           (parent.paid_profile_id, parent.paid_profile_version, parent.paid_item_id, parent.assessment_id, parent.assessment_revision, parent.assessment_sha256) THEN
            RAISE EXCEPTION 'plan source changed' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.paid_item_id IS NOT NULL THEN
        SELECT record->'state' INTO source FROM nofries.dashboard_framework_revisions
        WHERE (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision, record_sha256) =
              (NEW.tenant_id, NEW.organisation_id, NEW.paid_profile_id, NEW.paid_profile_version, NEW.assessment_id, NEW.assessment_revision, NEW.assessment_sha256);
        gap_options := CASE
            WHEN (NEW.paid_profile_id, NEW.paid_profile_version) = ('nf-iso-27001-2022-readiness','2026-11-19.1')
                THEN ARRAY['not_started','partly_in_place']
            WHEN (NEW.paid_profile_id, NEW.paid_profile_version) = ('nf-nist-csf-2-0-core','2026-09-08.1')
                THEN ARRAY['no','partial','unknown','not_applicable']
        END;
        IF (source->>'status' = 'submitted' AND source#>'{submission,revision}' = to_jsonb(NEW.assessment_revision)
            AND source#>>'{submission,responseSetSha256}' ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof(source->'responses') = 'array' AND gap_options IS NOT NULL) IS NOT TRUE THEN
            RAISE EXCEPTION 'paid gap source unavailable' USING ERRCODE = '23514';
        END IF;
        IF NOT (SELECT count(*) = 1 AND bool_and(COALESCE(answer->>'optionId' = ANY(gap_options), false))
                FROM jsonb_array_elements(source->'responses') answer WHERE answer->>'itemId' = NEW.paid_item_id) THEN
            RAISE EXCEPTION 'paid gap answer unavailable' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NULL;
END
$guard$;
CREATE TRIGGER plan_gap_source AFTER INSERT ON nofries.dashboard_improvement_revisions
    FOR EACH ROW EXECUTE FUNCTION nofries.check_plan_gap_source();

-- The unchanged tenant policy still admits legacy plans. Only staff wipe and
-- the disposable owner fixture can operate on paid rows under this proposal.
CREATE POLICY plan_runtime_legacy ON nofries.dashboard_improvement_revisions AS RESTRICTIVE TO nofries_runtime
    USING (paid_item_id IS NULL) WITH CHECK (paid_item_id IS NULL);
CREATE POLICY plan_head_runtime_legacy ON nofries.dashboard_improvement_heads AS RESTRICTIVE TO nofries_runtime
    USING (EXISTS (SELECT 1 FROM nofries.dashboard_improvement_revisions r
        WHERE (r.tenant_id, r.organisation_id, r.plan_id, r.revision, r.payload_sha256) =
              (dashboard_improvement_heads.tenant_id, dashboard_improvement_heads.organisation_id,
               dashboard_improvement_heads.plan_id, dashboard_improvement_heads.revision, dashboard_improvement_heads.payload_sha256)));
