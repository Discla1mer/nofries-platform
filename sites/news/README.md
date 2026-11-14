# No Fries News source mirror

This directory holds the static source mirror for `https://news.nofries.nz/`.
It is separate from the No Fries dashboard's public asset registry and is not
served or deployed by the dashboard application build.

## 10 November 2026: matches the live page; News is being retired

`dist/index.html` is the live page as published on 26 October 2026 (SHA256
`b16f2f6e1d3bb1d4cd7ad4f8b32c3babb611392195026fa9166027e5634311ef`, with the
hosting provider's injected challenge script removed). `dist/style.css` is
the live stylesheet. The unpublished "What's new." edit proposed on
9 November was withdrawn: the owner decided to retire News, and nofries.nz
no longer links to it. Do not publish this directory as an update.

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
