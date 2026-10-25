const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'mssp.js'),
    'utf8'
);

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        add(value) {
            values.add(value);
        },
        remove(value) {
            values.delete(value);
        },
        toggle(value, force) {
            if (force === true) {
                values.add(value);
                return true;
            }
            if (force === false) {
                values.delete(value);
                return false;
            }
            if (values.has(value)) {
                values.delete(value);
                return false;
            }
            values.add(value);
            return true;
        },
        contains(value) {
            return values.has(value);
        }
    };
}

function createElement(overrides = {}) {
    return Object.assign({
        hidden: true,
        innerHTML: '',
        textContent: '',
        classList: createClassList(),
        appendChild: jest.fn(),
        setAttribute: jest.fn(),
        removeAttribute: jest.fn()
    }, overrides);
}

function validBootstrap() {
    return {
        revision: 7,
        tenant: { name: 'No Fries test workspace' },
        user: {
            name: 'Test Operator',
            email: 'operator@example.com',
            role: 'admin',
            capabilities: []
        },
        counts: {
            customers: 0,
            activeAssessments: 0,
            completedAssessments: 0,
            proposals: 0,
            publishedServices: 0
        },
        catalogue: {
            publishedVersionId: null,
            publishedLabel: '',
            serviceCount: 0
        },
        customers: [],
        assessments: [],
        proposals: [],
        integration: { configured: false }
    };
}

function createHarness() {
    const elements = Object.fromEntries([
        'appSidebar',
        'appMain',
        'loadingPanel',
        'viewRoot',
        'workspaceIdentity',
        'tenantName',
        'roleBadge',
        'userName',
        'saveIndicator',
        'toastRegion',
        'appDialog',
        'dialogEyebrow',
        'dialogTitle',
        'dialogBody'
    ].map((id) => [id, createElement()]));
    const bodyClasses = createClassList(['app-loading']);
    const overviewNavigation = createElement({
        dataset: { view: 'overview' },
        hidden: false
    });
    const document = {
        body: { classList: bodyClasses },
        addEventListener: jest.fn(),
        getElementById(id) {
            if (!elements[id]) {
                throw new Error(`Unexpected element lookup: ${id}`);
            }
            return elements[id];
        },
        querySelectorAll(selector) {
            if (selector !== '[data-view]') {
                throw new Error(`Unexpected selector: ${selector}`);
            }
            return [overviewNavigation];
        },
        createElement: jest.fn()
    };
    const window = {
        addEventListener: jest.fn(),
        confirm: jest.fn(),
        location: {
            assign: jest.fn(),
            search: ''
        },
        history: { replaceState: jest.fn() },
        setTimeout: jest.fn()
    };

    vm.runInNewContext(appSource, {
        URLSearchParams,
        document,
        fetch: jest.fn(),
        window
    });

    return {
        bodyClasses,
        document,
        elements,
        overviewNavigation,
        window
    };
}

describe('real protected scoping application startup', () => {
    test('opens and renders the workspace from a valid bootstrap payload', () => {
        const harness = createHarness();

        expect(harness.window.NoFriesSales).toBeDefined();
        expect(typeof harness.window.NoFriesSales.start).toBe('function');

        harness.window.NoFriesSales.start(validBootstrap());

        expect(harness.bodyClasses.contains('app-loading')).toBe(false);
        expect(harness.elements.loadingPanel.hidden).toBe(true);
        expect(harness.elements.appSidebar.hidden).toBe(false);
        expect(harness.elements.workspaceIdentity.hidden).toBe(false);
        expect(harness.elements.viewRoot.hidden).toBe(false);
        expect(harness.elements.tenantName.textContent).toBe('No Fries test workspace');
        expect(harness.elements.roleBadge.textContent).toBe('Administrator');
        expect(harness.elements.userName.textContent).toBe('Test Operator');
        expect(harness.overviewNavigation.classList.contains('is-active')).toBe(true);
        expect(harness.elements.viewRoot.innerHTML).toContain('<h1>Sales</h1>');
        expect(harness.elements.viewRoot.innerHTML).toContain('Private pre-sales workbench');
        expect(harness.document.addEventListener).toHaveBeenCalledTimes(4);
        expect(harness.window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    });

    test('carries an approved proposal into the exact Work continuation', () => {
        expect(appSource).toContain('Continue to acceptance');
        expect(appSource).toContain('operatorAcceptanceUrl(proposal, customer)');
        expect(appSource).toContain("organisationId: customer && customer.lifecycleOrganisationId || ''");
        expect(appSource).toContain('Proposal approved — linked assessment required');
        expect(appSource).toContain('assessment.lifecycleOrganisationId === customer.lifecycleOrganisationId');
        expect(appSource).toContain("salesCustomerId: proposal.customerId || ''");
        expect(appSource).toContain("assessmentId: proposal.assessmentId || ''");
        expect(appSource).toContain("proposalId: proposal.id || ''");
        expect(appSource).not.toContain("? 'onboarding' : 'proposal'");
    });
});
