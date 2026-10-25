'use strict';

const POSTGRES_TOKEN_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const DEFAULT_POOL_MAX = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;

class PostgresDatabaseError extends Error {
    constructor(code = 'postgres_database_error') {
        super('No Fries could not complete the database operation.');
        this.name = 'PostgresDatabaseError';
        this.code = code;
        this.statusCode = 500;
    }
}

function createPostgresDatabase(options = {}) {
    const pool = options.pool || createPostgresPool(options);
    assertPool(pool);
    let closed = false;

    return Object.freeze({
        async withTenantTransaction(tenantId, work) {
            if (closed) {
                throw new PostgresDatabaseError('postgres_database_closed');
            }
            const safeTenantId = validateTenantId(tenantId);
            if (typeof work !== 'function') {
                throw new PostgresDatabaseError('postgres_transaction_callback_invalid');
            }

            let client;
            try {
                client = await pool.connect();
            } catch {
                throw new PostgresDatabaseError('postgres_connection_failed');
            }

            let transactionStarted = false;
            let discardClient = false;
            try {
                try {
                    await client.query('BEGIN');
                    transactionStarted = true;
                } catch {
                    discardClient = true;
                    throw new PostgresDatabaseError('postgres_begin_failed');
                }

                try {
                    await client.query(
                        "SELECT set_config('nofries.tenant_id', $1, true)",
                        [safeTenantId]
                    );
                } catch {
                    try {
                        await client.query('ROLLBACK');
                        transactionStarted = false;
                    } catch {
                        discardClient = true;
                        throw new PostgresDatabaseError('postgres_rollback_failed');
                    }
                    throw new PostgresDatabaseError('postgres_tenant_context_failed');
                }

                let result;
                try {
                    result = await work(createTenantClient(client));
                } catch (applicationError) {
                    try {
                        await client.query('ROLLBACK');
                        transactionStarted = false;
                    } catch {
                        discardClient = true;
                        throw new PostgresDatabaseError('postgres_rollback_failed');
                    }
                    throw applicationError;
                }

                try {
                    await client.query('COMMIT');
                    transactionStarted = false;
                } catch {
                    if (transactionStarted) {
                        try {
                            await client.query('ROLLBACK');
                            transactionStarted = false;
                        } catch {
                            discardClient = true;
                            throw new PostgresDatabaseError('postgres_rollback_failed');
                        }
                    }
                    throw new PostgresDatabaseError('postgres_commit_failed');
                }
                return result;
            } finally {
                try {
                    client.release(discardClient);
                } catch {
                    // A release failure cannot safely expose the driver error or connection state.
                }
            }
        },

        async close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                await pool.end();
            } catch {
                throw new PostgresDatabaseError('postgres_close_failed');
            }
        }
    });
}

function createTenantClient(client) {
    return Object.freeze({
        async query(text, params) {
            try {
                return await client.query(text, params);
            } catch {
                throw new PostgresDatabaseError('postgres_query_failed');
            }
        }
    });
}

function createPostgresPool(options = {}) {
    const settings = resolvePostgresSettings(options);
    let Pool = options.Pool;
    if (!Pool) {
        try {
            ({ Pool } = options.pg || require('pg'));
        } catch {
            throw new PostgresDatabaseError('postgres_dependency_unavailable');
        }
    }
    if (typeof Pool !== 'function') {
        throw new PostgresDatabaseError('postgres_dependency_invalid');
    }

    let pool;
    try {
        pool = new Pool(settings);
    } catch {
        throw new PostgresDatabaseError('postgres_pool_initialisation_failed');
    }
    if (pool && typeof pool.on === 'function') {
        pool.on('error', () => {
            if (typeof options.onPoolError !== 'function') {
                return;
            }
            try {
                options.onPoolError(new PostgresDatabaseError('postgres_idle_client_error'));
            } catch {
                // A diagnostic callback must not turn an idle-client failure into a process crash.
            }
        });
    }
    return pool;
}

function resolvePostgresSettings(options) {
    const env = options.env || process.env;
    const common = {
        application_name: validateApplicationName(options.applicationName || 'nofries'),
        max: boundedInteger(
            options.poolMax ?? env.NOFRIES_POSTGRES_POOL_MAX,
            DEFAULT_POOL_MAX,
            1,
            20
        ),
        statement_timeout: boundedInteger(
            options.statementTimeoutMs ?? env.NOFRIES_POSTGRES_STATEMENT_TIMEOUT_MS,
            DEFAULT_STATEMENT_TIMEOUT_MS,
            1000,
            60000
        ),
        query_timeout: boundedInteger(
            options.statementTimeoutMs ?? env.NOFRIES_POSTGRES_STATEMENT_TIMEOUT_MS,
            DEFAULT_STATEMENT_TIMEOUT_MS,
            1000,
            60000
        ),
        connectionTimeoutMillis: boundedInteger(
            options.connectionTimeoutMs ?? env.NOFRIES_POSTGRES_CONNECTION_TIMEOUT_MS,
            DEFAULT_CONNECTION_TIMEOUT_MS,
            1000,
            30000
        ),
        idleTimeoutMillis: boundedInteger(
            options.idleTimeoutMs ?? env.NOFRIES_POSTGRES_IDLE_TIMEOUT_MS,
            DEFAULT_IDLE_TIMEOUT_MS,
            1000,
            60000
        ),
        keepAlive: true
    };

    const databaseUrl = firstNonEmpty(
        options.databaseUrl,
        env.NOFRIES_DATABASE_URL,
        env.DATABASE_URL
    );
    if (databaseUrl) {
        if (isProduction(env) && options.allowProductionDatabaseUrl !== true) {
            throw new PostgresDatabaseError('postgres_connection_string_forbidden');
        }
        validateDatabaseUrl(databaseUrl);
        return Object.assign(common, { connectionString: databaseUrl });
    }

    const host = validateHost(options.host || env.NOFRIES_POSTGRES_HOST);
    const database = validateDatabaseIdentifier(
        options.database || env.NOFRIES_POSTGRES_DATABASE
    );
    const user = validateDatabaseIdentifier(options.user || env.NOFRIES_POSTGRES_USER);
    const port = boundedInteger(
        options.port ?? env.NOFRIES_POSTGRES_PORT,
        5432,
        1,
        65535
    );
    const credential = resolveCredential(options);

    return Object.assign(common, {
        host,
        database,
        user,
        port,
        ssl: { rejectUnauthorized: true },
        password: async () => {
            try {
                const token = await credential.getToken(POSTGRES_TOKEN_SCOPE);
                if (!token || typeof token.token !== 'string' || token.token.length === 0) {
                    throw new Error('token unavailable');
                }
                return token.token;
            } catch {
                throw new PostgresDatabaseError('postgres_managed_identity_token_failed');
            }
        }
    });
}

function resolveCredential(options) {
    if (options.credential && typeof options.credential.getToken === 'function') {
        return options.credential;
    }
    try {
        const { DefaultAzureCredential } = require('@azure/identity');
        return new DefaultAzureCredential();
    } catch {
        throw new PostgresDatabaseError('postgres_credential_unavailable');
    }
}

function assertPool(pool) {
    if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
        throw new PostgresDatabaseError('postgres_pool_invalid');
    }
}

function validateTenantId(value) {
    const tenantId = typeof value === 'string' ? value.trim() : '';
    if (!tenantId || tenantId.length > 256 || /[\u0000-\u001f\u007f]/.test(tenantId)) {
        throw new PostgresDatabaseError('postgres_tenant_invalid');
    }
    return tenantId;
}

function validateDatabaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
    if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        !parsed.username ||
        !parsed.pathname ||
        parsed.pathname === '/'
    ) {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
}

function validateHost(value) {
    const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
    return host;
}

function validateDatabaseIdentifier(value) {
    const identifier = typeof value === 'string' ? value.trim() : '';
    if (!identifier || identifier.length > 128 || !/^[A-Za-z0-9_.@-]+$/.test(identifier)) {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
    return identifier;
}

function validateApplicationName(value) {
    const applicationName = typeof value === 'string' ? value.trim() : '';
    if (!applicationName || applicationName.length > 48 || !/^[A-Za-z0-9_.-]+$/.test(applicationName)) {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
    return applicationName;
}

function boundedInteger(value, defaultValue, minimum, maximum) {
    const candidate = value == null || value === '' ? defaultValue : Number(value);
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
        throw new PostgresDatabaseError('postgres_configuration_invalid');
    }
    return candidate;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function isProduction(env) {
    return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

module.exports = {
    PostgresDatabaseError,
    createPostgresDatabase,
    createPostgresPool
};
