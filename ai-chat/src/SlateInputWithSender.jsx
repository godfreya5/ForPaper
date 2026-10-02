import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createEditor, Editor, Range, Transforms } from 'slate';
import { withHistory } from 'slate-history';
import { Editable, Slate, useFocused, useSelected, withReact } from 'slate-react';
import { SendOutlined, DownOutlined, SettingOutlined, PlusOutlined, DeleteOutlined, CloseOutlined } from '@ant-design/icons';
import { Button, Flex, theme, Dropdown, message as antMessage, Modal, Form, Input, Select, Badge, Checkbox } from 'antd';
import { formatCustomModelLabel, zoteroL10n } from './zoteroL10n';
import modelIcon from '../icons/model.svg';
import ImageUploader from './ImageUploader';
import ImagePreview from './ImagePreview';
import { uploadImageToOss } from './imageR2Uploader';

// 开源版：不内置任何预设模型，仅支持用户自定义模型（自行配置 API），
// 因此预设品牌图标 / 计价排序等代码已全部移除。

/** 下拉项更紧凑；工具栏略大 */
const MENU_SLOT_PX = 20;
const TOOLBAR_ICON_PX = 18;

/**
 * 测试模型连接（参考 WorkBuddy 自定义模型的「配完即可测」）：
 * 按所选接口格式发一条最小请求（max_tokens=1，非流式），20 秒超时。
 * 只验证 网络可达 + 鉴权通过 + 模型名有效，不污染会话历史。
 * @returns {Promise<{ok: boolean, msg?: string}>}
 */
async function testModelConnectionRequest({ baseUrl, apiKey, modelName, apiFormat }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        let url = String(baseUrl || '').trim().replace(/\/+$/, '');
        const headers = { 'Content-Type': 'application/json' };
        let body;
        if (apiFormat === 'anthropic') {
            if (!url.endsWith('/messages')) {
                url += /\/v\d+$/.test(url) ? '/messages' : '/v1/messages';
            }
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
            body = { model: modelName, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
        } else {
            if (!url.endsWith('/chat/completions')) {
                if (/\/v\d+$/.test(url)) url += '/chat/completions';
                else if (/\/v\d+\//.test(url)) url = url.replace(/(\/v\d+\/).*$/, '$1chat/completions');
                else url += '/v1/chat/completions';
            }
            headers['Authorization'] = `Bearer ${apiKey}`;
            body = { model: modelName, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false };
        }
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
        const text = await resp.text();
        if (resp.ok) return { ok: true };
        let detail = text;
        try {
            const j = JSON.parse(text);
            detail = j.error?.message || j.message || text;
        } catch (_) { /* 保留原文 */ }
        return { ok: false, msg: `HTTP ${resp.status}: ${String(detail).slice(0, 200)}` };
    } catch (e) {
        const msg = e?.name === 'AbortError' ? '请求超时（20 秒）' : (e?.message || String(e));
        return { ok: false, msg };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 供应商快捷预设（参考 epsilon/Mrite 的设置面板）：
 * 点一下自动填入 Base URL + 接口格式 + 常用模型下拉，用户只需再粘贴 API Key。
 * baseUrl 命中前缀时用于反向识别已保存配置属于哪个供应商。
 */
const MODEL_PROVIDERS = [
    {
        key: 'deepseek', name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com', apiFormat: 'openai',
        defaultModel: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        docsUrl: 'https://platform.deepseek.com/api_keys',
    },
    {
        key: 'kimi', name: 'Kimi',
        baseUrl: 'https://api.moonshot.cn/v1', apiFormat: 'openai',
        defaultModel: 'kimi-k2',
        models: ['kimi-k2', 'kimi-latest', 'moonshot-v1-128k', 'moonshot-v1-32k'],
        docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    },
    {
        key: 'glm', name: '智谱 GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'openai',
        defaultModel: 'glm-4-plus',
        models: ['glm-4-plus', 'glm-4-flash', 'glm-4-long'],
        docsUrl: 'https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    },
    {
        key: 'qwen', name: '阿里千问',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'openai',
        defaultModel: 'qwen-plus',
        models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
        docsUrl: 'https://bailian.console.aliyun.com/',
    },
    {
        key: 'openai', name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai',
        defaultModel: 'gpt-4.1-mini',
        models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
        docsUrl: 'https://platform.openai.com/api-keys',
    },
    {
        key: 'gemini', name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiFormat: 'openai',
        defaultModel: 'gemini-2.5-flash',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        docsUrl: 'https://aistudio.google.com/apikey',
    },
    {
        key: 'grok', name: 'Grok',
        baseUrl: 'https://api.x.ai/v1', apiFormat: 'openai',
        defaultModel: 'grok-3-mini',
        models: ['grok-3', 'grok-3-mini'],
        docsUrl: 'https://console.x.ai/',
    },
    {
        key: 'custom', name: '自定义',
        baseUrl: '', apiFormat: 'openai',
        defaultModel: '',
        models: [],
        docsUrl: '',
    },
];

// 在 Zotero iframe 里打开外部链接（优先走主窗口的 Zotero.launchURL）
const openExternalUrl = (url) => {
    if (!url) return;
    try {
        const z = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
        if (z && typeof z.launchURL === 'function') {
            z.launchURL(url);
            return;
        }
    } catch (e) { /* 跨域等异常走回退 */ }
    try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
};

// VibeCard Mention 组件
const BaseMention = ({ attributes, children, element, label }) => {
    const selected = useSelected();
    const focused = useFocused();

    return (
        <span
            {...attributes}
            contentEditable={false}
            style={{
                padding: '2px 6px',
                margin: '0 2px',
                verticalAlign: 'baseline',
                display: 'inline-block',
                borderRadius: '12px',
                backgroundColor: 'var(--material-sidepane, #f5f5f5)',
                border: '1px solid var(--fill-quinary, #e5e5e5)',
                color: 'var(--fill-primary, #262626)',
                fontSize: '0.9em',
                fontWeight: '500',
                boxShadow: selected && focused ? '0 0 0 2px rgba(0,0,0,0.06)' : 'none',
                cursor: 'default',
                transition: 'background-color .2s, border-color .2s, box-shadow .2s',
            }}
        >
            <span contentEditable={false}>
                @{label}
                {children}
            </span>
        </span>
    );
};

const VibeCardMention = ({ attributes, children, element }) => (
    <BaseMention
        attributes={attributes}
        children={children}
        element={element}
        label={element.vibeCardName || element.vibeCardId}
    />
);

const PaperMention = ({ attributes, children, element }) => (
    <BaseMention
        attributes={attributes}
        children={children}
        element={element}
        label={element.paperShortName || element.paperTitle || element.paperItemID}
    />
);

// 元素渲染器
const Element = ({ attributes, children, element }) => {
    switch (element.type) {
        case 'vibecard-mention':
            return <VibeCardMention attributes={attributes} children={children} element={element} />;
        case 'paper-mention':
            return <PaperMention attributes={attributes} children={children} element={element} />;
        default:
            return <div {...attributes}>{children}</div>;
    }
};

// 叶子节点渲染器
const Leaf = ({ attributes, children }) => {
    return <span {...attributes}>{children}</span>;
};

// 扩展编辑器以支持 VibeCard mentions
const withVibeCardMentions = (editor) => {
    const { isInline, isVoid } = editor;

    editor.isInline = (element) => {
        return element.type === 'vibecard-mention' || element.type === 'paper-mention' ? true : isInline(element);
    };

    editor.isVoid = (element) => {
        return element.type === 'vibecard-mention' || element.type === 'paper-mention' ? true : isVoid(element);
    };

    return editor;
};

// 插入 VibeCard mention
const insertVibeCardMention = (editor, vibeCardData, targetRange = null, searchText = '') => {
    const mention = {
        type: 'vibecard-mention',
        vibeCardId: vibeCardData.id,
        vibeCardName: vibeCardData.name,
        children: [{ text: '' }],
    };

    if (targetRange) {
        try {
            const endPoint = Range.end(targetRange);
            const distance = (searchText?.length || 0) + 1;
            const anchorPoint = Editor.before(editor, endPoint, { distance, unit: 'character' });
            if (anchorPoint) {
                const exactRange = { anchor: anchorPoint, focus: endPoint };
                Transforms.select(editor, exactRange);
                Transforms.delete(editor);
            } else {
                Transforms.select(editor, targetRange);
                Transforms.delete(editor);
            }
        } catch (err) {
            Transforms.select(editor, targetRange);
            Transforms.delete(editor);
        }
    }

    Transforms.insertNodes(editor, mention);
    Transforms.move(editor);
};

const buildPaperShortName = (title) => {
    const raw = String(title || '').replace(/\s+/g, '').trim();
    if (!raw) return 'paper';
    if (raw.length <= 10) return raw;
    return `${raw.slice(0, 10)}...`;
};

const insertPaperMention = (editor, paperData) => {
    const mention = {
        type: 'paper-mention',
        paperItemID: paperData.itemID,
        paperTitle: paperData.title,
        paperShortName: buildPaperShortName(paperData.title),
        children: [{ text: '' }],
    };
    Transforms.insertNodes(editor, mention);
    Transforms.move(editor);
};

const removePaperMention = (editor, paperItemID) => {
    const matches = Array.from(
        Editor.nodes(editor, {
            at: [],
            match: (node) =>
                !Editor.isEditor(node) &&
                node &&
                node.type === 'paper-mention' &&
                String(node.paperItemID) === String(paperItemID),
        })
    );
    matches.reverse().forEach(([, path]) => {
        Transforms.removeNodes(editor, { at: path });
    });
};

// Slate 输入框组件（使用 Ant Design X Sender 样式）
const SlateInputWithSender = ({
    onSubmit,
    loading,
    onVibeCardInsert,
    onModelChange,
    currentModel, // 接收父组件传入的当前模型
    canUseAdvancedModels = true, // 开源版：无订阅门槛
    visionCapable = true,
    /** 当前 PDF 总页数；未知时不加页数加价（菜单与排序按基准档） */
    pdfPageCount = null,
    extraContextPapers = [],
    onChangeExtraContextPapers = null,
    onRequestExtraPaperCandidates = null,
    extraContextCost = 0,
}) => {
    const { token } = theme.useToken();
    const editorRef = useRef();
    if (!editorRef.current) {
        editorRef.current = withVibeCardMentions(withReact(withHistory(createEditor())));
    }
    const editor = editorRef.current;

    const [value, setValue] = useState([
        {
            type: 'paragraph',
            children: [{ text: '' }],
        },
    ]);

    // 自定义模型多配置
    const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
    const [form] = Form.useForm();
    const [customConfigs, setCustomConfigs] = useState([]);
    const [editingConfigId, setEditingConfigId] = useState(null);
    const [addFormFlash, setAddFormFlash] = useState(false);
    // 供应商快捷预设：当前高亮的供应商 + 模型名下的联想选项
    const [activeProviderKey, setActiveProviderKey] = useState(null);
    const [providerModelOptions, setProviderModelOptions] = useState([]);
    // 测试连接：testing=请求中；testResult={ok,msg} 展示在表单下方
    const [testingConnection, setTestingConnection] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const apiFormatWatched = Form.useWatch('apiFormat', form);
    const apiFormatForUrlPlaceholder = apiFormatWatched ?? 'openai';
    const [isExtraPaperPickerOpen, setIsExtraPaperPickerOpen] = useState(false);
    const [extraPaperCandidates, setExtraPaperCandidates] = useState([]);
    const [extraPaperLoading, setExtraPaperLoading] = useState(false);
    const [extraPaperSearch, setExtraPaperSearch] = useState('');

    const getZotero = () => window.Zotero || window.parent?.Zotero || window.top?.Zotero;

    // 读取所有自定义模型配置
    const getCustomModelConfigs = useCallback(() => {
        try {
            const Zotero = getZotero();
            if (Zotero && Zotero.Prefs) {
                const saved = Zotero.Prefs.get('aiChat.customModelConfigs', true);
                if (saved) {
                    const arr = JSON.parse(saved);
                    return Array.isArray(arr) ? arr : [];
                }
                // 迁移：旧版单配置 -> 新版多配置
                const oldSingle = Zotero.Prefs.get('aiChat.customModelConfig', true);
                if (oldSingle) {
                    try {
                        const old = JSON.parse(oldSingle);
                        const migrated = [{
                            id: `custom-${Date.now()}`,
                            name: old.modelName || zoteroL10n('vibe-ai-chat-custom-model-fallback'),
                            baseUrl: old.baseUrl || '',
                            apiKey: old.apiKey || '',
                            modelName: old.modelName || '',
                            apiFormat: old.apiFormat || 'openai'
                        }];
                        Zotero.Prefs.set('aiChat.customModelConfigs', JSON.stringify(migrated), true);
                        Zotero.Prefs.set('aiChat.customModelConfigId', migrated[0].id, true);
                        return migrated;
                    } catch (_) {
                        return [];
                    }
                }
            }
        } catch (e) {
            console.warn('[SlateInput] Failed to get custom model configs:', e);
        }
        return [];
    }, []);

    // 根据 configId 获取单条配置
    const getCustomModelConfigById = useCallback((configId) => {
        const configs = getCustomModelConfigs();
        return configs.find(c => c.id === configId) || null;
    }, [getCustomModelConfigs]);

    // 保存配置列表
    const saveCustomModelConfigs = useCallback((configs) => {
        try {
            const Zotero = getZotero();
            if (Zotero && Zotero.Prefs) {
                Zotero.Prefs.set('aiChat.customModelConfigs', JSON.stringify(configs), true);
                return true;
            }
        } catch (e) {
            console.error('[SlateInput] Failed to save custom model configs:', e);
        }
        return false;
    }, []);

    // 获取当前选中的 configId
    const getSelectedConfigId = useCallback(() => {
        try {
            const Zotero = getZotero();
            if (Zotero && Zotero.Prefs) {
                return Zotero.Prefs.get('aiChat.customModelConfigId', true) || null;
            }
        } catch (_) {}
        return null;
    }, []);

    const setSelectedConfigId = (id) => {
        try {
            const Zotero = getZotero();
            if (Zotero && Zotero.Prefs) {
                Zotero.Prefs.set('aiChat.customModelConfigId', id || '', true);
            }
        } catch (_) {}
    };

    // 打开弹窗时：有配置则默认选中 Prefs 中当前项或列表第一项并填入表单；无配置则进入「新建」空表
    useEffect(() => {
        if (!isConfigModalOpen) return;
        const list = getCustomModelConfigs();
        setCustomConfigs(list);
        if (!list.length) {
            setEditingConfigId(null);
            form.resetFields();
            form.setFieldsValue({ apiFormat: 'openai' });
            syncProviderFromConfig(null);
            return;
        }
        const prefId = getSelectedConfigId();
        const pick = list.find(c => c.id === prefId) || list[0];
        setEditingConfigId(pick.id);
        form.setFieldsValue({
            baseUrl: pick.baseUrl,
            apiKey: pick.apiKey,
            modelName: pick.modelName,
            apiFormat: pick.apiFormat || 'openai'
        });
        syncProviderFromConfig(pick);
    }, [isConfigModalOpen, getCustomModelConfigs, getSelectedConfigId, form]);

    // 弹窗打开时把本 iframe 临时扩展为整个窗口大小（fixed 全屏），
    // 让白卡片弹窗 + 暗色遮罩覆盖所有页面；关闭时精确还原。
    // 同域 chrome iframe，window.frameElement 可直接拿到父文档里的 iframe 元素。
    useEffect(() => {
        let frame = null;
        try { frame = window.frameElement; } catch (e) { frame = null; }
        if (!frame) return undefined;
        if (isConfigModalOpen) {
            if (frame.dataset.prevCssText === undefined) {
                frame.dataset.prevCssText = frame.style.cssText || '';
            }
            frame.style.cssText += ';position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:99998 !important;';
            return () => {
                frame.style.cssText = frame.dataset.prevCssText || '';
                delete frame.dataset.prevCssText;
            };
        }
        return undefined;
    }, [isConfigModalOpen]);

    const handleSaveConfig = () => {
        form.validateFields().then(values => {
            const wasEditing = !!editingConfigId;
            const { baseUrl, apiKey, modelName, apiFormat } = values;
            const configs = getCustomModelConfigs();
            const configToSave = {
                baseUrl,
                apiKey,
                modelName,
                apiFormat: apiFormat || 'openai'
            };

            if (editingConfigId) {
                const idx = configs.findIndex(c => c.id === editingConfigId);
                if (idx >= 0) {
                    configs[idx] = { ...configs[idx], ...configToSave };
                }
            } else {
                configs.push({
                    id: `custom-${Date.now()}`,
                    ...configToSave
                });
            }

            if (saveCustomModelConfigs(configs)) {
                const editedId = editingConfigId;
                setCustomConfigs(configs);
                const target = wasEditing && editedId
                    ? configs.find(c => c.id === editedId)
                    : configs[configs.length - 1];
                if (target) {
                    setEditingConfigId(target.id);
                    form.setFieldsValue({
                        baseUrl: target.baseUrl,
                        apiKey: target.apiKey,
                        modelName: target.modelName,
                        apiFormat: target.apiFormat || 'openai'
                    });
                    syncProviderFromConfig(target);
                } else {
                    setEditingConfigId(null);
                    form.resetFields();
                    form.setFieldsValue({ apiFormat: 'openai' });
                    syncProviderFromConfig(null);
                }
                antMessage.success(zoteroL10n(wasEditing ? 'vibe-ai-chat-config-updated' : 'vibe-ai-chat-config-added'));
                if (onModelChange && configs.length > 0 && target) {
                    setSelectedConfigId(target.id);
                    onModelChange({
                        key: 'custom',
                        label: formatCustomModelLabel(target.modelName),
                        configId: target.id,
                        config: target
                    });
                }
            } else {
                antMessage.error(zoteroL10n('vibe-ai-chat-config-save-failed'));
            }
        });
    };

    const handleDeleteConfig = (config) => {
        const displayName = getConfigDisplayName(config);
        Modal.confirm({
            title: zoteroL10n('vibe-ai-chat-confirm-delete-title'),
            content: zoteroL10n('vibe-ai-chat-confirm-delete-body', { name: displayName }),
            okText: zoteroL10n('vibe-ai-chat-button-delete'),
            cancelText: zoteroL10n('general-cancel'),
            okButtonProps: { danger: true },
            centered: true,
            bodyStyle: { textAlign: 'center' },
            wrapClassName: 'ai-chat-modal',
            zIndex: 10002,
            onOk: () => {
                const idToDelete = config.id;
                const configs = getCustomModelConfigs().filter(c => c.id !== idToDelete);
                if (saveCustomModelConfigs(configs)) {
                    setCustomConfigs(configs);
                    setSelectedConfigId(configs.length > 0 ? configs[0].id : null);
                    if (editingConfigId === idToDelete) {
                        if (configs.length === 0) {
                            setEditingConfigId(null);
                            form.resetFields();
                            form.setFieldsValue({ apiFormat: 'openai' });
                            syncProviderFromConfig(null);
                        } else {
                            const next = configs[0];
                            setEditingConfigId(next.id);
                            form.setFieldsValue({
                                baseUrl: next.baseUrl,
                                apiKey: next.apiKey,
                                modelName: next.modelName,
                                apiFormat: next.apiFormat || 'openai'
                            });
                            syncProviderFromConfig(next);
                        }
                    }
                    antMessage.success(zoteroL10n('vibe-ai-chat-config-deleted'));
                }
            }
        });
    };

    // 按 Base URL 前缀反向识别已保存配置属于哪个供应商（用于高亮卡片 + 模型联想）
    const detectProviderByBaseUrl = (baseUrl) =>
        MODEL_PROVIDERS.find(p => p.baseUrl && baseUrl && String(baseUrl).startsWith(p.baseUrl)) || null;

    // 点供应商卡片：自动填入接口格式 + Base URL + 默认模型，用户只需再填 API Key
    const applyProviderPreset = (p) => {
        setActiveProviderKey(p.key);
        setProviderModelOptions(p.models || []);
        setTestResult(null);
        form.setFieldsValue({
            apiFormat: p.apiFormat,
            baseUrl: p.baseUrl || '',
            modelName: p.defaultModel || '',
        });
    };

    // 测试连接：直接校验当前表单里的值（无需先保存）
    const handleTestConnection = async () => {
        let values;
        try {
            values = await form.validateFields();
        } catch (_) {
            return; // 校验失败，antd 已有红字提示
        }
        setTestingConnection(true);
        setTestResult(null);
        try {
            const r = await testModelConnectionRequest(values);
            setTestResult(r.ok
                ? { ok: true, msg: zoteroL10n('vibe-ai-chat-test-success') }
                : { ok: false, msg: zoteroL10n('vibe-ai-chat-test-failed', { error: r.msg }) });
        } finally {
            setTestingConnection(false);
        }
    };

    // 编辑已有配置 / 新建时同步供应商高亮与模型联想
    const syncProviderFromConfig = (config) => {
        const p = config ? detectProviderByBaseUrl(config.baseUrl) : null;
        setActiveProviderKey(p ? p.key : null);
        setProviderModelOptions(p ? p.models : []);
    };

    const handleAddConfig = () => {
        const alreadyOnAddPage = editingConfigId === null;
        setEditingConfigId(null);
        form.resetFields();
        form.setFieldsValue({ apiFormat: 'openai' });
        syncProviderFromConfig(null);
        setTestResult(null);
        if (alreadyOnAddPage) {
            setAddFormFlash(false);
            requestAnimationFrame(() => {
                setAddFormFlash(true);
                window.setTimeout(() => setAddFormFlash(false), 550);
            });
        }
    };

    const handleSelectConfigToEdit = (config) => {
        setEditingConfigId(config.id);
        form.setFieldsValue({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelName: config.modelName,
            apiFormat: config.apiFormat || 'openai'
        });
        syncProviderFromConfig(config);
        setTestResult(null);
    };

    const getConfigDisplayName = (c) => c.modelName || c.name || zoteroL10n('vibe-ai-chat-unnamed');

    // 图片状态
    const [attachedImages, setAttachedImages] = useState([]);

    const selectedExtraPaperCount = extraContextPapers.length;

    const formatBadgeCount = (count) => {
        if (count > 99) return '99+';
        return count;
    };

    const openExtraPaperPicker = useCallback(async () => {
        setIsExtraPaperPickerOpen(true);
        setExtraPaperSearch('');
        if (extraPaperCandidates.length > 0 || !onRequestExtraPaperCandidates) {
            return;
        }
        setExtraPaperLoading(true);
        try {
            const list = await onRequestExtraPaperCandidates();
            setExtraPaperCandidates(Array.isArray(list) ? list : []);
        } catch (e) {
            console.error('[SlateInput] Failed to load extra paper candidates:', e);
            antMessage.error(zoteroL10n('vibe-ai-chat-extra-paper-load-failed'));
        } finally {
            setExtraPaperLoading(false);
        }
    }, [extraContextPapers, extraPaperCandidates.length, onRequestExtraPaperCandidates]);

    const toggleExtraPaperSelection = useCallback((paper) => {
        if (!onChangeExtraContextPapers) {
            return;
        }
        const key = String(paper.itemID);
        const exists = extraContextPapers.some((p) => String(p.itemID) === key);
        if (exists) {
            onChangeExtraContextPapers(extraContextPapers.filter((p) => String(p.itemID) !== key));
            removePaperMention(editor, paper.itemID);
            return;
        }
        onChangeExtraContextPapers([...extraContextPapers, paper]);
        insertPaperMention(editor, paper);
        Transforms.insertText(editor, ' ');
    }, [onChangeExtraContextPapers, extraContextPapers, editor]);

    const filteredExtraPaperCandidates = extraPaperCandidates.filter((p) => {
        const q = extraPaperSearch.trim().toLowerCase();
        if (!q) return true;
        return String(p.title || '').toLowerCase().includes(q);
    });

    const renderElement = useCallback((props) => <Element {...props} />, []);
    const renderLeaf = useCallback((props) => <Leaf {...props} />, []);

    // 暴露插入 VibeCard 的方法给父组件
    useEffect(() => {
        if (onVibeCardInsert) {
            onVibeCardInsert((vibeCardData) => {
                insertVibeCardMention(editor, vibeCardData);
            });
        }
    }, [editor, onVibeCardInsert]);

    // 提取纯文本和 VibeCard 引用
    const extractContent = () => {
        const text = editor.children
            .map((node) => {
                return node.children
                    .map((child) => {
                        if (child.type === 'vibecard-mention') {
                            // 使用 name 而不是 id，确保与替换逻辑一致
                            return `@${child.vibeCardName || child.vibeCardId}`;
                        }
                        if (child.type === 'paper-mention') {
                            return `@${child.paperShortName || child.paperTitle || child.paperItemID}`;
                        }
                        return child.text || '';
                    })
                    .join('');
            })
            .join('\n');

        const vibeCardRefs = [];
        editor.children.forEach((node) => {
            node.children.forEach((child) => {
                if (child.type === 'vibecard-mention') {
                    vibeCardRefs.push({
                        id: child.vibeCardId,
                        name: child.vibeCardName || child.vibeCardId
                    });
                }
            });
        });

        return { text, vibeCardRefs };
    };

    // 检查编辑器是否为空（包括图片）
    const isEditorEmpty = () => {
        const { text, vibeCardRefs } = extractContent();
        return !text.trim() && vibeCardRefs.length === 0 && attachedImages.length === 0;
    };

    // 处理图片选择（经 Edge Function 上传到阿里云 OSS，见 imageR2Uploader.js）
    const handleImageSelect = useCallback(async (imageData) => {
        if (!visionCapable) {
            antMessage.warning(
                zoteroL10n('vibe-ai-chat-multimodal-not-supported', {
                    model: currentModel?.label || currentModel?.key || '',
                })
            );
            return;
        }
        // console.log('[SlateInput] 图片已选择:', imageData.type, imageData.name);

        // 显示上传中的提示
        const hideLoading = antMessage.loading(zoteroL10n('vibe-ai-chat-uploading-image'), 0);

        try {
            const uploadResult = await uploadImageToOss(imageData.base64, imageData.name);

            // 保存图片信息（OSS 公开 URL + object key；字段名 r2* 为历史兼容）
            const imageWithUrl = {
                ...imageData,
                r2Url: uploadResult.url,      // 阿里云 OSS 公开 URL（发给多模态 API）
                r2Key: uploadResult.key,      // OSS object key
                base64: imageData.base64       // 保留 base64（用于本地显示）
            };

            setAttachedImages(prev => [...prev, imageWithUrl]);
            hideLoading();
            antMessage.success(zoteroL10n('vibe-ai-chat-image-upload-success'));

        } catch (error) {
            console.error('[SlateInput] Image upload failed:', error);
            hideLoading();
            antMessage.error(
                zoteroL10n('vibe-ai-chat-image-upload-failed', { error: error?.message || '' })
            );
        }
    }, [visionCapable, currentModel?.label, currentModel?.key]);

    // 移除图片
    const handleImageRemove = useCallback((index) => {
        setAttachedImages(prev => prev.filter((_, i) => i !== index));
    }, []);

    /** 从 MIME 取上传用扩展名（与剪贴板/截图常见类型一致） */
    const extFromImageMime = useCallback((mime) => {
        if (!mime || !mime.startsWith('image/')) return 'png';
        const sub = mime.slice('image/'.length).toLowerCase();
        if (sub === 'jpeg') return 'jpg';
        return sub.replace(/[^a-z0-9]/g, '') || 'png';
    }, []);

    // Ctrl/Cmd+V 粘贴图片：与上传/截图同一路径（uploadImageToOss → attachedImages）
    const handlePaste = useCallback(
        async (event) => {
            const dt = event.clipboardData;
            if (!dt) return;

            const imageFiles = [];
            const seen = new Set();
            const pushFile = (file) => {
                if (!file || !file.type?.startsWith('image/')) return;
                // 避免同一 Blob 在 items + files 里重复
                const key = `${file.size}:${file.type}:${file.lastModified}`;
                if (seen.has(key)) return;
                seen.add(key);
                imageFiles.push(file);
            };

            if (dt.items?.length) {
                for (let i = 0; i < dt.items.length; i++) {
                    const item = dt.items[i];
                    if (item.kind === 'file' && item.type?.startsWith('image/')) {
                        const f = item.getAsFile();
                        pushFile(f);
                    }
                }
            }
            if (dt.files?.length) {
                for (let i = 0; i < dt.files.length; i++) {
                    pushFile(dt.files[i]);
                }
            }

            if (imageFiles.length === 0) return;

            event.preventDefault();
            event.stopPropagation();

            const maxBytes = 10 * 1024 * 1024;
            for (let i = 0; i < imageFiles.length; i++) {
                const file = imageFiles[i];
                if (file.size > maxBytes) {
                    antMessage.error(zoteroL10n('vibe-ai-chat-image-too-large'));
                    continue;
                }
                let base64;
                try {
                    base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target?.result);
                        reader.onerror = () => reject(new Error(zoteroL10n('vibe-ai-chat-image-read-failed')));
                        reader.readAsDataURL(file);
                    });
                } catch (err) {
                    console.error('[SlateInput] Failed to read pasted image:', err);
                    antMessage.error(err?.message || zoteroL10n('vibe-ai-chat-image-read-failed'));
                    continue;
                }
                if (!base64) continue;

                const ext = extFromImageMime(file.type);
                const safeName =
                    file.name && String(file.name).trim()
                        ? file.name
                        : `paste_${Date.now()}_${i}.${ext}`;

                await handleImageSelect({
                    base64,
                    file,
                    type: 'paste',
                    name: safeName,
                });
            }
        },
        [extFromImageMime, handleImageSelect]
    );

    // 内部提交状态，防止快速重复点击导致的竞态问题
    // 使用 useRef 而非 useState，因为 ref 更新是同步的，可以立即阻止第二次回车
    const submittingRef = useRef(false);

    // 处理发送
    const handleSubmit = useCallback(async () => {
        // 防止重复提交：检查 loading (父组件状态) 和 submittingRef (本地同步锁)
        if (isEditorEmpty() || loading || submittingRef.current) return;

        // 立即设置本地提交状态（同步更新，立即生效）
        submittingRef.current = true;

        try {
            // 基本检查：只做同步的快速检查，耗时检查（如余额）移到父组件
            const Zotero = window.Zotero || window.parent?.Zotero || window.top?.Zotero;
            if (!Zotero || !Zotero.VibeDBSync) {
                console.error('[SlateInput/handleSubmit] Cannot access Zotero.VibeDBSync');
                antMessage.error(zoteroL10n('vibe-ai-chat-system-error-restart'));
                return;
            }

            // 1. 检查登录状态（同步检查，不阻塞）
            // 使用 VibeDBSync.ensureLoggedIn 统一处理（它会自动尝试打开登录面板）
            if (Zotero.VibeDBSync.ensureLoggedIn && !Zotero.VibeDBSync.ensureLoggedIn()) {
                antMessage.warning(zoteroL10n('vibe-ai-chat-login-required'));
                return;
            }

            // 提取内容
            const { text, vibeCardRefs } = extractContent();

            // 先保存当前的图片数组（避免被清空前就丢失）
            const imagesToSend = [...attachedImages];

            // 立即清空 UI（提升用户体验，不等待 onSubmit 返回）
            Transforms.delete(editor, {
                at: {
                    anchor: Editor.start(editor, []),
                    focus: Editor.end(editor, []),
                },
            });
            setAttachedImages([]);

            // 调用父组件的 onSubmit（父组件会设置 loading 状态并进行余额检查）
            // 注意：不再等待结果，让父组件处理后续逻辑
            onSubmit(text, vibeCardRefs, imagesToSend, extraContextPapers);

        } catch (e) {
            console.error('[SlateInput] handleSubmit execution failed:', e);
            antMessage.error(zoteroL10n('vibe-ai-chat-send-failed', { error: e?.message || '' }));
        } finally {
            submittingRef.current = false;
        }
    }, [loading, attachedImages, editor, onSubmit, extraContextPapers]);

    // 处理键盘事件
    const handleKeyDown = useCallback(
        (event) => {
            const isCtrlArrow =
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);

            if (isCtrlArrow) {
                event.preventDefault();

                const { selection } = editor;
                if (!selection) {
                    return;
                }

                if (event.key === 'ArrowUp') {
                    Transforms.select(editor, Editor.start(editor, []));
                    return;
                }

                if (event.key === 'ArrowDown') {
                    Transforms.select(editor, Editor.end(editor, []));
                    return;
                }

                const blockEntry = Editor.above(editor, {
                    at: selection,
                    match: (node) => Editor.isBlock(editor, node),
                });

                if (!blockEntry) {
                    return;
                }

                const [, blockPath] = blockEntry;
                const targetPoint =
                    event.key === 'ArrowLeft'
                        ? Editor.start(editor, blockPath)
                        : Editor.end(editor, blockPath);

                Transforms.select(editor, targetPoint);
                return;
            }

            // Enter 提交（Shift+Enter 换行）
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                // 禁用状态下不允许提交（检查 loading 和 submittingRef）
                // submittingRef.current 是同步值，可以立即阻止第二次回车
                if (loading || submittingRef.current || isEditorEmpty()) {
                    return;
                }
                handleSubmit();
            }
        },
        [editor, loading, handleSubmit]
    );

    // 处理拖拽放置事件（VibeCard 引用）
    const handleDrop = useCallback(
        (event) => {
            // 检查是否是 VibeCard 拖拽
            const vibeCardData = event.dataTransfer.getData('application/x-zotero-vibecard-reference');
            if (vibeCardData) {
                event.preventDefault();
                event.stopPropagation();

                try {
                    const data = JSON.parse(vibeCardData);
                    // console.log('[SlateInput] VibeCard dropped:', data);

                    if (data.vibeCardId) {
                        // 插入 VibeCard mention
                        insertVibeCardMention(editor, {
                            id: data.vibeCardId,
                            name: data.vibeCardName || data.vibeCardId,
                            type: data.type,
                            vibeCardType: data.vibeCardType
                        });
                        // console.log('[SlateInput] VibeCard mention inserted:', data);
                    }
                } catch (error) {
                    console.error('[SlateInput] Error parsing VibeCard drop data:', error);
                }
            }
            // 如果不是 VibeCard，让浏览器处理默认的文本拖拽
        },
        [editor]
    );

    // 处理拖拽悬停事件
    const handleDragOver = useCallback(
        (event) => {
            // 检查是否是 VibeCard 拖拽
            const types = event.dataTransfer.types;
            if (types.includes('application/x-zotero-vibecard-reference')) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'copy';
            }
        },
        []
    );

    const handleChange = useCallback(
        (newValue) => {
            setValue(newValue);

            if (onChangeExtraContextPapers && extraContextPapers.length > 0) {
                const mentionedPaperIDs = new Set();
                newValue.forEach((node) => {
                    (node.children || []).forEach((child) => {
                        if (child?.type === 'paper-mention' && child.paperItemID != null) {
                            mentionedPaperIDs.add(String(child.paperItemID));
                        }
                    });
                });

                const nextSelectedPapers = extraContextPapers.filter((paper) =>
                    mentionedPaperIDs.has(String(paper.itemID))
                );

                if (nextSelectedPapers.length !== extraContextPapers.length) {
                    onChangeExtraContextPapers(nextSelectedPapers);
                }
            }
        },
        [onChangeExtraContextPapers, extraContextPapers]
    );

    const iconStyle = {
        fontSize: 18,
        color: token.colorText,
    };
    // 模型选择菜单（开源版：仅自定义模型；勾选在标签行右侧，不占左侧 icon 位）
    const customConfigsList = getCustomModelConfigs();

    const handleModelSelect = ({ key }) => {
        if (key === '__custom_manage__') {
            setIsConfigModalOpen(true);
            return;
        }
        const config = customConfigsList.find(c => c.id === key);
        if (config) {
            setSelectedConfigId(config.id);
            if (onModelChange) {
                onModelChange({
                    key: 'custom',
                    label: formatCustomModelLabel(config.modelName || config.name),
                    configId: config.id,
                    config
                });
            }
        }
    };

    const displayModel = (() => {
        if (currentModel?.key === 'custom' && currentModel?.configId) {
            const cfg = getCustomModelConfigById(currentModel.configId);
            return cfg
                ? formatCustomModelLabel(cfg.modelName || cfg.name)
                : (currentModel?.label || zoteroL10n('vibe-ai-chat-custom-model-fallback'));
        }
        return currentModel?.label || zoteroL10n('vibe-ai-chat-custom-model-fallback');
    })();

    const selectedMenuKey = currentModel?.key === 'custom'
        ? (currentModel.configId || getSelectedConfigId() || customConfigsList[0]?.id || '__custom_manage__')
        : (customConfigsList[0]?.id || '__custom_manage__');

    const toolbarBrandIcon = (
        <img src={modelIcon} alt="" style={{ width: TOOLBAR_ICON_PX, height: TOOLBAR_ICON_PX, marginRight: 4, objectFit: 'contain' }} />
    );

    // 仅当选中项 key 确实在菜单中存在时交给 antd，避免出现「双高亮」
    const selectableMenuKeysSet = new Set(customConfigsList.map((c) => c.id));
    const menuSelectedKeys =
        selectedMenuKey && selectableMenuKeysSet.has(selectedMenuKey) ? [selectedMenuKey] : [];

    const dropdownModelItems = [
        ...customConfigsList.map((c) => {
            const customLabel = formatCustomModelLabel(c.modelName || c.name);
            return {
                key: c.id,
                label: (
                    <Flex align="center" gap={6} style={{ minWidth: 0, maxWidth: 280 }} title={customLabel}>
                        <span
                            style={{
                                width: MENU_SLOT_PX,
                                height: MENU_SLOT_PX,
                                flexShrink: 0,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <img src={modelIcon} alt="" style={{ width: 14, height: 14, objectFit: 'contain' }} />
                        </span>
                        <span
                            style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 12,
                                lineHeight: 1.25,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {customLabel}
                        </span>
                        <span
                            style={{
                                width: 18,
                                flexShrink: 0,
                                textAlign: 'right',
                                fontSize: 12,
                                color: token.colorPrimary,
                            }}
                        >
                            {selectedMenuKey === c.id ? '✓' : ''}
                        </span>
                    </Flex>
                ),
                disabled: false,
            };
        }),
        ...(customConfigsList.length > 0 ? [{ type: 'divider' }] : []),
        {
            key: '__custom_manage__',
            label: (
                <Flex justify="space-between" align="center" style={{ width: '100%', minWidth: 160 }}>
                    <span>{zoteroL10n('vibe-ai-chat-manage-custom-models')}</span>
                    <SettingOutlined style={{ fontSize: 14 }} />
                </Flex>
            ),
            disabled: false,
        },
    ];

    return (
        <div
            style={{
                background: 'var(--material-background, #ffffff)',
                border: '1px solid var(--fill-quinary, #e0e0e0)',
                borderRadius: '8px',
                transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            className="slate-sender-container"
        >
            {/* 图片预览区域 */}
            <ImagePreview
                images={attachedImages}
                onRemove={handleImageRemove}
            />

            {/* Slate 编辑器区域 */}
            <div style={{ padding: '8px 12px' }}>
                <Slate editor={editor} initialValue={value} onChange={handleChange}>
                    <Editable
                        renderElement={renderElement}
                        renderLeaf={renderLeaf}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        placeholder={zoteroL10n('vibe-ai-chat-input-placeholder')}
                        disabled={loading}
                        style={{
                            minHeight: '36px',
                            maxHeight: '120px',
                            fontSize: '14px',
                            color: 'var(--fill-primary, #333)',
                            outline: 'none',
                            overflowY: 'auto',
                            lineHeight: '1.5',
                        }}
                    />
                </Slate>
            </div>

            {/* Footer 工具栏 */}
            <div
                style={{
                    padding: '8px 12px',
                    borderTop: '1px solid var(--fill-quinary, #f0f0f0)',
                }}
            >
                <Flex justify="space-between" align="center" style={{ minWidth: 0, gap: 8 }}>
                    {/* 左侧工具：minWidth:0 避免长模型名把整行挤出视口 */}
                    <Flex gap="small" align="center" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                        {/* 图片上传和截图按钮 */}
                        <ImageUploader
                            onImageSelect={handleImageSelect}
                            iconStyle={iconStyle}
                            disabled={!visionCapable}
                            disabledTitle={zoteroL10n('vibe-ai-chat-multimodal-not-supported', {
                                model: currentModel?.label || currentModel?.key || '',
                            })}
                        />
                        <Dropdown
                            open={isExtraPaperPickerOpen}
                            onOpenChange={(open) => {
                                setIsExtraPaperPickerOpen(open);
                                if (open) {
                                    openExtraPaperPicker();
                                }
                            }}
                            trigger={['click']}
                            placement="topCenter"
                            getPopupContainer={(triggerNode) => (triggerNode?.ownerDocument || document).body}
                            popupRender={() => (
                                <div
                                    className="extra-paper-dropdown-panel"
                                    style={{
                                        width: 'min(280px, 92vw)',
                                        maxWidth: 'min(320px, 96vw)',
                                        background: 'var(--material-background, #fff)',
                                        border: '1px solid var(--fill-quinary, #e8e8e8)',
                                        borderRadius: 8,
                                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                                        padding: 8,
                                        boxSizing: 'border-box',
                                    }}
                                >
                                    <Flex vertical gap={8}>
                                        <Input
                                            value={extraPaperSearch}
                                            onChange={(e) => setExtraPaperSearch(e.target.value)}
                                            placeholder={zoteroL10n('vibe-ai-chat-extra-paper-search-placeholder')}
                                            size="small"
                                        />
                                        <div
                                            style={{
                                                border: '1px solid var(--fill-quinary, #ececec)',
                                                borderRadius: 8,
                                                maxHeight: 260,
                                                overflowY: 'auto',
                                                background: 'var(--material-background, #fff)',
                                            }}
                                        >
                                            {extraPaperLoading ? (
                                                <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--fill-secondary, #888)' }}>
                                                    {zoteroL10n('vibe-ai-chat-extra-paper-loading')}
                                                </div>
                                            ) : filteredExtraPaperCandidates.length === 0 ? (
                                                <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--fill-secondary, #888)' }}>
                                                    {zoteroL10n('vibe-ai-chat-extra-paper-empty')}
                                                </div>
                                            ) : (
                                                filteredExtraPaperCandidates.map((paper, index) => {
                                                    const key = String(paper.itemID);
                                                    const checked = extraContextPapers.some((p) => String(p.itemID) === key);
                                                    return (
                                                        <label
                                                            key={key}
                                                            style={{
                                                                display: 'flex',
                                                                gap: 8,
                                                                alignItems: 'flex-start',
                                                                padding: '9px 10px',
                                                                cursor: 'pointer',
                                                                borderBottom: index < filteredExtraPaperCandidates.length - 1 ? '1px solid var(--fill-quinary, #f1f1f1)' : 'none',
                                                                background: checked ? 'var(--material-sidepane, #f7f7f7)' : 'transparent',
                                                            }}
                                                        >
                                                            <Checkbox checked={checked} onChange={() => toggleExtraPaperSelection(paper)} />
                                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                                <div
                                                                    title={paper.title}
                                                                    style={{
                                                                        fontSize: 12,
                                                                        lineHeight: 1.35,
                                                                        color: 'var(--fill-primary, #222)',
                                                                        wordBreak: 'break-word',
                                                                    }}
                                                                >
                                                                    {paper.title}
                                                                </div>
                                                                <div style={{ marginTop: 3, fontSize: 11, color: 'var(--fill-secondary, #888)' }}>
                                                                    {zoteroL10n('vibe-ai-chat-extra-paper-pages-and-cost', {
                                                                        pages: paper.pageCount || 0,
                                                                        cost: paper.extraContextCost || 0
                                                                    })}
                                                                </div>
                                                            </div>
                                                        </label>
                                                    );
                                                })
                                            )}
                                        </div>
                                        <span style={{ fontSize: 12, color: 'var(--fill-secondary, #888)', padding: '2px 2px 0' }}>
                                            {zoteroL10n('vibe-ai-chat-extra-paper-selected-cost', {
                                                count: extraContextPapers.length,
                                                cost: extraContextCost
                                            })}
                                        </span>
                                    </Flex>
                                </div>
                            )}
                            >
                            <Button
                                type="text"
                                title={zoteroL10n('vibe-ai-chat-extra-paper-title')}
                                style={{
                                    ...iconStyle,
                                    position: 'relative',
                                    width: 32,
                                    height: 32,
                                    minWidth: 32,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Badge count={selectedExtraPaperCount > 0 ? formatBadgeCount(selectedExtraPaperCount) : 0} size="small" offset={[0, 2]}>
                                    <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 600, display: 'inline-block', transform: 'translateY(-1px)' }}>@</span>
                                </Badge>
                            </Button>
                        </Dropdown>
                        <Dropdown
                            placement="bottomCenter"
                            getPopupContainer={(triggerNode) =>
                                (triggerNode?.ownerDocument || document).body
                            }
                            menu={{
                                items: dropdownModelItems,
                                onClick: handleModelSelect,
                                className: 'model-dropdown-menu',
                                selectedKeys: menuSelectedKeys
                            }}
                            trigger={['click']}
                        >
                            <Button
                                type="text"
                                style={{
                                    ...iconStyle,
                                    flexShrink: 1,
                                    minWidth: 0,
                                    maxWidth: '100%',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                }}
                                title={zoteroL10n('vibe-ai-chat-current-model-title', { model: displayModel })}
                            >
                                <span
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        minWidth: 0,
                                        maxWidth: '100%',
                                        flex: 1,
                                    }}
                                >
                                    {toolbarBrandIcon}
                                    <span
                                        style={{
                                            marginRight: 4,
                                            fontSize: 14,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            minWidth: 0,
                                        }}
                                    >
                                        {displayModel}
                                    </span>
                                </span>
                                <DownOutlined style={{ fontSize: 12, flexShrink: 0 }} />
                            </Button>
                        </Dropdown>
                    </Flex>

                    {/* 右侧工具 */}
                    <Flex align="center" gap="small">
                        <Button
                            className="btn-black"
                            icon={<SendOutlined />}
                            loading={loading}
                            disabled={isEditorEmpty()}
                            onClick={handleSubmit}
                        >
                            Send
                        </Button>
                    </Flex>
                </Flex>
            </div>

            {/* 自定义模型配置弹窗（多配置管理）— 白卡片风格，参考 WorkBuddy「添加模型」 */}
            <Modal
                title={null}
                open={isConfigModalOpen}
                onCancel={() => { setIsConfigModalOpen(false); setEditingConfigId(null); setTestResult(null); form.resetFields(); }}
                footer={[
                    <Button key="test" onClick={handleTestConnection} loading={testingConnection}>
                        {testingConnection
                            ? zoteroL10n('vibe-ai-chat-testing')
                            : zoteroL10n('vibe-ai-chat-test-connection')}
                    </Button>,
                    <Button key="close" onClick={() => { setIsConfigModalOpen(false); setEditingConfigId(null); setTestResult(null); form.resetFields(); }}>
                        {zoteroL10n('vibe-ai-chat-button-close')}
                    </Button>,
                    <Button key="ok" type="primary" onClick={handleSaveConfig}>
                        {editingConfigId ? zoteroL10n('vibe-ai-chat-button-update') : zoteroL10n('vibe-ai-chat-button-add')}
                    </Button>,
                ]}
                destroyOnClose
                zIndex={10001}
                centered
                getContainer={false}
                closable={false}
                wrapClassName="ai-chat-modal custom-config-modal"
                width={600}
            >
                {/* 自定义头部：标题 + 协议标签 + 关闭按钮（默认 header 被全局隐藏） */}
                <div className="config-modal-header">
                    <span className="config-modal-title">{zoteroL10n('vibe-ai-chat-custom-model-settings-title')}</span>
                    <span className="config-modal-tag">{zoteroL10n('vibe-ai-chat-modal-support-tag')}</span>
                    <button
                        type="button"
                        className="config-modal-close"
                        onClick={() => { setIsConfigModalOpen(false); setEditingConfigId(null); setTestResult(null); form.resetFields(); }}
                    >
                        <CloseOutlined />
                    </button>
                </div>
                {/* 单列布局：已保存配置在上（无配置时只留添加按钮），表单在下 —— 适配窄侧栏 */}
                <div style={{ marginBottom: 0 }}>
                    <div style={{ marginBottom: 14 }}>
                        {customConfigs.length > 0 && (
                            <>
                                <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13 }}>{zoteroL10n('vibe-ai-chat-saved-configurations')}</div>
                                <div style={{
                                    border: '1px solid #e8e8e8',
                                    borderRadius: 8,
                                    maxHeight: 132,
                                    overflowY: 'auto',
                                    background: '#ffffff',
                                    marginBottom: 8
                                }}>
                                    {customConfigs.map((c) => (
                                        <div
                                            key={c.id}
                                            className="custom-config-row"
                                            onClick={() => handleSelectConfigToEdit(c)}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: '10px 12px',
                                                borderBottom: customConfigs.indexOf(c) < customConfigs.length - 1 ? '1px solid #f0f0f0' : 'none',
                                                cursor: 'pointer',
                                                background: editingConfigId === c.id ? '#f0f0f0' : '#ffffff'
                                            }}
                                        >
                                            <span style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {getConfigDisplayName(c)}
                                            </span>
                                            <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); handleDeleteConfig(c); }} className="custom-config-delete-btn" style={{ padding: '0 6px', flexShrink: 0 }} />
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                        <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddConfig} style={{ width: '100%' }}>
                            {zoteroL10n('vibe-ai-chat-add-configuration')}
                        </Button>
                    </div>
                    <div
                        className={addFormFlash ? 'custom-config-form-pane custom-config-form-flash' : 'custom-config-form-pane'}
                    >
                        <Form form={form} layout="vertical" preserve={false} initialValues={{ apiFormat: 'openai' }}>
                            {/* 供应商快捷选择（参考 epsilon/Mrite）：一键填入地址与模型，只需再填 Key */}
                            <div style={{ marginBottom: 12 }}>
                                <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 12, color: '#555555' }}>
                                        {zoteroL10n('vibe-ai-chat-provider-quick-pick')}
                                    </span>
                                    {(() => {
                                        const activeProvider = MODEL_PROVIDERS.find((p) => p.key === activeProviderKey);
                                        return activeProvider && activeProvider.docsUrl ? (
                                            <a
                                                style={{ fontSize: 12, color: '#4072e5', cursor: 'pointer' }}
                                                onClick={() => openExternalUrl(activeProvider.docsUrl)}
                                            >
                                                {zoteroL10n('vibe-ai-chat-view-docs')}
                                            </a>
                                        ) : null;
                                    })()}
                                </div>
                                <Flex wrap="wrap" gap={6}>
                                    {MODEL_PROVIDERS.map((p) => (
                                        <Button
                                            key={p.key}
                                            size="small"
                                            type={activeProviderKey === p.key ? 'primary' : 'default'}
                                            onClick={() => applyProviderPreset(p)}
                                        >
                                            {p.name}
                                        </Button>
                                    ))}
                                </Flex>
                            </div>
                            <Form.Item
                                label={zoteroL10n('vibe-ai-chat-api-base-url')}
                                required
                                tooltip={zoteroL10n('vibe-ai-chat-api-base-url-row-tooltip')}
                            >
                                <Flex gap={8} align="center" style={{ width: '100%' }}>
                                    <Form.Item name="apiFormat" noStyle initialValue="openai" rules={[{ required: true }]}>
                                        <Select
                                            style={{ width: 152, flexShrink: 0 }}
                                            popupMatchSelectWidth={false}
                                            getPopupContainer={(trigger) => trigger.parentElement}
                                            options={[
                                                { value: 'openai', label: zoteroL10n('vibe-ai-chat-api-format-label-openai') },
                                                { value: 'anthropic', label: zoteroL10n('vibe-ai-chat-api-format-label-anthropic') }
                                            ]}
                                        />
                                    </Form.Item>
                                    <Form.Item name="baseUrl" noStyle rules={[{ required: true }]} style={{ flex: 1, minWidth: 0 }}>
                                        <Input
                                            placeholder={
                                                apiFormatForUrlPlaceholder === 'anthropic'
                                                    ? zoteroL10n('vibe-ai-chat-api-base-url-placeholder-anthropic')
                                                    : zoteroL10n('vibe-ai-chat-api-base-url-placeholder-openai')
                                            }
                                        />
                                    </Form.Item>
                                </Flex>
                            </Form.Item>
                            <Form.Item
                                label={zoteroL10n('vibe-ai-chat-api-key-shared')}
                                name="apiKey"
                                rules={[{ required: true }]}
                                tooltip={zoteroL10n('vibe-ai-chat-api-key-tooltip')}
                            >
                                <Input.Password placeholder={zoteroL10n('vibe-ai-chat-api-key-placeholder')} autoComplete="off" />
                            </Form.Item>
                            <Form.Item
                                label={zoteroL10n('vibe-ai-chat-model-name')}
                                name="modelName"
                                rules={[{ required: true }]}
                                tooltip={zoteroL10n('vibe-ai-chat-model-name-tooltip')}
                            >
                                {providerModelOptions.length > 0 ? (
                                    /* 已知供应商：下拉选择（可搜索），选项来自该供应商的预设模型列表 */
                                    <Select
                                        showSearch
                                        allowClear
                                        placeholder={zoteroL10n('vibe-ai-chat-model-name-placeholder')}
                                        getPopupContainer={(trigger) => trigger.parentElement}
                                        options={providerModelOptions.map((m) => ({ value: m, label: m }))}
                                        filterOption={(input, option) =>
                                            String(option?.value || '').toLowerCase().includes(String(input).toLowerCase())
                                        }
                                    />
                                ) : (
                                    /* 自定义供应商：无预设列表，保留手动输入 */
                                    <Input placeholder={zoteroL10n('vibe-ai-chat-model-name-placeholder')} allowClear />
                                )}
                            </Form.Item>
                        </Form>
                        {/* 测试连接结果（成功绿 / 失败红，深字适配暗色弹窗） */}
                        {testResult && (
                            <div
                                style={{
                                    marginTop: 8,
                                    padding: '6px 10px',
                                    borderRadius: 6,
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    wordBreak: 'break-all',
                                    color: testResult.ok ? '#237804' : '#a8071a',
                                    background: testResult.ok ? '#f6ffed' : '#fff1f0',
                                    border: `1px solid ${testResult.ok ? '#b7eb8f' : '#ffa39e'}`,
                                }}
                            >
                                {testResult.ok ? '✅ ' : '❌ '}{testResult.msg}
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default SlateInputWithSender;
