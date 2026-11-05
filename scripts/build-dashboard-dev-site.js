'use strict';

// Packaging only. No cloud SDK, application server, API, credentials or deployment.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { renderPreview } = require('./build-dashboard-preview');
const ROOT = path.resolve(__dirname, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function buildDevSite(output) {
    if (!output || !path.isAbsolute(output)) throw new Error('Supply an absolute, new output directory outside the repository');
    // Resolve the parent to reject symlink aliases into a production build directory.
    const target = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
    const relative = path.relative(ROOT, target);
    if (!relative.startsWith('..' + path.sep) || fs.existsSync(target)) throw new Error('Output must be new and outside the repository');
    const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']));
    const { html, contentSecurityPolicy } = renderPreview(commit + (dirty ? '-dirty' : ''));
    const config = {
        routes: [
            { route: '/.auth/login/aad', statusCode: 404 },
            { route: '/.auth/login/aad/*', statusCode: 404 },
            { route: '/.auth/*', allowedRoles: ['anonymous'] },
            { route: '/api/*', statusCode: 404 },
            { route: '/*', allowedRoles: ['preview_reviewer'] }
        ],
        responseOverrides: { 401: { redirect: '/.auth/login/github?post_login_redirect_uri=.referrer', statusCode: 302 } },
        globalHeaders: {
            'Content-Security-Policy': contentSecurityPolicy + "; frame-ancestors 'none'",
            'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
        }
    };
    const configText = JSON.stringify(config, null, 2) + '\n';
    const manifest = { schemaVersion: 1, kind: 'synthetic-dashboard-dev', commit, dirty,
        files: { 'index.html': sha256(html), 'staticwebapp.config.json': sha256(configText) } };
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'index.html'), html);
    fs.writeFileSync(path.join(target, 'staticwebapp.config.json'), configText);
    fs.writeFileSync(path.join(target, 'preview-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { output: target, ...manifest };
}

if (require.main === module) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Expected --output /absolute/new/directory');
        console.log(JSON.stringify(buildDevSite(process.argv[3]), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildDevSite };
