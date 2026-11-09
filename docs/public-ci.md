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

## Reconciliation with early checks and timing-based scheduling

PR #13 changes application scheduling only. The reviewed workflow bytes and
inactive handover profile remain unchanged by the current-main refresh onto
`15f43e6d49523eb3a9f8c9d5aeac5c874542c462`. Public main at the first timing run
was `c884799bbb36b0c915988a91219119be335af2b8`.
Private #715 already admits
this exact four-shard workflow digest. This is not permission to change that
digest or the private release profile.

PR #41 now adds a separate PR-only isolated production-install check. It installs
and loads real App Service/API dependencies; it does not modify this workflow,
its required `application` aggregate, or its handover pins. PR #54 remains the
separate fresh release-policy audit and fast build/offline-install-planning check.
Neither lane repeats the full Jest suite. The ordinary build job retains its
existing offline install-closure check to preserve the reviewed workflow bytes;
removing that small overlap requires a separately coordinated profile change.
No shared build artifact or deployment authority is introduced.

PR #26 changes the Jest setup and `package.json` digest, without changing either
lockfile. The private controller already recognises that package with this
four-shard workflow. PR #63 changes runner labels and therefore the workflow
digest: land and qualify #13 first, then rebase #63 and review its resulting
workflow profile separately. Do not fold its labels into #13's admitted bytes.

`test/publicCiSharding.test.js` compares ordinary Jest discovery with all four
actual shard commands, requiring a disjoint and complete union. It also runs
the aggregate shell for every success/failure/cancelled/skipped combination and
checks that the build retains every non-Jest verification command.

Npm caching is not added: current hosted installs take seconds, so archive
restore/save overhead must be measured before claiming a benefit. The dependency
job audits lockfiles without an `npm ci`; it would gain no installation saving.
Promptfoo uses local mock providers and retains `--no-cache`, so each run
executes the provider regression instead of reusing previously computed output.

Private #724 weights its two shards using recorded private-suite durations.
Those weights describe a different suite inventory and are not copied into the
public repository. Public #13 keeps Jest's exact four-way discovered-file split
and serial execution within each shard. The historical public longest shard was
4m44s while PostgreSQL took 12m10s, so further shard balancing alone would not
shorten that observed workflow. Collect public timings before considering it.

### Historical timing baseline

Measure workflow wall time from creation to the last job's completion, and report
queue-inclusive elapsed time separately from job execution. These are individual
hosted samples, not a controlled benchmark or an SLA.

| Candidate | Run | Result | Workflow elapsed | Longest application work | PostgreSQL |
| --- | --- | --- | --- | --- | --- |
| Current main, serial | [41430367627](https://github.com/Discla1mer/nofries-platform/actions/runs/41430367627) | success | 28m17s | application 28m11s | 14m11s |
| Existing #13, four shards | [41512403215](https://github.com/Discla1mer/nofries-platform/actions/runs/41512403215) | success | 12m14s | longest shard 4m44s; aggregate completed at 5m08s | 12m10s |
| Existing #41, serial plus real installs | [41375710711](https://github.com/Discla1mer/nofries-platform/actions/runs/41375710711) | success | 19m59s | application 19m56s; isolated install step 6s | 14m22s |

For #13 the observed total reduction was 16m03s (57%); different run times and
runner variance prevent attributing all of it to sharding. The refreshed heads
and their automatic CI measurements are recorded on private #686 and the PRs.
The old #41 result is from its earlier base, so it is not a current-main
before/after causal comparison.
