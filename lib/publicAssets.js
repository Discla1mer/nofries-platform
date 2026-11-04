'use strict';

const PUBLIC_ROOT_FILES = Object.freeze([
    'index.html',
    'login.html',
    'report.html',
    'customer-report.css',
    'scope.html',
    'privacy.html',
    'terms.html',
    'roadmap.html',
    '404.html',
    'error.html',
    'favicon.svg',
    'favicon.ico',
    'apple-touch-icon.png',
    'style.css',
    'home.css',
    'managed-it.html',
    'managed-it.css',
    'shared-assistant.css',
    'robots.txt',
    '.well-known/security.txt'
]);

const PUBLIC_SCRIPT_FILES = Object.freeze([
    'home.js',
    'website-analytics.js',
    'customer-report.js',
    'organisation-setup.js',
    'managed-it.js',
    'operator-loader.js',
    'prospect-assistant.js',
    'shared-assistant.js',
    'scope-access.js'
]);

const PRIVATE_WORKSPACE_STYLES = Object.freeze({
    '/assets/mssp.css': 'app/mssp.css',
    '/assets/support.css': 'app/support.css',
    '/assets/operator.css': 'app/operator.css',
    '/assets/portal.css': 'app/portal.css'
});

module.exports = {
    PRIVATE_WORKSPACE_STYLES,
    PUBLIC_ROOT_FILES,
    PUBLIC_SCRIPT_FILES
};
