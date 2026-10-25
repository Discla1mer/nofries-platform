const express = require('express');
const {
    checkRateLimit,
    getClientKeyFromHeaders,
    rateLimitHeaders
} = require('./api/shared/abuseProtection');
const {
    handleMcpAuthMetadataRequest,
    handleMcpRequest
} = require('./api/shared/mcpRuntime');
const { API_SECURITY_HEADERS } = require('./api/shared/securityHeaders');

const app = express();
app.disable('x-powered-by');
const protectedResourceRoutes = [
    '/api/mcp-auth',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp'
];

app.set('trust proxy', 1);
app.use(applySecurityHeaders);
app.use(rateLimitRequests);
app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => {
    res.status(200).json({ service: 'nofries-agent-connector', status: 'ready' });
});

app.all('/api/mcp', asyncRoute(async (req, res) => {
    sendResult(res, await handleMcpRequest(req));
}));

app.get(protectedResourceRoutes, (req, res) => {
    sendResult(res, handleMcpAuthMetadataRequest(req));
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
    if (error && (error.type === 'entity.too.large' || error.status === 413)) {
        res.status(413).json({ error: 'Request body is too large', code: 'request_too_large' });
        return;
    }
    if (error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError)) {
        res.status(400).json({ error: 'Request body must contain valid JSON', code: 'invalid_json' });
        return;
    }
    console.error(error);
    res.status(500).json({ error: 'No Fries could not complete that request' });
});

if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`No Fries agent connector listening on port ${port}`));
}

function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function applySecurityHeaders(req, res, next) {
    Object.entries(API_SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
}

function rateLimitRequests(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
    const clientKey = getClientKeyFromHeaders(req.headers, req.ip || req.socket.remoteAddress);
    const result = checkRateLimit(bucket, clientKey);
    Object.entries(rateLimitHeaders(result)).forEach(([name, value]) => {
        if (value) res.setHeader(name, value);
    });
    if (!result.allowed) {
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
    }
    next();
}

function sendResult(res, result) {
    Object.entries(result.headers || {}).forEach(([name, value]) => res.setHeader(name, value));
    if (result.isRaw) {
        res.status(result.status).send(result.body);
        return;
    }
    res.status(result.status).json(result.body);
}

module.exports = app;
