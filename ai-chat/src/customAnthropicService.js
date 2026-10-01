/**
 * 自定义 Anthropic Messages API 服务（与 OpenAI 兼容接口分离）
 * Base URL 可为根域名、/v1 或完整 .../v1/messages
 */

import { enhanceErrorWithMultimodalHint } from './multimodalApiError';
import { resolveTemperatureForCustomModel } from './customChatTemperature';
import { fetchHttpsImageAsDataUrl } from './clientImageDataUrl';
import { isZhLocale, zoteroL10n } from './zoteroL10n';

class CustomAnthropicService {
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

    setConfig(config) {
        this.config = { ...this.config, ...config };
    }

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

    _contentToText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const textPart = content.find(p => p.type === 'text');
            if (textPart?.text) return textPart.text;
            return JSON.stringify(content);
        }
        return String(content ?? '');
    }

    /** 历史中的 user 内容统一成 OpenAI 式 parts，便于合并与转 Anthropic */
    _storedToOpenAIParts(stored) {
        if (stored === null || stored === undefined) return [];
        if (typeof stored === 'string') return stored ? [{ type: 'text', text: stored }] : [];
        if (Array.isArray(stored)) return stored;
        return [{ type: 'text', text: String(stored) }];
    }

    _mergeStoredUserContents(a, b) {
        const pa = this._storedToOpenAIParts(a);
        const pb = this._storedToOpenAIParts(b);
        return [...pa, { type: 'text', text: '\n\n' }, ...pb];
    }

    _mergeHistoryContentForRole(role, prevStored, nextStored) {
        if (role === 'assistant') {
            const a = typeof prevStored === 'string' ? prevStored : this._contentToText(prevStored);
            const b = typeof nextStored === 'string' ? nextStored : this._contentToText(nextStored);
            return `${a}\n\n${b}`;
        }
        return this._mergeStoredUserContents(prevStored, nextStored);
    }

    _dataUrlToAnthropicImageBlock(dataUrl) {
        const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) return null;
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: m[1] || 'image/png',
                data: m[2].replace(/\s/g, ''),
            },
        };
    }

    /** OpenAI Chat 多模态 parts → Anthropic Messages content blocks（http(s) 图在客户端拉取后改 base64） */
    async _openAIPartsToAnthropicBlocksAsync(parts) {
        const blocks = [];
        if (!Array.isArray(parts)) return blocks;
        for (const part of parts) {
            if (part.type === 'text') {
                const t = part.text ?? '';
                if (t) blocks.push({ type: 'text', text: t });
            } else if (part.type === 'image_url' && part.image_url) {
                const iu = part.image_url;
                const url = typeof iu === 'string' ? iu : iu.url;
                if (!url) continue;
                if (url.startsWith('data:')) {
                    const block = this._dataUrlToAnthropicImageBlock(url);
                    if (block) blocks.push(block);
                } else if (/^https?:\/\//i.test(url)) {
                    try {
                        const dataUrl = await fetchHttpsImageAsDataUrl(url);
                        const block = this._dataUrlToAnthropicImageBlock(dataUrl);
                        if (block) blocks.push(block);
                    } catch (e) {
                        const hint = e?.message || String(e);
                        throw new Error(
                            isZhLocale()
                                ? `图片 URL 无法在客户端加载（Anthropic 类接口通常要求 Base64）。${hint}`
                                : `Image URL cannot be loaded on client side (Anthropic-style APIs usually require Base64). ${hint}`
                        );
                    }
                } else {
                    blocks.push({ type: 'image', source: { type: 'url', url } });
                }
            }
        }
        return blocks;
    }

    _collapseAnthropicBlocks(blocks) {
        if (!blocks || blocks.length === 0) return '';
        if (blocks.every((b) => b.type === 'text')) {
            return blocks.map((b) => b.text).join('');
        }
        return blocks;
    }

    /** 会话历史或当前用户输入（string | OpenAI parts）→ Anthropic API 的 content 字段 */
    async _storedToAnthropicApiContentAsync(stored) {
        if (typeof stored === 'string') return stored;
        if (Array.isArray(stored)) {
            if (stored.length && stored[0].type === 'image' && stored[0].source) {
                return this._collapseAnthropicBlocks(stored);
            }
            const blocks = await this._openAIPartsToAnthropicBlocksAsync(stored);
            return this._collapseAnthropicBlocks(blocks);
        }
        return String(stored ?? '');
    }

    /**
     * 规范化为 .../v1/messages
     */
    _formatUrl(baseUrl) {
        let url = baseUrl.trim().replace(/\/+$/, '');
        if (url.endsWith('/messages')) {
            return url;
        }
        if (/\/v\d+$/.test(url)) {
            return `${url}/messages`;
        }
        if (/\/v\d+\//.test(url)) {
            return url.replace(/(\/v\d+\/).*$/, '$1messages');
        }
        return `${url}/v1/messages`;
    }

    /**
     * 从 OpenAI 式 role 列表构造 Anthropic 的 system + messages（合并连续同角色）
     */
    async _buildBodyAsync(systemPrompt, includeHistory, userMessage, temperature) {
        const systemParts = [];
        if (systemPrompt) {
            systemParts.push(systemPrompt);
        }

        const rawMessages = [];
        if (includeHistory && this.conversationHistory.length > 0) {
            for (const m of this.conversationHistory) {
                if (m.role === 'system') {
                    systemParts.push(this._contentToText(m.content));
                } else if (m.role === 'user' || m.role === 'assistant') {
                    rawMessages.push({ role: m.role, content: m.content });
                }
            }
        }

        rawMessages.push({ role: 'user', content: userMessage });

        const merged = [];
        for (const m of rawMessages) {
            if (merged.length && merged[merged.length - 1].role === m.role) {
                merged[merged.length - 1].content = this._mergeHistoryContentForRole(
                    m.role,
                    merged[merged.length - 1].content,
                    m.content
                );
            } else {
                merged.push({ role: m.role, content: m.content });
            }
        }

        const apiMessages = [];
        for (const m of merged) {
            apiMessages.push({
                role: m.role,
                content: await this._storedToAnthropicApiContentAsync(m.content),
            });
        }

        const body = {
            model: this.config.model,
            max_tokens: 8192,
            stream: true,
            messages: apiMessages
        };
        const systemStr = systemParts.filter(Boolean).join('\n\n');
        if (systemStr) {
            body.system = systemStr;
        }
        if (typeof temperature === 'number') {
            body.temperature = temperature;
        }
        return body;
    }

    async chatStream(userMessage, onChunk, options = {}) {
        const { baseUrl, apiKey, model } = this.config;
        const { includeHistory = true, systemPrompt, temperature: temperatureOpt } = options;
        const temperature = resolveTemperatureForCustomModel(model, temperatureOpt);

        if (!baseUrl || !apiKey || !model) {
            throw new Error(zoteroL10n(
                'vibe-ai-chat-custom-model-config-incomplete',
                undefined,
                'Custom model configuration is incomplete. Please open model settings and complete it.'
            ));
        }

        const endpoint = this._formatUrl(baseUrl);
        const body = await this._buildBodyAsync(systemPrompt, includeHistory, userMessage, temperature);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                let errorMsg = `API request failed: ${response.status}`;
                let backendDetail = '';
                try {
                    const errData = await response.json();
                    backendDetail = errData.error?.message || errData.message || errData.detail || '';
                    if (backendDetail) errorMsg += ` - ${backendDetail}`;
                } catch (_) { /* ignore */ }
                const err = new Error(errorMsg);
                enhanceErrorWithMultimodalHint(err, backendDetail || errorMsg);
                throw err;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullMessage = '';

            while (true) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const dataStr = trimmed.slice(5).trim();
                    if (!dataStr || dataStr === '[DONE]') continue;

                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
                            const content = data.delta.text;
                            fullMessage += content;
                            onChunk({ done: false, content, fullMessage });
                        }
                    } catch (_) {
                        // 忽略非 JSON 行
                    }
                }

                if (done) break;
            }

            if (includeHistory) {
                this.addMessage('user', userMessage);
                this.addMessage('assistant', fullMessage);
            }
            onChunk({ done: true, fullMessage });
        } catch (error) {
            console.error('[CustomAnthropic] Error:', error);
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

export default new CustomAnthropicService();
