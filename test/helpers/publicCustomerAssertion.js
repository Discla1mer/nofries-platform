'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const id = n => '83000000-0000-4000-8000-' + String(n).padStart(12, '0');
const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(__dirname,
    '../fixtures/customerAssertion/openssl-rsa3072-leaf.pem')));
const jwk = certificate.publicKey.export({ format: 'jwk' });
const keyId = 'https://synthetic-vault.vault.azure.net/keys/customer-assertion/' + 'a'.repeat(32);
const tokenEndpoint = `https://synthetic-customer.ciamlogin.com/${id(1)}/oauth2/v2.0/token`;
function configuration() {
    return { clientId: id(2), tokenEndpoint, vaultOrigin: 'https://synthetic-vault.vault.azure.net',
        keyName: 'customer-assertion', keyId, certificateDer: Buffer.from(certificate.raw),
        certificateSha256: crypto.createHash('sha256').update(certificate.raw).digest('hex') };
}
function keyBody() {
    return { key: { kid: keyId, kty: 'RSA', key_ops: ['sign', 'verify'], n: jwk.n, e: jwk.e },
        attributes: { enabled: true, nbf: 1604100000, exp: 4102444800 } };
}
module.exports = { id, certificate, jwk, keyId, tokenEndpoint, configuration, keyBody };
