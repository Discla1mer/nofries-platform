'use strict';
// Isolated synthetic worker: report via IPC, then explicitly release SDK handles.
const { BlockBlobClient, AnonymousCredential } = require('@azure/storage-blob');
const { createEnquiryRateLimiter } = require('../../api/shared/enquiryRateLimit');
const { createEnquiryService } = require('../../api/shared/enquiry');
process.send({ ready: true });
process.on('message', async message => {
    if (message.stall) return;
    const client = new BlockBlobClient(message.url, new AnonymousCredential(), { allowInsecureConnection: true, retryOptions: { maxTries: 1 } });
    let sent = 0, limited = 0, unavailable = 0;
    const service = createEnquiryService({
        env: { RESEND_API_KEY: 'synthetic', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' },
        rateLimiter: createEnquiryRateLimiter({ client }),
        fetchImpl: async () => { sent += 1; return { ok: true }; }
    });
    (async () => {
        for (let i = 0; i < message.count; i += 1) {
            try { await service.submitEnquiry({ name: 'Test', email: 'test@example.invalid', message: 'Synthetic test enquiry' }); }
            catch (e) { if (e.status === 429) limited += 1; else if (e.status === 503) unavailable += 1; else throw e; }
        }
        process.send({ sent, limited, unavailable }, () => { process.disconnect(); process.exit(0); });
    })().catch(() => process.exit(1));
});
