/**
 * Shared AST/golden normaliser for the Handlebars parity gates (plan Gate A / Gate A').
 *
 * This is the SINGLE source of truth for the denylist projection applied both when the goldens
 * are captured (`scripts/capture-golden.mjs`, run against `@handlebars/parser`) and when the
 * hand-rolled parser's output is compared against them (`tests/golden-parity.test.mjs`). Keeping
 * one copy prevents the capture path and the verification path from drifting.
 *
 * The projection:
 *   - drops the whitespace-control artefact keys nothing downstream reads
 *     (`strip`/`openStrip`/`closeStrip`/`inverseStrip`/`leftStripped`/`rightStripped`);
 *   - drops `ContentStatement.value` (upstream's WhitespaceControl pass mutates it on standalone
 *     lines — the golden keeps `original` instead);
 *   - sorts object keys with a stable byte-wise comparator;
 *   - represents an `undefined` value as the explicit marker `{ __undefined__: true }` so
 *     key-presence (e.g. `hash` present with value `undefined`, `program`/`inverse` presence)
 *     survives the JSON round-trip.
 */

/**
 * Stable byte-wise string comparator for deterministic key/file ordering.
 *
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} Negative, zero, or positive per standard sort order.
 */
export function compareStrings(a, b) {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}

// ── AST denylist normalisation ────────────────────────────────────────────
// Dropped: whitespace-control artefacts nothing downstream reads, plus
// ContentStatement.value (upstream's WhitespaceControl pass mutates it on
// standalone lines). Everything else is kept so the golden captures the full
// contract the new parser must reproduce.
export const DENYLIST_KEYS = new Set([
    'strip',
    'openStrip',
    'closeStrip',
    'inverseStrip',
    'leftStripped',
    'rightStripped',
]);

/**
 * Recursively project a parser value into a denylist-normalised, sorted plain object suitable for
 * stable JSON serialisation. Preserves `undefined`-valued keys as an explicit
 * `{ __undefined__: true }` marker so key-presence (e.g. `hash` present with value `undefined`,
 * `program`/`inverse` presence) survives JSON round-tripping.
 *
 * @param {unknown} value - The AST value to normalise.
 * @param {string} [key] - The key under which `value` sits in its parent.
 * @param {string} [parentType] - The `type` of the parent node, if any.
 * @returns {unknown} The normalised value.
 */
export function normalise(value, key, parentType) {
    if (Array.isArray(value)) {
        return value.map((item) => normalise(item, key, parentType));
    }
    if (value === undefined) {
        return { __undefined__: true };
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }

    const nodeType = typeof value.type === 'string' ? value.type : parentType;
    const out = {};
    for (const childKey of Object.keys(value).toSorted(compareStrings)) {
        if (DENYLIST_KEYS.has(childKey)) {
            continue;
        }
        // Drop ContentStatement.value (mutated by WhitespaceControl); keep original.
        if (childKey === 'value' && nodeType === 'ContentStatement') {
            continue;
        }
        out[childKey] = normalise(value[childKey], childKey, nodeType);
    }
    return out;
}

/**
 * Serialise a value as JSON with recursively sorted object keys, 4-space indent, and a trailing
 * newline. Matches the goldens' on-disk format so a prettier `tabWidth: 4` pass is a no-op.
 *
 * @param {unknown} value - The value to serialise (already denylist-normalised).
 * @returns {string} Deterministic JSON text.
 */
export function stableJson(value) {
    return JSON.stringify(value, null, 4) + '\n';
}
