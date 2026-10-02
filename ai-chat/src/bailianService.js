/**
 * 阿里云百炼（DashScope OpenAI 兼容）对话服务
 * 与 reader/onflow 使用的 `ai-summary-proxy-bailian` Edge Function 一致，POST 根路径、无 thinking 字段
 */

const getBailianProxyUrl = () => {
    // 开源版：网关地址从 prefs（vibeProxy.baseUrl）读取；未配置返回 null，调用方应提示改用自定义模型
    const Zotero = (typeof window !== 'undefined' && (window.Zotero || window.parent?.Zotero || window.top?.Zotero)) || null;
    const config = Zotero?.VibeDBSync?.getSupabaseConfig?.() || null;
    if (config && config.url) {
        const baseUrl = config.url.replace(/\/$/, '');
        return `${baseUrl}/functions/v1/ai-summary-proxy-bailian`;
    }
    return null;
};

const DEFAULT_MODEL = 'qwen-plus-latest';

/**
 * 百炼 AI 服务（JWT 与 llmapi.callBailianAI 一致）
 */
class BailianService {
    constructor(apiKey = '') {
        // API Key 已废弃，保留参数仅为兼容性
        this.apiKey = apiKey;
        this.conversationHistory = []; // 存储对话历史
        this.paperContext = null; // 存储论文上下文内容
        this.hasPaperContextSet = false; // 标记是否已设置论文上下文
    }

    /**
     * 设置 API Key（已废弃，保留仅为兼容性）
     */
    setApiKey(apiKey) {
        console.warn('[Bailian] setApiKey 已废弃，API Key 现在由服务端管理');
        this.apiKey = apiKey;
    }

    /**
     * 获取 API Key（已废弃）
     */
    getApiKey() {
        return this.apiKey;
    }

    /**
     * 清空对话历史
     */
    clearHistory() {
        this.conversationHistory = [];
        this.paperContext = null;
        this.hasPaperContextSet = false; // 清空时重置标记
    }

    /**
     * 检查是否已设置论文上下文
     * @returns {boolean} - 是否已设置论文上下文
     */
    hasPaperContext() {
        return this.hasPaperContextSet;
    }

    /**
     * 设置论文上下文（只在未设置过时调用）
     * @param {string} paperMarkdown - 论文的Markdown内容
     */
    setPaperContext(paperMarkdown) {
        // 检查是否已经设置过论文上下文，避免重复添加
        if (paperMarkdown && !this.hasPaperContextSet) {
            this.paperContext = paperMarkdown;
            this.hasPaperContextSet = true; // 设置标记
            // 将论文上下文插入到对话历史的最前面（作为 system 消息）
            this.conversationHistory.unshift({
                role: 'system',
                content: `[论文全文 Markdown 开始]\n${paperMarkdown}\n[论文全文 Markdown 结束]`
            });
        }
    }

    /**
     * 添加消息到历史记录
     */
    addMessage(role, content) {
        this.conversationHistory.push({
            role,
            content
        });
    }

    /**
     * 获取对话历史
     */
    getHistory() {
        return this.conversationHistory;
    }

    /**
     * 设置对话历史（用于恢复会话）
     */
    setHistory(history) {
        this.conversationHistory = history;
    }

    /**
     * 构建消息内容（支持文本和图片）
     * @param {string|Array} content - 文本消息或 [{ type: 'text', text: '' }, { type: 'image_url', ... }]
     * @returns {string|Array} 构建后的消息内容
     */
    _buildMessageContent(content) {
        // 如果已经是数组格式，直接返回
        if (Array.isArray(content)) {
            return content;
        }
        // 如果是字符串，直接返回
        return content;
    }

    /**
     * 获取 Access Token
     * @private
     */
    async _getAccessToken() {
        const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
        if (Zotero && Zotero.VibeDBSync && Zotero.VibeDBSync.getAccessToken) {
            try {
                return await Zotero.VibeDBSync.getAccessToken();
            } catch (e) {
                console.error('[Bailian] 获取 Token 失败:', e);
            }
        }
        return null;
    }

    /**
     * 处理 401 未授权错误
     * @private
     */
    _handleUnauthorized() {
        console.log('[Bailian] Token 失效 (401)，触发重新登录流程');
        const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
        if (Zotero && Zotero.VibeDBSync) {
            if (Zotero.VibeDBSync.clearUser) Zotero.VibeDBSync.clearUser();
            if (Zotero.VibeDBSync.ensureLoggedIn) Zotero.VibeDBSync.ensureLoggedIn();
        }
    }

    /**
     * 调用百炼对话补全 API（流式 / 非流式）
     * @param {string} userMessage - 用户消息
     * @param {Object} options - 可选配置
     * @param {string} options.model - 模型名称
     * @param {boolean} options.stream - 是否流式输出，默认 false
     * @param {number} options.temperature - 采样温度 [0.0, 2.0]，默认 1.0
     * @param {number} options.top_p - 核采样参数 (0.0, 1.0]，默认 0.95
     * @param {number} options.max_tokens - 最大输出令牌数，默认 4096
     * @param {boolean} options.includeHistory - 是否包含历史对话，默认 true
     * @param {string} options.systemPrompt - 系统提示词
     * @returns {Promise<Object>} API 响应
     */
    async chat(userMessage, options = {}) {
        const {
            model = DEFAULT_MODEL,
            stream = false,
            temperature = 1.0,
            top_p = 0.95,
            max_tokens = 4096,
            includeHistory = true,
            systemPrompt = '你是一个有用的AI助手。'
        } = options;

        // 构建消息列表
        const messages = [];

        // 添加系统消息
        if (systemPrompt) {
            messages.push({
                role: 'system',
                content: systemPrompt
            });
        }

        // 添加历史对话（如果启用）
        if (includeHistory && this.conversationHistory.length > 0) {
            messages.push(...this.conversationHistory);
        }

        // 添加当前用户消息（支持多模态内容）
        messages.push({
            role: 'user',
            content: this._buildMessageContent(userMessage)
        });

        // 构建请求体
        const requestBody = {
            model,
            messages,
            temperature,
            top_p,
            max_tokens,
            stream
        };

        try {
            const proxyUrl = getBailianProxyUrl();
            const token = await this._getAccessToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            console.log('[Bailian] Request model:', {
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

            if (!response.ok) {
                if (response.status === 401) {
                    this._handleUnauthorized();
                }

                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    `百炼 API 请求失败: ${response.status} ${response.statusText}. ` +
                    `详情: ${JSON.stringify(errorData)}`
                );
            }

            const data = await response.json();

            // 提取 AI 回复
            const assistantMessage = data.choices?.[0]?.message?.content || '';

            // 将用户消息和 AI 回复添加到历史记录
            if (includeHistory) {
                this.addMessage('user', userMessage);
                this.addMessage('assistant', assistantMessage);
            }

            return {
                success: true,
                message: assistantMessage,
                rawResponse: data,
                usage: data.usage
            };

        } catch (error) {
            console.error('[Bailian] 对话请求失败:', error);
            if (error.statusCode === 401 || (error.message && error.message.includes('401'))) {
                this._handleUnauthorized();
            }
            return {
                success: false,
                error: error.message,
                message: `抱歉，百炼 AI 服务出现错误: ${error.message}`
            };
        }
    }

    /**
     * 流式对话（SSE）- 支持多模态内容
     * @param {string|Array} userMessage - 用户消息（字符串或多模态数组）
     * @param {Function} onChunk - 接收每个数据块的回调函数
     * @param {Object} options - 可选配置
     */
    async chatStream(userMessage, onChunk, options = {}) {
        const {
            model = DEFAULT_MODEL,
            temperature = 1.0,
            top_p = 0.95,
            max_tokens = 4096,
            includeHistory = true,
            systemPrompt = '你是一个有用的AI助手。'
        } = options;

        // 构建消息列表
        const messages = [];

        if (systemPrompt) {
            messages.push({
                role: 'system',
                content: systemPrompt
            });
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
            // 提取用户消息的文本部分用于日志（支持多模态）
            let messagePreview = '';
            let imageCount = 0;
            if (typeof userMessage === 'string') {
                messagePreview = userMessage.substring(0, 50) + '...';
                imageCount = 0;
            } else if (Array.isArray(userMessage)) {
                const textPart = userMessage.find(part => part.type === 'text');
                messagePreview = textPart ? textPart.text.substring(0, 50) + '...' : '[多模态消息]';
                imageCount = userMessage.filter(part => part.type === 'image_url').length;
            }

            // 【调试】打印完整的最后一条消息结构（用户消息）
            const lastMessage = messages[messages.length - 1];
            // console.log('[Huoshan] 最后一条消息结构:', {
            //     role: lastMessage.role,
            //     contentType: typeof lastMessage.content,
            //     isArray: Array.isArray(lastMessage.content),
            //     contentLength: Array.isArray(lastMessage.content) ? lastMessage.content.length : 'N/A'
            // });
            if (Array.isArray(lastMessage.content)) {
                console.log('[Bailian] 消息内容数组详情:', lastMessage.content.map((item, idx) => ({
                    index: idx,
                    type: item.type,
                    hasUrl: item.type === 'image_url' ? !!item.image_url?.url : 'N/A'
                })));
            }

            const proxyUrl = getBailianProxyUrl();
            const token = await this._getAccessToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const response = await fetch(proxyUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            console.log('[Bailian] 收到响应:', response.status, response.statusText);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[Bailian] API 错误响应:', errorData);

                // 提取友好的错误信息
                let friendlyMessage = '';

                // 优先使用 API 返回的结构化错误
                if (errorData.error) {
                    const errorCode = errorData.error.code;
                    const errorMessage = errorData.error.message;
                    const errorParam = errorData.error.param;

                    // 针对常见错误提供友好提示
                    if (errorCode === 'InvalidParameter' && errorParam === 'image_url') {
                        if (errorMessage.includes('do not support image input')) {
                            friendlyMessage = '当前模型不支持本次对话中的图片或多模态输入，请去掉图片后重试';
                        } else if (errorMessage.includes('downloading')) {
                            friendlyMessage = '图片无法访问（可能已过期），请重新上传图片';
                        } else {
                            friendlyMessage = `图片参数错误: ${errorMessage}`;
                        }
                    } else if (errorCode === 'InvalidAPIKey') {
                        friendlyMessage = 'API Key 无效，请检查配置';
                    } else if (errorCode === 'RateLimitExceeded') {
                        friendlyMessage = 'API 请求频率超限，请稍后重试';
                    } else {
                        friendlyMessage = errorMessage || `请求失败 (${errorCode})`;
                    }
                }
                // 根据 HTTP 状态码处理
                else if (response.status === 429) {
                    friendlyMessage = '服务器请求过于频繁，请稍后再试';
                } else if (response.status === 500) {
                    friendlyMessage = '服务器错误，请稍后重试';
                } else if (response.status === 502 || response.status === 503 || response.status === 504) {
                    friendlyMessage = '服务器维护中或暂时不可用，请稍后重试';
                } else if (response.status === 401) {
                    friendlyMessage = 'API 授权失败，请检查 API Key 配置';
                    this._handleUnauthorized();
                } else if (response.status === 403) {
                    friendlyMessage = '没有权限访问该资源';
                } else if (response.status === 400) {
                    friendlyMessage = '请求参数有误';
                } else {
                    friendlyMessage = `请求失败: ${response.status} ${response.statusText}`;
                }

                const error = new Error(friendlyMessage);
                error.rawError = errorData;
                error.statusCode = response.status;
                throw error;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullMessage = '';
            let lastChunkTime = Date.now();
            const TIMEOUT_MS = 30000; // 30秒超时
            let streamCompleted = false;

            try {
                while (true) {
                    // 检查超时
                    if (Date.now() - lastChunkTime > TIMEOUT_MS) {
                        console.warn('[Bailian] 流式输出超时（30秒无数据）');
                        throw new Error('流式输出超时，连接可能中断');
                    }

                    const { done, value } = await reader.read();

                    if (done) {
                        console.log('[Bailian] 流读取完成，streamCompleted:', streamCompleted);
                        // 流结束但没收到 [DONE]，可能是中断
                        if (!streamCompleted && fullMessage) {
                            console.warn('[Bailian] ⚠️ 流意外结束（未收到 [DONE]），可能中断');
                            // 仍然保存已有内容
                            if (includeHistory) {
                                this.addMessage('user', userMessage);
                                this.addMessage('assistant', fullMessage);
                            }
                            onChunk({
                                done: true,
                                fullMessage,
                                interrupted: true // 标记为中断
                            });
                        }
                        break;
                    }

                    lastChunkTime = Date.now(); // 更新最后接收时间
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);

                            if (data === '[DONE]') {
                                // 流式输出正常结束
                                console.log('[Bailian] ✓ 流式输出正常完成');
                                streamCompleted = true;
                                if (includeHistory) {
                                    this.addMessage('user', userMessage);
                                    this.addMessage('assistant', fullMessage);
                                }
                                onChunk({ done: true, fullMessage });
                                return {
                                    success: true,
                                    message: fullMessage
                                };
                            }

                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices?.[0]?.delta?.content || '';

                                // 检查是否有 finish_reason（可能提前结束）
                                const finishReason = parsed.choices?.[0]?.finish_reason;
                                if (finishReason) {
                                    console.log('[Bailian] finish_reason:', finishReason);
                                    if (finishReason === 'length') {
                                        console.warn('[Bailian] ⚠️ 输出因达到 max_tokens 限制而截断');
                                    } else if (finishReason === 'stop') {
                                        console.log('[Bailian] ✓ 正常结束');
                                        streamCompleted = true;
                                    }
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
                                console.warn('[Bailian] 解析 SSE 数据失败:', line, e);
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
                // 读取流时发生错误
                console.error('[Bailian] 读取流时出错:', readError);

                // 提供友好的错误提示
                let friendlyMessage = readError.message;
                if (readError.message.includes('超时')) {
                    friendlyMessage = '网络连接超时，请检查网络并重试';
                } else if (readError.message.includes('Failed to fetch')) {
                    friendlyMessage = '网络连接失败，请检查网络并重试';
                } else if (readError.message.includes('abort')) {
                    friendlyMessage = '请求被中断，请重试';
                }

                // 如果已经有部分内容，保存它
                if (fullMessage && includeHistory) {
                    this.addMessage('user', userMessage);
                    this.addMessage('assistant', fullMessage);
                }

                // 通知组件流已中断
                onChunk({
                    done: true,
                    fullMessage,
                    error: friendlyMessage,
                    interrupted: true
                });

                // 抛出友好的错误消息
                const error = new Error(friendlyMessage);
                error.originalError = readError;
                throw error;
            }

        } catch (error) {
            console.error('[Bailian] 流式对话请求失败:', error);
            // 抛出错误让 UI 层处理，而不是返回错误对象
            throw error;
        }
    }
}

const bailianService = new BailianService();

export default bailianService;
export { BailianService };
