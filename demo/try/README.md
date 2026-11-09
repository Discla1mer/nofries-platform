# Try No Fries: fictional interactive demo (#29)

**Not live.** A self-contained sales demo of the real dashboard renderer and a six-question sample assessment, ending in a call to action to `/contact.html`. Going live is a separate PR.

    node demo/try/serve.js    # http://127.0.0.1:3000/try; browser check: node scripts/tests/try-demo-browser.cjs

- **Data:** a fictional business, Brightwater Joinery. All data is in `try-demo.js`, and the questions were written for this demo. It uses no `test/fixtures`, no development preview and no framework text.
- **Isolation:** the page CSP forbids every request, form submission, frame and image. The demo has no sign-in, cookies, emails, AI or provider calls. **Reset demo** removes only the `nofries.tryDemo.v1` browser-storage key.
- **Default-off:** the route exists only for `createNoFriesApp({ tryDemo: true })`. Neither production builder packages `demo/`.
