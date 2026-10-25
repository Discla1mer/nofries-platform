const fs = require('fs');
const path = require('path');

module.exports = function loadSharedRuntime(name) {
    const packagedPath = path.join(__dirname, 'shared', `${name}.js`);
    const sourcePath = path.join(__dirname, '..', 'api', 'shared', `${name}.js`);
    return require(fs.existsSync(packagedPath) ? packagedPath : sourcePath);
};
