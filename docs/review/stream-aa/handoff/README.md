# Sample campaign handoff at 375 × 844

Each campaign landing linked to its sample section. From there Chromium followed **Start your free assessment** and **Talk to us** in separate fresh tabs. The login and signup clients navigated to Results using a synthetic completed account state. Contact read the campaign without sending an enquiry.

| Entry | First section on Results | Contact heading |
| --- | --- | --- |
| Board | Summary for your board or insurer | 90-day managed security |
| Insurance and supplier questionnaire | Answers for your insurer or customer questionnaire | 90-day managed security |
| Invoice scams | Check payment changes safely | 90-day managed security |
| Direct sample, fresh tab | Suggested follow-ups | Talk to No Fries |
| Board after a scam-tagged sample in the same tab | Check payment changes safely | 90-day managed security |

[Sample actions](sample-actions.png) · [Board Results](board-signup.png) · [Contact](board-contact.png) · [All 12 journeys, paths and stored values](journeys.json)

The fixture intercepted every Chromium request and served local files, a synthetic signup response and a submitted assessment. It rejected external requests and writes. The test checked the campaign at the sample and destination, the outbound URLs and referrers, and viewport overflow. It did not exercise a live identity provider.

The signup and Contact pages came from [#483 at cc44013](https://github.com/Discla1mer/nofries-platform/commit/cc44013dad3c45434dfc79ea72f3cf52f92118d9). Results used [#477 at 50468f9](https://github.com/Discla1mer/nofries-platform/commit/50468f9cf327f30aea22014a776ed49af4145878). To reproduce from the sample checkout with Chromium and Playwright installed:

```sh
NOFRIES_SIGNUP_CHECKOUT=/path/to/483 NOFRIES_RESULTS_CHECKOUT=/path/to/477 \
  node scripts/tests/sample-campaign-browser.cjs /tmp/sample-handoff
```
