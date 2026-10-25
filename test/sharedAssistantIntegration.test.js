'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { buildGatewayDocument } = require('../lib/gatewayDocument');
const { withSharedAssistantDocument, publicAssistantPage } = require('../lib/withSharedAssistantDocument');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('post-builder composition leaves the exact loader, integrity and CSP binding intact', () => {
    const built = buildGatewayDocument({
        customerLogin: true, customerTransport: 'auto', template: read('index.html'),
        loaderSource: read('js/dashboard-loader.js'),
        protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js']
            .map(file => read('api/shared/protectedAssets/' + file)).join('\n'),
        protectedStyleSource: read('app/dashboard.css')
    });
    const assisted = withSharedAssistantDocument(built.html, 'home');
    const inlineRuntime = html => html.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
    expect(inlineRuntime(assisted)).toBe(inlineRuntime(built.html));
    expect(assisted).toContain(`content="${built.appIntegrity}"`);
    expect(assisted).toContain(`content="${built.styleIntegrity}"`);
    expect(built.contentSecurityPolicy).toContain(built.scriptHash);
    expect(built.contentSecurityPolicy).toContain("script-src 'self'");
    expect(assisted.match(/src="\/js\/prospect-assistant\.js"/g)).toHaveLength(1);
    expect(assisted.match(/src="\/js\/shared-assistant\.js"/g)).toHaveLength(1);
    expect(assisted).not.toMatch(/\bon(?:click|load|error|submit)=|<iframe\b/);
});

test('duplicate or ambiguous composition fails closed', () => {
    const html = '<html><head></head><body></body></html>';
    const once = withSharedAssistantDocument(html);
    expect(() => withSharedAssistantDocument(once)).toThrow('shared_assistant_document_invalid');
    expect(() => withSharedAssistantDocument(html.replace('</body>', '</body></body>'))).toThrow();
    expect(() => withSharedAssistantDocument(html, 'private-organisation-data')).toThrow();
});

test('only the standalone service page selects discovery mode', () => {
    for (const file of PUBLIC_ROOT_FILES.filter(file => file.endsWith('.html'))) {
        const html = withSharedAssistantDocument(read(file), publicAssistantPage(file));
        expect(html).toContain(`data-assistant-help-only="${file !== 'managed-it.html'}"`);
        expect(html.match(/\bdata-shared-assistant(?:\s|>)/g)).toHaveLength(1);
    }
});

test('the built static package mounts one shared assistant on every shipped document', () => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root, stdio: 'pipe' });
    const files = [...PUBLIC_ROOT_FILES.filter(file => file.endsWith('.html')),
        'app/dashboard.html', 'app/signup.html', 'app/mssp.html', 'app/support.html', 'app/portal.html', 'app/operator.html'];
    for (const file of files) {
        const html = read('dist/' + file);
        expect(html.match(/\bdata-shared-assistant(?:\s|>)/g)).toHaveLength(1);
        if (file === 'app/signup.html') {
            expect(html).not.toMatch(/<script\b[^>]*\bsrc=/);
            expect(html).toContain('<script id="nofriesPublicHelpRuntime">');
        } else {
            expect(html).toContain('src="/js/shared-assistant.js" defer');
        }
        expect(html).toContain('href="/shared-assistant.css"');
        expect(html).toContain('src="/images/fry-chat.png"');
    }
    expect(fs.readFileSync(path.join(root, 'dist/images/fry-chat.png'))).toEqual(fs.readFileSync(path.join(root, 'images/fry-chat.png')));
});

test('HTTP public and protected entry documents mount generic help without changing access headers', async () => {
    const app = createNoFriesApp();
    for (const route of ['/', '/managed-it.html', '/roadmap.html', '/privacy.html', '/terms.html', '/dashboard', '/portal', '/support', '/operator', '/scoping']) {
        const result = await request(app).get(route);
        expect(result.status).toBe(200);
        expect(result.text.match(/\bdata-shared-assistant(?:\s|>)/g)).toHaveLength(1);
        expect(result.text).toContain(`data-assistant-help-only="${route !== '/managed-it.html'}"`);
        expect(result.headers['content-security-policy']).toContain("script-src 'self'");
        expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        if (['/dashboard', '/portal', '/support', '/operator', '/scoping'].includes(route)) {
            expect(result.headers['cache-control']).toContain('no-store');
            expect(result.headers['x-robots-tag']).toBe('noindex, nofollow');
        }
    }
});

test('the exact selected transparent Fry asset is shipped and served without substitution', async () => {
    const bytes = fs.readFileSync(path.join(root, 'images/fry-chat.png'));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe('daeed090495f690239b2b29d6d66ab22ab2fcde39057db2912811b279a87b743');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[25]]).toEqual([1254, 1254, 6]);
    const response = await request(createNoFriesApp()).get('/images/fry-chat.png');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
});
