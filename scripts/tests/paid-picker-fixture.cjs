'use strict';

// In-memory ports for the local picker acceptance run. The fixed persona records
// never reach a database or a provider. The candidate supplies the real editors,
// collection, profile registry, access decision, sealed records and SRI assets.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function startFixture(root, persona, enabled, entitled) {
    const load = createRequire(path.join(root, 'package.json'));
    const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
    const { buildDashboardDocument } = load('./lib/dashboardDocument');
    const { buildFixtures } = load('./scripts/build-ncsc-questionnaire-preview');
    const { ncscFixture } = load('./test/fixtures/ncscAssessmentFixture');
    const { prepareRequest, parsePaidRoute, paidAccess, paidRequest } = load('./api/shared/assessmentLifecycle/paidAssessments');
    const { parseAsset, matchesSelection, packagedAsset } = load('./api/shared/paidRendererAssets');
    const { paidFrameworks } = load('./api/shared/protectedAssets/dashboardRegistry');
    const { ACCEPTED_PROFILE_REF } = load('./api/shared/assessmentEngine/ncscAssessmentEvaluator');
    const now = '2026-11-19T00:01:00.000Z';
    const preview = buildFixtures(),
        operations = [],
        errors = [];
    const rows = entitled ? paidFrameworks.map(({ moduleId, profileId, version }) => ({ moduleId, profileId, version })) : [];
    const profileRefs = [ACCEPTED_PROFILE_REF, ...rows.map((r) => ({ profileId: r.profileId, profileVersion: r.version }))];
    const accounts = preview.tenants.map(({ model }, index) => {
        const setup = ncscFixture({
            tenantId: 'synthetic-picker-' + index,
            organisationId: model.context.organisationId,
            now,
            profileRefs,
            capacity: 8
        });
        const product = setup.state.entitlementState.grants.find((g) => g.grantId === 'synthetic-product');
        const usage = {
            ...setup.scope,
            schemaVersion: 1,
            revision: 0,
            grantId: product.grantId,
            counters: Object.fromEntries(Object.keys(product.limits).map((key) => [key, 0]))
        };
        return { ...setup, model, usage, revisions: [], bindingId: '10000000-0000-4000-8000-00000000000' + (index + 1) };
    });
    const shared = [
        'dashboardRegistry.js',
        'dashboardShell.js',
        'ncscAssessmentClient.js',
        'ncscQuestionnaire.js',
        'assessmentExplanation.js',
        'organisationPicture.js',
        'improvementActionPlanView.js',
        'improvementActionPlanClient.js'
    ]
        .map((name) => read('api/shared/protectedAssets/' + name))
        .join('\n');
    const css = read('app/dashboard.css');
    const doc = buildDashboardDocument({
        customerLogin: true,
        customerTransport: 'auto',
        loaderSource: read('js/dashboard-loader.js'),
        template: read('app/dashboard.html'),
        protectedAppSource: shared,
        protectedStyleSource: css
    });
    const staticFiles = new Map([
        ['/style.css', 'text/css'],
        ['/home.css', 'text/css'],
        ['/images/nofrieslogo.png', 'image/png'],
        ['/images/paper-texture.webp', 'image/webp'],
        ['/images/nofries-mark-large.webp', 'image/webp'],
        ['/assets/fonts/fraunces-latin-opsz-normal.woff2', 'font/woff2'],
        ['/assets/fonts/fraunces-latin-opsz-italic.woff2', 'font/woff2']
    ]);
    let generationNumber = 1,
        selected = accounts[0];
    const generation = () => String(generationNumber).padStart(64, '0');
    const context = () => ({ scope: selected.scope, identity: { subjectKey: selected.subjectKey }, resolvedAt: now });
    const authority = () => ({ ...selected.state, usage: [selected.usage] });
    function query(sql, args) {
        const history = selected.revisions.filter((r) => args.slice(0, 4).every((v, i) => v === r.keys[i]));
        if (sql.startsWith('SELECT DISTINCT ON')) {
            const heads = new Map(history.map((r) => [r.keys[4], r.record.state]));
            return {
                rows: [...heads.values()]
                    .sort((a, b) => a.assessmentId.localeCompare(b.assessmentId))
                    .map((s) => ({ assessment_id: s.assessmentId, revision: s.revision, updated_at: s.updatedAt, status: s.status }))
            };
        }
        if (sql.startsWith('SELECT revision,')) {
            const saved = history.filter((r) => r.keys[4] === args[4] && (args.length === 5 || r.idempotencyKey === args[5]));
            return { rows: saved.slice(-1) };
        }
        if (sql.startsWith('SELECT octet_length')) return { rows: [{ bytes: Buffer.byteLength(args[0]) }] };
        if (sql.startsWith('INSERT INTO nofries.dashboard_framework_revisions')) {
            const [revision, idempotencyKey, intent_sha256, record_sha256, encoded] = args.slice(5);
            selected.revisions.push({
                keys: args.slice(0, 5),
                revision,
                idempotencyKey,
                intent_sha256,
                record_sha256,
                record: JSON.parse(encoded)
            });
            return { rowCount: 1 };
        }
        if (sql.startsWith('UPDATE nofries.dashboard_usage ')) {
            selected.usage = JSON.parse(args.at(-1));
            return { rowCount: 1 };
        }
        throw Error('Unexpected fixture query');
    }
    const pair = {
        clock: () => now,
        database: {
            withTenantTransaction: (tenantId, work) => {
                assert.equal(tenantId, selected.scope.tenantId);
                return work({ query }, authority());
            }
        },
        audit: { createEvent: () => ({}), writeEvent: () => {} }
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1'),
            route = url.pathname,
            method = req.method;
        const send = (status, value, type = 'application/json') => {
            res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' });
            res.end(typeof value === 'string' ? value : JSON.stringify(value));
        };
        try {
            if (staticFiles.has(route)) {
                res.setHeader('Content-Type', staticFiles.get(route));
                return res.end(fs.readFileSync(path.join(root, route)));
            }
            if (route === '/dashboard') {
                res.setHeader('Content-Security-Policy', doc.contentSecurityPolicy);
                return send(200, doc.html, 'text/html');
            }
            if (route === '/api/dashboard/app.js') return send(200, shared, 'application/javascript');
            if (route === '/api/dashboard/dashboard.css') return send(200, css, 'text/css');
            if (route === '/api/dashboard/session')
                return send(200, {
                    schemaVersion: 1,
                    authenticated: true,
                    purpose: 'customer',
                    accountType: persona === 'consultant' ? 'consultant' : 'company',
                    generation: generation(),
                    selectedBindingId: selected.bindingId,
                    expiresAt: new Date(Date.now() + 3600000).toISOString()
                });
            if (route === '/api/dashboard/organisations')
                return send(200, {
                    schemaVersion: 1,
                    bindings: (persona === 'consultant' ? accounts : [selected]).map((a) => ({
                        bindingId: a.bindingId,
                        organisationLabel: a.model.context.displayName
                    })),
                    nextAfterBindingId: null
                });
            let raw = '';
            for await (const part of req) raw += part;
            const body = raw ? JSON.parse(raw) : undefined;
            if (
                route === '/api/dashboard/selection' &&
                persona === 'consultant' &&
                method === 'POST' &&
                body.expectedGeneration === generation()
            ) {
                selected = accounts.find((a) => a.bindingId === body.bindingId);
                assert.ok(selected);
                generationNumber++;
                return send(200, { schemaVersion: 1, generation: generation(), selectedBindingId: selected.bindingId });
            }
            const model = selected.model;
            if (route === '/api/dashboard/bootstrap') return send(200, model);
            if (route === '/api/dashboard/modules/cyber_security')
                return send(200, {
                    schemaVersion: 1,
                    context: model.context,
                    generatedAt: model.generatedAt,
                    module: model.modules.find((m) => m.key === 'cyber_security'),
                    summary: model.summary,
                    services: model.services,
                    admissionGranted: false,
                    providerAccessGranted: false,
                    metadata: preview.metadata,
                    presentationMode: 'editable',
                    ...(enabled ? { paidFrameworks: rows } : {})
                });
            if (route === '/api/dashboard/ncsc/assessments')
                return send(200, { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null });
            if (!route.startsWith('/api/dashboard/frameworks/')) return send(404, {});
            operations.push({ method, route, client: selected.model.context.displayName });
            if (!enabled) return send(404, {});
            const suffix = route.slice('/api/dashboard/'.length);
            const asset = parseAsset(suffix, url.search.slice(1));
            if (asset) {
                if (!matchesSelection(asset, generation())) return send(403, {});
                const prepared = prepareRequest({ ...asset.ref, assessmentId: null }, undefined, null);
                paidAccess(authority(), context(), false, prepared.profileRef, now);
                const bytes = packagedAsset(asset);
                return bytes ? send(200, bytes.body, 'application/javascript') : send(404, {});
            }
            if (req.headers['x-nofries-dashboard-generation'] !== generation()) return send(403, {});
            const parsed = parsePaidRoute(suffix);
            if (!parsed) return send(404, {});
            const prepared = prepareRequest(parsed, body, url.searchParams.get('afterAssessmentId'));
            return send(200, await paidRequest(pair, context(), prepared));
        } catch (err) {
            if (!err.statusCode) errors.push(err.message);
            return send(err.statusCode || 500, { code: err.code || 'fixture_error' });
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        origin: 'http://127.0.0.1:' + server.address().port,
        operations,
        errors,
        accounts,
        generation,
        paidFrameworks,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

module.exports = { startFixture };
