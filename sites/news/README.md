# No Fries News source mirror

This directory holds the static source mirror for `https://news.nofries.nz/`.
It is separate from the No Fries dashboard's public asset registry and is not
served or deployed by the dashboard application build.

## 9 November 2026: News announces, the Roadmap tracks status

This mirror was first brought up to date with the live 26 October 2026 page
(the hosting provider's injected challenge script removed). It then makes
News an announcements page and leaves status to the Roadmap:

- The heading is "What's new." (no longer "What's new. What's next.").
- The "What the labels mean" status legend is replaced by a pointer to the
  product roadmap. Post labels show status when each post was published.
- The header and footer link to the Roadmap.
- `style.css` adds one rule for the pointer's paragraph.

Dated posts are unchanged. These edits are **not published**: upload both
`dist/index.html` (SHA256 `3cfc9840bdcf1cebbf1baf68ae48c29277da6c19364d61f8e08264f1e34237fc`) and `dist/style.css` (SHA256 `d7585c2473fa580c1b64ebf5ec3523345a5a35b274fd0b92f8a766d277077758`)
through Sites after checking the live page has not changed since 26 October.

## Earlier history

The 21 October 2026 mirror includes Joel's approved enquiry-first NCSC-aligned
review offer and explicitly optional dashboard access. Its HTML matches the
published News version 9 (Site source
`a32629c9af4ab81b4b55e22e6d90c38b9aaf5544`), verified byte-for-byte after
publication. HTML SHA256:
`668144031edb9d80972b632363be074dd5a356f4d954dbda4a832aa47f88a881`. Before that addition, it reconciles the newer live 19 October
News version 8, preserving its promo, existing-Company-account qualification,
shorter historical posts, contact destinations and responsive styles. The
existing logo remains unchanged. `dist/style.css`, the promo video and its
poster are byte-identical to the existing public assets observed on 21 October.
The HTML preserves the historical articles with only the previous featured and
latest-update markers moved to the new offer. The offer links the verified live
`https://nofries.nz/roadmap.html` route; the roadmap source update has a separate
dashboard release path.

News was published separately through Sites. The dashboard roadmap remains
a separate source/release outcome; committing this mirror does not release it,
configure billing or establish usable customer access. Preserve any later Site
owner edits: recheck the live version and source before applying the reviewed
changes. Do not upload this directory over a newer Site without reconciliation.

Hosting project metadata stays with the existing Site owner and is omitted
from this mirror. No credential belongs here. Future mirrors should retain the
reviewed Site source and its required assets together. External Site publication
is owned and verified separately from dashboard release.
