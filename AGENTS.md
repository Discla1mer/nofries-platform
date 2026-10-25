# No Fries public source instructions

Keep application behavior, authentication, authorization, tenant isolation, privacy, audit evidence and recovery guarantees intact. Do not put credentials, customer data, raw operational captures or internal approvals into source, fixtures, logs or pull requests.

Read the relevant code and tests first. Use targeted checks during implementation, then the complete applicable application and native database checks on the final candidate. Do not remove security assertions or turn failing checks into skips. Keep dependency graphs and third-party notices explicit.

This repository has no deployment authority. Public contributions must run without secrets, write tokens, paid-provider credentials or production access. Do not add pull_request_target, privileged workflow_run consumers, dynamic credential loading or deployment actions without a separately reviewed design and explicit owner authorization. Use full-commit-pinned actions, read-only workflow permissions and checkout without persisted credentials.

Keep live releases, infrastructure, account operations and the private release controller separate. A passing public CI run is application evidence, not permission to deploy. Never weaken required checks, review, exact-source binding, tenant isolation, recovery or cost limits to make a change pass.

Follow the scoped rights notice in LICENSE.md. Preserve existing valid grants and third-party licences; do not claim that changing metadata revokes rights.
