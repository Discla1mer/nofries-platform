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
// LENA-R17-03 (#733) updates the compared dataset's DOM and requests digests: the
// board summary now reads the previous submission once and says it supersedes it,
// with the changed answers. Models and actions are unchanged; the other datasets
// have one submission and are unchanged.
// #719 updates the three single-result DOM digests: "Change over time" gains one
// sentence on what a second assessment is for, and the Actions card's empty line
// names saved plan actions when gaps are listed above it. The compared, draft-only
// and empty datasets are unchanged, as are all models, requests and actions.
// #657 (owner decision, 28 Nov 2026) updates the four DOM digests that show the
// "Next step" offer: it now states the 90-day price and its two links are no
// longer wrapped in the details gate. Models, requests and actions are unchanged.
// The No Fries steer (owner direction, 28 Nov 2026) then adds one "No Fries can
// help you fix any of these." line above the gap list in the same four digests.
// #724 updates the empty-organisation DOM digest only: the third first-use step
// says "your top gaps" (it said "top three", which #727 retired). The other
// datasets, and all models, requests and actions, are unchanged.
// #655 adds the board report preview to the four result-bearing DOM fixtures.
// Model, network and Actions digests (and the two non-result DOMs) are unchanged.
const EXPECTED_V1 = {
    "mixed single result": {"dom": "6cb30b993507c81f3dc1bee0a899c5c4c036a6d1de9779803cbb5e088994f99a", "models": "1090aaaa9a72e144276c87fbf806f98258434689b118da98fff5587466657317", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "three results and a draft, compared": {"dom": "892d2844ab59e698e0474865eb0c47c24e675ba7154ae2922258c8629260d691", "models": "4b41f9a9893a8523e0efd203626b5b51a21332e766a8385320879abf5237386b", "requests": "845dc7275fade1a166f73f9517ca9da94f526f1932a61d894e605e4d8d7921ef", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "draft only": {"dom": "19dd2dc08b683324e28380d0a1177718b211998f359c59bfa7e1a5bcb3cc2bc1", "models": "2772bcc0d42c03eee0cc71978e76ca33cba06678d81d480bce411aae65809881", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "empty organisation": {"dom": "734b45471d4a76a6041a953e2f32e343601cd409506924d73b9c9a44ee2bfbb7", "models": "3780390742e7759777266b571cc73e3936831d9932af25d137babd5ca79c5934", "requests": "9d958ad5c85eeed7346a66959c79d22e6c4551a3b2f3a623487e26109fa09d0c", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "mostly unknown, with actions and plan links": {"dom": "74c7d11129bffec7967fa9002bf4d95876ce1415713d944d23e5bd1fb2deeb14", "models": "78c602dbc29aad06bbf3e00ca09ea209489ef405838263f7f72d1d8a12b64daf", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "two gaps only": {"dom": "f666b7be483a5a10fe4a69b81ab1bbdbe8845d7decafffac3a4258022a38e420", "models": "19b587b318bcb19a3a828fd9ebac9fc5364dc2a6a982544c2e3fec843c15e3c1", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
};

test('flag off: v1 Overview, Actions summary, client models and requests match the recorded v1 baseline', async () => {
    expect(await renderV1Parity(require('path').join(__dirname, '..'))).toEqual(EXPECTED_V1);
});
