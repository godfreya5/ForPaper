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

export function getCurrentSupabaseConfig() {
    try {
        if (typeof window !== 'undefined' && window.ZoteroHelper?.getSupabaseConfig) {
            const config = window.ZoteroHelper.getSupabaseConfig();
            if (config && config.url) {
                return config;
            }
        }
    } catch (e) {
        console.error('[AIChatRuntime] Failed to read Supabase config:', e);
    }
    return null;
}

export function getOpenRouterProxyUrl() {
    const region = getVibeRegion();
    const config = getCurrentSupabaseConfig();

    if (region === 'global' && config?.url) {
        return `${config.url.replace(/\/$/, '')}/functions/v1/ai-chat-proxy-openrouter`;
    }

    if (region === 'cn') {
        return 'https://spb-t4nj7wrm82msmqf9.supabase.opentrust.net/functions/v1/ai-chat-proxy-openrouter-cn';
    }

    return 'https://spb-t4nj7wrm82msmqf9.supabase.opentrust.net/functions/v1/ai-chat-proxy-openrouter';
}
