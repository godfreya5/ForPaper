import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createEditor, Editor, Range, Transforms } from 'slate';
import { withHistory } from 'slate-history';
import { Editable, Slate, useFocused, useSelected, withReact } from 'slate-react';
import { SendOutlined, DownOutlined, SettingOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { Button, Flex, theme, Dropdown, message as antMessage, Modal, Form, Input, Select, Badge, Checkbox } from 'antd';
import { formatCustomModelLabel, zoteroL10n } from './zoteroL10n';
import modelIcon from '../icons/model.svg';
import doubaoLogo from '../icons/llm_logo/doubao.png';
import geminiStarLogo from '../icons/llm_logo/gemini.svg';
import wenTextOnlyMark from '../icons/llm_logo/wen.svg';
// 禁止从 '@lobehub/icons' 主入口导入（会连带 features → antd-style / react-layout-kit 等缺失依赖）
// OpenAI 默认导出即 Mono，与 `import { OpenAI } from '@lobehub/icons'` 的默认图标一致
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono';
import KimiColor from '@lobehub/icons/es/Kimi/components/Color';
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color';
import QwenColor from '@lobehub/icons/es/Qwen/components/Color';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color';
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color';
import ImageUploader from './ImageUploader';
import ImagePreview from './ImagePreview';
import { uploadImageToOss } from './imageR2Uploader';
import {
    getChatCreditsForPresetKey,
    getPageSurchargeCredits,
    getPresetTierBaseCredits,
} from './chatModelPricing';
import { presetSupportsVision } from './chatModelVision';
import { getVibeRegion } from './chatRuntimeConfig';

/** 同档内按 credits 从高到低，同价按标签排序（含页数阶梯） */
function sortPresetRowsByCreditsDesc(rows, pdfPageCount) {
    return [...rows].sort((a, b) => {
        const ca = getChatCreditsForPresetKey(a.key, pdfPageCount);
        const cb = getChatCreditsForPresetKey(b.key, pdfPageCount);
        if (cb !== ca) return cb - ca;
        return String(a.label).localeCompare(String(b.label), 'zh-Hans-CN');
    });
}

/** 下拉项更紧凑；工具栏略大 */
const MENU_ICON_PX = 16;
const MENU_SLOT_PX = 20;
const DOUBAO_MENU_IMG_PX = 20;
const TOOLBAR_ICON_PX = 18;
const TOOLBAR_DOUBAO_PX = 20;

const MONO_BRAND_COLOR = { chatgpt: '#000000', grok: '#1a1a1a' };

function normalizePresetLogoKey(menuKey) {
    if (menuKey === 'qwen3.5-plus') return 'qwen';
    if (menuKey === 'minimax-2.5') return 'minimax';
    if (menuKey === 'GLM-4.7') return 'zhipu';
    return menuKey;
}

/** 内置模型角标（菜单 / 工具栏共用） */
function renderPresetBrandLogo(menuKey, sizePx) {
    const k = normalizePresetLogoKey(menuKey);
    if (k === 'doubao') {
        const imgPx = sizePx >= TOOLBAR_ICON_PX ? TOOLBAR_DOUBAO_PX : DOUBAO_MENU_IMG_PX;
        return (
            <img
                src={doubaoLogo}
                alt=""
                style={{
                    width: imgPx,
                    height: imgPx,
                    objectFit: 'cover',
                    borderRadius: '50%',
                    display: 'block',
                }}
            />
        );
    }
    if (k === 'chatgpt') {
        return (
            <span style={{ color: MONO_BRAND_COLOR.chatgpt, display: 'inline-flex', lineHeight: 0 }}>
                <OpenAI size={sizePx} />
            </span>
        );
    }
    if (k === 'grok') {
        return (
            <span style={{ color: MONO_BRAND_COLOR.grok, display: 'inline-flex', lineHeight: 0 }}>
                <GrokMono size={sizePx} />
            </span>
        );
    }
    if (k === 'gemini') {
        // 本地 SVG 为四色渐变星标；Lobe 的 BrandColor 是横排「GEMINI」字标，缩略后易被裁成「星+emi」
        return (
            <img
                src={geminiStarLogo}
                alt=""
                style={{
                    width: sizePx,
                    height: sizePx,
                    objectFit: 'contain',
                    display: 'block',
                    flexShrink: 0,
                }}
            />
        );
    }
    const ColorIcon = {
        kimi: KimiColor,
        minimax: MinimaxColor,
        qwen: QwenColor,
        deepseek: DeepSeekColor,
        zhipu: ZhipuColor,
    }[k];
    return ColorIcon ? <ColorIcon size={sizePx} /> : null;
}

function renderMenuBrandIcon(menuKey) {
    return renderPresetBrandLogo(menuKey, MENU_ICON_PX);
}

function renderToolbarBrandIcon(menuKey) {
    if (normalizePresetLogoKey(menuKey) === 'doubao') {
        return (
            <span style={{ marginRight: 4, display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
                {renderPresetBrandLogo(menuKey, TOOLBAR_ICON_PX)}
            </span>
        );
    }
    const node = renderPresetBrandLogo(menuKey, TOOLBAR_ICON_PX);
    if (node) {
        return (
            <span style={{ marginRight: 4, display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
                {node}
            </span>
        );
    }
    return <img src={modelIcon} alt="" style={{ width: TOOLBAR_ICON_PX, height: TOOLBAR_ICON_PX, marginRight: 4, objectFit: 'contain' }} />;
}

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
    canUseAdvancedModels = false,
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
    }, [isConfigModalOpen, getCustomModelConfigs, getSelectedConfigId, form]);

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
                } else {
                    setEditingConfigId(null);
                    form.resetFields();
                    form.setFieldsValue({ apiFormat: 'openai' });
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
                        } else {
                            const next = configs[0];
                            setEditingConfigId(next.id);
                            form.setFieldsValue({
                                baseUrl: next.baseUrl,
                                apiKey: next.apiKey,
                                modelName: next.modelName,
                                apiFormat: next.apiFormat || 'openai'
                            });
                        }
                    }
                    antMessage.success(zoteroL10n('vibe-ai-chat-config-deleted'));
                }
            }
        });
    };

    const handleAddConfig = () => {
        const alreadyOnAddPage = editingConfigId === null;
        setEditingConfigId(null);
        form.resetFields();
        form.setFieldsValue({ apiFormat: 'openai' });
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
    const vibeRegion = getVibeRegion();
    const showDoubao = vibeRegion !== 'global';

    // 模型选择菜单（高级 / 标准分组；勾选在标签行右侧，不占左侧 icon 位）
    const customConfigsList = getCustomModelConfigs();
    const advancedModels = sortPresetRowsByCreditsDesc([
        { key: 'chatgpt', label: zoteroL10n('vibe-ai-chat-model-chatgpt') },
        { key: 'grok', label: zoteroL10n('vibe-ai-chat-model-grok') },
        { key: 'gemini', label: zoteroL10n('vibe-ai-chat-model-gemini') },
        { key: 'kimi', label: zoteroL10n('vibe-ai-chat-model-kimi') },
    ], pdfPageCount);
    // 标准组：多模态在前；纯文本（MiniMax-M2.5 / DeepSeek-V4-Flash / GLM-4.7）置底
    const standardModels = [
        ...sortPresetRowsByCreditsDesc([
            { key: 'qwen', label: zoteroL10n('vibe-ai-chat-model-qwen') },
            ...(showDoubao ? [{ key: 'doubao', label: zoteroL10n('vibe-ai-chat-model-doubao') }] : []),
        ], pdfPageCount),
        { key: 'minimax', label: zoteroL10n('vibe-ai-chat-model-minimax') },
        { key: 'deepseek', label: zoteroL10n('vibe-ai-chat-model-deepseek') },
        { key: 'zhipu', label: zoteroL10n('vibe-ai-chat-model-zhipu') },
    ];
    const presetModelsFlat = [...advancedModels, ...standardModels];

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
            return;
        }
        const preset = presetModelsFlat.find(r => r.key === key);
        if (preset && onModelChange) {
            onModelChange({ key: preset.key, label: preset.label });
        }
    };

    const displayModel = (() => {
        if (currentModel?.key === 'custom' && currentModel?.configId) {
            const cfg = getCustomModelConfigById(currentModel.configId);
            return cfg
                ? formatCustomModelLabel(cfg.modelName || cfg.name)
                : (currentModel?.label || zoteroL10n('vibe-ai-chat-custom-model-fallback'));
        }
        return currentModel?.label || zoteroL10n('vibe-ai-chat-model-gemini');
    })();

    const selectedMenuKey = currentModel?.key === 'custom'
        ? (currentModel.configId || getSelectedConfigId() || customConfigsList[0]?.id || '__custom_manage__')
        : (currentModel?.key || 'gemini');

    const toolbarBrandIcon =
        currentModel?.key === 'custom' && currentModel?.configId
            ? <img src={modelIcon} alt="" style={{ width: TOOLBAR_ICON_PX, height: TOOLBAR_ICON_PX, marginRight: 4, objectFit: 'contain' }} />
            : renderToolbarBrandIcon(currentModel?.key || 'gemini');

    // 仅当选中项 key 确实在菜单中存在时交给 antd，避免预设与自定义切换后出现「双高亮」
    const selectableMenuKeysSet = new Set([
        ...presetModelsFlat.map((r) => r.key),
        ...customConfigsList.map((c) => c.id),
    ]);
    const menuSelectedKeys =
        selectedMenuKey && selectableMenuKeysSet.has(selectedMenuKey) ? [selectedMenuKey] : [];

    const presetRowMenuItem = (row, { disabled: rowDisabled = false } = {}) => {
        const base = getPresetTierBaseCredits(row.key);
        const surcharge = getPageSurchargeCredits(pdfPageCount);
        const credits = base + surcharge;
        const creditsLabel =
            surcharge > 0 ? `${credits} (${base}+${surcharge})` : String(credits);
        return {
            key: row.key,
            disabled: rowDisabled,
            label: (
                <Flex align="center" gap={6} style={{ minWidth: 0, width: '100%' }}>
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
                        {renderMenuBrandIcon(row.key)}
                    </span>
                    <span
                        style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            lineHeight: 1.25,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            overflow: 'hidden',
                        }}
                    >
                        <span
                            style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                            }}
                        >
                            {row.label}
                        </span>
                        {!presetSupportsVision(row.key) ? (
                            <img
                                src={wenTextOnlyMark}
                                alt=""
                                aria-hidden
                                title={zoteroL10n('vibe-ai-chat-text-only-model-badge')}
                                style={{
                                    width: 13,
                                    height: 13,
                                    flexShrink: 0,
                                    objectFit: 'contain',
                                    opacity: 0.45,
                                    filter: 'grayscale(1)',
                                }}
                            />
                        ) : null}
                    </span>
                    <span
                        style={{
                            flexShrink: 0,
                            fontSize: 10,
                            lineHeight: 1.2,
                            color: token.colorTextQuaternary,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {creditsLabel} credits
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
                        {selectedMenuKey === row.key ? '✓' : ''}
                    </span>
                </Flex>
            ),
        };
    };

    const dropdownModelItems = [
        {
            type: 'group',
            label: (
                <span style={{ fontSize: 11, color: token.colorTextSecondary, fontWeight: 600 }}>
                    {zoteroL10n('vibe-ai-chat-model-tier-advanced')}
                    <span style={{ fontWeight: 400, color: token.colorTextQuaternary, marginLeft: 4 }}>
                        {zoteroL10n('vibe-ai-chat-model-tier-advanced-pro-only-suffix')}
                    </span>
                </span>
            ),
            children: advancedModels.map((row) =>
                presetRowMenuItem(row, { disabled: !canUseAdvancedModels })
            ),
        },
        {
            type: 'group',
            label: (
                <span style={{ fontSize: 11, color: token.colorTextSecondary, fontWeight: 600 }}>
                    {zoteroL10n('vibe-ai-chat-model-tier-standard')}
                </span>
            ),
            children: standardModels.map(presetRowMenuItem),
        },
        { type: 'divider' },
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
                        placeholder="Press Enter to send message"
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

            {/* 自定义模型配置弹窗（多配置管理） */}
            <Modal
                title={zoteroL10n('vibe-ai-chat-custom-model-settings-title')}
                open={isConfigModalOpen}
                onOk={handleSaveConfig}
                onCancel={() => { setIsConfigModalOpen(false); setEditingConfigId(null); form.resetFields(); }}
                okText={editingConfigId ? zoteroL10n('vibe-ai-chat-button-update') : zoteroL10n('vibe-ai-chat-button-add')}
                cancelText={zoteroL10n('vibe-ai-chat-button-close')}
                destroyOnClose
                zIndex={10001}
                centered
                getContainer={false}
                wrapClassName="ai-chat-modal"
                width={580}
            >
                <Flex gap="middle" align="flex-start" style={{ marginBottom: 0 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13 }}>{zoteroL10n('vibe-ai-chat-saved-configurations')}</div>
                        <div style={{
                            border: '1px solid var(--fill-quinary, #e8e8e8)',
                            borderRadius: 6,
                            maxHeight: 180,
                            overflowY: 'auto',
                            background: '#ffffff'
                        }}>
                            {customConfigs.map((c) => (
                                <div
                                    key={c.id}
                                    onClick={() => handleSelectConfigToEdit(c)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '10px 12px',
                                        borderBottom: customConfigs.indexOf(c) < customConfigs.length - 1 ? '1px solid var(--fill-quinary, #f0f0f0)' : 'none',
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
                        <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddConfig} style={{ marginTop: 8, width: '100%' }}>
                            {zoteroL10n('vibe-ai-chat-add-configuration')}
                        </Button>
                    </div>
                    <div
                        className={addFormFlash ? 'custom-config-form-pane custom-config-form-flash' : 'custom-config-form-pane'}
                        style={{ flex: 1.2, minWidth: 0 }}
                    >
                        <Form form={form} layout="vertical" preserve={false} initialValues={{ apiFormat: 'openai' }}>
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
                                <Input.Password placeholder={zoteroL10n('vibe-ai-chat-api-key-placeholder')} autoComplete="off" visibilityToggle={false} />
                            </Form.Item>
                            <Form.Item
                                label={zoteroL10n('vibe-ai-chat-model-name')}
                                name="modelName"
                                rules={[{ required: true }]}
                                tooltip={zoteroL10n('vibe-ai-chat-model-name-tooltip')}
                            >
                                <Input placeholder={zoteroL10n('vibe-ai-chat-model-name-placeholder')} />
                            </Form.Item>
                        </Form>
                    </div>
                </Flex>
            </Modal>
        </div>
    );
};

export default SlateInputWithSender;
