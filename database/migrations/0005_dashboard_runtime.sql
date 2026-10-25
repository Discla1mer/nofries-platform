-- POR010: additive, source-only runtime persistence. No seed enables ingress.
-- The existing migration runner owns transactionality and checksum idempotence.
-- Application codecs retain canonical hashes and complete transition validation;
-- these constraints bind closed JSON to exact indexed/scoped SQL projections.

CREATE TABLE nofries.dashboard_runtime_instance (
    instance_id uuid NOT NULL PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    restore_epoch uuid NOT NULL,
    ingress_status text NOT NULL CHECK (ingress_status IN ('fenced','enabled')),
    changed_at timestamptz(3) NOT NULL CHECK (isfinite(changed_at) AND changed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND changed_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 180 AND evidence_ref=btrim(evidence_ref) AND evidence_ref !~ '[[:cntrl:]*]'),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
    head_receipt_id uuid NOT NULL,
    CONSTRAINT dashboard_runtime_instance_genesis CHECK (revision<>0 OR ingress_status='fenced')
);

CREATE TABLE nofries.dashboard_admission_authorities (
    authority_id uuid NOT NULL PRIMARY KEY,
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    head_revision bigint NOT NULL CHECK (head_revision BETWEEN 0 AND 9007199254740991),
    head_sha256 text NOT NULL CHECK (head_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('eligible','withdrawn')),
    updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at) AND updated_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND updated_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    UNIQUE (authority_id,tenant_id,organisation_id)
);

CREATE TABLE nofries.dashboard_admission_decisions (
    authority_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    parent_revision bigint CHECK (parent_revision BETWEEN 0 AND 9007199254740991),
    parent_sha256 text CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
    decision_sha256 text NOT NULL CHECK (decision_sha256 ~ '^[0-9a-f]{64}$'),
    occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at) AND occurred_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND occurred_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    actor_subject_key text NOT NULL CHECK (actor_subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 16384),
    PRIMARY KEY (authority_id,revision),
    UNIQUE (authority_id,revision,decision_sha256),
    UNIQUE (authority_id,revision,decision_sha256,tenant_id,organisation_id),
    CONSTRAINT dashboard_admission_parent CHECK ((revision=0 AND parent_revision IS NULL AND parent_sha256 IS NULL) OR (revision>0 AND parent_revision=revision-1 AND parent_revision IS NOT NULL AND parent_sha256 IS NOT NULL)),
    CONSTRAINT dashboard_admission_payload CHECK ((jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'decision', 'target', 'identityPolicyRef', 'approvedEffectSha256', 'evidenceRefs', 'validFrom', 'validUntil', 'actorSubjectKey', 'occurredAt'] AND payload - ARRAY['schemaVersion', 'decision', 'target', 'identityPolicyRef', 'approvedEffectSha256', 'evidenceRefs', 'validFrom', 'validUntil', 'actorSubjectKey', 'occurredAt']='{}'::jsonb
        AND payload->'schemaVersion'='1'::jsonb
        AND payload->>'decision' IN ('eligible','withdrawn')
        AND (revision<>0 OR payload->>'decision'='eligible')
        AND jsonb_typeof((payload->'target'))='object' AND (payload->'target') ?& ARRAY['tenantId', 'organisationId'] AND (payload->'target') - ARRAY['tenantId', 'organisationId']='{}'::jsonb
        AND payload#>>'{target,tenantId}'=tenant_id AND payload#>>'{target,organisationId}'=organisation_id
        AND jsonb_typeof((payload->'identityPolicyRef'))='object' AND (payload->'identityPolicyRef') ?& ARRAY['policyId', 'policyRevision'] AND (payload->'identityPolicyRef') - ARRAY['policyId', 'policyRevision']='{}'::jsonb
        AND jsonb_typeof(payload#>'{identityPolicyRef,policyId}')='string'
        AND length(payload#>>'{identityPolicyRef,policyId}') BETWEEN 1 AND 180
        AND payload#>>'{identityPolicyRef,policyId}'=btrim(payload#>>'{identityPolicyRef,policyId}')
        AND payload#>>'{identityPolicyRef,policyId}' !~ '[[:cntrl:]*]'
        AND jsonb_typeof(payload#>'{identityPolicyRef,policyRevision}')='number'
        AND payload#>>'{identityPolicyRef,policyRevision}' ~ '^[0-9]+$'
        AND (payload#>>'{identityPolicyRef,policyRevision}')::numeric BETWEEN 0 AND 9007199254740991
        AND payload->>'approvedEffectSha256' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(payload->'evidenceRefs')='array' AND jsonb_array_length(payload->'evidenceRefs') BETWEEN 0 AND 16
        AND ((payload->'evidenceRefs'->0) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->0))='object' AND (payload->'evidenceRefs'->0) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->0)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->0)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->0)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->0)->'id')='string' AND length((payload->'evidenceRefs'->0)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->0)->>'id'=btrim((payload->'evidenceRefs'->0)->>'id') AND (payload->'evidenceRefs'->0)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->1) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->1))='object' AND (payload->'evidenceRefs'->1) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->1)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->1)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->1)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->1)->'id')='string' AND length((payload->'evidenceRefs'->1)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->1)->>'id'=btrim((payload->'evidenceRefs'->1)->>'id') AND (payload->'evidenceRefs'->1)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->2) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->2))='object' AND (payload->'evidenceRefs'->2) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->2)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->2)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->2)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->2)->'id')='string' AND length((payload->'evidenceRefs'->2)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->2)->>'id'=btrim((payload->'evidenceRefs'->2)->>'id') AND (payload->'evidenceRefs'->2)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->3) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->3))='object' AND (payload->'evidenceRefs'->3) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->3)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->3)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->3)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->3)->'id')='string' AND length((payload->'evidenceRefs'->3)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->3)->>'id'=btrim((payload->'evidenceRefs'->3)->>'id') AND (payload->'evidenceRefs'->3)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->4) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->4))='object' AND (payload->'evidenceRefs'->4) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->4)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->4)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->4)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->4)->'id')='string' AND length((payload->'evidenceRefs'->4)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->4)->>'id'=btrim((payload->'evidenceRefs'->4)->>'id') AND (payload->'evidenceRefs'->4)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->5) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->5))='object' AND (payload->'evidenceRefs'->5) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->5)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->5)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->5)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->5)->'id')='string' AND length((payload->'evidenceRefs'->5)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->5)->>'id'=btrim((payload->'evidenceRefs'->5)->>'id') AND (payload->'evidenceRefs'->5)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->6) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->6))='object' AND (payload->'evidenceRefs'->6) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->6)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->6)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->6)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->6)->'id')='string' AND length((payload->'evidenceRefs'->6)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->6)->>'id'=btrim((payload->'evidenceRefs'->6)->>'id') AND (payload->'evidenceRefs'->6)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->7) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->7))='object' AND (payload->'evidenceRefs'->7) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->7)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->7)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->7)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->7)->'id')='string' AND length((payload->'evidenceRefs'->7)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->7)->>'id'=btrim((payload->'evidenceRefs'->7)->>'id') AND (payload->'evidenceRefs'->7)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->8) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->8))='object' AND (payload->'evidenceRefs'->8) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->8)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->8)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->8)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->8)->'id')='string' AND length((payload->'evidenceRefs'->8)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->8)->>'id'=btrim((payload->'evidenceRefs'->8)->>'id') AND (payload->'evidenceRefs'->8)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->9) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->9))='object' AND (payload->'evidenceRefs'->9) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->9)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->9)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->9)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->9)->'id')='string' AND length((payload->'evidenceRefs'->9)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->9)->>'id'=btrim((payload->'evidenceRefs'->9)->>'id') AND (payload->'evidenceRefs'->9)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->10) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->10))='object' AND (payload->'evidenceRefs'->10) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->10)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->10)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->10)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->10)->'id')='string' AND length((payload->'evidenceRefs'->10)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->10)->>'id'=btrim((payload->'evidenceRefs'->10)->>'id') AND (payload->'evidenceRefs'->10)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->11) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->11))='object' AND (payload->'evidenceRefs'->11) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->11)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->11)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->11)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->11)->'id')='string' AND length((payload->'evidenceRefs'->11)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->11)->>'id'=btrim((payload->'evidenceRefs'->11)->>'id') AND (payload->'evidenceRefs'->11)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->12) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->12))='object' AND (payload->'evidenceRefs'->12) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->12)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->12)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->12)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->12)->'id')='string' AND length((payload->'evidenceRefs'->12)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->12)->>'id'=btrim((payload->'evidenceRefs'->12)->>'id') AND (payload->'evidenceRefs'->12)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->13) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->13))='object' AND (payload->'evidenceRefs'->13) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->13)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->13)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->13)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->13)->'id')='string' AND length((payload->'evidenceRefs'->13)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->13)->>'id'=btrim((payload->'evidenceRefs'->13)->>'id') AND (payload->'evidenceRefs'->13)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->14) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->14))='object' AND (payload->'evidenceRefs'->14) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->14)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->14)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->14)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->14)->'id')='string' AND length((payload->'evidenceRefs'->14)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->14)->>'id'=btrim((payload->'evidenceRefs'->14)->>'id') AND (payload->'evidenceRefs'->14)->>'id' !~ '[[:cntrl:]*]'))
        AND ((payload->'evidenceRefs'->15) IS NULL OR (jsonb_typeof((payload->'evidenceRefs'->15))='object' AND (payload->'evidenceRefs'->15) ?& ARRAY['kind','id','sha256'] AND (payload->'evidenceRefs'->15)-ARRAY['kind','id','sha256']='{}'::jsonb
          AND (payload->'evidenceRefs'->15)->>'kind' IN ('RG002','RG010','approval','effect') AND (payload->'evidenceRefs'->15)->>'sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof((payload->'evidenceRefs'->15)->'id')='string' AND length((payload->'evidenceRefs'->15)->>'id') BETWEEN 1 AND 180
          AND (payload->'evidenceRefs'->15)->>'id'=btrim((payload->'evidenceRefs'->15)->>'id') AND (payload->'evidenceRefs'->15)->>'id' !~ '[[:cntrl:]*]'))
        AND jsonb_typeof(payload->'validFrom')='string' AND payload->>'validFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND jsonb_typeof(payload->'validUntil')='string' AND payload->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND payload->>'validFrom' < payload->>'validUntil'
        AND payload->>'actorSubjectKey'=actor_subject_key AND payload->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) IS TRUE)
);

CREATE TABLE nofries.dashboard_onboarding_cases (
    case_id uuid NOT NULL PRIMARY KEY,
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    capability_sha256 text NOT NULL CHECK (capability_sha256 ~ '^[0-9a-f]{64}$') UNIQUE,
    created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at) AND created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    accept_before timestamptz(3) NOT NULL CHECK (isfinite(accept_before) AND accept_before >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND accept_before <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    head_revision bigint NOT NULL CHECK (head_revision BETWEEN 0 AND 4),
    head_sha256 text NOT NULL CHECK (head_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('awaiting_identity','identity_verified','approved','accepted','revoked','expired','denied')),
    candidate_proof_id uuid,
    identity_sha256 text CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
    approval_id uuid,
    approval_revision bigint CHECK (approval_revision BETWEEN 0 AND 4),
    approval_sha256 text CHECK (approval_sha256 ~ '^[0-9a-f]{64}$'),
    accepted_receipt_id uuid,
    updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at) AND updated_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND updated_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    UNIQUE (case_id,tenant_id,organisation_id),
    UNIQUE (tenant_id,organisation_id,case_id),
    CONSTRAINT dashboard_case_times CHECK (created_at<accept_before AND created_at<=updated_at),
    CONSTRAINT dashboard_case_candidate CHECK ((candidate_proof_id IS NULL)=(identity_sha256 IS NULL)),
    CONSTRAINT dashboard_case_approval CHECK ((approval_id IS NULL AND approval_revision IS NULL AND approval_sha256 IS NULL) OR (approval_id IS NOT NULL AND approval_revision IS NOT NULL AND approval_sha256 IS NOT NULL AND candidate_proof_id IS NOT NULL)),
    CONSTRAINT dashboard_case_acceptance CHECK ((accepted_receipt_id IS NULL AND status<>'accepted') OR (accepted_receipt_id IS NOT NULL AND status IN ('accepted','revoked') AND approval_id IS NOT NULL)),
    CONSTRAINT dashboard_case_status_revision CHECK ((status='awaiting_identity' AND head_revision=0 AND candidate_proof_id IS NULL AND approval_id IS NULL AND updated_at=created_at) OR (status='identity_verified' AND head_revision=1 AND candidate_proof_id IS NOT NULL AND approval_id IS NULL) OR (status='approved' AND head_revision=2 AND approval_id IS NOT NULL) OR (status='accepted' AND head_revision=3) OR (status='revoked' AND head_revision BETWEEN 1 AND 4) OR (status IN ('expired','denied') AND head_revision BETWEEN 1 AND 3))
);

CREATE TABLE nofries.dashboard_onboarding_proofs (
    proof_id uuid NOT NULL PRIMARY KEY,
    case_id uuid NOT NULL,
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    case_revision bigint NOT NULL CHECK (case_revision BETWEEN 0 AND 4),
    identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
    identity_payload jsonb NOT NULL CHECK (octet_length(identity_payload::text) <= 16384),
    subject_key text NOT NULL CHECK (subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    authentication_sha256 text NOT NULL CHECK (authentication_sha256 ~ '^[0-9a-f]{64}$'),
    verified_at timestamptz(3) NOT NULL CHECK (isfinite(verified_at) AND verified_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND verified_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    fresh_until timestamptz(3) NOT NULL CHECK (isfinite(fresh_until) AND fresh_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND fresh_until <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    proof_sha256 text NOT NULL CHECK (proof_sha256 ~ '^[0-9a-f]{64}$'),
    operation_id uuid NOT NULL,
    UNIQUE (case_id,authentication_sha256),
    UNIQUE (case_id,operation_id),
    UNIQUE (case_id,proof_id,identity_sha256),
    UNIQUE (case_id,proof_id,identity_sha256,proof_sha256),
    CONSTRAINT dashboard_proof_interval CHECK (verified_at<fresh_until),
    CHECK ((jsonb_typeof(identity_payload)='object' AND identity_payload ?& ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience'] AND identity_payload - ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience']='{}'::jsonb
        AND jsonb_typeof(identity_payload->'policyId')='string' AND length(identity_payload->>'policyId') BETWEEN 1 AND 180
        AND identity_payload->>'policyId'=btrim(identity_payload->>'policyId') AND identity_payload->>'policyId' !~ '[[:cntrl:]*]'
        AND jsonb_typeof(identity_payload->'policyRevision')='number' AND identity_payload->>'policyRevision' ~ '^[0-9]+$'
        AND (identity_payload->>'policyRevision')::numeric BETWEEN 0 AND 9007199254740991
        AND jsonb_typeof(identity_payload->'issuer')='string' AND octet_length(identity_payload->>'issuer') BETWEEN 1 AND 1024
        AND jsonb_typeof(identity_payload->'audience')='string' AND octet_length(identity_payload->>'audience') BETWEEN 1 AND 1024
        AND identity_payload->>'identityTenantId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND identity_payload->>'oid' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND subject_key=(identity_payload->>'identityTenantId')||':'||(identity_payload->>'oid')
    ) IS TRUE)
);

CREATE TABLE nofries.dashboard_onboarding_decisions (
    case_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 4),
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    parent_revision bigint CHECK (parent_revision BETWEEN 0 AND 4),
    parent_sha256 text CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
    decision text NOT NULL CHECK (decision IN ('create','bind_identity','approve','accept','revoke','expire','deny')),
    decision_sha256 text NOT NULL CHECK (decision_sha256 ~ '^[0-9a-f]{64}$'),
    occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at) AND occurred_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND occurred_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    actor_subject_key text NOT NULL CHECK (actor_subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    operation_id uuid NOT NULL,
    approval_id uuid,
    candidate_proof_id uuid,
    candidate_proof_sha256 text CHECK (candidate_proof_sha256 ~ '^[0-9a-f]{64}$'),
    candidate_identity_sha256 text CHECK (candidate_identity_sha256 ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 262144),
    PRIMARY KEY (case_id,revision),
    UNIQUE (case_id,revision,decision_sha256),
    UNIQUE (case_id,revision,decision_sha256,tenant_id,organisation_id),
    UNIQUE (case_id,operation_id),
    UNIQUE (case_id,approval_id,revision,decision_sha256),
    CONSTRAINT dashboard_case_decision_parent CHECK ((revision=0 AND decision='create' AND parent_revision IS NULL AND parent_sha256 IS NULL) OR (revision>0 AND decision<>'create' AND parent_revision=revision-1 AND parent_revision IS NOT NULL AND parent_sha256 IS NOT NULL)),
    CONSTRAINT dashboard_case_decision_approval CHECK ((decision='approve' AND approval_id IS NOT NULL AND candidate_proof_id IS NOT NULL AND candidate_proof_sha256 IS NOT NULL AND candidate_identity_sha256 IS NOT NULL) OR (decision<>'approve' AND approval_id IS NULL AND candidate_proof_id IS NULL AND candidate_proof_sha256 IS NULL AND candidate_identity_sha256 IS NULL)),
    CONSTRAINT dashboard_case_decision_payload CHECK ((jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'caseId', 'scope', 'revision', 'status', 'createdAt', 'updatedAt', 'initiatorSubjectKey', 'acceptBefore', 'templateRef', 'templateSha256', 'template', 'authorityRef', 'candidateProof', 'approval', 'acceptanceReceipt', 'revocationEffect', 'decisions', 'headSha256'] AND payload - ARRAY['schemaVersion', 'caseId', 'scope', 'revision', 'status', 'createdAt', 'updatedAt', 'initiatorSubjectKey', 'acceptBefore', 'templateRef', 'templateSha256', 'template', 'authorityRef', 'candidateProof', 'approval', 'acceptanceReceipt', 'revocationEffect', 'decisions', 'headSha256']='{}'::jsonb
        AND payload->'schemaVersion'='1'::jsonb AND payload->>'caseId'=case_id::text
        AND jsonb_typeof((payload->'scope'))='object' AND (payload->'scope') ?& ARRAY['tenantId', 'organisationId'] AND (payload->'scope') - ARRAY['tenantId', 'organisationId']='{}'::jsonb
        AND payload#>>'{scope,tenantId}'=tenant_id AND payload#>>'{scope,organisationId}'=organisation_id
        AND payload->'revision'=to_jsonb(revision) AND payload->>'headSha256'=decision_sha256
        AND payload->>'updatedAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND jsonb_typeof(payload->'decisions')='array' AND jsonb_array_length(payload->'decisions')=revision+1
        AND jsonb_typeof((payload->'decisions'->-1))='object' AND (payload->'decisions'->-1) ?& ARRAY['schemaVersion', 'revision', 'parentSha256', 'command', 'sha256'] AND (payload->'decisions'->-1) - ARRAY['schemaVersion', 'revision', 'parentSha256', 'command', 'sha256']='{}'::jsonb
        AND (payload->'decisions'->-1)->'schemaVersion'='1'::jsonb AND (payload->'decisions'->-1)->'revision'=to_jsonb(revision)
        AND (payload->'decisions'->-1)->'parentSha256'=COALESCE(to_jsonb(parent_sha256),'null'::jsonb)
        AND (payload->'decisions'->-1)->>'sha256'=decision_sha256
        AND jsonb_typeof((payload->'decisions'->-1->'command'))='object' AND (payload->'decisions'->-1->'command') ?& ARRAY['action', 'operationId', 'expectedRevision', 'actorSubjectKey', 'at', 'payload'] AND (payload->'decisions'->-1->'command') - ARRAY['action', 'operationId', 'expectedRevision', 'actorSubjectKey', 'at', 'payload']='{}'::jsonb
        AND (payload->'decisions'->-1->'command')->>'action'=decision AND (payload->'decisions'->-1->'command')->>'operationId'=operation_id::text
        AND (payload->'decisions'->-1->'command')->'expectedRevision'=COALESCE(to_jsonb(parent_revision),'null'::jsonb)
        AND (payload->'decisions'->-1->'command')->>'actorSubjectKey'=actor_subject_key AND (payload->'decisions'->-1->'command')->>'at'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND ((decision='create' AND payload->>'status'='awaiting_identity')
          OR (decision='bind_identity' AND payload->>'status'='identity_verified')
          OR (decision='approve' AND payload->>'status'='approved')
          OR (decision='accept' AND payload->>'status'='accepted')
          OR (decision='revoke' AND payload->>'status'='revoked')
          OR (decision='expire' AND payload->>'status'='expired')
          OR (decision='deny' AND payload->>'status'='denied'))
        AND (decision<>'approve' OR (
          payload#>>'{approval,approvalId}'=approval_id::text
          AND payload#>'{approval,revision}'=to_jsonb(revision) AND payload#>>'{approval,sha256}'=decision_sha256
          AND payload#>>'{approval,candidateProofId}'=candidate_proof_id::text
          AND payload#>>'{approval,candidateProofSha256}'=candidate_proof_sha256
          AND payload#>>'{approval,identitySha256}'=candidate_identity_sha256))
    ) IS TRUE)
);

CREATE UNIQUE INDEX dashboard_case_one_approval ON nofries.dashboard_onboarding_decisions (case_id) WHERE decision='approve';
CREATE UNIQUE INDEX dashboard_case_approval_id ON nofries.dashboard_onboarding_decisions (approval_id) WHERE decision='approve';

CREATE TABLE nofries.dashboard_identity_bindings (
    binding_id uuid NOT NULL PRIMARY KEY,
    tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text NOT NULL CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    membership_id text NOT NULL CHECK (length(membership_id) BETWEEN 1 AND 180 AND membership_id=btrim(membership_id) AND membership_id !~ '[[:cntrl:]*]'),
    invitation_id text NOT NULL CHECK (length(invitation_id) BETWEEN 1 AND 180 AND invitation_id=btrim(invitation_id) AND invitation_id !~ '[[:cntrl:]*]'),
    grant_evidence_id text NOT NULL CHECK (length(grant_evidence_id) BETWEEN 1 AND 180 AND grant_evidence_id=btrim(grant_evidence_id) AND grant_evidence_id !~ '[[:cntrl:]*]'),
    identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
    identity_payload jsonb NOT NULL CHECK (octet_length(identity_payload::text) <= 16384),
    subject_key text NOT NULL CHECK (subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    binding_origin text NOT NULL CHECK (binding_origin IN ('staged_acceptance','existing_membership')),
    case_id uuid,
    approval_id uuid,
    approval_revision bigint CHECK (approval_revision BETWEEN 0 AND 4),
    approval_sha256 text CHECK (approval_sha256 ~ '^[0-9a-f]{64}$'),
    acceptance_receipt_id uuid,
    publication_receipt_id uuid,
    authority_id uuid NOT NULL,
    authority_revision bigint NOT NULL CHECK (authority_revision BETWEEN 0 AND 9007199254740991),
    authority_sha256 text NOT NULL CHECK (authority_sha256 ~ '^[0-9a-f]{64}$'),
    revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 1),
    status text NOT NULL CHECK (status IN ('active','revoked')),
    valid_from timestamptz(3) NOT NULL CHECK (isfinite(valid_from) AND valid_from >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND valid_from <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    valid_until timestamptz(3) NOT NULL CHECK (isfinite(valid_until) AND valid_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND valid_until <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at) AND created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at) AND updated_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND updated_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    organisation_label text NOT NULL CHECK (length(organisation_label) BETWEEN 1 AND 200),
    UNIQUE (tenant_id,organisation_id,binding_id),
    UNIQUE (tenant_id,organisation_id,membership_id),
    UNIQUE (case_id),
    CONSTRAINT dashboard_binding_interval CHECK (valid_from<valid_until AND created_at<=updated_at),
    CONSTRAINT dashboard_binding_revision CHECK ((status='active' AND revision=0 AND created_at=updated_at) OR (status='revoked' AND revision=1)),
    CONSTRAINT dashboard_binding_origin CHECK ((binding_origin='staged_acceptance' AND case_id IS NOT NULL AND approval_id IS NOT NULL AND approval_revision IS NOT NULL AND approval_sha256 IS NOT NULL AND acceptance_receipt_id IS NOT NULL AND publication_receipt_id IS NULL) OR (binding_origin='existing_membership' AND case_id IS NULL AND approval_id IS NULL AND approval_revision IS NULL AND approval_sha256 IS NULL AND acceptance_receipt_id IS NULL AND publication_receipt_id IS NOT NULL)),
    CHECK ((jsonb_typeof(identity_payload)='object' AND identity_payload ?& ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience'] AND identity_payload - ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience']='{}'::jsonb
        AND jsonb_typeof(identity_payload->'policyId')='string' AND length(identity_payload->>'policyId') BETWEEN 1 AND 180
        AND identity_payload->>'policyId'=btrim(identity_payload->>'policyId') AND identity_payload->>'policyId' !~ '[[:cntrl:]*]'
        AND jsonb_typeof(identity_payload->'policyRevision')='number' AND identity_payload->>'policyRevision' ~ '^[0-9]+$'
        AND (identity_payload->>'policyRevision')::numeric BETWEEN 0 AND 9007199254740991
        AND jsonb_typeof(identity_payload->'issuer')='string' AND octet_length(identity_payload->>'issuer') BETWEEN 1 AND 1024
        AND jsonb_typeof(identity_payload->'audience')='string' AND octet_length(identity_payload->>'audience') BETWEEN 1 AND 1024
        AND identity_payload->>'identityTenantId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND identity_payload->>'oid' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND subject_key=(identity_payload->>'identityTenantId')||':'||(identity_payload->>'oid')
    ) IS TRUE)
);

CREATE UNIQUE INDEX dashboard_binding_active_identity ON nofries.dashboard_identity_bindings (identity_sha256,tenant_id,organisation_id) WHERE status='active';
CREATE INDEX dashboard_binding_subject ON nofries.dashboard_identity_bindings (identity_sha256,subject_key,binding_id);

CREATE TABLE nofries.dashboard_session_gates (
    session_sha256 text NOT NULL CHECK (session_sha256 ~ '^[0-9a-f]{64}$') PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('operator_dashboard','onboarding_discovery','customer')),
    parent_session_sha256 text CHECK (parent_session_sha256 ~ '^[0-9a-f]{64}$') UNIQUE,
    operator_issuance_sha256 text CHECK (operator_issuance_sha256 ~ '^[0-9a-f]{64}$'),
    identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
    identity_payload jsonb NOT NULL CHECK (octet_length(identity_payload::text) <= 16384),
    subject_key text NOT NULL CHECK (subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    status text NOT NULL CHECK (status IN ('active','revoked')),
    revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    selection_generation bigint NOT NULL CHECK (selection_generation BETWEEN 0 AND 9007199254740991),
    generation_token text NOT NULL CHECK (generation_token ~ '^[0-9a-f]{64}$'),
    selected_binding_id uuid,
    selected_tenant_id text CHECK (length(selected_tenant_id) BETWEEN 1 AND 180 AND selected_tenant_id=btrim(selected_tenant_id) AND selected_tenant_id !~ '[[:cntrl:]*]'),
    selected_organisation_id text CHECK (length(selected_organisation_id) BETWEEN 1 AND 180 AND selected_organisation_id=btrim(selected_organisation_id) AND selected_organisation_id !~ '[[:cntrl:]*]'),
    discovery_case_id uuid,
    discovery_proof_id uuid,
    issued_at timestamptz(3) NOT NULL CHECK (isfinite(issued_at) AND issued_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND issued_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    expires_at timestamptz(3) NOT NULL CHECK (isfinite(expires_at) AND expires_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND expires_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    restore_epoch uuid NOT NULL,
    instance_id uuid NOT NULL,
    created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at) AND created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at) AND updated_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND updated_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    revoked_at timestamptz(3) CHECK (isfinite(revoked_at) AND revoked_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND revoked_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    CHECK ((jsonb_typeof(identity_payload)='object' AND identity_payload ?& ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience'] AND identity_payload - ARRAY['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'oid', 'audience']='{}'::jsonb
        AND jsonb_typeof(identity_payload->'policyId')='string' AND length(identity_payload->>'policyId') BETWEEN 1 AND 180
        AND identity_payload->>'policyId'=btrim(identity_payload->>'policyId') AND identity_payload->>'policyId' !~ '[[:cntrl:]*]'
        AND jsonb_typeof(identity_payload->'policyRevision')='number' AND identity_payload->>'policyRevision' ~ '^[0-9]+$'
        AND (identity_payload->>'policyRevision')::numeric BETWEEN 0 AND 9007199254740991
        AND jsonb_typeof(identity_payload->'issuer')='string' AND octet_length(identity_payload->>'issuer') BETWEEN 1 AND 1024
        AND jsonb_typeof(identity_payload->'audience')='string' AND octet_length(identity_payload->>'audience') BETWEEN 1 AND 1024
        AND identity_payload->>'identityTenantId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND identity_payload->>'oid' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND subject_key=(identity_payload->>'identityTenantId')||':'||(identity_payload->>'oid')
    ) IS TRUE),
    CONSTRAINT dashboard_gate_counters CHECK (revision=selection_generation),
    CONSTRAINT dashboard_gate_times CHECK (issued_at<expires_at AND issued_at<=created_at AND created_at<=updated_at AND (status<>'active' OR updated_at<expires_at) AND (revision<>0 OR created_at=updated_at) AND (revision=0 OR created_at<expires_at)),
    CONSTRAINT dashboard_gate_revocation CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL AND revoked_at=updated_at)),
    CONSTRAINT dashboard_gate_selection CHECK ((selected_binding_id IS NULL AND selected_tenant_id IS NULL AND selected_organisation_id IS NULL) OR (selected_binding_id IS NOT NULL AND selected_tenant_id IS NOT NULL AND selected_organisation_id IS NOT NULL)),
    CONSTRAINT dashboard_gate_kind CHECK ((kind='operator_dashboard' AND parent_session_sha256 IS NOT NULL AND parent_session_sha256=session_sha256 AND discovery_case_id IS NULL AND discovery_proof_id IS NULL AND ((operator_issuance_sha256 IS NULL AND status='revoked' AND revision=0 AND selected_binding_id IS NULL) OR (operator_issuance_sha256 IS NOT NULL AND ((status='active' AND ((revision=0 AND selected_binding_id IS NULL) OR (revision>0 AND selected_binding_id IS NOT NULL))) OR (status='revoked' AND revision>=1 AND ((revision=1 AND selected_binding_id IS NULL) OR (revision>1 AND selected_binding_id IS NOT NULL))))))) OR (kind='onboarding_discovery' AND parent_session_sha256 IS NULL AND operator_issuance_sha256 IS NULL AND discovery_case_id IS NOT NULL AND discovery_proof_id IS NOT NULL AND selected_binding_id IS NULL AND ((status='active' AND revision=0) OR (status='revoked' AND revision=1))) OR (kind='customer' AND parent_session_sha256 IS NULL AND operator_issuance_sha256 IS NULL AND discovery_case_id IS NULL AND discovery_proof_id IS NULL AND selected_binding_id IS NOT NULL AND (status='active' OR revision>=1)))
);

CREATE TABLE nofries.dashboard_runtime_receipts (
    receipt_id uuid NOT NULL PRIMARY KEY,
    anchor_kind text NOT NULL CHECK (anchor_kind IN ('session','case','authority','binding','instance')),
    anchor_session_sha256 text CHECK (anchor_session_sha256 ~ '^[0-9a-f]{64}$'),
    anchor_case_id uuid,
    anchor_authority_id uuid,
    anchor_binding_id uuid,
    anchor_instance_id uuid,
    tenant_id text CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    operation_id uuid NOT NULL,
    operation_type text NOT NULL CHECK (operation_type IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','createCase','approveCase','revokeCase','denyCase','expireCase','acceptStagedOnboarding','publishExistingMembershipBinding','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')),
    intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
    result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
    occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at) AND occurred_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND occurred_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    actor_subject_key text NOT NULL CHECK (actor_subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 262144),
    runtime_instance_id uuid NOT NULL,
    scope_json jsonb NOT NULL,
    audit_event_id uuid NOT NULL,
    audit_event_sha256 text NOT NULL CHECK (audit_event_sha256 ~ '^[0-9a-f]{64}$'),
    acceptance_case_id uuid,
    related_case_id uuid,
    related_proof_id uuid,
    related_identity_sha256 text CHECK (related_identity_sha256 ~ '^[0-9a-f]{64}$'),
    instance_result_revision bigint CHECK (instance_result_revision BETWEEN 0 AND 9007199254740991),
    instance_result_sha256 text CHECK (instance_result_sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (((tenant_id IS NULL AND organisation_id IS NULL AND scope_json='null'::jsonb) OR (tenant_id IS NOT NULL AND organisation_id IS NOT NULL AND scope_json=jsonb_build_object('tenantId',tenant_id,'organisationId',organisation_id))) IS TRUE),
    UNIQUE (acceptance_case_id,tenant_id,organisation_id,receipt_id),
    UNIQUE (anchor_binding_id,tenant_id,organisation_id,receipt_id),
    UNIQUE (related_proof_id),
    UNIQUE (anchor_instance_id,instance_result_revision),
    UNIQUE (anchor_instance_id,instance_result_revision,instance_result_sha256,receipt_id),
    CONSTRAINT dashboard_receipt_anchor CHECK (((anchor_kind='session' AND anchor_session_sha256 IS NOT NULL AND operation_type IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession'))
        OR (anchor_kind='case' AND anchor_case_id IS NOT NULL AND operation_type IN ('createCase','approveCase','revokeCase','denyCase','expireCase','acceptStagedOnboarding'))
        OR (anchor_kind='authority' AND anchor_authority_id IS NOT NULL AND operation_type IN ('publishAdmissionDecision','withdrawAdmissionDecision'))
        OR (anchor_kind='binding' AND anchor_binding_id IS NOT NULL AND operation_type='publishExistingMembershipBinding')
        OR (anchor_kind='instance' AND anchor_instance_id IS NOT NULL AND operation_type IN ('initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')))
        AND num_nonnulls(anchor_session_sha256,anchor_case_id,anchor_authority_id,anchor_binding_id,anchor_instance_id)=1),
    CONSTRAINT dashboard_receipt_anchor_scope CHECK ((anchor_kind='instance' AND tenant_id IS NULL) OR anchor_kind='session' OR (anchor_kind IN ('case','binding','authority') AND tenant_id IS NOT NULL)),
    CONSTRAINT dashboard_receipt_acceptance CHECK ((operation_type='acceptStagedOnboarding' AND acceptance_case_id IS NOT NULL AND acceptance_case_id=anchor_case_id) OR (operation_type<>'acceptStagedOnboarding' AND acceptance_case_id IS NULL)),
    CONSTRAINT dashboard_receipt_compound CHECK ((operation_type='recordProofAndActivateDiscovery' AND related_case_id IS NOT NULL AND related_proof_id IS NOT NULL AND related_identity_sha256 IS NOT NULL AND tenant_id IS NOT NULL) OR (operation_type<>'recordProofAndActivateDiscovery' AND related_case_id IS NULL AND related_proof_id IS NULL AND related_identity_sha256 IS NULL)),
    CONSTRAINT dashboard_receipt_instance_result CHECK ((anchor_kind='instance' AND instance_result_revision IS NOT NULL AND instance_result_sha256 IS NOT NULL AND anchor_instance_id=runtime_instance_id) OR (anchor_kind<>'instance' AND instance_result_revision IS NULL AND instance_result_sha256 IS NULL)),
    CONSTRAINT dashboard_receipt_data_reference CHECK ((
        (operation_type='acceptStagedOnboarding' AND payload#>>'{originalFacts,domainReceipt,effect,kind}'='bootstrap'
          AND jsonb_typeof((payload#>'{originalFacts,dataReference}'))='object' AND (payload#>'{originalFacts,dataReference}') ?& ARRAY['schemaVersion','operationType','tenantId','organisationId','operationId','intentSha256','resultSha256'] AND (payload#>'{originalFacts,dataReference}') - ARRAY['schemaVersion','operationType','tenantId','organisationId','operationId','intentSha256','resultSha256']='{}'::jsonb
          AND payload#>'{originalFacts,dataReference,schemaVersion}'='1'::jsonb
          AND payload#>>'{originalFacts,dataReference,operationType}'='organisation.initialise'
          AND payload#>>'{originalFacts,dataReference,tenantId}'=tenant_id
          AND payload#>>'{originalFacts,dataReference,organisationId}'=organisation_id
          AND payload#>>'{originalFacts,dataReference,operationId}'=operation_id::text
          AND payload#>>'{originalFacts,dataReference,intentSha256}' ~ '^[0-9a-f]{64}$'
          AND payload#>>'{originalFacts,dataReference,resultSha256}' ~ '^[0-9a-f]{64}$')
        OR ((operation_type<>'acceptStagedOnboarding' OR payload#>>'{originalFacts,domainReceipt,effect,kind}'<>'bootstrap')
          AND payload#>'{originalFacts,dataReference}'='null'::jsonb)
    ) IS TRUE),
    CONSTRAINT dashboard_receipt_operation_facts CHECK ((
        (operation_type NOT IN ('createCase','approveCase','revokeCase','denyCase','expireCase','recordProofAndActivateDiscovery','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')
          AND payload#>'{originalFacts,operationFacts}'='null'::jsonb)
        OR (operation_type='recordProofAndActivateDiscovery'
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts}'))='object' AND (payload#>'{originalFacts,operationFacts}') ?& ARRAY['caseState'] AND (payload#>'{originalFacts,operationFacts}') - ARRAY['caseState']='{}'::jsonb
          AND jsonb_typeof(payload#>'{originalFacts,operationFacts,caseState}')='object'
          AND payload#>>'{originalFacts,operationFacts,caseState,caseId}'=related_case_id::text
          AND payload#>'{originalFacts,operationFacts,caseState,scope}'=scope_json)
        OR (operation_type IN ('createCase','approveCase','revokeCase','denyCase','expireCase')
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts}'))='object' AND (payload#>'{originalFacts,operationFacts}') ?& ARRAY['predecessor','command','bindingPredecessor','capabilitySha256'] AND (payload#>'{originalFacts,operationFacts}') - ARRAY['predecessor','command','bindingPredecessor','capabilitySha256']='{}'::jsonb
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts,command}'))='object' AND (payload#>'{originalFacts,operationFacts,command}') ?& ARRAY['action','operationId','expectedRevision','actorSubjectKey','at','payload'] AND (payload#>'{originalFacts,operationFacts,command}') - ARRAY['action','operationId','expectedRevision','actorSubjectKey','at','payload']='{}'::jsonb
          AND payload#>>'{originalFacts,operationFacts,command,action}'=CASE operation_type
            WHEN 'createCase' THEN 'create' WHEN 'approveCase' THEN 'approve' WHEN 'revokeCase' THEN 'revoke' WHEN 'denyCase' THEN 'deny' WHEN 'expireCase' THEN 'expire' END
          AND payload#>>'{originalFacts,operationFacts,command,operationId}'=operation_id::text
          AND payload#>>'{originalFacts,operationFacts,command,actorSubjectKey}'=actor_subject_key
          AND payload#>>'{originalFacts,operationFacts,command,at}'=payload->>'occurredAt'
          AND ((operation_type='createCase'
            AND payload#>'{originalFacts,operationFacts,predecessor}'='null'::jsonb
            AND payload#>'{originalFacts,operationFacts,command,expectedRevision}'='null'::jsonb
            AND payload#>>'{originalFacts,operationFacts,capabilitySha256}' ~ '^[0-9a-f]{64}$')
            OR (operation_type<>'createCase'
              AND jsonb_typeof(payload#>'{originalFacts,operationFacts,predecessor}')='object'
              AND payload#>>'{originalFacts,operationFacts,predecessor,caseId}'=anchor_case_id::text
              AND payload#>'{originalFacts,operationFacts,predecessor,scope}'=scope_json
              AND payload#>'{originalFacts,operationFacts,command,expectedRevision}'=payload#>'{originalFacts,operationFacts,predecessor,revision}'
              AND payload#>'{originalFacts,operationFacts,capabilitySha256}'='null'::jsonb))
          AND ((operation_type='revokeCase' AND payload#>>'{originalFacts,operationFacts,predecessor,status}'='accepted'
            AND jsonb_typeof(payload#>'{originalFacts,operationFacts,bindingPredecessor}')='object')
            OR ((operation_type<>'revokeCase' OR payload#>>'{originalFacts,operationFacts,predecessor,status}' IS DISTINCT FROM 'accepted')
              AND payload#>'{originalFacts,operationFacts,bindingPredecessor}'='null'::jsonb)))
        OR (anchor_kind='instance'
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts}'))='object' AND (payload#>'{originalFacts,operationFacts}') ?& ARRAY['predecessor','command','facts'] AND (payload#>'{originalFacts,operationFacts}') - ARRAY['predecessor','command','facts']='{}'::jsonb
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts,command}'))='object' AND (payload#>'{originalFacts,operationFacts,command}') ?& ARRAY['schemaVersion','operationType','operationId','instanceId','actorSubjectKey','expectedRevision','expectedRecordSha256','payload'] AND (payload#>'{originalFacts,operationFacts,command}') - ARRAY['schemaVersion','operationType','operationId','instanceId','actorSubjectKey','expectedRevision','expectedRecordSha256','payload']='{}'::jsonb
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts,command,payload}'))='object' AND (payload#>'{originalFacts,operationFacts,command,payload}') ?& ARRAY['restoreEpoch','evidenceRef','evidenceSha256'] AND (payload#>'{originalFacts,operationFacts,command,payload}') - ARRAY['restoreEpoch','evidenceRef','evidenceSha256']='{}'::jsonb
          AND jsonb_typeof((payload#>'{originalFacts,operationFacts,facts}'))='object' AND (payload#>'{originalFacts,operationFacts,facts}') ?& ARRAY['occurredAt'] AND (payload#>'{originalFacts,operationFacts,facts}') - ARRAY['occurredAt']='{}'::jsonb
          AND payload#>'{originalFacts,operationFacts,command,schemaVersion}'='1'::jsonb
          AND payload#>>'{originalFacts,operationFacts,command,operationType}'=operation_type
          AND payload#>>'{originalFacts,operationFacts,command,operationId}'=operation_id::text
          AND payload#>>'{originalFacts,operationFacts,command,instanceId}'=runtime_instance_id::text
          AND payload#>>'{originalFacts,operationFacts,command,actorSubjectKey}'=actor_subject_key
          AND payload#>>'{originalFacts,operationFacts,facts,occurredAt}'=payload->>'occurredAt'
          AND ((operation_type='initializeRuntimeInstance'
            AND payload#>'{originalFacts,operationFacts,predecessor}'='null'::jsonb
            AND payload#>'{originalFacts,operationFacts,command,expectedRevision}'='null'::jsonb
            AND payload#>'{originalFacts,operationFacts,command,expectedRecordSha256}'='null'::jsonb)
            OR (operation_type<>'initializeRuntimeInstance'
              AND jsonb_typeof(payload#>'{originalFacts,operationFacts,predecessor}')='object'
              AND payload#>>'{originalFacts,operationFacts,predecessor,instanceId}'=runtime_instance_id::text
              AND payload#>'{originalFacts,operationFacts,command,expectedRevision}'=payload#>'{originalFacts,operationFacts,predecessor,revision}'
              AND payload#>>'{originalFacts,operationFacts,command,expectedRecordSha256}' ~ '^[0-9a-f]{64}$')))
    ) IS TRUE),
    CONSTRAINT dashboard_receipt_result CHECK ((
        (operation_type IN ('initializeOperatorSession','activateCustomerSession','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision') AND payload->'result'=payload#>'{originalFacts,domainReceipt,result}')
        OR (operation_type='recordProofAndActivateDiscovery'
          AND jsonb_typeof((payload->'result'))='object' AND (payload->'result') ?& ARRAY['session','case','proof','caseOutcome'] AND (payload->'result') - ARRAY['session','case','proof','caseOutcome']='{}'::jsonb
          AND payload#>'{result,session}'=payload#>'{originalFacts,domainReceipt,result}'
          AND jsonb_typeof((payload#>'{result,proof}'))='object' AND (payload#>'{result,proof}') ?& ARRAY['proofId','proofSha256'] AND (payload#>'{result,proof}') - ARRAY['proofId','proofSha256']='{}'::jsonb
          AND payload#>>'{result,proof,proofId}'=related_proof_id::text
          AND payload#>'{result,proof,proofSha256}'=payload#>'{originalFacts,domainReceipt,originalFacts,facts,proof,proofSha256}'
          AND payload#>>'{result,caseOutcome}' IN ('bound','preserved'))
        OR (operation_type IN ('createCase','approveCase','revokeCase','denyCase','expireCase') AND jsonb_typeof((payload->'result'))='object' AND (payload->'result') ?& ARRAY['case','binding'] AND (payload->'result') - ARRAY['case','binding']='{}'::jsonb
          AND ((operation_type='revokeCase' AND payload#>>'{originalFacts,operationFacts,predecessor,status}'='accepted'
            AND jsonb_typeof(payload#>'{result,binding}')='object')
            OR ((operation_type<>'revokeCase' OR payload#>>'{originalFacts,operationFacts,predecessor,status}' IS DISTINCT FROM 'accepted')
              AND payload#>'{result,binding}'='null'::jsonb)))
        OR (operation_type='acceptStagedOnboarding' AND jsonb_typeof((payload->'result'))='object' AND (payload->'result') ?& ARRAY['case','binding','acceptedAt'] AND (payload->'result') - ARRAY['case','binding','acceptedAt']='{}'::jsonb
          AND payload#>'{result,acceptedAt}'=payload#>'{originalFacts,domainReceipt,effect,acceptedAt}'
          AND jsonb_typeof(payload#>'{result,binding}')='object')
        OR (operation_type='publishExistingMembershipBinding' AND jsonb_typeof((payload->'result'))='object' AND (payload->'result') ?& ARRAY['binding'] AND (payload->'result') - ARRAY['binding']='{}'::jsonb
          AND payload#>>'{result,binding,bindingId}'=anchor_binding_id::text)
        OR (anchor_kind='instance' AND jsonb_typeof((payload->'result'))='object' AND (payload->'result') ?& ARRAY['record','outcome'] AND (payload->'result') - ARRAY['record','outcome']='{}'::jsonb
          AND jsonb_typeof((payload#>'{result,record}'))='object' AND (payload#>'{result,record}') ?& ARRAY['schemaVersion','instanceId','revision','restoreEpoch','ingressStatus','changedAt','evidenceRef','evidenceSha256'] AND (payload#>'{result,record}') - ARRAY['schemaVersion','instanceId','revision','restoreEpoch','ingressStatus','changedAt','evidenceRef','evidenceSha256']='{}'::jsonb
          AND payload#>'{result,record,schemaVersion}'='1'::jsonb
          AND payload#>>'{result,record,changedAt}'=payload->>'occurredAt'
          AND payload#>'{result,record,restoreEpoch}'=payload#>'{originalFacts,operationFacts,command,payload,restoreEpoch}'
          AND payload#>'{result,record,evidenceRef}'=payload#>'{originalFacts,operationFacts,command,payload,evidenceRef}'
          AND payload#>'{result,record,evidenceSha256}'=payload#>'{originalFacts,operationFacts,command,payload,evidenceSha256}'
          AND payload#>>'{result,outcome}'=CASE operation_type WHEN 'initializeRuntimeInstance' THEN 'initialized' WHEN 'fenceRestoreEpoch' THEN 'fenced' WHEN 'enableRuntimeIngress' THEN 'enabled' END
          AND payload#>>'{result,record,ingressStatus}'=CASE operation_type WHEN 'enableRuntimeIngress' THEN 'enabled' ELSE 'fenced' END)
    ) IS TRUE),
    CONSTRAINT dashboard_receipt_compact_results CHECK ((
        (operation_type NOT IN ('createCase','approveCase','revokeCase','denyCase','expireCase','recordProofAndActivateDiscovery','acceptStagedOnboarding') OR (
          jsonb_typeof((payload#>'{result,case}'))='object' AND (payload#>'{result,case}') ?& ARRAY['caseId','revision','headSha256','status'] AND (payload#>'{result,case}') - ARRAY['caseId','revision','headSha256','status']='{}'::jsonb
          AND payload#>>'{result,case,caseId}'=COALESCE(anchor_case_id,related_case_id)::text
          AND jsonb_typeof(payload#>'{result,case,revision}')='number'
          AND payload#>>'{result,case,revision}' ~ '^[0-4]$'
          AND payload#>>'{result,case,headSha256}' ~ '^[0-9a-f]{64}$'
          AND payload#>>'{result,case,status}' IN ('awaiting_identity','identity_verified','approved','accepted','revoked','expired','denied')))
        AND (payload#>'{result,binding}' IS NULL OR payload#>'{result,binding}'='null'::jsonb OR (
          jsonb_typeof((payload#>'{result,binding}'))='object' AND (payload#>'{result,binding}') ?& ARRAY['bindingId','membershipId','revision','status','updatedAt'] AND (payload#>'{result,binding}') - ARRAY['bindingId','membershipId','revision','status','updatedAt']='{}'::jsonb
          AND payload#>>'{result,binding,bindingId}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND jsonb_typeof(payload#>'{result,binding,membershipId}')='string'
          AND length(payload#>>'{result,binding,membershipId}') BETWEEN 1 AND 180
          AND payload#>>'{result,binding,membershipId}'=btrim(payload#>>'{result,binding,membershipId}')
          AND payload#>>'{result,binding,membershipId}' !~ '[[:cntrl:]*]'
          AND payload#>'{result,binding,revision}' IN ('0'::jsonb,'1'::jsonb)
          AND payload#>>'{result,binding,status}' IN ('active','revoked')
          AND payload#>>'{result,binding,updatedAt}'=payload->>'occurredAt'))
    ) IS TRUE),
    CONSTRAINT dashboard_receipt_stable_intent CHECK ((payload#>>'{stableIntent,operationType}'=operation_type AND (
        (operation_type IN ('initializeOperatorSession','activateCustomerSession','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','acceptStagedOnboarding','publishExistingMembershipBinding')
          AND jsonb_typeof((payload->'stableIntent'))='object' AND (payload->'stableIntent') ?& ARRAY['operationType','anchorKind','anchorId','domainIntent'] AND (payload->'stableIntent') - ARRAY['operationType','anchorKind','anchorId','domainIntent']='{}'::jsonb
          AND payload#>>'{stableIntent,anchorKind}'=anchor_kind AND payload#>>'{stableIntent,anchorId}'=payload->>'anchorId'
          AND payload#>'{stableIntent,domainIntent}'=CASE WHEN operation_type IN ('acceptStagedOnboarding','publishExistingMembershipBinding') THEN payload#>'{originalFacts,domainReceipt,intent}' ELSE payload#>'{originalFacts,domainReceipt,stableIntent}' END)
        OR (operation_type='recordProofAndActivateDiscovery'
          AND jsonb_typeof((payload->'stableIntent'))='object' AND (payload->'stableIntent') ?& ARRAY['operationType','anchorKind','anchorId','domainIntent','caseId','caseRevision','caseSha256','proofSha256'] AND (payload->'stableIntent') - ARRAY['operationType','anchorKind','anchorId','domainIntent','caseId','caseRevision','caseSha256','proofSha256']='{}'::jsonb
          AND payload#>>'{stableIntent,anchorKind}'=anchor_kind AND payload#>>'{stableIntent,anchorId}'=anchor_session_sha256
          AND payload#>'{stableIntent,domainIntent}'=payload#>'{originalFacts,domainReceipt,stableIntent}'
          AND payload#>>'{stableIntent,caseId}'=related_case_id::text
          AND payload#>'{stableIntent,caseRevision}'=payload#>'{originalFacts,operationFacts,caseState,revision}'
          AND payload#>'{stableIntent,caseSha256}'=payload#>'{originalFacts,operationFacts,caseState,headSha256}'
          AND payload#>'{stableIntent,proofSha256}'=payload#>'{originalFacts,domainReceipt,originalFacts,facts,proof,proofSha256}')
        OR (operation_type IN ('createCase','approveCase','revokeCase','denyCase','expireCase')
          AND jsonb_typeof((payload->'stableIntent'))='object' AND (payload->'stableIntent') ?& ARRAY['operationType','caseId','commandIntent','expectedHeadSha256','capabilitySha256','bindingRef'] AND (payload->'stableIntent') - ARRAY['operationType','caseId','commandIntent','expectedHeadSha256','capabilitySha256','bindingRef']='{}'::jsonb
          AND payload#>>'{stableIntent,caseId}'=anchor_case_id::text
          AND payload#>'{stableIntent,commandIntent}'=(payload#>'{originalFacts,operationFacts,command}')-'at'
          AND payload#>'{stableIntent,capabilitySha256}'=payload#>'{originalFacts,operationFacts,capabilitySha256}'
          AND payload#>'{stableIntent,expectedHeadSha256}'=COALESCE(payload#>'{originalFacts,operationFacts,predecessor,headSha256}','null'::jsonb)
          AND ((payload#>'{originalFacts,operationFacts,bindingPredecessor}'='null'::jsonb AND payload#>'{stableIntent,bindingRef}'='null'::jsonb)
            OR (jsonb_typeof((payload#>'{stableIntent,bindingRef}'))='object' AND (payload#>'{stableIntent,bindingRef}') ?& ARRAY['bindingId','revision','sha256'] AND (payload#>'{stableIntent,bindingRef}') - ARRAY['bindingId','revision','sha256']='{}'::jsonb
              AND payload#>'{stableIntent,bindingRef,bindingId}'=payload#>'{originalFacts,operationFacts,bindingPredecessor,bindingId}'
              AND payload#>'{stableIntent,bindingRef,revision}'=payload#>'{originalFacts,operationFacts,bindingPredecessor,revision}'
              AND payload#>>'{stableIntent,bindingRef,sha256}' ~ '^[0-9a-f]{64}$')))
        OR (anchor_kind='instance' AND payload->'stableIntent'=payload#>'{originalFacts,operationFacts,command}')
    )) IS TRUE),
    CONSTRAINT dashboard_receipt_payload CHECK ((jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'receiptId', 'operationType', 'operationId', 'instanceId', 'anchorKind', 'anchorId', 'scope', 'actorSubjectKey', 'occurredAt', 'stableIntent', 'intentSha256', 'originalFacts', 'result', 'resultSha256', 'auditEventId', 'auditEventSha256', 'receiptSha256'] AND payload - ARRAY['schemaVersion', 'receiptId', 'operationType', 'operationId', 'instanceId', 'anchorKind', 'anchorId', 'scope', 'actorSubjectKey', 'occurredAt', 'stableIntent', 'intentSha256', 'originalFacts', 'result', 'resultSha256', 'auditEventId', 'auditEventSha256', 'receiptSha256']='{}'::jsonb
        AND payload->'schemaVersion'='1'::jsonb AND payload->>'receiptId'=receipt_id::text
        AND payload->>'operationType'=operation_type AND payload->>'operationId'=operation_id::text
        AND payload->>'instanceId'=runtime_instance_id::text AND payload->>'anchorKind'=anchor_kind
        AND payload->>'anchorId'=COALESCE(anchor_session_sha256,anchor_case_id::text,anchor_authority_id::text,anchor_binding_id::text,anchor_instance_id::text)
        AND payload->'scope'=scope_json AND payload->>'actorSubjectKey'=actor_subject_key
        AND payload->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND payload->>'intentSha256'=intent_sha256
        AND payload->>'resultSha256'=result_sha256 AND payload->>'auditEventId'=audit_event_id::text
        AND payload->>'auditEventSha256'=audit_event_sha256 AND payload->>'receiptSha256' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(payload->'stableIntent')='object' AND jsonb_typeof(payload->'result')='object'
        AND jsonb_typeof((payload->'originalFacts'))='object' AND (payload->'originalFacts') ?& ARRAY['domainReceipt', 'operationFacts', 'dataReference'] AND (payload->'originalFacts') - ARRAY['domainReceipt', 'operationFacts', 'dataReference']='{}'::jsonb
        AND ((operation_type IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','acceptStagedOnboarding','publishExistingMembershipBinding')
          AND jsonb_typeof(payload#>'{originalFacts,domainReceipt}')='object'
          AND payload#>>'{originalFacts,domainReceipt,receiptId}'=receipt_id::text
          AND payload#>>'{originalFacts,domainReceipt,operationId}'=operation_id::text)
          OR (operation_type IN ('createCase','approveCase','revokeCase','denyCase','expireCase','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')
          AND payload#>'{originalFacts,domainReceipt}'='null'::jsonb))
        AND ((operation_type IN ('initializeOperatorSession','activateCustomerSession','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','acceptStagedOnboarding','publishExistingMembershipBinding')
          AND payload#>'{originalFacts,operationFacts}'='null'::jsonb)
          OR (operation_type IN ('recordProofAndActivateDiscovery','createCase','approveCase','revokeCase','denyCase','expireCase','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')
          AND jsonb_typeof(payload#>'{originalFacts,operationFacts}')='object'))
        AND (operation_type NOT IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision') OR (
          payload#>>'{originalFacts,domainReceipt,operationType}'=operation_type
          AND payload#>>'{originalFacts,domainReceipt,auditEventId}'=audit_event_id::text))
        AND (operation_type<>'acceptStagedOnboarding' OR (
          payload#>>'{originalFacts,domainReceipt,caseId}'=acceptance_case_id::text
          AND payload#>'{originalFacts,domainReceipt,scope}'=scope_json
          AND payload#>>'{originalFacts,domainReceipt,intent,operationType}'='accept'))
        AND (operation_type<>'publishExistingMembershipBinding' OR (
          payload#>>'{originalFacts,domainReceipt,operationType}'='publish_existing_membership'
          AND payload#>>'{originalFacts,domainReceipt,binding,bindingId}'=anchor_binding_id::text
          AND payload#>'{originalFacts,domainReceipt,binding,scope}'=scope_json))
        AND (operation_type<>'recordProofAndActivateDiscovery' OR (
          payload#>>'{originalFacts,domainReceipt,originalFacts,facts,proof,caseId}'=related_case_id::text
          AND payload#>>'{originalFacts,domainReceipt,originalFacts,facts,proof,proofId}'=related_proof_id::text
          AND payload#>>'{originalFacts,domainReceipt,originalFacts,facts,proof,identitySha256}'=related_identity_sha256
          AND payload#>>'{originalFacts,domainReceipt,originalFacts,facts,proof,operationId}'=operation_id::text
          AND payload#>'{originalFacts,domainReceipt,originalFacts,facts,proof,scope}'=scope_json
          AND payload#>>'{originalFacts,domainReceipt,result,record,sessionSha256}'=anchor_session_sha256))
        AND (anchor_kind<>'instance' OR (
          payload#>'{result,record,revision}'=to_jsonb(instance_result_revision)
          AND payload#>>'{result,record,instanceId}'=anchor_instance_id::text))
    ) IS TRUE)
);

CREATE UNIQUE INDEX dashboard_receipt_session_operation ON nofries.dashboard_runtime_receipts (anchor_session_sha256,operation_id) WHERE anchor_kind='session';

CREATE UNIQUE INDEX dashboard_receipt_case_operation ON nofries.dashboard_runtime_receipts (anchor_case_id,operation_id) WHERE anchor_kind='case';

CREATE UNIQUE INDEX dashboard_receipt_authority_operation ON nofries.dashboard_runtime_receipts (anchor_authority_id,operation_id) WHERE anchor_kind='authority';

CREATE UNIQUE INDEX dashboard_receipt_binding_operation ON nofries.dashboard_runtime_receipts (anchor_binding_id,operation_id) WHERE anchor_kind='binding';

CREATE UNIQUE INDEX dashboard_receipt_instance_operation ON nofries.dashboard_runtime_receipts (anchor_instance_id,operation_id) WHERE anchor_kind='instance';

CREATE INDEX dashboard_receipt_anchor_history ON nofries.dashboard_runtime_receipts (runtime_instance_id,anchor_kind,occurred_at,receipt_id);

CREATE TABLE nofries.dashboard_runtime_audit (
    event_id uuid NOT NULL PRIMARY KEY,
    session_sha256 text CHECK (session_sha256 ~ '^[0-9a-f]{64}$'),
    instance_id uuid NOT NULL,
    authority_id uuid,
    request_id uuid NOT NULL,
    tenant_id text CHECK (length(tenant_id) BETWEEN 1 AND 180 AND tenant_id=btrim(tenant_id) AND tenant_id !~ '[[:cntrl:]*]'),
    organisation_id text CHECK (length(organisation_id) BETWEEN 1 AND 180 AND organisation_id=btrim(organisation_id) AND organisation_id !~ '[[:cntrl:]*]'),
    occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at) AND occurred_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND occurred_at <= TIMESTAMPTZ '9999-12-31 23:59:59.999+00'),
    event_type text NOT NULL CHECK (event_type IN ('dashboard.operation','dashboard.runtime')),
    event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
    operation_id uuid,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 16384),
    scope_json jsonb NOT NULL,
    CHECK (((tenant_id IS NULL AND organisation_id IS NULL AND scope_json='null'::jsonb) OR (tenant_id IS NOT NULL AND organisation_id IS NOT NULL AND scope_json=jsonb_build_object('tenantId',tenant_id,'organisationId',organisation_id))) IS TRUE),
    UNIQUE (event_id,operation_id,instance_id,scope_json,event_sha256),
    CONSTRAINT dashboard_audit_session CHECK ((session_sha256 IS NULL AND event_type='dashboard.runtime' AND payload->>'action' IN ('publishAdmissionDecision','withdrawAdmissionDecision','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress') AND operation_id IS NOT NULL AND request_id=operation_id)
        OR (session_sha256 IS NOT NULL AND (event_type<>'dashboard.runtime' OR payload->>'action' NOT IN ('publishAdmissionDecision','withdrawAdmissionDecision','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress')))),
    CONSTRAINT dashboard_audit_payload CHECK ((payload->'schemaVersion'='1'::jsonb
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
            OR (payload->>'action'='readOnboardingStatus' AND payload->>'resourceKey'='case'))
          AND ((operation_id IS NOT NULL AND payload->>'action' IN ('initializeOperatorSession','activateCustomerSession','recordProofAndActivateDiscovery','selectBinding','revokeSession','publishAdmissionDecision','withdrawAdmissionDecision','createCase','approveCase','revokeCase','denyCase','expireCase','acceptStagedOnboarding','publishExistingMembershipBinding','initializeRuntimeInstance','fenceRestoreEpoch','enableRuntimeIngress') AND payload->>'outcome'='succeeded')
            OR (operation_id IS NULL AND payload->>'action' IN ('readSession','discoverBindings','readOnboardingStatus'))))
        OR (event_type='dashboard.operation'
          AND jsonb_typeof(payload)='object' AND payload ?& ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt'] AND payload - ARRAY['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt']='{}'::jsonb
          AND operation_id IS NULL AND tenant_id IS NOT NULL
          AND payload->>'tenantId'=tenant_id AND payload->>'organisationId'=organisation_id
          AND payload->>'actorSubjectKey' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND jsonb_typeof(payload->'action')='string' AND jsonb_typeof(payload->'module')='string'
          AND payload->>'result' IN ('succeeded','denied','failed'))))
    IS TRUE)
);

-- Exact non-deferrable unique targets precede all cyclic foreign keys.

ALTER TABLE nofries.dashboard_admission_decisions ADD CONSTRAINT dashboard_admission_owner_fk
    FOREIGN KEY (authority_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_admission_authorities (authority_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_admission_decisions ADD CONSTRAINT dashboard_admission_parent_fk
    FOREIGN KEY (authority_id,parent_revision,parent_sha256) REFERENCES nofries.dashboard_admission_decisions (authority_id,revision,decision_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_admission_authorities ADD CONSTRAINT dashboard_admission_head_fk
    FOREIGN KEY (authority_id,head_revision,head_sha256,tenant_id,organisation_id) REFERENCES nofries.dashboard_admission_decisions (authority_id,revision,decision_sha256,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_decisions ADD CONSTRAINT dashboard_case_decision_owner_fk
    FOREIGN KEY (case_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_cases (case_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_decisions ADD CONSTRAINT dashboard_case_decision_parent_fk
    FOREIGN KEY (case_id,parent_revision,parent_sha256) REFERENCES nofries.dashboard_onboarding_decisions (case_id,revision,decision_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_onboarding_cases ADD CONSTRAINT dashboard_case_head_fk
    FOREIGN KEY (case_id,head_revision,head_sha256,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_decisions (case_id,revision,decision_sha256,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_proofs ADD CONSTRAINT dashboard_proof_case_fk
    FOREIGN KEY (case_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_cases (case_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_onboarding_proofs ADD CONSTRAINT dashboard_proof_decision_fk
    FOREIGN KEY (case_id,case_revision) REFERENCES nofries.dashboard_onboarding_decisions (case_id,revision)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_onboarding_cases ADD CONSTRAINT dashboard_case_candidate_fk
    FOREIGN KEY (case_id,candidate_proof_id,identity_sha256) REFERENCES nofries.dashboard_onboarding_proofs (case_id,proof_id,identity_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_cases ADD CONSTRAINT dashboard_case_approval_fk
    FOREIGN KEY (case_id,approval_id,approval_revision,approval_sha256) REFERENCES nofries.dashboard_onboarding_decisions (case_id,approval_id,revision,decision_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_decisions ADD CONSTRAINT dashboard_approval_proof_fk
    FOREIGN KEY (case_id,candidate_proof_id,candidate_identity_sha256,candidate_proof_sha256) REFERENCES nofries.dashboard_onboarding_proofs (case_id,proof_id,identity_sha256,proof_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_onboarding_cases ADD CONSTRAINT dashboard_case_acceptance_fk
    FOREIGN KEY (case_id,tenant_id,organisation_id,accepted_receipt_id) REFERENCES nofries.dashboard_runtime_receipts (acceptance_case_id,tenant_id,organisation_id,receipt_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_organisation_fk
    FOREIGN KEY (tenant_id,organisation_id) REFERENCES nofries.dashboard_organisations (tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_case_fk
    FOREIGN KEY (case_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_cases (case_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_approval_fk
    FOREIGN KEY (case_id,approval_id,approval_revision,approval_sha256) REFERENCES nofries.dashboard_onboarding_decisions (case_id,approval_id,revision,decision_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_authority_fk
    FOREIGN KEY (authority_id,authority_revision,authority_sha256,tenant_id,organisation_id) REFERENCES nofries.dashboard_admission_decisions (authority_id,revision,decision_sha256,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_acceptance_fk
    FOREIGN KEY (case_id,tenant_id,organisation_id,acceptance_receipt_id) REFERENCES nofries.dashboard_runtime_receipts (acceptance_case_id,tenant_id,organisation_id,receipt_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_identity_bindings ADD CONSTRAINT dashboard_binding_publication_fk
    FOREIGN KEY (binding_id,tenant_id,organisation_id,publication_receipt_id) REFERENCES nofries.dashboard_runtime_receipts (anchor_binding_id,tenant_id,organisation_id,receipt_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_session_gates ADD CONSTRAINT dashboard_gate_instance_fk
    FOREIGN KEY (instance_id) REFERENCES nofries.dashboard_runtime_instance (instance_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_session_gates ADD CONSTRAINT dashboard_gate_binding_fk
    FOREIGN KEY (selected_tenant_id,selected_organisation_id,selected_binding_id) REFERENCES nofries.dashboard_identity_bindings (tenant_id,organisation_id,binding_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION;

ALTER TABLE nofries.dashboard_session_gates ADD CONSTRAINT dashboard_gate_proof_fk
    FOREIGN KEY (discovery_case_id,discovery_proof_id,identity_sha256) REFERENCES nofries.dashboard_onboarding_proofs (case_id,proof_id,identity_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_session_fk
    FOREIGN KEY (anchor_session_sha256) REFERENCES nofries.dashboard_session_gates (session_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_case_fk
    FOREIGN KEY (anchor_case_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_cases (case_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_authority_fk
    FOREIGN KEY (anchor_authority_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_admission_authorities (authority_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_binding_fk
    FOREIGN KEY (tenant_id,organisation_id,anchor_binding_id) REFERENCES nofries.dashboard_identity_bindings (tenant_id,organisation_id,binding_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_instance_anchor_fk
    FOREIGN KEY (anchor_instance_id) REFERENCES nofries.dashboard_runtime_instance (instance_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_instance_fk
    FOREIGN KEY (runtime_instance_id) REFERENCES nofries.dashboard_runtime_instance (instance_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_compound_proof_fk
    FOREIGN KEY (related_case_id,related_proof_id,related_identity_sha256) REFERENCES nofries.dashboard_onboarding_proofs (case_id,proof_id,identity_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_compound_case_fk
    FOREIGN KEY (related_case_id,tenant_id,organisation_id) REFERENCES nofries.dashboard_onboarding_cases (case_id,tenant_id,organisation_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_receipts ADD CONSTRAINT dashboard_receipt_audit_fk
    FOREIGN KEY (audit_event_id,operation_id,runtime_instance_id,scope_json,audit_event_sha256) REFERENCES nofries.dashboard_runtime_audit (event_id,operation_id,instance_id,scope_json,event_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_instance ADD CONSTRAINT dashboard_instance_head_receipt_fk
    FOREIGN KEY (instance_id,revision,record_sha256,head_receipt_id) REFERENCES nofries.dashboard_runtime_receipts (anchor_instance_id,instance_result_revision,instance_result_sha256,receipt_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_instance_fk
    FOREIGN KEY (instance_id) REFERENCES nofries.dashboard_runtime_instance (instance_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_session_fk
    FOREIGN KEY (session_sha256) REFERENCES nofries.dashboard_session_gates (session_sha256)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE nofries.dashboard_runtime_audit ADD CONSTRAINT dashboard_audit_authority_fk
    FOREIGN KEY (authority_id) REFERENCES nofries.dashboard_admission_authorities (authority_id)
    ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- New NOLOGIN capabilities do not acquire ownership or a runtime-to-maintenance path.

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_subject_reader') THEN
        CREATE ROLE nofries_dashboard_subject_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_subject_reader' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'dashboard_runtime_role_configuration_invalid';
    END IF;
END
$role$;

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_capability_reader') THEN
        CREATE ROLE nofries_dashboard_capability_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_capability_reader' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'dashboard_runtime_role_configuration_invalid';
    END IF;
END
$role$;

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_maintenance') THEN
        CREATE ROLE nofries_dashboard_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_dashboard_maintenance' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'dashboard_runtime_role_configuration_invalid';
    END IF;
END
$role$;

-- Existing named capabilities must be as restricted as newly created ones.
-- Fail closed instead of silently revoking unrelated pre-existing privileges.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname IN ('nofries_dashboard_subject_reader','nofries_dashboard_capability_reader','nofries_dashboard_maintenance')
          AND (EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=capability.oid)
            OR EXISTS (
                SELECT 1 FROM pg_auth_members membership
                JOIN pg_roles member_role ON member_role.oid=membership.member
                WHERE membership.roleid=capability.oid
                  AND NOT (capability.rolname IN ('nofries_dashboard_subject_reader','nofries_dashboard_capability_reader')
                    AND member_role.rolname='nofries_runtime'
                    AND membership.set_option AND NOT membership.inherit_option AND NOT membership.admin_option)
                  -- PostgreSQL17 automatically gives a nonsuperuser creator an
                  -- ADMIN-only membership. Keep only that schema-owner edge;
                  -- it grants neither SET nor inherited capability access.
                  AND NOT (member_role.rolname=current_user
                    AND member_role.rolcreaterole AND NOT member_role.rolsuper
                    AND membership.admin_option AND NOT membership.set_option AND NOT membership.inherit_option
                    AND EXISTS (SELECT 1 FROM pg_namespace owned_schema
                      WHERE owned_schema.nspname='nofries' AND owned_schema.nspowner=member_role.oid))
            )
            OR has_schema_privilege(capability.oid,'nofries','CREATE')
            OR EXISTS (
                SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
                WHERE namespace.nspname='nofries' AND relation.relkind IN ('r','p','v','m','f')
                  AND relation.relname NOT IN ('dashboard_runtime_instance','dashboard_admission_authorities',
                    'dashboard_admission_decisions','dashboard_onboarding_cases','dashboard_onboarding_proofs',
                    'dashboard_onboarding_decisions','dashboard_identity_bindings','dashboard_session_gates',
                    'dashboard_runtime_receipts','dashboard_runtime_audit')
                  AND (has_table_privilege(capability.oid,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                    OR has_any_column_privilege(capability.oid,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
            ))
    ) OR EXISTS (
        SELECT 1 FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid=membership.member
        JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
        WHERE member_role.rolname='nofries_runtime'
          AND granted_role.rolname IN ('nofries_dashboard_subject_reader','nofries_dashboard_capability_reader')
          AND (NOT membership.set_option OR membership.inherit_option OR membership.admin_option)
    ) THEN
        RAISE EXCEPTION 'dashboard_runtime_role_baseline_invalid';
    END IF;
END
$capability_baseline$;

GRANT nofries_dashboard_subject_reader, nofries_dashboard_capability_reader TO nofries_runtime WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
GRANT USAGE ON SCHEMA nofries TO nofries_dashboard_subject_reader, nofries_dashboard_capability_reader, nofries_dashboard_maintenance;

-- Follow usable SET-prefix/INHERIT paths; group attributes alone are insufficient.
-- An all-INHERIT reader path would OR reader policies into runtime. Also reject
-- that overlap after any usable SET prefix; the intended direct SET edges stay.
DO $membership$
BEGIN
    IF EXISTS (
        WITH RECURSIVE reachable(origin,role_id,can_set,can_use) AS (
            SELECT oid,oid,true,true FROM pg_roles
            WHERE rolname IN ('nofries_runtime','nofries_dashboard_subject_reader','nofries_dashboard_capability_reader','nofries_dashboard_maintenance')
            UNION
            SELECT r.origin,m.roleid,r.can_set AND m.set_option,
                (r.can_use AND m.inherit_option) OR (r.can_set AND m.set_option)
            FROM reachable r JOIN pg_auth_members m ON m.member=r.role_id
            WHERE (r.can_set AND m.set_option) OR (r.can_use AND m.inherit_option)
        )
        SELECT 1 FROM reachable r JOIN pg_roles reached ON reached.oid=r.role_id
        JOIN pg_roles origin ON origin.oid=r.origin
        WHERE (reached.rolname='nofries_dashboard_maintenance' AND origin.rolname<>'nofries_dashboard_maintenance')
           OR (origin.rolname IN ('nofries_dashboard_subject_reader','nofries_dashboard_capability_reader') AND reached.rolname='nofries_runtime')
           OR (origin.rolname='nofries_dashboard_maintenance' AND reached.rolname IN ('nofries_runtime','nofries_dashboard_subject_reader','nofries_dashboard_capability_reader'))
           OR (origin.rolname='nofries_runtime' AND r.can_use AND EXISTS (
               SELECT 1 FROM pg_auth_members inherited JOIN pg_roles reader ON reader.oid=inherited.roleid
               WHERE inherited.member=r.role_id AND inherited.inherit_option
                 AND reader.rolname IN ('nofries_dashboard_subject_reader','nofries_dashboard_capability_reader')
           ))
           OR reached.rolsuper OR reached.rolbypassrls OR reached.rolcreaterole
           OR EXISTS (SELECT 1 FROM pg_class owned JOIN pg_namespace ns ON ns.oid=owned.relnamespace
               WHERE owned.relowner=reached.oid AND ns.nspname='nofries')
    ) THEN
        RAISE EXCEPTION 'dashboard_runtime_role_membership_invalid';
    END IF;
END
$membership$;

ALTER TABLE nofries.dashboard_admission_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_admission_authorities FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_admission_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_admission_decisions FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_identity_bindings FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_onboarding_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_onboarding_cases FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_onboarding_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_onboarding_decisions FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_onboarding_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_onboarding_proofs FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_runtime_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_runtime_audit FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_runtime_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_runtime_instance FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_runtime_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_runtime_receipts FORCE ROW LEVEL SECURITY;

ALTER TABLE nofries.dashboard_session_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_session_gates FORCE ROW LEVEL SECURITY;

REVOKE ALL ON
    nofries.dashboard_admission_authorities,
    nofries.dashboard_admission_decisions,
    nofries.dashboard_identity_bindings,
    nofries.dashboard_onboarding_cases,
    nofries.dashboard_onboarding_decisions,
    nofries.dashboard_onboarding_proofs,
    nofries.dashboard_runtime_audit,
    nofries.dashboard_runtime_instance,
    nofries.dashboard_runtime_receipts,
    nofries.dashboard_session_gates
FROM PUBLIC, nofries_runtime, nofries_dashboard_subject_reader, nofries_dashboard_capability_reader, nofries_dashboard_maintenance;

CREATE POLICY dashboard_instance_runtime_select ON nofries.dashboard_runtime_instance
    FOR SELECT TO nofries_runtime
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_instance_subject_select ON nofries.dashboard_runtime_instance
    FOR SELECT TO nofries_dashboard_subject_reader
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_instance_maintenance_select ON nofries.dashboard_runtime_instance
    FOR SELECT TO nofries_dashboard_maintenance
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_instance_maintenance_insert ON nofries.dashboard_runtime_instance
    FOR INSERT TO nofries_dashboard_maintenance
    WITH CHECK (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_instance_maintenance_update ON nofries.dashboard_runtime_instance
    FOR UPDATE TO nofries_dashboard_maintenance
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''))
    WITH CHECK (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_authority_runtime_select ON nofries.dashboard_admission_authorities
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_admission_runtime_select ON nofries.dashboard_admission_decisions
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_authority_maintenance_select ON nofries.dashboard_admission_authorities
    FOR SELECT TO nofries_dashboard_maintenance
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_authority_maintenance_insert ON nofries.dashboard_admission_authorities
    FOR INSERT TO nofries_dashboard_maintenance
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_authority_maintenance_update ON nofries.dashboard_admission_authorities
    FOR UPDATE TO nofries_dashboard_maintenance
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL)
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_admission_maintenance_select ON nofries.dashboard_admission_decisions
    FOR SELECT TO nofries_dashboard_maintenance
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_admission_maintenance_insert ON nofries.dashboard_admission_decisions
    FOR INSERT TO nofries_dashboard_maintenance
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND NULLIF(current_setting('nofries.runtime_instance_id',true),'') IS NOT NULL);

CREATE POLICY dashboard_case_runtime_select ON nofries.dashboard_onboarding_cases
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_case_runtime_insert ON nofries.dashboard_onboarding_cases
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_case_runtime_update ON nofries.dashboard_onboarding_cases
    FOR UPDATE TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''))
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_proof_runtime_select ON nofries.dashboard_onboarding_proofs
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_proof_runtime_insert ON nofries.dashboard_onboarding_proofs
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_case_decision_runtime_select ON nofries.dashboard_onboarding_decisions
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_case_decision_runtime_insert ON nofries.dashboard_onboarding_decisions
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND case_id::text=NULLIF(current_setting('nofries.case_id',true),''));

CREATE POLICY dashboard_case_capability_select ON nofries.dashboard_onboarding_cases
    FOR SELECT TO nofries_dashboard_capability_reader
    USING (capability_sha256=NULLIF(current_setting('nofries.capability_sha256',true),''));

-- Reduced internal locator only. Original issuance/proof and time remain fixed
-- invocation checks; this policy adds neither an authority clock nor a mode.
CREATE POLICY dashboard_case_subject_locator ON nofries.dashboard_onboarding_cases
    FOR SELECT TO nofries_dashboard_subject_reader
    USING (case_id::text=NULLIF(current_setting('nofries.case_id',true),'')
        AND EXISTS (
            SELECT 1 FROM nofries.dashboard_session_gates gate
            JOIN nofries.dashboard_runtime_instance instance
              ON instance.instance_id=gate.instance_id AND instance.restore_epoch=gate.restore_epoch
            WHERE gate.session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'')
              AND gate.kind=NULLIF(current_setting('nofries.session_kind',true),'')
              AND gate.identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'')
              AND gate.subject_key=NULLIF(current_setting('nofries.subject_key',true),'')
              AND instance.instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'')
              AND gate.status='active' AND instance.ingress_status='enabled'
              AND ((gate.kind='operator_dashboard' AND gate.operator_issuance_sha256 IS NOT NULL)
                OR (gate.kind='onboarding_discovery'
                  AND gate.discovery_case_id=dashboard_onboarding_cases.case_id
                  AND gate.discovery_proof_id IS NOT NULL))
        ));

CREATE POLICY dashboard_binding_runtime_select ON nofries.dashboard_identity_bindings
    FOR SELECT TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND binding_id::text=NULLIF(current_setting('nofries.binding_id',true),''));

CREATE POLICY dashboard_binding_runtime_insert ON nofries.dashboard_identity_bindings
    FOR INSERT TO nofries_runtime
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND binding_id::text=NULLIF(current_setting('nofries.binding_id',true),''));

CREATE POLICY dashboard_binding_runtime_update ON nofries.dashboard_identity_bindings
    FOR UPDATE TO nofries_runtime
    USING (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND binding_id::text=NULLIF(current_setting('nofries.binding_id',true),''))
    WITH CHECK (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'') AND binding_id::text=NULLIF(current_setting('nofries.binding_id',true),''));

CREATE POLICY dashboard_binding_subject_select ON nofries.dashboard_identity_bindings
    FOR SELECT TO nofries_dashboard_subject_reader
    USING (identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),''));

CREATE POLICY dashboard_gate_runtime_select ON nofries.dashboard_session_gates
    FOR SELECT TO nofries_runtime
    USING (session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND kind=NULLIF(current_setting('nofries.session_kind',true),'') AND identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_gate_runtime_insert ON nofries.dashboard_session_gates
    FOR INSERT TO nofries_runtime
    WITH CHECK (session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND kind=NULLIF(current_setting('nofries.session_kind',true),'') AND identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_gate_runtime_update ON nofries.dashboard_session_gates
    FOR UPDATE TO nofries_runtime
    USING (session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND kind=NULLIF(current_setting('nofries.session_kind',true),'') AND identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''))
    WITH CHECK (session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND kind=NULLIF(current_setting('nofries.session_kind',true),'') AND identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_gate_subject_select ON nofries.dashboard_session_gates
    FOR SELECT TO nofries_dashboard_subject_reader
    USING (session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND kind=NULLIF(current_setting('nofries.session_kind',true),'') AND identity_sha256=NULLIF(current_setting('nofries.identity_sha256',true),'') AND subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''));

CREATE POLICY dashboard_receipt_runtime_select ON nofries.dashboard_runtime_receipts
    FOR SELECT TO nofries_runtime
    USING (runtime_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND ((anchor_kind='session' AND anchor_session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND actor_subject_key=NULLIF(current_setting('nofries.subject_key',true),'')) OR (anchor_kind='case' AND anchor_case_id::text=NULLIF(current_setting('nofries.case_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='binding' AND anchor_binding_id::text=NULLIF(current_setting('nofries.binding_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='authority' AND anchor_authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='instance' AND anchor_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''))));

CREATE POLICY dashboard_receipt_runtime_insert ON nofries.dashboard_runtime_receipts
    FOR INSERT TO nofries_runtime
    WITH CHECK (runtime_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND actor_subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND ((anchor_kind='session' AND anchor_session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND actor_subject_key=NULLIF(current_setting('nofries.subject_key',true),'') AND (scope_json='null'::jsonb OR (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')))) OR (anchor_kind='case' AND anchor_case_id::text=NULLIF(current_setting('nofries.case_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='binding' AND anchor_binding_id::text=NULLIF(current_setting('nofries.binding_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),''))));

CREATE POLICY dashboard_receipt_maintenance_select ON nofries.dashboard_runtime_receipts
    FOR SELECT TO nofries_dashboard_maintenance
    USING (runtime_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND ((anchor_kind='authority' AND anchor_authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='instance' AND anchor_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''))));

CREATE POLICY dashboard_receipt_maintenance_insert ON nofries.dashboard_runtime_receipts
    FOR INSERT TO nofries_dashboard_maintenance
    WITH CHECK (runtime_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND ((anchor_kind='authority' AND anchor_authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (anchor_kind='instance' AND anchor_instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),''))));

CREATE POLICY dashboard_audit_runtime_select ON nofries.dashboard_runtime_audit
    FOR SELECT TO nofries_runtime
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'')
        AND ((session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'')
          AND payload->>'actorSubjectKey'=NULLIF(current_setting('nofries.subject_key',true),''))
        OR EXISTS (
            SELECT 1 FROM nofries.dashboard_runtime_receipts receipt
            WHERE receipt.audit_event_id=dashboard_runtime_audit.event_id
              AND receipt.operation_id=dashboard_runtime_audit.operation_id
              AND receipt.runtime_instance_id=dashboard_runtime_audit.instance_id
              AND receipt.scope_json=dashboard_runtime_audit.scope_json
              AND receipt.audit_event_sha256=dashboard_runtime_audit.event_sha256
        )));

CREATE POLICY dashboard_audit_runtime_insert ON nofries.dashboard_runtime_audit
    FOR INSERT TO nofries_runtime
    WITH CHECK (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND session_sha256=NULLIF(current_setting('nofries.session_sha256',true),'') AND payload->>'actorSubjectKey'=NULLIF(current_setting('nofries.subject_key',true),'') AND request_id::text=NULLIF(current_setting('nofries.request_id',true),'') AND (scope_json='null'::jsonb OR (tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),''))) AND (authority_id IS NULL OR authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'')));

CREATE POLICY dashboard_audit_maintenance_select ON nofries.dashboard_runtime_audit
    FOR SELECT TO nofries_dashboard_maintenance
    USING (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND session_sha256 IS NULL AND ((authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (authority_id IS NULL AND scope_json='null'::jsonb)));

CREATE POLICY dashboard_audit_maintenance_insert ON nofries.dashboard_runtime_audit
    FOR INSERT TO nofries_dashboard_maintenance
    WITH CHECK (instance_id::text=NULLIF(current_setting('nofries.runtime_instance_id',true),'') AND session_sha256 IS NULL AND ((authority_id::text=NULLIF(current_setting('nofries.authority_id',true),'') AND tenant_id=NULLIF(current_setting('nofries.tenant_id',true),'') AND organisation_id=NULLIF(current_setting('nofries.organisation_id',true),'')) OR (authority_id IS NULL AND scope_json='null'::jsonb)));

-- No table-wide UPDATE grant: only the finite mutable projections may change.

GRANT SELECT ON nofries.dashboard_runtime_instance,nofries.dashboard_admission_authorities,nofries.dashboard_admission_decisions TO nofries_runtime;

GRANT SELECT,INSERT ON nofries.dashboard_onboarding_cases,nofries.dashboard_onboarding_proofs,nofries.dashboard_onboarding_decisions,nofries.dashboard_identity_bindings,nofries.dashboard_session_gates,nofries.dashboard_runtime_receipts,nofries.dashboard_runtime_audit TO nofries_runtime;

GRANT UPDATE (head_revision,head_sha256,status,candidate_proof_id,identity_sha256,approval_id,approval_revision,approval_sha256,accepted_receipt_id,updated_at) ON nofries.dashboard_onboarding_cases TO nofries_runtime;

GRANT UPDATE (revision,status,updated_at) ON nofries.dashboard_identity_bindings TO nofries_runtime;

GRANT UPDATE (status,revision,selection_generation,generation_token,selected_binding_id,selected_tenant_id,selected_organisation_id,updated_at,revoked_at) ON nofries.dashboard_session_gates TO nofries_runtime;

GRANT SELECT (session_sha256,kind,parent_session_sha256,operator_issuance_sha256,identity_sha256,identity_payload,subject_key,status,revision,selection_generation,generation_token,selected_binding_id,selected_tenant_id,selected_organisation_id,discovery_case_id,discovery_proof_id,issued_at,expires_at,restore_epoch,instance_id,created_at,updated_at,revoked_at) ON nofries.dashboard_session_gates TO nofries_dashboard_subject_reader;
GRANT SELECT (instance_id,revision,restore_epoch,ingress_status,changed_at,evidence_ref,evidence_sha256,record_sha256,head_receipt_id) ON nofries.dashboard_runtime_instance TO nofries_dashboard_subject_reader;

GRANT SELECT (binding_id,organisation_label,identity_sha256,subject_key,status,valid_from,valid_until,tenant_id,organisation_id) ON nofries.dashboard_identity_bindings TO nofries_dashboard_subject_reader;
GRANT SELECT (case_id,tenant_id,organisation_id) ON nofries.dashboard_onboarding_cases TO nofries_dashboard_subject_reader;

GRANT SELECT (capability_sha256,case_id,tenant_id,organisation_id,status,accept_before) ON nofries.dashboard_onboarding_cases TO nofries_dashboard_capability_reader;

GRANT SELECT,INSERT ON nofries.dashboard_runtime_instance,nofries.dashboard_admission_authorities,nofries.dashboard_admission_decisions,nofries.dashboard_runtime_receipts,nofries.dashboard_runtime_audit TO nofries_dashboard_maintenance;

GRANT UPDATE (revision,restore_epoch,ingress_status,changed_at,evidence_ref,evidence_sha256,record_sha256,head_receipt_id) ON nofries.dashboard_runtime_instance TO nofries_dashboard_maintenance;
GRANT UPDATE (head_revision,head_sha256,status,updated_at) ON nofries.dashboard_admission_authorities TO nofries_dashboard_maintenance;
