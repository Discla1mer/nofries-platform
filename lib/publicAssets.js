'use strict';

const PUBLIC_ROOT_FILES = Object.freeze([
    'index.html',
    'login.html',
    'report.html',
    'customer-report.css',
    'scope.html',
    'privacy.html',
    'contact.html',
    'account-help.html',
    'terms.html',
    'pilot-terms.html',
    'roadmap.html',
    'changelog.html',
    'changelog.css',
    'sample-result.html',
    'fictional-iso-example.html',
    'pricing.html',
    'insurance.html',
    'supplier-questionnaire.html',
    'board.html',
    'consultants.html',
    'offer.html',
    'fictional-nist-example.html',
    'invoice-scams.html',
    'sitemap.xml',
    '404.html',
    'error.html',
    'favicon.svg',
    'favicon.ico',
    'apple-touch-icon.png',
    'style.css',
    'home.css',
    'guides.css',
    'managed-it.html',
    'managed-it.css',
    'robots.txt',
    '.well-known/security.txt'
]);

const PUBLIC_SCRIPT_FILES = Object.freeze([
    'home.js',
    'customer-report.js',
    'organisation-setup.js',
    'managed-it.js',
    'operator-loader.js',
    'scope-access.js',
    'contact.js',
    'pricing.js',
    'pricing-estimate.js',
    'enquiry-availability.js',
    'enquiry-home.js',
    'roadmap.js'
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
