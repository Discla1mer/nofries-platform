'use strict';
// Test-only CDP driver: uses the runner's installed Chromium and Node built-ins.
// No package download, production account, browser profile or provider credential.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

async function launch(origin) {
    const executable = [process.env.CHROMIUM_EXECUTABLE_PATH, '/usr/bin/chromium',
        '/usr/bin/chromium-browser', process.env.CHROME_BIN, '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));
    assert.ok(executable, 'Chromium is required: set CHROMIUM_EXECUTABLE_PATH to an installed browser');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-persona-browser-'));
    const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
        '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let socket, sequence = 0, sessionId, output = '', closed = false;
    const pending = new Map(), errors = [], unexpected = [];
    async function close() {
        if (closed) return; closed = true;
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('browser closed')); } pending.clear();
        socket?.close();
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
            let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]);
            clearTimeout(timer);
        }
        fs.rmSync(profile, { recursive: true, force: true });
    }
    function send(method, params = {}, target = sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }));
        });
    }
    try {
        const endpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Chromium startup timed out')), 15000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('Chromium exited before startup: ' + output.slice(-1000))); });
            child.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-8192);
                const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
        });
        socket = new WebSocket(endpoint);
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true }); });
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
                if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result); return; }
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
            if (message.method === 'Fetch.requestPaused') {
                const r = message.params, allowed = r.request.url.startsWith(origin + '/');
                if (!allowed) unexpected.push(r.request.method + ' ' + r.request.url);
                send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: r.requestId,
                    ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }, message.sessionId).catch(error => errors.push(error.message));
            }
        });
        const version = await send('Browser.getVersion', {}, null);
        const target = await send('Target.createTarget', { url: 'about:blank' }, null);
        sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
        await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        async function evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result.value;
        }
        async function wait(expression, label = expression) {
            const deadline = Date.now() + 12000;
            do { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
            throw new Error('Journey condition timed out: ' + label);
        }
        const selector = s => 'document.querySelector(' + JSON.stringify(s) + ')';
        async function click(s, twice = false) {
            await wait(selector(s) + ' && !' + selector(s) + '.disabled', 'enabled ' + s);
            await evaluate(selector(s) + '.scrollIntoView({block:"center"})');
            const box = await evaluate('(()=>{const r=' + selector(s) + '.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
            for (let count = 1; count <= (twice ? 2 : 1); count++) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: count });
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: count });
            }
        }
        async function fill(s, value, expectedValue = value) {
            await evaluate(selector(s) + '.focus()');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            if (value) await send('Input.insertText', { text: value });
            assert.equal(await evaluate(selector(s) + '.value'), expectedValue);
        }
        async function textScale(factor) {
            const measured = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('body,body *')].filter(n=>n instanceof HTMLElement);
                const sizes=nodes.map(n=>parseFloat(getComputedStyle(n).fontSize));
                nodes.forEach((n,i)=>n.style.setProperty('font-size',(sizes[i]*${factor})+'px','important'));
                return {before:sizes[nodes.indexOf(document.querySelector('h1,h2'))],after:parseFloat(getComputedStyle(document.querySelector('h1,h2')).fontSize)};})()`);
            assert.equal(measured.after, measured.before * factor, 'Text really doubles; device scale/viewport zoom is not substituted'); return measured;
        }
        return { version: version.product, errors, unexpected, send, evaluate, wait, click, fill, textScale, close,
            async navigate(url, width) { await send('Emulation.setDeviceMetricsOverride', { width, height: width === 320 ? 700 : 900, deviceScaleFactor: 1, mobile: false }); await send('Page.navigate', { url }); await wait('location.href === ' + JSON.stringify(url) + ' && document.readyState === "complete"'); } };
    } catch (error) { await close(); throw error; }
}
module.exports = { launch };
