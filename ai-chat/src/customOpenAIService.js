/**
 * 自定义 OpenAI 兼容服务
 * 允许用户配置任意支持 OpenAI 接口格式的模型服务 (如 DeepSeek, Moonshot, LocalLLM 等)
 */

import { enhanceErrorWithMultimodalHint } from './multimodalApiError';
import { resolveTemperatureForCustomModel } from './customChatTemperature';
import { inlineHttpsImageUrlsInOpenAIParts } from './clientImageDataUrl';

/** @param {unknown} userMessage */
function normalizeOpenAIMultimodalContent(userMessage) {
    if (!Array.isArray(userMessage)) return userMessage;
    return userMessage.map((part) => {
        if (!part || typeof part !== 'object') return part;
        if (part.type === 'text') {
            return { type: 'text', text: part.text ?? '' };
        }
        if (part.type === 'image_url' && part.image_url) {
            const iu = part.image_url;
            const url = typeof iu === 'string' ? iu : iu.url;
            if (!url) return part;
            const detail = typeof iu === 'object' && iu.detail ? iu.detail : undefined;
            return {
                type: 'image_url',
                image_url: detail ? { url, detail } : { url },
            };
        }
        return part;
    });
}

class CustomOpenAIService {
    constructor() {
        this.config = {
            baseUrl: '',
            apiKey: '',
            model: ''
        };
        this.conversationHistory = [];
        this.paperContext = null;
        this.hasPaperContextSet = false;
    }

    /**
     * 设置配置信息
     * @param {Object} config - { baseUrl, apiKey, model }
     */
    setConfig(config) {
        this.config = { ...this.config, ...config };
    }

    /**
     * 清空历史
     */
    clearHistory() {
        this.conversationHistory = [];
        this.paperContext = null;
        this.hasPaperContextSet = false;
    }

    hasPaperContext() {
        return this.hasPaperContextSet;
    }

    setPaperContext(paperMarkdown) {
        if (paperMarkdown && !this.hasPaperContextSet) {
            this.paperContext = paperMarkdown;
            this.hasPaperContextSet = true;
            this.conversationHistory.unshift({
                role: 'system',
                content: `[论文全文 Markdown 开始]\n${paperMarkdown}\n[论文全文 Markdown 结束]`
            });
        }
    }

    addMessage(role, content) {
        this.conversationHistory.push({ role, content });
    }

    getHistory() {
        return this.conversationHistory;
    }

    setHistory(history) {
        this.conversationHistory = history;
    }

    /**
     * 格式化 URL，确保以 /chat/completions 结尾
     * 支持多种输入格式:
     * - https://api.openai.com
     * - https://api.openai.com/v1
     * - https://api.openai.com/v1/
     * - https://api.openai.com/v1/chat/completions
     * - https://open.bigmodel.cn/api/paas/v4 (智谱AI)
     */
    _formatUrl(baseUrl) {
        let url = baseUrl.trim();
        // 移除末尾斜杠
        url = url.replace(/\/+$/, '');

        console.log('[CustomOpenAI] Original baseUrl:', baseUrl);

        // 如果已经包含完整路径，直接返回
        if (url.endsWith('/chat/completions')) {
            console.log('[CustomOpenAI] URL already complete:', url);
            return url;
        }

        // 检查是否以版本号结尾 (v1, v2, v3, v4 等)
        if (/\/v\d+$/.test(url)) {
            // 以版本号结尾，直接添加 /chat/completions
            url += '/chat/completions';
            console.log('[CustomOpenAI] Added /chat/completions to versioned URL:', url);
            return url;
        }

        // 如果包含 /vN/ 但路径不完整，补全
        if (/\/v\d+\//.test(url)) {
            // 移除版本号后面的部分，重新添加
            url = url.replace(/(\/v\d+\/).*$/, '$1chat/completions');
            console.log('[CustomOpenAI] Fixed partial path:', url);
            return url;
        }

        // 没有版本号，添加默认的 /v1/chat/completions
        url += '/v1/chat/completions';
        console.log('[CustomOpenAI] Added default /v1/chat/completions:', url);
        return url;
    }

    /**
     * 流式对话
     */
    async chatStream(userMessage, onChunk, options = {}) {
        const { baseUrl, apiKey, model } = this.config;
        const { includeHistory = true, systemPrompt, temperature: temperatureOpt } = options;
        const temperature = resolveTemperatureForCustomModel(model, temperatureOpt);

        if (!baseUrl || !apiKey || !model) {
            throw new Error('自定义模型配置不完整，请点击模型菜单右侧的设置图标进行配置。');
        }

        const endpoint = this._formatUrl(baseUrl);
        const messages = [];

        // 1. 系统提示
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // 2. 历史记录；含图轮次把 http(s) URL 在客户端拉成 data URL（Kimi 等拒 OSS 直链）
        if (includeHistory && this.conversationHistory.length > 0) {
            for (const m of this.conversationHistory) {
                if (Array.isArray(m.content)) {
                    messages.push({
                        ...m,
                        content: await inlineHttpsImageUrlsInOpenAIParts(
                            normalizeOpenAIMultimodalContent(m.content)
                        ),
                    });
                } else {
                    messages.push(m);
                }
            }
        }

        // 3. 用户消息
        const userContentForRequest = await inlineHttpsImageUrlsInOpenAIParts(
            normalizeOpenAIMultimodalContent(userMessage)
        );

        messages.push({ role: 'user', content: userContentForRequest });

        console.log('[CustomOpenAI] Request config:', {
            endpoint,
            model,
            messageCount: messages.length,
            hasApiKey: !!apiKey
        });

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    stream: true,
                    temperature: temperature
                })
            });

            if (!response.ok) {
                let errorMsg = `API 请求失败: ${response.status}`;
                let backendDetail = '';
                try {
                    const errData = await response.json();
                    backendDetail = errData.error?.message || errData.message || errData.detail || '';
                    if (backendDetail) errorMsg += ` - ${backendDetail}`;
                } catch (e) { /* ignore */ }
                const err = new Error(errorMsg);
                enhanceErrorWithMultimodalHint(err, backendDetail || errorMsg);
                throw err;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullMessage = '';
            let streamCompleted = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            streamCompleted = true;
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.error) {
                                const em =
                                    parsed.error.message ||
                                    (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
                                const streamErr = new Error(em || '流式接口返回错误');
                                enhanceErrorWithMultimodalHint(streamErr, em);
                                throw streamErr;
                            }
                            const delta = parsed.choices?.[0]?.delta;
                            let piece = '';
                            if (typeof delta?.content === 'string') {
                                piece = delta.content;
                            } else if (Array.isArray(delta?.content)) {
                                for (const block of delta.content) {
                                    if (block?.type === 'text' && block.text) piece += block.text;
                                }
                            }
                            if (piece) {
                                fullMessage += piece;
                                onChunk({ done: false, content: piece, fullMessage });
                            }
                        } catch (e) {
                            if (e instanceof SyntaxError) {
                                /* 忽略损坏的 SSE 行 */
                            } else {
                                throw e;
                            }
                        }
                    }
                }
            }

            // 完成（历史里保留原始 userMessage，避免 base64 撑爆内存）
            if (includeHistory) {
                this.addMessage('user', userMessage);
                this.addMessage('assistant', fullMessage);
            }
            onChunk({ done: true, fullMessage });

        } catch (error) {
            console.error('[CustomOpenAI] Error:', error);
            enhanceErrorWithMultimodalHint(error, error?.message);
            onChunk({
                done: true,
                fullMessage: '',
                error: error.message,
                errorCode: error.code,
                interrupted: true
            });
            throw error;
        }
    }
}

export default new CustomOpenAIService();
