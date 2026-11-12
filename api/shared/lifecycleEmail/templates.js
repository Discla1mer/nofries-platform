'use strict';

// Plain-text, versioned lifecycle email templates (#151). They greet nobody by
// name and carry a sign-in link only: never gap titles, answers or scores. The
// only placeholders are the sign-in and unsubscribe links the sender supplies.
const { TEMPLATE_VERSIONS: V } = require('./templateVersions');

const PLACEHOLDERS = Object.freeze(['signInUrl', 'unsubscribeUrl']);
const FOOTER = ['', '--', 'No Fries, nofries.nz',
    'You are getting this because you have a No Fries account. To stop these emails, unsubscribe: {{unsubscribeUrl}}'];
const template = (subject, ...body) => Object.freeze({ subject, lines: Object.freeze(['Kia ora,', '', ...body]) });
const TEMPLATES = Object.freeze({
    welcome: Object.freeze({ [V.welcome]: template('Welcome to No Fries',
        'Your No Fries account is ready. Sign in to start your cyber security self-assessment:', '{{signInUrl}}') }),
    result_summary: Object.freeze({ [V.result_summary]: template('Your No Fries results are ready',
        'Your assessment results are ready. Sign in to see them and your improvement plan:', '{{signInUrl}}', '',
        'For your security, we do not include any results in this email.') }),
    nudge_unfinished: Object.freeze({ [V.nudge_unfinished]: template('Your No Fries assessment is waiting',
        'You started a cyber security self-assessment but have not finished it yet. Sign in to pick up where you left off:', '{{signInUrl}}') }),
    reassess_reminder: Object.freeze({ [V.reassess_reminder]: template('Time to check your cyber security again',
        'It has been a while since your last assessment, and things change. Sign in to start a new one:', '{{signInUrl}}') })
});

class TemplateError extends Error { constructor(code) { super(code); this.code = code; } }

function link(value) {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new TemplateError('template_link_invalid');
    return url.toString();
}

function renderTemplate(type, version, links) {
    const template = Object.hasOwn(TEMPLATES, type) && Object.hasOwn(TEMPLATES[type], version) ? TEMPLATES[type][version] : null;
    if (!template) throw new TemplateError('template_unknown');
    const values = { signInUrl: link(links.signInUrl), unsubscribeUrl: link(links.unsubscribeUrl) };
    const text = [...template.lines, ...FOOTER].join('\n').replace(/\{\{([A-Za-z]+)\}\}/g, (_, name) => {
        if (!PLACEHOLDERS.includes(name)) throw new TemplateError('template_placeholder_invalid');
        return values[name];
    });
    return Object.freeze({ subject: template.subject, text });
}

module.exports = { TEMPLATES, PLACEHOLDERS, FOOTER, renderTemplate, TemplateError };
