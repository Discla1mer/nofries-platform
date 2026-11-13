# Try No Fries: fictional interactive demo (#29)

The real signed-in dashboard, running in the browser for a made-up business. Visitors use the same full 14-question Cyber Security assessment, review and submit, and results that clients see. The banner links to "Create your account" (`/login?intent=create`), `/contact.html` and the homepage. The static site publishes it at `/try` as an unlisted, noindex page; it is not linked from the homepage.

    node demo/try/serve.js    # http://127.0.0.1:3000/try; browser check: node scripts/tests/try-demo-browser.cjs

- **Same code as clients:** `document.js` embeds the dashboard's protected assets unchanged (shell, questionnaire client and questionnaire). It also bundles the server's questionnaire metadata and ENG-003 evaluator unchanged, so results come from the real scoring rules. `node-shims.js` supplies browser versions of the three Node built-ins they use (SHA-256, UTF-8 length, `isProxy`). Changes to those files reach the demo with no demo edits; `test/tryDemo.test.js` checks the results match the server path.
- **Data:** a fictional business, Brightwater Joinery. `try-demo.js` holds that data and an in-memory stand-in for the assessment API. It uses no `test/fixtures` and no development preview. The Improvement Plan and other modules show as "Coming next".
- **Isolation:** the page CSP forbids every request, form submission, frame and image, and the assessment API is answered in memory. No sign-in, cookies, emails, AI or provider calls. Answers are kept as a replayable log under the `nofries.tryDemo.v2` browser-storage key; **Reset demo** removes only that key.
- **Publishing:** `build-static.js` writes `app/try.html`, and the `/try` Static Web App route carries its hash-bound CSP (`/app/*` stays redirected). The App Service never packages `demo/`; `server.js` serves it only for `createNoFriesApp({ tryDemo: true })`.
