'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Exercise the actual nested parser selected by each evaluator dependency,
// without asking Jest to transform that dependency's ESM distribution.
function nestedParse(parent, source, limit) {
    return JSON.parse(execFileSync(process.execPath, ['-e', `
        const yaml = require(require.resolve('js-yaml', { paths: [process.argv[1]] }));
        try {
            const value = yaml.load(process.argv[2], { schema: yaml.YAML11_SCHEMA,
                maxTotalMergeKeys: Number(process.argv[3]) });
            process.stdout.write(JSON.stringify({ value }));
        } catch (error) {
            process.stdout.write(JSON.stringify({ error: error.message.split('\\n')[0] }));
        }
    `, path.resolve(__dirname, '../node_modules', parent), source, String(limit)], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 16384
    }));
}

test.each(['promptfoo', '@apidevtools/json-schema-ref-parser'])('%s counts empty merge sources against its work budget', parent => {
    expect(nestedParse(parent, 'a: &a [{}, {}, {}]\nb: {<<: *a}\n', 2).error)
        .toMatch(/exceeded maxTotalMergeKeys/);
    expect(nestedParse(parent, 'a: &a {}\nb: {<<: *a}\nc: {<<: *a}\nd: {<<: *a}\n', 2).error)
        .toMatch(/exceeded maxTotalMergeKeys/);
});

test.each(['promptfoo', '@apidevtools/json-schema-ref-parser'])('%s preserves ordinary aliases and merges within budget', parent => {
    expect(nestedParse(parent, 'a: &a {label: example}\nb: {<<: *a, enabled: true}\n', 10))
        .toEqual({ value: { a: { label: 'example' }, b: { label: 'example', enabled: true } } });
});

test('release validators use the supported safe YAML load API', () => {
    const yaml = require('js-yaml');
    const source = 'on: [push]\npermissions:\n  contents: read\n' +
        'defaults: &defaults {timeout-minutes: 5}\njob: {<<: *defaults}\n';
    const expected = {
        on: ['push'], permissions: { contents: 'read' },
        defaults: { 'timeout-minutes': 5 }, job: { 'timeout-minutes': 5 }
    };
    expect(yaml.load(source)).toEqual(expected);
    expect(yaml.load('on: [push]\npermissions: {contents: read}\n', {
        schema: yaml.JSON_SCHEMA
    })).toEqual({ on: ['push'], permissions: { contents: 'read' } });
    expect(() => yaml.load('permissions: read\npermissions: write\n'))
        .toThrow(/duplicated mapping key/);
    for (const source of ['!!js/function function () {}', '!!js/regexp /x/', '!!js/undefined']) {
        expect(() => yaml.load(source)).toThrow(/unknown tag/);
    }
});

test.each([['05', 5], ['012', 12], ['1:23', '1:23'], ['1_0', '1_0']])(
    'maintained YAML 4 scalar %s has explicit default and JSON schema semantics', (source, expected) => {
        const yaml = require('js-yaml');
        expect(yaml.load(source)).toEqual(expected);
        expect(yaml.load(source, { schema: yaml.JSON_SCHEMA })).toEqual(expected);
    }
);
