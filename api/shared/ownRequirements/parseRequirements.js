(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesRequirementsParser = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const maxCharacters = 40000, maxRows = 200;
    // Only recognise a list marker at a word boundary. Never strip the first
    // word, a year on its own, a version embedded in text, or a negative number.
    const marker = /^(?:(\d+(?:\.\d+)*[.)]|\d+(?:\.\d+)+)|[-*•])(?:[ \t]+|$)/u;

    function parseRequirements(source) {
        if (typeof source !== 'string') throw new TypeError('Paste requirements as text.');
        if (source.length > maxCharacters) throw new RangeError('Use 40,000 characters or fewer per preview.');
        const rows = [];
        let previous = null;
        for (const raw of source.split(/\r\n|[\r\n\u2028\u2029]/u)) {
            const line = raw.trim();
            if (!line) { previous = null; continue; }
            const match = marker.exec(line);
            const text = match ? line.slice(match[0].length).trim() : line;
            if (!text) throw new RangeError('One list item is empty. Add its text or remove its marker.');
            if (!match && previous && /^[ \t]/u.test(raw)) {
                previous.text += ' ' + text;
                continue;
            }
            if (rows.length >= maxRows) throw new RangeError('Review up to 200 requirements at a time.');
            previous = { number: rows.length + 1, sourceNumber: match?.[1]?.replace(/[.)]$/u, '') ?? null, text };
            rows.push(previous);
        }
        return rows;
    }
    return { parseRequirements };
}));
