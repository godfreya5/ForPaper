/**
 * 预设模型是否支持本会话带图（OpenAI 式 image_url / 多模态）
 * 纯文本：MiniMax-M2.5、GLM-4.7、DeepSeek-V4-Flash（见菜单 minimax / zhipu / deepseek）
 */

import { normalizePresetModelKey } from './chatModelPricing';

const TEXT_ONLY_PRESET_NORMALIZED_KEYS = new Set(['minimax', 'zhipu', 'deepseek']);

/**
 * @param {string} menuKey selectedModel.key；custom 视为未知能力，由上游校验，客户端放行选图
 */
export function presetSupportsVision(menuKey) {
    if (!menuKey || menuKey === 'custom') return true;
    const k = normalizePresetModelKey(menuKey);
    return !TEXT_ONLY_PRESET_NORMALIZED_KEYS.has(k);
}
