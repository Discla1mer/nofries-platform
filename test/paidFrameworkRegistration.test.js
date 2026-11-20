'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');
const { parsePaidRoute, prepareRequest } = require('../api/shared/assessmentLifecycle/paidAssessments');

test('the reserved ISO route reads only its exact packaged publication', () => {
    const route = parsePaidRoute('frameworks/nf-iso-27001-2022-readiness/2026-11-19.1/assessments');
    const read = () => prepareRequest(route, undefined, null);
    if (existsSync(path.join(__dirname, '../api/shared/assessmentEngine/iso27001FrameworkProfile.js'))) {
        const { profile, profileRef } = read();
        expect(profile.questions).toHaveLength(116);
        expect(profileRef).toEqual({
            frameworkId: 'iso-iec-27001', frameworkVersion: '2022',
            profileId: route.profileId, profileVersion: route.version,
            catalogueSha256: '88b628987e8117690de70b7be04ddeb60de95cbe27fd96d4353f7107a2758124',
            sourceCatalogueSha256: 'b6b39634dbaf1060b655e99f296dbfcbae1a3b035120ffb2badd5321483b5973'
        });
    } else expect(read).toThrow(expect.objectContaining({ code: 'framework_not_found', statusCode: 404 }));
    expect(() => prepareRequest({ ...route, version: 'latest' }, undefined, null)).toThrow('framework_not_found');
});
