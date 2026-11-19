'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const registry = require('./protectedAssets/dashboardRegistry');
const { apiSecurityHeaders } = require('./securityHeaders');

const files = { collection: 'paidCollection.js', questionnaire: 'paidQuestionnaire.js', results: 'paidResults.js' };
function parseAsset(route, query) {
    const match = /^frameworks\/([\w.-]+)\/([\w.-]+)\/assets\/(collection|questionnaire|results)\.js$/.exec(route);
    if (!match) return null;
    const [, profileId, version, name] = match;
    const ref = registry.paidFrameworks.find(row => row.profileId === profileId && row.version === version);
    const params = /^v=([A-Za-z0-9_-]{43})&s=([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(query || '');
    const integrity = registry.rendererIntegrity[name];
    if (!ref || !params || params[1] !== Buffer.from(integrity.slice(7), 'base64').toString('base64url')) return null;
    return { ref, name, integrity, nonce: params[2], fingerprint: params[3] };
}

function matchesSelection(asset, generation) {
    const message = registry.rendererSelection(generation, asset.ref, asset.name, asset.nonce);
    return createHash('sha256').update(message).digest('hex') === asset.fingerprint;
}

function packagedAsset(asset) {
    const filename = path.join(__dirname, 'protectedAssets', files[asset.name]);
    let bytes;
    try { bytes = fs.readFileSync(filename); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if ('sha256-' + createHash('sha256').update(bytes).digest('base64') !== asset.integrity) return null;
    return { status: 200, isRaw: true, body: bytes.toString('utf8'),
        headers: apiSecurityHeaders({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'private, no-store',
            'Cross-Origin-Resource-Policy': 'same-origin' }) };
}

module.exports = { parseAsset, matchesSelection, packagedAsset };
