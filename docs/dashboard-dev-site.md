# Synthetic dashboard dev site

This static review site retains eight layout scenarios and adds a default Cyber
practice scenario using the real dashboard, questionnaire and CSS. Its DEV banner
identifies the source commit and the limits of every simulated save/submit.

Practice uses the existing `build-ncsc-questionnaire-preview.js` in-memory
transport. Create, edit, Save, leave and reopen work within the current scenario
mount. Submit seals the practice answers; **it does not calculate a score**.
Overview shows answer counts for the selected practice assessment. Improvement
Plan shows question-order follow-up guidance from those same answers, not saved
actions, assignments, verified evidence, risk rankings or control outcomes.

“Review seeded example results” opens a separate, explicitly labelled fixed case,
unrelated to entered answers. The actual Node evaluator and plan domain compute
it at build time. The real results and read-only Improvement Plan renderers display
those bound fixtures; no browser scoring shim or evaluator parity is claimed.

Reload, Reset or changing scenario clears all practice work, including simulated
saves and submissions. Reopening the site starts empty. The site persists; user
work does not. Reset's announcement makes no claim about the subsequently viewed
page. Other planned workspaces remain placeholders. Source and download links are
reference-only in this offline preview. No customer signup/login, backend, mail,
production traffic, credentials, integrations or browser storage are included.
The existing hosting authentication, `/api/*` block and connection-denying CSP
remain intact; only content-dependent CSP hashes change.

## Preview appearance

A scoped ivory-and-gold stylesheet adds serif heading hierarchy, quieter card
shadows, a heading rule and a clearer active workspace indicator. It is included
only in this synthetic renderer; production styles and application behavior are
unchanged. Native CSS paint needs no image requests, external fonts or new CSP
permissions. Decorative effects are removed for print and forced colors.

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
Graphics checks cover forced-colors focus, print resets, 200% text enlargement
and an equivalent half-width zoom reflow. Actual browser zoom remains a manual
check; these emulations do not change the browser zoom setting.

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
