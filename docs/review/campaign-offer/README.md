# Campaign offer at 375px

Each image shows the dependency snapshot (left) and the proposed change (right). The top row shows the public landing offer. The bottom row shows the service offer in submitted Results. All captures used Chromium at 375 × 844 with synthetic data.

[Invoice scams](scam.png) · [Insurance](insurance.png) · [Supplier questionnaires](supplier.png) · [Board reporting](board.png)

The baseline combines #481 at `013796b40fa6b7cc15cbb800c42fc6754faf5ccb` and #484 at `a4206c2bb83737e62190e356e33f9d2c8193613e`. The four tagged landing bodies and eight tagged Results fixture cases each differ from baseline by one paragraph. Untagged and unknown Results have identical panel HTML and identical screenshots across revisions.

Results used the submission flow in `scripts/tests/stream-n-browser.cjs`, including an unknown payment answer and representative-details gates. The fixture checks section order, enquiry links, keyboard copy, board print, session storage and request counts. The landing comparison loaded each real page with its corresponding campaign parameters, checked viewport overflow and compared rendered body HTML.
