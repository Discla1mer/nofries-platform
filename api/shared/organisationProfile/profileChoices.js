'use strict';

// Organisation profile (#608 step 1): the closed choice lists and the website
// rule shared by the 0035 CHECK constraints, the API and the Settings screen.
// Codes are stored; labels are shown. Changing a code needs a migration.
const freezeList = list => Object.freeze(list.map(([code, label]) => Object.freeze({ code, label })));

const INDUSTRIES = freezeList([
    ['agriculture', 'Farming, forestry and fishing'],
    ['construction', 'Building and construction'],
    ['manufacturing', 'Manufacturing'],
    ['retail', 'Retail and wholesale'],
    ['hospitality', 'Hospitality and tourism'],
    ['transport', 'Transport and logistics'],
    ['professional', 'Professional services'],
    ['finance', 'Finance and insurance'],
    ['health', 'Health and care'],
    ['education', 'Education'],
    ['community', 'Community and not-for-profit'],
    ['technology', 'Technology and media'],
    ['other', 'Something else']
]);

const REGIONS = freezeList([
    ['northland', 'Northland'], ['auckland', 'Auckland'], ['waikato', 'Waikato'], ['bay-of-plenty', 'Bay of Plenty'],
    ['gisborne', 'Gisborne'], ['hawkes-bay', 'Hawke’s Bay'], ['taranaki', 'Taranaki'], ['manawatu-whanganui', 'Manawatū-Whanganui'],
    ['wellington', 'Wellington'], ['tasman', 'Tasman'], ['nelson', 'Nelson'], ['marlborough', 'Marlborough'],
    ['west-coast', 'West Coast'], ['canterbury', 'Canterbury'], ['otago', 'Otago'], ['southland', 'Southland'],
    ['outside-nz', 'Outside New Zealand']
]);

// Matches the scope builder's headcount choices (#614) so one answer can pre-fill the other later.
const SIZE_BANDS = freezeList([
    ['just-me', 'Just me'], ['2-5', '2 to 5 people'], ['6-20', '6 to 20 people'],
    ['21-50', '21 to 50 people'], ['51-200', '51 to 200 people'], ['200-plus', 'More than 200 people']
]);

const WEBSITE_MAX = 255;
// Mirrors the 0035 CHECK: https, a lower-case DNS host with at least one dot whose last
// label starts with a letter (so no IPv4 literal), root path only.
const WEBSITE_PATTERN = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?\/$/;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home', '.arpa', '.onion', '.corp', '.test', '.example', '.invalid'];

// Normalise what a person types ("example.co.nz", "https://Example.co.nz/about")
// to "https://example.co.nz/". Returns null for an empty value and throws a
// coded error for anything that is not a public https host. No lookup or fetch.
function normaliseWebsite(input) {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'string') throw invalid();
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (trimmed.length > WEBSITE_MAX * 2) throw invalid();
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : 'https://' + trimmed;
    let url;
    try { url = new URL(candidate); } catch (_) { throw invalid(); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid();
    // A port is allowed only when it is the https default; http with any explicit port is refused.
    if (url.username || url.password || (url.port && (url.protocol !== 'https:' || url.port !== '443'))) throw invalid();
    const host = url.hostname.replace(/\.$/, '');
    // URL() lower-cases the host and converts non-ASCII labels to punycode, so anything
    // outside [a-z0-9.-] here is an IP literal, an IPv6 address or a malformed host.
    if (!host.includes('.') || /^[\d.]+$/.test(host) || /[^a-z0-9.-]/.test(host)) throw invalid();
    if (host === 'localhost' || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) throw invalid();
    const value = 'https://' + host + '/';
    if (value.length > WEBSITE_MAX || !WEBSITE_PATTERN.test(value)) throw invalid();
    return value;
}

function choice(list, value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !list.some(item => item.code === value)) throw invalid();
    return value;
}

function invalid() {
    const error = new Error('organisation_profile_invalid');
    error.code = 'organisation_profile_invalid';
    error.statusCode = 400;
    return error;
}

module.exports = Object.freeze({ INDUSTRIES, REGIONS, SIZE_BANDS, WEBSITE_MAX, WEBSITE_PATTERN, normaliseWebsite, choice });
