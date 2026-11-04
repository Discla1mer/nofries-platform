'use strict';

// Local-only: serves the fictional demo on loopback (#29). No production host runs this.
const { createNoFriesApp } = require('../../server');
const port = Number(process.env.PORT) || 3000;
createNoFriesApp({ tryDemo: true }).listen(port, '127.0.0.1', () => {
    console.log('Fictional No Fries demo (local only): http://127.0.0.1:' + port + '/try');
});
