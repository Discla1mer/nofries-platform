'use strict';

const fs = require('fs');
const path = require('path');
const { buildPortalDocument } = require('../lib/portalDocument');

const root = path.resolve(__dirname, '..');

describe('customer portal protected shell', () => {
    test('embeds only the CSP-authorised loader and fetches the protected application after membership bootstrap', () => {
        const loaderSource = fs.readFileSync(path.join(root, 'js', 'portal-loader.js'), 'utf8');
        const result = buildPortalDocument({
            template: fs.readFileSync(path.join(root, 'app', 'portal.html'), 'utf8'),
            loaderSource
        });
        const scripts = [...result.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        expect(scripts).toHaveLength(1);
        expect(scripts[0][1]).toMatch(/id="portalRuntime"/);
        expect(scripts[0][1]).not.toMatch(/\bsrc=/);
        expect(scripts[0][2]).toContain('/api/customer-portal/bootstrap');
        expect(scripts[0][2]).toContain('/api/customer-portal/app.js');
        expect(scripts[0][2]).toContain('validateProofBinding(value.customer, value.proof)');
        expect(scripts[0][2]).toContain('report.publicationEnvelope.customerId !== proofCustomerId');
        expect(result.html).toContain('customer_portal_startup_watchdog');
        expect(result.contentSecurityPolicy).toContain(result.scriptHash);
        expect(result.html).toContain('href="#monthlyProof"');
        expect(result.html).toContain('id="startupWatchdog" hidden aria-hidden="true"');
        expect(result.html).not.toContain('Safe test environment');
    });

    test('renders the canonical Proof metric array and numeric strings without HTML injection', () => {
        const source = fs.readFileSync(path.join(root, 'api', 'shared', 'protectedAssets', 'portal.js'), 'utf8');
        const styles = fs.readFileSync(path.join(root, 'app', 'portal.css'), 'utf8');
        expect(source).toContain('Array.isArray(section.metrics)');
        expect(source).toContain('isSafeNumericValue(value.value)');
        expect(source).toContain('value.label || value.key');
        expect(source).toContain("mode.includes('mixed')");
        expect(source).toContain('report.evidenceReceipts');
        expect(source).toContain('Copy checksum');
        expect(source).toContain('report.approvedAt');
        expect(source).toContain('report.issuer');
        expect(source).toContain("report.statement.label === 'No Fries-attested monthly statement'");
        expect(source).toContain("createElement('p', 'proof-statement', report.statement.label)");
        expect(styles).toMatch(/\.proof-statement\s*\{[^}]*font-weight:\s*850/s);
        expect(source).toContain('element.textContent = String(text)');
        expect(source).not.toContain('.innerHTML');
        expect(source).not.toContain('section.metrics && typeof section.metrics');
    });

    test('offers status recovery without claiming an unresolved provider operation was cancelled', () => {
        const source = fs.readFileSync(path.join(root, 'api', 'shared', 'protectedAssets', 'portal.js'), 'utf8');
        const runtime = fs.readFileSync(path.join(root, 'api', 'shared', 'customerPortalRuntime.js'), 'utf8');
        const template = fs.readFileSync(path.join(root, 'app', 'portal.html'), 'utf8');
        expect(template).toContain('id="checkPendingReply"');
        expect(template).toContain('id="checkPendingCreate"');
        expect(template).toContain('Check status again');
        expect(template).toContain('id="newTicketSubmit"');
        expect(source).toContain("newTicketSubmit.textContent = recoveredCreate ? 'Retry exact request'");
        expect(source).toContain('/api/customer-portal/tickets/operations/');
        expect(runtime).toContain("segments[1] === 'operations'");
        expect(runtime).toContain('portal.getOperationStatus(access, segments[2])');
        expect(source).toContain('pollPendingOperation(pending');
        expect(source).toContain("pendingApi.operationDisposition(result) !== 'terminal'");
        expect(source).toContain('operation may still complete');
        expect(source).not.toContain('Pending reply cancelled');
        expect(source).not.toContain('No reply was submitted');
        expect(source).not.toContain('Cancel, then start a new request');
        expect(source).toContain('Restore the exact original details and check status');
        expect(source).toContain('error.operationResult = body');
        expect(source).toContain("pendingApi.operationDisposition(result) === 'pending'");
    });
});
