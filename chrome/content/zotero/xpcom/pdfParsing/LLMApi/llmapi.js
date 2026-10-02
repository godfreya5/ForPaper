/**
 * 测试调用智谱AI API的JavaScript代码
 * Test script for calling Zhipu AI API
 * 注意：API Key 已迁移到 Cloudflare Worker，客户端不再直接调用
 */

// 开源版：代理端点从 vibeDBSync（prefs vibeProxy.baseUrl）读取，默认为空。
// 需要全文总结/大纲等 LLM 后处理时，请先在 prefs 中配置自建网关地址（见 README「自建后端」章节）。
const API_CONFIG = {
  get proxyUrl() {
    const base = typeof Zotero !== 'undefined' && Zotero.VibeDBSync?.getSupabaseConfig()?.url || '';
    return `${base}/functions/v1/ai-summary-proxy-bailian`;
  }
};

const MODEL_NAME_MAP = {
  'GLM47': 'ep-20260119112302-q7rcg', // 火山引擎 GLM endpoint ID
  'DEEPSEEK': 'ep-20260119112406-4c4rb', // 火山引擎 DeepSeek endpoint ID
  'DOUBAO': 'ep-20260116154917-bwg4d' // 火山引擎 Doubao endpoint ID
};
const DEFAULT_MODEL = MODEL_NAME_MAP.DEEPSEEK;


function createLLMRequestId(provider) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${provider}-${Date.now().toString(36)}-${randomPart}`;
}

const BATCH_SIZE = 60; // 每批处理多少个对象

/**
 * 调用火山引擎（豆包）API（通过 Cloudflare Worker 代理）
 * 注意：此函数专门用于火山引擎 Worker，不需要 X-API-Provider 请求头
 * 支持 response_format: json_schema 严格模式或 json_object 宽松模式
 * @param {string} message - 用户消息
 * @param {Object} options - 可选参数（包含 response_format）
 * @returns {Promise<Object>} API响应数据
 */
async function callHuoshanAI(message = "你好，请介绍一下你自己", options = {}) {
  const url = API_CONFIG.proxyUrl;

  // 获取 access_token (如果需要 JWT 验证)
  // 注意：在 XPCOM 环境下，Zotero 对象是全局可用的
  let token = null;
  if (typeof Zotero !== 'undefined' && Zotero.VibeDBSync) {
    token = await Zotero.VibeDBSync.getAccessToken();
    // 如果获取不到 token，且 ensureLoggedIn 可用，强制检查登录
    if (!token && Zotero.VibeDBSync.ensureLoggedIn) {
      if (Zotero.VibeDBSync.handleAuthInvalid) {
        Zotero.VibeDBSync.handleAuthInvalid('请先登录 Vibero 账号');
      } else if (!Zotero.VibeDBSync.ensureLoggedIn()) {
        throw new Error("用户未登录，请登录后重试");
      }
      throw new Error("用户未登录，请在弹出的窗口中登录后重试");
      // 登录面板打开后，重新获取一次（虽然通常需要用户操作后才会有）
      // 这里直接抛出错误让用户去登录比较合理
    }
  }

  // 构建请求体（火山引擎格式）
  const huoshanMessages = [];
  if (options.system) huoshanMessages.push({ role: "system", content: options.system });
  huoshanMessages.push({ role: "user", content: message });

  const requestBody = {
    // model: options.model || "ep-20260116143400-qz6rl", // 火山引擎 endpoint ID
    model: DEFAULT_MODEL,
    stream: false, // 改为非流式传输
    temperature: options.temperature || 1.0,
    top_p: options.top_p || 0.95,
    max_tokens: options.max_tokens,
    thinking: {
      type: "disabled" // 火山引擎特有参数
    },
    messages: huoshanMessages
  };

  // 支持 response_format 选项（json_schema 严格模式或 json_object）
  if (options.response_format) {
    requestBody.response_format = options.response_format;
  } else {
    // 默认使用 json_object
    requestBody.response_format = {
      type: "json_object"
    };
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  // 如果有 token，添加到 Authorization 头
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const fetchOptions = {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody)
  };

  try {
    // console.log('🚀 发送请求到火山引擎 API (通过 Supabase 代理, 流式模式)...');
    // console.log('📝 请求消息:', message);
    // console.log(`[llmapi/callHuoshanAI] 发送请求, 模型: ${requestBody.model}, 是否流式(stream): ${requestBody.stream}`);

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      // 检查 401 错误，触发重新登录
      if (response.status === 401 && typeof Zotero !== 'undefined' && Zotero.VibeDBSync) {
        console.log('[llmapi] Token 失效 (401)，触发重新登录流程');
        if (Zotero.VibeDBSync.handleAuthInvalid) {
          Zotero.VibeDBSync.handleAuthInvalid();
        } else {
          if (Zotero.VibeDBSync.clearUser) Zotero.VibeDBSync.clearUser();
          if (Zotero.VibeDBSync.ensureLoggedIn) Zotero.VibeDBSync.ensureLoggedIn();
        }
        throw new Error("登录已过期，请在弹出的窗口中重新登录");
      }

      const errorText = await response.text();
      const responseHeaders = {};
      response.headers.forEach((val, key) => responseHeaders[key] = val);

      const errorDetail = {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: responseHeaders,
        body: errorText
      };

      throw new Error(`HTTP错误完整详情:\n${JSON.stringify(errorDetail, null, 2)}`);
    }

    // 非流式响应处理
    // console.log('[llmapi/callHuoshanAI] 🚀 接口调用成功，开始等待非流式 JSON 返回...');
    const data = await response.json();

    // 打印 Token 消耗情况
    if (data.usage) {
      // console.log(`[llmapi/callHuoshanAI] 📊 Token 消耗统计 - prompt_tokens: ${data.usage.prompt_tokens || 0}, completion_tokens: ${data.usage.completion_tokens || 0}, total_tokens: ${data.usage.total_tokens || 0}`);
      if (typeof Zotero !== 'undefined') {
        if (!Zotero._vibeTokenCounter) Zotero._vibeTokenCounter = { prompt: 0, completion: 0, total: 0 };
        Zotero._vibeTokenCounter.prompt += data.usage.prompt_tokens || 0;
        Zotero._vibeTokenCounter.completion += data.usage.completion_tokens || 0;
        Zotero._vibeTokenCounter.total += data.usage.total_tokens || 0;
      }
    } else {

      // console.log('[llmapi/callHuoshanAI] 📊 未返回 Token 消耗统计 (usage 参数缺失)');
    }
    // console.log('[llmapi/callHuoshanAI] ✅ 收到非流式完整 JSON 响应');
    return data;

  } catch (error) {
    console.error('❌ API调用失败:', error.message);
    console.error('🔍 错误详情:', error);
    throw error;
  }
}


/**
 * 调用阿里云百炼（通义千问）API（通过 Supabase Edge Function 代理）
 * 使用 OpenAI Compatible 格式，支持 response_format: json_schema 严格模式或 json_object 宽松模式
 * 与 callHuoshanAI 完全对称，只是后端 url 不同，且不需要 thinking 参数
 * @param {string} message - 用户消息
 * @param {Object} options - 可选参数（包含 response_format）
 * @returns {Promise<Object>} API响应数据
 */
async function callBailianAI(message = "你好，请介绍一下你自己", options = {}) {
  const url = API_CONFIG.proxyUrl;
  const requestId = createLLMRequestId('bailian');
  const startedAt = Date.now();

  // 获取 access_token（JWT 鉴权，与火山引擎逻辑一致）
  let token = null;
  if (typeof Zotero !== 'undefined' && Zotero.VibeDBSync) {
    token = await Zotero.VibeDBSync.getAccessToken();
    if (!token && Zotero.VibeDBSync.ensureLoggedIn) {
      if (Zotero.VibeDBSync.handleAuthInvalid) {
        Zotero.VibeDBSync.handleAuthInvalid('请先登录 Vibero 账号');
      } else if (!Zotero.VibeDBSync.ensureLoggedIn()) {
        throw new Error("用户未登录，请登录后重试");
      }
      throw new Error("用户未登录，请在弹出的窗口中登录后重试");
    }
  }

  // 构建请求体（OpenAI Compatible 格式，百炼不支持 thinking 参数）
  const bailianMessages = [];
  if (options.system) bailianMessages.push({ role: "system", content: options.system });
  bailianMessages.push({ role: "user", content: message });

  const requestBody = {
    model: options.model || 'qwen-plus-latest', // 百炼默认模型（与 Edge 代理默认一致）
    stream: false, // 改为非流式传输
    temperature: options.temperature || 1.0,
    top_p: options.top_p || 0.95,
    max_tokens: options.max_tokens,
    messages: bailianMessages
  };

  // 支持 response_format 选项（json_schema 严格模式或 json_object）
  if (options.response_format) {
    requestBody.response_format = options.response_format;
  } else {
    // 默认使用 json_object
    requestBody.response_format = {
      type: "json_object"
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-vibezotero-request-id': requestId
  };
  // 如果有 token，添加到 Authorization 头（用于 Supabase Edge Function 鉴权）
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const fetchOptions = {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody)
  };

  try {
    // console.warn(`[llmapi/Bailian] request_id=${requestId} 开始请求 Edge Function: ${url}, model=${requestBody.model}, stream=${requestBody.stream}`);
    const response = await fetch(url, fetchOptions);
    const elapsedMs = Date.now() - startedAt;
    // console.warn(`[llmapi/Bailian] request_id=${requestId} Edge Function 已返回 HTTP: status=${response.status}, elapsed_ms=${elapsedMs}`);

    if (!response.ok) {
      // 检查 401 错误，触发重新登录
      if (response.status === 401 && typeof Zotero !== 'undefined' && Zotero.VibeDBSync) {
        console.log('[llmapi] Token 失效 (401)，触发重新登录流程');
        if (Zotero.VibeDBSync.handleAuthInvalid) {
          Zotero.VibeDBSync.handleAuthInvalid();
        } else {
          if (Zotero.VibeDBSync.clearUser) Zotero.VibeDBSync.clearUser();
          if (Zotero.VibeDBSync.ensureLoggedIn) Zotero.VibeDBSync.ensureLoggedIn();
        }
        throw new Error("登录已过期，请在弹出的窗口中重新登录");
      }

      const errorText = await response.text();
      const responseHeaders = {};
      response.headers.forEach((val, key) => responseHeaders[key] = val);

      const errorDetail = {
        requestId,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: responseHeaders,
        body: errorText
      };

      throw new Error(`HTTP错误完整详情:\n${JSON.stringify(errorDetail, null, 2)}`);
    }

    // 非流式响应处理
    // console.log('[llmapi/callBailianAI] 🚀 接口调用成功，开始等待非流式 JSON 返回...');
    const data = await response.json();

    // 打印 Token 消耗情况
    if (data.usage) {
      // console.log(`[llmapi/callBailianAI] 📊 Token 消耗统计 - prompt_tokens: ${data.usage.prompt_tokens || 0}, completion_tokens: ${data.usage.completion_tokens || 0}, total_tokens: ${data.usage.total_tokens || 0}`);
      if (typeof Zotero !== 'undefined') {
        if (!Zotero._vibeTokenCounter) Zotero._vibeTokenCounter = { prompt: 0, completion: 0, total: 0 };
        Zotero._vibeTokenCounter.prompt += data.usage.prompt_tokens || 0;
        Zotero._vibeTokenCounter.completion += data.usage.completion_tokens || 0;
        Zotero._vibeTokenCounter.total += data.usage.total_tokens || 0;
      }
    } else {

      // console.log('[llmapi/callBailianAI] 📊 未返回 Token 消耗统计 (usage 参数缺失)');
    }
    // console.log('[llmapi/callBailianAI] ✅ 收到非流式完整 JSON 响应');
    return data;

  } catch (error) {
    console.error(`❌ [Bailian] API调用失败 request_id=${requestId}, elapsed_ms=${Date.now() - startedAt}:`, error.message);
    // if (error instanceof TypeError && /NetworkError|Failed to fetch|Network request failed/i.test(error.message || '')) {
    //   console.error(`[llmapi/Bailian] request_id=${requestId} fetch 在收到 HTTP 响应前失败。若 Supabase Edge 日志没有这个 request_id，基本可判定是本机/Zotero 到 Supabase 这一跳失败；若有，则继续看 Edge 的 upstream 日志。`);
    // }
    console.error('🔍 错误详情:', error);
    throw error;
  }
}


/**
 * 调用 OpenRouter API（通过 Cloudflare Worker / Supabase Edge Function 代理）
 * @param {string} message - 用户消息
 * @param {Object} options - 可选参数
 * @returns {Promise<Object>} API响应数据
 */
async function callOpenRouterAI(message = "你好，请介绍一下你自己", options = {}) {
  const url = API_CONFIG.proxyUrl;
  // 更新为用户指定的 DeepSeek v3.2 (Chat Model)
  const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v3.2";

  // 构建请求体 (OpenAI Compatible)
  const openrouterMessages = [];
  if (options.system) openrouterMessages.push({ role: "system", content: options.system });
  openrouterMessages.push({ role: "user", content: message });

  const requestBody = {
    model: options.model || DEFAULT_OPENROUTER_MODEL,
    stream: false, // 改为 false，避免 XPCOM 环境下流读取错误 (Error in input stream)
    // DeepSeek V3.2 是 Chat 模型，不需要处理 Thinking/Reasoning 标签
    temperature: options.temperature || 0.7,
    top_p: options.top_p || 0.9,
    max_tokens: options.max_tokens,
    messages: openrouterMessages
  };

  // 支持 response_format 选项
  // OpenRouter 支持 json_schema (Structured Outputs)，不再强制降级为 json_object
  if (options.response_format) {
    // console.log('[callOpenRouterAI] 使用用户指定的 response_format:', options.response_format.type);
    requestBody.response_format = options.response_format;
  } else {
    // 默认使用 json_object
    requestBody.response_format = {
      type: "json_object"
    };
  }

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  };

  try {
    // console.log('🚀 发送请求到 OpenRouter API (通过 Supabase 代理, 非流式模式)...');
    // console.log('📝 请求消息:', message);

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const headers = {};
      response.headers.forEach((val, key) => headers[key] = val);

      const errorDetail = {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: headers,
        body: errorText
      };

      throw new Error(`HTTP错误完整详情:\n${JSON.stringify(errorDetail, null, 2)}`);
    }

    // 非流式模式：直接解析 JSON
    const data = await response.json();
    return data;

  } catch (error) {
    console.error('❌ API调用失败:', error.message);
    console.error('🔍 错误详情:', error);
    throw error;
  }
}

/**
 * 调用智谱AI API（通过 Cloudflare Worker 代理）
 * @param {string} message - 用户消息
 * @param {Object} options - 可选参数
 * @returns {Promise<Object>} API响应数据
 */
async function callZhipuAI(message = "你好，请介绍一下你自己", options = {}) {
  // console.log("[API_CONFIG.proxyUrl]:", API_CONFIG.proxyUrl);
  // 如果使用火山引擎代理，调用 callHuoshanAI
  if (API_CONFIG.proxyUrl.includes('ai-summary-proxy-huoshan')) {
    return callHuoshanAI(message, options);
  }

  // 如果使用阿里云百炼代理，调用 callBailianAI
  if (API_CONFIG.proxyUrl.includes('ai-summary-proxy-bailian')) {
    return callBailianAI(message, options);
  }

  // 如果使用 OpenRouter Worker，调用 callOpenRouterAI
  if (API_CONFIG.proxyUrl.includes('ai-summary-proxy-openrouter')) {
    return callOpenRouterAI(message, options);
  }

  const url = API_CONFIG.proxyUrl;

  // 构建请求体
  const requestBody = {
    model: "GLM-4.6",
    stream: false,
    thinking: {
      type: "disabled"
    },
    do_sample: true,
    temperature: options.temperature || 1,
    top_p: options.top_p || 0.95,
    response_format: {
      type: "json_object"
    },
    messages: [
    {
      role: "user",
      content: message
    }]

  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Provider': 'zhipu' // 指定使用智谱 AI
    },
    body: JSON.stringify(requestBody)
  };

  try {
    // console.log('🚀 发送请求到智谱AI API (通过代理)...');
    // console.log('📝 请求消息:', message);

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const headers = {};
      response.headers.forEach((val, key) => headers[key] = val);

      const errorDetail = {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: headers,
        body: errorText
      };

      throw new Error(`HTTP错误完整详情:\n${JSON.stringify(errorDetail, null, 2)}`);
    }

    const data = await response.json();

    // console.log('✅ API调用成功!');
    // console.log('📊 响应数据:', data);

    // 提取并显示AI回复内容
    if (data.choices && data.choices[0] && data.choices[0].message) {

      // console.log('🤖 AI回复:', data.choices[0].message.content);
    }
    return data;

  } catch (error) {
    console.error('❌ API调用失败:', error.message);
    console.error('🔍 错误详情:', error);
    throw error;
  }
}

/**
 * 调用 DeepSeek API（通过 Cloudflare Worker 代理）
 * @param {string} message - 用户消息
 * @param {Object} options - 可选参数
 * @returns {Promise<Object>} API响应数据
 */
async function callDeepseekAI(message = "你好，请介绍一下你自己", options = {}) {
  const url = API_CONFIG.proxyUrl;

  // 构建请求体
  const requestBody = {
    model: "deepseek-chat",
    stream: false,
    temperature: options.temperature || 1.0,
    top_p: options.top_p || 0.95,
    max_tokens: options.max_tokens,
    messages: [
    {
      role: "user",
      content: message
    }]

  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Provider': 'deepseek' // 指定使用 DeepSeek
    },
    body: JSON.stringify(requestBody)
  };

  try {
    // console.log('🚀 发送请求到 DeepSeek API (通过代理)...');
    // console.log('📝 请求消息:', message);

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      const headers = {};
      response.headers.forEach((val, key) => headers[key] = val);

      const errorDetail = {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: headers,
        body: errorText
      };

      throw new Error(`HTTP错误完整详情:\n${JSON.stringify(errorDetail, null, 2)}`);
    }

    const data = await response.json();

    // console.log('✅ API调用成功!');
    // console.log('📊 响应数据:', JSON.stringify(data, null, 2));

    // 提取并显示AI回复内容
    if (data.choices && data.choices[0] && data.choices[0].message) {

      // console.log('🤖 AI回复:', data.choices[0].message.content);
    }
    return data;

  } catch (error) {
    console.error('❌ API调用失败:', error.message);
    console.error('🔍 错误详情:', error);
    throw error;
  }
}

// XPCOM 环境下不使用 export，直接将函数暴露到全局作用域
// 这些函数会在 Services.scriptloader.loadSubScript 加载后自动可用