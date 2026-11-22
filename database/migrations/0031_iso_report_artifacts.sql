-- Held proposal (a), dependent on 0030. No issuer, customer reader or export grant.
CREATE TABLE nofries.dashboard_iso_report_artifacts (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    report_id uuid NOT NULL,
    profile_id text NOT NULL CHECK (profile_id = 'nf-iso-27001-2022-readiness'),
    profile_version text NOT NULL CHECK (profile_version = '2026-11-19.1'),
    assessment_id text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    source_record_sha256 text NOT NULL CHECK (source_record_sha256 ~ '^[a-f0-9]{64}$'),
    response_set_sha256 text NOT NULL CHECK (response_set_sha256 ~ '^[a-f0-9]{64}$'),
    output_kind text NOT NULL CHECK (output_kind IN ('iso_board_summary','iso_statement_of_applicability')),
    content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 4194304 AND content IS JSON OBJECT WITH UNIQUE KEYS),
    output_sha256 text NOT NULL CHECK (output_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
    maker_subject text NOT NULL CHECK (maker_subject ~ '^[a-z0-9._-]{1,180}:[a-z0-9._-]{1,180}$'),
    maker_email_sha256 text CHECK (maker_email_sha256 ~ '^[a-f0-9]{64}$'),
    prepared_at timestamptz NOT NULL CHECK (isfinite(prepared_at)),
    PRIMARY KEY (tenant_id, organisation_id, report_id),
    UNIQUE (tenant_id, organisation_id, report_id, output_sha256),
    FOREIGN KEY (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision)
        REFERENCES nofries.dashboard_framework_revisions,
    CHECK ((content::jsonb -> 'formatVersion' = '1'::jsonb AND content::jsonb ->> 'outputKind' = output_kind
        AND jsonb_typeof(content::jsonb -> 'blocks') = 'array'
        AND content::jsonb - ARRAY['formatVersion','outputKind','blocks'] = '{}'::jsonb) IS TRUE)
);

CREATE TABLE nofries.dashboard_iso_report_decisions (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    report_id uuid NOT NULL,
    output_sha256 text NOT NULL,
    stage text NOT NULL CHECK (stage IN ('approved','issued')),
    predecessor text GENERATED ALWAYS AS (CASE WHEN stage = 'issued' THEN 'approved' END) STORED,
    actor_subject text NOT NULL CHECK (actor_subject ~ '^[a-z0-9._-]{1,180}:[a-z0-9._-]{1,180}$'),
    actor_email_sha256 text CHECK (actor_email_sha256 ~ '^[a-f0-9]{64}$'),
    decided_at timestamptz NOT NULL CHECK (isfinite(decided_at)),
    PRIMARY KEY (tenant_id, organisation_id, report_id, stage),
    FOREIGN KEY (tenant_id, organisation_id, report_id, output_sha256)
        REFERENCES nofries.dashboard_iso_report_artifacts (tenant_id, organisation_id, report_id, output_sha256),
    FOREIGN KEY (tenant_id, organisation_id, report_id, predecessor)
        REFERENCES nofries.dashboard_iso_report_decisions (tenant_id, organisation_id, report_id, stage)
);

-- Use the caller's scoped visibility. No SECURITY DEFINER or public function capability.
CREATE FUNCTION nofries.check_iso_report_artifact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' OR NOT EXISTS (
        SELECT 1 FROM nofries.dashboard_framework_revisions s
        WHERE (s.tenant_id, s.organisation_id, s.profile_id, s.profile_version, s.assessment_id, s.revision) =
              (NEW.tenant_id, NEW.organisation_id, NEW.profile_id, NEW.profile_version, NEW.assessment_id, NEW.revision)
          AND s.record_sha256 = NEW.source_record_sha256
          AND s.record #>> '{state,status}' = 'submitted'
          AND s.record #> '{state,submission,revision}' = to_jsonb(s.revision)
          AND s.record #>> '{state,submission,responseSetSha256}' = NEW.response_set_sha256
          AND isfinite((s.record #>> '{state,submission,submittedAt}')::timestamptz)
          AND (s.record #>> '{state,submission,submittedAt}')::timestamptz <= NEW.prepared_at
          AND s.record #>> '{state,profileRef,frameworkId}' = 'iso-iec-27001'
          AND s.record #>> '{state,profileRef,frameworkVersion}' = '2022'
          AND s.record #>> '{state,profileRef,catalogueSha256}' = '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d'
          AND s.record #>> '{state,profileRef,sourceCatalogueSha256}' = '66ce68bdf0d8ea2d271c52f68d6505b7a50f69f8d8d5ce40bcf833320caef1fd'
    ) THEN RAISE EXCEPTION 'invalid ISO report source or mutation' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION nofries.check_iso_report_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' OR NOT EXISTS (
        SELECT 1 FROM nofries.dashboard_iso_report_artifacts a
        WHERE (a.tenant_id, a.organisation_id, a.report_id, a.output_sha256) =
              (NEW.tenant_id, NEW.organisation_id, NEW.report_id, NEW.output_sha256)
          AND a.prepared_at <= NEW.decided_at AND a.maker_subject <> NEW.actor_subject
          AND (a.maker_email_sha256 = NEW.actor_email_sha256) IS NOT TRUE
    ) THEN RAISE EXCEPTION 'invalid ISO report decision' USING ERRCODE = '23514'; END IF;
    IF NEW.stage = 'issued' AND NOT EXISTS (
        SELECT 1 FROM nofries.dashboard_iso_report_decisions d
        WHERE (d.tenant_id, d.organisation_id, d.report_id, d.stage) =
              (NEW.tenant_id, NEW.organisation_id, NEW.report_id, 'approved')
          AND d.decided_at <= NEW.decided_at AND d.actor_subject <> NEW.actor_subject
          AND (d.actor_email_sha256 = NEW.actor_email_sha256) IS NOT TRUE
    ) THEN RAISE EXCEPTION 'independent ISO report approval required' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER check_iso_report_artifact BEFORE INSERT OR UPDATE ON nofries.dashboard_iso_report_artifacts
    FOR EACH ROW EXECUTE FUNCTION nofries.check_iso_report_artifact();
CREATE TRIGGER check_iso_report_decision BEFORE INSERT OR UPDATE ON nofries.dashboard_iso_report_decisions
    FOR EACH ROW EXECUTE FUNCTION nofries.check_iso_report_decision();
REVOKE ALL ON FUNCTION nofries.check_iso_report_artifact(), nofries.check_iso_report_decision() FROM PUBLIC;

ALTER TABLE nofries.dashboard_iso_report_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_iso_report_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_iso_report_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_iso_report_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY iso_report_artifact_wipe ON nofries.dashboard_iso_report_artifacts TO nofries_account_wipe
    USING (tenant_id = nullif(current_setting('nofries.wipe_tenant_id', true), '')) WITH CHECK (false);
CREATE POLICY iso_report_decision_wipe ON nofries.dashboard_iso_report_decisions TO nofries_account_wipe
    USING (tenant_id = nullif(current_setting('nofries.wipe_tenant_id', true), '')) WITH CHECK (false);
REVOKE ALL ON nofries.dashboard_iso_report_artifacts, nofries.dashboard_iso_report_decisions FROM PUBLIC, nofries_runtime, nofries_account_wipe;
-- The wipe predicate reads tenant_id only. Reviewed bytes and actor evidence stay private.
GRANT SELECT (tenant_id), DELETE ON nofries.dashboard_iso_report_artifacts, nofries.dashboard_iso_report_decisions TO nofries_account_wipe;
