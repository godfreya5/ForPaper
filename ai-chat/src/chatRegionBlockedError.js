import { isZhLocale, zoteroL10n } from './zoteroL10n';

/**
 * 上游（Gemini / OpenRouter 等）返回地域限制类错误时，统一给用户看的短文案。
 */
export const CHAT_REGION_BLOCKED_HINT =
    zoteroL10n('vibe-ai-chat-region-blocked');

/**
 * 英文 API 常见：User location is not supported / not available in your region。
 * 使用 \\b 避免误伤含 "location" 子串的无关词（如某些库名）。
 */
export function isLikelyChatRegionBlockedError(text) {
    if (!text || typeof text !== 'string') return false;
    const s = text.toLowerCase();
    return /\bregion\b/.test(s)
        || /\blocation\b/.test(s)
        || /该模型不支持该区域/.test(text);
}

/** 若为地域限制则替换为友好中文，否则返回原始字符串 */
export function userFacingChatApiErrorText(raw) {
    const s = raw == null ? '' : String(raw);
    if (isLikelyChatRegionBlockedError(s)) return CHAT_REGION_BLOCKED_HINT;
    if (!isZhLocale()) {
        const map = [
            ['网络连接超时，请检查网络并重试', 'Network timeout. Please check your connection and retry'],
            ['网络连接失败，请检查网络并重试', 'Network error. Please check your connection and retry'],
            ['请求被中断，请重试', 'Request was interrupted. Please retry'],
            ['流式输出超时，连接可能中断', 'Streaming timed out. Connection may have been interrupted'],
            ['API Key 无效，请检查配置', 'Invalid API key. Please check your settings'],
            ['API 授权失败，请检查 API Key 配置', 'API authorization failed. Please verify your API key settings'],
            ['API 请求频率超限，请稍后重试', 'Rate limit exceeded. Please try again later'],
            ['服务器请求过于频繁，请稍后再试', 'Server is busy. Please try again later'],
            ['服务器错误，请稍后重试', 'Server error. Please try again later'],
            ['服务器维护中或暂时不可用，请稍后重试', 'Server is under maintenance or temporarily unavailable'],
            ['没有权限访问该资源', 'You do not have permission to access this resource'],
            ['请求参数有误', 'Invalid request parameters'],
            ['图片无法访问（可能已过期），请重新上传图片', 'Image is inaccessible (possibly expired). Please re-upload it'],
            ['当前模型不支持本次对话中的图片或多模态输入，请去掉图片后重试', 'This model does not support images/multimodal input in this chat. Remove images and retry'],
            ['自定义模型配置不完整，请点击模型菜单右侧的设置图标进行配置。', 'Custom model configuration is incomplete. Open model settings and finish configuration'],
            ['保存失败', 'Save failed'],
        ];
        for (const [cn, en] of map) {
            if (s.includes(cn)) return s.replace(cn, en);
        }
    }
    return s;
}
