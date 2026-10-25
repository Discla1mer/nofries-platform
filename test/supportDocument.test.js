const fs = require('fs');
const path = require('path');
const {
    SUPPORT_RUNTIME_MARKER,
    buildSupportDocument,
    supportScriptHash
} = require('../lib/supportDocument');

describe('protected support document', () => {
    const root = path.join(__dirname, '..');
    const template = fs.readFileSync(path.join(root, 'app', 'support.html'), 'utf8');
    const loaderSource = fs.readFileSync(path.join(root, 'js', 'support-loader.js'), 'utf8');

    test('embeds one CSP-authorised loader that fetches the application after verification', () => {
        const result = buildSupportDocument({ template, loaderSource });
        const scripts = [...result.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

        expect(scripts).toHaveLength(1);
        expect(scripts[0][1]).toMatch(/\bid=["']supportRuntime["']/i);
        expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/i);
        expect(result.html).toContain('/api/service-desk/app.js');
        expect(result.html).not.toContain('window.NoFriesSupport = { start };');
        expect(result.html).not.toContain(SUPPORT_RUNTIME_MARKER);
        expect(result.contentSecurityPolicy).toContain(`script-src 'self' ${supportScriptHash(result.runtime)}`);
        expect(result.html).toContain('Live production service desk');
        expect(result.html).toContain('production service desk connected to Autotask');
        expect(result.html).not.toMatch(/Service Desk Lab|Safe test environment|Simulation only|sample ticket/i);
    });

    test('fails the build when the marker or embedded source is unsafe', () => {
        expect(() => buildSupportDocument({
            template: template.replace(SUPPORT_RUNTIME_MARKER, ''),
            loaderSource
        })).toThrow('exactly one');
        expect(() => buildSupportDocument({
            template,
            loaderSource: 'window.bad = "</script>";'
        })).toThrow('forbidden closing script token');
    });

    test('ships only live list, create, exact read and reply workflows', () => {
        const source = fs.readFileSync(path.join(root, 'api', 'shared', 'protectedAssets', 'support.js'), 'utf8');
        expect(source).toContain("'/api/service-desk/tickets'");
        expect(source).toContain('/api/service-desk/tickets/by-number/');
        expect(source).toContain('/replies');
        expect(source).not.toMatch(/investigate|approve|execute|remediation|simulation|sample ticket|\bdemo\b/i);
        expect(template).not.toMatch(/Service Desk Lab|Safe test|Simulation|sample ticket|\bmock\b|remediation/i);
    });
});
