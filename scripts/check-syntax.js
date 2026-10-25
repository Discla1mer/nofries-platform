const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_DIRECTORIES = ['api', 'connector-functions', 'scripts', 'evals', 'app', 'js', 'lib', '.github/actions'];
const ROOT_FILES = ['server.js', 'app-service.js', 'lib/identity.js'];

function collectFiles(root) {
    const files = new Set(ROOT_FILES.map((file) => path.join(root, file)));
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && entry.name !== 'node_modules') visit(file);
            if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.add(file);
        }
    }
    for (const directory of SOURCE_DIRECTORIES) visit(path.join(root, directory));
    return [...files].sort();
}

function checkSyntax(root) {
    let files;
    try {
        files = collectFiles(root);
    } catch (error) {
        console.error(`Unable to enumerate JavaScript sources: ${error.message}`);
        return 1;
    }
    for (const file of files) {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (result.error || result.status !== 0) {
            console.error(`Syntax check failed: ${path.relative(root, file)}`);
            console.error(result.error ? result.error.message : result.stderr || result.stdout || `Node exited with ${result.signal || result.status}`);
            return 1;
        }
    }
    console.log(`Syntax checks passed (${files.length} JavaScript files).`);
    return 0;
}

if (require.main === module) process.exitCode = checkSyntax(path.resolve(__dirname, '..'));

module.exports = { checkSyntax, collectFiles, SOURCE_DIRECTORIES, ROOT_FILES };
