/**
 * DeepSeek AI API 服务
 * 文档: https://api-docs.deepseek.com/zh-cn/
 */

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * DeepSeek AI 服务类
 */
class DeepSeekService {
    constructor(apiKey = '') {
        // 开源版：不再内置任何 API Key；预设模型需自建网关或改用「自定义模型」
        this.apiKey = apiKey;
        this.conversationHistory = []; // 存储对话历史
        this.paperContext = null; // 存储论文上下文内容
        this.hasPaperContextSet = false; // 标记是否已设置论文上下文
    }

    /**
     * 设置 API Key
     */
    setApiKey(apiKey) {
        this.apiKey = apiKey;
    }

    /**
     * 获取 API Key
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
     * 调用 DeepSeek AI 对话补全 API
     * @param {string} userMessage - 用户消息
     * @param {Object} options - 可选配置
     * @param {string} options.model - 模型名称，默认 deepseek
     * @param {boolean} options.stream - 是否流式输出，默认 false
     * @param {number} options.temperature - 采样温度 [0.0, 2.0]，默认 1.0
     * @param {number} options.top_p - 核采样参数 (0.0, 1.0]，默认 0.95
     * @param {number} options.max_tokens - 最大输出令牌数，默认 4096
     * @param {number} options.frequency_penalty - 频率惩罚 [-2.0, 2.0]，默认 0
     * @param {number} options.presence_penalty - 存在惩罚 [-2.0, 2.0]，默认 0
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
            frequency_penalty = 0,
            presence_penalty = 0,
            includeHistory = true,
            systemPrompt = '你是一个有用的AI助手。'
        } = options;

        if (!this.apiKey) {
            throw new Error('DeepSeek API Key 未设置。请先调用 setApiKey() 设置 API Key。');
        }

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

        // 添加当前用户消息
        messages.push({
            role: 'user',
            content: userMessage
        });

        // 构建请求体
        const requestBody = {
            model,
            messages,
            temperature,
            top_p,
            max_tokens,
            frequency_penalty,
            presence_penalty,
            stream
        };

        try {
            console.log('[DeepSeek] Request model:', {
                model: requestBody.model,
                url: `${DEEPSEEK_API_BASE_URL}/chat/completions`,
                stream: requestBody.stream,
                messageCount: requestBody.messages.length
            });

            const response = await fetch(`${DEEPSEEK_API_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    `DeepSeek API 请求失败: ${response.status} ${response.statusText}. ` +
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
            console.error('[DeepSeek] 对话请求失败:', error);
            return {
                success: false,
                error: error.message,
                message: `抱歉，DeepSeek AI 服务出现错误: ${error.message}`
            };
        }
    }

    /**
     * 流式对话（SSE）
     * @param {string} userMessage - 用户消息
     * @param {Function} onChunk - 接收每个数据块的回调函数
     * @param {Object} options - 可选配置
     */
    async chatStream(userMessage, onChunk, options = {}) {
        const {
            model = DEFAULT_MODEL,
            temperature = 1.0,
            top_p = 0.95,
            max_tokens = 4096,
            frequency_penalty = 0,
            presence_penalty = 0,
            includeHistory = true,
            systemPrompt = '你是一个有用的AI助手。'
        } = options;

        if (!this.apiKey) {
            throw new Error('DeepSeek API Key 未设置。请先调用 setApiKey() 设置 API Key。');
        }

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
            content: userMessage
        });

        const requestBody = {
            model,
            messages,
            temperature,
            top_p,
            max_tokens,
            frequency_penalty,
            presence_penalty,
            stream: true
        };

        try {
            const response = await fetch(`${DEEPSEEK_API_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    `DeepSeek API 请求失败: ${response.status} ${response.statusText}. ` +
                    `详情: ${JSON.stringify(errorData)}`
                );
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
                        console.warn('[DeepSeek] 流式输出超时（30秒无数据）');
                        throw new Error('流式输出超时，连接可能中断');
                    }

                    const { done, value } = await reader.read();

                    if (done) {
                        console.log('[DeepSeek] 流读取完成，streamCompleted:', streamCompleted);
                        // 流结束但没收到 [DONE]，可能是中断
                        if (!streamCompleted && fullMessage) {
                            console.warn('[DeepSeek] ⚠️ 流意外结束（未收到 finish_reason），可能中断');
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
                                console.log('[DeepSeek] ✓ 流式输出正常完成');
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
                                    console.log('[DeepSeek] finish_reason:', finishReason);
                                    if (finishReason === 'length') {
                                        console.warn('[DeepSeek] ⚠️ 输出因达到 max_tokens 限制而截断');
                                    } else if (finishReason === 'stop') {
                                        console.log('[DeepSeek] ✓ 正常结束');
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
                                console.warn('[DeepSeek] 解析 SSE 数据失败:', line, e);
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
                console.error('[DeepSeek] 读取流时出错:', readError);

                // 如果已经有部分内容，保存它
                if (fullMessage && includeHistory) {
                    this.addMessage('user', userMessage);
                    this.addMessage('assistant', fullMessage);
                }

                // 通知组件流已中断
                onChunk({
                    done: true,
                    fullMessage,
                    error: readError.message,
                    interrupted: true
                });

                throw readError; // 重新抛出错误，让外层 catch 处理
            }

        } catch (error) {
            console.error('[DeepSeek] 流式对话请求失败:', error);
            return {
                success: false,
                error: error.message,
                message: `抱歉，DeepSeek AI 服务出现错误: ${error.message}`
            };
        }
    }
}

// 导出单例实例
const deepSeekService = new DeepSeekService();

export default deepSeekService;
export { DeepSeekService };
