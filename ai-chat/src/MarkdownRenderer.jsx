import React from 'react';
import ReactMarkdown from 'react-markdown';
import ChatImageLightbox from './ChatImageLightbox';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'highlight.js/styles/github.css'; // 代码高亮样式
import 'katex/dist/katex.min.css'; // 数学公式样式

/**
 * Markdown 渲染组件
 * 用于将 AI 返回的 Markdown 文本转换为格式化的 HTML
 * 支持：
 * - GitHub Flavored Markdown (表格、删除线等)
 * - LaTeX 数学公式 (行内: $...$ 或 \(...\), 块级: $$...$$ 或 \[...\])
 * - 代码高亮
 */
const MarkdownRenderer = ({ content }) => {
    return (
        <div className="markdown-content">
            <ReactMarkdown
                remarkPlugins={[
                    remarkGfm,  // GitHub Flavored Markdown
                    remarkMath  // 数学公式支持
                ]}
                rehypePlugins={[
                    // strict: 'ignore' 减少因 Unicode/部分 LaTeX 变体导致的硬失败；语法错误仍会走 rehype-katex 的降级分支
                    [rehypeKatex, { strict: 'ignore' }],
                    rehypeHighlight, // 代码高亮
                    rehypeRaw        // 支持 HTML
                ]}
                components={{
                    // 自定义代码块样式
                    code({ node, inline, className, children, ...props }) {
                        // 提取语言类型
                        const match = /language-(\w+)/.exec(className || '');
                        const lang = match ? match[1] : '';
                        
                        return inline ? (
                            <code className="inline-code" {...props}>
                                {children}
                            </code>
                        ) : (
                            <div className="code-block-wrapper">
                                {lang && <div className="code-block-lang">{lang}</div>}
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            </div>
                        );
                    },
                    // 自定义链接样式（在新标签页打开）
                    a({ node, children, href, ...props }) {
                        return (
                            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                                {children}
                            </a>
                        );
                    },
                    // 自定义表格样式
                    table({ node, children, ...props }) {
                        return (
                            <div className="table-wrapper">
                                <table {...props}>{children}</table>
                            </div>
                        );
                    },
                    // 优化 pre 标签（代码块容器）
                    pre({ node, children, ...props }) {
                        return <pre {...props}>{children}</pre>;
                    },
                    // Markdown 内图片：与输入区一致的可点击大图预览
                    img({ node, src, alt, ...props }) {
                        if (!src) return null;
                        return (
                            <ChatImageLightbox
                                src={src}
                                alt={typeof alt === 'string' ? alt : ''}
                                imgProps={props}
                            />
                        );
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
};

export default MarkdownRenderer;

