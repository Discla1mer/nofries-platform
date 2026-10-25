'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('the evaluator FTP parser preserves normal listings and bounds hostile owner/group input', () => {
    // Resolve through the real consumer, not a separate top-level test copy.
    // A child deadline contains the vulnerable parser if this dependency regresses.
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
        const path = require('node:path');
        const consumer = require.resolve('get-uri', { paths: [process.argv[1]] });
        const entry = require.resolve('basic-ftp', { paths: [path.dirname(consumer)] });
        const parser = require(path.join(path.dirname(entry), 'parseListUnix.js'));
        const regular = parser.parseLine('-rw-r--r-- 1 alice staff 42 Sep 30 12:30 fixture.txt');
        const hostile = '-rw-r--r-- 1 ' + 'owner '.repeat(50000) + 'not-a-size Sep 30 12:30 fixture.txt';
        const rejected = parser.parseLine(hostile) === undefined;
        process.stdout.write(JSON.stringify({ rejected, name: regular.name, size: regular.size,
            user: regular.user, group: regular.group }));
    `, path.resolve(__dirname, '../node_modules')], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 16384
    }));
    expect(result).toEqual({ rejected: true, name: 'fixture.txt', size: 42, user: 'alice', group: 'staff' });
});
