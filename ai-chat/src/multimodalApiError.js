/**
 * 识别各家 API 返回中「当前请求/模型不接受图片或多模态」的常见文案，用于友好提示。
 */

const EN_PATTERNS = [
    /does not support (image|images|vision|multimodal)/i,
    /do not support (image|images|vision)/i,
    /image(s)? (is|are) not supported/i,
    /unsupported (image|image type|content type|message type)/i,
    /invalid (image|image_url|image url|content)/i,
    /cannot (accept|process|handle) (image|images)/i,
    /model.*does not.*vision/i,
    /multimodal.*not.*available/i,
    /input.*image.*not.*allowed/i,
    /must not provide.*image/i,
    /only text.*supported/i,
];

const ZH_PATTERNS = [/不支持.*图片/, /图片.*不支持/, /不支持.*视觉/, /不支持.*多模态/, /无法识别.*图片/];

/** 上游拒绝「某张图的 URL」（常因服务端拉不到 OSS），不是「模型不做多模态」 */
function isUnsupportedImageUrlPolicyError(message) {
    if (!message || typeof message !== 'string') return false;
    const lower = message.toLowerCase();
    return /unsupported image url/.test(lower) || /unsupported\s+url.*image/.test(lower);
}

/** @param {string} message */
export function isLikelyMultimodalUnsupportedError(message) {
    if (!message || typeof message !== 'string') return false;
    if (isUnsupportedImageUrlPolicyError(message)) return false;
    if (EN_PATTERNS.some((re) => re.test(message))) return true;
    if (ZH_PATTERNS.some((re) => re.test(message))) return true;
    // OpenAI 类：整段错误里出现 image_url 且带有 invalid / unsupported 等
    const lower = message.toLowerCase();
    if (
        lower.includes('image_url') &&
        /invalid|unsupported|not allowed|rejected|forbidden/.test(lower) &&
        !isUnsupportedImageUrlPolicyError(message)
    ) {
        return true;
    }
    return false;
}

export const MULTIMODAL_UNSUPPORTED_CODE = 'VIBE_MULTIMODAL_UNSUPPORTED';

/**
 * @param {Error} err
 * @param {string} [backendMessage]
 */
export function enhanceErrorWithMultimodalHint(err, backendMessage) {
    if (!err || typeof err !== 'object') return err;
    const raw = [backendMessage, err.message].filter(Boolean).join(' ');
    if (isLikelyMultimodalUnsupportedError(raw)) {
        err.code = MULTIMODAL_UNSUPPORTED_CODE;
    }
    return err;
}
