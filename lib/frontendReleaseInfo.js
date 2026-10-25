'use strict';

const { createHash } = require('node:crypto');
const { version } = require('../package.json');
const { getReleaseIdentity } = require('../api/shared/releaseIdentity');
const FRONTEND_RELEASE_MARKER = '<!-- FRONTEND_RELEASE_INFO -->';

function frontendReleaseInformation({ productVersion = version, releaseIdentity = getReleaseIdentity() } = {}) {
    if (typeof productVersion !== 'string' || productVersion.length > 64 ||
        !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(productVersion)) return null;
    const identity = getReleaseIdentity(releaseIdentity);
    if (!identity) return null;
    // Include the exact existing tuple; absence of runAttempt is not attempt 1.
    const frontendBuildCue = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
    return Object.freeze({ productVersion, frontendBuildCue });
}

function withFrontendReleaseInformation(template, options) {
    if (typeof template !== 'string') throw new Error('frontend_release_template_invalid');
    const count = template.split(FRONTEND_RELEASE_MARKER).length - 1;
    if (count > 1) throw new Error('frontend_release_marker_ambiguous');
    if (!count) return template;
    const value = frontendReleaseInformation(options);
    const presentation = value ? '<span class="frontend-release-info">Version ' + value.productVersion +
        ' <span>· Build ' + value.frontendBuildCue + '</span></span>' : '';
    return template.replace(FRONTEND_RELEASE_MARKER, () => presentation);
}

module.exports = { FRONTEND_RELEASE_MARKER, frontendReleaseInformation, withFrontendReleaseInformation };
