function requestBodySize(req) {
    const contentLength = Number(getHeader(req, 'content-length'));
    const declaredSize = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0;
    const body = req && req.body;
    let actualSize = 0;

    if (Buffer.isBuffer(body)) {
        actualSize = body.length;
    } else if (typeof body === 'string') {
        actualSize = Buffer.byteLength(body, 'utf8');
    } else if (body != null) {
        try {
            actualSize = Buffer.byteLength(JSON.stringify(body), 'utf8');
        } catch (error) {
            return Number.POSITIVE_INFINITY;
        }
    }

    return Math.max(declaredSize, actualSize);
}

function parameterBytes(value) {
    try {
        return Buffer.byteLength(new URLSearchParams(value || {}).toString(), 'utf8');
    } catch (error) {
        return Number.POSITIVE_INFINITY;
    }
}

function getHeader(req, name) {
    if (!req) return '';
    if (typeof req.get === 'function') return String(req.get(name) || '');
    const headers = req.headers || {};
    return String(headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '');
}

module.exports = {
    parameterBytes,
    requestBodySize
};
