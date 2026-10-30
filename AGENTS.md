# No Fries public source instructions

Keep application behavior, authentication, authorization, tenant isolation, privacy, audit evidence and recovery guarantees intact. Do not put credentials, customer data, raw operational captures or internal approvals into source, fixtures, logs or pull requests.

Read the relevant code and tests first. Use targeted checks during implementation, then the complete applicable application and native database checks on the final candidate. Do not remove security assertions or turn failing checks into skips. Keep dependency graphs and third-party notices explicit.

This repository has no deployment authority. Public contributions must run without secrets, write tokens, paid-provider credentials or production access. Do not add pull_request_target, privileged workflow_run consumers, dynamic credential loading or deployment actions without a separately reviewed design and explicit owner authorization. Use full-commit-pinned actions, read-only workflow permissions and checkout without persisted credentials.

Keep live releases, infrastructure, account operations and the private release controller separate. A passing public CI run is application evidence, not permission to deploy. Never weaken required checks, review, exact-source binding, tenant isolation, recovery or cost limits to make a change pass.

Follow the scoped rights notice in LICENSE.md. Preserve existing valid grants and third-party licences; do not claim that changing metadata revokes rights.

## Delivery rules

The goal is small changes that reach main quickly. The security rules above still apply in full.

- One pull request delivers one user-visible change or one fix. Aim for under 500 changed lines, excluding lockfiles and generated fixtures. If a change needs more, split it into PRs that each leave main working, using a default-off flag where needed.
- Branch from current main. Do not open "composition", "integration" or "union" PRs that combine other open PRs. If two PRs conflict, land one, then rebase the other.
- Do not open draft PRs as a holding area. Open a PR when it is ready for review; close it if the work is abandoned or superseded, naming the replacement.
- Done means: required checks green on the exact head, and the PR description below is filled in. Merge and release decisions belong to the owner.
- Keep PR descriptions under 200 words using the template in `.github/pull_request_template.md`. Put test counts and run links on one line each. Do not restate governance, holds or activation prerequisites in every PR; link the issue instead.
- If CI fails, fix the cause or report it in five lines or fewer on the PR. Do not write diagnostic essays, rerun repeatedly, or work around a failing check.
- Work comes from GitHub issues. Reference the issue (`Fixes #n`) and stay within its scope. Note follow-up ideas as new issues rather than expanding the PR.
