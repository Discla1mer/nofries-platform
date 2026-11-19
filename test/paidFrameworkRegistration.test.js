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
        expect(profileRef).toMatchObject({ frameworkId: 'iso-iec-27001', frameworkVersion: '2022',
            catalogueSha256: '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d' });
    } else expect(read).toThrow(expect.objectContaining({ code: 'framework_not_found', statusCode: 404 }));
    expect(() => prepareRequest({ ...route, version: 'latest' }, undefined, null)).toThrow('framework_not_found');
});
