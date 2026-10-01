import React, { useState } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import ImageLightboxModal from './ImageLightboxModal';
import { zoteroL10n } from './zoteroL10n';

/**
 * 图片预览组件 - 显示在输入框上方
 * 
 * @param {Array} images - 图片数组 [{ base64, name, type }]
 * @param {Function} onRemove - 移除图片回调，参数为 index
 */
const ImagePreview = ({ images = [], onRemove }) => {
    // 大图预览状态
    const [previewVisible, setPreviewVisible] = useState(false);
    const [previewImage, setPreviewImage] = useState('');
    const [previewAlt, setPreviewAlt] = useState('');

    if (!images || images.length === 0) return null;

    // 点击图片显示大图
    const handlePreview = (image) => {
        setPreviewImage(image.base64);
        setPreviewAlt(
            image.name
            || (image.type === 'screenshot'
                ? zoteroL10n('vibe-ai-chat-screenshot-label')
                : zoteroL10n('vibe-ai-chat-image-label'))
        );
        setPreviewVisible(true);
    };

    // 关闭大图预览
    const handleCancel = () => {
        setPreviewVisible(false);
    };

    return (
        <>
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--fill-quinary, #f0f0f0)',
                }}
            >
                {images.map((image, index) => (
                    <div
                        key={index}
                        style={{
                            position: 'relative',
                            // 外层容器留出关闭按钮的空间
                            padding: '6px 6px 0 0',
                        }}
                    >
                        {/* 图片容器 */}
                        <div
                            style={{
                                position: 'relative',
                                width: 64,
                                height: 64,
                                borderRadius: 8,
                                overflow: 'hidden',
                                border: '1px solid var(--fill-quinary, #e5e5e5)',
                                backgroundColor: '#f5f5f5',
                                cursor: 'pointer',
                                transition: 'transform 0.2s, box-shadow 0.2s',
                            }}
                            onClick={() => handlePreview(image)}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.transform = 'scale(1.02)';
                                e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.transform = 'scale(1)';
                                e.currentTarget.style.boxShadow = 'none';
                            }}
                            title={zoteroL10n('vibe-ai-chat-click-view-large')}
                        >
                            <img
                                src={image.base64}
                                alt={image.name || 'preview'}
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    objectFit: 'cover',
                                }}
                            />
                            {/* 图片类型标签 */}
                            {image.type === 'screenshot' && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        bottom: 0,
                                        left: 0,
                                        right: 0,
                                        padding: '2px 4px',
                                        backgroundColor: 'rgba(0,0,0,0.5)',
                                        color: '#fff',
                                        fontSize: 10,
                                        textAlign: 'center',
                                    }}
                                >
                                    {zoteroL10n('vibe-ai-chat-screenshot-label')}
                                </div>
                            )}
                        </div>
                        
                        {/* 删除按钮 - 放在外层容器的右上角 */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove?.(index);
                            }}
                            style={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                width: 18,
                                height: 18,
                                padding: 0,
                                border: 'none',
                                borderRadius: '50%',
                                backgroundColor: 'rgba(0, 0, 0, 0.45)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'background-color 0.2s',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.45)';
                            }}
                            title={zoteroL10n('vibe-ai-chat-remove-image')}
                        >
                            <CloseOutlined style={{ fontSize: 10, color: '#fff' }} />
                        </button>
                    </div>
                ))}
            </div>

            <ImageLightboxModal
                open={previewVisible}
                onCancel={handleCancel}
                src={previewImage}
                alt={previewAlt}
            />
        </>
    );
};

export default ImagePreview;
