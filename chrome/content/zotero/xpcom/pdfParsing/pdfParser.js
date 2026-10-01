/**
 * PDF解析模块入口
 * 提供统一的PDF解析接口
 */

// 在Zotero环境中，Components、Services等全局对象已经可用
// 不需要额外导入，直接使用即可

// 导入MinerU解析器
// 在XPCOM环境中，需要先加载MinerU.js文件
Services.scriptloader.loadSubScript("chrome://zotero/content/xpcom/pdfParsing/MinerU/MinerU.js");

// 导入LLM API模块
Services.scriptloader.loadSubScript("chrome://zotero/content/xpcom/pdfParsing/LLMApi/llmapi.js");

// 导入JSON工具类
/**
 * XPCOM环境下的JSON处理工具函数
 * 由于XPCOM环境中JSON对象可能不完整，提供统一的JSON处理方法
 */
Services.scriptloader.loadSubScript("chrome://zotero/content/xpcom/pdfParsing/jsonUtils.js");

/**
 * PDF解析器类
 * 作为统一的入口点，调用具体的解析实现
 */
class PDFParser {
  constructor() {
    // 直接使用MinerUParser类，无需通过Zotero命名空间
    this.mineruParser = new MinerUParser();
  }

  /**
   * 设置 MinerU API 模式
   * @param {string} mode - 'cloud' 或 'local'
   */
  setApiMode(mode) {
    this.mineruParser.setApiMode(mode);
  }

  /**
   * 获取当前 MinerU API 模式
   * @returns {string} 'cloud' 或 'local'
   */
  getApiMode() {
    return this.mineruParser.getApiMode();
  }

  /**
   * 设置 MinerU 轮询状态回调
   * @param {Function|null} callback
   */
  setMinerUPollStatusCallback(callback) {
    this.mineruParser.setPollStatusCallback(callback);
  }

  /**
   * 检查本地 MinerU API 是否可用
   * @returns {Promise<boolean>} 是否可用
   */
  async isLocalAPIAvailable() {
    return await this.mineruParser.isLocalAPIAvailable();
  }

  /**
   * 处理contentList数据，为每个对象添加唯一ID
   * @param {Array} contentListData - 原始的contentList数据数组
   * @returns {Object} 包含处理后数据
   */
  processContentListData(contentListData) {
    if (!contentListData || !Array.isArray(contentListData)) {
      console.warn("contentListData不是有效的数组:", contentListData);
      return contentListData;
    }

    // 为每个对象添加唯一ID
    const processedData = contentListData.map((item, index) => {
      return {
        id: index,
        ...item
      };
    });

    return processedData;
  }

  /**
   * 处理PDF文件的主要入口函数
   * @param {string} filePath - PDF文件路径
   * @returns {Promise<Object>} 解析结果
   */
  async processFile(filePath) {
    // 原始实现已注释掉，现在直接读取预处理的JSON文件
    // 1. MinerU解析pdf文件
    let resultData, resultDir;
    try {
      // 调用MinerU解析器处理文件
      resultData = await this.mineruParser.processFile(filePath);

      // 检查 MinerU 解析结果
      if (!resultData.success) {
        // MinerU 返回失败，直接传递错误信息
        console.error('解析失败:', resultData.message || resultData.error);
        return {
          success: false,
          filePath: filePath,
          error: resultData.error || resultData.message,
          message: resultData.message || `解析失败: ${resultData.error}`,
          timestamp: Zotero.Date.getUnixTimestamp()
        };
      }

      resultDir = resultData["extractedPath"];

      // 2. 在resultDir目录下搜索以content_list.json结尾的文件
      const contentListData = await this.findAndReadContentList(resultDir);

      // 3. 对json进行后处理
      const processedContentList = this.processContentListData(contentListData);
      // console.log("处理后的JSON数据:", this.stringifyJSON(processedContentList));


      return {
        success: true,
        filePath: filePath,
        resultDir: resultDir,
        contentList: processedContentList,
        timestamp: Zotero.Date.getUnixTimestamp()
      };

    } catch (error) {
      console.error("PDF解析失败:", error);

      return {
        success: false,
        filePath: filePath,
        resultDir: resultDir,
        error: error.message,
        message: `PDF解析失败: ${error.message}`,
        timestamp: Zotero.Date.getUnixTimestamp()
      };
    }
  }

  /**
   * 调用LLM API处理PDF内容
   * @param {string} prompt - LLM API请求的prompt
   * @param {Object} options - LLM 请求选项（可包含 response_format/json_schema）
   * @returns {Promise<Object>} 处理结果
   */
  async llmRequest(prompt, options = undefined) {
    try {
      const response = await callZhipuAI(prompt, options || {});
      // console.log('[pdfParser] LLM API 响应:', response);
      const content = response?.choices?.[0]?.message?.content;
      if (!content) {
        console.warn('[pdfParser] LLM 响应为空，返回空字符串');
        return '';
      }

      // 尝试解析 LLM 返回的内容
      const parsedResult = this._parseLLMResponse(content);

      if (parsedResult !== null) {
        // 如果解析成功
        if (Array.isArray(parsedResult)) {
          // 数组格式：直接返回解析后的数组（兼容旧的段落处理逻辑）
          // console.log('[pdfParser] 返回解析后的数组，长度:', parsedResult.length);
          return parsedResult;
        } else if (typeof parsedResult === 'object') {
          // 对象格式：返回原始 JSON 字符串（供 articleSummaryRequest 使用）
          // console.log('[pdfParser] 返回原始 JSON 字符串');
          return content;
        }
      }

      // 解析失败，返回原始内容
      console.warn('[pdfParser] 无法解析 LLM 响应，返回原始内容');
      return content;
    }
    catch (error) {
      console.error('[pdfParser] LLM API 调用失败:', error);
      // 统一向上抛出，保留 callBailianAI 等返回的 HTTP 状态、body、headers（见 llmapi 的 HTTP错误完整详情）
      // 避免返回 '' 导致 reader 把空串当 JSON 解析，掩盖真实 502/5xx 等原因
      throw error;
    }
  }

  /**
   * 解析 LLM 返回的 JSON 内容（支持对象和数组）
   * @param {string} content - LLM 返回的文本内容
   * @returns {Object|Array|null} 解析后的结果或 null
   */
  _parseLLMResponse(content) {
    if (!content) {
      return null;
    }
    let trimmed = content.trim();

    // 1. 尝试直接解析整个内容
    try {
      const directParsed = JSONUtils.parseJSON(trimmed);
      if (directParsed !== null && typeof directParsed === 'object') {
        // console.log('[pdfParser] 直接解析成功');
        return directParsed;
      }
    }
    catch (error) {
      console.warn('[pdfParser] 直接解析失败，尝试提取 JSON:', error);
    }

    // 2. 尝试提取 JSON 对象（优先）
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSONUtils.parseJSON(objectMatch[0]);
        if (parsed !== null && typeof parsed === 'object') {
          // console.log('[pdfParser] 提取 JSON 对象成功');
          return parsed;
        }
      }
      catch (error) {
        console.warn('[pdfParser] 提取的 JSON 对象解析失败，尝试修复:', error);
        // 尝试修复被截断或格式错误的 JSON
        try {
          const fixed = this._fixMalformedJSON(objectMatch[0]);
          const parsed = JSONUtils.parseJSON(fixed);
          if (parsed !== null && typeof parsed === 'object') {
            console.warn('[pdfParser] ⚠️ JSON 格式错误，已通过修复恢复');
            return parsed;
          }
        } catch (fixError) {
          console.warn('[pdfParser] JSON 修复失败:', fixError);
        }
      }
    }

    // 3. 尝试提取 JSON 数组（兼容旧逻辑）
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSONUtils.parseJSON(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          // console.log('[pdfParser] 提取 JSON 数组成功');
          return parsed;
        }
      }
      catch (error) {
        console.warn('[pdfParser] 提取的 JSON 数组解析失败，尝试修复:', error);
        // 尝试修复被截断或格式错误的 JSON
        try {
          const fixed = this._fixMalformedJSON(arrayMatch[0]);
          const parsed = JSONUtils.parseJSON(fixed);
          if (Array.isArray(parsed)) {
            console.warn('[pdfParser] ⚠️ JSON 格式错误，已通过修复恢复');
            return parsed;
          }
        } catch (fixError) {
          console.warn('[pdfParser] JSON 修复失败:', fixError);
        }
      }
    }

    return null;
  }

  /**
   * 修复格式错误的 JSON（处理未闭合的字符串、缺失的括号等）
   * @param {string} json - 格式错误的 JSON 字符串
   * @returns {string} 修复后的 JSON 字符串
   */
  _fixMalformedJSON(json) {
    let fixed = json;

    // 1. 修复未闭合的字符串
    // 通过扫描找到最后一个未闭合的字符串
    let inString = false;
    let escaped = false;
    let lastStringStart = -1;

    for (let i = 0; i < fixed.length; i++) {
      const char = fixed[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        if (inString) {
          inString = false;
        } else {
          inString = true;
          lastStringStart = i;
        }
      }
    }

    // 如果最后还有未闭合的字符串，添加闭合引号
    if (inString) {
      fixed += '"';
    }

    // 2. 补全缺失的闭合符号
    let openBraces = (fixed.match(/\{/g) || []).length;
    let closeBraces = (fixed.match(/\}/g) || []).length;
    let openBrackets = (fixed.match(/\[/g) || []).length;
    let closeBrackets = (fixed.match(/\]/g) || []).length;

    while (closeBraces < openBraces) {
      fixed += '}';
      closeBraces++;
    }
    while (closeBrackets < openBrackets) {
      fixed += ']';
      closeBrackets++;
    }

    // 3. 移除末尾可能的逗号（JSON 不允许）
    fixed = fixed.replace(/,\s*([}\]])/, '$1');

    return fixed;
  }

  /**
   * 在指定目录下搜索以content_list.json结尾的文件并读取内容
   * @param {string} dirPath - 要搜索的目录路径
   * @returns {Promise<Object|null>} JSON文件内容或null
   */
  async findAndReadContentList(dirPath) {
    try {
      // console.log("在", dirPath, "中查找content list")
      // 获取目录对象
      const dir = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      dir.initWithPath(dirPath);

      if (!dir.exists() || !dir.isDirectory()) {
        console.warn("目录不存在或不是有效目录:", dirPath);
        return null;
      }

      // 遍历目录寻找以content_list.json结尾的文件
      const entries = dir.directoryEntries;
      while (entries.hasMoreElements()) {
        const entry = entries.getNext().QueryInterface(Components.interfaces.nsIFile);

        if (entry.isFile() && entry.leafName.endsWith("content_list.json")) {
          // console.log("找到content_list.json文件:", entry.path);

          // 读取JSON文件内容
          const fileContent = await this.readJSONFile(entry.path);
          return fileContent;
        }
      }

      console.warn("未找到以content_list.json结尾的文件");
      return null;

    } catch (error) {
      console.error("搜索content_list.json文件时出错:", error);
      return null;
    }
  }

  /**
   * 读取JSON文件内容
   * @param {string} filePath - JSON文件路径
   * @returns {Promise<Object|null>} 解析后的JSON对象或null
   */
  async readJSONFile(filePath) {
    return await Zotero.JSONUtils.readJSONFile(filePath);
  }
}

// 导出PDF解析器类到Zotero命名空间，符合XPCOM模块惯例
Zotero.PDFParser = PDFParser;

// 单例模式：全局 PDFParser 实例缓存
let _pdfParserInstance = null;

/**
 * 获取或创建 PDFParser 单例实例
 * @returns {PDFParser} 全局唯一的 PDFParser 实例
 */
function getPDFParserInstance() {
  if (!_pdfParserInstance) {
    _pdfParserInstance = new Zotero.PDFParser();
  }
  return _pdfParserInstance;
}

// 创建 pdfParser 模块接口（单例模式）
Zotero.pdfParser = {
  /**
   * 处理 PDF 文件（复用单例实例）
   * @param {string} filePath - PDF 文件路径
   * @returns {Promise<Object>} 解析结果
   */
  processFile: async function (filePath) {
    return await getPDFParserInstance().processFile(filePath);
  },

  /**
   * 调用 LLM API（复用单例实例）
   * @param {string} prompt - LLM 提示词
   * @param {Object} options - LLM 请求选项（可包含 response_format/json_schema）
   * @returns {Promise<Array>} LLM 返回结果
   */
  llmRequest: async function (prompt, options) {
    return await getPDFParserInstance().llmRequest(prompt, options);
  },

  /**
   * 设置 MinerU API 模式
   * @param {string} mode - 'cloud' 或 'local'
   */
  setApiMode: function (mode) {
    getPDFParserInstance().setApiMode(mode);
  },

  /**
   * 获取当前 MinerU API 模式
   * @returns {string} 'cloud' 或 'local'
   */
  getApiMode: function () {
    return getPDFParserInstance().getApiMode();
  },

  /**
   * 设置 MinerU 轮询状态回调（reader 等调用）
   * @param {Function|null} callback
   */
  setMinerUPollStatusCallback: function (callback) {
    getPDFParserInstance().setMinerUPollStatusCallback(callback);
  },

  /**
   * 检查本地 MinerU API 是否可用
   * @returns {Promise<boolean>} 是否可用
   */
  isLocalAPIAvailable: async function () {
    return await getPDFParserInstance().isLocalAPIAvailable();
  },

  /**
   * 获取当前 PDFParser 实例（可选，用于调试或特殊需求）
   * @returns {PDFParser|null} 当前实例或 null
   */
  getInstance: function () {
    return _pdfParserInstance;
  },

  /**
   * 重置 PDFParser 实例（可选，用于清理资源）
   */
  reset: function () {
    _pdfParserInstance = null;
  }
};