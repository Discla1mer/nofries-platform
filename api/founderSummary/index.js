const os = require('os');
const path = require('path');
const { handlers, runFunction } = require('../shared/apiRuntime');

module.exports = async function founderSummary(context, req) {
    await runFunction(context, Object.assign({}, req, {
        telemetryDataDir: process.env.NOFRIES_TELEMETRY_DIR || process.env.NOFRIES_DATA_DIR || path.join(os.tmpdir(), 'nofries-telemetry')
    }), handlers.founderSummary);
};
