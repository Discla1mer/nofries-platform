const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '../..');
const compiledTemplates = new Map();

const formatCompilerFailure = (compiler, result) => {
    if (result.error && result.error.code === 'ENOENT') {
        return `${compiler}: executable not found`;
    }

    const status = result.status === null ? 'no exit status' : `exit ${result.status}`;
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const detail = stderr || stdout || (result.error && result.error.message) || 'no compiler output';
    return `${compiler}: ${status}: ${detail}`;
};

const compilerAttempts = (absolutePath) => [
    {
        command: 'az',
        label: 'az bicep build',
        args: ['bicep', 'build', '--file', absolutePath, '--stdout', '--no-restore']
    },
    {
        command: 'bicep',
        label: 'bicep build',
        args: ['build', absolutePath, '--stdout', '--no-restore']
    }
];

const compileBicep = (relativePath) => {
    if (compiledTemplates.has(relativePath)) {
        return compiledTemplates.get(relativePath);
    }

    const absolutePath = path.join(repositoryRoot, relativePath);
    const failures = [];

    for (const compiler of compilerAttempts(absolutePath)) {
        const result = spawnSync(compiler.command, compiler.args, {
            cwd: repositoryRoot,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        });

        if (result.status !== 0) {
            failures.push(formatCompilerFailure(compiler.label, result));
            continue;
        }

        try {
            const compiled = JSON.parse(result.stdout);
            compiledTemplates.set(relativePath, compiled);
            return compiled;
        } catch (error) {
            failures.push(`${compiler.label}: compiler output was not valid ARM JSON: ${error.message}`);
        }
    }

    throw new Error(
        `Unable to compile ${relativePath}. A working Azure CLI Bicep compiler or standalone Bicep CLI is required; this test never skips compilation.\n${failures.join('\n')}`
    );
};

const resourceEntries = (template) => {
    if (!template || !template.resources) {
        return [];
    }
    if (Array.isArray(template.resources)) {
        return template.resources.map((resource) => ({ resource }));
    }
    return Object.entries(template.resources).map(([symbolicName, resource]) => ({
        resource,
        symbolicName
    }));
};

const collectTemplates = (rootTemplate) => {
    const templates = [];
    const visit = (template, deploymentPath) => {
        templates.push({ template, deploymentPath });
        for (const { resource, symbolicName } of resourceEntries(template)) {
            const nestedTemplate = resource && resource.properties && resource.properties.template;
            if (nestedTemplate) {
                const name = symbolicName || String(resource.name || resource.type || 'deployment');
                visit(nestedTemplate, [...deploymentPath, name]);
            }
        }
    };
    visit(rootTemplate, []);
    return templates;
};

const collectResources = (rootTemplate) => {
    const resources = [];
    const visitResource = (resource, symbolicName, deploymentPath, parentPath) => {
        resources.push({ resource, symbolicName, deploymentPath, parentPath });
        const children = Array.isArray(resource.resources)
            ? resource.resources.map((child) => ({ resource: child }))
            : Object.entries(resource.resources || {}).map(([childName, child]) => ({
                resource: child,
                symbolicName: childName
            }));
        for (const child of children) {
            visitResource(
                child.resource,
                child.symbolicName,
                deploymentPath,
                [...parentPath, symbolicName || String(resource.name || resource.type)]
            );
        }
    };

    for (const { template, deploymentPath } of collectTemplates(rootTemplate)) {
        for (const { resource, symbolicName } of resourceEntries(template)) {
            visitResource(resource, symbolicName, deploymentPath, []);
        }
    }
    return resources;
};

const resourcesOfType = (rootTemplate, resourceType) => {
    const expected = resourceType.toLowerCase();
    return collectResources(rootTemplate).filter(({ resource }) =>
        String(resource.type || '').toLowerCase() === expected
    );
};

const findTemplateWithVariable = (rootTemplate, variableName) => {
    const match = collectTemplates(rootTemplate).find(({ template }) =>
        Object.prototype.hasOwnProperty.call(template.variables || {}, variableName)
    );
    if (!match) {
        throw new Error(`Compiled ARM does not contain variable ${variableName}`);
    }
    return match.template;
};

const compactExpression = (value) => String(value).replace(/\s+/g, '').toLowerCase();

const resolveJsonNumber = (value) => {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value !== 'string') {
        return Number.NaN;
    }
    const match = value.match(/^\[json\('(-?\d+(?:\.\d+)?)'\)\]$/i);
    return match ? JSON.parse(match[1]) : Number.NaN;
};

module.exports = {
    collectResources,
    collectTemplates,
    compactExpression,
    compileBicep,
    findTemplateWithVariable,
    repositoryRoot,
    resolveJsonNumber,
    resourcesOfType
};

