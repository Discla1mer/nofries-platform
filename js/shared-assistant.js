(function (global) {
    'use strict';
    const instances = new WeakMap();
    const publicPages = Object.freeze(['home', 'dashboard', 'managed-it', 'sales-agency', 'news', 'roadmap', 'luna']);

    function mount(root) {
        if (!root || typeof root.querySelector !== 'function') return null;
        if (instances.has(root)) return instances.get(root);
        const launcher = root.querySelector('[data-assistant-launcher]');
        const dialog = root.querySelector('#nofries-assistant-dialog');
        const closeButton = root.querySelector('[data-assistant-close]');
        if (!launcher || !dialog || !closeButton || typeof dialog.show !== 'function') return null;
        const page = publicPages.includes(root.dataset.assistantPage) ? root.dataset.assistantPage : 'home';
        const transport = root.dataset.assistantTransport;
        // There is no configurable API origin. Other origins use the public link handoff.
        if (!['same-origin', 'link-only'].includes(transport)) return null;
        if (!['true', 'false'].includes(root.dataset.assistantHelpOnly)) return null;
        const helpOnly = root.dataset.assistantHelpOnly === 'true';
        if (page === 'dashboard' && !helpOnly) return null;
        let client = null;
        let opener = launcher;
        let startedOutside = false;

        const input = root.querySelector('#assistant-input');
        const composer = root.querySelector('.nf-assistant-compose');
        const header = root.querySelector('.nf-assistant-header');
        if (input && composer && header) {
            let headerHeight = -1;
            const measureHeader = () => {
                const height = Math.ceil(header.getBoundingClientRect().height);
                if (height !== headerHeight) {
                    headerHeight = height;
                    root.style.setProperty('--nf-assistant-header-height', height + 'px');
                }
            };
            const revealComposer = () => {
                if (!dialog.open) return;
                measureHeader();
                // Native control focus may reveal only its caret or Send. Use
                // the whole composer and the rendered sticky header clearance.
                composer.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
            };
            const reflowComposer = () => {
                if (!dialog.open) return;
                measureHeader();
                // Reflow may move an already-focused composer under the header.
                // Preserve another control's focus and scroll position.
                if (composer.contains(document.activeElement)) revealComposer();
            };
            input.addEventListener('focus', revealComposer);
            const send = composer.querySelector('button[type="submit"]');
            if (send) send.addEventListener('focus', revealComposer);
            if (typeof global.ResizeObserver === 'function') {
                const resize = new global.ResizeObserver(reflowComposer);
                [header, dialog, composer].forEach(node => resize.observe(node));
            }
            if (typeof global.addEventListener === 'function') global.addEventListener('resize', reflowComposer);
        }

        // Reserve the real dashboard taskbar, including wrapped/zoomed rows.
        // Only its presence and geometry are read; no account content is used.
        if (transport === 'same-origin' && ['home', 'dashboard'].includes(page) &&
            typeof global.ResizeObserver === 'function' && typeof global.MutationObserver === 'function') {
            let navigation = null;
            const reserveNavigation = () => {
                const next = document.querySelector('.dashboard-mobile-nav');
                if (next !== navigation) {
                    if (navigation) resize.unobserve(navigation);
                    navigation = next;
                    if (navigation) resize.observe(navigation);
                }
                const bounds = navigation && navigation.getBoundingClientRect();
                const height = bounds && bounds.width > 0 && bounds.height > 0
                    ? Math.max(0, Math.ceil(global.innerHeight - bounds.top)) : 0;
                root.style.setProperty('--nf-assistant-dashboard-bottom', height + 'px');
            };
            const resize = new global.ResizeObserver(reserveNavigation);
            new global.MutationObserver(reserveNavigation).observe(document.body, { childList: true, subtree: true });
            global.addEventListener('resize', reserveNavigation);
            reserveNavigation();
        }

        function setTopic(value) {
            const buttons = Array.from(root.querySelectorAll('[data-assistant-starter-topic]'));
            const permitted = publicPages.includes(value) && buttons.some(button => button.dataset.assistantStarterTopic === value);
            const topic = permitted ? value : page;
            const prompts = root.querySelector('#assistant-prompts');
            if (prompts && publicPages.includes(value)) prompts.hidden = false;
            buttons.forEach(button => {
                button.hidden = !(page === 'dashboard' ? [topic] : ['home', topic]).includes(button.dataset.assistantStarterTopic);
            });
        }

        function ensureClient() {
            if (!client && global.NoFriesProspectAssistant && typeof global.NoFriesProspectAssistant.mount === 'function') {
                client = global.NoFriesProspectAssistant.mount({ root, activation: 'manual', publicHelp: true, helpOnly,
                    // A public visitor history is not selected-organisation history.
                    restoreHistory: false, isOpen: () => dialog.open });
            }
            return client;
        }

        async function open(options = {}) {
            const source = options.opener;
            if (source && typeof source.focus === 'function') opener = source;
            if (!dialog.open) {
                if (!source) opener = launcher;
                setTopic(options.topic);
                dialog.show();
                launcher.setAttribute('aria-expanded', 'true');
                closeButton.focus();
            } else if (publicPages.includes(options.topic)) {
                setTopic(options.topic);
            }
            if (transport === 'link-only') return;
            const activeAtOpen = document.activeElement;
            const current = ensureClient();
            if (!current) {
                const progress = root.querySelector('#assistant-progress');
                if (progress) progress.textContent = 'Chat is unavailable. Use the public links below.';
                return;
            }
            try {
                const ready = await current.open();
                const input = root.querySelector('#assistant-input');
                if (ready && current.isReady() && dialog.open && document.activeElement === activeAtOpen &&
                    activeAtOpen === closeButton && input && !input.disabled) input.focus();
            } catch (_) {
                // Never start a retry or submit a prompt after an unexpected failure.
            }
        }

        function close() {
            if (dialog.open) dialog.close();
        }

        launcher.addEventListener('click', () => {
            if (dialog.open) close();
            else open({ opener: launcher });
        });
        closeButton.addEventListener('click', close);
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); }
        });
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('close', () => {
            // A queued native close event may arrive after a deliberate reopen.
            if (dialog.open) return;
            launcher.setAttribute('aria-expanded', 'false');
            startedOutside = false;
            if (document.activeElement === document.body || dialog.contains(document.activeElement)) opener.focus();
        });
        document.addEventListener('pointerdown', event => {
            startedOutside = dialog.open && event.button === 0 && event.isPrimary !== false &&
                !root.contains(event.target) && !(event.target.closest && event.target.closest('[data-assistant-open]'));
        });
        document.addEventListener('pointercancel', () => { startedOutside = false; });
        document.addEventListener('click', event => {
            const source = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('[data-assistant-open]') : null;
            if (source && !source.disabled) {
                event.preventDefault();
                open({ opener: source, topic: source.dataset.assistantTopic });
                startedOutside = false;
                return;
            }
            const dismiss = startedOutside && event.detail !== 0 && !root.contains(event.target);
            startedOutside = false;
            if (dismiss) close();
        });

        const controller = Object.freeze({ open, close,
            setPosition({ bottom = 0, right = 0 } = {}) {
                if (![bottom, right].every(value => Number.isFinite(value) && value >= 0 && value <= 400)) {
                    throw new TypeError('shared_assistant_position_invalid');
                }
                root.style.setProperty('--nf-assistant-bottom-offset', bottom + 'px');
                root.style.setProperty('--nf-assistant-right-offset', right + 'px');
            }
        });
        instances.set(root, controller);
        return controller;
    }

    global.NoFriesSharedAssistant = Object.freeze({ mount });
    // Mounting binds local events only. GET session, POST chat and prompts wait for explicit clicks.
    document.querySelectorAll('[data-shared-assistant]').forEach(root => mount(root));
}(globalThis));
