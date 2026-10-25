'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    PostgresDatabaseError,
    createPostgresPool
} = require('../api/shared/database/postgres');

const DEFAULT_MIGRATIONS_DIRECTORY = path.resolve(__dirname, '..', 'database', 'migrations');
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MAX_MIGRATION_BYTES = 2 * 1024 * 1024;
const MIGRATION_LOCK_CLASS = 1313822278;
const MIGRATION_LOCK_INSTANCE = 1;

class DatabaseMigrationError extends Error {
    constructor(code = 'database_migration_failed', migrationId = null) {
        super('No Fries could not complete the database migration.');
        this.name = 'DatabaseMigrationError';
        this.code = code;
        this.migrationId = migrationId;
    }
}

async function applyMigrations(options = {}) {
    const migrations = loadMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIRECTORY);
    let pool = options.pool || null;
    let client = options.client || null;
    let ownsPool = false;
    let releaseClient = false;
    let discardClient = false;
    let transactionStarted = false;

    try {
        if (!client) {
            if (!pool) {
                pool = createPostgresPool(options.databaseOptions || options);
                ownsPool = true;
            }
            assertPool(pool);
            try {
                client = await pool.connect();
                releaseClient = true;
            } catch {
                throw new DatabaseMigrationError('database_migration_connection_failed');
            }
        }
        assertClient(client);

        try {
            await client.query('BEGIN');
            transactionStarted = true;
            await client.query(
                'SELECT pg_advisory_xact_lock($1, $2)',
                [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_INSTANCE]
            );
            await bootstrapMigrationLedger(client);
        } catch {
            if (!transactionStarted) {
                discardClient = true;
            }
            throw new DatabaseMigrationError('database_migration_bootstrap_failed');
        }

        const applied = [];
        const skipped = [];
        for (const migration of migrations) {
            let existing;
            try {
                existing = await client.query(
                    'SELECT checksum_sha256 FROM nofries.schema_migrations WHERE migration_id = $1',
                    [migration.id]
                );
            } catch {
                throw new DatabaseMigrationError('database_migration_ledger_read_failed', migration.id);
            }

            if (existing.rows.length > 0) {
                if (existing.rows[0].checksum_sha256 !== migration.checksum) {
                    throw new DatabaseMigrationError(
                        'database_migration_checksum_drift',
                        migration.id
                    );
                }
                skipped.push(migration.id);
                continue;
            }

            try {
                await client.query(migration.sql);
                await client.query(
                    `INSERT INTO nofries.schema_migrations
                        (migration_id, checksum_sha256)
                     VALUES ($1, $2)`,
                    [migration.id, migration.checksum]
                );
            } catch {
                throw new DatabaseMigrationError('database_migration_apply_failed', migration.id);
            }
            applied.push(migration.id);
        }

        try {
            await client.query('COMMIT');
            transactionStarted = false;
        } catch {
            throw new DatabaseMigrationError('database_migration_commit_failed');
        }

        return Object.freeze({
            applied: Object.freeze(applied.slice()),
            skipped: Object.freeze(skipped.slice()),
            total: migrations.length
        });
    } catch (error) {
        if (transactionStarted && client) {
            try {
                await client.query('ROLLBACK');
                transactionStarted = false;
            } catch {
                discardClient = true;
                throw new DatabaseMigrationError('database_migration_rollback_failed');
            }
        }
        if (error instanceof DatabaseMigrationError) {
            throw error;
        }
        if (error instanceof PostgresDatabaseError) {
            throw new DatabaseMigrationError('database_migration_connection_failed');
        }
        throw new DatabaseMigrationError('database_migration_failed');
    } finally {
        if (releaseClient && client) {
            try {
                client.release(discardClient);
            } catch {
                // Do not expose driver or connection state during cleanup.
            }
        }
        if (ownsPool && pool) {
            try {
                await pool.end();
            } catch {
                // The migration result is authoritative; cleanup errors remain sanitised.
            }
        }
    }
}

async function bootstrapMigrationLedger(client) {
    await client.query('CREATE SCHEMA IF NOT EXISTS nofries');
    await client.query(`
        CREATE TABLE IF NOT EXISTS nofries.schema_migrations (
            migration_id varchar(255) PRIMARY KEY,
            checksum_sha256 char(64) NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT schema_migrations_checksum_sha256_format
                CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
        )
    `);
    await client.query('REVOKE ALL ON nofries.schema_migrations FROM PUBLIC');
}

function loadMigrations(directory) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        throw new DatabaseMigrationError('database_migration_directory_invalid');
    }

    const files = entries
        .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    if (files.length === 0) {
        throw new DatabaseMigrationError('database_migration_files_missing');
    }

    return files.map((fileName) => {
        let contents;
        try {
            contents = fs.readFileSync(path.join(directory, fileName));
        } catch {
            throw new DatabaseMigrationError('database_migration_file_invalid', fileName);
        }
        if (
            contents.length === 0 ||
            contents.length > MAX_MIGRATION_BYTES ||
            contents.includes(0)
        ) {
            throw new DatabaseMigrationError('database_migration_file_invalid', fileName);
        }
        return Object.freeze({
            id: fileName,
            checksum: crypto.createHash('sha256').update(contents).digest('hex'),
            sql: contents.toString('utf8')
        });
    });
}

function assertPool(pool) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new DatabaseMigrationError('database_migration_pool_invalid');
    }
}

function assertClient(client) {
    if (!client || typeof client.query !== 'function') {
        throw new DatabaseMigrationError('database_migration_client_invalid');
    }
}

async function runCli() {
    try {
        const result = await applyMigrations();
        process.stdout.write(
            `Database migrations current: ${result.applied.length} applied, ` +
            `${result.skipped.length} already recorded.\n`
        );
    } catch (error) {
        if (
            error instanceof DatabaseMigrationError &&
            error.code === 'database_migration_checksum_drift' &&
            error.migrationId
        ) {
            process.stderr.write(`Database migration checksum drift: ${error.migrationId}.\n`);
        } else {
            process.stderr.write('Database migration failed.\n');
        }
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runCli();
}

module.exports = {
    DatabaseMigrationError,
    applyMigrations
};
