/**
 * MinerU PDF解析模块
 * 提供PDF文档的智能解析和处理功能
 * 
 * 支持两种模式：
 * 1. 云端 API (默认) - 使用 mineru.net 在线服务
 * 2. 本地 API - 使用本地部署的 MinerU FastAPI 服务
 */

// ==================== API 配置 ====================
// 开源版：
// - 默认本地模式（LOCAL），需要自建 MinerU FastAPI 服务（见 README「本地解析」章节）
// - 云端模式（CLOUD）端点由 prefs 配置，默认为空，不再内置任何远程地址
//   extensions.zotero.vibeProxy.baseUrl  自建网关根地址（如 https://your-gateway.example.com）
const _getMinerUBase = () => {
  const configured = typeof Zotero !== 'undefined' && Zotero.VibeDBSync?.getSupabaseConfig()?.url;
  return String(configured || '');
};
const MINERU_WORKER_URL = () => `${_getMinerUBase()}/functions/v1/mineru`;
const R2_UPLOAD_WORKER_URL = () => `${_getMinerUBase()}/functions/v1/r2-upload`;
const DOWNLOAD_WORKER_URL = () => `${_getMinerUBase()}/functions/v1/mineru`;

// 本地 MinerU API 配置：默认本机适配层端口（与安装包内「一键部署AI解析.command」一致），可通过 pref 覆盖
// extensions.zotero.vibeProxy.mineruLocalUrl
const LOCAL_MINERU_API_URL = (() => {
  try {
    return String(Zotero.Prefs.get('vibeProxy.mineruLocalUrl') || 'http://127.0.0.1:8004/file_parse');
  }
  catch (e) {
    return 'http://127.0.0.1:8004/file_parse';
  }
})();

// API 模式配置：'cloud' 或 'local'
// 开源版默认本地模式；可通过 Zotero.Prefs 动态切换
const DEFAULT_API_MODE = 'local';
// 导入必要的组件
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const { OS } = ChromeUtils.importESModule("chrome://zotero/content/osfile.mjs");

const ZipReader = Components.Constructor(
  "@mozilla.org/libjar/zip-reader;1",
  "nsIZipReader",
  "open"
);

/**
 * MinerU PDF解析器类
 * 支持云端 API 和本地 API 两种模式
 */
class MinerUParser {
  constructor() {
    this.resultDir = OS.Path.join(Zotero.DataDirectory.dir, 'MinerUResult');
    this.ensureResultDirectory();
    // 默认使用配置的 API 模式
    this._apiMode = DEFAULT_API_MODE;
    this._pollStatusCallback = null;
  }

  /**
   * 设置轮询状态回调
   * @param {Function|null} callback
   */
  setPollStatusCallback(callback) {
    this._pollStatusCallback = typeof callback === 'function' ? callback : null;
  }

  _notifyPollStatus(payload) {
    if (!this._pollStatusCallback) {
      return;
    }
    try {
      this._pollStatusCallback(payload);
    } catch (error) {
      console.warn('[MinerU] 轮询状态回调执行失败:', error);
    }
  }

  /**
   * 获取 MinerU 轮询最大次数
   * 0 或负数表示不限次数，持续等待直到任务完成/失败。
   * @returns {number}
   */
  _getMaxPollAttempts() {
    try {
      const value = Zotero.Prefs.get('mineru.maxPollAttempts');
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
    } catch (error) {
      console.warn('[MinerU] 读取 mineru.maxPollAttempts 失败，默认使用不限次数:', error);
      return 0;
    }
  }

  /**
   * 设置 API 模式
   * @param {string} mode - 'cloud' 或 'local'
   */
  setApiMode(mode) {
    if (mode === 'cloud' || mode === 'local') {
      this._apiMode = mode;
      console.log(`[MinerU] API 模式已切换为: ${mode}`);
    } else {
      console.warn(`[MinerU] 无效的 API 模式: ${mode}，保持当前模式: ${this._apiMode}`);
    }
  }

  /**
   * 获取当前 API 模式
   * @returns {string} 'cloud' 或 'local'
   */
  getApiMode() {
    return this._apiMode;
  }

  /**
   * 获取 Access Token
   * @private
   */
  async _getAccessToken() {
    if (typeof Zotero !== 'undefined' && Zotero.VibeDBSync && Zotero.VibeDBSync.getAccessToken) {
      try {
        return await Zotero.VibeDBSync.getAccessToken();
      } catch (e) {
        console.error('[MinerU] 获取 Token 失败:', e);
      }
    }
    return null;
  }

  /**
   * 处理 401 未授权错误
   * @private
   */
  _handleUnauthorized() {
    console.log('[MinerU] Token 失效 (401)，触发重新登录流程');
    if (typeof Zotero !== 'undefined' && Zotero.VibeDBSync) {
      if (Zotero.VibeDBSync.clearUser) Zotero.VibeDBSync.clearUser();
      if (Zotero.VibeDBSync.ensureLoggedIn) Zotero.VibeDBSync.ensureLoggedIn();
    }
  }

  /**
   * 确保结果目录存在
   */
  ensureResultDirectory() {
    try {
      const dir = new FileUtils.File(this.resultDir);
      if (!dir.exists()) {
        dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
      }
    } catch (error) {
      console.error("创建MinerU结果目录失败:", error);
    }
  }

  /**
   * 请求上传URL (v4 API) - 已废弃，保留兼容性
   * @deprecated 使用 Cloudflare Worker API 后不再需要此方法
   */
  async __requestUploadUrl(fileName) {
    console.warn('[MinerU] __requestUploadUrl 已废弃，请使用 Cloudflare Worker API');
    throw new Error('此方法已废弃，请使用 Cloudflare Worker API');
  }

  /**
   * 上传文件到MinerU (v4 API) - 已废弃，保留兼容性
   * @deprecated 使用 Cloudflare Worker API 后不再需要此方法
   */
  async __uploadFileToMinerU(filePath, uploadUrl) {
    console.warn('[MinerU] __uploadFileToMinerU 已废弃，请使用 Cloudflare Worker API');
    throw new Error('此方法已废弃，请使用 Cloudflare Worker API');
  }

  /**
   * 上传本地 PDF 文件到 Cloudflare R2
   * @param {string} filePath - 本地 PDF 文件路径
   * @returns {Promise<{url: string, key: string}>} 上传结果，包含公开 URL 和文件 key
   */
  async __uploadToR2(filePath) {
    // console.log(`[MinerU] ========================================`);
    // console.log(`[MinerU] 📤 开始上传 PDF 到 Cloudflare R2`);
    // console.log(`[MinerU] 📡 R2 Worker URL: ${R2_UPLOAD_WORKER_URL}`);
    // console.log(`[MinerU] 📄 本地文件: ${filePath}`);
    // console.log(`[MinerU] ========================================`);
    // console.log(`📤 开始上传 PDF`);

    try {
      // 读取本地 PDF 文件
      const pdfFile = new FileUtils.File(filePath);
      const fileName = pdfFile.leafName;

      if (!pdfFile.exists()) {
        throw new Error(`PDF 文件不存在: ${filePath}`);
      }

      // 读取文件内容
      let fileInputStream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
      fileInputStream.init(pdfFile, -1, -1, 0);

      let binaryInputStream = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
      binaryInputStream.setInputStream(fileInputStream);

      let bytes = binaryInputStream.readByteArray(binaryInputStream.available());
      binaryInputStream.close();
      fileInputStream.close();

      // console.log(`[MinerU] 📊 文件大小: ${bytes.length} bytes (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);

      // 构建 FormData 上传
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
      formData.append('file', blob, fileName);

      // console.log(`[MinerU] ⏳ 正在上传到 R2...`);
      const startTime = Date.now();

      const token = await this._getAccessToken();
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${R2_UPLOAD_WORKER_URL()}/upload`, {
        method: 'POST',
        headers: headers,
        body: formData
      });

      const elapsed = Date.now() - startTime;
      // console.log(`[MinerU] 📊 上传响应状态: ${response.status} (${elapsed}ms)`);

      if (!response.ok) {
        if (response.status === 401) {
          this._handleUnauthorized();
        }
        const errorText = await response.text();
        console.log(` ❌ 上传失败: ${errorText}`);
        throw new Error(`PDF 上传失败: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      // console.log(`[MinerU] 📥 上传响应:`, JSON.stringify(result));

      if (!result.success) {
        throw new Error(result.error || 'PDF 上传失败');
      }

      console.log(`✅ 上传成功！`);
      // console.log(`[MinerU]   - 文件 Key: ${result.key}`);
      // console.log(`[MinerU]   - 公开 URL: ${result.url}`);

      return {
        url: result.url,
        key: result.key,
        proxyUrl: result.proxyUrl
      };

    } catch (error) {
      console.error(`[MinerU] ❌ PDF 上传失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 从 R2 删除临时文件
   * @param {string} key - 文件 key
   */
  async __deleteFromR2(key) {
    try {
      console.log(`🗑️ 删除 R2 临时文件`);

      const token = await this._getAccessToken();
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${R2_UPLOAD_WORKER_URL()}/file/${key}`, {
        method: 'DELETE',
        headers: headers
      });

      if (response.ok) {
        console.log(`✅ R2 文件已删除`);
      } else {
        console.warn(`⚠️ R2 文件删除失败: ${response.status}`);
      }
    } catch (error) {
      // 删除失败不影响主流程
      console.warn(`⚠️ R2 文件删除异常: ${error.message}`);
    }
  }

  /**
   * 下载MinerU结果文件
   */
  async __downloadMinerUResult(downloadUrl, fileName) {
    console.log(`开始下载结果文件`);

    // 创建目标目录
    const targetDir = this.resultDir;
    let targetDirFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    targetDirFile.initWithPath(targetDir);

    if (!targetDirFile.exists()) {
      targetDirFile.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }

    // 下载文件
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 保存文件 - 使用跨平台路径拼接
    const filePath = OS.Path.join(targetDir, fileName);
    // console.log(`[MinerU] 目标文件路径: ${filePath}`);
    // console.log(`[MinerU] targetDir: ${targetDir}, fileName: ${fileName}`);
    let targetFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    targetFile.initWithPath(filePath);

    let fileOutputStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    fileOutputStream.init(targetFile, 0x02 | 0x08 | 0x20, 0o644, 0);

    let binaryOutputStream = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
    binaryOutputStream.setOutputStream(fileOutputStream);
    binaryOutputStream.writeByteArray(bytes);
    binaryOutputStream.close();
    fileOutputStream.close();

    console.log(`文件下载完成`);
    return filePath;
  }

  /**
   * 解压ZIP文件
   */
  async __unzipMinerUResult(zipFilePath) {
    // console.log(`[Reader] 开始解压文件: ${zipFilePath}`);

    // 创建解压目录 - 使用MinerUResult目录
    const zipFile = new FileUtils.File(zipFilePath);

    // 使用this.resultDir作为解压的基础目录
    const resultDir = new FileUtils.File(this.resultDir);
    if (!resultDir.exists()) {
      resultDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    }

    const zipFileName = zipFile.leafName.replace('.zip', '');
    const extractDir = resultDir.clone();
    extractDir.append(zipFileName);

    if (!extractDir.exists()) {
      extractDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    }

    try {
      // 使用ZipReader解压文件
      const zipReader = new ZipReader(zipFile);
      const entries = zipReader.findEntries('*');

      while (entries.hasMore()) {
        const entryName = entries.getNext();
        const entry = zipReader.getEntry(entryName);

        const targetFile = extractDir.clone();
        // ZIP文件内部路径统一使用正斜杠分割，这是ZIP格式的标准
        const pathParts = entryName.split('/').filter(Boolean);

        for (const part of pathParts) {
          targetFile.append(part);
        }

        if (entry.isDirectory) {
          if (!targetFile.exists()) {
            targetFile.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
          }
          continue;
        }

        const parent = targetFile.parent;
        if (parent && !parent.exists()) {
          parent.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
        }

        zipReader.extract(entryName, targetFile);
      }

      zipReader.close();

      // 删除原ZIP文件 - 添加重试机制和错误处理
      try {
        // 在Windows上，短暂等待确保文件句柄完全释放
        await new Promise((resolve) => setTimeout(resolve, 100));
        zipFile.remove(false);
        // console.log(`[Reader] ZIP文件删除成功: ${zipFile.path}`);
      } catch (removeError) {
        console.warn(`[Reader] ZIP文件删除失败，但不影响解压结果: ${removeError.message}`);
        // 在Windows上，文件可能被其他进程占用，删除失败不影响主要功能
        // ZIP文件会留在 MinerUResult 目录中，可以手动清理
      }

      // console.log(`[Reader] 文件解压完成: ${extractDir.path}`);
      return extractDir.path;

    } catch (error) {
      console.error(`[Reader] 解压文件失败: ${error}`);
      throw error;
    }
  }

  /**
   * 轮询 Cloudflare Worker MinerU 任务状态
   * @param {string} taskId - 任务 ID
   * @param {number|null} keyIndex - API Key 索引（submit 返回的 key_index），用于多 Key 负载均衡
   * @returns {Promise<string>} 下载 URL
   */
  async __pollWorkerTaskStatus(taskId, keyIndex = null) {
    // 构建状态查询 URL，携带 key 参数
    const keyParam = keyIndex !== null ? `?key=${keyIndex}` : '';
    const STATUS_URL = `${MINERU_WORKER_URL()}/status/${taskId}${keyParam}`;
    const maxAttempts = this._getMaxPollAttempts();
    const isUnlimited = maxAttempts <= 0;

    // console.log(`[MinerU] ========================================`);
    // console.log(`[MinerU] 🔄 开始轮询 Cloudflare Worker 任务状态`);
    // console.log(`[MinerU] 📡 Worker URL: ${MINERU_WORKER_URL}`);
    // console.log(`[MinerU] 🆔 任务 ID: ${taskId}`);
    // console.log(`[MinerU] 🔑 API Key 索引: ${keyIndex !== null ? keyIndex : '未指定（随机）'}`);
    // console.log(`[MinerU] 🔗 状态查询 URL: ${STATUS_URL}`);
    // console.log(`[MinerU] ========================================`);
    console.log(`开始轮询任务状态`);
    // console.log(`开始轮询任务状态 (${taskId})`);

    for (let attempt = 0; isUnlimited || attempt < maxAttempts; attempt++) {
      // 计算当前轮询间隔
      let interval = 5000;
      if (attempt >= 10 && attempt < 20) {
        interval = 8000;
      } else if (attempt >= 20 && attempt < 31) {
        interval = 10000;
      } else if (attempt >= 31) {
        interval = 20000;
      }

      // 轮询前等待，确保第一次轮询也有延迟
      await new Promise((resolve) => setTimeout(resolve, interval));

      this._notifyPollStatus({
        attempt: attempt + 1,
        interval,
        maxAttempts,
        isUnlimited
      });

      if (isUnlimited) {
        console.log(`轮询第 ${attempt + 1} 次 (间隔 ${interval / 1000}s)...`);
      } else {
        console.log(`轮询第 ${attempt + 1}/${maxAttempts} 次 (间隔 ${interval / 1000}s)...`);
      }

      const startTime = Date.now();
      let response;

      const token = await this._getAccessToken();
      const headers = {
        'Content-Type': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        response = await fetch(STATUS_URL, {
          method: 'GET',
          headers: headers
        });
      } catch (fetchError) {
        // 网络错误（fetch 失败）立即抛出，不重试
        console.error(`轮询网络错误: ${fetchError.message}`);
        throw new Error(`网络连接失败: ${fetchError.message}`);
      }

      const elapsed = Date.now() - startTime;
      // console.log(`[MinerU] 📊 响应状态: ${response.status} (${elapsed}ms)`);

      if (!response.ok) {
        if (response.status === 401) {
          this._handleUnauthorized();
        }
        // HTTP 错误状态码，立即抛出
        throw new Error(`轮询请求失败: ${response.status} ${response.statusText}`);
      }

      let result;
      try {
        result = await response.json();
      } catch (parseError) {
        // JSON 解析错误，立即抛出
        throw new Error(`轮询响应解析失败: ${parseError.message}`);
      }

      // console.log(`[MinerU] 📥 轮询结果:`, JSON.stringify(result));

      // 检查任务状态
      const state = result.state || result.status;

      if (state === 'done') {
        console.log(`任务完成！准备下载结果`);
        return taskId; // 返回 taskId 用于下载

      } else if (state === 'processing' || state === 'pending' || state === 'running') {
        // 任务仍在处理中，继续轮询
        console.log(`任务状态: ${state}，${interval / 1000}秒后继续轮询...`);

      } else if (state === 'failed' || state === 'error') {
        console.log(`任务失败: ${result.error || result.message || '未知错误'}`);
        throw new Error(`MinerU 任务处理失败: ${result.error || result.message || '未知错误'}`);

      } else {
        console.log(`未知状态: ${state}，继续等待...`);
      }

    }

    throw new Error('MinerU 任务处理超时，请稍后重试');
  }

  /**
   * 通过 Cloudflare Worker 代理下载结果
   * 使用独立的 Cloudflare Worker (DOWNLOAD_WORKER_URL) 进行下载，利用 Cloudflare 全球 CDN 加速
   * @param {string} taskId - 任务 ID
   * @param {string} fileName - 保存的文件名
   * @param {number|null} keyIndex - API Key 索引（submit 返回的 key_index），用于多 Key 负载均衡
   * @returns {Promise<string>} 下载的文件路径
   */
  async __downloadAndSaveExtracted(taskId, timestamp, keyIndex = null) {
    const keyParam = keyIndex !== null ? `&key=${keyIndex}` : '';
    const extractUrl = `${DOWNLOAD_WORKER_URL()}/download/${taskId}?extract=true${keyParam}`;

    //  console.log(`[MinerU][extract] → 请求: ${extractUrl}`);
    const t0 = Date.now();

    const token = await this._getAccessToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(extractUrl, { headers });
    //  console.log(`[MinerU][extract] ← HTTP ${response.status} (${Date.now() - t0}ms)`);

    if (!response.ok) {
      if (response.status === 401) this._handleUnauthorized();
      const errorText = await response.text();
      throw new Error(`下载失败: ${response.status} - ${errorText}`);
    }

    const json = await response.json();
    const files = json.files;
    //  console.log(`[MinerU][extract] JSON 解析完成，共 ${files?.length ?? 0} 个文件:`);
    if (files) {
      for (const f of files) {

        //  console.log(`[MinerU][extract]   ${f.path}  (${f.content?.length ?? 0} chars)`);
      }}
    if (!files || files.length === 0) throw new Error('服务端未返回目标文件');

    // Create MinerUResult/mineru_worker_TIMESTAMP/
    const folderName = `mineru_worker_${timestamp}`;
    const extractDir = OS.Path.join(this.resultDir, folderName);
    //  console.log(`[MinerU][extract] 写入目录: ${extractDir}`);
    let extractDirFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    extractDirFile.initWithPath(extractDir);
    if (!extractDirFile.exists()) extractDirFile.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

    // Write each file preserving internal zip path
    const encoder = new TextEncoder();
    for (const { path: filePath, content } of files) {
      const parts = filePath.split('/').filter(Boolean);
      const targetFile = extractDirFile.clone();
      for (const part of parts) targetFile.append(part);

      const parent = targetFile.parent;
      if (parent && !parent.exists()) parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

      const bytes = encoder.encode(content);
      let fileOutputStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
      fileOutputStream.init(targetFile, 0x02 | 0x08 | 0x20, 0o644, 0);
      let binaryOutputStream = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
      binaryOutputStream.setOutputStream(fileOutputStream);
      binaryOutputStream.writeByteArray(Array.from(bytes));
      binaryOutputStream.close();
      fileOutputStream.close();
      //  console.log(`[MinerU][extract] ✅ 写入: ${targetFile.path}`);
    }

    //  console.log(`[MinerU][extract] 全部完成，耗时 ${Date.now() - t0}ms，目录: ${extractDir}`);
    return extractDir;
  }

  async __downloadFromWorker(taskId, fileName, keyIndex = null) {
    // 修正：无论是 Cloudflare 还是 Supabase，都需要 proxy=true 参数来获取文件流
    // 具体的逻辑请参考 edge-function/mineru/index.ts 中的 getDownload 方法
    // 如果不加 proxy=true，服务端会返回包含下载链接的 JSON 对象，而不是文件流

    const keyParam = keyIndex !== null ? `&key=${keyIndex}` : '';
    const downloadUrl = `${DOWNLOAD_WORKER_URL()}/download/${taskId}?proxy=true${keyParam}`;

    // console.log(`[MinerU] ========================================`);
    // console.log(`[MinerU] 🔗 下载 URL: ${downloadUrl}`);
    // console.log(`[MinerU] 🔑 API Key 索引: ${keyIndex !== null ? keyIndex : '未指定（随机）'}`);
    // console.log(`[MinerU] 📁 目标文件名: ${fileName}`);
    // console.log(`[MinerU] ========================================`);
    // console.log(`[MinerU] 📥 下载 URL: ${downloadUrl}`);

    const startTime = Date.now();

    const token = await this._getAccessToken();
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(downloadUrl, {
      headers: headers
    });
    const elapsed = Date.now() - startTime;
    // console.log(`[MinerU] 📊 下载响应状态: ${response.status} (${elapsed}ms)`);
    // console.log(`[MinerU] 📋 响应头:`, Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      if (response.status === 401) {
        this._handleUnauthorized();
      }
      const errorText = await response.text();
      console.error(`[MinerU] ❌ 下载失败: ${errorText}`);
      throw new Error(`下载失败: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    console.log(` ✅ 下载完成`);
    // console.log(`[MinerU]   - 文件大小: ${bytes.length} bytes (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);

    // 保存文件
    const filePath = OS.Path.join(this.resultDir, fileName);
    // console.log(`[MinerU] 💾 保存到: ${filePath}`);

    let targetFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    targetFile.initWithPath(filePath);

    let fileOutputStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    fileOutputStream.init(targetFile, 0x02 | 0x08 | 0x20, 0o644, 0);

    let binaryOutputStream = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
    binaryOutputStream.setOutputStream(fileOutputStream);
    binaryOutputStream.writeByteArray(bytes);
    binaryOutputStream.close();
    fileOutputStream.close();

    // console.log(` ✅ 文件保存完成: ${filePath}`);
    return filePath;
  }

  /**
   * 调用 Cloudflare Worker MinerU API 进行 PDF 解析
   * 
   * 流程：
   * 1. 上传本地 PDF 到 R2 → 获取公开 URL
   * 2. POST /submit 提交 PDF URL → 获取 task_id
   * 3. GET /status/{task_id} 轮询状态 → 等待 state=done
   * 4. GET /download/{task_id}?proxy=true → 下载结果
   * 5. 删除 R2 临时文件
   * 
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<string>} 解压后的结果目录路径
   */
  async __callMinerUAPI(filePath) {
    let r2Key = null; // 用于最后清理 R2 文件

    try {
      // console.log(`[MinerU] ========================================`);
      // console.log(`[MinerU] 🚀 开始调用 Cloudflare Worker MinerU API`);
      // console.log(`[MinerU] 📄 本地文件: ${filePath}`);
      // console.log(`[MinerU] ========================================`);
      // console.log(`[MinerU] 🚀 开始调用 Cloudflare Worker MinerU API (File: ${filePath})`);

      // 检查文件是否存在
      const file = new FileUtils.File(filePath);
      if (!file.exists()) {
        throw new Error(`PDF 文件不存在: ${filePath}`);
      }

      // 步骤 1: 上传本地 PDF 到 R2
      console.log(`📤 步骤 1/5: 上传 PDF...`);
      const uploadResult = await this.__uploadToR2(filePath);
      const pdfUrl = uploadResult.url;
      r2Key = uploadResult.key;

      console.log(`✅ 上传完成`);

      // 步骤 2: 提交任务到 MinerU
      console.log(`📤 步骤 2/5: 提交任务...`);

      const submitUrl = `${MINERU_WORKER_URL()}/submit`;
      const requestBody = {
        url: pdfUrl,
        model_version: 'vlm'
      };

      // console.log(`[MinerU] 📤 提交到: ${submitUrl}`);
      // console.log(`[MinerU] 📤 请求体:`, JSON.stringify(requestBody));

      const startTime = Date.now();

      const token = await this._getAccessToken();
      const headers = {
        'Content-Type': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const submitResponse = await fetch(submitUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });
      const elapsed = Date.now() - startTime;

      // console.log(`[MinerU] 📊 提交响应状态: ${submitResponse.status} (${elapsed}ms)`);

      if (!submitResponse.ok) {
        if (submitResponse.status === 401) {
          this._handleUnauthorized();
        }
        const errorText = await submitResponse.text();
        // ...
        console.log(`❌ 提交失败: ${errorText}`);
        throw new Error(`提交任务失败: ${submitResponse.status} - ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      // console.log(`[MinerU] 📥 提交响应:`, JSON.stringify(submitResult));

      const taskId = submitResult.task_id || submitResult.taskId;
      // 获取 API Key 索引，用于后续轮询和下载时使用相同的 Key
      const keyIndex = submitResult.key_index !== undefined ? submitResult.key_index : null;

      if (!taskId) {
        console.log(`❌ 未获取到任务 ID`);
        throw new Error('未获取到任务 ID');
      }

      console.log(`🆔 taskId: ${taskId}`);
      console.log(`✅ 任务已提交`);
      // console.log(`✅ 任务已提交，任务ID: ${taskId}，Key索引: ${keyIndex}`);

      // 步骤 3: 轮询任务状态（传入 keyIndex 确保使用同一个 API Key）
      console.log(`🔄 步骤 3/5: 轮询任务状态...`);
      await this.__pollWorkerTaskStatus(taskId, keyIndex);

      // 步骤 4/5: 下载并提取结果文件
      console.log(`📥 步骤 4/5: 下载并提取解析结果...`);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extractedDirPath = await this.__downloadAndSaveExtracted(taskId, timestamp, keyIndex);

      // console.log(`[MinerU] ========================================`);
      console.log(`✅ PDF 解析完成！`);
      // console.log(`[MinerU] 📁 结果目录: ${extractedDirPath}`);
      // console.log(`[MinerU] ========================================`);

      return extractedDirPath;

    } catch (error) {
      console.error("❌ Proxy API 调用失败:", error);
      throw error;
    } finally {
      // 清理 R2 临时文件
      if (r2Key) {
        console.log(`🗑️ 清理临时文件...`);
        await this.__deleteFromR2(r2Key);
      }
    }
  }

  /**
   * 使用公开 URL 调用 Cloudflare Worker MinerU API
   * 适用于已知 PDF 公开 URL 的场景
   * 
   * @param {string} pdfUrl - PDF 的公开 URL
   * @returns {Promise<string>} 解压后的结果目录路径
   */
  async processFileByUrl(pdfUrl) {
    try {
      // console.log(`[MinerU] ========================================`);
      // console.log(`[MinerU] 🚀 开始调用 Cloudflare Worker MinerU API`);
      // console.log(`[MinerU] 📡 Worker URL: ${MINERU_WORKER_URL}`);
      // console.log(`[MinerU] 📄 PDF URL: ${pdfUrl}`);
      // console.log(`[MinerU] ========================================`);
      console.log(`🚀 开始调用 Proxy API`);

      // 1. 提交任务
      const submitUrl = `${MINERU_WORKER_URL()}/submit`;
      const requestBody = {
        url: pdfUrl,
        model_version: 'vlm'
      };

      // console.log(`[MinerU] 📤 提交任务到: ${submitUrl}`);
      // console.log(`[MinerU] 📤 请求体:`, JSON.stringify(requestBody));

      const startTime = Date.now();

      const token = await this._getAccessToken();
      const headers = {
        'Content-Type': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const submitResponse = await fetch(submitUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody)
      });
      const elapsed = Date.now() - startTime;

      // console.log(`[MinerU] 📊 提交响应状态: ${submitResponse.status} (${elapsed}ms)`);

      if (!submitResponse.ok) {
        if (submitResponse.status === 401) {
          this._handleUnauthorized();
        }
        const errorText = await submitResponse.text();
        console.log(`❌ 提交失败: ${errorText}`);
        throw new Error(`提交任务失败: ${submitResponse.status} - ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      // console.log(`[MinerU] 📥 提交响应:`, JSON.stringify(submitResult));

      const taskId = submitResult.task_id || submitResult.taskId;
      // 获取 API Key 索引，用于后续轮询和下载时使用相同的 Key
      const keyIndex = submitResult.key_index !== undefined ? submitResult.key_index : null;

      if (!taskId) {
        console.log(`❌ 未获取到任务 ID`);
        throw new Error('未获取到任务 ID');
      }

      console.log(`✅ 任务已提交`);
      // console.log(`✅ 任务已提交，任务ID: ${taskId}，Key索引: ${keyIndex}`);

      // 2. 轮询任务状态（传入 keyIndex 确保使用同一个 API Key）
      await this.__pollWorkerTaskStatus(taskId, keyIndex);

      // 3. 下载并提取结果文件
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extractedDirPath = await this.__downloadAndSaveExtracted(taskId, timestamp, keyIndex);

      // console.log(`[MinerU] ========================================`);
      console.log(` ✅ PDF 解析完成！`);
      // console.log(`[MinerU] 📁 结果目录: ${extractedDirPath}`);
      // console.log(`[MinerU] ========================================`);

      return {
        success: true,
        extractedPath: extractedDirPath,
        message: 'PDF解析完成 (Cloudflare Worker API)',
        apiMode: 'cloud',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error("[MinerU] URL 解析失败:", error);
      return {
        success: false,
        url: pdfUrl,
        error: error.message,
        message: this.getUserFriendlyErrorMessage(error),
        apiMode: 'cloud',
        timestamp: new Date().toISOString()
      };
    }
  }

  // ==================== 本地 API 方法 ====================

  /**
   * 扁平化本地 API 解压目录结构
   * 本地 API 解压后会多一层文件夹，需要将内容提升一级以与云端 API 保持一致
   * @param {string} extractedDirPath - 解压后的目录路径
   * @returns {Promise<string>} 扁平化后的目录路径
   */
  async __flattenLocalExtractDir(extractedDirPath) {
    try {
      const extractDir = new FileUtils.File(extractedDirPath);

      if (!extractDir.exists() || !extractDir.isDirectory()) {
        console.warn(`[MinerU] 目录不存在或不是目录: ${extractedDirPath}`);
        return extractedDirPath;
      }

      // 获取目录下的所有条目
      const entries = extractDir.directoryEntries;
      const subItems = [];

      while (entries.hasMoreElements()) {
        const entry = entries.getNext().QueryInterface(Ci.nsIFile);
        subItems.push(entry);
      }

      // 检查是否只有一个子目录（本地 API 的特征）
      if (subItems.length === 1 && subItems[0].isDirectory()) {
        const innerDir = subItems[0];
        // console.log(`[MinerU] 检测到中间层文件夹: ${innerDir.leafName}，开始扁平化...`);

        // 获取内层目录的所有内容
        const innerEntries = innerDir.directoryEntries;
        const itemsToMove = [];

        while (innerEntries.hasMoreElements()) {
          const innerEntry = innerEntries.getNext().QueryInterface(Ci.nsIFile);
          itemsToMove.push(innerEntry);
        }

        // 将内层目录的内容移动到外层目录
        for (const item of itemsToMove) {
          const targetPath = OS.Path.join(extractedDirPath, item.leafName);
          const targetFile = new FileUtils.File(targetPath);

          // 如果目标已存在，先删除
          if (targetFile.exists()) {
            targetFile.remove(true);
          }

          // 移动文件/目录
          item.moveTo(extractDir, item.leafName);
          // console.log(`[MinerU] 已移动: ${item.leafName}`);
        }

        // 删除空的中间层目录
        try {
          // 短暂等待确保文件操作完成
          await new Promise((resolve) => setTimeout(resolve, 100));
          innerDir.remove(false);
          // console.log(`[MinerU] 已删除中间层文件夹: ${innerDir.leafName}`);
        } catch (removeError) {
          console.warn(`[MinerU] 删除中间层文件夹失败: ${removeError.message}`);
          // 不影响主流程
        }

        // console.log(`[MinerU] 目录扁平化完成: ${extractedDirPath}`);
      } else {

        // console.log(`[MinerU] 目录结构正常，无需扁平化 (${subItems.length} 个条目)`);
      }
      return extractedDirPath;

    } catch (error) {
      console.error(`[MinerU] 扁平化目录失败: ${error.message}`);
      // 出错时返回原路径，不影响主流程
      return extractedDirPath;
    }
  }

  /**
   * 调用本地 MinerU FastAPI 进行 PDF 解析
   * 对应 Python 测试代码: test_mineru_api.py
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<string>} 解压后的结果目录路径
   */
  async __callLocalMinerUAPI(filePath) {
    try {
      console.log(`开始调用本地 MinerU API，文件路径: ${filePath}`);

      // 1. 读取 PDF 文件内容
      const pdfFile = new FileUtils.File(filePath);
      const fileName = pdfFile.leafName;

      if (!pdfFile.exists()) {
        throw new Error(`PDF 文件不存在: ${filePath}`);
      }

      // console.log(`[MinerU] 准备上传文件: ${fileName}`);

      // 读取文件为二进制数据
      let fileInputStream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
      fileInputStream.init(pdfFile, -1, -1, 0);

      let binaryInputStream = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
      binaryInputStream.setInputStream(fileInputStream);

      let bytes = binaryInputStream.readByteArray(binaryInputStream.available());
      binaryInputStream.close();
      fileInputStream.close();

      // 2. 构建 multipart/form-data 请求
      // 使用 FormData 构建请求体（模拟 Python requests 的 files 和 data 参数）
      const formData = new FormData();

      // 添加文件（对应 Python: files = {"files": ("test.pdf", f, "application/pdf")}）
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
      formData.append('files', blob, fileName);

      // 添加解析参数（对应 Python: data = {...}）
      formData.append('backend', 'pipeline');
      formData.append('parse_method', 'auto');
      formData.append('formula_enable', 'false'); // 禁用公式解析
      formData.append('return_md', 'true');
      formData.append('return_middle_json', 'true');
      formData.append('return_model_output', 'true');
      formData.append('return_content_list', 'true');
      formData.append('return_images', 'true');
      formData.append('response_format_zip', 'true'); // 返回 ZIP 格式

      // console.log(`[MinerU] 正在调用本地 API: ${LOCAL_MINERU_API_URL}`);

      // 3. 发送请求到本地 API
      Zotero.debug('[MinerU] POST ' + LOCAL_MINERU_API_URL + ' (size=' + bytes.length + ')');
      const response = await fetch(LOCAL_MINERU_API_URL, {
        method: 'POST',
        body: formData
      }).catch((e) => {
        Zotero.debug('[MinerU] fetch 异常: ' + (e && e.message) + ' | ' + (e && e.stack), 1);
        throw e;
      });
      Zotero.debug('[MinerU] 响应状态: ' + response.status);

      // console.log(`[MinerU] 本地 API 响应状态: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`本地 API 请求失败: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // 4. 处理响应
      const contentType = response.headers.get('Content-Type') || '';
      // console.log(`[MinerU] 响应 Content-Type: ${contentType}`);

      if (contentType.includes('application/zip') || contentType.includes('octet-stream')) {
        // ZIP 格式响应 - 保存并解压
        const arrayBuffer = await response.arrayBuffer();
        const zipBytes = new Uint8Array(arrayBuffer);

        // console.log(`[MinerU] 收到 ZIP 响应，大小: ${zipBytes.length} bytes`);

        // 生成唯一的文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipFileName = `mineru_local_${timestamp}.zip`;
        const zipFilePath = OS.Path.join(this.resultDir, zipFileName);

        // 保存 ZIP 文件
        let targetFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        targetFile.initWithPath(zipFilePath);

        let fileOutputStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
        fileOutputStream.init(targetFile, 0x02 | 0x08 | 0x20, 0o644, 0);

        let binaryOutputStream = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        binaryOutputStream.setOutputStream(fileOutputStream);
        binaryOutputStream.writeByteArray(zipBytes);
        binaryOutputStream.close();
        fileOutputStream.close();

        // console.log(`[MinerU] ZIP 文件已保存: ${zipFilePath}`);

        // 解压 ZIP 文件
        let extractedDirPath = await this.__unzipMinerUResult(zipFilePath);

        // 扁平化目录结构（移除本地 API 多出的中间层文件夹）
        extractedDirPath = await this.__flattenLocalExtractDir(extractedDirPath);

        return extractedDirPath;

      } else {
        // JSON 格式响应 - 需要额外处理（本地 API 通常返回 ZIP）
        const result = await response.json();
        // console.log(`[MinerU] 收到 JSON 响应:`, result);

        // 如果是 JSON 响应，需要将结果保存到文件系统
        // 这种情况较少见，本地 API 通常配置为返回 ZIP
        throw new Error('本地 API 返回了 JSON 格式，请配置 response_format_zip=true');
      }

    } catch (error) {
      console.error("[MinerU] 本地 API 调用失败:", error);
      throw error;
    }
  }

  // ==================== 统一入口 ====================

  /**
   * 处理PDF文件的主要入口函数
   * 根据 _apiMode 自动选择云端或本地 API
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<Object>} 解析结果
   */
  async processFile(filePath) {
    try {
      let result;

      if (this._apiMode === 'local') {
        // console.log(`[MinerU] 使用本地 API 模式`);
        result = await this.__callLocalMinerUAPI(filePath);
      } else {
        // console.log(`[MinerU] 使用云端 API 模式`);
        result = await this.__callMinerUAPI(filePath);
      }

      return {
        success: true,
        extractedPath: result,
        message: `PDF解析完成 (${this._apiMode === 'local' ? '本地' : '云端'} API)`,
        apiMode: this._apiMode,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      const userMessage = this.getUserFriendlyErrorMessage(error);

      return {
        success: false,
        filePath: filePath,
        error: error.message,
        message: userMessage,
        apiMode: this._apiMode,
        timestamp: new Date().toISOString(),
        configHelp: this._getConfigHelp(error)
      };
    }
  }

  /**
   * 使用云端 API 处理 PDF 文件（显式调用）
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<Object>} 解析结果
   */
  async processFileCloud(filePath) {
    const originalMode = this._apiMode;
    this._apiMode = 'cloud';
    try {
      return await this.processFile(filePath);
    } finally {
      this._apiMode = originalMode;
    }
  }

  /**
   * 使用本地 API 处理 PDF 文件（显式调用）
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<Object>} 解析结果
   */
  async processFileLocal(filePath) {
    const originalMode = this._apiMode;
    this._apiMode = 'local';
    try {
      return await this.processFile(filePath);
    } finally {
      this._apiMode = originalMode;
    }
  }

  /**
   * 根据错误类型获取配置帮助信息
   * @param {Error} error - 错误对象
   * @returns {Object|null} 配置帮助信息
   */
  _getConfigHelp(error) {
    const errorMessage = error.message.toLowerCase();

    if (this._apiMode === 'cloud' && (errorMessage.includes('url') || errorMessage.includes('公开'))) {
      return {
        step1: 'Cloudflare Worker API 需要公开可访问的 PDF URL',
        step2: '方案1: 使用本地 API 模式 (setApiMode("local"))',
        step3: '方案2: 使用 processFileByUrl(url) 方法直接传入 PDF URL'
      };
    } else if (this._apiMode === 'local' && (errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('econnrefused'))) {
      return {
        step1: '确保本地 MinerU FastAPI 服务已启动',
        step2: `检查服务是否运行在 ${LOCAL_MINERU_API_URL}`,
        step3: '启动命令示例: uvicorn mineru_api:app --host 0.0.0.0 --port 8000'
      };
    }

    return null;
  }

  /**
   * 获取用户友好的错误消息
   * @param {Error} error - 错误对象
   * @returns {string} 用户友好的错误消息
   */
  getUserFriendlyErrorMessage(error) {
    const errorMessage = error.message.toLowerCase();

    // Cloudflare Worker API 相关错误
    if (errorMessage.includes('公开') || errorMessage.includes('url')) {
      return 'Cloudflare Worker API 需要公开可访问的 PDF URL，本地文件请使用本地 API 模式';
    } else if (errorMessage.includes('task_id') || errorMessage.includes('taskid')) {
      return '任务提交失败，请检查 PDF URL 是否有效';
    }
    // 云端 API 相关错误
    else if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || errorMessage.includes('api token')) {
      return 'API Token无效或已过期，请检查配置';
    } else if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
      return 'API访问被拒绝，请检查权限设置';
    } else if (errorMessage.includes('404') || errorMessage.includes('not found')) {
      return 'API端点不存在，请检查API版本';
    } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      return 'API调用频率超限，请稍后重试';
    } else if (errorMessage.includes('500') || errorMessage.includes('internal server')) {
      return 'MinerU服务器内部错误，请稍后重试';
    }
    // 本地 API 相关错误
    else if (errorMessage.includes('econnrefused') || errorMessage.includes('connection refused')) {
      return `本地 MinerU API 连接被拒绝，请确保服务已启动 (${LOCAL_MINERU_API_URL})`;
    } else if (errorMessage.includes('localhost') || errorMessage.includes('127.0.0.1')) {
      return '本地 MinerU API 服务未响应，请检查服务状态';
    }
    // 通用错误
    else if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
      return '网络连接失败，请检查网络设置';
    } else if (errorMessage.includes('timeout')) {
      return 'MinerU处理超时，文件可能过大或服务繁忙';
    } else if (errorMessage.includes('file') && errorMessage.includes('not found')) {
      return '找不到指定的PDF文件';
    } else if (errorMessage.includes('zip')) {
      return 'ZIP文件处理失败，请检查解析结果';
    } else {
      return `MinerU处理失败: ${error.message}`;
    }
  }
}

// MinerUParser类仅供同目录下的pdfParser.js使用，不需要导出到全局命名空间