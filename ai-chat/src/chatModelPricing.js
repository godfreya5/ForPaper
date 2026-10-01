/**
 * 预设模型单次对话扣费（与菜单标价一致）
 * 标准档基准 4；高级档（Grok / Gemini / Kimi）基准 6；ChatGPT 基准 8
 * 按 PDF 页数阶梯：第 1 档 1–50 页仅基准价；之后每多 50 页，各档基准外再 +2（ceil(n/50)-1 档）
 */

const PAGES_PER_CHAT_TIER = 50;
const STANDARD_BASE = 4;
const ADVANCED_BASE = 6;
const CHATGPT_BASE = 8;
const CREDITS_INCREMENT_PER_TIER = 2;

export function normalizePresetModelKey(menuKey) {
    if (menuKey === 'qwen3.5-plus') return 'qwen';
    if (menuKey === 'minimax-2.5') return 'minimax';
    if (menuKey === 'GLM-4.7') return 'zhipu';
    return menuKey;
}

/**
 * 超出首档 50 页的档位数（0 表示 1–50 页）
 * @param {number|null|undefined} pageCount
 * @returns {number}
 */
export function getChatPageTierSteps(pageCount) {
    if (pageCount == null || pageCount === undefined) return 0;
    const n = Math.max(0, Math.floor(Number(pageCount)));
    if (n <= 0) return 0;
    return Math.max(0, Math.ceil(n / PAGES_PER_CHAT_TIER) - 1);
}

/** 仅页数带来的加价（不含模型基准） */
export function getPageSurchargeCredits(pageCount) {
    return getChatPageTierSteps(pageCount) * CREDITS_INCREMENT_PER_TIER;
}

/**
 * @param {string} menuKey
 * @returns {number}
 */
export function getPresetTierBaseCredits(menuKey) {
    const k = normalizePresetModelKey(menuKey);
    if (k === 'chatgpt') return CHATGPT_BASE;
    if (k === 'grok' || k === 'gemini' || k === 'kimi') return ADVANCED_BASE;
    return STANDARD_BASE;
}

/**
 * @param {string} menuKey 菜单 key（含兼容旧 key）
 * @param {number|null|undefined} [pageCount] 当前文献 PDF 总页数；未知时不加页数加价
 * @returns {number}
 */
export function getChatCreditsForPresetKey(menuKey, pageCount) {
    return getPresetTierBaseCredits(menuKey) + getPageSurchargeCredits(pageCount);
}

/**
 * 余额检查用；自定义模型返回 null（不扣平台余额）
 * @param {string} menuKey
 * @param {number|null|undefined} [pageCount]
 * @returns {number|null}
 */
export function getChatCreditsForBalanceCheck(menuKey, pageCount) {
    if (!menuKey || menuKey === 'custom') return null;
    return getChatCreditsForPresetKey(menuKey, pageCount);
}
