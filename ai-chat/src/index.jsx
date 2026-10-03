
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Bubble, Prompts } from '@ant-design/x';
import { Button, Flex, Input, message as antMessage, Space, Spin, Modal } from 'antd';
import { BulbOutlined, BookOutlined, DeleteOutlined, EditOutlined, LoadingOutlined, FontSizeOutlined } from '@ant-design/icons';
import loveMessageSvg from '../icons/love_message.svg';
import atIconSvg from '../icons/at.svg';
import viberoIconPng from '../icons/vibero.png';
import SlateInputWithSender from './SlateInputWithSender';
import zhipuAIService from './zhipuAIService';
import deepSeekService from './deepSeekService';
// import geminiService from './geminiService'; // Gemini 官方独立链路已暂停，统一走 OpenRouter
import huoshanService from './huoshanService';
import bailianService from './bailianService';
import openrouterChatService from './openrouterChatService';
import { getChatCreditsForBalanceCheck } from './chatModelPricing';
import {
    ADVANCED_PRESET_MODEL_KEYS,
    subscriptionAllowsAdvancedFromBalance,
} from './chatModelAccess';
import { presetSupportsVision } from './chatModelVision';
import customOpenAIService from './customOpenAIService';
import customAnthropicService from './customAnthropicService';
import { MULTIMODAL_UNSUPPORTED_CODE } from './multimodalApiError';
import {
    buildChatHardFailureBubbleContent,
    buildChatHardFailureToastContent,
} from './chatHardFailureContent';
import { getVibeRegion } from './chatRuntimeConfig';
import { formatCustomModelLabel, isZhLocale, zoteroL10n } from './zoteroL10n';
import MarkdownRenderer from './MarkdownRenderer';
import ChatImageLightbox from './ChatImageLightbox';
import './styles.css';

// 开源版：仅支持自定义模型（用户自行配置 API）。默认读取用户已保存的自定义模型选择
const defaultCustomModel = () => {
    try {
        const Zotero = window.parent?.Zotero || window.Zotero;
        const savedId = Zotero?.Prefs?.get('aiChat.customModelConfigId', true) || null;
        const saved = Zotero?.Prefs?.get('aiChat.customModelConfigs', true);
        const arr = saved ? JSON.parse(saved) : [];
        const cfg = (Array.isArray(arr) && (arr.find(c => c.id === savedId) || arr[0])) || null;
        if (cfg) {
            return {
                key: 'custom',
                label: formatCustomModelLabel(cfg.modelName || cfg.name),
                configId: cfg.id,
            };
        }
    } catch (_) { /* ignore */ }
    return { key: 'custom', label: zoteroL10n('vibe-ai-chat-custom-model-fallback') };
};

// 模型名称映射：菜单 key -> 上游模型名（百炼 OpenAI 兼容 / 火山 endpoint / Gemini）
// 百炼侧具体 model 以控制台为准；若报错可改此处或换自定义模型
const DEFAULT_MODEL_NAME_MAP = {
    chatgpt: 'openai/gpt-5.4-nano',
    grok: 'x-ai/grok-4.3',
    gemini: 'google/gemini-3.1-flash-lite-preview',
    kimi: 'kimi-k2.5',
    minimax: 'MiniMax-M2.5',
    qwen: 'qwen3.5-plus',
    doubao: 'ep-20260116143400-qz6rl',
    deepseek: 'deepseek-v4-flash',
    zhipu: 'glm-4.7',
    // 兼容旧版菜单 key（会话内状态）
    'qwen3.5-plus': 'qwen3.5-plus',
    'minimax-2.5': 'MiniMax-M2.5',
    'GLM-4.7': 'glm-4.7'
};

const OPENROUTER_MODEL_NAME_MAP = {
    chatgpt: 'openai/gpt-5.4-nano',
    grok: 'x-ai/grok-4.3',
    gemini: 'google/gemini-3.1-flash-lite-preview',
    kimi: 'moonshotai/kimi-k2.5',
    minimax: 'minimax/minimax-m2.5',
    qwen: 'qwen/qwen-plus',
    deepseek: 'deepseek/deepseek-v4-flash',
    zhipu: 'z-ai/glm-4.7',
    'qwen3.5-plus': 'qwen/qwen-plus',
    'minimax-2.5': 'minimax/minimax-m2.5',
    'GLM-4.7': 'z-ai/glm-4.7'
};

const VIBERO_AI_SYSTEM_PROMPT_CN = `你是 ForPaper 的 AI 助手，擅长帮助用户阅读和理解学术论文。请以简洁、专业的风格回答。

请使用与用户 user_prompt 相同的语言回答。

格式要求：
1. 所有输出使用 Markdown。
2. 数学公式必须使用美元符号包裹：行内公式用 $...$，块级公式用独立一段的 $$...$$。不要输出裸 LaTeX 命令。
3. 写出公式后，不要再用纯文本重复同一公式。
4. Markdown 标记必须是合法 CommonMark：例如使用 **加粗文本**，不要写成 **加粗文本 **。
5. 代码请使用带语言标记的 fenced code block，例如 \`\`\`python。`;

const VIBERO_AI_SYSTEM_PROMPT_GLOBAL = `You are ForPaper's AI assistant, specialized in helping users read and understand academic papers. Please answer in a concise and professional style.

Reply in the same language as the user's user_prompt.

Formatting requirements:
1. Use Markdown for all output.
2. Wrap math with dollar delimiters: inline math in $...$ and block math as its own paragraph with $$...$$. Do not output bare LaTeX commands.
3. After writing a formula, do not restate the same formula again in plain text.
4. Markdown syntax must be valid CommonMark, for example **bold text**, not **bold text **.
5. Use fenced code blocks with a language tag, like \`\`\`python.`;

// 开源版：预设模型路由（OpenRouter / 百炼 / 火山）已移除，仅保留自定义模型链路

/**
 * 解析当前文献 PDF 总页数（Zotero fulltextItems.totalPages），供对话阶梯计价
 * @param {string|null|undefined} itemIDStr iframe data-item-id（多为 PDF 附件 id，或顶层条目 id）
 */
async function resolvePdfPageCountForChat(itemIDStr) {
    if (!itemIDStr) return null;
    const Z = window.parent?.Zotero;
    if (!Z?.Items?.getAsync || !Z.Fulltext?.getPages) return null;
    const id = parseInt(String(itemIDStr), 10);
    if (!Number.isFinite(id)) return null;
    try {
        const item = await Z.Items.getAsync(id);
        if (!item) return null;
        let attachId = id;
        if (!item.isPDFAttachment()) {
            if (typeof item.getAttachments !== 'function') return null;
            const ids = item.getAttachments();
            let found = null;
            for (const aid of ids) {
                const att = Z.Items.get(aid);
                if (att?.isPDFAttachment?.()) {
                    found = aid;
                    break;
                }
            }
            if (found == null) return null;
            attachId = found;
        }
        const row = await Z.Fulltext.getPages(attachId);
        const total = row?.total != null ? parseInt(row.total, 10) : null;
        if (Number.isFinite(total) && total > 0) return total;
        return null;
    } catch (e) {
        console.warn('[AIChat] resolvePdfPageCountForChat:', e);
        return null;
    }
}

function getExtraPaperContextCostByPages(pageCount) {
    const n = Number.isFinite(Number(pageCount)) ? Math.max(0, Math.floor(Number(pageCount))) : 0;
    if (n > 0 && n < 20) {
        return 1;
    }
    const tiers = Math.max(1, Math.ceil(n / 50));
    return tiers * 2;
}

function buildExtraPaperShortName(title) {
    const raw = String(title || '').replace(/\s+/g, '').trim();
    if (!raw) return 'paper';
    if (raw.length <= 10) return raw;
    return `${raw.slice(0, 10)}...`;
}

function buildMultiPaperContext(mainPaperContext, extraPaperContexts = []) {
    const blocks = [];
    if (mainPaperContext?.content) {
        blocks.push(
            `[当前正在阅读的论文开始]\n` +
            `标题: ${mainPaperContext.title || (isZhLocale() ? '无标题' : 'Untitled')}\n` +
            `${mainPaperContext.content}\n` +
            `[当前正在阅读的论文结束]`
        );
    }
    extraPaperContexts.forEach((ctx, idx) => {
        if (!ctx?.content) return;
        blocks.push(
            `[用户额外引用的论文 ${idx + 1} 开始]\n` +
            `标题: ${ctx.title || `Paper ${idx + 1}`}\n` +
            `${ctx.content}\n` +
            `[用户额外引用的论文 ${idx + 1} 结束]`
        );
    });
    return blocks.join('\n\n');
}

// Vibero Logo
const viberoLogo = (
    <img src={viberoIconPng} width="40" height="40" alt="ForPaper Logo" />
);

// 定义 roles 配置
const roles = {
    assistant: {
        placement: 'start',
        variant: 'borderless',
        header: 'AI',
        loadingRender: () => (
            <Space>
                <Spin indicator={<LoadingOutlined style={{ fontSize: 20, color: 'var(--fill-primary)' }} spin />} size="small" />
            </Space>
        ),
    },
    user: {
        placement: 'end',
        variant: 'borderless',
        header: 'You',
    },
};

// 欢迎消息提示项配置（静态数据）
const welcomePromptItems = [
    {
        key: '1',
        icon: <BookOutlined style={{ color: '#1890FF' }} />,
        label: isZhLocale() ? 'Canvas ⬅️ 对话' : 'Canvas ⬅️ Chat',
        description: isZhLocale()
            ? '将 AI 对话拖到画布，生成问答闪卡。'
            : 'Drag AI chats to the canvas to generate Q&A flashcards.',
    },
    {
        key: '2',
        icon: <BulbOutlined style={{ color: '#FFD700' }} />,
        label: isZhLocale() ? 'Canvas ➡️ 对话' : 'Canvas ➡️ Chat',
        description: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                {isZhLocale() ? (
                    <>
                        <span style={{ fontWeight: 600, color: '#262626' }}>三种带上下文提问的方式：</span>
                        <span>1️⃣ <span style={{ fontWeight: 600 }}>Cmd/Ctrl + 点击</span>任意段落</span>
                        <span>2️⃣ <span style={{ fontWeight: 600 }}>拖动</span>总结卡片到这里</span>
                        <span>3️⃣ <span style={{ fontWeight: 600 }}>粘贴</span>截图</span>
                    </>
                ) : (
                    <>
                        <span style={{ fontWeight: 600, color: '#262626' }}>3 ways to chat with context:</span>
                        <span>1️⃣ <span style={{ fontWeight: 600 }}>Cmd/Ctrl + Click</span> any paragraph</span>
                        <span>2️⃣ <span style={{ fontWeight: 600 }}>Drag</span> Summary Card here</span>
                        <span>3️⃣ <span style={{ fontWeight: 600 }}>Paste</span> Screenshot</span>
                    </>
                )}
            </div>
        ),
    }
];

function AIChatApp() {
    const vibeRegion = useMemo(() => getVibeRegion(), []);
    const openRouterOnlyRegion = vibeRegion === 'global';
    const viberoSystemPrompt = useMemo(
        () => (openRouterOnlyRegion ? VIBERO_AI_SYSTEM_PROMPT_GLOBAL : VIBERO_AI_SYSTEM_PROMPT_CN),
        [openRouterOnlyRegion]
    );

    // 消息状态（不包含欢迎消息）
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [welcomeActionText, setWelcomeActionText] = useState('🤫 Sometimes AI has a surprise note for you. Take a peek!');
    const [loveActive, setLoveActive] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const [draggedVibeCardId, setDraggedVibeCardId] = useState(null);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null); // 消息列表滚动容器，用于判断是否接近底部
    const insertVibeCardRef = useRef(null);
    const mouseDownTargetRef = useRef(null);
    const [selectedConversations, setSelectedConversations] = useState(new Set());
    const [editingConversationId, setEditingConversationId] = useState(null);
    const [editingText, setEditingText] = useState('');

    // 字体大小调整状态
    const [fontScale, setFontScale] = useState(() => {
        // 从 Zotero Prefs 读取保存的字体大小
        try {
            const Zotero = window.parent?.Zotero || window.Zotero;
            if (Zotero && Zotero.Prefs) {
                const saved = Zotero.Prefs.get('aiChat.fontScale', true);
                if (saved !== undefined && saved !== null) {
                    // // console.log('[AIChat] 从 Prefs 读取字体大小:', saved);
                    return parseFloat(saved);
                }
            }
        } catch (e) {
            console.warn('[AIChat] Failed to read font scale from Prefs:', e);
        }
        return 1.0;
    });
    const [showFontSlider, setShowFontSlider] = useState(false);

    // API Key 配置
    const [apiKey, setApiKey] = useState('');
    // 开源版：默认使用自定义模型（读取用户已保存的配置）
    const [selectedModel, setSelectedModel] = useState(defaultCustomModel);
    /** 高级预设模型需 PRO / ULTIMATE 活跃订阅 */
    const [canUseAdvancedModels, setCanUseAdvancedModels] = useState(true); // 开源版：无订阅门槛
    /** 避免余额接口返回前误判无权限、把 PRO 用户从 Gemini 误切走 */
    const [subscriptionAccessResolved, setSubscriptionAccessResolved] = useState(false);
    /** 当前文献 PDF 总页数（未知则为 null，计价按首档基准） */
    const [pdfPageCount, setPdfPageCount] = useState(null);
    const [extraContextPapers, setExtraContextPapers] = useState([]);
    const [deepSeekApiKey, setDeepSeekApiKey] = useState('');

    // 获取自定义模型配置（支持多配置，按 configId 读取）
    const getCustomModelConfig = useCallback((configId) => {
        try {
            const Zotero = window.parent?.Zotero || window.Zotero;
            if (Zotero && Zotero.Prefs) {
                const saved = Zotero.Prefs.get('aiChat.customModelConfigs', true);
                if (saved) {
                    const arr = JSON.parse(saved);
                    if (Array.isArray(arr) && configId) {
                        return arr.find(c => c.id === configId) || null;
                    }
                    // 兼容旧版单配置
                    const old = Zotero.Prefs.get('aiChat.customModelConfig', true);
                    if (old) return JSON.parse(old);
                }
            }
        } catch (e) {
            console.warn('[AIChat] Failed to get custom model config:', e);
        }
        return null;
    }, []);

    const visionCapable = useMemo(
        () => presetSupportsVision(selectedModel.key),
        [selectedModel.key]
    );

    const displayModel = useMemo(() => {
        if (selectedModel.key === 'custom') {
            const configId = selectedModel.configId;
            const config = getCustomModelConfig(configId);
            if (config) {
                return {
                    key: 'custom',
                    label: formatCustomModelLabel(config.name || config.modelName),
                    configId,
                    config
                };
            }
        }
        return selectedModel;
    }, [selectedModel, getCustomModelConfig]);

    // 旧版本可能残留预设模型选择（如 gemini/doubao），统一迁移到自定义模型
    useEffect(() => {
        if (selectedModel.key !== 'custom') {
            setSelectedModel(defaultCustomModel());
        }
    }, [selectedModel.key]);

    // 获取当前论文的 itemID
    const getItemID = useCallback(() => {
        return window.frameElement?.getAttribute('data-item-id');
    }, []);

    const refreshPdfPageCount = useCallback(async () => {
        const n = await resolvePdfPageCountForChat(getItemID());
        if (typeof n === 'number' && n > 0) {
            setPdfPageCount(n);
        }
    }, [getItemID]);

    useEffect(() => {
        refreshPdfPageCount();
    }, [refreshPdfPageCount]);

    useEffect(() => {
        const onFocus = () => {
            refreshPdfPageCount();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refreshPdfPageCount]);

    const requestExtraPaperCandidates = useCallback(async () => {
        const itemID = getItemID();
        const Z = window.parent?.Zotero || window.Zotero;
        if (!itemID || !Z?.AIChatContext?.listCandidatePapers) {
            return [];
        }
        const rows = await Z.AIChatContext.listCandidatePapers(parseInt(itemID, 10));
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows.map((row) => ({
            ...row,
            extraContextCost: getExtraPaperContextCostByPages(row.pageCount),
        }));
    }, [getItemID]);

    const extraContextCost = useMemo(
        () => extraContextPapers.reduce((sum, p) => sum + getExtraPaperContextCostByPages(p.pageCount), 0),
        [extraContextPapers]
    );

    const buildServiceHistoryFromMessages = useCallback((sourceMessages) => {
        return sourceMessages
            .filter(msg => (msg.role === 'user' || msg.role === 'assistant') && !msg.isError)
            .map(msg => {
                if (msg.images && msg.images.length > 0) {
                    const messageContent = [
                        { type: 'text', text: msg.content }
                    ];
                    msg.images.forEach(img => {
                        const imageUrl = img.r2Url || img.base64;
                        messageContent.push({
                            type: 'image_url',
                            image_url: { url: imageUrl }
                        });
                    });
                    return {
                        role: msg.role,
                        content: messageContent
                    };
                }

                return {
                    role: msg.role,
                    content: msg.content
                };
            });
    }, []);

    const syncServiceHistoryFromMessages = useCallback((sourceMessages) => {
        const serviceHistory = buildServiceHistoryFromMessages(sourceMessages);
        huoshanService.setHistory(serviceHistory);
        bailianService.setHistory(serviceHistory);
        openrouterChatService.setHistory(serviceHistory);
        customOpenAIService.setHistory(serviceHistory);
        customAnthropicService.setHistory(serviceHistory);
    }, [buildServiceHistoryFromMessages]);

    // 保存消息到数据库（只保存非欢迎消息）
    const saveMessagesToDB = useCallback(async (messagesToSave) => {
        const itemID = getItemID();
        if (!itemID) {
            console.warn('[AIChat] Unable to save: itemID not found');
            return;
        }

        try {
            // 过滤掉欢迎消息，只保存实际对话
            const filteredMessages = messagesToSave.filter(msg => !msg.isWelcome);

            // 序列化消息（移除 React 组件，只保留可序列化数据）
            const serializableMessages = filteredMessages.map(msg => ({
                id: msg.id,
                role: msg.role,
                content: typeof msg.content === 'string' ? msg.content : '[React Component]',
                vibeCardRefs: msg.vibeCardRefs || [],
                extraPaperRefs: msg.extraPaperRefs || [],
                images: msg.images?.map(img => ({
                    // 保存完整的图片信息
                    name: img.name,
                    type: img.type,
                    r2Url: img.r2Url,       // R2 公开 URL
                    r2Key: img.r2Key,       // R2 文件 key
                    base64: img.base64      // Base64（用于本地显示）
                })) || [],
                timestamp: msg.timestamp || Date.now()
            }));

            await window.parent.Zotero.VibeDB.AIChats.save(parseInt(itemID), serializableMessages);
            // console.log(`[AIChat] ✓ 已保存 ${serializableMessages.length} 条消息到数据库`);
        } catch (error) {
            console.error('[AIChat] Failed to save messages:', error);
        }
    }, [getItemID]);

    const persistMessages = useCallback(async (messagesToPersist) => {
        await saveMessagesToDB(messagesToPersist);
        syncServiceHistoryFromMessages(messagesToPersist);
    }, [saveMessagesToDB, syncServiceHistoryFromMessages]);

    // 从数据库加载历史消息（仅在组件初始化时调用一次）
    const loadHistoryFromDB = useCallback(async () => {
        const itemID = getItemID();
        if (!itemID) {
            // // console.log('[AIChat] 未找到 itemID，跳过加载历史');
            setHistoryLoaded(true);
            return;
        }

        try {
            const result = await window.parent.Zotero.VibeDB.AIChats.get(parseInt(itemID));
            if (result && result.messages && Array.isArray(result.messages)) {
                // console.log(`[AIChat] ✓ 从数据库加载 ${result.messages.length} 条历史消息`);
                setMessages(result.messages);

                syncServiceHistoryFromMessages(result.messages);
            } else {
                // // console.log('[AIChat] 数据库中无历史消息');
            }
        } catch (error) {
            console.error('[AIChat] Failed to load chat history:', error);
        } finally {
            setHistoryLoaded(true);
        }
    }, [getItemID, syncServiceHistoryFromMessages]); // 移除 selectedModel.key 依赖，避免模型切换时重新加载历史

    // 初始化时加载历史消息（仅执行一次）
    useEffect(() => {
        try {
            // API Key 已迁移到 Cloudflare Worker，不再需要在客户端设置
            // // console.log('[AIChat] ✓ 使用 Cloudflare Worker 代理（API Key 已隐藏）');
        } catch (error) {
            console.warn('[AIChat] Error during initialization:', error);
        }

        // 加载历史消息
        loadHistoryFromDB();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // 空依赖数组，确保只在组件挂载时执行一次

    // 应用字体大小到 CSS 变量
    useEffect(() => {
        const scaleValue = fontScale.toString();
        document.documentElement.style.setProperty('--panel-font-scale', scaleValue);

        // 调试日志：检查各个元素的实际字体大小
        setTimeout(() => {
            const container = document.querySelector('.ai-chat-container');
            const bubble = document.querySelector('.ant-bubble-content');
            const header = document.querySelector('.ai-chat-header h3');

            // // console.log('[AIChat] 字体缩放已设置:', {
            //     scale: fontScale,
            //     cssValue: scaleValue,
            //     computed: getComputedStyle(document.documentElement).getPropertyValue('--panel-font-scale'),
            //     containerFontSize: container ? getComputedStyle(container).fontSize : 'N/A',
            //     headerFontSize: header ? getComputedStyle(header).fontSize : 'N/A',
            //     bubbleFontSize: bubble ? getComputedStyle(bubble).fontSize : 'N/A'
            // });
        }, 100);
    }, [fontScale]);

    const refreshSubscriptionAccess = useCallback(async () => {
        try {
            const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
            const balance = await Zotero?.VibeDBSync?.getUserBalance?.();
            setCanUseAdvancedModels(true); // 开源版：无订阅门槛，恒可用
        } catch (e) {
            console.warn('[AIChat] Failed to refresh subscription tier:', e);
            setCanUseAdvancedModels(false);
        } finally {
            setSubscriptionAccessResolved(true);
        }
    }, []);

    useEffect(() => {
        refreshSubscriptionAccess();
        const onFocus = () => {
            refreshSubscriptionAccess();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refreshSubscriptionAccess]);

    // 开源版：无订阅门槛，无需自动切换高级预设

    // 已移除 Claude 预设：旧会话若仍存 claude，迁到 ChatGPT
    useEffect(() => {
        if (selectedModel.key === 'claude') {
            setSelectedModel({
                key: 'chatgpt',
                label: zoteroL10n('vibe-ai-chat-model-chatgpt'),
            });
        }
    }, [selectedModel.key]);

    // 处理字体大小变化（用户手动调整滑块）
    const handleFontScaleChange = (value) => {
        // console.log('[AIChat] User changed font scale:', value);
        setFontScale(value);

        // 保存到 Zotero Prefs（使用 Char 类型）
        try {
            const Zotero = window.parent?.Zotero || window.Zotero;
            if (Zotero && Zotero.Prefs) {
                Zotero.Prefs.set('aiChat.fontScale', String(value), true);
                // console.log('[AIChat] Font scale saved to Prefs:', value);
            }
        } catch (e) {
            console.error('[AIChat] Failed to save font scale to Prefs:', e);
        }
    };

    // 获取 VibeCard 内容
    const getVibeCardContent = async (vibeCardId) => {
        // console.log(`[VibeCard] 开始获取内容: ${vibeCardId}`);
        try {
            if (window.parent && window.parent.Zotero && window.parent.Zotero.VibeCard) {
                const itemID = getItemID();
                if (itemID) {
                    // console.log(`[VibeCard] 使用 itemID: ${itemID} 调用 Zotero.VibeCard.getContent(${vibeCardId})`);
                    const content = await window.parent.Zotero.VibeCard.getContent(vibeCardId, parseInt(itemID));
                    // console.log(`[VibeCard] 获取到内容 (长度: ${content?.length || 0})`);
                    return content || `[VibeCard ${vibeCardId} content]`;
                } else {
                    const content = await window.parent.Zotero.VibeCard.getContent(vibeCardId);
                    return content || `[VibeCard ${vibeCardId} content]`;
                }
            }
            return `[VibeCard ${vibeCardId} content]`;
        } catch (error) {
            console.error(`[VibeCard] Failed to get content for ${vibeCardId}:`, error);
            return `[VibeCard ${vibeCardId}]`;
        }
    };

    // 渲染用户消息内容（支持 VibeCard chip 和图片）
    const renderUserMessageContent = (content, vibeCardRefs = [], images = [], extraPaperRefs = []) => {
        const parts = [];

        // 先渲染图片
        if (images && images.length > 0) {
            parts.push(
                <div
                    key="images"
                    style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: content ? 8 : 0
                    }}
                >
                    {images.map((img, idx) => (
                        <ChatImageLightbox
                            key={`img-${idx}`}
                            thumbnail
                            src={img.r2Url || img.base64}
                            alt={img.name || 'image'}
                        />
                    ))}
                </div>
            );
        }

        // 如果没有 VibeCard 引用，直接返回文本
        if ((!vibeCardRefs || vibeCardRefs.length === 0) && (!extraPaperRefs || extraPaperRefs.length === 0)) {
            if (content) parts.push(content);
            return parts.length > 0 ? <>{parts}</> : content;
        }

        // 处理 VibeCard 引用
        const textParts = [];
        let lastIndex = 0;
        const nameToRefMap = {};
        vibeCardRefs.forEach(ref => {
            nameToRefMap[ref.name || ref.id] = ref;
        });
        extraPaperRefs.forEach(ref => {
            nameToRefMap[ref.shortName || ref.name || ref.itemID] = {
                ...ref,
                __paper: true
            };
        });

        const regex = /@([^\s@]+)/g;
        let match;

        while ((match = regex.exec(content)) !== null) {
            const matchedName = match[1];
            const vibeCardRef = nameToRefMap[matchedName];

            if (vibeCardRef) {
                if (match.index > lastIndex) {
                    textParts.push(content.substring(lastIndex, match.index));
                }
                textParts.push(
                    <span
                        key={`chip-${vibeCardRef.id || vibeCardRef.itemID}-${match.index}`}
                        style={{
                            display: 'inline-block',
                            padding: '2px 6px',
                            margin: '0 2px',
                            borderRadius: '12px',
                            backgroundColor: 'var(--material-sidepane, #f5f5f5)',
                            border: '1px solid var(--fill-quinary, #e5e5e5)',
                            color: 'var(--fill-primary, #262626)',
                            fontSize: '0.9em',
                            fontWeight: '500',
                        }}
                    >
                        @{vibeCardRef.__paper
                            ? (vibeCardRef.shortName || vibeCardRef.name || vibeCardRef.itemID)
                            : (vibeCardRef.name || vibeCardRef.id)}
                    </span>
                );
                lastIndex = regex.lastIndex;
            }
        }

        if (lastIndex < content.length) {
            textParts.push(content.substring(lastIndex));
        }

        // 合并图片和文本部分
        if (textParts.length > 0) {
            parts.push(<span key="text">{textParts}</span>);
        }

        return <>{parts}</>;
    };

    // 自动滚动到底部：仅当用户未手动滚动到上方时（靠近底部）才滚动，避免流式输出时强制跟随导致无法查看上方内容
    const SCROLL_NEAR_BOTTOM_THRESHOLD = 150;
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container || !messagesEndRef.current) return;
        const { scrollHeight, scrollTop, clientHeight } = container;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        const isNearBottom = distanceToBottom <= SCROLL_NEAR_BOTTOM_THRESHOLD;
        if (isNearBottom) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    // 发送消息处理
    const handleSend = async (text, vibeCardRefs = [], images = [], selectedExtraPapers = []) => {
        // 立刻设置 loading 状态，让 UI 立刻响应
        setLoading(true);

        // 多模态：纯文本预设（MiniMax / GLM / DeepSeek）禁止当前条或历史含图
        if (!presetSupportsVision(selectedModel.key)) {
            const hasImageInCurrentMessage = images && images.length > 0;
            const hasImageInHistory = messages.some(msg => msg.images && msg.images.length > 0);
            if (hasImageInCurrentMessage || hasImageInHistory) {
                antMessage.error({
                    content: zoteroL10n('vibe-ai-chat-multimodal-not-supported', { model: selectedModel.label }),
                    duration: 5,
                    style: { marginTop: '20vh' },
                });
                setLoading(false);
                return false;
            }
        }

        // 开源版：无订阅门槛，高级预设直接可用（需自建网关，见 chatModelAccess.js）

        const normalizedExtraPapers = (Array.isArray(selectedExtraPapers) ? selectedExtraPapers : [])
            .filter((p) => p && Number.isFinite(parseInt(p.itemID, 10)))
            .map((p) => ({
                ...p,
                itemID: parseInt(p.itemID, 10)
            }));
        const extraCost = normalizedExtraPapers.reduce(
            (sum, p) => sum + getExtraPaperContextCostByPages(p.pageCount),
            0
        );

        // 余额检查：仅对非 custom model。getUserBalance 内会先 subscription-check-reset，credits = 订阅(quota+carryover−used)+礼品卡等（RPC）
        if (selectedModel.key !== 'custom') {
            try {
                const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
                if (Zotero && Zotero.VibeDBSync) {
                    const balance = await Zotero.VibeDBSync.getUserBalance();
                    const baseChatCost =
                        getChatCreditsForBalanceCheck(selectedModel.key, pagesForBilling) ??
                        Zotero.VibeDBSync.PRICING?.CHAT ??
                        1;
                    const chatCost = baseChatCost + extraCost;
                    if (!balance || balance.credits === null || balance.credits === undefined) {
                        antMessage.error(zoteroL10n('vibe-ai-chat-balance-fetch-failed'));
                        setLoading(false);
                        return false;
                    }

                    if (balance.credits < chatCost) {
                        antMessage.error(
                            zoteroL10n('vibe-ai-chat-credits-insufficient', {
                                required: chatCost,
                                remaining: balance.credits,
                            })
                        );
                        setLoading(false);
                        return false;
                    }
                }
            } catch (e) {
                console.error('[AIChat] Balance check failed:', e);
                antMessage.error(zoteroL10n('vibe-ai-chat-balance-check-failed'));
                setLoading(false);
                return false;
            }
        }

        // 获取当前论文的 Markdown 内容（先检查，不立即添加消息）
        let currentService;

        if (selectedModel.key === 'custom') {
            try {
                const configId = selectedModel.configId || (() => {
                    try {
                        return (window.Zotero || window.parent?.Zotero)?.Prefs?.get('aiChat.customModelConfigId', true) || null;
                    } catch (_) { return null; }
                })();
                const config = getCustomModelConfig(configId);
                if (!config || !config.baseUrl || !config.apiKey || !config.modelName) {
                    antMessage.error(zoteroL10n('vibe-ai-chat-prompt-configure-custom-first'));
                    setLoading(false);
                    return false;
                }
                const apiFormat = config.apiFormat || 'openai';
                const customCfg = {
                    baseUrl: config.baseUrl,
                    apiKey: config.apiKey,
                    model: config.modelName
                };
                if (apiFormat === 'anthropic') {
                    customAnthropicService.setConfig(customCfg);
                    currentService = customAnthropicService;
                } else {
                    customOpenAIService.setConfig(customCfg);
                    currentService = customOpenAIService;
                }
            } catch (e) {
                console.error('Failed to load custom config', e);
                antMessage.error(zoteroL10n('vibe-ai-chat-custom-config-load-failed'));
                setLoading(false);
                return false;
            }
        } else {
            // 开源版：仅支持自定义模型。非 custom 选择会被上方迁移逻辑拦截，
            // 理论上不会走到这里；兜底提示用户先去配置自定义模型
            antMessage.error(zoteroL10n('vibe-ai-chat-prompt-configure-custom-first'));
            setLoading(false);
            return false;
        }
        // 每次发送前重建上下文：主论文 + 附加论文
        // 修复：handleSend 内 itemID 未声明（ReferenceError 导致发送卡死、全局 loading 锁死）
        const itemID = getItemID();
        if (itemID) {
            try {
                const Z = window.parent?.Zotero || window.Zotero;
                const contextAPI = Z?.AIChatContext;
                let mainPaperContext = null;
                if (contextAPI?.getContextByItemID) {
                    mainPaperContext = await contextAPI.getContextByItemID(parseInt(itemID, 10));
                }
                if (!mainPaperContext?.content) {
                    // 兼容旧链路
                    let paperMarkdown = await window.parent?.Zotero?.VibeCard?.getMarkdownContent?.(parseInt(itemID, 10));
                    const mdTrimmed = typeof paperMarkdown === 'string' ? paperMarkdown.trim() : '';
                    if (!mdTrimmed && window.parent?.Zotero?.VibeCard?.getPlainTextForAIChat) {
                        const plain = await window.parent.Zotero.VibeCard.getPlainTextForAIChat(parseInt(itemID, 10));
                        if (plain && String(plain).trim()) {
                            paperMarkdown = String(plain).trim();
                        }
                    }
                    const finalContext = typeof paperMarkdown === 'string' ? paperMarkdown.trim() : '';
                    if (finalContext) {
                        mainPaperContext = {
                            itemID: parseInt(itemID, 10),
                            title: '',
                            content: finalContext
                        };
                    }
                }

                if (!mainPaperContext?.content) {
                    Modal.confirm({
                        title: null,
                        content: zoteroL10n('vibe-ai-chat-parse-paper-first'),
                        okText: zoteroL10n('vibe-ai-chat-confirm'),
                        cancelButtonProps: { style: { display: 'none' } },
                        centered: true,
                        width: 200,
                        bodyStyle: { textAlign: 'center' },
                        okButtonProps: {
                            style: {
                                backgroundColor: '#262626',
                                borderColor: '#262626',
                                color: '#ffffff',
                                fontWeight: 500,
                                height: '28px',
                                borderRadius: '6px',
                                fontSize: '13px'
                            }
                        },
                        modalRenderToBody: true,
                        style: { borderRadius: '8px' },
                        wrapClassName: 'ai-chat-modal'
                    });
                    setLoading(false);
                    return false;
                }

                const extraPaperContexts = [];
                const missingTitles = [];
                if (normalizedExtraPapers.length > 0 && !contextAPI?.getContextByItemID) {
                    antMessage.error(zoteroL10n('vibe-ai-chat-extra-paper-load-failed'));
                    setLoading(false);
                    return false;
                }
                if (normalizedExtraPapers.length > 0 && contextAPI?.getContextByItemID) {
                    const ctxRows = await Promise.all(
                        normalizedExtraPapers.map(async (paper) => ({
                            paper,
                            ctx: await contextAPI.getContextByItemID(paper.itemID)
                        }))
                    );
                    ctxRows.forEach(({ paper, ctx }) => {
                        if (ctx?.content) {
                            extraPaperContexts.push({
                                ...ctx,
                                title: ctx.title || paper.title || ''
                            });
                        } else {
                            missingTitles.push(paper.title || String(paper.itemID));
                        }
                    });
                }

                if (missingTitles.length > 0) {
                    antMessage.error(
                        zoteroL10n('vibe-ai-chat-extra-paper-context-missing', {
                            titles: missingTitles.slice(0, 5).join('，')
                        })
                    );
                    setLoading(false);
                    return false;
                }

                const serviceHistory = buildServiceHistoryFromMessages(messages);
                const contextMessage = {
                    role: 'system',
                    content: buildMultiPaperContext(mainPaperContext, extraPaperContexts)
                };
                currentService.setHistory([contextMessage, ...serviceHistory]);
            } catch (error) {
                console.error('[AIChat] Failed to build paper context:', error);
                antMessage.error(zoteroL10n('vibe-ai-chat-send-failed', { error: error?.message || '' }));
                setLoading(false);
                return false;
            }
        }

        // 论文上下文已准备好，现在添加用户消息
        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: text,
            vibeCardRefs: vibeCardRefs,
            extraPaperRefs: normalizedExtraPapers.map((paper) => ({
                itemID: paper.itemID,
                name: paper.title,
                shortName: buildExtraPaperShortName(paper.title),
                pageCount: paper.pageCount || 0
            })),
            images: images, // 添加图片数据
            timestamp: Date.now()
        };

        // 替换 VibeCard 引用为实际内容
        let processedText = text;
        if (vibeCardRefs && vibeCardRefs.length > 0) {
            for (const vibeCardRef of vibeCardRefs) {
                const content = await getVibeCardContent(vibeCardRef.id);
                const regex = new RegExp(`@${vibeCardRef.name}`, 'g');
                processedText = processedText.replace(regex, `\n[引用内容开始]\n${content}\n[引用内容结束]\n`);
            }
        }

        // 构建消息内容：支持文本和图片的多模态格式
        let messageContent = processedText;
        if (images && images.length > 0) {
            // 构建多模态消息：文本 + 图片（使用 R2 公开 URL）
            messageContent = [
                { type: 'text', text: processedText }
            ];
            // 添加图片到消息内容（优先使用 R2 URL）
            images.forEach((img, idx) => {
                const imageUrl = img.r2Url || img.base64; // 优先使用 R2 URL，降级到 Base64
                messageContent.push({
                    type: 'image_url',
                    image_url: {
                        url: imageUrl
                    }
                });
            });
        }

        // 创建 AI 消息占位符
        const aiMessageId = Date.now() + 1;
        const aiMessage = {
            id: aiMessageId,
            role: 'assistant',
            content: '',
            typing: true,
            timestamp: Date.now()
        };

        // 合并更新消息状态（使用函数式更新，确保基于最新状态）
        // 同时也避免了中间状态（只有 user message 没有 AI placeholder）的渲染
        setMessages(prev => [...prev, userMessage, aiMessage]);

        // 注意：这里去掉了 setLoading(true) 因为在函数开始时已经设置了

        // 请求硬失败（catch 或流式 onChunk 带 error）时统一：短暂展示后移除本轮用户+助手，与 OpenRouter 抛错路径一致
        const FAIL_ROUND_UI_MS = 3000;
        const scheduleRemoveFailedChatRound = (userMsgId, asstMsgId) => {
            setTimeout(() => {
                setMessages(prev =>
                    prev.filter(m => m.id !== asstMsgId && m.id !== userMsgId)
                );
            }, FAIL_ROUND_UI_MS);
        };

        const performChat = async () => {
            try {
                // 使用当前选择的 AI 服务（流式输出）
                // 如果有图片，发送多模态内容；否则发送纯文本
                const resolvedModel = (
                    openRouterOnlyRegion
                        ? OPENROUTER_MODEL_NAME_MAP[selectedModel.key]
                        : DEFAULT_MODEL_NAME_MAP[selectedModel.key]
                ) || selectedModel.key;
                // console.log('[AIChat] Sending chat request:', { selectedModelKey: selectedModel.key, selectedModelLabel: selectedModel.label, openRouterOnlyRegion, service: currentService?.constructor?.name || 'unknown', resolvedModel });

                await currentService.chatStream(
                    messageContent,
                    ({ done, content, fullMessage, interrupted, error, errorCode }) => {
                        if (!done && content) {
                            // 流式更新消息内容
                            setMessages(prev => prev.map(msg =>
                                msg.id === aiMessageId
                                    ? { ...msg, content: fullMessage, typing: true }
                                    : msg
                            ));
                        } else if (done) {
                            // 流式输出完成
                            let finalContent = fullMessage;
                            const isMmRejected =
                                interrupted && errorCode === MULTIMODAL_UNSUPPORTED_CODE;
                            // Gemini 等：在流内通过 error 结束而非 throw，须与 catch 同一套「不入库 + 延时移除」
                            const streamFailedHard =
                                interrupted && !!error && !isMmRejected;

                            if (interrupted) {
                                if (isMmRejected) {
                                    finalContent = zoteroL10n('vibe-ai-chat-multimodal-not-supported', {
                                        model: selectedModel.label,
                                    });
                                } else if (streamFailedHard) {
                                    // 与 catch 共用文案，禁止拼在 fullMessage 后（否则会出现 --- 段落等第三种样式）
                                    finalContent = buildChatHardFailureBubbleContent(String(error), {
                                        modelLabel: selectedModel.label,
                                        multimodalRejectedCode: errorCode,
                                    });
                                }
                            }

                            // 更新最终消息
                            const finalAIMessage = {
                                id: aiMessageId,
                                role: 'assistant',
                                content: finalContent,
                                typing: false,
                                interrupted,
                                isError: isMmRejected || streamFailedHard,
                                timestamp: Date.now()
                            };

                            setMessages(prev => {
                                const updatedMessages = prev.map(msg =>
                                    msg.id === aiMessageId ? finalAIMessage : msg
                                );

                                // 多模态被拒、流内 error 结束：均不入库（与 catch 一致）
                                if (!isMmRejected && !streamFailedHard) {
                                    persistMessages(updatedMessages);
                                }

                                return updatedMessages;
                            });

                            if (streamFailedHard) {
                                scheduleRemoveFailedChatRound(userMessage.id, aiMessageId);
                                antMessage.error({
                                    content: buildChatHardFailureToastContent(String(error), {
                                        modelLabel: selectedModel.label,
                                        multimodalRejectedCode: errorCode,
                                    }),
                                    duration: 5,
                                    style: { marginTop: '20vh' },
                                });
                            }

                            // 仅完整成功时扣费：中断 / API 报错 / 多模态被拒均不扣
                            const streamSucceeded = !interrupted && !isMmRejected;
                            if (selectedModel.key !== 'custom' && streamSucceeded) {
                                (async () => {
                                    try {
                                        const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
                                        const baseChatCost = getChatCreditsForBalanceCheck(selectedModel.key, pagesForBilling);
                                        const chatCost = (baseChatCost == null ? null : baseChatCost + extraCost);
                                        if (
                                            Zotero && Zotero.VibeDBSync && Zotero.VibeDBSync.deductCredits &&
                                            chatCost != null
                                        ) {
                                            const success = await Zotero.VibeDBSync.deductCredits(chatCost);
                                            if (!success) {
                                                console.error('[AIChat] Failed to deduct credits (chat will continue)');
                                            }
                                        }
                                    } catch (e) {
                                        console.error('[AIChat] Credit deduction error:', e);
                                    }
                                })();
                            }

                            // 重置 loading 状态
                            setLoading(false);
                        }
                    },
                    {
                        includeHistory: true,
                        model: resolvedModel,
                        systemPrompt: viberoSystemPrompt
                    }
                );
            } catch (error) {
                console.error('[AIChat] Error sending message:', error);

                const isMultimodalRejected = error?.code === MULTIMODAL_UNSUPPORTED_CODE;

                if (isMultimodalRejected) {
                    // 仅友好文案，不向用户展示接口原始英文/错误码（详情见控制台）
                    console.warn('[AIChat] Custom endpoint rejected multimodal request (raw):', error.message);
                }

                const rawMsg = error.message || '';
                const errorContent = buildChatHardFailureBubbleContent(rawMsg, {
                    modelLabel: selectedModel.label,
                    multimodalRejectedCode: isMultimodalRejected ? MULTIMODAL_UNSUPPORTED_CODE : error?.code,
                });

                // 创建错误消息（只用于 UI 显示，不保存到数据库）
                const errorMessage = {
                    id: aiMessageId,
                    role: 'assistant',
                    content: errorContent,
                    typing: false,
                    isError: true,
                    timestamp: Date.now()
                };

                // 只在 UI 上显示错误消息，不保存到数据库
                setMessages(prev => {
                    const updatedMessages = prev.map(msg =>
                        msg.id === aiMessageId ? errorMessage : msg
                    );
                    // 不调用 saveMessagesToDB()，这样错误消息就不会被保存
                    return updatedMessages;
                });

                scheduleRemoveFailedChatRound(userMessage.id, aiMessageId);

                // 使用 Ant Design 的 message 组件显示通知
                antMessage.error({
                    content: buildChatHardFailureToastContent(rawMsg, {
                        modelLabel: selectedModel.label,
                        multimodalRejectedCode: isMultimodalRejected ? MULTIMODAL_UNSUPPORTED_CODE : error?.code,
                    }),
                    duration: isMultimodalRejected ? 6 : 5,
                    style: {
                        marginTop: '20vh',
                    }
                });
            } finally {
                // 确保无论成功或失败都重置 loading 状态
                setLoading(false);
            }
        };

        performChat();
        return true;
    };

    // 插入 VibeCard 引用
    const insertVibeCardReference = (vibeCardData) => {
        if (insertVibeCardRef.current) {
            insertVibeCardRef.current(vibeCardData);
        }
    };

    // 暴露方法给全局 API
    useEffect(() => {
        globalInsertVibeCard = insertVibeCardReference;
        globalClearMessages = () => {
            setMessages([]);
        };
        globalSetDragOverState = (isDragging, vibeCardId) => {
            setIsDragOver(isDragging);
            setDraggedVibeCardId(isDragging ? vibeCardId : null);
        };
    }, [insertVibeCardReference]);

    // 记录鼠标按下时的目标元素，并动态设置 draggable
    const handleMouseDown = (event) => {
        mouseDownTargetRef.current = event.target;
        const isTextContent = event.target.closest('.ant-bubble-content');
        const container = event.currentTarget;

        if (isTextContent) {
            container.draggable = false;
        } else {
            container.draggable = true;
        }
    };

    // 处理从 PDF View 拖拽 VibeCard 到 AI Chat 的 drop 事件
    const handleVibeCardDrop = (event) => {
        event.preventDefault();
        event.stopPropagation();

        setIsDragOver(false);
        setDraggedVibeCardId(null);

        const vibeCardData = event.dataTransfer.getData('application/x-zotero-vibecard-reference');
        if (vibeCardData) {
            try {
                const data = JSON.parse(vibeCardData);
                if (data.vibeCardId && insertVibeCardRef.current) {
                    insertVibeCardRef.current({
                        id: data.vibeCardId,
                        name: data.vibeCardName || data.vibeCardId,
                        type: data.type,
                        vibeCardType: data.vibeCardType
                    });
                }
            } catch (error) {
                console.error('[AIChat] Error parsing VibeCard drop data:', error);
            }
        }
    };

    // 处理 dragover 事件以允许 drop
    const handleDragOver = (event) => {
        const types = event.dataTransfer.types;
        if (types.includes('application/x-zotero-vibecard-reference')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }
    };

    // 处理对话选择
    const handleConversationClick = (event, conversationId) => {
        const isTextContent = event.target.closest('.ant-bubble-content');
        if (isTextContent) return;

        setSelectedConversations(prev => {
            const newSet = new Set(prev);
            if (newSet.has(conversationId)) {
                newSet.delete(conversationId);
            } else {
                newSet.add(conversationId);
            }
            return newSet;
        });
    };

    // 拖拽处理（支持多选）
    const handleDragStart = (event, conversationId, userMsg, aiMsg) => {
        let conversationsToDrag = [];

        if (selectedConversations.has(conversationId)) {
            for (let i = 0; i < messages.length - 1; i++) {
                const msg = messages[i];
                const nextMsg = messages[i + 1];
                if (msg.role === 'user' && nextMsg && nextMsg.role === 'assistant') {
                    const convId = `${msg.id}-${nextMsg.id}`;
                    if (selectedConversations.has(convId)) {
                        conversationsToDrag.push({
                            userText: msg.content,
                            aiText: nextMsg.content,
                            userVibeCardRefs: msg.vibeCardRefs || []
                        });
                    }
                }
            }
        } else {
            conversationsToDrag = [{
                userText: userMsg.content,
                aiText: aiMsg.content,
                userVibeCardRefs: userMsg.vibeCardRefs || []
            }];
        }

        const conversationData = {
            type: 'ai-chat-conversation',
            conversations: conversationsToDrag,
            timestamp: Date.now()
        };

        event.dataTransfer.setData('application/x-zotero-ai-conversation', JSON.stringify(conversationData));

        const plainText = conversationsToDrag
            .map(c => `Q: ${c.userText}\n\nA: ${c.aiText}`)
            .join('\n\n---\n\n');
        event.dataTransfer.setData('text/plain', plainText);

        event.dataTransfer.effectAllowed = 'copy';
        event.currentTarget.classList.add('dragging');
    };

    const handleDragEnd = (event) => {
        event.currentTarget.classList.remove('dragging');
        setSelectedConversations(new Set());
    };

    const removeConversationPair = useCallback((userMessageId, aiMessageId) => {
        setMessages(prev => {
            const updatedMessages = prev.filter(m => m.id !== userMessageId && m.id !== aiMessageId);
            persistMessages(updatedMessages);
            return updatedMessages;
        });

        setSelectedConversations(prev => {
            const next = new Set(prev);
            next.delete(`${userMessageId}-${aiMessageId}`);
            return next;
        });
    }, [persistMessages]);

    const handleDeleteConversation = useCallback((conversationId, userMsg, aiMsg) => {
        Modal.confirm({
            title: zoteroL10n('vibe-ai-chat-delete-conversation-title'),
            content: zoteroL10n('vibe-ai-chat-delete-conversation-content'),
            okText: zoteroL10n('vibe-ai-chat-button-delete'),
            cancelText: zoteroL10n('general-cancel'),
            okButtonProps: { danger: true },
            onOk: async () => {
                removeConversationPair(userMsg.id, aiMsg.id);
                if (editingConversationId === conversationId) {
                    setEditingConversationId(null);
                    setEditingText('');
                }
                antMessage.success(zoteroL10n('vibe-ai-chat-conversation-deleted'));
            }
        });
    }, [editingConversationId, removeConversationPair]);

    const handleStartEditingConversation = useCallback((conversationId, userMsg) => {
        setEditingConversationId(conversationId);
        setEditingText(userMsg.content || '');
    }, []);

    const handleCancelEditingConversation = useCallback(() => {
        setEditingConversationId(null);
        setEditingText('');
    }, []);

    const handleResendEditedConversation = useCallback(async (conversationId, userMsg, aiMsg) => {
        const nextText = editingText.trim();
        if (!nextText) {
            antMessage.warning(zoteroL10n('vibe-ai-chat-edit-empty-warning'));
            return;
        }

        const sent = await handleSend(nextText, userMsg.vibeCardRefs || [], userMsg.images || [], userMsg.extraPaperRefs || []);
        if (!sent) return;

        removeConversationPair(userMsg.id, aiMsg.id);
        setEditingConversationId(null);
        setEditingText('');
        antMessage.success(zoteroL10n('vibe-ai-chat-conversation-resent'));
    }, [editingText, handleSend, removeConversationPair]);

    // 欢迎消息拖拽处理
    const handleWelcomeDragStart = (event) => {
        const welcomeContent = isZhLocale()
            ? `欢迎使用 ForPaper！🚀 开启你的畅读之旅！

**Canvas ⬅️ 对话**
将 AI 对话拖到画布，生成问答闪卡。

**Canvas ➡️ 对话**
三种带上下文提问的方式：
1️⃣ **Cmd/Ctrl + 点击**任意段落
2️⃣ **拖动**总结卡片到这里
3️⃣ **粘贴**截图`
            : `Welcome to ForPaper! 🚀 Enjoy your vibe reading trip!

**Canvas ⬅️ Chat**
Drag AI chats to the canvas to generate Q&A flashcards.

**Canvas ➡️ Chat**
3 ways to chat with context:
1️⃣ **Cmd/Ctrl + Click** any paragraph
2️⃣ **Drag** Summary Card here
3️⃣ **Paste** Screenshot`;

        const conversationData = {
            type: 'ai-chat-conversation',
            conversations: [{
                userText: isZhLocale() ? '如何使用 ForPaper AI 聊天？' : 'How can I use ForPaper AI Chat?',
                aiText: welcomeContent,
                userVibeCardRefs: []
            }],
            timestamp: Date.now()
        };

        event.dataTransfer.setData('application/x-zotero-ai-conversation', JSON.stringify(conversationData));

        const plainText = `Q: ${conversationData.conversations[0].userText}\n\nA: ${conversationData.conversations[0].aiText}`;
        event.dataTransfer.setData('text/plain', plainText);

        event.dataTransfer.effectAllowed = 'copy';
        event.currentTarget.classList.add('dragging');
    };

    // 模型切换处理
    const handleModelChange = (model) => {
        // // console.log('[AIChat] 模型切换:', model);
        setSelectedModel(model);
    };

    // 清空对话历史
    const handleClearHistory = () => {
        Modal.confirm({
            title: zoteroL10n('vibe-ai-chat-clear-history-title'),
            content: zoteroL10n('vibe-ai-chat-clear-history-content'),
            okText: zoteroL10n('vibe-ai-chat-confirm'),
            cancelText: zoteroL10n('general-cancel'),
            onOk: async () => {
                // 清空所有 AI 服务历史
                huoshanService.clearHistory();
                bailianService.clearHistory();
                openrouterChatService.clearHistory();
                // geminiService.clearHistory(); // Gemini 官方独立链路已暂停
                customOpenAIService.clearHistory();
                customAnthropicService.clearHistory();

                // 清空消息状态
                setMessages([]);
                setEditingConversationId(null);
                setEditingText('');
                setExtraContextPapers([]);

                // 清空数据库
                const itemID = getItemID();
                if (itemID) {
                    try {
                        await window.parent.Zotero.VibeDB.AIChats.save(parseInt(itemID), []);
                        // // console.log('[AIChat] ✓ 数据库历史已清空');
                    } catch (error) {
                        console.error('[AIChat] Failed to clear chat history in DB:', error);
                    }
                }

                antMessage.success(zoteroL10n('vibe-ai-chat-history-cleared'));
            }
        });
    };

    return (
        <div
            className="ai-chat-container"
            onDrop={handleVibeCardDrop}
            onDragOver={handleDragOver}
            style={{ position: 'relative' }}
        >
            {/* 拖拽悬停遮罩层 */}
            {isDragOver && (
                <div
                    className="drag-overlay"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 9999,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(255, 255, 255, 0.3)',
                        backdropFilter: 'blur(10px)',
                        WebkitBackdropFilter: 'blur(10px)',
                        pointerEvents: 'none',
                    }}
                >
                    <img
                        src={atIconSvg}
                        alt="@"
                        style={{ width: '80px', height: '80px', marginBottom: '16px' }}
                    />
                    <div style={{
                        fontSize: '20px',
                        fontWeight: 300,
                        color: '#262626',
                        marginBottom: '8px',
                    }}>
                        {isZhLocale() ? '把内容拖到这里即可 @ 引用！' : 'Drop content here to @!'}
                    </div>
                </div>
            )}

            {/* 头部 */}
            <div className="ai-chat-header">
                <Flex justify="space-between" align="center">
                    <h3>{isZhLocale() ? 'AI 聊天' : 'AI Chat'}</h3>
                    <Flex gap="small">
                        <Button
                            type="text"
                            size="small"
                            icon={<FontSizeOutlined />}
                            onClick={() => setShowFontSlider(!showFontSlider)}
                            title={zoteroL10n('vibe-ai-chat-font-size-adjust')}
                        />
                        <Button
                            type="text"
                            size="small"
                            onClick={handleClearHistory}
                            title={zoteroL10n('vibe-ai-chat-clear-history-action')}
                        >
                            {zoteroL10n('vibe-ai-chat-clear')}
                        </Button>
                    </Flex>
                </Flex>

                {/* 字体大小调整滑块 */}
                {showFontSlider && (
                    <div style={{
                        marginTop: '8px',
                        padding: '8px',
                        background: 'var(--fill-quinary)',
                        borderRadius: '6px',
                        border: '1px solid var(--fill-quaternary)'
                    }}>
                        <Flex gap="small" align="center">
                            <span style={{ fontSize: '12px', color: 'var(--fill-secondary)' }}>
                                {zoteroL10n('vibe-ai-chat-font-size')}
                            </span>
                            <input
                                type="range"
                                min="0.5"
                                max="2.0"
                                step="0.1"
                                value={fontScale}
                                onChange={(e) => handleFontScaleChange(parseFloat(e.target.value))}
                                style={{ flex: 1 }}
                            />
                            <span style={{
                                fontSize: '12px',
                                color: 'var(--fill-primary)',
                                minWidth: '3em',
                                textAlign: 'right'
                            }}>
                                {Math.round(fontScale * 100)}%
                            </span>
                            <Button
                                type="text"
                                size="small"
                                onClick={() => handleFontScaleChange(1.0)}
                                title={zoteroL10n('vibe-ai-chat-reset-default')}
                                style={{ fontSize: '12px', padding: '0 8px' }}
                            >
                                {zoteroL10n('vibe-ai-chat-reset')}
                            </Button>
                        </Flex>
                    </div>
                )}
            </div>

            {/* 消息列表 */}
            <div className="ai-chat-messages" ref={messagesContainerRef}>
                {/* 静态欢迎消息（始终显示，不存入 messages 状态，不可拖拽） */}
                {historyLoaded && (
                    <div
                        className="welcome-section"
                        draggable={true}
                        onDragStart={handleWelcomeDragStart}
                        onDragEnd={(e) => e.currentTarget.classList.remove('dragging')}
                    >
                        {/* Logo 和欢迎文字 */}
                        <div className="welcome-header">
                            <Bubble
                                placement="start"
                                variant="shadow"
                                content={
                                    <Flex gap="middle" align="center">
                                        {viberoLogo}
                                        <div>
                                            <div className="welcome-title">
                                                {isZhLocale() ? '欢迎使用 ForPaper！' : 'Welcome to ForPaper!'}
                                            </div>
                                            <div className="welcome-subtitle">
                                                {isZhLocale() ? '🚀 开启你的畅读之旅！' : '🚀 Enjoy your vibe reading trip!'}
                                            </div>
                                        </div>
                                    </Flex>
                                }
                            />
                        </div>

                        {/* 提示卡片（始终显示） */}
                        <div className="welcome-prompts-container">
                            <Prompts
                                vertical
                                items={welcomePromptItems}
                                styles={{
                                    list: { gap: 8 },
                                    item: {
                                        padding: '12px',
                                        border: '1px solid #f0f0f0',
                                        borderRadius: '6px',
                                        cursor: 'default',
                                        width: '100%',
                                        boxSizing: 'border-box'
                                    }
                                }}
                            />
                        </div>

                        {/* Action bar（只在没有对话时显示）
                        {messages.length === 0 && (
                            <div className="conversation-action-bar">
                                <Button
                                    type="text"
                                    size="small"
                                    icon={loveActive ? null : (
                                        <img src={loveMessageSvg} alt="love" style={{ width: 16, height: 16, display: 'block' }} />
                                    )}
                                    onClick={() => {
                                        setLoveActive(true);
                                        setTimeout(() => setLoveActive(false), 3000);
                                    }}
                                >
                                    {loveActive ? welcomeActionText : null}
                                </Button>
                            </div>
                        )} */}
                    </div>
                )}

                {/* 渲染对话消息 */}
                {messages.map((msg, index) => {
                    const isUserMsg = msg.role === 'user';
                    const nextMsg = messages[index + 1];
                    const isConversationPair = isUserMsg && nextMsg && nextMsg.role === 'assistant';

                    // 如果是对话对的开始，渲染整个对话容器
                    if (isConversationPair) {
                        const conversationId = `${msg.id}-${nextMsg.id}`;
                        const isSelected = selectedConversations.has(conversationId);
                        const isEditing = editingConversationId === conversationId;

                        return (
                            <div
                                key={conversationId}
                                className={`conversation-container ${isSelected ? 'selected' : ''}`}
                                onMouseDown={handleMouseDown}
                                onClick={(e) => handleConversationClick(e, conversationId)}
                                onDragStart={(e) => handleDragStart(e, conversationId, msg, nextMsg)}
                                onDragEnd={handleDragEnd}
                                draggable={!isEditing}
                            >
                                <div
                                    className="conversation-actions"
                                    onClick={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<EditOutlined />}
                                        disabled={loading}
                                        title={zoteroL10n('vibe-ai-chat-button-edit')}
                                        aria-label={zoteroL10n('vibe-ai-chat-button-edit')}
                                        onClick={() => handleStartEditingConversation(conversationId, msg)}
                                    />
                                    <Button
                                        type="text"
                                        size="small"
                                        danger
                                        className="conversation-action-delete-btn"
                                        icon={<DeleteOutlined />}
                                        disabled={loading}
                                        title={zoteroL10n('vibe-ai-chat-button-delete')}
                                        aria-label={zoteroL10n('vibe-ai-chat-button-delete')}
                                        onClick={() => handleDeleteConversation(conversationId, msg, nextMsg)}
                                    />
                                </div>
                                <div className={`conversation-messages ${nextMsg.isError ? 'error-message' : ''}`}>
                                    <Bubble.List
                                        roles={roles}
                                        items={[
                                            {
                                                key: msg.id,
                                                role: 'user',
                                                content: isEditing ? (
                                                    <div
                                                        className="conversation-inline-editor"
                                                        onClick={(e) => e.stopPropagation()}
                                                        onMouseDown={(e) => e.stopPropagation()}
                                                    >
                                                        {msg.images && msg.images.length > 0 ? (
                                                            <div className="conversation-inline-editor-images">
                                                                {msg.images.map((img, idx) => (
                                                                    <ChatImageLightbox
                                                                        key={`edit-img-${idx}`}
                                                                        thumbnail
                                                                        src={img.r2Url || img.base64}
                                                                        alt={img.name || 'image'}
                                                                    />
                                                                ))}
                                                            </div>
                                                        ) : null}
                                                        <Input.TextArea
                                                            value={editingText}
                                                            autoSize={{ minRows: 2, maxRows: 8 }}
                                                            onChange={(e) => setEditingText(e.target.value)}
                                                            onPressEnter={(e) => {
                                                                if (!e.shiftKey) {
                                                                    e.preventDefault();
                                                                    handleResendEditedConversation(conversationId, msg, nextMsg);
                                                                }
                                                            }}
                                                        />
                                                        <div className="conversation-inline-editor-actions">
                                                            <Button
                                                                size="small"
                                                                onClick={handleCancelEditingConversation}
                                                            >
                                                                {zoteroL10n('general-cancel')}
                                                            </Button>
                                                            <Button
                                                                size="small"
                                                                type="primary"
                                                                className="btn-black"
                                                                loading={loading}
                                                                onClick={() => handleResendEditedConversation(conversationId, msg, nextMsg)}
                                                            >
                                                                {zoteroL10n('vibe-ai-chat-button-resend')}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ) : renderUserMessageContent(msg.content, msg.vibeCardRefs, msg.images, msg.extraPaperRefs),
                                            },
                                            {
                                                key: nextMsg.id,
                                                role: 'assistant',
                                                content: typeof nextMsg.content === 'string'
                                                    ? <MarkdownRenderer content={nextMsg.content} />
                                                    : nextMsg.content,
                                                loading: nextMsg.content === '' && loading && nextMsg.id === messages[messages.length - 1].id,
                                            },
                                        ]}
                                    />
                                </div>
                            </div>
                        );
                    }

                    // 如果是单独的 AI 消息
                    if (!isUserMsg && (index === 0 || messages[index - 1].role !== 'user')) {
                        return (
                            <div key={msg.id} className={`single-message ${msg.isError ? 'error-message' : ''}`}>
                                <Bubble.List
                                    roles={roles}
                                    items={[
                                        {
                                            key: msg.id,
                                            role: 'assistant',
                                            content: typeof msg.content === 'string'
                                                ? <MarkdownRenderer content={msg.content} />
                                                : msg.content,
                                            loading: msg.content === '' && loading && msg.id === messages[messages.length - 1].id,
                                        },
                                    ]}
                                />
                            </div>
                        );
                    }

                    return null;
                })}
                <div ref={messagesEndRef} />
            </div>

            {/* 输入区域 */}
            <div className="ai-chat-input-area">
                <SlateInputWithSender
                    onSubmit={handleSend}
                    loading={loading}
                    isDragOver={isDragOver}
                    draggedVibeCardId={draggedVibeCardId}
                    onVibeCardInsert={(insertFn) => {
                        insertVibeCardRef.current = insertFn;
                    }}
                    onModelChange={handleModelChange}
                    currentModel={displayModel}
                    canUseAdvancedModels={canUseAdvancedModels}
                    visionCapable={visionCapable}
                    pdfPageCount={pdfPageCount}
                    extraContextPapers={extraContextPapers}
                    onChangeExtraContextPapers={setExtraContextPapers}
                    onRequestExtraPaperCandidates={requestExtraPaperCandidates}
                    extraContextCost={extraContextCost}
                />
            </div>
        </div>
    );
}

// 全局引用，用于从外部调用
let globalInsertVibeCard = null;
let globalClearMessages = null;
let globalSetDragOverState = null;

// 安全地初始化全局 API
const initializeGlobalAPI = () => {
    if (typeof window !== 'undefined') {
        window.aiChatAPI = {
            insertVibeCardReference: (vibeCardData) => {
                if (globalInsertVibeCard) {
                    globalInsertVibeCard(vibeCardData);
                }
            },
            clearMessages: () => {
                if (globalClearMessages) {
                    globalClearMessages();
                }
            },
            setDragOverState: (isDragging, vibeCardId) => {
                if (globalSetDragOverState) {
                    globalSetDragOverState(isDragging, vibeCardId);
                }
            }
        };
    }
};

// 挂载到 DOM
const rootElement = document.getElementById('root');

if (!rootElement) {
    console.error('[AIChat] ❌ Root element not found!');
} else {
    try {
        const root = createRoot(rootElement);
        root.render(<AIChatApp />);
        initializeGlobalAPI();
    } catch (error) {
        console.error('[AIChat] ❌ Error mounting React app:', error);
    }
}
