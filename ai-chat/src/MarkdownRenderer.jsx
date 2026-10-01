import React from 'react';
import ReactMarkdown from 'react-markdown';
import ChatImageLightbox from './ChatImageLightbox';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import katex from 'katex';
import { normalizeMarkdown, preRenderMath } from '../../shared/markdownMath';
import 'highlight.js/styles/github.css'; // 代码高亮样式
import 'katex/dist/katex.min.css'; // 数学公式样式

const remarkPlugins = [remarkGfm];
const rehypePlugins = [
    rehypeRaw,
    rehypeHighlight,
];

const MarkdownRenderer = ({ content }) => {
    const processed = preRenderMath(normalizeMarkdown(content), katex);

    const components = {
        pre({ node, children, ...props }) {
            const codeChild = node?.children?.[0];
            const classNames = codeChild?.properties?.className || [];
            const classText = Array.isArray(classNames) ? classNames.join(' ') : classNames;
            const match = /language-([\w-]+)/.exec(classText || '');
            const lang = match ? match[1] : '';

            return (
                <div className="code-block-wrapper">
                    {lang ? <div className="code-block-lang">{lang}</div> : null}
                    <pre {...props}>{children}</pre>
                </div>
            );
        },
        code({ className, children, ...props }) {
            if (className) {
                return <code className={className} {...props}>{children}</code>;
            }

            return (
                <code className="inline-code" {...props}>
                    {children}
                </code>
            );
        },
        a({ children, href, ...props }) {
            return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                    {children}
                </a>
            );
        },
        table({ children, ...props }) {
            return (
                <div className="table-wrapper">
                    <table {...props}>{children}</table>
                </div>
            );
        },
        img({ src, alt, ...props }) {
            if (!src) {
                return null;
            }

            return (
                <ChatImageLightbox
                    src={src}
                    alt={typeof alt === 'string' ? alt : ''}
                    imgProps={props}
                />
            );
        },
    };

    return (
        <div className="markdown-content">
            <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                components={components}
                skipHtml={false}
            >
                {processed}
            </ReactMarkdown>
        </div>
    );
};

export default MarkdownRenderer;
