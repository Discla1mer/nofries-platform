# Try No Fries: fictional interactive demo (#29)

A self-contained sales demo of the real dashboard renderer and a six-question sample assessment, ending in a call to action to `/contact.html`. The static site publishes it at `/try` as an unlisted, noindex link for sales to share; it is not linked from the homepage.

    node demo/try/serve.js    # http://127.0.0.1:3000/try; browser check: node scripts/tests/try-demo-browser.cjs

- **Data:** a fictional business, Brightwater Joinery. All data is in `try-demo.js`, and the questions were written for this demo. It uses no `test/fixtures`, no development preview and no framework text.
- **Isolation:** the page CSP forbids every request, form submission, frame and image. The demo has no sign-in, cookies, emails, AI or provider calls. **Reset demo** removes only the `nofries.tryDemo.v1` browser-storage key.
- **Publishing:** `build-static.js` writes `app/try.html`, and the `/try` Static Web App route carries its hash-bound CSP (`/app/*` stays redirected). The App Service never packages `demo/`; `server.js` serves it only for `createNoFriesApp({ tryDemo: true })`.
