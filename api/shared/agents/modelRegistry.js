const MODEL_DEFAULTS = Object.freeze({
    prospect: Object.freeze({
        model: 'gpt-5.6-luna',
        reasoningEffort: 'none',
        inputUsdPerMillion: 0.20,
        outputUsdPerMillion: 1.20
    }),
    summary: Object.freeze({
        model: 'gpt-5.6-luna',
        reasoningEffort: 'none',
        inputUsdPerMillion: 0.20,
        outputUsdPerMillion: 1.20
    }),
    scoping: Object.freeze({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'low',
        inputUsdPerMillion: 2.00,
        outputUsdPerMillion: 12.00
    }),
    investigation: Object.freeze({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'low',
        inputUsdPerMillion: 2.00,
        outputUsdPerMillion: 12.00
    })
});

function resolveModel(purpose, env = process.env) {
    const key = Object.prototype.hasOwnProperty.call(MODEL_DEFAULTS, purpose) ? purpose : 'prospect';
    const defaults = MODEL_DEFAULTS[key];
    const prefix = `NOFRIES_MODEL_${key.toUpperCase()}`;
    return {
        purpose: key,
        model: clean(env[prefix]) || defaults.model,
        reasoningEffort: normaliseEffort(env[`${prefix}_REASONING`], defaults.reasoningEffort),
        inputUsdPerMillion: positiveNumber(env[`${prefix}_INPUT_USD_PER_MILLION`], defaults.inputUsdPerMillion),
        outputUsdPerMillion: positiveNumber(env[`${prefix}_OUTPUT_USD_PER_MILLION`], defaults.outputUsdPerMillion),
        cachedInputRateMultiplier: 0.1,
        cacheWriteRateMultiplier: 1.25,
        pricingAsOf: '2026-08-15'
    };
}

function estimateCost(model, usage = {}) {
    const normalised = normaliseUsage(usage);
    const cachedInputTokens = Math.min(normalised.cachedInputTokens, normalised.inputTokens);
    const cacheWriteTokens = Math.min(
        normalised.cacheWriteTokens,
        Math.max(0, normalised.inputTokens - cachedInputTokens)
    );
    const ordinaryInputTokens = Math.max(0, normalised.inputTokens - cachedInputTokens - cacheWriteTokens);
    const cachedInputMultiplier = positiveNumber(model.cachedInputRateMultiplier, 0.1);
    const cacheWriteMultiplier = positiveNumber(model.cacheWriteRateMultiplier, 1.25);
    return Math.round((
        (ordinaryInputTokens / 1000000 * model.inputUsdPerMillion) +
        (cachedInputTokens / 1000000 * model.inputUsdPerMillion * cachedInputMultiplier) +
        (cacheWriteTokens / 1000000 * model.inputUsdPerMillion * cacheWriteMultiplier) +
        (normalised.outputTokens / 1000000 * model.outputUsdPerMillion)
    ) * 1000000) / 1000000;
}

function normaliseUsage(value = {}) {
    const inputTokens = nonNegative(firstDefined(value.input_tokens, value.inputTokens));
    const outputTokens = nonNegative(firstDefined(value.output_tokens, value.outputTokens));
    const inputDetails = value.input_tokens_details || value.inputTokensDetails || {};
    const outputDetails = value.output_tokens_details || value.outputTokensDetails || {};
    return {
        inputTokens,
        outputTokens,
        totalTokens: nonNegative(firstDefined(value.total_tokens, value.totalTokens, inputTokens + outputTokens)),
        cachedInputTokens: nonNegative(firstDefined(
            inputDetails.cached_tokens,
            inputDetails.cachedTokens,
            value.cached_input_tokens,
            value.cachedInputTokens
        )),
        cacheWriteTokens: nonNegative(firstDefined(
            inputDetails.cache_write_tokens,
            inputDetails.cacheWriteTokens,
            value.cache_write_tokens,
            value.cacheWriteTokens
        )),
        reasoningTokens: nonNegative(firstDefined(
            outputDetails.reasoning_tokens,
            outputDetails.reasoningTokens,
            value.reasoning_tokens,
            value.reasoningTokens
        ))
    };
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

function normaliseEffort(value, fallback) {
    const effort = clean(value).toLowerCase();
    return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : fallback;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function nonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function clean(value) {
    return String(value || '').trim();
}

module.exports = {
    MODEL_DEFAULTS,
    estimateCost,
    normaliseUsage,
    resolveModel
};
