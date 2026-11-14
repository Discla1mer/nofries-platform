'use strict';

// Customer copy uses one vocabulary: Account (the person), Organisation (the
// business being assessed) and Dashboard (the product). "Workspace" is retired
// from customer-facing text. Staff pages and code identifiers are not checked.
const fs = require('node:fs');
const path = require('node:path');

const CUSTOMER_FILES = [
    'login.html',
    'js/organisation-setup.js',
    'lib/signupDocument.js',
    'api/shared/customerSignup/signupJourney.js',
    'js/dashboard-loader.js'
];
const RETIRED = /\bworkspaces?\b/i;

function visibleHtmlText(html) {
    const withoutCode = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
    const attributes = [...withoutCode.matchAll(/\s(?:aria-label|title|alt|placeholder|content)="([^"]*)"/gi)].map(match => match[1]);
    const text = withoutCode.replace(/<[^>]*>/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
    return [...attributes, ...text];
}

// A string literal with no spaces that looks like a class, id, route or key is
// a code identifier, not copy.
const identifierLike = value => !/\s/.test(value) && (/^[a-z.#/]/.test(value) || /[_-]/.test(value));

function visibleScriptText(source) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const literals = [...withoutComments.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g)]
        .map(match => match[1] ?? match[2] ?? match[3]);
    return literals.flatMap(value => value.includes('<') ? visibleHtmlText(value) : [value])
        .filter(value => !identifierLike(value.trim()));
}

function retiredCopy(file) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const copy = file.endsWith('.html') ? visibleHtmlText(source) : visibleScriptText(source);
    return copy.filter(value => RETIRED.test(value));
}

test('the copy check finds retired wording in visible text and ignores identifiers', () => {
    expect(visibleHtmlText('<p class="client-workspace">Your workspace</p>')).toEqual(['Your workspace']);
    expect(visibleHtmlText('<nav aria-label="Workspace"></nav>')).toEqual(['Workspace']);
    expect(visibleScriptText("el.className = 'client-workspace-row'; el.textContent = 'Open your workspace';"))
        .toEqual(['Open your workspace']);
    expect(visibleScriptText("const key = 'workspace_preparation'; label('Workspace');")).toEqual(['Workspace']);
});

test.each(CUSTOMER_FILES)('%s does not use "workspace" in customer-facing copy', file => {
    expect(retiredCopy(file)).toEqual([]);
});
