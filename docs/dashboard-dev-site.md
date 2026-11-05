# Synthetic dashboard dev site

This is the smallest persistent review site: the existing eight-scenario dashboard
preview, real `dashboardRegistry.js`, `dashboardShell.js` and `app/dashboard.css`.
It adds a DEV / synthetic-data banner, source commit and Reset preview button.
Navigation and scenario switching stay in memory. Reset restores the first
scenario and Overview; reload also discards state. No customer login, backend,
production URLs, credentials, analytics, operational integrations or storage are
included. The CSP denies connections, form submissions and external assets.

The existing `build-ncsc-questionnaire-preview.js` was inspected. It already
provides in-memory assessment edits, saving and failure scenarios using the real
questionnaire. Those are a separate local fixture, with simulated submission
outcomes. This first persistent artifact does not duplicate or incorporate that
harness. Planned/unavailable modules remain so; it is not an end-to-end sandbox.
The existing local eight-scenario preview already satisfies layout/navigation
review. Hosting, private-access qualification and a repeatable publication path
are the missing parts.

## Build and review locally

From a checkout of the desired source commit, with dependencies installed:

```sh
node scripts/build-dashboard-dev-site.js --output /tmp/nofries-dev-candidate
node scripts/tests/dashboard-dev-site-browser.cjs
```

The output directory must be new, its parent must exist, and it must be outside
the repository (including through symlinks). Existing output is never deleted.
The only files are `index.html`, `staticwebapp.config.json` and
`preview-manifest.json`. The manifest records the full Git commit, dirty status
and SHA-256 of both publishable inputs. Dirty work is labelled `-dirty`; publish
only from a clean frozen checkout. No dependency, workflow, main/release profile
or production packaging changes are required.

The browser check saves desktop/mobile screenshots, navigation/reset results,
request records and CSP probe outcomes outside source. Its loopback server is
only for local inspection; it cannot qualify Azure authentication or routing.

## Proposed Azure resource and access approval

Nothing below has been created, configured, invited or deployed. Proposed names
are subject to availability; the owner must bind the subscription before creation.

| Item | Exact proposed scope / estimated incremental cost |
| --- | --- |
| Resource group | One new `rg-nofries-dashboard-dev`; choose the owner's verified subscription; $0 for the group itself |
| Static Web App | One `nofries-dashboard-dev`, `Microsoft.Web/staticSites`, **Free** SKU, `eastasia` if available in the subscription; Azure hostname and managed TLS; **$0/month hosting** within Free quotas |
| Extra services | None: no App Service plan, Functions/API, database, storage account, Entra app registration, managed identity, custom domain, DNS, Front Door or paid diagnostics |
| Review access | One initial reviewer: Joel's verified GitHub identity, invited to `preview_reviewer` on this app only; no Azure RBAC or repository write access for viewing |
| Publication | An authorized operator's existing session; one deployment token scoped to this new app only, acquired after separate approval and kept outside the public repository/build environment |
| Automation | None in this change. Manual publication has no additional Actions compute/storage charge; a private automated publisher needs a separate design and cost approval |

Verify the region, subscription Free-app quota and available bandwidth before
creation. Microsoft lists 10 Free apps per subscription, 100 GB/month shared
bandwidth, 250 MB per deployment, and 25 invited users with custom roles. Free
has no SLA or paid overage; quota exhaustion can stop serving. No automatic
upgrade is proposed. [Pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/static/)
and [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas), checked
5 November 2026. Existing production costs are unaffected.

Use the existing authorized resource owner; no new RBAC assignment is proposed.
Creation uses resource-group creation permission and `Microsoft.Web/staticSites/Write`
on the new group. Readback uses `staticSites/Read`; token retrieval uses
`staticSites/listsecrets/action`. Review enrollment uses
`staticSites/createinvitation/action`, `staticSites/listConfiguredRoles/action`
and `staticSites/authproviders/listusers/Action`; revocation uses
`staticSites/authproviders/users/Delete`, on this app only. All `staticSites`
actions here have the `Microsoft.Web/` prefix. If current owner access is
insufficient, stop for a separately scoped role design; do not grant subscription
Contributor/Owner or pass management credentials to a candidate build.
[Azure permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/web-and-mobile).

Private review requires a hosting access gate, separate from No Fries login.
The prepared config uses Azure's preconfigured GitHub provider and an invitation
to `preview_reviewer`; merely being `authenticated` is insufficient. All content,
including the manifest and direct `index.html`, is behind the final wildcard
role rule. Only `/.auth/*` is public for provider callbacks/invitations; Entra
sign-in is blocked, `/api/*` returns 404 and there is no fallback rewrite.
This is an internet-facing, invitation-restricted site, not a private network
endpoint. Free supports the former; private endpoints require Standard.
[Authentication](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-authorization),
[roles](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-custom#manage-roles),
[configuration](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration)
and [plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans).

## Publication and later updates (separate approval)

1. Approve the subscription, isolated group/app, Free-only cost ceiling, hosting
   sign-in/provider, verified reviewer identity and app-scoped token handling.
   Confirm framework/source licensing permits this private review use.
2. Create the app with source **Other**, without GitHub repository integration,
   generated workflows, linked APIs or application settings. No production
   resource, DNS, account or release/recovery controller changes.
3. In an unprivileged clean checkout, build the owner-selected full commit and
   run the targeted checks. Record manifest and SHA-256 of the config; independently
   check the role rule and deny-by-default CSP before publication. Keep candidate
   code and its build scripts away from cloud credentials. Do not consume arbitrary
   PR artifacts in a privileged job or run PR-provided scripts with a token.
4. Transfer only the three reviewed static files to a trusted operator context;
   verify digests there. Use a pinned, reviewed SWA CLI deployment client with an
   app-only token, no build/API step, to publish to this dev app's default
   environment. Azure calls that environment `production`; it is **not** the No
   Fries production resource. This manual command/client pin is selected during
   the separately authorized publication, not by an untrusted candidate.
5. Verify before inviting: anonymous and signed-in-but-uninvited requests cannot
   read `/`, `/index.html`, `/preview-manifest.json` or alternate encoded paths;
   `/api/dashboard` is denied; CSP and no-store headers match. Then issue a
   short-lived invitation for Joel only and verify allowed review, logout and
   removal/revocation. Invitations are identity-bound; do not publish their URLs.
6. Confirm the hosted commit, desktop/mobile navigation/reset and zero application
   network requests after the hosting sign-in. Retain the previous approved bundle
   outside the public repo for rollback; redeploy those exact bytes if necessary.

Once this publication policy is approved, updating the dedicated dev site can
use a selected clean feature-branch commit without merging main or running the
production release process. The small preview checks protect this dev artifact;
they do not replace ordinary required checks for a later production merge.
Automatic feature-branch publication is not included or authorized here.
