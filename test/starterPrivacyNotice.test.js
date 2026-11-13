'use strict';

const fs = require('node:fs');
const path = require('node:path');

const notice = fs.readFileSync(path.join(__dirname, '../privacy.html'), 'utf8');
function section(title) {
    const start = notice.search(new RegExp('<h2\\b[^>]*>' + title + '</h2>'));
    expect(start).not.toBe(-1);
    const end = notice.indexOf('<h2', start + 4);
    return notice.slice(start, end === -1 ? undefined : end);
}

describe('starter signup privacy disclosure', () => {
    test('names the durable representative data for own and consultant client signup', () => {
        const text = section('Organisation and representative details');
        for (const field of ['full name', 'your role', 'business address', 'optional company registration number',
            'authority assertion', 'each client organisation', 'verified email', 'offered schedule', 'terms acceptance']) {
            expect(text).toContain(field);
        }
    });
    test('distinguishes verification cleanup from durable and unfinished starter records', () => {
        const verification = section('Account setup and email verification');
        expect(verification).toContain('Short-lived email-verification requests and security counters');
        expect(verification).toContain('This cleanup does not apply to the durable representative and account records');
        const durable = section('Organisation and representative details');
        for (const statement of ['stored durably in separate private Azure storage', '24-hour request expires',
            'earlier offer’s access period ends', 'no automatic deletion timer', 'including unfinished setup', 'expiry alone is not account deletion',
            'Recoverable storage versions and backups']) expect(durable).toContain(statement);
    });
    test('retains a request contact without claiming automatic or immediate deletion', () => {
        expect(section('Organisation and representative details')).toContain('request access, correction or deletion');
        expect(section('Access, correction and complaints')).toContain('mailto:hello@nofries.nz');
        expect(notice).toContain('Last updated: 11 November 2026');
        expect(notice).not.toContain('Setup and security records are stored in private Azure authentication storage. Expired records are removed');
    });
});
