'use strict';
const { parseRequirements } = require('../api/shared/ownRequirements/parseRequirements');
const fixtures = require('./fixtures/pastedRequirements.json');

test.each(fixtures)('$name', ({ source, expected }) => {
    expect(parseRequirements(source).map(({ number, sourceNumber, text }) => [number, sourceNumber, text])).toEqual(expected);
});
test('empty input yields no entries; non-text is rejected without coercion', () => {
    expect(parseRequirements(' \t\r\n ')).toEqual([]);
    expect(() => parseRequirements(null)).toThrow(TypeError);
});
test('does not silently drop an empty list item or truncate oversized input', () => {
    expect(() => parseRequirements('1) First.\n2)')).toThrow(/item is empty/);
    expect(parseRequirements('a'.repeat(40000))[0].text).toHaveLength(40000);
    expect(() => parseRequirements('a'.repeat(40001))).toThrow(/40,000/);
    expect(parseRequirements(Array(200).fill('One').join('\n'))).toHaveLength(200);
    expect(() => parseRequirements(Array(201).fill('One').join('\n'))).toThrow(/200/);
});
test('returns fresh deterministic review data and treats markup as literal text', () => {
    const input = '9. Show the <review> & <status> labels.';
    const first = parseRequirements(input);
    first[0].text = 'changed';
    expect(parseRequirements(input)).toEqual([{ number: 1, sourceNumber: '9', text: 'Show the <review> & <status> labels.' }]);
});
