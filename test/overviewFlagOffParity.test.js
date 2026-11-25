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
const EXPECTED_V1 = {
    "mixed single result": {"dom": "bf6b18fa1191f24eefe3e4210340baaca30462fe9143e935940c01d921c7c5ce", "models": "1090aaaa9a72e144276c87fbf806f98258434689b118da98fff5587466657317", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "three results and a draft, compared": {"dom": "13db75ec9ef9b0b3698251fa04368dde7cf7f72f4cb0da6252d6d80ef0abf92d", "models": "4b41f9a9893a8523e0efd203626b5b51a21332e766a8385320879abf5237386b", "requests": "d43f4f731927071e22113944f77fab7815125a9a95eeeca12ae1dd079aad1a3b", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "draft only": {"dom": "19dd2dc08b683324e28380d0a1177718b211998f359c59bfa7e1a5bcb3cc2bc1", "models": "2772bcc0d42c03eee0cc71978e76ca33cba06678d81d480bce411aae65809881", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "empty organisation": {"dom": "b9aac7ee3305933a8735d17a85944b5d30df968dc230ed282e1346f28b03e851", "models": "3780390742e7759777266b571cc73e3936831d9932af25d137babd5ca79c5934", "requests": "9d958ad5c85eeed7346a66959c79d22e6c4551a3b2f3a623487e26109fa09d0c", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "mostly unknown, with actions and plan links": {"dom": "f218409ac6a7a88455d1f19ade98f91afa359bd4be3f494f27fd35935f0bcc0a", "models": "78c602dbc29aad06bbf3e00ca09ea209489ef405838263f7f72d1d8a12b64daf", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
    "two gaps only": {"dom": "5b4177e28034afad7fa81ba9828a08dd331794a74f64e5f1f6954cafc9fa0f71", "models": "19b587b318bcb19a3a828fd9ebac9fc5364dc2a6a982544c2e3fec843c15e3c1", "requests": "0bc62d8a75163b4c0cbd9eae4bf23d3fb1075fc46f1296b9ca669d132522ccbe", "actions": "382ab69c2c7db231fb94b554071fa910bb4e87756ba47d29547221a5d5dc3118"},
};

test('flag off: v1 Overview, Actions summary, client models and requests match the recorded v1 baseline', async () => {
    expect(await renderV1Parity(require('path').join(__dirname, '..'))).toEqual(EXPECTED_V1);
});
