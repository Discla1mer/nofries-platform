const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'scoping-copy.js'), 'utf8');

describe('authenticated MSP scoping copy layer', () => {
    test('is valid JavaScript and contains no legacy organisation naming', () => {
        expect(() => new Function(source)).not.toThrow();
        expect(source).toContain('Customer set-up');
        expect(source).toContain('Managed IT service review');
        expect(source).not.toContain('Kordia');
    });

    test('protected shell reserves one build-time inline runtime and no external scoping scripts', () => {
        const shell = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'mssp.html'), 'utf8');
        expect(shell.match(/<!-- SCOPING_RUNTIME -->/g)).toHaveLength(1);
        expect(shell).not.toContain('/js/app-loader.js');
        expect(shell).not.toContain('/js/scoping-copy.js');
        expect(shell).not.toContain('/assets/scoping-app.js');
    });

    test('observer copy rewrites settle instead of scheduling an endless mutation loop', () => {
        const pendingObservers = [];
        let observerCallback = null;
        const getObserver = () => observerCallback;
        const paragraph = mutationNode('Original description', pendingObservers, getObserver);
        const heading = mutationNode('Sales & onboarding workspace', pendingObservers, getObserver, {
            closest: () => ({ querySelector: () => paragraph })
        });
        const root = {
            querySelector: jest.fn((selector) => selector.includes('page-heading h1') ? heading : null),
            querySelectorAll: jest.fn(() => [])
        };
        const activeNav = { dataset: { view: 'overview' } };

        class FakeMutationObserver {
            constructor(callback) {
                observerCallback = callback;
            }

            observe() {}
        }

        vm.runInNewContext(source, {
            document: {
                getElementById: () => root,
                querySelector: () => activeNav
            },
            MutationObserver: FakeMutationObserver
        });

        let callbacks = 0;
        while (pendingObservers.length && callbacks < 10) {
            const callback = pendingObservers.shift();
            callback();
            callbacks += 1;
        }

        expect(heading.textContent).toBe('Customer set-up');
        expect(paragraph.textContent).toContain('Move a qualified prospect');
        expect(callbacks).toBe(2);
        expect(pendingObservers).toHaveLength(0);
    });
});

function mutationNode(initialText, pendingObservers, getObserver, overrides = {}) {
    let text = initialText;
    const node = Object.assign({
        querySelector: () => null,
        closest: () => null
    }, overrides);
    Object.defineProperty(node, 'textContent', {
        get() {
            return text;
        },
        set(value) {
            text = value;
            const callback = getObserver();
            if (callback) pendingObservers.push(callback);
        }
    });
    return node;
}
