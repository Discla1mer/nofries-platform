const DETECTOR_VERSION = 'classic_v1';

const ZERO_WIDTH_AND_BIDI = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const BASE64_CANDIDATE = /\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g;

function detectProspectPromptInjection(value) {
    const original = String(value || '').slice(0, 8000);
    const variants = [normalise(original)];
    const decoded = decodeCandidates(original);
    decoded.forEach((item) => variants.push(normalise(item)));

    const signals = new Set();
    inspectControlTokens(original, signals);
    variants.forEach((text, index) => {
        inspectVariant(text, signals);
        if (index > 0 && signals.size) signals.add('encoded_payload');
    });

    const compact = variants[0].replace(/[^a-z0-9]+/g, '');
    if (
        compact.includes('ignorepreviousinstructions') ||
        compact.includes('ignoreallinstructions') ||
        compact.includes('revealsystemprompt') ||
        compact.includes('showdeveloperprompt')
    ) {
        signals.add('obfuscated_instruction');
    }

    return {
        detected: signals.size > 0,
        detectorVersion: DETECTOR_VERSION,
        signals: Array.from(signals).slice(0, 8)
    };
}

function inspectControlTokens(value, signals) {
    const text = String(value || '')
        .normalize('NFKC')
        .replace(ZERO_WIDTH_AND_BIDI, '')
        .toLowerCase();
    if (/(?:^|\n)\s*(?:\[\s*(?:system|developer)\s*\]|#{1,6}\s*(?:system|developer)|<\s*(?:system|developer)\s*>)/m.test(text) ||
        /<\|\s*(?:im_start\s*\|>\s*)?(?:system|developer)\s*\|?>/.test(text) ||
        /["']role["']\s*:\s*["'](?:system|developer)["']/.test(text)) {
        signals.add('role_marker_spoofing');
    }
}

function inspectVariant(text, signals) {
    if (!text) return;

    if (/\b(?:ignore|forget|disregard|override|discard)\s+(?:(?:all|any|the|your)\s+)*(?:(?:previous|prior|earlier|above|original|system|developer|hidden)\s+)*(?:instructions?|rules?|prompts?|messages?|polic(?:y|ies)|constraints?|safeguards?)\b/.test(text) ||
        /\b(?:do\s+not|don\s*t)\s+(?:obey|follow)\s+(?:(?:the|your)\s+)*(?:instructions?|rules?|prompt|polic(?:y|ies)|safeguards?)\b/.test(text)) {
        signals.add('instruction_override');
    }

    if (/\b(?:treat|use|accept|regard)\s+(?:(?:the|these)\s+)?(?:following|instructions?\s+below|text\s+below)\s+as\s+(?:(?:the|your)\s+)?(?:new|replacement|real)\s+(?:(?:system|developer)\s+)?(?:instructions?|prompt|rules?)\b/.test(text) ||
        /\b(?:instructions?|rules?|prompt|guidance)\s+(?:below|following)\s+(?:supersede|replace|override|take\s+precedence\s+over)\s+(?:all\s+)?(?:prior|previous|earlier|system|developer)\s+(?:instructions?|rules?|prompt|guidance)\b/.test(text)) {
        signals.add('instruction_replacement');
    }

    if (/\b(?:reveal|show|print|output|display|repeat|quote|provide|give|tell)\s+(?:me\s+)?(?:(?:the|your)\s+)?(?:(?:hidden|internal|initial|system|developer|original)\s+)*(?:prompt|instructions?|message|rules?)\b/.test(text) ||
        /\b(?:reveal|show|print|output|display|repeat|quote|provide|give|tell)\s+(?:me\s+)?(?:the\s+)?(?:contents?\s+of\s+)?(?:(?:the|your)\s+)?(?:hidden|internal|initial|system|developer)\s+(?:context|instructions?|prompt|message)\b/.test(text) ||
        /\bwhat\s+(?:is|are)\s+(?:the\s+|your\s+)?(?:hidden|internal|system|developer)\s+(?:prompt|instructions?|message|rules?)\b/.test(text) ||
        /\b(?:everything|text)\s+(?:above|before)\s+(?:this|here|the\s+chat)\b/.test(text)) {
        signals.add('instruction_exfiltration');
    }

    if (/\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as|pretend\s+to\s+be)\s+(?:(?:an?|the)\s+)?(?:dan|system|developer|administrator|admin|unrestricted|unfiltered|jailbroken)\b/.test(text) ||
        /\b(?:enable|enter|switch\s+to|activate)\s+(?:dan|developer|jailbreak|unrestricted|unfiltered)\s+mode\b/.test(text)) {
        signals.add('role_reassignment');
    }

    if (/(?:^|\n)\s*(?:system|developer)\s+(?:new\s+policy|instruction|message|role|you\s+must)\b/m.test(text)) {
        signals.add('role_marker_spoofing');
    }

    if (/\b(?:bypass|disable|remove|evade|turn\s+off)\s+(?:(?:the|your|all)\s+)*(?:safety|safeguards?|guardrails?|filters?|restrictions?|polic(?:y|ies))\b/.test(text) ||
        /\b(?:jailbreak|prompt\s+injection)\s+(?:yourself|this\s+assistant|the\s+assistant)\b/.test(text)) {
        signals.add('safeguard_bypass');
    }

    if (/\b(?:call|invoke|run|execute)\s+(?:(?:the|your)\s+)*(?:update\s+prospect\s+context|record\s+conversation\s+summary|suggest\s+next\s+action|advance\s+lifecycle)\b/.test(text) ||
        /\b(?:reveal|show|print|output|dump)\s+(?:(?:the|your|all)\s+)*(?:tool|function)\s+(?:schema|arguments?|output|definitions?)\b/.test(text)) {
        signals.add('protected_tool_request');
    }

    if (/\b(?:decode|decrypt|translate)\s+(?:(?:this|the\s+following)\s+)?(?:base\s*64|encoded|cipher)\s+(?:text|message|instructions?|payload)?\s*(?:and|then)\s+(?:follow|obey|execute|apply|do)\b/.test(text)) {
        signals.add('encoded_instruction_request');
    }

    if (/\bignora\s+(?:todas?\s+)?(?:las\s+)?instrucciones\s+(?:anteriores|previas)\b/.test(text) ||
        /\b(?:muestra|revela)\s+(?:el\s+)?prompt\s+(?:del\s+)?sistema\b/.test(text)) {
        signals.add('multilingual_instruction_override');
    }
}

function normalise(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(ZERO_WIDTH_AND_BIDI, '')
        .toLowerCase()
        .replace(/0/g, 'o')
        .replace(/1/g, 'i')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/7/g, 't')
        .replace(/@/g, 'a')
        .replace(/\$/g, 's')
        .replace(/[^\p{L}\p{N}\n]+/gu, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
}

function decodeCandidates(value) {
    const candidates = String(value || '').match(BASE64_CANDIDATE) || [];
    const decoded = [];
    for (const candidate of candidates.slice(0, 3)) {
        try {
            const standard = candidate.replace(/-/g, '+').replace(/_/g, '/');
            const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
            const buffer = Buffer.from(padded, 'base64');
            const text = buffer.toString('utf8');
            if (!text || buffer.length < 12 || Buffer.from(text, 'utf8').length !== buffer.length) continue;
            const printable = Array.from(text).filter((character) => /[\p{L}\p{N}\p{P}\p{Z}\r\n\t]/u.test(character)).length;
            if (printable / Array.from(text).length < 0.9) continue;
            decoded.push(text.slice(0, 4000));
        } catch (error) {
            // Invalid encodings are ordinary visitor text, not a security signal.
        }
    }
    return decoded;
}

module.exports = {
    DETECTOR_VERSION,
    detectProspectPromptInjection
};
