/**
 * AI Chat 附图上传（开源版）：
 * - 未配置自建网关（prefs vibeProxy.baseUrl）时，直接返回 Data URI（base64 内联），
 *   不经任何远程服务；多模态 API 会收到内联图片（多数 OpenAI 兼容端点均支持）。
 * - 配置了网关时，走 `oss-image-upload` Edge Function（自建，见 README「自建后端」章节）。
 */
import { getCurrentSupabaseConfig } from './chatRuntimeConfig';

function getOssImageUploadConfig() {
    const config = getCurrentSupabaseConfig();
    if (config?.url) {
        return {
            endpoint: `${config.url.replace(/\/$/, '')}/functions/v1/oss-image-upload`,
            anonKey: config.anonKey || null,
        };
    }
    return { endpoint: null, anonKey: null };
}

/**
 * 将 Base64 Data URI 上传到阿里云 OSS（经上述 Edge Function）
 * @param {string} base64DataURI - Base64 格式的图片数据 (data:image/png;base64,...)
 * @param {string} fileName - 文件名（如 'screenshot_123456.png'）
 * @returns {Promise<{url: string, key: string}>} 上传结果，包含公开 URL
 */
export async function uploadImageToOss(base64DataURI, fileName = 'image.png') {
    // 开源版无网关：直接内联 base64，不上传任何远端
    const { endpoint } = getOssImageUploadConfig();
    if (!endpoint) {
        console.log('[ImageUploader] OSS build: no gateway configured, using inline data URI');
        return { url: base64DataURI, key: null, inline: true };
    }
    console.log('[ImageUploader] 开始上传图片（oss-image-upload）');
    console.log('[ImageR2] 文件名:', fileName);
    console.log('[ImageR2] Data URI 前缀:', base64DataURI.substring(0, 50));

    try {
        // 1. 提取 MIME type 和 base64 数据
        const matches = base64DataURI.match(/^data:(.+?);base64,(.+)$/);
        if (!matches) {
            throw new Error('无效的 Base64 Data URI 格式');
        }

        const mimeType = matches[1]; // 如 'image/png'
        const base64Data = matches[2];

        console.log('[ImageR2] MIME Type:', mimeType);
        console.log('[ImageR2] Base64 数据长度:', base64Data.length);

        // 2. 将 Base64 转换为 Blob
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });

        console.log('[ImageUploader] Blob 大小:', blob.size, 'bytes (', (blob.size / 1024).toFixed(2), 'KB)');

        // 3. 构建 FormData 上传
        const formData = new FormData();
        formData.append('file', blob, fileName);

        console.log('[ImageUploader] 正在上传到 OSS（Edge Function）...');
        const startTime = Date.now();

        // 4. 发送上传请求
        const { endpoint, anonKey } = getOssImageUploadConfig();
        const headers = {};
        if (anonKey) {
            headers['Authorization'] = `Bearer ${anonKey}`;
        }
        const response = await fetch(`${endpoint}/upload`, {
            method: 'POST',
            headers,
            body: formData
        });

        const elapsed = Date.now() - startTime;
        console.log('[ImageUploader] 上传响应状态:', response.status, '(', elapsed, 'ms)');

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ImageUploader] 上传失败:', errorText);
            throw new Error(`图片上传失败: ${response.status} - ${errorText}`);
        }

        // 5. 解析响应
        const result = await response.json();
        console.log('[ImageUploader] 上传响应:', result);

        if (!result.success) {
            throw new Error(result.error || '图片上传失败');
        }

        console.log('[ImageUploader] ✅ 上传成功！');
        console.log('[ImageUploader] 公开 URL:', result.url);
        console.log('[ImageUploader] 文件 Key:', result.key);

        // 直接使用 Worker 返回的 URL（Worker 会根据配置返回正确的公开 URL）
        return {
            url: result.url,
            key: result.key,
            proxyUrl: result.proxyUrl
        };

    } catch (error) {
        console.error('[ImageUploader] ❌ 上传失败:', error.message);
        throw error;
    }
}

/** @deprecated 历史命名，请使用 uploadImageToOss */
export const uploadImageToSupabase = uploadImageToOss;

/**
 * 删除 OSS 对象（若线上 Function 未实现 DELETE，可能返回失败）
 * @param {string} key - OSS object key
 */
export async function deleteImageFromOss(key) {
    try {
        console.log('[ImageUploader] 删除 OSS 对象:', key);

        const { endpoint, anonKey } = getOssImageUploadConfig();
        const headers = {};
        if (anonKey) {
            headers['Authorization'] = `Bearer ${anonKey}`;
        }
        const response = await fetch(`${endpoint}/file/${key}`, {
            method: 'DELETE',
            headers,
        });

        if (response.ok) {
            console.log('[ImageUploader] ✅ OSS 对象已删除:', key);
            return true;
        } else {
            console.warn('[ImageUploader] ⚠️ OSS 删除失败:', response.status);
            return false;
        }
    } catch (error) {
        console.warn('[ImageUploader] ⚠️ 删除异常:', error.message);
        return false;
    }
}

/** @deprecated 使用 deleteImageFromOss */
export const deleteImageFromSupabase = deleteImageFromOss;

/**
 * 批量上传图片到 OSS
 * @param {Array<{base64: string, name: string}>} images - 图片数组
 * @returns {Promise<Array<{url: string, key: string, originalIndex: number}>>} 上传结果数组
 */
export async function uploadMultipleImagesToOss(images) {
    console.log('[ImageUploader] 批量上传', images.length, '张图片');

    const results = [];
    for (let i = 0; i < images.length; i++) {
        try {
            const img = images[i];
            console.log(`[ImageUploader] 上传第 ${i + 1}/${images.length} 张图片:`, img.name);

            const uploadResult = await uploadImageToOss(img.base64, img.name);
            results.push({
                ...uploadResult,
                originalIndex: i,
                originalName: img.name
            });

        } catch (error) {
            console.error(`[ImageUploader] 第 ${i + 1} 张图片上传失败:`, error);
            // 继续上传其他图片
            results.push({
                error: error.message,
                originalIndex: i,
                originalName: images[i].name
            });
        }
    }

    const successCount = results.filter(r => !r.error).length;
    console.log('[ImageUploader] 批量上传完成:', successCount, '/', images.length, '成功');

    return results;
}

/** @deprecated 使用 uploadMultipleImagesToOss */
export const uploadMultipleImagesToSupabase = uploadMultipleImagesToOss;
