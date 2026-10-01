/**
 * AI Chat → Supabase `ai-chat-proxy-openrouter` → OpenRouter（OpenAI 兼容流式）
 */
import { zoteroL10n } from './zoteroL10n';
import { getOpenRouterProxyUrl } from './chatRuntimeConfig';

const DEFAULT_MODEL = 'openai/gpt-5.4-nano';

/**
 * Worker 返回体：{ error: string, details: OpenRouter JSON }
 * OpenRouter：{ error: { message, code, metadata?: { reasons, provider_name } } } }
 */
function extractOpenRouterFailureMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    // SSE 数据块内嵌：{ error: { message, metadata? } }
    if (payload.error && typeof payload.error === 'object' && payload.error !== null) {
        const oe = payload.error;
        if (typeof oe.message === 'string' && oe.message.trim()) {
            let msg = oe.message.trim();
            const meta = oe.metadata;
            if (meta && Array.isArray(meta.reasons) && meta.reasons.length) {
                msg += `（${meta.reasons.join('; ')}）`;
            }
            if (meta && meta.provider_name) msg += ` [${meta.provider_name}]`;
            return msg;
        }
    }
    const details = payload.details;
    if (details && typeof details.error === 'object' && details.error !== null) {
        const oe = details.error;
        let msg = typeof oe.message === 'string' ? oe.message.trim() : '';
        const meta = oe.metadata;
        if (meta && Array.isArray(meta.reasons) && meta.reasons.length) {
            const r = meta.reasons.join('; ');
            msg = msg ? `${msg}（${r}）` : r;
        }
        if (meta && meta.provider_name) {
            msg = msg ? `${msg} [${meta.provider_name}]` : String(meta.provider_name);
        }
        if (msg) return msg;
    }
    if (details && typeof details.error === 'string') return details.error;
    const top = payload.error;
    if (typeof top === 'string' && !/^OpenRouter request failed:\s*\d+$/.test(top)) {
        return top;
    }
    if (payload.message) return String(payload.message);
    return '';
}

class OpenRouterChatService {
    constructor(apiKey = '') {
        this.apiKey = apiKey;
        this.conversationHistory = [];
        this.paperContext = null;
        this.hasPaperContextSet = false;
    }

    setApiKey(apiKey) {
        console.warn('[OpenRouterChat] setApiKey is deprecated');
        this.apiKey = apiKey;
    }

    getApiKey() {
        return this.apiKey;
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

    _buildMessageContent(content) {
        if (Array.isArray(content)) {
            return content;
        }
        return content;
    }

    async _getAccessToken() {
        const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
        if (Zotero && Zotero.VibeDBSync && Zotero.VibeDBSync.getAccessToken) {
            try {
                return await Zotero.VibeDBSync.getAccessToken();
            } catch (e) {
                console.error('[OpenRouterChat] Failed to get token:', e);
            }
        }
        return null;
    }

    _handleUnauthorized() {
        console.log('[OpenRouterChat] Token expired (401)');
        const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
        if (Zotero && Zotero.VibeDBSync) {
            if (Zotero.VibeDBSync.clearUser) Zotero.VibeDBSync.clearUser();
            if (Zotero.VibeDBSync.ensureLoggedIn) Zotero.VibeDBSync.ensureLoggedIn();
        }
    }

    async chatStream(userMessage, onChunk, options = {}) {
        const {
            model = DEFAULT_MODEL,
            temperature = 1.0,
            top_p = 0.95,
            max_tokens = 4096,
            includeHistory = true,
            systemPrompt = 'You are a helpful AI assistant.'
        } = options;

        const messages = [];

        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        if (includeHistory && this.conversationHistory.length > 0) {
            messages.push(...this.conversationHistory);
        }

        messages.push({
            role: 'user',
            content: this._buildMessageContent(userMessage)
        });

        const requestBody = {
            model,
            messages,
            temperature,
            top_p,
            max_tokens,
            stream: true
        };

        try {
            const lastMessage = messages[messages.length - 1];
            if (Array.isArray(lastMessage.content)) {
                console.log('[OpenRouterChat] Message content array:', lastMessage.content.map((item, idx) => ({
                    index: idx,
                    type: item.type,
                    hasUrl: item.type === 'image_url' ? !!item.image_url?.url : 'N/A'
                })));
            }

            const proxyUrl = getOpenRouterProxyUrl();
            const token = await this._getAccessToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            console.log('[OpenRouterChat] Request model:', {
                model: requestBody.model,
                proxyUrl,
                stream: requestBody.stream,
                messageCount: requestBody.messages.length
            });

            const response = await fetch(proxyUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            console.log('[OpenRouterChat] Response:', response.status, response.statusText);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[OpenRouterChat] API error:', response.status, errorData);
                let friendlyMessage = extractOpenRouterFailureMessage(errorData);
                if (!friendlyMessage) {
                    try {
                        friendlyMessage = errorData?.details
                            ? JSON.stringify(errorData.details)
                            : '';
                    } catch (_) {
                        friendlyMessage = '';
                    }
                }
                if (!friendlyMessage) {
                    friendlyMessage =
                        response.status === 403
                            ? 'Server returned 403 (possibly blocked by content policy, unauthorized model, or provider rejection). Check details in console and verify OpenRouter key/model/account settings.'
                            : `HTTP ${response.status} ${response.statusText || ''}`.trim();
                }
                if (response.status === 401) {
                    this._handleUnauthorized();
                }
                const err = new Error(`API request failed: ${friendlyMessage}`);
                err.rawError = errorData;
                err.statusCode = response.status;
                throw err;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullMessage = '';
            let lastChunkTime = Date.now();
            const TIMEOUT_MS = 30000;
            let streamCompleted = false;

            try {
                while (true) {
                    if (Date.now() - lastChunkTime > TIMEOUT_MS) {
                        console.warn('[OpenRouterChat] Stream timeout');
                        throw new Error('Stream timed out. Connection may have been interrupted');
                    }

                    const { done, value } = await reader.read();

                    if (done) {
                        if (!streamCompleted && fullMessage) {
                            if (includeHistory) {
                                this.addMessage('user', userMessage);
                                this.addMessage('assistant', fullMessage);
                            }
                            onChunk({
                                done: true,
                                fullMessage,
                                interrupted: true
                            });
                        }
                        break;
                    }

                    lastChunkTime = Date.now();
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);

                            if (data === '[DONE]') {
                                streamCompleted = true;
                                if (includeHistory) {
                                    this.addMessage('user', userMessage);
                                    this.addMessage('assistant', fullMessage);
                                }
                                onChunk({ done: true, fullMessage });
                                return { success: true, message: fullMessage };
                            }

                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.error) {
                                    const em =
                                        extractOpenRouterFailureMessage(parsed) ||
                                        JSON.stringify(parsed.error);
                                    throw new Error(`API request failed: ${em}`);
                                }
                                const content = parsed.choices?.[0]?.delta?.content || '';
                                const finishReason = parsed.choices?.[0]?.finish_reason;
                                if (finishReason === 'stop') {
                                    streamCompleted = true;
                                }
                                if (content) {
                                    fullMessage += content;
                                    onChunk({
                                        done: false,
                                        content,
                                        fullMessage
                                    });
                                }
                            } catch (e) {
                                if (e.message && e.message.startsWith('API request failed:')) {
                                    throw e;
                                }
                                console.warn('[OpenRouterChat] Failed to parse SSE:', line, e);
                            }
                        }
                    }
                }

                return {
                    success: true,
                    message: fullMessage,
                    interrupted: !streamCompleted
                };
            } catch (readError) {
                console.error('[OpenRouterChat] Stream read error:', readError);
                let friendlyMessage = readError.message;
                if (readError.message.includes('timeout') || readError.message.includes('timed out')) {
                    friendlyMessage = zoteroL10n('vibe-ai-chat-network-timeout');
                } else if (readError.message.includes('Failed to fetch')) {
                    friendlyMessage = zoteroL10n('vibe-ai-chat-network-failed');
                } else if (readError.message.includes('abort')) {
                    friendlyMessage = zoteroL10n('vibe-ai-chat-request-interrupted');
                }

                if (fullMessage && includeHistory) {
                    this.addMessage('user', userMessage);
                    this.addMessage('assistant', fullMessage);
                }

                onChunk({
                    done: true,
                    fullMessage,
                    error: friendlyMessage,
                    interrupted: true
                });

                const error = new Error(friendlyMessage);
                error.originalError = readError;
                throw error;
            }
        } catch (error) {
            console.error('[OpenRouterChat] chatStream failed:', error);
            throw error;
        }
    }
}

const openrouterChatService = new OpenRouterChatService();

export default openrouterChatService;
export { OpenRouterChatService };
