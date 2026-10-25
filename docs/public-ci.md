# Public application checks

The public workflow runs three independent jobs on standard Ubuntu runners:
application checks, native PostgreSQL checks, and dependency policy. It runs for
pull requests, pushes to main and manual dispatch. The token is read-only,
checkout does not persist credentials, actions and the database image are pinned,
and no secrets, environments, OIDC tokens, paid providers or deployment jobs are
configured. PostgreSQL uses a disposable service with a synthetic test password.
There is no privileged pull-request trigger, privileged workflow-run consumer,
shared cache or downloadable build artifact for a deployment to trust.

Application checks include the retained unit/integration contracts, mock and
provider-free Promptfoo evaluations, JavaScript syntax, static packaging and an
App Service runtime package/install-closure check. Native checks apply migrations
twice and exercise the retained database, tenant isolation, signup, evidence,
lifecycle and improvement-plan contracts. Tests of private production controllers,
cloud-account configuration and release/recovery workflows remain in the private
repository. This workflow does not qualify a production release.

The consultant reader's frozen-fixture checks remain public. Its prospective
writer/native recovery mode requires the private production schema verifier and
must run in the private checkout; enabling that mode here fails before database
creation. Its private verifier assertion has not been removed or bypassed.

The dependency closure and application runtime source match the admitted source
snapshot. The inherited GHSA-xcx6-jx8p-x3h5 disposition remains exact: only its
reviewed advisory, High severity, package versions, installed paths and report
chains can pass before 2026-10-27 00:00 UTC. All other High/Critical findings and
undispositioned Moderate findings block. The public source fence hashes the
exported source because the private ancestry is intentionally absent. The manifest
digest is pinned in the verifier; the manifest and verifier are excluded from the
file inventory to avoid a circular hash. Changes to either require policy review.
Any source addition, removal or byte change blocks use of that temporary
disposition. Do not regenerate the baseline to admit a change; remediate the
dependency or obtain an explicit, bounded review. This is not an extension of
the exception or authority to deploy.

Protect main with required `application`, `postgres` and `dependencies` checks,
review requirements, restricted direct pushes, and appropriate fork-workflow
approval settings before admitting ongoing contributions. Those repository
settings must be verified by an authorized owner; source alone does not prove
that they are configured. Keep the production release controller private until a
separately reviewed handoff binds a public source commit and successful run to
verified build inputs and recovery evidence. Do not consume arbitrary fork
artifacts or introduce a privileged workflow that runs their code.

Using this repository for application development moves these three jobs to
public standard compute. The private repository's existing workflows continue
when triggered, and private deployment, live provider evaluation, recovery,
artifact storage and existing retention costs remain separate. Avoid creating
mirrored development pushes to both repositories; switching the release source
and retiring duplicate private application checks is a separate reviewed change.
