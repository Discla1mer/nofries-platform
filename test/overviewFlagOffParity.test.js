'use strict';

// Scoring v2 (#399), browser slice 2. With NOFRIES_NCSC_PROFILE_V2 unset the
// server sends no further profiles, so Overview, its Actions card and the
// bounded client must behave exactly as on main. These digests were recorded by
// running test/fixtures/overviewParity.js against main at 40f3432 (before the v2
// Overview change). The rendered DOM (text, classes, attributes, hidden state,
// values), the client's validated models, the requests sent and the Actions
// summary are compared for six accepted-profile datasets, including a trend
// comparison, a draft, an empty organisation and an Actions card.
//
// To refresh after an intended v1 change, run renderV1Parity on a checkout of
// main and on this tree, and update the digests only when the change is meant.
const { renderV1Parity } = require('./fixtures/overviewParity');

// #480 changes only visible Not applicable wording. The four affected DOM digests
// were checked against d2e2503. Stream I updates the same four DOM digests for
// the central Pricing link in Results. Compared against 711cea6: removing just
// the offer subtree gives identical DOM for all six datasets. Model, action and
// request digests are unchanged and still come from 40f3432.
// #607 updates five Overview DOM digests against c22aa1c for the intended copy and chips.
// Client models, Actions, requests and the empty Overview match main in all six cases.
// #604 updates the four result-bearing DOM digests for the gauge and
// answer-mix charts: with just the chart nodes removed, all six DOM digests
// match the previous baseline. Other digests are unchanged.
// #603 (function rings and Overview illustrations) updates the DOM digests only:
// the ring is added beside each existing bar and the first-use panel gains a
// decorative image. Model, request and action digests are unchanged.
// #639 updates the four result-bearing DOM digests for one sentence on the Answers
// confirmed card ("still to confirm" no longer appends "including 0 answers marked
// not applicable, to confirm"). It is the only source change; other digests are unchanged.
// #643 updates three DOM digests: "Suggested follow-ups" now list accepted-profile
// gaps in the top-gaps order (tier, then No before Partial) with a matching caption.
// "Two gaps only" has no reordering, so its digest is unchanged, as are all models,
// requests and actions.
// RANGI-13 (#644) updates the four result-bearing DOM digests: each top-gap
// "What to do next" now shows the first specific check instead of restating the
// question. Models, requests and actions are unchanged.
// M1-13 board summary: the four result-bearing DOM digests change because the
// copyable board summary now opens with "What needs attention first" (the
// on-screen top gaps). Models, requests and actions are unchanged.
// M6-01 (#731) updates only the compared dataset's DOM digest: Compare now shows
// one comparability message (no separate "same questions and weights" footnote)
// and lists the answers that changed. Models, requests and actions are unchanged.
const EXPECTED_V1 = {
    "mixed single result": {"dom": "a06aa3e8357f76d222794a4e72fb0c2c698414652c2b99b498aaa21b3598098c", "models": "1090aaaa9a72e144276c87fbf806f98258434689b118da98fff5587466657317", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "three results and a draft, compared": {"dom": "29885cffc6fd394910f37e090583e3cc249aae5262be8c28a22c27b91d9a593d", "models": "4b41f9a9893a8523e0efd203626b5b51a21332e766a8385320879abf5237386b", "requests": "d43f4f731927071e22113944f77fab7815125a9a95eeeca12ae1dd079aad1a3b", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "draft only": {"dom": "19dd2dc08b683324e28380d0a1177718b211998f359c59bfa7e1a5bcb3cc2bc1", "models": "2772bcc0d42c03eee0cc71978e76ca33cba06678d81d480bce411aae65809881", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "empty organisation": {"dom": "aa85043d776c6e1f88fc1d969dd33babd1d0ba6865f68ca471ba0d7e51fc7b5d", "models": "3780390742e7759777266b571cc73e3936831d9932af25d137babd5ca79c5934", "requests": "9d958ad5c85eeed7346a66959c79d22e6c4551a3b2f3a623487e26109fa09d0c", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "mostly unknown, with actions and plan links": {"dom": "f2fd998c994a6cf51899734153edbdd7960c85928bda22c3ffaa161c1db072d5", "models": "78c602dbc29aad06bbf3e00ca09ea209489ef405838263f7f72d1d8a12b64daf", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "two gaps only": {"dom": "d2ff7fe033f9600aaf079fb265c64a4c2e9d2d4fc9545ffdaa1a37719ca2f942", "models": "19b587b318bcb19a3a828fd9ebac9fc5364dc2a6a982544c2e3fec843c15e3c1", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
};

test('flag off: v1 Overview, Actions summary, client models and requests match the recorded v1 baseline', async () => {
    expect(await renderV1Parity(require('path').join(__dirname, '..'))).toEqual(EXPECTED_V1);
});
