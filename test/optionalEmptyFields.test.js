'use strict';

const { hasOnlyEmptyOptionalFields } = require('../scripts/shared/optional-empty-fields.cjs');

const KEYS = Object.freeze(['optionA', 'optionB', 'optionC']);

describe('hasOnlyEmptyOptionalFields', () => {
    test.each(Array.from({ length: 8 }, (_, mask) => [mask]))(
        'accepts every combination of omitted and empty fields (mask %i)',
        mask => {
            const record = Object.fromEntries(KEYS.filter((_key, index) => mask & (1 << index)).map(key => [key, '']));
            expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(true);
        }
    );

    const invalidValues = [
        ['null', null],
        ['false', false],
        ['true', true],
        ['zero', 0],
        ['nonzero number', 1],
        ['negative number', -1],
        ['space', ' '],
        ['tab', '\t'],
        ['newline', '\n'],
        ['nonempty string', 'value'],
        ['empty array', []],
        ['nonempty array', ['']],
        ['empty object', {}],
        ['nonempty object', { value: '' }]
    ];

    for (const key of KEYS) {
        test.each(invalidValues)('rejects %s in ' + key, (_label, value) => {
            const record = Object.fromEntries(KEYS.map(name => [name, '']));
            record[key] = value;
            expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(false);
        });
    }

    test('checks only the selected fields', () => {
        expect(hasOnlyEmptyOptionalFields({ optionA: '', unrelated: 'value' }, KEYS)).toBe(true);
        expect(hasOnlyEmptyOptionalFields({ optionA: 'value' }, ['optionB'])).toBe(true);
    });

    test('accepts an empty selection', () => {
        expect(hasOnlyEmptyOptionalFields({ optionA: 'value' }, [])).toBe(true);
    });

    test('does not treat an own undefined value as an absent field', () => {
        expect(hasOnlyEmptyOptionalFields({ optionA: undefined }, KEYS)).toBe(false);
    });

    test('checks actual JSON serialization with an omitted undefined field', () => {
        const encoded = JSON.stringify({ optionA: undefined, optionB: '' });
        expect(encoded).toBe('{"optionB":""}');
        const record = JSON.parse(encoded);
        expect(Object.hasOwn(record, 'optionA')).toBe(false);
        expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(true);
    });

    test.each(invalidValues)('JSON serialization preserves refusal of %s', (_label, value) => {
        const record = JSON.parse(JSON.stringify({ optionA: value, optionB: '' }));
        expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(false);
    });

    test('does not use inherited values as own fields', () => {
        const record = Object.create({ optionA: 'inherited' });
        record.optionB = '';
        expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(true);
        record.optionA = 'own';
        expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(false);
    });

    test('handles data properties whose names also exist on Object.prototype', () => {
        const record = JSON.parse('{"hasOwnProperty":"","__proto__":""}');
        expect(hasOnlyEmptyOptionalFields(record, ['hasOwnProperty', '__proto__'])).toBe(true);
        record.__proto__ = 'value';
        expect(hasOnlyEmptyOptionalFields(record, ['hasOwnProperty', '__proto__'])).toBe(false);
    });

    test('does not mutate the record or key selection', () => {
        const record = Object.freeze({ optionA: '', unrelated: 'value' });
        const before = JSON.stringify(record);
        expect(hasOnlyEmptyOptionalFields(record, KEYS)).toBe(true);
        expect(JSON.stringify(record)).toBe(before);
        expect(KEYS).toEqual(['optionA', 'optionB', 'optionC']);
    });
});
