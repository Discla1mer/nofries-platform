'use strict';

const { unfinishedNudge, reassessmentReminder, monthlyStatus } = require('../api/shared/lifecycleEmail/reminderContent');
const { renderTemplate } = require('../api/shared/lifecycleEmail/templates');
const { TEMPLATE_VERSIONS } = require('../api/shared/lifecycleEmail/templateVersions');

const links = { signInUrl: 'https://example.invalid/dashboard',
    unsubscribeUrl: 'https://example.invalid/api/emailPreferences?t=fiction&lang=nz' };

describe.each([
    [unfinishedNudge, /start it, or to carry on/],
    [reassessmentReminder, /start a new one/],
    [monthlyStatus, /decide what to work on next/]
])('%p', (render, copy) => {
    test('both formats preserve the action, privacy and per-type unsubscribe', () => {
        const input = { ...links, name: 'PRIVATE_NAME', assessment: 'PRIVATE_RESULT', score: 1234567 };
        const message = render(input);
        expect(message).toEqual(render(links));
        expect(message.text).toMatch(/^Kia ora,/);
        for (const body of [message.text, message.html]) {
            expect(body).toMatch(copy);
            expect(body).toContain('To stop this kind of email');
            expect(body).not.toMatch(/PRIVATE_|1234567|\{\{|<img/i);
        }
        expect(message.text.match(/https:\/\/\S+/g)).toEqual(Object.values(links));
        expect([...message.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]))
            .toEqual([links.signInUrl, links.unsubscribeUrl.replace('&', '&amp;')]);
        expect(message.html).toContain('Sign in to No Fries</a>');
        expect(message.html).toContain('Unsubscribe from this kind of email</a>');
    });

    test.each(['javascript:alert(1)', 'http://example.invalid', 'https://someone@example.invalid',
        'https://example.invalid/\nheader', undefined])('rejects invalid links in either slot', bad => {
        for (const key of Object.keys(links)) expect(() => render({ ...links, [key]: bad })).toThrow();
    });
});

test.each([[unfinishedNudge, 'nudge_unfinished'], [reassessmentReminder, 'reassess_reminder']])(
    'existing reminder copy cannot drift between the preview and the active plain-text renderer', (render, type) => {
        const current = renderTemplate(type, TEMPLATE_VERSIONS[type], links);
        expect(render(links)).toMatchObject(current);
    });

test('monthly status is content only, not a registered delivery type', () => {
    expect(Object.keys(TEMPLATE_VERSIONS).sort()).toEqual(['nudge_unfinished', 'reassess_reminder', 'result_summary', 'welcome']);
    expect(monthlyStatus(links).subject).toBe('Your monthly No Fries check-in');
});
