import { MULTIMODAL_UNSUPPORTED_CODE } from './multimodalApiError';
import {
    isLikelyChatRegionBlockedError,
    userFacingChatApiErrorText,
} from './chatRegionBlockedError';
import { zoteroL10n } from './zoteroL10n';

function isMultimodalRejectedBranch(raw, multimodalRejectedCode) {
    return (
        multimodalRejectedCode === MULTIMODAL_UNSUPPORTED_CODE ||
        (raw && raw.includes('不支持图片输入'))
    );
}

/**
 * 硬失败时助手气泡正文：catch 与流式 streamFailedHard 共用，避免 Gemini 拼在 fullMessage 里多出一种样式。
 */
export function buildChatHardFailureBubbleContent(rawMsg, { modelLabel, multimodalRejectedCode } = {}) {
    const raw = rawMsg == null ? '' : String(rawMsg);
    const msg = userFacingChatApiErrorText(raw);
    const lc = msg.toLowerCase();

    if (isMultimodalRejectedBranch(raw, multimodalRejectedCode)) {
        return zoteroL10n('vibe-ai-chat-multimodal-not-supported', { model: modelLabel });
    }
    if (isLikelyChatRegionBlockedError(raw)) {
        return msg;
    }
    let errorContent = `${zoteroL10n('vibe-ai-chat-error-header')}\n\n${msg}`;
    if (msg.includes('图片无法访问') || lc.includes('image')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-image')}`;
    } else if (msg.includes('API Key')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-apikey')}`;
    } else if (msg.includes('超限') || lc.includes('rate') || lc.includes('too many')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-rate-limit')}`;
    } else if (msg.includes('网络') || lc.includes('network')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-network')}`;
    } else if (msg.includes('超时') || lc.includes('timeout') || lc.includes('timed out')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-timeout')}`;
    } else if (msg.includes('服务器') || lc.includes('server')) {
        errorContent += `\n\n${zoteroL10n('vibe-ai-chat-tip-server')}`;
    }
    return errorContent;
}

/** 与 catch 里 antMessage.error 的 content 规则一致 */
export function buildChatHardFailureToastContent(rawMsg, { modelLabel, multimodalRejectedCode } = {}) {
    const raw = rawMsg == null ? '' : String(rawMsg);
    if (isMultimodalRejectedBranch(raw, multimodalRejectedCode)) {
        return zoteroL10n('vibe-ai-chat-multimodal-not-supported', { model: modelLabel });
    }
    return userFacingChatApiErrorText(raw);
}
