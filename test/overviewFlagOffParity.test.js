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
const EXPECTED_V1 = {
    "mixed single result": {"dom": "465b3e97de6b84c0d27f725af4bf566d6af7ef023ed07de1d990a6787d184c50", "models": "1090aaaa9a72e144276c87fbf806f98258434689b118da98fff5587466657317", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "three results and a draft, compared": {"dom": "04d530ff0f6ab7fe058afb9013ab4cac6b6a45d5df164fd50396d4026400ba5d", "models": "4b41f9a9893a8523e0efd203626b5b51a21332e766a8385320879abf5237386b", "requests": "d43f4f731927071e22113944f77fab7815125a9a95eeeca12ae1dd079aad1a3b", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "draft only": {"dom": "19dd2dc08b683324e28380d0a1177718b211998f359c59bfa7e1a5bcb3cc2bc1", "models": "2772bcc0d42c03eee0cc71978e76ca33cba06678d81d480bce411aae65809881", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "empty organisation": {"dom": "aa85043d776c6e1f88fc1d969dd33babd1d0ba6865f68ca471ba0d7e51fc7b5d", "models": "3780390742e7759777266b571cc73e3936831d9932af25d137babd5ca79c5934", "requests": "9d958ad5c85eeed7346a66959c79d22e6c4551a3b2f3a623487e26109fa09d0c", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "mostly unknown, with actions and plan links": {"dom": "1a5b31137fc091179ca799203785dc60c8ded20e05bff2313d419faa9c991af8", "models": "78c602dbc29aad06bbf3e00ca09ea209489ef405838263f7f72d1d8a12b64daf", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "two gaps only": {"dom": "87a09ab8b30d7b60b3a6388b98d3d9046595a4e9f736763507367be2e7b8be64", "models": "19b587b318bcb19a3a828fd9ebac9fc5364dc2a6a982544c2e3fec843c15e3c1", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
};

test('flag off: v1 Overview, Actions summary, client models and requests match the recorded v1 baseline', async () => {
    expect(await renderV1Parity(require('path').join(__dirname, '..'))).toEqual(EXPECTED_V1);
});
