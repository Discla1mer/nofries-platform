async function readBoundedResponseText(response, maximumBytes, createTooLargeError) {
    const maximum = Number(maximumBytes);
    if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('A positive response byte limit is required');
    const tooLarge = typeof createTooLargeError === 'function'
        ? createTooLargeError
        : () => new Error('The response body is too large');
    const declaredLength = response && response.headers && typeof response.headers.get === 'function'
        ? Number(response.headers.get('content-length'))
        : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > maximum) throw tooLarge();

    const body = response && response.body;
    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (!part || part.done) break;
                const chunk = toBuffer(part.value);
                total += chunk.length;
                if (total > maximum) {
                    if (typeof reader.cancel === 'function') await reader.cancel().catch(() => {});
                    throw tooLarge();
                }
                chunks.push(chunk);
            }
        } finally {
            if (typeof reader.releaseLock === 'function') reader.releaseLock();
        }
        return Buffer.concat(chunks, total).toString('utf8');
    }

    if (body && typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        let total = 0;
        for await (const value of body) {
            const chunk = toBuffer(value);
            total += chunk.length;
            if (total > maximum) {
                if (typeof body.destroy === 'function') body.destroy();
                throw tooLarge();
            }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, total).toString('utf8');
    }

    if (!response || typeof response.text !== 'function') throw new TypeError('The response body is unreadable');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximum) throw tooLarge();
    return text;
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    return Buffer.from(String(value == null ? '' : value), 'utf8');
}

module.exports = { readBoundedResponseText };
