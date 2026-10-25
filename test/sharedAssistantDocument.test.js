'use strict';

const { MAIN_HELP_URL, PUBLIC_PAGES, renderSharedAssistant } = require('../lib/sharedAssistantDocument');

const fixture = { fryAssetPath: '/images/synthetic-fry-fixture.png' };

test('the real Fry asset is required and is never replaced by an invented default', () => {
    expect(() => renderSharedAssistant()).toThrow('shared_assistant_fry_asset_required');
    for (const path of ['https://example.test/fry.png', '//example.test/fry.png', '/images/../private.png',
        '/images/fry.png?token=private', '/images/fry.png#private', '/images/fry%2epng', '/images/fry" onerror="x.png']) {
        expect(() => renderSharedAssistant({ fryAssetPath: path })).toThrow('shared_assistant_fry_asset_required');
    }
    const html = renderSharedAssistant(fixture);
    expect(html).toContain('src="/images/synthetic-fry-fixture.png"');
    expect(html).not.toMatch(/data:image|onerror=|<svg|<script|<style/);
});

test('one labelled closed launcher and non-modal-ready dialog contain no automatic action', () => {
    const html = renderSharedAssistant(fixture);
    expect(html.match(/data-assistant-launcher\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Ask Fry about No Fries"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="nofries-assistant-dialog"');
    expect(html).toContain('aria-labelledby="nofries-assistant-heading"');
    expect(html).toContain('aria-describedby="nofries-assistant-boundary"');
    expect(html).not.toMatch(/<dialog[^>]+\bopen\b|autofocus|autoplay|fetch\(/);
    expect(html).toContain('role="log" aria-live="polite"');
    expect(html).toContain('id="assistant-input"');
    expect(html).toContain('required disabled');
    expect(html).toContain('Keep private information out.');
});

test('closed public page hints select existing fixed starters without customer identity or permissions', () => {
    expect(Object.isFrozen(PUBLIC_PAGES)).toBe(true);
    for (const page of PUBLIC_PAGES) {
        const html = renderSharedAssistant({ ...fixture, page });
        expect(html).toContain(`data-assistant-page="${page}"`);
        expect(html).toContain('<p>How can I help?</p>');
        expect(html).toContain('for="assistant-input">Your question</label>');
        const visible = [...html.matchAll(/<button[^>]+data-assistant-starter-topic="([^"]+)"[^>]*>/g)]
            .filter(match => !match[0].includes(' hidden')).map(match => match[1]);
        expect(visible).toEqual(page === 'home' || page === 'luna' ? ['home', 'home', 'home'] : page === 'dashboard'
            ? ['dashboard', 'dashboard', 'dashboard'] : ['home', 'home', 'home', page]);
        expect(html).not.toMatch(/data-(?:organisation|tenant|assessment|customer|account|session)-id|document\.cookie/);
    }
    for (const page of ['private-organisation-id', '/dashboard?token=secret', '__proto__', '<script>']) {
        expect(() => renderSharedAssistant({ ...fixture, page })).toThrow('shared_assistant_page_invalid');
    }
});

test('dashboard public guidance is forced into the deterministic help-only mode', () => {
    const html = renderSharedAssistant({ ...fixture, page: 'dashboard' });
    expect(html).toContain('data-assistant-help-only="true"');
    expect(html).toContain('Public help only. No access to your organisation, forms or assessments.');
    expect(() => renderSharedAssistant({ ...fixture, page: 'dashboard', helpOnly: false })).toThrow('shared_assistant_help_mode_invalid');
    expect(() => renderSharedAssistant({ ...fixture, helpOnly: 'true' })).toThrow('shared_assistant_help_mode_invalid');
    expect(renderSharedAssistant({ ...fixture, helpOnly: true })).toContain('data-assistant-help-only="true"');
    expect(renderSharedAssistant({ ...fixture, page: 'managed-it' })).toContain('data-assistant-help-only="false"');
});

test('foreign-origin presentation offers a fixed public handoff with no local chat form or API origin', () => {
    const html = renderSharedAssistant({ ...fixture, page: 'luna', transport: 'link-only' });
    expect(MAIN_HELP_URL).toBe('https://nofries.nz/');
    expect(html).toContain('data-assistant-transport="link-only"');
    expect(html).toContain(`href="${MAIN_HELP_URL}">Open No Fries help`);
    expect(html).not.toContain('id="assistant-form"');
    expect(html).not.toContain('id="prospect-assistant"');
    expect(html).not.toMatch(/\/api\/|returnTo|access_token|iframe|crossorigin/);
    expect(() => renderSharedAssistant({ ...fixture, transport: 'https://nofries.nz/api' })).toThrow('shared_assistant_transport_invalid');
});

test('the shared public template does not promote or link to Luna', () => {
    const html = renderSharedAssistant(fixture);
    expect(html).not.toMatch(/luna\.nofries\.nz|>About Luna<|data-assistant-starter-topic="luna"/);
});

test('the homepage help template contains dashboard help and legal links without other product promotion', () => {
    const html = renderSharedAssistant(fixture);
    expect(html).toContain('data-assistant-help-only="true"');
    expect(html).toContain('Explore the dashboard');
    expect(html).not.toMatch(/managed IT|managed-it|Sales Agency|sales-agency|News|news\.nofries|Luna|luna\.nofries|Roadmap|roadmap\.html|Service pricing/);
    expect(html).toContain('https://nofries.nz/privacy.html');
    expect([...html.matchAll(/data-assistant-starter-topic="([^"]+)"/g)].map(match => match[1])).toEqual(['home', 'home', 'home', 'dashboard', 'dashboard', 'dashboard']);
});

test('public chat exposes a multiline labelled composer, recovery controls and truthful local clear scope', () => {
    const html = renderSharedAssistant({ ...fixture, page: 'dashboard' });
    expect(html).toContain('<textarea id="assistant-input" rows="3" maxlength="2000"');
    expect(html).toContain('aria-describedby="nofries-assistant-boundary assistant-compose-hint"');
    expect(html).toContain('Shift+Enter for a new line');
    for (const id of ['assistant-stop', 'assistant-retry', 'assistant-reset']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Chat view lasts until you clear it or reload this page.');
    expect(renderSharedAssistant({ ...fixture, page: 'managed-it' })).toContain('not any server records');
    expect(html).not.toMatch(/<input[^>]+id="assistant-input"|localStorage|sessionStorage/);
});

test('home and dashboard expose multiple relevant fixed public questions', () => {
    for (const [page, labels] of [['home', ['Explore the dashboard', 'Create an account or log in', 'Company or Consultant?']],
        ['dashboard', ['Save and resume', 'Find saved results', 'What can Fry access?']]]) {
        const html = renderSharedAssistant({ ...fixture, page });
        const visible = [...html.matchAll(/<button[^>]+data-assistant-starter-topic="[^"]+"[^>]*>([^<]+)<\/button>/g)]
            .filter(match => !match[0].includes(' hidden')).map(match => match[1]);
        expect(visible).toEqual(labels);
    }
});
