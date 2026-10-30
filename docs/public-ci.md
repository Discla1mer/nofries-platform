# Public application checks

The public workflow reports three required checks from standard Ubuntu runners:
application checks, native PostgreSQL checks, and dependency policy. The
`application` check is a gate over four parallel Jest shards (`unit`, each
running its files serially) and a `build` job (evaluations, static and App
Service packaging, syntax). It fails unless every one of those jobs succeeded. It runs for
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

This repository is the primary home for new application branches and pull
requests. The proposed main rule requires a pull request, up-to-date `application`,
`postgres` and `dependencies` checks from GitHub Actions, and resolved review
conversations. It applies to administrators and forbids force pushes and branch
deletion. It requires zero GitHub reviewer approvals, with no Code Owner or
last-push approval gate, so the owner is not required to find a second human or
approve their own pull request. Independent technical/security review remains an
engineering requirement. Settings need owner approval and readback; they have
not been established by a documentation change. Verify appropriate fork-workflow
approval settings separately. Keep the current private Azure release owner and
controls until an exact source, identity, recovery and exclusive-deployer handoff
is qualified. Do not consume arbitrary fork artifacts or introduce a privileged
workflow that runs their code.

New application development here uses public standard compute for these three
jobs. Avoid mirrored development pushes to both repositories. If a release is
needed before the deployment handoff, the private release owner can review a
frozen source snapshot while preserving all private gates; that is not a second
feature-development stream. Private workflows still run when triggered, and
private deployment, live provider evaluation, recovery, artifact storage and
existing retention costs remain separate. No private check was disabled or
skipped by this handover. The target is to reuse the qualified release controllers
here after the explicit deployment handoff, without a permanent synchronization
service. Public development and Azure deployment are separate milestones.
