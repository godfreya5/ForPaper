import React from 'react';
import { Modal } from 'antd';

/**
 * 与输入框 ImagePreview 一致的大图弹窗，供聊天记录 ChatImageLightbox 等复用（无标题栏，仅保留关闭）
 */
export default function ImageLightboxModal({ open, onCancel, src, alt = '' }) {
    return (
        <Modal
            open={open}
            title={null}
            closable
            footer={null}
            onCancel={onCancel}
            centered
            width="auto"
            styles={{
                body: {
                    padding: 0,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    maxHeight: '80vh',
                    overflow: 'auto',
                },
            }}
        >
            <img
                alt={alt}
                src={src}
                style={{
                    maxWidth: '100%',
                    maxHeight: '75vh',
                    objectFit: 'contain',
                }}
            />
        </Modal>
    );
}
