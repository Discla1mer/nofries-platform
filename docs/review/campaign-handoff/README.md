# Campaign handoff at 375 × 844

Chromium opened each dedicated landing with synthetic Meta labels, clicked **Create a free account**, followed the real external-provider login and signup clients and reached the submitted Results renderer. The loopback server supplied a completed signup state and the submitted assessment from #477’s Stream N fixture. This exercises presentation and navigation without creating an identity, registering an organisation or submitting an enquiry.

| Landing | First Results section | Screenshots |
| --- | --- | --- |
| Insurance | Answers for your insurer or customer questionnaire | [Results](insurance-results.png) · [Contact](insurance-contact.png) |
| Supplier questionnaire | Answers for your insurer or customer questionnaire | [Results](supplier-results.png) · [Contact](supplier-contact.png) |
| Board | Summary for your board or insurer | [Results](board-results.png) · [Contact](board-contact.png) |
| Invoice scams | Payment-check gap and next step | [Results](scam-results.png) · [Contact](scam-contact.png) |

Scam Results supplied the paid Contact link. For Results without that link the browser revisited the original landing in the same tab and clicked its paid CTA. Both paths preserved the service prefill. Landing CTAs retained their existing UTMs. Signup and dashboard destinations stayed clean. Browser routing allowed only loopback GETs, checked signup/dashboard/API queries and referrers for UTM leakage, and rejected request bodies. Synthetic assessment transport reads were checked separately. There was no live IdP round trip.

A clean untagged tab and an unrecognised campaign both showed Suggested follow-ups. Following board in a tab already tagged scam kept the earlier scam presentation. An existing malformed value stayed untouched and produced generic Results. The capture requires a valid source (or the existing Meta click-ID fallback); it normalises only source, medium and campaign. A campaign label alone still stores nothing. The existing contact success path owns clearing.

The [receipt](receipt.json) records the exact dependency snapshots, browser version, per-case paths, stored values and first sections. Q adds no schema, scoring, assessment copy, certification, NCSC approval or insurer acceptance claims. It changes no auth decisions.
