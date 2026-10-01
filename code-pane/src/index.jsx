import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './styles.css';

// DeepWiki Proxy 服务地址 (Cloudflare Worker)
const DEEPWIKI_PROXY_URL = 'https://deepwiki-proxy.yuc430060.workers.dev';

// GitHub 图标 SVG
const GitHubIcon = ({ size = 48 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
);

// 刷新图标
const RefreshIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
);

// 外部链接图标
const ExternalLinkIcon = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 4 }}>
        <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
    </svg>
);

// 从 GitHub URL 提取 owner/repo
const extractRepoName = (url) => {
    if (!url) return null;
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\s\.#?]+)/);
    if (match) {
        return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
    }
    // 如果已经是 owner/repo 格式
    if (/^[^\/]+\/[^\/]+$/.test(url)) {
        return url;
    }
    return url;
};

// 通过父窗口打开外部链接（避免 iframe 中的链接问题）
const openExternalURL = (url) => {
    try {
        // 尝试通过 Zotero API 打开
        if (window.parent && window.parent.Zotero && window.parent.Zotero.launchURL) {
            window.parent.Zotero.launchURL(url);
            console.log('[CodePane] 通过 Zotero.launchURL 打开:', url);
            return;
        }

        // 备用方案：通过 postMessage 通知父窗口
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'openExternalURL', url }, '*');
            console.log('[CodePane] 通过 postMessage 请求打开:', url);
            return;
        }

        // 最后备用：直接打开（可能不工作）
        window.open(url, '_blank');
    } catch (error) {
        console.error('[CodePane] 打开外部链接失败:', error);
    }
};

// 自定义链接渲染器（拦截所有链接点击）
const LinkRenderer = ({ href, children }) => {
    const handleClick = (e) => {
        e.preventDefault();
        if (href) {
            openExternalURL(href);
        }
    };

    return (
        <a
            href={href}
            onClick={handleClick}
            style={{ cursor: 'pointer' }}
        >
            {children}
        </a>
    );
};

function CodePaneApp() {
    // GitHub 仓库信息
    const [repoInfo, setRepoInfo] = useState(null);
    const [loading, setLoading] = useState(false); // 改为 false，初始状态不是加载中
    const [hasReceivedRepo, setHasReceivedRepo] = useState(false); // 是否已接收过仓库信息

    // DeepWiki 文档状态
    const [wikiContent, setWikiContent] = useState('');
    const [wikiLoading, setWikiLoading] = useState(false);
    const [wikiError, setWikiError] = useState(null);
    const [proxyConnected, setProxyConnected] = useState(false);

    // 检查 DeepWiki 代理服务连接
    const checkProxyConnection = useCallback(async () => {
        try {
            const response = await fetch(`${DEEPWIKI_PROXY_URL}/api/health`);
            const data = await response.json();
            const connected = data.status === 'ok';
            setProxyConnected(connected);
            console.log('[CodePane] DeepWiki 代理状态:', data);
            return connected;
        } catch (error) {
            console.warn('[CodePane] DeepWiki 代理未连接:', error.message);
            setProxyConnected(false);
            return false;
        }
    }, []);

    // 加载 DeepWiki 完整文档内容
    const loadWikiContents = useCallback(async (repoUrl) => {
        if (!repoUrl) return;

        const repoName = extractRepoName(repoUrl);
        if (!repoName) {
            setWikiError('无法解析仓库地址');
            return;
        }

        setWikiLoading(true);
        setWikiError(null);
        setWikiContent('');

        try {
            console.log(`[CodePane] 加载 DeepWiki 完整文档: ${repoName}`);

            // 使用 /api/contents 获取完整文档内容
            const response = await fetch(`${DEEPWIKI_PROXY_URL}/api/contents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoName })
            });

            const data = await response.json();

            if (data.success) {
                setWikiContent(data.contents || '暂无文档');
                console.log('[CodePane] DeepWiki 文档加载成功，长度:', (data.contents || '').length);
            } else {
                setWikiError(data.error || '加载失败');
            }
        } catch (error) {
            console.error('[CodePane] DeepWiki 加载失败:', error);
            setWikiError(`连接失败: ${error.message}`);
        } finally {
            setWikiLoading(false);
        }
    }, []);

    // 监听字体大小调整消息
    useEffect(() => {
        try {
            const Zotero = window.parent?.Zotero;
            if (Zotero) {
                const callback = (scale) => {
                    console.log('[CodePane] Setting --panel-font-scale from Global:', scale);
                    document.documentElement.style.setProperty('--panel-font-scale', scale);
                };

                if (!Zotero._vibeFontScaleListeners) {
                    Zotero._vibeFontScaleListeners = [];
                }
                Zotero._vibeFontScaleListeners.push(callback);

                // 初始化应用当前值
                if (Zotero._vibeCurrentFontScale) {
                    callback(Zotero._vibeCurrentFontScale);
                }

                return () => {
                    if (Zotero._vibeFontScaleListeners) {
                        const idx = Zotero._vibeFontScaleListeners.indexOf(callback);
                        if (idx > -1) Zotero._vibeFontScaleListeners.splice(idx, 1);
                    }
                };
            }
        } catch (e) {
            console.error('[CodePane] Failed to verify Zotero global:', e);
        }
    }, []);

    // 初始化
    useEffect(() => {
        // 暴露 API 给父窗口
        window.codePaneAPI = {
            setGitHubRepo: async (info) => {
                console.log('[CodePane] 收到 GitHub 仓库信息:', info);
                setHasReceivedRepo(true); // 标记已接收过仓库信息
                setRepoInfo(info);
                setLoading(false);

                // 检查代理连接并自动加载文档
                const connected = await checkProxyConnection();
                if (connected && (info?.url || info?.name)) {
                    loadWikiContents(info.url || info.name);
                }
            },
            clearRepo: () => {
                setRepoInfo(null);
                setWikiContent('');
                setWikiError(null);
                setHasReceivedRepo(false); // 重置接收状态
                setLoading(false);
            }
        };

        console.log('[CodePane] ✓ API 已就绪');

        // 初始检查代理连接
        checkProxyConnection();

        // 不再需要超时处理，因为初始状态就是"尚未发现"
    }, [checkProxyConnection, loadWikiContents]);

    // 渲染加载状态
    if (loading) {
        return (
            <div className="code-pane-container">
                <div className="code-pane-loading">
                    <div className="loading-icon">🔍</div>
                    <div className="loading-text">Searching for GitHub repository...</div>
                </div>
            </div>
        );
    }

    // 渲染尚未接收到仓库地址的状态
    if (!hasReceivedRepo) {
        return (
            <div className="code-pane-container">
                <div className="code-pane-empty">
                    <div className="empty-icon">📦</div>
                    <div className="empty-text">尚未发现代码仓库地址</div>
                    <div className="empty-hint">正在等待论文中的 GitHub 仓库信息...</div>
                </div>
            </div>
        );
    }

    // 渲染未找到仓库（已接收但为空）
    if (!repoInfo) {
        return (
            <div className="code-pane-container">
                <div className="code-pane-empty">
                    <div className="empty-icon">📭</div>
                    <div className="empty-text">No GitHub repository found</div>
                    <div className="empty-hint">The paper may not have an associated code repository</div>
                </div>
            </div>
        );
    }

    // 渲染仓库信息和文档
    return (
        <div className="code-pane-container">
            {/* 仓库头部 */}
            <div className="code-pane-header">
                <GitHubIcon size={32} />
                <div className="repo-info">
                    <a
                        href={repoInfo.url}
                        onClick={(e) => {
                            e.preventDefault();
                            openExternalURL(repoInfo.url);
                        }}
                        className="repo-name"
                        style={{ cursor: 'pointer' }}
                    >
                        {repoInfo.name}
                        <ExternalLinkIcon />
                    </a>
                    {repoInfo.stars !== null && repoInfo.stars !== undefined && (
                        <span className="repo-stars">⭐ {repoInfo.stars}</span>
                    )}
                </div>
                <span className={`proxy-status ${proxyConnected ? 'connected' : 'disconnected'}`}>
                    {proxyConnected ? '● 已连接' : '○ 未连接'}
                </span>
            </div>

            {repoInfo.description && (
                <div className="repo-description">{repoInfo.description}</div>
            )}

            {/* 代理未连接提示 */}
            {!proxyConnected && (
                <div className="proxy-hint">
                    <p>DeepWiki 代理服务未运行</p>
                    <code>sh start_deepwiki_proxy.sh</code>
                    <button className="retry-btn" onClick={checkProxyConnection}>
                        重试连接
                    </button>
                </div>
            )}

            {/* 文档区域 */}
            {proxyConnected && (
                <div className="wiki-section">
                    <div className="section-header">
                        <span className="section-title">📚 DeepWiki Documentation</span>
                        <button
                            className="refresh-btn"
                            onClick={() => loadWikiContents(repoInfo.url || repoInfo.name)}
                            disabled={wikiLoading}
                            title="刷新文档"
                        >
                            <RefreshIcon />
                        </button>
                    </div>

                    <div className="wiki-content-area">
                        {wikiLoading && (
                            <div className="wiki-loading">
                                <div className="loading-spinner"></div>
                                <span>Loading documentation...</span>
                            </div>
                        )}

                        {wikiError && (
                            <div className="wiki-error">
                                <span>❌ {wikiError}</span>
                                <button
                                    className="retry-btn small"
                                    onClick={() => loadWikiContents(repoInfo.url || repoInfo.name)}
                                >
                                    重试
                                </button>
                            </div>
                        )}

                        {!wikiLoading && !wikiError && wikiContent && (
                            <div className="markdown-content">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        // 自定义链接渲染，拦截点击事件
                                        a: LinkRenderer
                                    }}
                                >
                                    {wikiContent}
                                </ReactMarkdown>
                            </div>
                        )}

                        {!wikiLoading && !wikiError && !wikiContent && (
                            <div className="wiki-placeholder">
                                <p>点击刷新按钮加载文档</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// 挂载 React 应用
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<CodePaneApp />);
    console.log('[CodePane] ✓ React 应用已挂载');
}
