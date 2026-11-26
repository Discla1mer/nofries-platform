'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { INDUSTRIES, REGIONS, SIZE_BANDS, WEBSITE_PATTERN, normaliseWebsite, choice } = require('../api/shared/organisationProfile/profileChoices');
const { RESET_TABLES, DELETE_TENANT_TABLES } = require('../api/shared/dashboardAdmin/accountWipeRepository');

const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/0035_organisation_profile.sql'), 'utf8');
const listIn = column => new RegExp(`${column} IN \\(([^)]*)\\)`).exec(sql)[1].match(/'([^']+)'/g).map(item => item.slice(1, -1));

test('0035 CHECK lists and the website rule match the shared choice module', () => {
    expect(listIn('industry')).toEqual(INDUSTRIES.map(item => item.code));
    expect(listIn('region')).toEqual(REGIONS.map(item => item.code));
    expect(listIn('size_band')).toEqual(SIZE_BANDS.map(item => item.code));
    expect(sql).toContain(`website ~ '${WEBSITE_PATTERN.source.replace(/\\\//g, '/')}'`);
    for (const value of ['https://10.0.0.1/', 'https://1.2/', 'https://localhost/', 'https://Example.co.nz/', 'https://example.co.nz']) {
        expect([value, WEBSITE_PATTERN.test(value)]).toEqual([value, false]);
    }
});

test('0035 gives runtime no delete and the wipe role no write', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b[^;]*TO nofries_runtime/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|TRUNCATE|ALL)\b[^;]*TO nofries_account_wipe/i);
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*\b(tenant_id|organisation_id)\b/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
});

test('staff delete removes the profile before its organisation; reset keeps it', () => {
    expect(RESET_TABLES).not.toContain('dashboard_organisation_profiles');
    const at = DELETE_TENANT_TABLES.indexOf('dashboard_organisation_profiles');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(DELETE_TENANT_TABLES.indexOf('dashboard_organisations'));
});

test.each([
    ['example.co.nz', 'https://example.co.nz/'],
    ['  Example.CO.nz  ', 'https://example.co.nz/'],
    ['https://www.example.co.nz/about?x=1#top', 'https://www.example.co.nz/'],
    ['http://shop.example.com', 'https://shop.example.com/'],
    ['https://example.co.nz:443/', 'https://example.co.nz/'],
    ['https://café.example.nz/', 'https://xn--caf-dma.example.nz/'],
    ['', null], [null, null], [undefined, null]
])('normaliseWebsite(%j) is %j', (input, expected) => {
    expect(normaliseWebsite(input)).toBe(expected);
    if (expected) expect(WEBSITE_PATTERN.test(expected)).toBe(true);
});

test.each([
    'localhost', 'https://localhost/', 'intranet', 'https://10.0.0.1/', '192.168.1.1', 'https://[::1]/', 'ftp://example.co.nz/',
    'javascript:alert(1)', 'https://user:pass@example.co.nz/', 'https://example.co.nz:8443/', 'http://example.co.nz:443/', 'printer.local', 'files.internal',
    'router.home.arpa', 'hidden.onion', 'box.localdomain',
    'https://' + 'a'.repeat(260) + '.nz/', 42, {}
])('normaliseWebsite refuses %j', input => {
    expect(() => normaliseWebsite(input)).toThrow(expect.objectContaining({ code: 'organisation_profile_invalid', statusCode: 400 }));
});

test('choice accepts only listed codes and treats empty as unset', () => {
    expect(choice(INDUSTRIES, 'retail')).toBe('retail');
    expect(choice(REGIONS, '')).toBeNull();
    expect(() => choice(SIZE_BANDS, 'Just me')).toThrow(expect.objectContaining({ code: 'organisation_profile_invalid' }));
    expect(() => choice(INDUSTRIES, ['retail'])).toThrow(expect.objectContaining({ code: 'organisation_profile_invalid' }));
});
