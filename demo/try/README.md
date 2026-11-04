# Try No Fries: fictional interactive demo (#29)

**Not live.** A self-contained page for exploring the real dashboard renderer and a six-question sample assessment before creating an account.

    node demo/try/serve.js    # http://127.0.0.1:3000/try, loopback only
    node scripts/tests/try-demo-browser.cjs

- **Data:** a fictional business, Brightwater Joinery. All data is in `try-demo.js`, and the questions were written for this demo. It uses no `test/fixtures`, no development preview and no framework text.
- **Isolation:** the page CSP forbids every request, form submission, frame and image. The demo has no sign-in, cookies, emails, AI or provider calls. **Reset demo** removes only the `nofries.tryDemo.v1` browser-storage key.
- **Default-off:** the route exists only for `createNoFriesApp({ tryDemo: true })`. Neither production builder packages `demo/`.
- **Going live** is an owner decision for a separate PR: package `demo/`, add a Static Web App route with this CSP, link it from the homepage and decide on indexing.
