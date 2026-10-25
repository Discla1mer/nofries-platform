'use strict';

// Presentation hints only. None is customer identity, permission or provider context.
const PUBLIC_PAGES = Object.freeze(['home', 'dashboard', 'managed-it', 'sales-agency', 'news', 'roadmap', 'luna']);
const MAIN_HELP_URL = 'https://nofries.nz/';
const STARTERS = Object.freeze([
    ['home', 'Explore the dashboard', 'What can I do in the No Fries dashboard?'],
    ['home', 'Create an account or log in', 'How do I create an account or log in to No Fries?'],
    ['home', 'Company or Consultant?', 'How do I choose between Company and Consultant accounts?'],
    ['dashboard', 'Save and resume', 'How do I save and resume an assessment?'],
    ['dashboard', 'Find saved results', 'How do I reopen submitted assessment results?'],
    ['dashboard', 'What can Fry access?', 'Can you read or change my organisation, forms or assessment answers?'],
    ['managed-it', 'Explore managed IT', 'What does No Fries managed IT include, and how is it different from the dashboard?'],
    ['sales-agency', 'About the Sales Agency', 'Where can I learn about the No Fries Sales Agency?'],
    ['news', 'Find No Fries news', 'Where can I find public No Fries news and product information?'],
    ['roadmap', 'What is available?', 'Which No Fries dashboard features are available, and which are planned?']
]);

function renderSharedAssistant(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('shared_assistant_options_invalid');
    const { fryAssetPath, page = 'home', transport = 'same-origin', helpOnly = ['home', 'dashboard'].includes(page) } = options;
    // Byte provenance remains the integrator's responsibility. Do not silently select another graphic.
    if (typeof fryAssetPath !== 'string' || !/^\/images\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|webp|avif|gif|svg)$/.test(fryAssetPath)) {
        throw new TypeError('shared_assistant_fry_asset_required');
    }
    if (!PUBLIC_PAGES.includes(page)) throw new TypeError('shared_assistant_page_invalid');
    if (!['same-origin', 'link-only'].includes(transport)) throw new TypeError('shared_assistant_transport_invalid');
    if (typeof helpOnly !== 'boolean' || (page === 'dashboard' && !helpOnly)) throw new TypeError('shared_assistant_help_mode_invalid');
    const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const availableStarters = page === 'home' || helpOnly ? STARTERS.filter(([topic]) => ['home', 'dashboard'].includes(topic)) : STARTERS;
    const starters = availableStarters.map(([topic, label, message]) => `<button type="button" data-assistant-starter-topic="${topic}" data-message="${escape(message)}"${topic === page || (page !== 'dashboard' && topic === 'home') ? '' : ' hidden'} disabled>${escape(label)}</button>`).join('\n');
    const greeting = 'How can I help?';
    const linkOnly = transport === 'link-only';
    return `<section class="nf-assistant" data-shared-assistant data-assistant-page="${page}" data-assistant-transport="${transport}" data-assistant-help-only="${helpOnly}">
    <button type="button" class="nf-assistant-launcher" data-assistant-launcher aria-label="Ask Fry about No Fries" aria-haspopup="dialog" aria-expanded="false" aria-controls="nofries-assistant-dialog">
        <img src="${escape(fryAssetPath)}" width="48" height="48" alt="" draggable="false">
        <span class="nf-assistant-launcher-label">Ask Fry</span>
    </button>
    <dialog class="nf-assistant-panel" id="nofries-assistant-dialog" aria-labelledby="nofries-assistant-heading" aria-describedby="nofries-assistant-boundary">
        <header class="nf-assistant-header">
            <div><p>No Fries</p><h2 id="nofries-assistant-heading">Ask Fry</h2></div>
            <button type="button" class="nf-assistant-close" data-assistant-close aria-label="Close No Fries chat">×</button>
        </header>
        <p class="nf-assistant-boundary" id="nofries-assistant-boundary">Public help only. No access to your organisation, forms or assessments. Keep private information out.</p>
        ${linkOnly ? `<div class="nf-assistant-handoff"><p>Continue on the main No Fries site to ask Fry about No Fries products and services.</p><a href="${MAIN_HELP_URL}">Open No Fries help</a></div>` : `<aside class="prospect-assistant" id="prospect-assistant" aria-label="No Fries public help">
            <div class="assistant-topline"><span id="assistant-runtime" class="assistant-runtime">Ready when you are</span><button type="button" id="assistant-reset" aria-label="Clear this chat view">Clear chat</button></div>
            <div class="assistant-messages" id="assistant-messages" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0" aria-label="Conversation">
                <div class="assistant-message is-assistant"><span>No Fries</span><p>${greeting}</p></div>
            </div>
            <div class="assistant-prompts" id="assistant-prompts" aria-label="Public help topics">${starters}</div>
            <form class="assistant-form" id="assistant-form">
                <label class="nf-assistant-input-label" for="assistant-input">Your question</label>
                <div class="nf-assistant-compose"><textarea id="assistant-input" rows="3" maxlength="2000" autocomplete="off" autocapitalize="sentences" enterkeyhint="enter" placeholder="Ask about No Fries…" aria-describedby="nofries-assistant-boundary assistant-compose-hint" required disabled></textarea><button type="submit" disabled>Send</button></div>
                <p class="nf-assistant-compose-hint" id="assistant-compose-hint">Enter to send · Shift+Enter for a new line</p>
                <div class="nf-assistant-actions"><button type="button" id="assistant-stop" hidden>Stop</button><button type="button" id="assistant-retry" hidden>Retry</button></div>
            </form>
            <p class="nf-assistant-history">${helpOnly ? 'Chat view lasts until you clear it or reload this page.' : 'Clear chat removes this page view, not any server records.'}</p>
            <p class="assistant-progress" id="assistant-progress" role="status" aria-live="polite">Public help · no account or assessment changes</p>
        </aside>`}
        <footer class="nf-assistant-footer"><a href="${MAIN_HELP_URL}">No Fries</a>${page === 'home' ? '' : '<a href="https://nofries.nz/roadmap.html">Roadmap</a>'}<a href="https://nofries.nz/privacy.html">Privacy</a></footer>
    </dialog>
</section>`;
}

module.exports = { MAIN_HELP_URL, PUBLIC_PAGES, renderSharedAssistant };
