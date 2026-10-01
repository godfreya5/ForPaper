import React, { useRef, useState, useCallback, useEffect } from 'react';
import { PictureOutlined, ScissorOutlined } from '@ant-design/icons';
import { Button, message } from 'antd';
import { zoteroL10n } from './zoteroL10n';

/**
 * 图片上传和截图组件
 * 
 * 截图功能说明：
 * - 由于 AI Chat 运行在 iframe 中，无法直接访问父窗口 DOM
 * - 截图通过通知父窗口进入截图模式，由父窗口完成截图后回传结果
 * - 使用 postMessage 进行跨 iframe 通信
 * 
 * @param {Function} onImageSelect - 图片选择回调，参数为 { base64, file, type: 'upload' | 'screenshot' }
 * @param {Object} iconStyle - 图标样式
 */
const ImageUploader = ({ onImageSelect, iconStyle = {}, disabled = false, disabledTitle = '' }) => {
    const fileInputRef = useRef(null);
    const [isWaitingScreenshot, setIsWaitingScreenshot] = useState(false);

    // 处理文件选择
    const handleFileChange = useCallback((event) => {
        if (disabled) return;
        const file = event.target.files?.[0];
        if (!file) return;

        // 验证文件类型
        if (!file.type.startsWith('image/')) {
            message.error(zoteroL10n('vibe-ai-chat-select-image-file'));
            return;
        }

        // 验证文件大小（限制 10MB）
        if (file.size > 10 * 1024 * 1024) {
            message.error(zoteroL10n('vibe-ai-chat-image-too-large'));
            return;
        }

        // 读取为 base64
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target?.result;
            if (base64 && onImageSelect) {
                onImageSelect({
                    base64,
                    file,
                    type: 'upload',
                    name: file.name
                });
            }
        };
        reader.onerror = () => {
            message.error(zoteroL10n('vibe-ai-chat-image-read-failed'));
        };
        reader.readAsDataURL(file);

        // 清空 input，允许重复选择同一文件
        event.target.value = '';
    }, [onImageSelect, disabled]);

    // 触发文件选择
    const handleUploadClick = useCallback(() => {
        if (disabled) {
            if (disabledTitle) message.warning(disabledTitle);
            return;
        }
        fileInputRef.current?.click();
    }, [disabled, disabledTitle]);

    // 监听来自父窗口的截图结果
    useEffect(() => {
        const handleMessage = (event) => {
            // 处理截图结果
            if (event.data?.type === 'screenshot-result') {
                setIsWaitingScreenshot(false);
                
                if (event.data.success && event.data.base64) {
                    console.log('[ImageUploader] Screenshot result received');
                    if (onImageSelect) {
                        onImageSelect({
                            base64: event.data.base64,
                            type: 'screenshot',
                            name: `screenshot_${Date.now()}.png`,
                            width: event.data.width,
                            height: event.data.height
                        });
                    }
                    message.success(zoteroL10n('vibe-ai-chat-screenshot-success'));
                } else if (event.data.cancelled) {
                    console.log('[ImageUploader] Screenshot cancelled');
                } else {
                    message.error(
                        zoteroL10n('vibe-ai-chat-screenshot-failed', {
                            error: event.data.error || 'Unknown error',
                        })
                    );
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onImageSelect]);

    // 开始截图 - 通知父窗口进入截图模式
    const startScreenshot = useCallback(() => {
        if (disabled) {
            if (disabledTitle) message.warning(disabledTitle);
            return;
        }
        // 检查是否有父窗口的截图 API
        if (window.parent && window.parent !== window) {
            try {
                // 调试：打印可用的 API
                console.log('[ImageUploader] Checking parent-window Zotero object...');
                console.log('[ImageUploader] window.parent.Zotero:', !!window.parent.Zotero);
                console.log('[ImageUploader] window.parent.Zotero?.AIChat:', !!window.parent.Zotero?.AIChat);
                console.log('[ImageUploader] window.parent.Zotero?.AIChat?.startScreenshot:', !!window.parent.Zotero?.AIChat?.startScreenshot);
                
                // 尝试直接调用父窗口的截图 API
                if (window.parent.Zotero?.AIChat?.startScreenshot) {
                    console.log('[ImageUploader] Calling parent-window screenshot API');
                    setIsWaitingScreenshot(true);
                    window.parent.Zotero.AIChat.startScreenshot((result) => {
                        setIsWaitingScreenshot(false);
                        if (result.success && result.base64) {
                            if (onImageSelect) {
                                onImageSelect({
                                    base64: result.base64,
                                    type: 'screenshot',
                                    name: `screenshot_${Date.now()}.png`,
                                    width: result.width,
                                    height: result.height
                                });
                            }
                            message.success(zoteroL10n('vibe-ai-chat-screenshot-success'));
                        } else if (result.cancelled) {
                            console.log('[ImageUploader] Screenshot cancelled');
                        } else {
                            message.error(
                                zoteroL10n('vibe-ai-chat-screenshot-failed', {
                                    error: result.error || 'Unknown error',
                                })
                            );
                        }
                    });
                    return;
                }
                
                // API 不可用
                console.warn('[ImageUploader] Screenshot API unavailable');
                message.warning(zoteroL10n('vibe-ai-chat-screenshot-unavailable'));
                setIsWaitingScreenshot(false);
                
            } catch (error) {
                console.error('[ImageUploader] Unable to access parent window:', error);
                message.error(zoteroL10n('vibe-ai-chat-screenshot-unavailable'));
                setIsWaitingScreenshot(false);
            }
        } else {
            // 没有父窗口
            message.warning(zoteroL10n('vibe-ai-chat-screenshot-unsupported'));
        }
    }, [onImageSelect, disabled, disabledTitle]);

    return (
        <>
            {/* 隐藏的文件输入 */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />

            {/* 上传图片按钮 */}
            <Button
                type="text"
                icon={<PictureOutlined />}
                onClick={handleUploadClick}
                title={disabled ? (disabledTitle || zoteroL10n('vibe-ai-chat-current-model-no-image')) : zoteroL10n('vibe-ai-chat-upload-image')}
                disabled={disabled}
                style={{ ...iconStyle, opacity: disabled ? 0.45 : 1 }}
            />

            {/* 截图按钮 */}
            <Button
                type="text"
                icon={<ScissorOutlined />}
                onClick={startScreenshot}
                loading={isWaitingScreenshot}
                title={disabled ? (disabledTitle || zoteroL10n('vibe-ai-chat-current-model-no-image')) : zoteroL10n('vibe-ai-chat-screenshot')}
                disabled={disabled}
                style={{ ...iconStyle, opacity: disabled ? 0.45 : 1 }}
            />
        </>
    );
};

export default ImageUploader;
