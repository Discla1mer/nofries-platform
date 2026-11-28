'use strict';

// Content previews only. Nothing here selects recipients or issues unsubscribe tokens.
const { TEMPLATES, FOOTER } = require('./templates');
const { TEMPLATE_VERSIONS } = require('./templateVersions');

const monthly = {
    subject: 'Your monthly No Fries check-in',
    lines: ['Kia ora,', '', 'Sign in to review your cyber security and decide what to work on next:',
        '{{signInUrl}}', '', 'Your assessment details stay in the dashboard.']
};

function safeLink(value) {
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error('template_link_invalid');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('template_link_invalid');
    return url.href;
}

const escaped = value => value.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);

function render(source, { signInUrl, unsubscribeUrl }) {
    const links = { signInUrl: safeLink(signInUrl), unsubscribeUrl: safeLink(unsubscribeUrl) };
    const labels = { signInUrl: 'Sign in to No Fries', unsubscribeUrl: 'Unsubscribe from this kind of email' };
    const lines = [...source.lines, ...FOOTER];
    const pattern = /\{\{(signInUrl|unsubscribeUrl)\}\}/g;
    const text = lines.join('\n').replace(pattern, (_, key) => links[key]);
    const html = lines.filter(line => line && line !== '--').map(line =>
        '<p>' + escaped(line).replace(pattern, (_, key) =>
            '<a href="' + escaped(links[key]) + '">' + labels[key] + '</a>') + '</p>').join('\n');
    return Object.freeze({ subject: source.subject, text, html });
}

const unfinishedNudge = links => render(TEMPLATES.nudge_unfinished[TEMPLATE_VERSIONS.nudge_unfinished], links);
const reassessmentReminder = links => render(TEMPLATES.reassess_reminder[TEMPLATE_VERSIONS.reassess_reminder], links);
const monthlyStatus = links => render(monthly, links);

module.exports = { unfinishedNudge, reassessmentReminder, monthlyStatus };
