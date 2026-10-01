/**
 * 高级预设模型（与 Slate 菜单 Advanced 分组一致）仅 PRO / ULTIMATE 活跃订阅可用
 */

export const ADVANCED_PRESET_MODEL_KEYS = new Set([
    'chatgpt',
    'grok',
    'gemini',
    'kimi',
]);

/**
 * @param {string|null|undefined} planTier subscription_info.plan_tier
 */
export function planTierAllowsAdvancedChatModels(planTier) {
    const t = String(planTier || '').toUpperCase();
    return t === 'PRO' || t === 'ULTIMATE';
}

/**
 * @param {object|null|undefined} balance VibeDBSync.getUserBalance()：含 subscription_info、credits（聚合剩余，与解析/大纲扣费同源）
 */
export function subscriptionAllowsAdvancedFromBalance(balance) {
    const sub = balance?.subscription_info;
    if (!sub || sub.status !== 'active') return false;
    return planTierAllowsAdvancedChatModels(sub.plan_tier);
}
