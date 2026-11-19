# Meta ad landing pages

Full-page Chromium captures at a 375 × 900 CSS-pixel viewport, with synthetic UTM
parameters. These pages contain no customer data. Images are review evidence and
are not included in the public application bundles.

Regenerate from the repository root:

```sh
node scripts/build-static.js
NOFRIES_AD_SCREENSHOTS=docs/evidence/meta-ad-landings node scripts/accessibility/public-pages.cjs
```

The existing browser suite checks all four pages at 320, 375 and 1280 pixels and
100%/200% text. At 375px it checks every link, retained UTMs, sign-in intent,
the managed-security service key and empty cookies/local/session storage.
Local captures used `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.

Text over the existing paper texture needs manual contrast review; axe reports
that as incomplete. These screenshots do not exercise identity-provider sign-in
or submit contact enquiries.
