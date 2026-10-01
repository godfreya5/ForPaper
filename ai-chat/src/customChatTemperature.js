/**
 * Moonshot / Kimi OpenAPI（含 Anthropic 兼容）对部分模型强制 temperature === 1，传 0.7 会 400。
 */

/**
 * @param {string|undefined} modelName
 * @param {number|undefined} explicit options.temperature
 * @param {number} [defaultForGeneric=0.7]
 */
export function resolveTemperatureForCustomModel(modelName, explicit, defaultForGeneric = 0.7) {
    const m = String(modelName || '').toLowerCase();
    if (/kimi|moonshot/.test(m)) return 1;
    return typeof explicit === 'number' ? explicit : defaultForGeneric;
}
