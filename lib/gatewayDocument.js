'use strict';
const { buildDashboardDocument } = require('./dashboardDocument');
const SCRIPTS = ['/js/organisation-setup.js', '/js/home.js', '/js/prospect-assistant.js'];
function buildGatewayDocument(options) {
    if (typeof options?.template !== 'string') throw new Error('gateway_template_invalid');
    const scripts = [...options.template.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)];
    if (scripts.length !== SCRIPTS.length || scripts.some((match, i) => match[0] !== '<script src="' + SCRIPTS[i] + '" defer></script>')) throw new Error('gateway_scripts_invalid');
    const template = options.template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const result = buildDashboardDocument({ ...options, template });
    return { ...result, html: result.html.replace('</head>', scripts.map(x => x[0]).join('\n') + '\n</head>') };
}
module.exports = { buildGatewayDocument };
