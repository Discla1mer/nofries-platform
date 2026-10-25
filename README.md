# No Fries

No Fries is a dashboard and managed-IT application. This is the primary repository for new application development and ordinary CI. It contains the application, connector, database, public assets and deterministic development checks. It has no production credentials or public deployment workflow.

Commercial reuse rights are reserved only where No Fries owns and retains those rights. Existing valid ISC grants and third-party licences remain effective. See LICENSE.md and THIRD_PARTY_NOTICES.md. Package privacy flags prevent accidental npm publication; they do not determine GitHub visibility.

Use Node.js 24.19.0 (the source minimum is 22.22.0). Install the committed dependency graph with `npm ci --ignore-scripts --omit=optional --audit=false`, then run `npm run verify` and `npm run eval:prospect:promptfoo`. The latter is deterministic and does not require an OpenAI key. Build the App Service package with `npm run build:app-service`.

Native PostgreSQL cases require a disposable local database and `NOFRIES_TEST_DATABASE_URL`. Never point tests at a live database. Optional browser/native gates remain explicit and are reported separately from ordinary unit checks.

Create product branches and pull requests here, following CONTRIBUTING.md and docs/public-ci.md. Avoid mirroring each development push into the private repository. The existing private controller remains responsible for Azure releases, infrastructure, recovery and private operational work until its separately reviewed handoff is complete. A passing public CI run does not deploy or authorize customer operations. No private required check has been retired by this development handover.

The repository contains public-facing product copy, supplied No Fries artwork and attributed framework material. Those assets do not imply permission to reuse trademarks or material outside its applicable licence.
