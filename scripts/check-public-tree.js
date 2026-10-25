'use strict';
const { execFileSync } = require('node:child_process');
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = tracked.filter(p => p.split('/').some(name =>
    name === 'node_modules' || name === '.env' || (name.startsWith('.env.') && name !== '.env.example')));
if (forbidden.length) throw new Error('Tracked dependencies or local environment files are forbidden; remove them from the proposed source tree.');
process.stdout.write('Tracked dependency and local environment-file guard passed.\n');
