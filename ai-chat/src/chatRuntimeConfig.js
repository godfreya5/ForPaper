export function getRuntimeZotero() {
    return window.Zotero || window.parent?.Zotero || window.top?.Zotero;
}

export function getVibeRegion() {
    try {
        const Zotero = getRuntimeZotero();
        const region = String(Zotero?.Prefs?.get?.('vibeRegion') || 'cn').toLowerCase();
        return region === 'global' ? 'global' : 'cn';
    } catch (_) {
        return 'cn';
    }
}

/**
 * 开源版：网关地址从 Zotero prefs（vibeProxy.baseUrl）读取，默认为空。
 * 预设模型（OpenRouter / 百炼 / 豆包 / 全文总结）需要自建网关，未配置时返回 null，
 * 调用方应提示用户改用「自定义模型」直连自己的 API。
 */
export function getCurrentSupabaseConfig() {
    try {
        const Zotero = getRuntimeZotero();
        if (Zotero?.VibeDBSync?.getSupabaseConfig) {
            const config = Zotero.VibeDBSync.getSupabaseConfig();
            if (config && config.url) {
                return config;
            }
        }
        if (typeof window !== 'undefined' && window.ZoteroHelper?.getSupabaseConfig) {
            const config = window.ZoteroHelper.getSupabaseConfig();
            if (config && config.url) {
                return config;
            }
        }
    } catch (e) {
        console.error('[AIChatRuntime] Failed to read proxy config:', e);
    }
    return null;
}

export function getOpenRouterProxyUrl() {
    const config = getCurrentSupabaseConfig();
    if (!config?.url) {
        return null;
    }
    return `${config.url.replace(/\/$/, '')}/functions/v1/ai-chat-proxy-openrouter`;
}
