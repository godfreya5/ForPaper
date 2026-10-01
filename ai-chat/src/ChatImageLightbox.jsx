import React, { useState, useCallback } from 'react';
import ImageLightboxModal from './ImageLightboxModal';
import { zoteroL10n } from './zoteroL10n';

/**
 * 聊天记录内图片：单击弹窗放大（与输入框 ImagePreview 共用 ImageLightboxModal）
 */
export default function ChatImageLightbox({ src, alt = '', thumbnail = false, imgProps = {} }) {
    const [open, setOpen] = useState(false);
    const show = useCallback(() => {
        if (src) setOpen(true);
    }, [src]);
    const hide = useCallback(() => setOpen(false), []);

    if (!src) return null;

    return (
        <>
            <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                    e.stopPropagation();
                    show();
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        show();
                    }
                }}
                style={{
                    cursor: 'pointer',
                    display: 'inline-block',
                    maxWidth: thumbnail ? undefined : '100%',
                    lineHeight: 0,
                }}
                title={zoteroL10n('vibe-ai-chat-click-view-large')}
            >
                {thumbnail ? (
                    <img
                        src={src}
                        alt={alt}
                        style={{
                            maxWidth: 150,
                            maxHeight: 150,
                            borderRadius: 6,
                            objectFit: 'cover',
                            display: 'block',
                        }}
                    />
                ) : (
                    <img {...imgProps} src={src} alt={alt} style={{ maxWidth: '100%', height: 'auto', ...imgProps.style }} />
                )}
            </span>
            <ImageLightboxModal
                open={open}
                onCancel={hide}
                src={src}
                alt={alt || zoteroL10n('vibe-ai-chat-image-label')}
            />
        </>
    );
}
