# Contributing

This repository is published for inspection. Before contributing new material, agree its ownership and licence with the maintainer. Do not assume a blanket permissive licence or that a pull request assigns copyright.

Use this repository for new application changes: create a branch from current main, open a pull request here, and wait for the exact candidate's `application`, `postgres` and `dependencies` checks. Keep review and validation evidence with that change. Do not mirror ordinary feature branches into the private operational repository.

Describe the problem, behavior change, affected trust boundaries and validation. Use synthetic data. Preserve authentication, authorization, tenant isolation, audit and recovery guarantees. Run targeted tests while iterating and all applicable final application/native checks before review. Do not alter required-check policy or dependency exceptions as an incidental fix.

The proposed main protection requires a pull request and current passing checks, with zero required GitHub reviewer approvals for this one-person programme. It adds no Code Owner or last-push approval gate. Applicable independent technical/security review remains part of the engineering process; it is not an extra-human or self-approval requirement. Protection settings still require owner approval and verified application; this document does not establish that they are active.

Public CI has no deployment credentials or paid-provider access. Deployment and operational changes require separate review and owner authorization. A merge must not automatically deploy. Do not submit secrets or personal/customer operational evidence in issues, logs, attachments or source.
