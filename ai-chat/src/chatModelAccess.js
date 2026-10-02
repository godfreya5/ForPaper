/**
 * 模型访问控制（开源版）
 *
 * 开源版没有订阅体系：所有预设模型对本地用户一视同仁，不再有 PRO / ULTIMATE 门槛。
 * - ADVANCED_PRESET_MODEL_KEYS 保留（分组展示用途：菜单「高级」分组）
 * - subscriptionAllowsAdvancedFromBalance 恒返回 true（stub 的 getUserBalance 本身
 *   也返回 active/ULTIMATE，双保险）
 *
 * 注意：预设模型仍需要自建网关（prefs vibeProxy.baseUrl）才能使用；
 * 未配置网关时建议直接使用「自定义模型」直连自己的 API。
 */

export const ADVANCED_PRESET_MODEL_KEYS = new Set([
    'chatgpt',
    'grok',
    'gemini',
    'kimi',
]);

/**
 * @param {string|null|undefined} planTier 保留参数兼容旧调用
 */
export function planTierAllowsAdvancedChatModels(planTier) {
    return true; // 开源版：无订阅门槛
}

/**
 * @param {object|null|undefined} balance 保留参数兼容旧调用
 */
export function subscriptionAllowsAdvancedFromBalance(balance) {
    return true; // 开源版：无订阅门槛
}
