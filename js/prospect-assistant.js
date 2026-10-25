(function (global) {
    const instances = new WeakMap();
    // Exact destinations from the reviewed public knowledge; model-provided URLs
    // never choose an origin, path, query, fragment or redirect.
    const publicLinks = new Set([
        'https://nofries.nz/', 'https://nofries.nz/dashboard', 'https://nofries.nz/login',
        'https://nofries.nz/managed-it.html', 'https://nofries.nz/scoping',
        'https://nofries.nz/roadmap.html', 'https://nofries.nz/privacy.html',
        'https://news.nofries.nz/', 'https://sales.nofries.nz/', 'https://luna.nofries.nz/'
    ]);

    function mount(options = {}) {
        const find = options.root
            ? (id) => options.root.querySelector('#' + id)
            : (id) => document.getElementById(id);
        const shell = find('prospect-assistant');
        const form = find('assistant-form');
        const input = find('assistant-input');
        const messages = find('assistant-messages');
        const prompts = find('assistant-prompts');
        const runtimeBadge = find('assistant-runtime');
        const progress = find('assistant-progress');
        const submit = form && form.querySelector('button[type="submit"]');
        let busy = false;
        let ready = false;
        let initialisation = null;
        let startupOperation = null;
        let chatOperation = null;
        let retryMessage = null;
        const stopButton = find('assistant-stop');
        const retryButton = find('assistant-retry');
        const resetButton = find('assistant-reset');

        if (!shell || !form || !input || !messages || !runtimeBadge || !progress) return null;
        if (instances.has(shell)) return instances.get(shell);

        const helpOnly = options.helpOnly === true;
        const publicHelp = options.publicHelp === true || helpOnly;
        const unavailable = publicHelp
            ? 'Chat is unavailable. Use the public links below or reload this page later.'
            : 'The chat is not available yet. The service information remains available below.';
        const controller = Object.freeze({
            open: () => ensureInitialised().then(() => ready),
            isReady: () => ready && !busy,
            stop,
            reset
        });
        instances.set(shell, controller);

        const promptButtons = prompts ? Array.from(prompts.querySelectorAll('[data-message]')) : [];
        setControlsEnabled(false);

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            send(input.value, true);
        });
        input.addEventListener('keydown', (event) => {
            if (publicHelp && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                send(input.value, true);
            }
        });
        if (stopButton) stopButton.addEventListener('click', stop);
        if (resetButton) resetButton.addEventListener('click', reset);
        if (retryButton) retryButton.addEventListener('click', () => {
            if (busy || startupOperation) return;
            if (!ready) ensureInitialised();
            else if (retryMessage) send(retryMessage);
        });
        if (prompts) {
            prompts.addEventListener('click', (event) => {
                const target = event.target.closest('[data-message]');
                if (target) send(target.dataset.message);
            });
        }
        // Dashboard visitors have not requested the optional managed-IT service.
        // Its existing session/pricing contract is loaded only from the service entry.
        if (options.activation === 'manual') {
            // Shared launchers initialise only after their explicit open action.
        } else if (document.body && document.body.dataset.product === 'dashboard') {
            document.addEventListener('click', (event) => {
                const opener = event.target && typeof event.target.closest === 'function'
                    ? event.target.closest('[data-dialog]') : null;
                if (opener && ['discovery-dialog', 'pricing-dialog'].includes(opener.dataset.dialog)) {
                    const dialog = opener.dataset.dialog === 'discovery-dialog'
                        ? document.getElementById('discovery-dialog') : null;
                    const focusAtOpen = document.activeElement;
                    ensureInitialised().then(() => {
                        // Native dialog opening precedes this listener. Wait for the
                        // input to be enabled, but never steal focus after a visitor
                        // has moved elsewhere or closed the dialog during the fetch.
                        if (dialog && dialog.open && ready && !busy && !input.disabled &&
                            document.activeElement === focusAtOpen && focusAtOpen !== input) {
                            input.focus();
                            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    });
                }
            });
        } else {
            ensureInitialised();
        }

        function ensureInitialised() {
            if (!initialisation) {
                const pending = initialise().then((completed) => {
                    // Cache valid ready/disabled responses, not a failed request.
                    // A retry needs another explicit service opening; never loop
                    // automatically or replay a user's message.
                    if (!completed && initialisation === pending) initialisation = null;
                    setControlsEnabled(ready && !busy);
                    return completed;
                });
                initialisation = pending;
            }
            return initialisation;
        }

        function setControlsEnabled(enabled) {
            // Shared public chat permits drafting while a submitted turn is busy.
            // Legacy discovery retains its established disabled/focus behaviour.
            input.disabled = !(publicHelp ? ready : enabled);
            if (submit) submit.disabled = !enabled;
            promptButtons.forEach((button) => { button.disabled = !enabled; });
            if (stopButton) stopButton.hidden = !busy && !startupOperation;
            if (retryButton) {
                retryButton.hidden = busy || !!startupOperation || !(retryMessage || (!ready && initialisation === null));
                retryButton.textContent = ready ? 'Retry last question' : 'Retry connection';
            }
        }

        // Race the entire operation, including response bodies and idle streams.
        // Aborting alone is insufficient when a transport never settles its read.
        function operation(milliseconds) {
            const abort = new AbortController();
            let rejectWait;
            let active = true;
            const interrupted = new Promise((_, reject) => { rejectWait = reject; });
            const cancel = (reason) => {
                if (!active) return;
                active = false;
                abort.abort();
                rejectWait(new Error(reason));
            };
            const timer = setTimeout(() => cancel('The request timed out. Retry when you are ready.'), milliseconds);
            return {
                signal: abort.signal,
                assertActive() { if (!active) throw new Error('Request ended.'); },
                run: promise => Promise.race([promise, interrupted]),
                cancel,
                finish() { active = false; clearTimeout(timer); }
            };
        }

        async function initialise() {
            ready = false;
            const current = operation(15000);
            startupOperation = current;
            setControlsEnabled(false);
            progress.textContent = 'Connecting to public help…';
            try {
                const payload = await current.run((async () => {
                    const response = await fetch(helpOnly ? '/api/prospect/session?publicHelpOnly=true' : '/api/prospect/session', {
                        method: 'GET',
                        credentials: 'same-origin',
                        headers: { Accept: 'application/json' },
                        signal: current.signal
                    });
                    const body = await response.json();
                    if (!response.ok) throw new Error('Chat set-up pending');
                    return body;
                })());
                current.assertActive();
                if (startupOperation !== current) return false;
                if (!payload || !payload.assistant || !payload.assistant.runtime ||
                    typeof payload.assistant.runtime.mode !== 'string') throw new Error('Invalid chat setup.');
                // A legacy/rolled-back server must never enable help-only input.
                if (helpOnly && (payload.assistant.publicHelpOnly !== true ||
                    payload.assistant.publicHelpProtocol !== 'public-help-v1')) {
                    throw new Error('Public help is unavailable.');
                }
                setRuntime(payload.assistant.runtime);
                if (!publicHelp) setPricing(payload.assistant.pricing);
                if (!publicHelp && options.restoreHistory !== false) restoreMessages(payload.conversation && payload.conversation.messages || []);
                progress.textContent = publicHelp ? 'Public help · no account or assessment changes' : 'Indicative pricing · no commitment';
                updateProgress(payload.organisation);
                ready = payload.assistant.runtime.mode !== 'disabled';
                if (!ready) progress.textContent = unavailable;
                return true; // Explicit server-disabled status is a valid response.
            } catch (error) {
                if (startupOperation !== current) return false;
                setRuntime({ mode: 'disabled' });
                progress.textContent = current.signal.aborted ? error.message : publicHelp
                    ? 'Chat is unavailable. Use Retry connection or the public links below.' : unavailable;
                ready = false;
                return false;
            } finally {
                current.finish();
                if (startupOperation === current) {
                    startupOperation = null;
                    setControlsEnabled(ready && !busy);
                }
            }
        }

        function stop() {
            if (startupOperation) startupOperation.cancel('Connection stopped. Use Retry connection when you are ready.');
            if (chatOperation) chatOperation.cancel('Response stopped. Retry last question when you are ready.');
        }

        function reset() {
            const startup = startupOperation;
            const chat = chatOperation;
            startupOperation = null;
            chatOperation = null;
            if (startup) { startup.cancel('Chat cleared.'); initialisation = null; }
            if (chat) chat.cancel('Chat cleared.');
            busy = false;
            retryMessage = null;
            input.value = '';
            messages.replaceChildren();
            addMessage('assistant', publicHelp
                ? 'How can I help?'
                : 'Hi, what would you like to know about No Fries?');
            if (prompts) prompts.hidden = false;
            progress.textContent = publicHelp ? 'Public help · no account or assessment changes' : 'Indicative pricing · no commitment';
            setControlsEnabled(ready);
        }

        async function send(rawMessage, fromComposer = false) {
            const message = String(rawMessage || '').trim();
            if (!ready || !message || message.length > 2000 || busy) return;
            busy = true;
            retryMessage = null;
            if (fromComposer) input.value = '';
            const current = operation(45000);
            chatOperation = current;
            setControlsEnabled(false);
            if (prompts) prompts.hidden = true;
            addMessage('user', message);
            const assistant = addMessage('assistant', '', true);
            let focusMoved = false;
            const recordFocusMove = () => { focusMoved = true; };
            document.addEventListener('focusin', recordFocusMove);
            const guard = () => {
                current.assertActive();
                if (chatOperation !== current) throw new Error('Request ended.');
            };
            try {
                await current.run((async () => {
                    const response = await fetch('/api/prospect/chat', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
                        body: JSON.stringify(helpOnly ? { publicHelpMessage: message, publicHelpOnly: true } : { message }),
                        signal: current.signal
                    });
                    guard();
                    if (!response.ok) {
                        const payload = await response.json().catch(() => ({}));
                        guard();
                        const error = new Error(publicHelp ? 'The assistant could not respond. Please retry when you are ready.'
                            : payload.error || 'The assistant could not respond.');
                        // Preserve legacy discovery's rate-limit draft recovery.
                        error.retryableMessage = response.status === 429 && !publicHelp;
                        throw error;
                    }
                    await consumeSse(response, {
                        ready(data) { guard(); setRuntime(data.runtime); },
                        delta(data) {
                            guard();
                            assistant.text.textContent += data.delta;
                            scrollMessages();
                        },
                        done(data) {
                            guard();
                            renderAssistantText(assistant.text, data.text);
                            setRuntime(data.runtime);
                            updateProgress(data.organisation);
                        }
                    }, current);
                })());
                guard();
                progress.textContent = publicHelp ? 'Public help · no account or assessment changes' : progress.textContent;
            } catch (error) {
                if (chatOperation !== current) return;
                // Do not present a partial or unvalidated stream as an answer.
                assistant.text.textContent = error.retryableMessage
                    ? `${error.message || 'Please wait and try again.'} Your message is still in the box.`
                    : publicHelp && !current.signal.aborted ? 'The reply could not be completed. Retry last question when you are ready.'
                    : error.message || 'The assistant could not respond. Please try again.';
                assistant.node.classList.add('is-error');
                retryMessage = message;
                if (error.retryableMessage && !input.value) input.value = message;
                progress.textContent = publicHelp ? 'No complete reply received. Retry sends your last question again.' : progress.textContent;
            } finally {
                current.finish();
                document.removeEventListener('focusin', recordFocusMove);
                if (chatOperation === current) {
                    assistant.node.classList.remove('is-typing');
                    chatOperation = null;
                    busy = false;
                    setControlsEnabled(ready);
                    const dialog = !publicHelp && document.getElementById('discovery-dialog');
                    const open = typeof options.isOpen === 'function' ? options.isOpen() : !dialog || dialog.open;
                    // Public composition stays editable, so async replies need not
                    // move focus. Legacy disabled-input recovery remains intact.
                    if (!publicHelp && open && !input.disabled && !focusMoved) input.focus();
                    scrollMessages();
                }
            }
        }

        async function consumeSse(response, handlers, current) {
            let terminal = false;
            let characters = 0;
            const accept = (value) => {
                current.assertActive();
                for (const frame of String(value || '').split(/\r?\n\r?\n/).filter(Boolean)) {
                    let event = 'message';
                    const dataLines = [];
                    frame.split(/\r?\n/).forEach((line) => {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                    });
                    if (!dataLines.length) continue; // SSE comments/keepalive.
                    if (terminal) throw new Error('Invalid reply after completion.');
                    let data;
                    try { data = JSON.parse(dataLines.join('\n')); } catch (_) { throw new Error('Malformed reply.'); }
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Malformed reply.');
                    if (event === 'error') throw new Error('The assistant could not respond. Please try again.');
                    if (!['ready', 'delta', 'done'].includes(event)) throw new Error('Unexpected reply event.');
                    if (event === 'delta' && typeof data.delta !== 'string') throw new Error('Malformed reply.');
                    if (event === 'done' && (typeof data.text !== 'string' || !data.text.trim())) throw new Error('Incomplete reply.');
                    if (typeof handlers[event] === 'function') handlers[event](data);
                    if (event === 'done') terminal = true;
                }
            };
            if (!response.body || typeof response.body.getReader !== 'function') {
                const text = await response.text();
                current.assertActive();
                if (text.length > 100000) throw new Error('Reply too long.');
                accept(text);
            } else {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                const cancelReader = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
                current.signal.addEventListener('abort', cancelReader, { once: true });
                try {
                    while (!terminal) {
                        const { done, value } = await reader.read();
                        current.assertActive();
                        if (done) { buffer += decoder.decode(); break; }
                        buffer += decoder.decode(value, { stream: true });
                        characters += value.byteLength;
                        if (characters > 100000) throw new Error('Reply too long.');
                        const frames = buffer.split(/\r?\n\r?\n/);
                        buffer = frames.pop() || '';
                        accept(frames.join('\n\n'));
                    }
                    if (buffer.trim()) accept(buffer);
                } finally {
                    current.signal.removeEventListener('abort', cancelReader);
                    cancelReader();
                }
            }
            if (!terminal) throw new Error('The reply ended before completion. Please try again.');
        }

        function renderAssistantText(paragraph, value) {
            const text = presentAssistantText(value);
            paragraph.textContent = text;
            const matches = [...text.matchAll(/https?:\/\/[^\s<>"'`]+/g)];
            if (!matches.length) return;
            const nodes = [];
            let offset = 0;
            for (const match of matches) {
                const url = match[0].replace(/[.,;:!?)\]}]+$/, '');
                if (!publicLinks.has(url)) continue;
                nodes.push(document.createTextNode(text.slice(offset, match.index)));
                const anchor = document.createElement('a');
                anchor.setAttribute('href', url);
                anchor.textContent = url;
                nodes.push(anchor);
                offset = match.index + url.length;
            }
            if (!nodes.length) return;
            nodes.push(document.createTextNode(text.slice(offset)));
            paragraph.replaceChildren(...nodes);
        }

        function restoreMessages(items) {
            if (!items.length) return;
            messages.replaceChildren();
            items.slice(-20).forEach((item) => addMessage(item.role, item.text));
            scrollMessages();
        }

        function addMessage(role, text, typing) {
            const node = document.createElement('div');
            node.className = `assistant-message is-${role === 'user' ? 'user' : 'assistant'}${typing ? ' is-typing' : ''}`;
            const label = document.createElement('span');
            label.textContent = role === 'user' ? 'You' : 'No Fries';
            const paragraph = document.createElement('p');
            if (role === 'assistant' && !typing) renderAssistantText(paragraph, text);
            else paragraph.textContent = text;
            node.append(label, paragraph);
            messages.append(node);
            // Bound only the mounted view; never persist public questions.
            while (messages.children.length > 40) messages.removeChild(messages.children[0]);
            scrollMessages();
            return { node, text: paragraph };
        }

        function setRuntime(runtime) {
            const value = runtime || {};
            runtimeBadge.textContent = value.mode === 'disabled'
                ? 'Unavailable'
                : helpOnly
                    ? value.mode === 'mock' ? 'Public help preview' : 'Public help'
                : value.mode === 'mock'
                    ? 'Preview'
                    : 'AI assistant';
            runtimeBadge.className = 'assistant-runtime';
            if (value.mode === 'mock') runtimeBadge.classList.add('is-preview');
            if (value.mode === 'disabled') runtimeBadge.classList.add('is-unavailable');
        }

        function setPricing(pricing) {
            const value = pricing || {};
            const perUser = Number(value.perUserMonthly);
            const onboarding = Number(value.onboardingFrom);
            const additionalEndpoint = Number(value.additionalEndpointMonthly);
            const additionalLocation = Number(value.additionalLocationMonthly);
            const rate = document.getElementById('managed-it-per-user-price');
            const summary = document.getElementById('managed-it-price-summary');
            const extras = document.getElementById('managed-it-price-extras');
            if (!rate || !summary || !Number.isFinite(perUser) || !Number.isFinite(onboarding)) return;

            const taxLabel = value.gstExclusive ? ' + GST' : '';
            rate.textContent = `NZ$${perUser.toLocaleString('en-NZ')}${taxLabel}`;
            rate.dataset.policyId = String(value.policyId || '');
            summary.textContent = `Per user each month, including support for one main work computer. Initial set-up starts at NZ$${onboarding.toLocaleString('en-NZ')}${taxLabel}.`;
            if (extras && Number.isFinite(additionalEndpoint) && Number.isFinite(additionalLocation)) {
                extras.textContent = `Additional computers are NZ$${additionalEndpoint.toLocaleString('en-NZ')}${taxLabel} each per month. Additional locations are NZ$${additionalLocation.toLocaleString('en-NZ')}${taxLabel} each per month. Protection, after-hours security help, backup and other separately quoted work are agreed before the service starts.`;
            }
        }

        function updateProgress(organisation) {
            if (publicHelp) return;
            if (!organisation || !organisation.discovery) return;
            const unknown = organisation.discovery.missingFields && organisation.discovery.missingFields.length || 0;
            progress.textContent = unknown
                ? 'Indicative pricing · no commitment'
                : 'Ready for an indicative price';
        }

        function presentAssistantText(value) {
            return String(value || '')
                .replace(/\r\n/g, '\n')
                .replace(/(^|\s)#{1,6}[ \t]+/g, '$1')
                .replace(/\*\*([^*\n]+)\*\*/g, '$1')
                .replace(/__([^_\n]+)__/g, '$1')
                .replace(/^([ \t]*)[-*][ \t]+/gm, '$1• ')
                .trim();
        }

        function scrollMessages() {
            messages.scrollTop = messages.scrollHeight;
        }

        return controller;
    }

    global.NoFriesProspectAssistant = Object.freeze({ mount });
    const legacyShell = document.getElementById('prospect-assistant');
    if (legacyShell && !(typeof legacyShell.closest === 'function' && legacyShell.closest('[data-shared-assistant]'))) {
        mount();
    }
}(globalThis));
