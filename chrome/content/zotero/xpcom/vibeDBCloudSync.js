/*
	***** BEGIN LICENSE BLOCK *****
    
	Copyright © 2024 VibeZotero
    
	This file is part of VibeZotero.
    
	VibeZotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
    
	***** END LICENSE BLOCK *****
*/

"use strict";

/**
 * VibeDB 云同步模块
 * 负责将本地 VibeDB（SQLite）数据同步到 Supabase（PostgreSQL）
 * 
 * 同步策略：
 * 1. 首次全量同步：按依赖拓扑执行全细粒度批量同步
 * 2. 增量同步：基于 updated_at 字段，只同步有变化的数据
 * 3. 本地优先：发生冲突时，本地数据优先
 * 4. 定时后台同步 + 显式入口同步：每 1 小时自动同步一次，另支持手动点击和 onflow 完成后的上传
 * 
 * 架构说明：
 * - 本地使用 INTEGER 作为主键，云端使用 UUID
 * - papers / ai_chats 通过稳定附件键匹配跨设备记录
 * - flash_cards / summary_cards 通过 client_uuid 匹配跨设备记录
 * - paragraphs / points / article_summary / sections / sentences 已切到全细粒度同步
 * - 不再使用 id_mapping 表
 */

Zotero.VibeDBCloudSync = new function () {

  // 同步配置
  const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 小时
  const DEBOUNCE_DELAY_MS = 3 * 1000; // 3 秒（数据变化后的防抖延迟）
  const TABLES_TO_SYNC = ['papers', 'ai_chats', 'flash_cards', 'summary_cards'];
  const CLOUD_PAPERS_TABLE = 'papers_sync';
  const FULL_SYNC_PHASE_CONCURRENCY = 2;
  const INCREMENTAL_PHASE_CONCURRENCY = 4;
  const FULL_SYNC_PAPER_CONCURRENCY = 1;
  const INCREMENTAL_SYNC_PAPER_CONCURRENCY = 2;
  const PAPER_PHASE_CONCURRENCY = 2;
  const BATCH_SIZE_SMALL = 50;
  const BATCH_SIZE_MEDIUM = 100;
  const BATCH_SIZE_LARGE = 200;
  const MIN_UPLOAD_HEADROOM_BYTES = 64 * 1024;
  const CLOUD_SCAN_PAGE_SIZE = 500;
  const CLOUD_DOWNLOAD_PAGE_SIZE = 200;
  // 下载水位推进时回退的安全窗口，防止并发事务提交顺序差异导致漏下载
  const REVISION_SAFETY_WINDOW = 10;
  const ALL_SYNC_TABLES = [
  'papers',
  'article_summary',
  'sections',
  'paragraphs',
  'points',
  'sentences',
  'ai_chats',
  'summary_cards',
  'flash_cards'];


  /**
   * 获取云同步专用配置 — 委托给 vibeDBSync，统一由构建时注入区域配置
   */
  this.getCloudSyncConfig = function () {
    return Zotero.VibeDBSync.getSupabaseConfig();
  };

  /**
   * 云同步与主登录模块当前共用同一个正式 Supabase 项目
   */
  this._isDedicatedCloudSyncProject = function () {
    return false;
  };

  // 同步状态
  let _syncTimer = null; // 1 小时后台同步定时器
  let _debounceTimer = null; // 保留 stopAutoSync 兼容清理逻辑
  let _isSyncing = false;
  let _lastSyncTime = null;
  let _lastRemoteRevision = 0;
  let _hasPendingChanges = false; // 是否有待同步的更改
  let _syncRunSeq = 0;
  let _currentSyncTraceId = null;
  let _warnedKeys = new Set();

  function _updateSyncIndicators(isSyncing) {
    try {
      const mainWindow = Zotero.getMainWindow();
      if (!mainWindow) {
        return;
      }

      mainWindow.ZoteroPane?.setCloudSyncButtonSyncing?.(isSyncing);

      const accountIframe = mainWindow.document.getElementById('account-status-iframe');
      accountIframe?.contentWindow?.setSyncingState?.(isSyncing);
    }
    catch (e) {
      Zotero.debug(`[VibeDBCloudSync] 更新同步状态指示器失败: ${e}`);
    }
  }

  async function _ensureInitialPreSyncBackup(traceId) {
    const prefKey = 'sync.vibedb.preSyncBackupCreated';
    if (Zotero.Prefs.get(prefKey)) {
      return;
    }

    try {
      const conn = Zotero.VibeDB.getConnection();
      await conn.backUpDatabase({
        suffix: 'pre-sync',
        force: true,
        online: true
      });
      Zotero.Prefs.set(prefKey, true);
      // console.log(`[VibeDBCloudSync][${traceId}] 已创建首次云同步前备份 vibeDB.sqlite.pre-sync.bak`);
    }
    catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] 创建首次云同步前备份失败:`, e);
      throw e;
    }
  }

  function _buildSyncTraceId(trigger = 'unknown') {
    _syncRunSeq += 1;
    return `${trigger}-${Date.now()}-${_syncRunSeq}`;
  }

  function _warnOnce(traceId, key, ...args) {
    const dedupeKey = `${traceId}:${key}`;
    if (_warnedKeys.has(dedupeKey)) {
      return;
    }
    _warnedKeys.add(dedupeKey);
    console.warn(...args);
  }

  function _toSyncRevision(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  }

  function _ensureLastRemoteRevisionLoaded() {
    if (_lastRemoteRevision > 0) {
      return _lastRemoteRevision;
    }
    const saved = Zotero.Prefs.get('sync.vibedb.lastRemoteRevision');
    _lastRemoteRevision = _toSyncRevision(saved);
    return _lastRemoteRevision;
  }

  function _persistLastRemoteRevision(revision) {
    const normalized = _toSyncRevision(revision);
    if (normalized <= _lastRemoteRevision) {
      return _lastRemoteRevision;
    }
    _lastRemoteRevision = normalized;
    Zotero.Prefs.set('sync.vibedb.lastRemoteRevision', String(normalized));
    return _lastRemoteRevision;
  }

  async function _markLocalRowsSyncClean(table, idColumn, ids) {
    const uniqueIDs = Array.from(new Set((ids || []).filter((id) => id !== null && id !== undefined)));
    if (!uniqueIDs.length) {
      return;
    }
    const conn = Zotero.VibeDB.getConnection();
    const placeholders = uniqueIDs.map(() => '?').join(', ');
    await conn.queryAsync(
      `UPDATE ${table} SET sync_dirty = 0 WHERE ${idColumn} IN (${placeholders})`,
      uniqueIDs
    );
  }

  async function _clearLocalPaperSyncIndexTables(paperID, tableNames) {
    if (!paperID || !Zotero.VibeDB?.Papers?.clearSyncIndexTables) {
      return;
    }
    await Zotero.VibeDB.Papers.clearSyncIndexTables(paperID, tableNames);
  }

  function _hasAttachmentIdentity(record) {
    return !!(record && record.attachment_library_id && record.attachment_key);
  }

  async function _resolveLocalItemIDFromAttachmentIdentity(record) {
    if (!_hasAttachmentIdentity(record)) {
      return null;
    }

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        record.attachment_library_id,
        record.attachment_key
      );
      return item ? item.id : null;
    }
    catch (e) {
      Zotero.debug(`[VibeDBCloudSync] _resolveLocalItemIDFromAttachmentIdentity failed: ${e}`);
      return null;
    }
  }

  async function _resolveUploadAttachmentIdentity(record) {
    if (_hasAttachmentIdentity(record)) {
      const localItemID = await _resolveLocalItemIDFromAttachmentIdentity(record);
      if (localItemID) {
        return {
          attachment_library_id: record.attachment_library_id,
          attachment_key: record.attachment_key
        };
      }
    }

    if (!record || !record.item_id || !Zotero.VibeDB?.Papers?.getAttachmentIdentityForItem) {
      return null;
    }

    try {
      const identity = await Zotero.VibeDB.Papers.getAttachmentIdentityForItem(record.item_id);
      if (identity?.attachmentLibraryID && identity?.attachmentKey) {
        return {
          attachment_library_id: identity.attachmentLibraryID,
          attachment_key: identity.attachmentKey
        };
      }
    }
    catch (e) {
      Zotero.debug(`[VibeDBCloudSync] _resolveUploadAttachmentIdentity failed for item ${record.item_id}: ${e}`);
    }

    return null;
  }

  function _stableIntegerFromString(value) {
    let str = String(value || '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i) | 0;
    }
    if (hash === 0) {
      hash = 1;
    }
    return hash < 0 ? hash : -hash;
  }

  function _normalizeSectionTitleBlockID(value, fallbackKey = '') {
    if (value === null || value === undefined || value === '') {
      return _stableIntegerFromString(`null:${fallbackKey}`);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
      return parseInt(value.trim(), 10);
    }
    return _stableIntegerFromString(`tb:${value}:${fallbackKey}`);
  }

  /**
   * 初始化云同步模块
   */
  this.init = async function () {
    // console.log('[VibeDBCloudSync] 初始化云同步模块...');

    try {
      // 恢复上次同步时间
      const lastSync = Zotero.Prefs.get('sync.vibedb.lastSyncTime');
      if (lastSync) {
        _lastSyncTime = new Date(lastSync);
        // console.log(`[VibeDBCloudSync] 上次同步时间: ${_lastSyncTime.toLocaleString()}`);
      }

      // console.log('[VibeDBCloudSync] ✅ 云同步模块初始化完成');
    } catch (e) {
      console.error('[VibeDBCloudSync] ❌ 初始化失败:', e);
    }
  };

  /**
   * 获取当前用户的 access_token（自动刷新过期 token）
   */
  this._getAccessToken = async function () {
    let session = Zotero.VibeDBSync._supabaseSession;

    // 如果内存中没有，从 Prefs 加载
    if (!session || !session.access_token) {
      session = Zotero.VibeDBSync._loadSessionFromPrefs();
      if (session) {
        Zotero.VibeDBSync._supabaseSession = session;
      }
    }

    if (!session || !session.access_token) {
      // console.log('[VibeDBCloudSync] ⚠️ Session 不存在');
      return null;
    }

    if (Zotero.VibeDBSync.isSessionFromCurrentProject &&
    !Zotero.VibeDBSync.isSessionFromCurrentProject(session)) {
      console.log('[VibeDBCloudSync] Session 来自另一个 Supabase 项目，清除登录态');
      Zotero.VibeDBSync.handleAuthInvalid?.('当前登录信息与此版本不匹配，请重新登录');
      this.stopAutoSync();
      return null;
    }

    // 检查 token 是否即将过期（提前 5 分钟刷新）
    const expiresAt = session.expires_at || 0;
    const now = Math.floor(Date.now() / 1000);
    const shouldRefresh = expiresAt - now < 300; // 5 分钟内过期

    if (shouldRefresh && session.refresh_token) {
      // console.log(`[VibeDBCloudSync] Token 即将过期（剩余 ${Math.floor((expiresAt - now) / 60)} 分钟），自动刷新...`);
      try {
        const newSession = await this._refreshToken(session.refresh_token);
        if (newSession && newSession.access_token) {
          // 更新 session
          Zotero.VibeDBSync._supabaseSession = newSession;
          Zotero.VibeDBSync.saveSupabaseSession(newSession);
          // console.log('[VibeDBCloudSync] ✅ Token 刷新成功');
          return newSession.access_token;
        } else {
          console.error('[VibeDBCloudSync] ❌ Token 刷新返回无效 session');
        }
      } catch (e) {
        console.error('[VibeDBCloudSync] ❌ Token 刷新失败:', e.message);

        // 如果刷新失败，检查是否因为 refresh_token 也过期了
        if (e.message && (e.message.includes('401') || e.message.includes('Invalid Refresh Token'))) {
          console.error('[VibeDBCloudSync] ⚠️ Refresh token 已失效，需要重新登录');
          Zotero.VibeDBSync.handleAuthInvalid?.();
          // 停止自动同步
          this.stopAutoSync();
          return null;
        }

        // 其他错误（网络问题等），检查 token 是否已完全过期
        if (expiresAt > 0 && now >= expiresAt) {
          console.error('[VibeDBCloudSync] ⚠️ Token 已过期且刷新失败，需要重新登录');
          Zotero.VibeDBSync.handleAuthInvalid?.();
          this.stopAutoSync();
          return null;
        }

        // Token 还未完全过期，继续使用（可能是临时网络问题）
        console.warn('[VibeDBCloudSync] ⚠️ Token 刷新失败但尚未完全过期，继续使用旧 token');
      }
    }

    // 最后检查：如果 token 已完全过期，拒绝返回
    if (expiresAt > 0 && now >= expiresAt) {
      console.error('[VibeDBCloudSync] ⚠️ Token 已过期且无法刷新');
      Zotero.VibeDBSync.handleAuthInvalid?.();
      this.stopAutoSync();
      return null;
    }

    return session.access_token;
  };

  /**
   * 刷新 access_token
   */
  this._refreshToken = async function (refreshToken) {
    // console.log('[VibeDBCloudSync] 使用 refresh_token 刷新 access_token');

    if (!refreshToken || refreshToken.trim() === '') {
      throw new Error('Refresh token 为空');
    }

    try {
      // 动态获取配置
      const config = Zotero.VibeDBSync.getSupabaseConfig();
      const SUPABASE_URL = config.url;
      const SUPABASE_ANON_KEY = config.anonKey;

      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refresh_token: refreshToken
        })
      });

      const data = await response.json();

      if (!response.ok) {
        // 详细的错误处理
        const errorMsg = data.error_description || data.msg || data.error || '未知错误';
        console.error('[VibeDBCloudSync] 刷新 token 失败:', response.status, errorMsg);

        // 401 通常表示 refresh_token 已过期或无效
        if (response.status === 401) {
          throw new Error(`Invalid Refresh Token: ${errorMsg}`);
        }

        throw new Error(`刷新 token 失败 (${response.status}): ${errorMsg}`);
      }

      // 验证返回数据
      if (!data.access_token || !data.refresh_token) {
        console.error('[VibeDBCloudSync] 刷新返回的数据不完整:', data);
        throw new Error('刷新返回的 session 数据不完整');
      }

      // console.log('[VibeDBCloudSync] ✅ Token 刷新成功，新 token 过期时间:', new Date(data.expires_at * 1000).toLocaleString());

      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        expires_in: data.expires_in,
        token_type: data.token_type,
        user: data.user
      };
    } catch (e) {
      console.error('[VibeDBCloudSync] 刷新 token 异常:', e.message);
      throw e;
    }
  };

  /**
   * 获取当前用户 ID
   * 正式模式下必须使用当前登录用户
   */
  this._getUserId = function () {
    const user = Zotero.VibeDBSync && Zotero.VibeDBSync.getCurrentUser ?
    Zotero.VibeDBSync.getCurrentUser() :
    null;
    return user ? user.id : null;
  };

  /**
   * 发起 Supabase REST API 请求
   */
  this._supabaseRequest = async function (endpoint, method = 'GET', body = null, options = {}) {
    const { url: _sbUrl, anonKey: _sbKey } = Zotero.VibeDBSync.getSupabaseConfig();
    const headers = {
      'apikey': _sbKey,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation'
    };

    const token = await this._getAccessToken();
    if (!token) {
      Zotero.VibeDBSync?.handleAuthInvalid?.();
      throw new Error('云同步需要有效登录态，请先登录 Vibero 账号');
    }
    headers['Authorization'] = `Bearer ${token}`;

    const requestBodyConfig = {
      method,
      headers
    };

    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      requestBodyConfig.body = JSON.stringify(body);
    }

    const url = `${_sbUrl}/rest/v1/${endpoint}`;
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const verboseHTTP = !!options.verboseHTTP;
    if (verboseHTTP) {
      console.log(`[VibeDBCloudSync][${traceId}] REST ${method} ${endpoint}`, {
        hasBody: !!body,
        usingDedicatedProject: this._isDedicatedCloudSyncProject(),
        hasAuthorization: !!headers.Authorization
      });
    }

    try {
      const response = await fetch(url, requestBodyConfig);
      if (verboseHTTP) {
        console.log(`[VibeDBCloudSync][${traceId}] REST 响应 ${method} ${endpoint}: ${response.status}`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[VibeDBCloudSync] API 错误: ${response.status}`, errorText);
        if (response.status === 401 || response.status === 403) {
          Zotero.VibeDBSync?.handleAuthInvalid?.();
        }
        throw new Error(`Supabase API 错误: ${response.status} - ${errorText}`);
      }

      // 检查是否有内容返回
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync] 请求失败: ${url}`, e);
      throw e;
    }

    return null;
  };

  // ── 云同步空间配额 ──

  /**
   * 调用 Supabase RPC 函数
   */
  this._supabaseRPC = async function (fnName, params = {}, options = {}) {
    const token = await this._getAccessToken();
    if (!token) {
      Zotero.VibeDBSync?.handleAuthInvalid?.();
      throw new Error('云同步需要有效登录态');
    }
    const { url: _sbUrl, anonKey: _sbKey } = Zotero.VibeDBSync.getSupabaseConfig();
    const url = `${_sbUrl}/rest/v1/rpc/${fnName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': _sbKey,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401 || response.status === 403) {
        Zotero.VibeDBSync?.handleAuthInvalid?.();
      }
      throw new Error(`RPC ${fnName} 失败: ${response.status} - ${errorText}`);
    }
    return await response.json();
  };

  /**
   * 获取当前用户的云同步配额状态
   * @returns {Object} { plan_tier, base_quota_mb, addon_quota_mb, total_quota_bytes, used_bytes, remaining_bytes, paper_count, over_quota }
   */
  this.getCloudSyncQuota = async function () {
    return await this._supabaseRPC('get_cloud_sync_quota');
  };

  function _isQuotaExhausted(quota) {
    if (!quota || typeof quota !== 'object') {
      return false;
    }
    if (quota.over_quota) {
      return true;
    }
    const remainingBytes = Number(quota.remaining_bytes);
    return Number.isFinite(remainingBytes) && remainingBytes <= 0;
  }

  function _isQuotaNearlyExhausted(quota) {
    if (!quota || typeof quota !== 'object') {
      return false;
    }
    if (_isQuotaExhausted(quota)) {
      return false;
    }
    const remainingBytes = Number(quota.remaining_bytes);
    return Number.isFinite(remainingBytes) && remainingBytes < MIN_UPLOAD_HEADROOM_BYTES;
  }

  /**
   * 检查单篇论文是否允许上传（预检查）
   * 服务端根据已有 usage 记录判断，客户端不需要传大小
   */
  this._checkPaperQuota = async function (attachmentLibraryId, attachmentKey) {
    return await this._supabaseRPC('check_paper_quota', {
      p_attachment_library_id: attachmentLibraryId,
      p_attachment_key: attachmentKey
    });
  };

  /**
   * 上传成功后提交论文用量
   * 服务端自动用 pg_column_size 计算该论文在云端各表的真实占用
   */
  this._commitPaperUsage = async function (attachmentLibraryId, attachmentKey) {
    return await this._supabaseRPC('commit_paper_usage', {
      p_attachment_library_id: attachmentLibraryId,
      p_attachment_key: attachmentKey
    });
  };

  // ── Batch sync & concurrency config ──
  const UPLOAD_BATCH_SIZE = 30; // cards 等小 payload 表的批量写入大小
  const UPLOAD_BATCH_SIZE_LARGE = 10; // papers 等大 payload 表的批量写入大小
  const TABLE_UPLOAD_CONCURRENCY = 4; // 上传阶段：4 张表并行
  const TABLE_DOWNLOAD_CONCURRENCY = 3; // 下载阶段：papers 先行，其余 3 张表并行
  const PATCH_CONCURRENCY = 5; // 单表 PATCH 请求并发上限

  /**
   * 并发池：以限定并发度执行一组异步任务
   * @param {Array<Function>} taskFns - 返回 Promise 的函数数组
   * @param {number} concurrency - 最大并发数
   * @returns {Array<{ok: boolean, value?, error?}>}
   */
  async function _concurrentRun(taskFns, concurrency = 4) {
    const results = [];
    let idx = 0;
    async function worker() {
      while (idx < taskFns.length) {
        const i = idx++;
        try {
          results[i] = { ok: true, value: await taskFns[i]() };
        } catch (e) {
          results[i] = { ok: false, error: e };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, taskFns.length) }, () => worker())
    );
    return results;
  }

  /**
   * 批量 GET 某张表中该用户的所有记录（仅返回指定列，节省带宽）
   * 用于在内存中做 LWW 过滤，避免逐条 GET
   */
  this._pagedSupabaseGet = async function* (endpointBase, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const pageSize = options.pageSize || CLOUD_SCAN_PAGE_SIZE;
    const prefer = options.prefer || 'return=representation';
    let offset = 0;

    while (true) {
      let endpoint = _appendQueryParam(endpointBase, 'limit', pageSize);
      endpoint = _appendQueryParam(endpoint, 'offset', offset);
      const rows = await this._supabaseRequest(endpoint, 'GET', null, { traceId, prefer });
      const normalizedRows = Array.isArray(rows) ? rows : [];
      if (!normalizedRows.length) {
        break;
      }
      yield normalizedRows;
      if (normalizedRows.length < pageSize) {
        break;
      }
      offset += normalizedRows.length;
    }
  };

  this._forEachRemotePage = async function (endpointBase, options = {}, pageHandler) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const pageSize = options.pageSize || CLOUD_DOWNLOAD_PAGE_SIZE;
    const label = _getPagingLabel(endpointBase, options.label);
    let totalRows = 0;
    let pageNo = 0;

    for await (const rows of this._pagedSupabaseGet(endpointBase, { traceId, pageSize, prefer: options.prefer })) {
      pageNo++;
      totalRows += rows.length;
      const isLastPage = rows.length < pageSize;
      // if (pageNo === 1 || pageNo % 10 === 0 || isLastPage) {
      // 	console.log(`[VibeDBCloudSync][${traceId}] paging ${label} page=${pageNo} rows=${rows.length} total=${totalRows}`);
      // }
      await pageHandler(rows, { pageNo, totalRows });
    }

    // if (pageNo > 1) {
    // 	console.log(`[VibeDBCloudSync][${traceId}] paging ${label} done total=${totalRows} pages=${pageNo}`);
    // }

    return totalRows;
  };

  this._collectPagedRemoteRows = async function (endpointBase, options = {}) {
    const rows = [];
    await this._forEachRemotePage(endpointBase, options, async (pageRows) => {
      rows.push(...pageRows);
    });
    return rows;
  };

  this._batchGetCloud = async function (table, userId, selectFields, traceId) {
    const endpointBase = `${table}?user_id=eq.${userId}&select=${selectFields}`;
    const records = [];
    for await (const rows of this._pagedSupabaseGet(endpointBase, {
      traceId,
      pageSize: CLOUD_SCAN_PAGE_SIZE
    })) {
      records.push(...rows);
    }
    return records;
  };

  /**
   * 批量 POST（插入）记录，按 batchSize 分片发送
   * @returns {{ succeeded: number, failed: number, minFailedAt: number, succeededIndices: number[] }}
   */
  this._batchInsert = async function (table, records, batchSize, traceId, getTimestamp) {
    let succeeded = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    const succeededIndices = [];
    const totalBatches = Math.ceil(records.length / batchSize);
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const batchNo = Math.floor(i / batchSize) + 1;
      try {
        const requestBatch = batch.map((record) => {
          if (!record || typeof record !== 'object') {
            return record;
          }
          const sanitized = { ...record };
          delete sanitized.__local_updated_at;
          return sanitized;
        });
        await this._supabaseRequest(table, 'POST', requestBatch, { traceId, prefer: 'return=minimal' });
        succeeded += batch.length;
        for (let j = i; j < i + batch.length; j++) succeededIndices.push(j);
      } catch (e) {
        console.error(`[VibeDBCloudSync][${traceId}] ${table}: 批量插入 ${batchNo}/${totalBatches} 失败（${batch.length} 条）`, e);
        failed += batch.length;
        if (getTimestamp) {
          for (const r of batch) {
            const ts = getTimestamp(r);
            if (Number.isFinite(ts)) {
              minFailedAt = Math.min(minFailedAt, ts);
            }
          }
        }
      }
    }
    return { succeeded, failed, minFailedAt, succeededIndices };
  };

  /**
   * 批量 UPSERT（依赖 PostgREST merge-duplicates）
   * 仅适用于云端唯一键简单明确的表，例如 (user_id, client_uuid)
   */
  this._batchUpsert = async function (table, records, batchSize, onConflict, traceId, getTimestamp) {
    let succeeded = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    const succeededIndices = [];
    const totalBatches = Math.ceil(records.length / batchSize);
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const batchNo = Math.floor(i / batchSize) + 1;
      try {
        const requestBatch = batch.map((record) => {
          if (!record || typeof record !== 'object') {
            return record;
          }
          const sanitized = { ...record };
          delete sanitized.__local_updated_at;
          return sanitized;
        });
        await this._supabaseRequest(
          `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
          'POST',
          requestBatch,
          { traceId, prefer: 'resolution=merge-duplicates,return=minimal' }
        );
        succeeded += batch.length;
        for (let j = i; j < i + batch.length; j++) succeededIndices.push(j);
      } catch (e) {
        console.error(`[VibeDBCloudSync][${traceId}] ${table}: 批量 upsert ${batchNo}/${totalBatches} 失败（${batch.length} 条）`, e);
        failed += batch.length;
        if (getTimestamp) {
          for (const r of batch) {
            const ts = getTimestamp(r);
            if (Number.isFinite(ts)) {
              minFailedAt = Math.min(minFailedAt, ts);
            }
          }
        }
      }
    }
    return { succeeded, failed, minFailedAt, succeededIndices };
  };

  function _toUnixTimestamp(value) {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === 'number') {
      return value;
    }
    const parsed = new Date(value);
    const ts = Math.floor(parsed.getTime() / 1000);
    return Number.isFinite(ts) ? ts : 0;
  }

  function _safeJSONParse(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    }
    catch (e) {
      return fallback;
    }
  }

  function _chunkRecords(records, size) {
    const chunks = [];
    for (let i = 0; i < records.length; i += size) {
      chunks.push(records.slice(i, i + size));
    }
    return chunks;
  }

  function _getPhaseConcurrency(isFirstSync) {
    return isFirstSync ? FULL_SYNC_PHASE_CONCURRENCY : INCREMENTAL_PHASE_CONCURRENCY;
  }

  function _getPaperConcurrency(isFirstSync) {
    return isFirstSync ? FULL_SYNC_PAPER_CONCURRENCY : INCREMENTAL_SYNC_PAPER_CONCURRENCY;
  }

  function _encodeFilterValue(value) {
    return encodeURIComponent(String(value));
  }

  function _appendQueryParam(endpoint, key, value) {
    return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${key}=${value}`;
  }

  function _getPagingLabel(endpointBase, explicitLabel = null) {
    if (explicitLabel) {
      return explicitLabel;
    }
    return String(endpointBase || '').split('?')[0] || 'unknown';
  }

  function _buildRemotePaperFilter(paperJob) {
    if (paperJob && paperJob.attachment_library_id && paperJob.attachment_key) {
      return `attachment_library_id=eq.${_encodeFilterValue(paperJob.attachment_library_id)}&attachment_key=eq.${_encodeFilterValue(paperJob.attachment_key)}`;
    }
    if (paperJob && paperJob.item_id) {
      return `item_id=eq.${_encodeFilterValue(paperJob.item_id)}`;
    }
    return '';
  }

  function _paperJobKey(job) {
    if (job && job.attachment_library_id && job.attachment_key) {
      return `${job.attachment_library_id}:${job.attachment_key}`;
    }
    return job && job.paper_id ? `paper:${job.paper_id}` : `item:${job && job.item_id ? job.item_id : 'unknown'}`;
  }

  function _normalizeChangedTables(changedTables) {
    if (!changedTables) {
      return [];
    }
    const values = Array.isArray(changedTables) ?
    changedTables :
    changedTables instanceof Set ?
    Array.from(changedTables) :
    [changedTables];
    return Array.from(new Set(values.filter((table) => ALL_SYNC_TABLES.includes(table)))).sort();
  }

  function _mergePaperJob(existingJob, nextJob) {
    const merged = {
      ...(existingJob || {}),
      ...(nextJob || {})
    };
    merged.force_sync = !!(existingJob?.force_sync || nextJob?.force_sync);
    merged.changed_tables = _normalizeChangedTables([
    ...(existingJob?.changed_tables || []),
    ...(nextJob?.changed_tables || [])]
    );
    return merged;
  }

  function _dedupePaperJobs(jobs) {
    const jobMap = new Map();
    for (const job of jobs || []) {
      const key = _paperJobKey(job);
      jobMap.set(key, _mergePaperJob(jobMap.get(key), job));
    }
    return Array.from(jobMap.values());
  }

  function _shouldSyncTable(job, tableName, effectiveFirstSync) {
    if (effectiveFirstSync || job?.force_sync) {
      return true;
    }
    const changedTables = _normalizeChangedTables(job?.changed_tables);
    if (!changedTables.length) {
      return true;
    }
    if (tableName === 'papers') {
      return changedTables.length > 0;
    }
    return changedTables.includes(tableName);
  }

  function _extractChangedTablesFromTableRevisions(tableRevisions, minRevision) {
    if (!tableRevisions || typeof tableRevisions !== 'object') {
      return [];
    }
    const changedTables = [];
    for (const table of ALL_SYNC_TABLES) {
      const revision = _toSyncRevision(tableRevisions[table]);
      if (revision > minRevision) {
        changedTables.push(table);
      }
    }
    return changedTables;
  }

  async function _getLocalPaperTableRevisions(paperID) {
    if (!paperID) {
      return {};
    }
    const conn = Zotero.VibeDB.getConnection();
    const queries = [
    ['papers', 'SELECT MAX(last_synced_revision) AS revision FROM papers WHERE paper_id = ?'],
    ['article_summary', 'SELECT MAX(last_synced_revision) AS revision FROM article_summary WHERE paper_id = ?'],
    ['sections', 'SELECT MAX(last_synced_revision) AS revision FROM sections WHERE paper_id = ?'],
    ['paragraphs', 'SELECT MAX(last_synced_revision) AS revision FROM paragraphs WHERE paper_id = ?'],
    ['points', `SELECT MAX(pt.last_synced_revision) AS revision
			            FROM points pt
			            JOIN paragraphs para ON pt.paragraph_id = para.paragraph_id
			            WHERE para.paper_id = ?`],
    ['sentences', `SELECT MAX(s.last_synced_revision) AS revision
			               FROM sentences s
			               JOIN paragraphs para ON s.paragraph_id = para.paragraph_id
			               WHERE para.paper_id = ?`],
    ['ai_chats', 'SELECT MAX(last_synced_revision) AS revision FROM ai_chats WHERE paper_id = ?'],
    ['summary_cards', 'SELECT MAX(last_synced_revision) AS revision FROM summary_cards WHERE paper_id = ?'],
    ['flash_cards', 'SELECT MAX(last_synced_revision) AS revision FROM flash_cards WHERE paper_id = ?']];

    const revisions = {};
    for (const [table, sql] of queries) {
      const row = await conn.rowQueryAsync(sql, [paperID]);
      revisions[table] = _toSyncRevision(row?.revision);
    }
    return revisions;
  }

  function _extractUnsyncedTablesFromRevisionMaps(remoteTableRevisions, localTableRevisions) {
    const changedTables = [];
    const remoteMap = remoteTableRevisions && typeof remoteTableRevisions === 'object' ? remoteTableRevisions : {};
    const localMap = localTableRevisions && typeof localTableRevisions === 'object' ? localTableRevisions : {};
    for (const table of ALL_SYNC_TABLES) {
      const remoteRevision = _toSyncRevision(remoteMap[table]);
      const localRevision = _toSyncRevision(localMap[table]);
      if (remoteRevision > localRevision) {
        changedTables.push(table);
      }
    }
    return changedTables;
  }

  function _sanitizeMarkdownContentForCloudSync(content) {
    if (typeof content !== 'string' || !content.includes('\u0000')) {
      return content;
    }
    return content.replace(/\u0000/g, ' ');
  }

  async function _applyLocalPaperRevisionSnapshot(paperID, tableRevisions, tables) {
    if (!paperID || !tableRevisions || typeof tableRevisions !== 'object') {
      return;
    }
    const conn = Zotero.VibeDB.getConnection();
    const targets = _normalizeChangedTables(tables);
    const updateDefs = {
      papers: ['UPDATE papers SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      article_summary: ['UPDATE article_summary SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      sections: ['UPDATE sections SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      paragraphs: ['UPDATE paragraphs SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      points: [`UPDATE points
			          SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END
			          WHERE sync_dirty = 0
			            AND paragraph_id IN (SELECT paragraph_id FROM paragraphs WHERE paper_id = ?)`, [paperID]],
      sentences: [`UPDATE sentences
			             SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END
			             WHERE sync_dirty = 0
			               AND paragraph_id IN (SELECT paragraph_id FROM paragraphs WHERE paper_id = ?)`, [paperID]],
      ai_chats: ['UPDATE ai_chats SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      summary_cards: ['UPDATE summary_cards SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]],
      flash_cards: ['UPDATE flash_cards SET last_synced_revision = CASE WHEN last_synced_revision < ? THEN ? ELSE last_synced_revision END WHERE paper_id = ? AND sync_dirty = 0', [paperID]]
    };
    for (const table of targets) {
      const revision = _toSyncRevision(tableRevisions[table]);
      if (!revision || !updateDefs[table]) {
        continue;
      }
      const [sql, tailParams] = updateDefs[table];
      await conn.queryAsync(sql, [revision, revision, ...tailParams]);
    }
  }

  async function _fetchRemotePaperRevisionSnapshot(userId, paperJob, traceId) {
    if (!paperJob?.attachment_library_id || !paperJob?.attachment_key) {
      return null;
    }
    const endpoint = `paper_sync_index?user_id=eq.${userId}` +
    `&attachment_library_id=eq.${_encodeFilterValue(paperJob.attachment_library_id)}` +
    `&attachment_key=eq.${_encodeFilterValue(paperJob.attachment_key)}` +
    '&select=last_revision,table_revisions' +
    '&limit=1';
    const rows = await Zotero.VibeDBCloudSync._collectPagedRemoteRows(endpoint, {
      traceId,
      pageSize: 1
    });
    return rows && rows.length ? rows[0] : null;
  }

  async function _normalizeLocalPaperJob(row) {
    if (!row) {
      return null;
    }
    let attachmentLibraryID = row.attachment_library_id || null;
    let attachmentKey = row.attachment_key || null;
    if (!attachmentLibraryID || !attachmentKey) {
      const resolved = await _resolveUploadAttachmentIdentity(row);
      if (resolved) {
        attachmentLibraryID = resolved.attachment_library_id;
        attachmentKey = resolved.attachment_key;
      }
    }
    if (!attachmentLibraryID || !attachmentKey) {
      return null;
    }
    return {
      paper_id: row.paper_id || null,
      item_id: row.item_id || null,
      attachment_library_id: attachmentLibraryID,
      attachment_key: attachmentKey,
      changed_tables: []
    };
  }

  async function _collectLocalPaperJobs(isFirstSync, traceId) {
    const conn = Zotero.VibeDB.getConnection();
    const rows = await conn.queryAsync(
      isFirstSync ?
      `SELECT p.paper_id, p.item_id, p.attachment_library_id, p.attachment_key, ? AS changed_tables
				   FROM papers p` :
      `SELECT p.paper_id, p.item_id, p.attachment_library_id, p.attachment_key, idx.changed_tables
				   FROM local_paper_sync_index idx
				   JOIN papers p ON idx.paper_id = p.paper_id`,
      isFirstSync ? [JSON.stringify(ALL_SYNC_TABLES)] : []
    );
    const jobMap = new Map();
    for (const row of rows || []) {
      const job = await _normalizeLocalPaperJob(row);
      if (!job) {
        _warnOnce(traceId, `local-paper-job-missing-identity-${row.item_id || row.paper_id}`,
        `[VibeDBCloudSync][${traceId}] 跳过缺少稳定附件键的论文任务`,
        { paper_id: row.paper_id, item_id: row.item_id });
        continue;
      }
      job.changed_tables = _normalizeChangedTables(row.changed_tables);
      const key = _paperJobKey(job);
      jobMap.set(key, _mergePaperJob(jobMap.get(key), job));
    }
    return Array.from(jobMap.values()).sort((a, b) => (a.item_id || 0) - (b.item_id || 0));
  }

  async function _collectRemotePaperJobs(userId, isFirstSync, traceId) {
    const lastRemoteRevision = _ensureLastRemoteRevisionLoaded();
    let maxSeenRemoteRevision = lastRemoteRevision;
    const jobMap = new Map();
    let endpoint = 'paper_sync_index?select=item_id,attachment_library_id,attachment_key,last_revision,table_revisions';
    endpoint += `&user_id=eq.${userId}`;
    endpoint += '&order=last_revision.asc';
    if (!isFirstSync && lastRemoteRevision > 0) {
      endpoint += `&last_revision=gt.${lastRemoteRevision}`;
    }
    await Zotero.VibeDBCloudSync._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_SCAN_PAGE_SIZE }, async (rows) => {
      for (const row of rows || []) {
        const rowLastRevision = _toSyncRevision(row.last_revision);
        if (rowLastRevision > maxSeenRemoteRevision) {
          maxSeenRemoteRevision = rowLastRevision;
        }
        if (!row.attachment_library_id || !row.attachment_key) {
          _warnOnce(traceId, `remote-paper-job-missing-identity-index-${row.item_id || 'unknown'}`,
          `[VibeDBCloudSync][${traceId}] 远端论文索引缺少稳定附件键，跳过`,
          { item_id: row.item_id });
          continue;
        }
        let changedTables = isFirstSync ?
        ALL_SYNC_TABLES :
        _extractChangedTablesFromTableRevisions(row.table_revisions, lastRemoteRevision);
        if (!isFirstSync) {
          const localPaper = await Zotero.VibeDB.Papers.getByAttachmentIdentity(
            row.attachment_library_id,
            row.attachment_key
          );
          if (localPaper?.paper_id) {
            const localTableRevisions = await _getLocalPaperTableRevisions(localPaper.paper_id);
            changedTables = _extractUnsyncedTablesFromRevisionMaps(row.table_revisions, localTableRevisions);
          }
        }
        if (!changedTables.length && _toSyncRevision(row.last_revision) > lastRemoteRevision) {
          continue;
        }
        const job = {
          item_id: row.item_id || null,
          attachment_library_id: row.attachment_library_id,
          attachment_key: row.attachment_key,
          changed_tables: _normalizeChangedTables(changedTables)
        };
        const key = _paperJobKey(job);
        jobMap.set(key, _mergePaperJob(jobMap.get(key), job));
      }
    });
    return {
      jobs: Array.from(jobMap.values()).sort((a, b) => (a.item_id || 0) - (b.item_id || 0)),
      maxSeenRemoteRevision
    };
  }

  async function _runPhase(taskDefs, concurrency) {
    const wrappers = await _concurrentRun(taskDefs.map((taskDef) => taskDef.run), concurrency);
    const results = [];
    for (let i = 0; i < wrappers.length; i++) {
      if (!wrappers[i].ok) {
        const label = taskDefs[i].label || `task-${i + 1}`;
        throw new Error(`${label} failed: ${wrappers[i].error && wrappers[i].error.message ? wrappers[i].error.message : wrappers[i].error}`);
      }
      results.push(wrappers[i].value);
    }
    return results;
  }

  async function _runPaperUploadJob(job, userId, isFirstSync, traceId) {
    const paperTraceId = `${traceId}|u:${_paperJobKey(job)}`;
    const effectiveFirstSync = isFirstSync || !!job.force_sync;
    const syncPapers = _shouldSyncTable(job, 'papers', effectiveFirstSync);
    const syncArticleSummary = _shouldSyncTable(job, 'article_summary', effectiveFirstSync);
    const syncSections = _shouldSyncTable(job, 'sections', effectiveFirstSync);
    const syncParagraphs = _shouldSyncTable(job, 'paragraphs', effectiveFirstSync);
    const syncPoints = _shouldSyncTable(job, 'points', effectiveFirstSync);
    const syncSentences = _shouldSyncTable(job, 'sentences', effectiveFirstSync);
    const syncAiChats = _shouldSyncTable(job, 'ai_chats', effectiveFirstSync);
    const syncSummaryCards = _shouldSyncTable(job, 'summary_cards', effectiveFirstSync);
    const syncFlashCards = _shouldSyncTable(job, 'flash_cards', effectiveFirstSync);

    // ── 配额预检查（服务端判断，客户端零内存开销）──
    if (job.attachment_library_id && job.attachment_key) {
      try {
        const quotaCheck = await Zotero.VibeDBCloudSync._checkPaperQuota(
          job.attachment_library_id, job.attachment_key
        );
        if (quotaCheck && !quotaCheck.allowed) {
          // console.warn(`[VibeDBCloudSync][${paperTraceId}] 配额不足，跳过上传: ${quotaCheck.reason}`,
          // 	{ used: quotaCheck.used_bytes, total: quotaCheck.total_quota_bytes });
          return {
            uploaded: 0, skipped: 0, failed: 0, minFailedAt: Infinity,
            uploadedPapers: 0, failedPapers: 0,
            quotaBlocked: true, quotaReason: quotaCheck.reason
          };
        }
      } catch (e) {
        console.error(`[VibeDBCloudSync][${paperTraceId}] 配额检查失败，拒绝上传:`, e.message);
        return {
          uploaded: 0, skipped: 0, failed: 0, minFailedAt: Infinity,
          uploadedPapers: 0, failedPapers: 0,
          quotaBlocked: true, quotaReason: 'quota_check_failed'
        };
      }
    }

    const phases = [];
    if (syncPapers) {
      phases.push([
      { label: 'sync-papers', run: () => Zotero.VibeDBCloudSync._syncPapers(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) }]
      );
    }
    const contentPhase = [];
    if (syncParagraphs) contentPhase.push({ label: 'sync-paragraphs', run: () => Zotero.VibeDBCloudSync._syncParagraphs(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncArticleSummary) contentPhase.push({ label: 'sync-article-summary', run: () => Zotero.VibeDBCloudSync._syncArticleSummary(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncSections) contentPhase.push({ label: 'sync-sections', run: () => Zotero.VibeDBCloudSync._syncSections(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncAiChats) contentPhase.push({ label: 'sync-ai-chats', run: () => Zotero.VibeDBCloudSync._syncAiChats(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (contentPhase.length) phases.push(contentPhase);
    const textPhase = [];
    if (syncPoints) textPhase.push({ label: 'sync-points', run: () => Zotero.VibeDBCloudSync._syncPoints(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncSentences) textPhase.push({ label: 'sync-sentences', run: () => Zotero.VibeDBCloudSync._syncSentences(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (textPhase.length) phases.push(textPhase);
    const cardPhase = [];
    if (syncSummaryCards) cardPhase.push({ label: 'sync-summary-cards', run: () => Zotero.VibeDBCloudSync._syncSummaryCards(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncFlashCards) cardPhase.push({ label: 'sync-flash-cards', run: () => Zotero.VibeDBCloudSync._syncFlashCards(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (cardPhase.length) phases.push(cardPhase);
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    for (const phase of phases) {
      const results = await _runPhase(phase, PAPER_PHASE_CONCURRENCY);
      for (const r of results) {
        uploaded += r.uploaded || 0;
        skipped += r.skipped || 0;
        failed += r.failed || 0;
        if (r.minFailedAt < minFailedAt) minFailedAt = r.minFailedAt;
      }
    }
    if (failed === 0 && uploaded > 0 && job.paper_id) {
      try {
        const remoteSnapshot = await _fetchRemotePaperRevisionSnapshot(userId, job, paperTraceId);
        if (remoteSnapshot?.table_revisions) {
          const syncedTables = ALL_SYNC_TABLES.filter((table) => _shouldSyncTable(job, table, effectiveFirstSync));
          await _applyLocalPaperRevisionSnapshot(job.paper_id, remoteSnapshot.table_revisions, syncedTables);
        }
      }
      catch (e) {

        // console.warn(`[VibeDBCloudSync][${paperTraceId}] 上传后回填远端 revision 快照失败，将在后续下载中兜底:`, e.message || e);
      }}
    if (failed === 0 && job.paper_id && !effectiveFirstSync) {
      const syncedTables = ALL_SYNC_TABLES.filter((table) => _shouldSyncTable(job, table, effectiveFirstSync));
      await _clearLocalPaperSyncIndexTables(job.paper_id, syncedTables);
    }

    // ── 上传成功后提交用量记账（服务端自动算云端实际大小）──
    if (uploaded > 0 && failed === 0 && job.attachment_library_id && job.attachment_key) {
      try {
        await Zotero.VibeDBCloudSync._commitPaperUsage(
          job.attachment_library_id, job.attachment_key
        );
      } catch (e) {

        // console.warn(`[VibeDBCloudSync][${paperTraceId}] 用量记账失败（不影响同步结果）:`, e.message);
      }}

    return {
      uploaded,
      skipped,
      failed,
      minFailedAt,
      uploadedPapers: uploaded > 0 ? 1 : 0,
      failedPapers: failed > 0 ? 1 : 0
    };
  }

  async function _runPaperDownloadJob(job, userId, isFirstSync, traceId) {
    const paperTraceId = `${traceId}|d:${_paperJobKey(job)}`;
    const effectiveFirstSync = isFirstSync || !!job.force_sync;
    const syncPapers = _shouldSyncTable(job, 'papers', effectiveFirstSync);
    const syncArticleSummary = _shouldSyncTable(job, 'article_summary', effectiveFirstSync);
    const syncSections = _shouldSyncTable(job, 'sections', effectiveFirstSync);
    const syncParagraphs = _shouldSyncTable(job, 'paragraphs', effectiveFirstSync);
    const syncPoints = _shouldSyncTable(job, 'points', effectiveFirstSync);
    const syncSentences = _shouldSyncTable(job, 'sentences', effectiveFirstSync);
    const syncAiChats = _shouldSyncTable(job, 'ai_chats', effectiveFirstSync);
    const syncSummaryCards = _shouldSyncTable(job, 'summary_cards', effectiveFirstSync);
    const syncFlashCards = _shouldSyncTable(job, 'flash_cards', effectiveFirstSync);
    const phases = [];
    if (syncPapers) {
      phases.push([
      { label: 'pull-papers', run: () => Zotero.VibeDBCloudSync._pullRemotePapers(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) }]
      );
    }
    const contentPhase = [];
    if (syncParagraphs) contentPhase.push({ label: 'pull-paragraphs', run: () => Zotero.VibeDBCloudSync._pullRemoteParagraphs(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncArticleSummary) contentPhase.push({ label: 'pull-article-summary', run: () => Zotero.VibeDBCloudSync._pullRemoteArticleSummary(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncSections) contentPhase.push({ label: 'pull-sections', run: () => Zotero.VibeDBCloudSync._pullRemoteSections(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncAiChats) contentPhase.push({ label: 'pull-ai-chats', run: () => Zotero.VibeDBCloudSync._pullRemoteAiChats(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (contentPhase.length) phases.push(contentPhase);
    const textPhase = [];
    if (syncPoints) textPhase.push({ label: 'pull-points', run: () => Zotero.VibeDBCloudSync._pullRemotePoints(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncSentences) textPhase.push({ label: 'pull-sentences', run: () => Zotero.VibeDBCloudSync._pullRemoteSentences(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (textPhase.length) phases.push(textPhase);
    const cardPhase = [];
    if (syncSummaryCards) cardPhase.push({ label: 'pull-summary-cards', run: () => Zotero.VibeDBCloudSync._pullRemoteSummaryCards(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (syncFlashCards) cardPhase.push({ label: 'pull-flash-cards', run: () => Zotero.VibeDBCloudSync._pullRemoteFlashCards(userId, effectiveFirstSync, { traceId: paperTraceId, paperJob: job }) });
    if (cardPhase.length) phases.push(cardPhase);
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    for (const phase of phases) {
      const results = await _runPhase(phase, PAPER_PHASE_CONCURRENCY);
      for (const r of results) {
        downloaded += r.downloaded || 0;
        skipped += r.skipped || 0;
        failed += r.failed || 0;
        if (_toSyncRevision(r.maxRemoteRevision) > maxRemoteRevision) {
          maxRemoteRevision = _toSyncRevision(r.maxRemoteRevision);
        }
        if (r.minFailedAt < minFailedAt) minFailedAt = r.minFailedAt;
      }
    }
    return {
      downloaded,
      skipped,
      failed,
      minFailedAt,
      maxRemoteRevision,
      downloadedPapers: downloaded > 0 ? 1 : 0,
      failedPapers: failed > 0 ? 1 : 0
    };
  }

  async function _collectPaperIdentityMaps() {
    const conn = Zotero.VibeDB.getConnection();
    const rows = await conn.queryAsync(`
			SELECT paper_id, item_id, attachment_library_id, attachment_key
			FROM papers
		`);
    const byPaperID = new Map();
    const byIdentity = new Map();
    for (const row of rows || []) {
      const normalized = {
        paper_id: row.paper_id,
        item_id: row.item_id,
        attachment_library_id: row.attachment_library_id,
        attachment_key: row.attachment_key
      };
      byPaperID.set(row.paper_id, normalized);
      if (row.attachment_library_id && row.attachment_key) {
        byIdentity.set(`${row.attachment_library_id}:${row.attachment_key}`, normalized);
      }
    }
    return { byPaperID, byIdentity };
  }

  async function _detectPaperIdentityGaps(userId, traceId) {
    const localMaps = await _collectPaperIdentityMaps();
    const missingLocal = [];
    const pendingRemote = new Set(localMaps.byIdentity.keys());
    let remoteCount = 0;

    await Zotero.VibeDBCloudSync._forEachRemotePage(
      `${CLOUD_PAPERS_TABLE}?user_id=eq.${userId}&select=attachment_library_id,attachment_key`,
      { traceId, pageSize: CLOUD_SCAN_PAGE_SIZE, prefer: 'return=minimal' },
      async (rows) => {
        for (const row of rows || []) {
          if (!row.attachment_library_id || !row.attachment_key) {
            continue;
          }
          remoteCount++;
          const identityKey = `${row.attachment_library_id}:${row.attachment_key}`;
          pendingRemote.delete(identityKey);
          if (localMaps.byIdentity.has(identityKey)) {
            continue;
          }
          const [libraryID, key] = identityKey.split(':');
          try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libraryID, 10), key);
            if (item) {
              missingLocal.push(identityKey);
            }
          }
          catch (e) {
            Zotero.debug(`[VibeDBCloudSync] _detectPaperIdentityGaps local lookup failed for ${identityKey}: ${e}`);
          }
        }
      }
    );

    return {
      missingLocal,
      missingRemote: Array.from(pendingRemote),
      remoteCount,
      localCount: localMaps.byIdentity.size
    };
  }

  async function _buildLocalPaperJobsFromIdentityKeys(identityKeys) {
    if (!identityKeys || !identityKeys.length) {
      return [];
    }
    const localMaps = await _collectPaperIdentityMaps();
    const jobs = [];
    for (const identityKey of identityKeys) {
      const row = localMaps.byIdentity.get(identityKey);
      if (!row) {
        continue;
      }
      jobs.push({
        paper_id: row.paper_id || null,
        item_id: row.item_id || null,
        attachment_library_id: row.attachment_library_id,
        attachment_key: row.attachment_key,
        force_sync: true,
        changed_tables: ALL_SYNC_TABLES
      });
    }
    return jobs;
  }

  async function _buildRemotePaperJobsFromIdentityKeys(identityKeys, traceId) {
    if (!identityKeys || !identityKeys.length) {
      return [];
    }
    const jobs = [];
    for (const identityKey of identityKeys) {
      const [libraryID, key] = identityKey.split(':');
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libraryID, 10), key);
        if (!item) {
          continue;
        }
        jobs.push({
          item_id: item.id || null,
          attachment_library_id: parseInt(libraryID, 10),
          attachment_key: key,
          force_sync: true,
          changed_tables: ALL_SYNC_TABLES
        });
      }
      catch (e) {
        Zotero.debug(`[VibeDBCloudSync] _buildRemotePaperJobsFromIdentityKeys failed for ${identityKey}: ${e}`);
        _warnOnce(traceId, `remote-gap-paper-job-build-failed-${identityKey}`,
        `[VibeDBCloudSync][${traceId}] 生成缺口修复下载任务失败`,
        { identityKey, error: e.message || String(e) });
      }
    }
    return jobs;
  }

  async function _resolveLocalPaperByRemoteIdentity(remoteRecord) {
    if (_hasAttachmentIdentity(remoteRecord)) {
      const byIdentity = await Zotero.VibeDB.Papers.getByAttachmentIdentity(
        remoteRecord.attachment_library_id,
        remoteRecord.attachment_key
      );
      if (byIdentity) {
        return byIdentity;
      }
      return null;
    }
    if (remoteRecord.item_id) {
      return await Zotero.VibeDB.Papers.get(remoteRecord.item_id);
    }
    return null;
  }

  async function _upsertLocalParagraph(paperID, paragraph) {
    const conn = Zotero.VibeDB.getConnection();
    await conn.queryAsync(`
			INSERT INTO paragraphs (
				paper_id, page_idx, paragraph_idx, minerU_id, paragraph_type,
				paragraph_text, paragraph_summary, importance_level, bbox, rects, updated_at, sync_dirty, last_synced_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
			ON CONFLICT(paper_id, page_idx, paragraph_idx) DO UPDATE SET
				minerU_id = excluded.minerU_id,
				paragraph_type = excluded.paragraph_type,
				paragraph_text = excluded.paragraph_text,
				paragraph_summary = excluded.paragraph_summary,
				importance_level = excluded.importance_level,
				bbox = excluded.bbox,
				rects = excluded.rects,
				updated_at = excluded.updated_at,
				sync_dirty = 0,
				last_synced_revision = excluded.last_synced_revision
			WHERE paragraphs.sync_dirty = 0
		`, [
    paperID,
    paragraph.page_idx,
    paragraph.paragraph_idx,
    paragraph.minerU_id || null,
    paragraph.paragraph_type || null,
    paragraph.paragraph_text || null,
    paragraph.paragraph_summary || null,
    paragraph.importance_level || null,
    paragraph.bbox ? JSON.stringify(paragraph.bbox) : null,
    paragraph.rects ? JSON.stringify(paragraph.rects) : null,
    paragraph.updated_at,
    _toSyncRevision(paragraph.sync_revision)]
    );
    return Zotero.VibeDB.findParagraphByKey(paperID, paragraph.paragraph_key);
  }

  async function _upsertLocalPoint(paragraphID, point) {
    const conn = Zotero.VibeDB.getConnection();
    await conn.queryAsync(`
			INSERT INTO points (
				paragraph_id, client_uuid, point_idx, point_summary, point_translation,
				sentence_indices, char_mapping, rects, importance_level, updated_at, sync_dirty, last_synced_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
			ON CONFLICT(paragraph_id, point_idx) DO UPDATE SET
				client_uuid = excluded.client_uuid,
				point_summary = excluded.point_summary,
				point_translation = excluded.point_translation,
				sentence_indices = excluded.sentence_indices,
				char_mapping = excluded.char_mapping,
				rects = excluded.rects,
				importance_level = excluded.importance_level,
				updated_at = excluded.updated_at,
				sync_dirty = 0,
				last_synced_revision = excluded.last_synced_revision
			WHERE points.sync_dirty = 0
		`, [
    paragraphID,
    point.client_uuid || null,
    point.point_idx,
    point.point_summary || null,
    point.point_translation || null,
    point.sentence_indices ? JSON.stringify(point.sentence_indices) : null,
    point.char_mapping ? JSON.stringify(point.char_mapping) : null,
    point.rects ? JSON.stringify(point.rects) : null,
    point.importance_level || null,
    point.updated_at,
    _toSyncRevision(point.sync_revision)]
    );
  }

  async function _upsertLocalSentence(paragraphID, sentence) {
    const conn = Zotero.VibeDB.getConnection();
    await conn.queryAsync(`
			INSERT INTO sentences (
				paragraph_id, sentence_idx, sentence_text, char_mapping,
				start_char_offset, end_char_offset, rects, updated_at, sync_dirty, last_synced_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
			ON CONFLICT(paragraph_id, sentence_idx) DO UPDATE SET
				sentence_text = excluded.sentence_text,
				char_mapping = excluded.char_mapping,
				start_char_offset = excluded.start_char_offset,
				end_char_offset = excluded.end_char_offset,
				rects = excluded.rects,
				updated_at = excluded.updated_at,
				sync_dirty = 0,
				last_synced_revision = excluded.last_synced_revision
			WHERE sentences.sync_dirty = 0
		`, [
    paragraphID,
    sentence.sentence_idx,
    sentence.sentence_text || null,
    sentence.char_mapping ? JSON.stringify(sentence.char_mapping) : null,
    sentence.start_char_offset || null,
    sentence.end_char_offset || null,
    sentence.rects ? JSON.stringify(sentence.rects) : null,
    sentence.updated_at,
    _toSyncRevision(sentence.sync_revision)]
    );
  }

  async function _upsertLocalArticleSummary(paperID, summary) {
    const conn = Zotero.VibeDB.getConnection();
    let existing = null;
    if (summary.client_uuid) {
      existing = await conn.rowQueryAsync(
        'SELECT summary_id, updated_at, sync_dirty FROM article_summary WHERE client_uuid = ?',
        [summary.client_uuid]
      );
    }
    if (!existing) {
      existing = await conn.rowQueryAsync(
        'SELECT summary_id, updated_at, client_uuid, sync_dirty FROM article_summary WHERE paper_id = ? AND sort_order = ?',
        [paperID, summary.sort_order || 0]
      );
    }
    if (existing) {
      // 本地有未上传修改时跳过远端覆盖，保护本地数据
      if (existing.sync_dirty === 1) {
        return;
      }
      await conn.queryAsync(`
				UPDATE article_summary
				SET paper_id = ?, client_uuid = ?, title = ?, content = ?, sort_order = ?, updated_at = ?, sync_dirty = 0, last_synced_revision = ?
				WHERE summary_id = ?
			`, [
      paperID,
      summary.client_uuid || existing.client_uuid || null,
      summary.title || '',
      summary.content ? JSON.stringify(summary.content) : null,
      summary.sort_order || 0,
      summary.updated_at,
      _toSyncRevision(summary.sync_revision),
      existing.summary_id]
      );
      return;
    }

    await conn.queryAsync(`
			INSERT INTO article_summary (paper_id, client_uuid, title, content, sort_order, updated_at, sync_dirty, last_synced_revision)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?)
		`, [
    paperID,
    summary.client_uuid || null,
    summary.title || '',
    summary.content ? JSON.stringify(summary.content) : null,
    summary.sort_order || 0,
    summary.updated_at,
    _toSyncRevision(summary.sync_revision)]
    );
  }

  async function _upsertLocalSection(paperID, section) {
    const conn = Zotero.VibeDB.getConnection();
    const normalizedTitleBlockID = _normalizeSectionTitleBlockID(
      section.title_block_id,
      section.client_uuid || `${paperID}:${section.title || ''}:${section.level || 0}:${section.children_order || 0}`
    );
    let parentSectionID = null;
    if (section.parent_client_uuid) {
      const parentRow = await conn.rowQueryAsync(
        'SELECT section_id FROM sections WHERE client_uuid = ?',
        [section.parent_client_uuid]
      );
      parentSectionID = parentRow ? parentRow.section_id : null;
    }

    let existing = null;
    if (section.client_uuid) {
      existing = await conn.rowQueryAsync(
        'SELECT section_id, updated_at, client_uuid, sync_dirty FROM sections WHERE client_uuid = ?',
        [section.client_uuid]
      );
    }
    if (!existing) {
      existing = await conn.rowQueryAsync(
        'SELECT section_id, updated_at, client_uuid, sync_dirty FROM sections WHERE paper_id = ? AND title_block_id = ?',
        [paperID, normalizedTitleBlockID]
      );
    }

    if (existing) {
      // 本地有未上传修改时跳过远端覆盖，保护本地数据
      if (existing.sync_dirty === 1) {
        return existing.section_id;
      }
      await conn.queryAsync(`
				UPDATE sections
				SET paper_id = ?, client_uuid = ?, parent_section_id = ?, title_block_id = ?, level = ?,
					title = ?, summary = ?, points = ?, children_order = ?, updated_at = ?, sync_dirty = 0, last_synced_revision = ?
				WHERE section_id = ?
			`, [
      paperID,
      section.client_uuid || existing.client_uuid || null,
      parentSectionID,
      normalizedTitleBlockID,
      section.level || 0,
      section.title || '',
      section.summary || null,
      section.points ? JSON.stringify(section.points) : null,
      section.children_order || 0,
      section.updated_at,
      _toSyncRevision(section.sync_revision),
      existing.section_id]
      );
      return existing.section_id;
    }

    await conn.queryAsync(`
			INSERT INTO sections (
				paper_id, client_uuid, parent_section_id, title_block_id, level,
				title, summary, points, children_order, updated_at, sync_dirty, last_synced_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
		`, [
    paperID,
    section.client_uuid || null,
    parentSectionID,
    normalizedTitleBlockID,
    section.level || 0,
    section.title || '',
    section.summary || null,
    section.points ? JSON.stringify(section.points) : null,
    section.children_order || 0,
    section.updated_at,
    _toSyncRevision(section.sync_revision)]
    );
  }

  /**
   * 标记数据已变更（仅记录待同步状态，不再自动触发上传）
   */
  this.markDataChanged = function () {
    _hasPendingChanges = true;
  };

  /**
   * 启动自动同步
   *
   * 当前仅保留每 1 小时一次的后台同步，不再做数据变更后的防抖自动上传。
   */
  this.startAutoSync = function () {
    if (_syncTimer) {
      return;
    }

    _syncTimer = setInterval(async () => {
      try {
        await this.syncAll(false, {
          trigger: 'interval-hourly',
          direction: 'both'
        });
      }
      catch (e) {
        console.error('[VibeDBCloudSync] 每小时后台同步失败:', e);
      }
    }, SYNC_INTERVAL_MS);
  };

  /**
   * 停止自动同步
   */
  this.stopAutoSync = function () {
    if (_syncTimer) {
      clearInterval(_syncTimer);
      _syncTimer = null;
      // console.log('[VibeDBCloudSync] ✅ 自动同步已停止');
    }

    // 清除防抖定时器
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    // 重置状态
    _hasPendingChanges = false;
  };

  /**
   * 判断是否需要自动回退到一次全量同步
   * 规则：
   * 1. 显式 fullSync 时直接全量
   * 2. 本地没有 lastSyncTime 时视为首次全量（UI 级“从未完整成功同步”）
   * 3. 本地没有 papers 时，也必须按全量处理，避免下载端缺少基础身份映射
   * 4. 本地有 papers，但云端 papers 为空时，自动做一次引导性全量回灌
   */
  this._determineSyncMode = async function (userId, fullSync = false, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    if (fullSync) {
      return {
        isFirstSync: true,
        reason: 'explicit-full-sync',
        gapInfo: null
      };
    }

    if (!_lastSyncTime) {
      return {
        isFirstSync: true,
        reason: 'no-last-sync-time',
        gapInfo: null
      };
    }

    const conn = Zotero.VibeDB.getConnection();
    const localPaperCount = await conn.valueQueryAsync('SELECT COUNT(*) FROM papers');
    if (!localPaperCount) {
      return {
        isFirstSync: true,
        reason: 'no-local-papers',
        gapInfo: null
      };
    }

    const remotePapers = await this._supabaseRequest(
      `${CLOUD_PAPERS_TABLE}?user_id=eq.${userId}&select=paper_sync_id&limit=1`,
      'GET',
      null,
      { traceId, prefer: 'return=minimal' }
    );

    if (!remotePapers || remotePapers.length === 0) {
      console.warn(`[VibeDBCloudSync][${traceId}] 检测到云端 papers 为空，本地有 ${localPaperCount} 条 papers，自动回退为全量同步`);
      return {
        isFirstSync: true,
        reason: 'cloud-empty-bootstrap',
        gapInfo: null
      };
    }

    // Gap check 已移至用户手动点击"全量同步"按钮触发（fullSync=true），
    // 普通增量同步不再自动执行 24h gap check
    return {
      isFirstSync: false,
      reason: 'incremental',
      gapInfo: null
    };
  };

  /**
   * 执行全量/增量同步
   *
   * 优化点：
   * - 上传阶段：4 张表并行执行
   * - 下载阶段：papers 先行，其余 3 表并行
   * - 水位推进：按最早失败记录推进，不再 all-or-nothing
   *
   * @param {boolean} fullSync - 是否强制全量同步
   */
  this.syncAll = async function (fullSync = false, options = {}) {
    if (_isSyncing) {
      return { success: false, message: '同步正在进行中' };
    }

    _isSyncing = true;
    _updateSyncIndicators(true);
    const startTime = Date.now();
    const trigger = options.trigger || 'manual';
    const direction = options.direction || 'both';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const traceId = options.traceId || _buildSyncTraceId(trigger);
    _currentSyncTraceId = traceId;
    _warnedKeys = new Set();

    if (!_lastSyncTime) {
      const savedTime = Zotero.Prefs.get('sync.vibedb.lastSyncTime');
      if (savedTime) {
        _lastSyncTime = new Date(savedTime);
      }
    }
    _ensureLastRemoteRevisionLoaded();

    try {
      if (!Zotero.VibeDBSync || !Zotero.VibeDBSync.ensureLoggedIn || !Zotero.VibeDBSync.ensureLoggedIn()) {
        throw new Error('云同步需要先登录 Vibero 账号');
      }

      const accessToken = await this._getAccessToken();
      if (!accessToken) {
        throw new Error('云同步需要有效登录态，请重新登录后重试');
      }

      const userId = this._getUserId();
      if (!userId) {
        throw new Error('无法获取用户 ID');
      }

      const syncMode = await this._determineSyncMode(userId, fullSync, { traceId });
      const isFirstSync = syncMode.isFirstSync;
      const gapInfo = syncMode.gapInfo || null;
      await _ensureInitialPreSyncBackup(traceId);
      console.log(`[VibeDBCloudSync][${traceId}] syncAll 开始`, {
        trigger, direction, fullSync, isFirstSync,
        syncModeReason: syncMode.reason, userId,
        lastSyncTime: _lastSyncTime ? _lastSyncTime.toISOString() : null
      });

      let totalUploaded = 0;
      let totalDownloaded = 0;
      let totalSkipped = 0;
      let totalUploadFailed = 0;
      let totalDownloadFailed = 0;
      let totalUploadedPapers = 0;
      let totalDownloadedPapers = 0;
      let totalFailedPapers = 0;
      let totalQuotaBlockedPapers = 0;
      let globalMinFailedAt = Infinity;
      let totalPaperJobs = 0;
      let completedPaperJobs = 0;
      let totalUploadJobs = 0;
      let completedUploadJobs = 0;
      let totalDownloadJobs = 0;
      let completedDownloadJobs = 0;
      let maxDownloadedRemoteRevision = _lastRemoteRevision;
      let maxObservedRemoteRevision = _lastRemoteRevision;

      function _emitProgress(extra = {}) {
        if (!onProgress) {
          return;
        }
        try {
          onProgress({
            completed: completedPaperJobs,
            total: totalPaperJobs,
            uploadCompleted: completedUploadJobs,
            uploadTotal: totalUploadJobs,
            downloadCompleted: completedDownloadJobs,
            downloadTotal: totalDownloadJobs,
            uploadedPapers: totalUploadedPapers,
            downloadedPapers: totalDownloadedPapers,
            failedPapers: totalFailedPapers,
            quotaBlockedPapers: totalQuotaBlockedPapers,
            phase: extra.phase || null,
            job: extra.job || null
          });
        }
        catch (e) {
          Zotero.debug(`[VibeDBCloudSync] onProgress 回调失败: ${e}`);
        }
      }

      function _collectResult(r, isUpload) {
        if (isUpload) {
          totalUploaded += r.uploaded || 0;
          totalUploadFailed += r.failed || 0;
          totalUploadedPapers += r.uploadedPapers || 0;
          if (r.quotaBlocked) totalQuotaBlockedPapers++;
        } else {
          totalDownloaded += r.downloaded || 0;
          totalDownloadFailed += r.failed || 0;
          totalDownloadedPapers += r.downloadedPapers || 0;
          if (_toSyncRevision(r.maxRemoteRevision) > maxDownloadedRemoteRevision) {
            maxDownloadedRemoteRevision = _toSyncRevision(r.maxRemoteRevision);
          }
        }
        totalFailedPapers += r.failedPapers || 0;
        totalSkipped += r.skipped || 0;
        if (r.minFailedAt < globalMinFailedAt) {
          globalMinFailedAt = r.minFailedAt;
        }
      }

      const paperConcurrency = _getPaperConcurrency(isFirstSync);
      _emitProgress();

      let dedupedUploadJobs = [];
      let dedupedDownloadJobs = [];
      let uploadQuotaState = null;

      if (direction === 'both' || direction === 'upload') {
        const uploadJobs = await _collectLocalPaperJobs(isFirstSync, traceId);
        if (gapInfo && gapInfo.missingRemote.length) {
          const gapUploadJobs = await _buildLocalPaperJobsFromIdentityKeys(gapInfo.missingRemote);
          for (const job of gapUploadJobs) {
            uploadJobs.push(job);
          }
        }
        dedupedUploadJobs = _dedupePaperJobs(uploadJobs);
        try {
          const quota = await this.getCloudSyncQuota();
          const quotaExhausted = _isQuotaExhausted(quota);
          const quotaNearlyExhausted = _isQuotaNearlyExhausted(quota);
          uploadQuotaState = {
            checked: true,
            quota,
            hardBlocked: quotaExhausted,
            nearlyExhausted: quotaNearlyExhausted,
            reason: quotaExhausted ?
            quota.over_quota ? 'over_quota' : 'quota_exhausted' :
            quotaNearlyExhausted ? 'quota_nearly_exhausted' : 'within_quota'
          };
          // console.log(`[VibeDBCloudSync][${traceId}] upload quota status`, {
          // 	reason: uploadQuotaState.reason,
          // 	remaining_bytes: quota?.remaining_bytes,
          // 	used_bytes: quota?.used_bytes,
          // 	total_quota_bytes: quota?.total_quota_bytes,
          // 	over_quota: quota?.over_quota,
          // 	min_upload_headroom_bytes: MIN_UPLOAD_HEADROOM_BYTES
          // });
          if (uploadQuotaState.hardBlocked) {
            console.warn(`[VibeDBCloudSync][${traceId}] 当前账号云同步空间已耗尽，拒绝本轮全部上传`, {
              remaining_bytes: quota?.remaining_bytes,
              used_bytes: quota?.used_bytes,
              total_quota_bytes: quota?.total_quota_bytes,
              over_quota: quota?.over_quota
            });
          } else
          if (uploadQuotaState.nearlyExhausted) {
            console.warn(`[VibeDBCloudSync][${traceId}] 当前账号云同步空间已接近或达到上限，本轮改为逐篇配额检查，尽量上传可用论文`, {
              remaining_bytes: quota?.remaining_bytes,
              used_bytes: quota?.used_bytes,
              total_quota_bytes: quota?.total_quota_bytes,
              over_quota: quota?.over_quota,
              min_upload_headroom_bytes: MIN_UPLOAD_HEADROOM_BYTES
            });
          }
        }
        catch (e) {
          console.error(`[VibeDBCloudSync][${traceId}] 获取云同步配额失败，回退到单篇 RPC 检查`, e);
          uploadQuotaState = {
            checked: false,
            hardBlocked: false,
            nearlyExhausted: false,
            reason: 'quota_status_check_failed'
          };
        }
      }

      if (direction === 'both' || direction === 'download') {
        const remoteCollection = await _collectRemotePaperJobs(userId, isFirstSync, traceId);
        const downloadJobs = remoteCollection.jobs || [];
        if (_toSyncRevision(remoteCollection.maxSeenRemoteRevision) > maxObservedRemoteRevision) {
          maxObservedRemoteRevision = _toSyncRevision(remoteCollection.maxSeenRemoteRevision);
        }
        if (gapInfo && gapInfo.missingLocal.length) {
          const gapDownloadJobs = await _buildRemotePaperJobsFromIdentityKeys(gapInfo.missingLocal, traceId);
          for (const job of gapDownloadJobs) {
            downloadJobs.push(job);
          }
        }
        dedupedDownloadJobs = _dedupePaperJobs(downloadJobs);
      }

      totalPaperJobs = dedupedUploadJobs.length + dedupedDownloadJobs.length;
      totalUploadJobs = dedupedUploadJobs.length;
      totalDownloadJobs = dedupedDownloadJobs.length;
      _emitProgress();

      if (dedupedUploadJobs.length) {
        // console.log(`[VibeDBCloudSync][${traceId}] upload: 待同步论文 ${dedupedUploadJobs.length} 篇`);
        _emitProgress({ phase: 'upload' });
        if (uploadQuotaState?.hardBlocked) {
          for (const job of dedupedUploadJobs) {
            completedPaperJobs++;
            completedUploadJobs++;
            totalQuotaBlockedPapers++;
            _emitProgress({ phase: 'upload', job });
          }
        } else
        {
          const taskFns = dedupedUploadJobs.map((job) => async () => {
            const result = await _runPaperUploadJob(job, userId, isFirstSync, traceId);
            completedPaperJobs++;
            completedUploadJobs++;
            _emitProgress({ phase: 'upload', job });
            return result;
          });
          const results = await _concurrentRun(taskFns, paperConcurrency);
          for (const result of results) {
            if (result.ok) {
              _collectResult(result.value, true);
            } else
            {
              throw result.error;
            }
          }
        }
      }

      if (dedupedDownloadJobs.length) {
        // console.log(`[VibeDBCloudSync][${traceId}] download: 待同步论文 ${dedupedDownloadJobs.length} 篇`);
        _emitProgress({ phase: 'download' });
        const taskFns = dedupedDownloadJobs.map((job) => async () => {
          const result = await _runPaperDownloadJob(job, userId, isFirstSync, traceId);
          completedPaperJobs++;
          completedDownloadJobs++;
          _emitProgress({ phase: 'download', job });
          return result;
        });
        const results = await _concurrentRun(taskFns, paperConcurrency);
        for (const result of results) {
          if (result.ok) {
            _collectResult(result.value, false);
          } else
          {
            throw result.error;
          }
        }
      }

      // ── 水位推进 ──
      const totalFailed = totalUploadFailed + totalDownloadFailed;
      const hasQuotaBlockedUploads = totalQuotaBlockedPapers > 0;
      const canAdvanceRemoteRevision = totalDownloadFailed === 0;
      const canAdvanceDisplayedSyncTime = totalFailed === 0 && !hasQuotaBlockedUploads;
      const nextRemoteRevision = Math.max(maxDownloadedRemoteRevision, maxObservedRemoteRevision);
      if (canAdvanceRemoteRevision && nextRemoteRevision > _lastRemoteRevision) {
        // 下载侧增量水位只认服务端 revision，不再依赖本机时间。
        // 回退安全窗口，防止并发事务提交顺序差异导致漏下载（per-record revision 去重保证不会重复写入）
        _persistLastRemoteRevision(Math.max(0, nextRemoteRevision - REVISION_SAFETY_WINDOW));
      }
      if (canAdvanceDisplayedSyncTime) {
        // lastSyncTime 仅用于 UI 展示“上次完整成功同步”。
        _lastSyncTime = new Date();
        Zotero.Prefs.set('sync.vibedb.lastSyncTime', _lastSyncTime.toISOString());
      } else
      if (hasQuotaBlockedUploads) {
        console.warn(`[VibeDBCloudSync][${traceId}] ${totalQuotaBlockedPapers} 篇论文因云空间配额不足未能上行同步，不推进 lastSyncTime，等待后续恢复配额后重试`);
      } else
      if (globalMinFailedAt < Infinity) {
        console.warn(`[VibeDBCloudSync][${traceId}] ${totalFailed} 条记录同步失败，不推进远端 revision 水位`);
      } else
      {
        console.warn(`[VibeDBCloudSync][${traceId}] ${totalFailed} 条记录同步失败，不推进远端 revision 水位`);
      }

      const duration = (Date.now() - startTime) / 1000;
      console.log(`[VibeDBCloudSync][${traceId}] syncAll 完成`, {
        uploaded: totalUploaded, downloaded: totalDownloaded,
        uploadedPapers: totalUploadedPapers, downloadedPapers: totalDownloadedPapers,
        skipped: totalSkipped,
        uploadFailed: totalUploadFailed, downloadFailed: totalDownloadFailed,
        failedPapers: totalFailedPapers,
        quotaBlockedPapers: totalQuotaBlockedPapers,
        duration
      });

      if (totalQuotaBlockedPapers > 0) {
        console.warn(`[VibeDBCloudSync][${traceId}] ${totalQuotaBlockedPapers} 篇论文因云空间配额不足未能上行同步`);
      }
      _emitProgress({ phase: 'done' });

      return {
        success: true,
        uploaded: totalUploaded,
        downloaded: totalDownloaded,
        uploadedPapers: totalUploadedPapers,
        downloadedPapers: totalDownloadedPapers,
        failedPapers: totalFailedPapers,
        quotaBlockedPapers: totalQuotaBlockedPapers,
        skipped: totalSkipped,
        uploadFailed: totalUploadFailed,
        downloadFailed: totalDownloadFailed,
        duration
      };
    }
    catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] syncAll 失败:`, e);
      return { success: false, message: e.message };
    } finally
    {
      _isSyncing = false;
      _currentSyncTraceId = null;
      _updateSyncIndicators(false);
    }
  };

  /**
   * 同步 papers 表（论文级元数据，不再承载 parse_payload 主链路）
   */
  this._syncPapers = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0;
    let minFailedAt = Infinity;

    try {
      const conn = Zotero.VibeDB.getConnection();
      let sql,params = [];
      if (paperJob && paperJob.paper_id) {
        sql = isFirstSync ?
        'SELECT * FROM papers WHERE paper_id = ?' :
        'SELECT * FROM papers WHERE paper_id = ? AND sync_dirty = 1';
        params = [paperJob.paper_id];
      } else
      if (isFirstSync) {
        sql = 'SELECT * FROM papers';
      } else {
        sql = 'SELECT * FROM papers WHERE sync_dirty = 1';
      }

      const localPapers = await conn.queryAsync(sql, params);
      if (!localPapers.length) return { uploaded, skipped, failed, minFailedAt };

      // ① 批量 GET 云端状态（只取匹配键 + 时间戳，节省带宽）
      const filter = _buildRemotePaperFilter(paperJob);
      const cloudRecords = filter ?
      await this._collectPagedRemoteRows(`${CLOUD_PAPERS_TABLE}?user_id=eq.${userId}&${filter}&select=paper_sync_id,item_id,attachment_library_id,attachment_key`, { traceId, pageSize: CLOUD_SCAN_PAGE_SIZE }) :
      await this._batchGetCloud(CLOUD_PAPERS_TABLE, userId, 'paper_sync_id,item_id,attachment_library_id,attachment_key', traceId);
      const cloudByAttachment = new Map();
      const cloudByItemId = new Map();
      for (const r of cloudRecords) {
        const entry = { id: r.paper_sync_id };
        if (r.attachment_library_id && r.attachment_key) {
          cloudByAttachment.set(`${r.attachment_library_id}:${r.attachment_key}`, entry);
        }
        cloudByItemId.set(r.item_id, entry);
      }

      // ② 由本地 dirty 决定是否上行；云端仅用于区分 insert / update
      const toInsert = [];
      const toUpdate = []; // { cloudId, paper }
      for (const paper of localPapers) {
        let cloud = null;
        if (_hasAttachmentIdentity(paper)) {
          cloud = cloudByAttachment.get(`${paper.attachment_library_id}:${paper.attachment_key}`);
        }
        if (!cloud && paper.item_id) {
          cloud = cloudByItemId.get(paper.item_id);
        }
        if (cloud) {
          toUpdate.push({ cloudId: cloud.id, paper });
        } else {
          toInsert.push(paper);
        }
      }

      const buildPayload = (paper) => ({
        user_id: userId,
        item_id: paper.item_id,
        attachment_library_id: paper.attachment_library_id || null,
        attachment_key: paper.attachment_key || null,
        result_dir: paper.result_dir,
        markdown_content: _sanitizeMarkdownContentForCloudSync(paper.markdown_content),
        article_summary: paper.article_summary,
        outline: _safeJSONParse(paper.outline, null),
        block_mapping: _safeJSONParse(paper.block_mapping, null),
        github_url: paper.github_url,
        updated_at: new Date(paper.updated_at * 1000).toISOString()
      });

      // ③ 批量 POST 新记录（按 UPLOAD_BATCH_SIZE_LARGE 分片，papers payload 较大）
      if (toInsert.length) {
        const totalBatches = Math.ceil(toInsert.length / UPLOAD_BATCH_SIZE_LARGE);
        for (let i = 0; i < toInsert.length; i += UPLOAD_BATCH_SIZE_LARGE) {
          const chunk = toInsert.slice(i, i + UPLOAD_BATCH_SIZE_LARGE);
          const batchNo = Math.floor(i / UPLOAD_BATCH_SIZE_LARGE) + 1;
          const payloads = chunk.map(buildPayload);
          if (payloads.length) {
            try {
              await this._supabaseRequest(CLOUD_PAPERS_TABLE, 'POST', payloads, { traceId, prefer: 'return=minimal' });
              uploaded += payloads.length;
              await _markLocalRowsSyncClean('papers', 'paper_id', chunk.map((p) => p.paper_id));
            } catch (e) {
              console.error(`[VibeDBCloudSync][${traceId}] papers: 批量插入 ${batchNo}/${totalBatches} 失败（${payloads.length} 条）`, e);
              failed += payloads.length;
              for (const p of chunk) minFailedAt = Math.min(minFailedAt, p.updated_at);
            }
          }
        }
      }

      // ④ 并发 PATCH 更新记录
      if (toUpdate.length) {
        const patchTasks = toUpdate.map(({ cloudId, paper }) => async () => {
          const data = buildPayload(paper);
          await this._supabaseRequest(
            `${CLOUD_PAPERS_TABLE}?paper_sync_id=eq.${cloudId}`, 'PATCH', data, { traceId }
          );
        });
        const results = await _concurrentRun(patchTasks, PATCH_CONCURRENCY);
        for (let i = 0; i < results.length; i++) {
          if (results[i].ok) {
            uploaded++;
            await _markLocalRowsSyncClean('papers', 'paper_id', [toUpdate[i].paper.paper_id]);
          } else {
            console.error(`[VibeDBCloudSync][${traceId}] patch paper failed:`, results[i].error);
            failed++;
            minFailedAt = Math.min(minFailedAt, toUpdate[i].paper.updated_at);
          }
        }
      }

    } catch (e) {
      console.error('[VibeDBCloudSync] papers 同步异常:', e);
      failed++;
    }

    return { uploaded, skipped, failed, minFailedAt };
  };

  /**
   * 从云端拉取 papers 元数据
   */
  this._pullRemotePapers = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    let maxRemoteRevision = 0;

    try {
      let endpoint = `${CLOUD_PAPERS_TABLE}?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) {
        endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      }

      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (remotePapers) => {
        for (const remotePaper of remotePapers) {
          try {
            let localPaper = null;
            if (_hasAttachmentIdentity(remotePaper)) {
              localPaper = await Zotero.VibeDB.Papers.getByAttachmentIdentity(
                remotePaper.attachment_library_id,
                remotePaper.attachment_key
              );
            }
            if (!localPaper && !_hasAttachmentIdentity(remotePaper) && remotePaper.item_id) {
              localPaper = await Zotero.VibeDB.Papers.get(remotePaper.item_id);
            }
            const cloudUpdatedAt = Math.floor(new Date(remotePaper.updated_at).getTime() / 1000);
            const localRevision = localPaper ? _toSyncRevision(localPaper.last_synced_revision) : 0;
            const remoteRevision = _toSyncRevision(remotePaper.sync_revision);
            if (remoteRevision > maxRemoteRevision) {
              maxRemoteRevision = remoteRevision;
            }

            if (remoteRevision > localRevision) {
              // 本地有未上传修改时跳过远端覆盖
              if (localPaper && localPaper.sync_dirty === 1) {
                skipped++;
                continue;
              }
              let localItemID = await _resolveLocalItemIDFromAttachmentIdentity(remotePaper);
              if (!localItemID && !_hasAttachmentIdentity(remotePaper)) {
                localItemID = remotePaper.item_id;
              }
              if (!localItemID) {
                // console.warn(`[VibeDBCloudSync] 拉取 paper: 本地不存在对应附件，跳过`, remotePaper);
                skipped++;
                continue;
              }

              await Zotero.VibeDB.Papers.save(localItemID, {
                resultDir: remotePaper.result_dir,
                markdownContent: remotePaper.markdown_content,
                articleSummary: remotePaper.article_summary,
                outline: remotePaper.outline,
                blockMapping: remotePaper.block_mapping,
                githubUrl: remotePaper.github_url,
                attachmentLibraryID: remotePaper.attachment_library_id || null,
                attachmentKey: remotePaper.attachment_key || null,
                updatedAt: cloudUpdatedAt,
                syncRevision: remoteRevision
              }, { isRemoteTrigger: true });

              if (isFirstSync && remotePaper.parse_payload) {
                const savedPaper = await Zotero.VibeDB.Papers.get(localItemID);
                const conn = Zotero.VibeDB.getConnection();
                const paragraphCount = savedPaper ?
                await conn.valueQueryAsync('SELECT COUNT(*) FROM paragraphs WHERE paper_id = ?', [savedPaper.paper_id]) :
                0;
                if (savedPaper && !paragraphCount) {
                  await this._applyParsePayload(savedPaper.paper_id, localItemID, remotePaper.parse_payload);
                }
              }

              downloaded++;
            } else
            {
              skipped++;
            }
          } catch (e) {
            console.error(`[VibeDBCloudSync][${traceId}] 拉取 paper 失败 item_id=${remotePaper.item_id}:`, e);
            failed++;
            const cloudUpdatedAt = Math.floor(new Date(remotePaper.updated_at).getTime() / 1000);
            if (Number.isFinite(cloudUpdatedAt)) {
              minFailedAt = Math.min(minFailedAt, cloudUpdatedAt);
            }
          }
        }
      });
      // console.log(`[VibeDBCloudSync][${traceId}] papers: 云端待下载 ${totalRows} 条`);
      if (!totalRows) {
        return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
      }
    }
    catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] 拉取 papers 异常:`, e);
      failed++;
    }

    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  this._syncArticleSummary = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    try {
      const conn = Zotero.VibeDB.getConnection();
      const sql = paperJob && paperJob.paper_id ?
      isFirstSync ?
      'SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key FROM article_summary s JOIN papers p ON s.paper_id = p.paper_id WHERE s.paper_id = ?' :
      'SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key FROM article_summary s JOIN papers p ON s.paper_id = p.paper_id WHERE s.paper_id = ? AND s.sync_dirty = 1' :
      isFirstSync ?
      'SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key FROM article_summary s JOIN papers p ON s.paper_id = p.paper_id' :
      'SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key FROM article_summary s JOIN papers p ON s.paper_id = p.paper_id WHERE s.sync_dirty = 1';
      const rows = await conn.queryAsync(
        sql,
        paperJob && paperJob.paper_id ? [paperJob.paper_id] : []
      );
      if (!rows.length) return { uploaded, skipped, failed, minFailedAt };
      // All rows belong to the same paper — resolve identity once and reuse
      const _sharedIdentityAS = paperJob?.attachment_library_id && paperJob?.attachment_key ?
      { attachment_library_id: paperJob.attachment_library_id, attachment_key: paperJob.attachment_key } :
      null;
      const toUpsert = [];
      const uploadedSummaryIDs = [];
      for (const row of rows) {
        if (!row.client_uuid) {
          skipped++;
          continue;
        }
        const attachmentIdentity = _sharedIdentityAS ?? (await _resolveUploadAttachmentIdentity(row));
        if (!attachmentIdentity) {
          _warnOnce(traceId, `article_summary-missing-identity-${row.item_id}`,
          `[VibeDBCloudSync][${traceId}] article_summary: 跳过缺少稳定附件键的记录 item_id=${row.item_id}`);
          skipped++;
          continue;
        }
        toUpsert.push({
          user_id: userId,
          item_id: row.item_id,
          attachment_library_id: attachmentIdentity.attachment_library_id,
          attachment_key: attachmentIdentity.attachment_key,
          client_uuid: row.client_uuid,
          title: row.title || '',
          content: _safeJSONParse(row.content, null),
          sort_order: row.sort_order || 0,
          updated_at: new Date(row.updated_at * 1000).toISOString(),
          __local_updated_at: row.updated_at
        });
        uploadedSummaryIDs.push(row.summary_id);
      }
      if (toUpsert.length) {
        const result = await this._batchUpsert('article_summary', toUpsert, BATCH_SIZE_SMALL, 'user_id,client_uuid', traceId, (r) => r.__local_updated_at);
        uploaded += result.succeeded;
        failed += result.failed;
        minFailedAt = Math.min(minFailedAt, result.minFailedAt);
        if (result.succeededIndices.length) {
          await _markLocalRowsSyncClean('article_summary', 'summary_id', result.succeededIndices.map((i) => uploadedSummaryIDs[i]));
        }
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] article_summary 上行异常:`, e);
      failed++;
    }
    return { uploaded, skipped, failed, minFailedAt };
  };

  this._pullRemoteArticleSummary = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    try {
      let endpoint = `article_summary?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (rows) => {
        await conn.executeTransaction(async () => {
          for (const row of rows) {
            try {
              const localPaper = await _resolveLocalPaperByRemoteIdentity(row);
              if (!localPaper) {
                skipped++;
                continue;
              }
              let existing = null;
              if (row.client_uuid) {
                existing = await conn.rowQueryAsync(
                  'SELECT summary_id, last_synced_revision, sync_dirty FROM article_summary WHERE client_uuid = ?',
                  [row.client_uuid]
                );
              }
              if (!existing) {
                existing = await conn.rowQueryAsync(
                  'SELECT summary_id, last_synced_revision, sync_dirty FROM article_summary WHERE paper_id = ? AND sort_order = ?',
                  [localPaper.paper_id, row.sort_order || 0]
                );
              }
              const cloudUpdatedAt = _toUnixTimestamp(row.updated_at);
              const remoteRevision = _toSyncRevision(row.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = existing ? _toSyncRevision(existing.last_synced_revision) : 0;
              if (remoteRevision <= localRevision) {
                skipped++;
                continue;
              }
              // 本地有未上传修改时跳过远端覆盖
              if (existing && existing.sync_dirty === 1) {
                skipped++;
                continue;
              }
              await _upsertLocalArticleSummary(localPaper.paper_id, {
                client_uuid: row.client_uuid,
                title: row.title,
                content: row.content,
                sort_order: row.sort_order,
                updated_at: cloudUpdatedAt,
                sync_revision: remoteRevision
              });
              downloaded++;
            } catch (e) {
              failed++;
              minFailedAt = Math.min(minFailedAt, _toUnixTimestamp(row.updated_at));
              console.error(`[VibeDBCloudSync][${traceId}] article_summary 下行失败 uuid=${row.client_uuid}:`, e);
            }
          }
        });
      });
      if (!totalRows) return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] article_summary 下行异常:`, e);
      failed++;
    }
    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  this._syncParagraphs = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    try {
      const conn = Zotero.VibeDB.getConnection();
      const sql = paperJob && paperJob.paper_id ?
      isFirstSync ?
      'SELECT para.*, p.item_id, p.attachment_library_id, p.attachment_key FROM paragraphs para JOIN papers p ON para.paper_id = p.paper_id WHERE para.paper_id = ?' :
      'SELECT para.*, p.item_id, p.attachment_library_id, p.attachment_key FROM paragraphs para JOIN papers p ON para.paper_id = p.paper_id WHERE para.paper_id = ? AND para.sync_dirty = 1' :
      isFirstSync ?
      'SELECT para.*, p.item_id, p.attachment_library_id, p.attachment_key FROM paragraphs para JOIN papers p ON para.paper_id = p.paper_id' :
      'SELECT para.*, p.item_id, p.attachment_library_id, p.attachment_key FROM paragraphs para JOIN papers p ON para.paper_id = p.paper_id WHERE para.sync_dirty = 1';
      const rows = await conn.queryAsync(
        sql,
        paperJob && paperJob.paper_id ? [paperJob.paper_id] : []
      );
      if (!rows.length) return { uploaded, skipped, failed, minFailedAt };
      // All rows belong to the same paper — resolve identity once and reuse
      const _sharedIdentityPara = paperJob?.attachment_library_id && paperJob?.attachment_key ?
      { attachment_library_id: paperJob.attachment_library_id, attachment_key: paperJob.attachment_key } :
      null;
      const toUpsert = [];
      const uploadedParagraphIDs = [];
      for (const row of rows) {
        const paragraphKey = Zotero.VibeDB.buildParagraphKey(row);
        const attachmentIdentity = _sharedIdentityPara ?? (await _resolveUploadAttachmentIdentity(row));
        if (!attachmentIdentity || !paragraphKey) {
          if (paragraphKey) {
            _warnOnce(traceId, `paragraphs-missing-identity-${row.item_id}`,
            `[VibeDBCloudSync][${traceId}] paragraphs: 跳过缺少稳定附件键的记录 item_id=${row.item_id}`);
          } else {
            _warnOnce(traceId, `paragraphs-missing-identity-${row.item_id}`,
            `[VibeDBCloudSync][${traceId}] paragraphs: 跳过缺少 paragraph_key 的记录 item_id=${row.item_id}`);
          }
          skipped++;
          continue;
        }
        toUpsert.push({
          user_id: userId,
          item_id: row.item_id,
          attachment_library_id: attachmentIdentity.attachment_library_id,
          attachment_key: attachmentIdentity.attachment_key,
          paragraph_key: paragraphKey,
          page_idx: row.page_idx,
          paragraph_idx: row.paragraph_idx,
          minerU_id: row.minerU_id || null,
          paragraph_type: row.paragraph_type || null,
          paragraph_text: row.paragraph_text || null,
          paragraph_summary: row.paragraph_summary || null,
          importance_level: row.importance_level || null,
          bbox: _safeJSONParse(row.bbox, null),
          rects: _safeJSONParse(row.rects, null),
          updated_at: new Date(row.updated_at * 1000).toISOString(),
          __local_updated_at: row.updated_at
        });
        uploadedParagraphIDs.push(row.paragraph_id);
      }
      if (toUpsert.length) {
        const result = await this._batchUpsert('paragraphs', toUpsert, BATCH_SIZE_MEDIUM, 'user_id,attachment_library_id,attachment_key,paragraph_key', traceId, (r) => r.__local_updated_at);
        uploaded += result.succeeded;
        failed += result.failed;
        minFailedAt = Math.min(minFailedAt, result.minFailedAt);
        if (result.succeededIndices.length) {
          await _markLocalRowsSyncClean('paragraphs', 'paragraph_id', result.succeededIndices.map((i) => uploadedParagraphIDs[i]));
        }
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] paragraphs 上行异常:`, e);
      failed++;
    }
    return { uploaded, skipped, failed, minFailedAt };
  };

  this._pullRemoteParagraphs = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    try {
      let endpoint = `paragraphs?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (rows) => {
        await conn.executeTransaction(async () => {
          for (const row of rows) {
            try {
              const localPaper = await _resolveLocalPaperByRemoteIdentity(row);
              if (!localPaper) {
                skipped++;
                continue;
              }
              const paragraphId = await Zotero.VibeDB.findParagraphByKey(localPaper.paper_id, row.paragraph_key);
              const existing = paragraphId ? await conn.rowQueryAsync('SELECT last_synced_revision, sync_dirty FROM paragraphs WHERE paragraph_id = ?', [paragraphId]) : null;
              const cloudUpdatedAt = _toUnixTimestamp(row.updated_at);
              const remoteRevision = _toSyncRevision(row.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = existing ? _toSyncRevision(existing.last_synced_revision) : 0;
              if (remoteRevision <= localRevision) {
                skipped++;
                continue;
              }
              // 本地有未上传修改时跳过远端覆盖
              if (existing && existing.sync_dirty === 1) {
                skipped++;
                continue;
              }
              await _upsertLocalParagraph(localPaper.paper_id, {
                paragraph_key: row.paragraph_key,
                page_idx: row.page_idx,
                paragraph_idx: row.paragraph_idx,
                minerU_id: row.minerU_id,
                paragraph_type: row.paragraph_type,
                paragraph_text: row.paragraph_text,
                paragraph_summary: row.paragraph_summary,
                importance_level: row.importance_level,
                bbox: row.bbox,
                rects: row.rects,
                updated_at: cloudUpdatedAt,
                sync_revision: remoteRevision
              });
              downloaded++;
            } catch (e) {
              failed++;
              minFailedAt = Math.min(minFailedAt, _toUnixTimestamp(row.updated_at));
              console.error(`[VibeDBCloudSync][${traceId}] paragraphs 下行失败 key=${row.paragraph_key}:`, e);
            }
          }
        });
      });
      if (!totalRows) return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] paragraphs 下行异常:`, e);
      failed++;
    }
    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  this._syncSections = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    try {
      const conn = Zotero.VibeDB.getConnection();
      const sql = paperJob && paperJob.paper_id ?
      `SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key,
						  ps.client_uuid AS parent_client_uuid
				   FROM sections s
				   JOIN papers p ON s.paper_id = p.paper_id
				   LEFT JOIN sections ps ON s.parent_section_id = ps.section_id
				   WHERE s.paper_id = ?${isFirstSync ? '' : ' AND s.sync_dirty = 1'}` :
      isFirstSync ?
      `SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key,
						  ps.client_uuid AS parent_client_uuid
				   FROM sections s
				   JOIN papers p ON s.paper_id = p.paper_id
				   LEFT JOIN sections ps ON s.parent_section_id = ps.section_id` :
      `SELECT s.*, p.item_id, p.attachment_library_id, p.attachment_key,
						  ps.client_uuid AS parent_client_uuid
				   FROM sections s
				   JOIN papers p ON s.paper_id = p.paper_id
				   LEFT JOIN sections ps ON s.parent_section_id = ps.section_id
				   WHERE s.sync_dirty = 1`;
      const rows = await conn.queryAsync(sql, paperJob && paperJob.paper_id ? [paperJob.paper_id] : []);
      if (!rows.length) return { uploaded, skipped, failed, minFailedAt };
      // All rows belong to the same paper — resolve identity once and reuse
      const _sharedIdentitySec = paperJob?.attachment_library_id && paperJob?.attachment_key ?
      { attachment_library_id: paperJob.attachment_library_id, attachment_key: paperJob.attachment_key } :
      null;
      const toUpsert = [];
      const uploadedSectionIDs = [];
      for (const row of rows) {
        if (!row.client_uuid) {
          skipped++;
          continue;
        }
        const attachmentIdentity = _sharedIdentitySec ?? (await _resolveUploadAttachmentIdentity(row));
        if (!attachmentIdentity) {
          _warnOnce(traceId, `sections-missing-identity-${row.item_id}`,
          `[VibeDBCloudSync][${traceId}] sections: 跳过缺少稳定附件键的记录 item_id=${row.item_id}`);
          skipped++;
          continue;
        }
        toUpsert.push({
          user_id: userId,
          item_id: row.item_id,
          attachment_library_id: attachmentIdentity.attachment_library_id,
          attachment_key: attachmentIdentity.attachment_key,
          client_uuid: row.client_uuid,
          parent_client_uuid: row.parent_client_uuid || null,
          title_block_id: _normalizeSectionTitleBlockID(row.title_block_id, row.client_uuid || ''),
          level: row.level || 0,
          title: row.title || '',
          summary: row.summary || null,
          points: _safeJSONParse(row.points, null),
          children_order: row.children_order || 0,
          updated_at: new Date(row.updated_at * 1000).toISOString(),
          __local_updated_at: row.updated_at
        });
        uploadedSectionIDs.push(row.section_id);
      }
      if (toUpsert.length) {
        const result = await this._batchUpsert('sections', toUpsert, BATCH_SIZE_SMALL, 'user_id,client_uuid', traceId, (r) => r.__local_updated_at);
        uploaded += result.succeeded;
        failed += result.failed;
        minFailedAt = Math.min(minFailedAt, result.minFailedAt);
        if (result.succeededIndices.length) {
          await _markLocalRowsSyncClean('sections', 'section_id', result.succeededIndices.map((i) => uploadedSectionIDs[i]));
        }
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] sections 上行异常:`, e);
      failed++;
    }
    return { uploaded, skipped, failed, minFailedAt };
  };

  this._pullRemoteSections = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    try {
      let endpoint = `sections?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (rows) => {
        await conn.executeTransaction(async () => {
          for (const row of rows) {
            try {
              const localPaper = await _resolveLocalPaperByRemoteIdentity(row);
              if (!localPaper) {
                skipped++;
                continue;
              }
              let existing = null;
              const normalizedTitleBlockID = _normalizeSectionTitleBlockID(
                row.title_block_id,
                row.client_uuid || `${localPaper.paper_id}:${row.title || ''}:${row.level || 0}:${row.children_order || 0}`
              );
              if (row.client_uuid) {
                existing = await conn.rowQueryAsync(
                  'SELECT section_id, last_synced_revision, sync_dirty FROM sections WHERE client_uuid = ?',
                  [row.client_uuid]
                );
              }
              if (!existing) {
                existing = await conn.rowQueryAsync(
                  'SELECT section_id, last_synced_revision, sync_dirty FROM sections WHERE paper_id = ? AND title_block_id = ?',
                  [localPaper.paper_id, normalizedTitleBlockID]
                );
              }
              const cloudUpdatedAt = _toUnixTimestamp(row.updated_at);
              const remoteRevision = _toSyncRevision(row.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = existing ? _toSyncRevision(existing.last_synced_revision) : 0;
              if (remoteRevision <= localRevision) {
                skipped++;
                continue;
              }
              // 本地有未上传修改时跳过远端覆盖
              if (existing && existing.sync_dirty === 1) {
                skipped++;
                continue;
              }
              await _upsertLocalSection(localPaper.paper_id, {
                client_uuid: row.client_uuid,
                parent_client_uuid: row.parent_client_uuid,
                title_block_id: normalizedTitleBlockID,
                level: row.level,
                title: row.title,
                summary: row.summary,
                points: row.points,
                children_order: row.children_order,
                updated_at: cloudUpdatedAt,
                sync_revision: remoteRevision
              });
              downloaded++;
            } catch (e) {
              failed++;
              minFailedAt = Math.min(minFailedAt, _toUnixTimestamp(row.updated_at));
              console.error(`[VibeDBCloudSync][${traceId}] sections 下行失败 uuid=${row.client_uuid}:`, e);
            }
          }
        });
      });
      if (!totalRows) return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] sections 下行异常:`, e);
      failed++;
    }
    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  this._syncPoints = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    try {
      const conn = Zotero.VibeDB.getConnection();
      const sql = paperJob && paperJob.paper_id ?
      `SELECT pt.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM points pt
				   JOIN paragraphs para ON pt.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id
				   WHERE para.paper_id = ?${isFirstSync ? '' : ' AND pt.sync_dirty = 1'}` :
      isFirstSync ?
      `SELECT pt.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM points pt
				   JOIN paragraphs para ON pt.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id` :
      `SELECT pt.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM points pt
				   JOIN paragraphs para ON pt.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id
				   WHERE pt.sync_dirty = 1`;
      const rows = await conn.queryAsync(
        sql,
        paperJob && paperJob.paper_id ? [paperJob.paper_id] : []
      );
      if (!rows.length) return { uploaded, skipped, failed, minFailedAt };
      // All rows belong to the same paper — resolve identity once and reuse
      const _sharedIdentityPt = paperJob?.attachment_library_id && paperJob?.attachment_key ?
      { attachment_library_id: paperJob.attachment_library_id, attachment_key: paperJob.attachment_key } :
      null;
      const toUpsert = [];
      const uploadedPointIDs = [];
      for (const row of rows) {
        if (!row.client_uuid) {
          skipped++;
          continue;
        }
        const attachmentIdentity = _sharedIdentityPt ?? (await _resolveUploadAttachmentIdentity(row));
        if (!attachmentIdentity) {
          _warnOnce(traceId, `points-missing-identity-${row.item_id}`,
          `[VibeDBCloudSync][${traceId}] points: 跳过缺少稳定附件键的记录 item_id=${row.item_id}`);
          skipped++;
          continue;
        }
        const paragraphKey = Zotero.VibeDB.buildParagraphKey(row);
        toUpsert.push({
          user_id: userId,
          item_id: row.item_id,
          attachment_library_id: attachmentIdentity.attachment_library_id,
          attachment_key: attachmentIdentity.attachment_key,
          paragraph_key: paragraphKey,
          client_uuid: row.client_uuid,
          point_idx: row.point_idx,
          point_summary: row.point_summary || null,
          point_translation: row.point_translation || null,
          sentence_indices: _safeJSONParse(row.sentence_indices, null),
          char_mapping: _safeJSONParse(row.char_mapping, null),
          rects: _safeJSONParse(row.rects, null),
          importance_level: row.importance_level || null,
          updated_at: new Date(row.updated_at * 1000).toISOString(),
          __local_updated_at: row.updated_at
        });
        uploadedPointIDs.push(row.point_id);
      }
      if (toUpsert.length) {
        const result = await this._batchUpsert('points', toUpsert, BATCH_SIZE_MEDIUM, 'user_id,client_uuid', traceId, (r) => r.__local_updated_at);
        uploaded += result.succeeded;
        failed += result.failed;
        minFailedAt = Math.min(minFailedAt, result.minFailedAt);
        if (result.succeededIndices.length) {
          await _markLocalRowsSyncClean('points', 'point_id', result.succeededIndices.map((i) => uploadedPointIDs[i]));
        }
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] points 上行异常:`, e);
      failed++;
    }
    return { uploaded, skipped, failed, minFailedAt };
  };

  this._pullRemotePoints = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    try {
      let endpoint = `points?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (rows) => {
        await conn.executeTransaction(async () => {
          for (const row of rows) {
            try {
              const localPaper = await _resolveLocalPaperByRemoteIdentity(row);
              if (!localPaper) {
                skipped++;
                continue;
              }
              const paragraphId = await Zotero.VibeDB.findParagraphByKey(localPaper.paper_id, row.paragraph_key);
              if (!paragraphId) {
                skipped++;
                continue;
              }
              const remoteRevision = _toSyncRevision(row.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              let existing = null;
              if (row.client_uuid) {
                existing = await conn.rowQueryAsync(
                  'SELECT point_id, last_synced_revision, sync_dirty FROM points WHERE client_uuid = ?',
                  [row.client_uuid]
                );
              }
              if (!existing) {
                existing = await conn.rowQueryAsync(
                  'SELECT point_id, last_synced_revision, sync_dirty FROM points WHERE paragraph_id = ? AND point_idx = ?',
                  [paragraphId, row.point_idx]
                );
              }
              const cloudUpdatedAt = _toUnixTimestamp(row.updated_at);
              const localRevision = existing ? _toSyncRevision(existing.last_synced_revision) : 0;
              if (remoteRevision <= localRevision) {
                skipped++;
                continue;
              }
              // 本地有未上传修改时跳过远端覆盖
              if (existing && existing.sync_dirty === 1) {
                skipped++;
                continue;
              }
              await _upsertLocalPoint(paragraphId, {
                client_uuid: row.client_uuid,
                point_idx: row.point_idx,
                point_summary: row.point_summary,
                point_translation: row.point_translation,
                sentence_indices: row.sentence_indices,
                char_mapping: row.char_mapping,
                rects: row.rects,
                importance_level: row.importance_level,
                updated_at: cloudUpdatedAt,
                sync_revision: remoteRevision
              });
              downloaded++;
            } catch (e) {
              failed++;
              minFailedAt = Math.min(minFailedAt, _toUnixTimestamp(row.updated_at));
              console.error(`[VibeDBCloudSync][${traceId}] points 下行失败 uuid=${row.client_uuid}:`, e);
            }
          }
        });
      });
      if (!totalRows) return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] points 下行异常:`, e);
      failed++;
    }
    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  this._syncSentences = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity;
    try {
      const conn = Zotero.VibeDB.getConnection();
      const sql = paperJob && paperJob.paper_id ?
      `SELECT s.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM sentences s
				   JOIN paragraphs para ON s.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id
				   WHERE para.paper_id = ?${isFirstSync ? '' : ' AND s.sync_dirty = 1'}` :
      isFirstSync ?
      `SELECT s.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM sentences s
				   JOIN paragraphs para ON s.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id` :
      `SELECT s.*, para.page_idx, para.paragraph_idx, para.minerU_id,
						  p.item_id, p.attachment_library_id, p.attachment_key
				   FROM sentences s
				   JOIN paragraphs para ON s.paragraph_id = para.paragraph_id
				   JOIN papers p ON para.paper_id = p.paper_id
				   WHERE s.sync_dirty = 1`;
      const rows = await conn.queryAsync(sql, paperJob && paperJob.paper_id ? [paperJob.paper_id] : []);
      if (!rows.length) return { uploaded, skipped, failed, minFailedAt };
      // All rows belong to the same paper — resolve identity once and reuse
      const _sharedIdentitySent = paperJob?.attachment_library_id && paperJob?.attachment_key ?
      { attachment_library_id: paperJob.attachment_library_id, attachment_key: paperJob.attachment_key } :
      null;
      const toUpsert = [];
      const uploadedSentenceIDs = [];
      for (const row of rows) {
        const attachmentIdentity = _sharedIdentitySent ?? (await _resolveUploadAttachmentIdentity(row));
        const paragraphKey = Zotero.VibeDB.buildParagraphKey(row);
        if (!attachmentIdentity || !paragraphKey) {
          if (paragraphKey) {
            _warnOnce(traceId, `sentences-missing-identity-${row.item_id}`,
            `[VibeDBCloudSync][${traceId}] sentences: 跳过缺少稳定附件键的记录 item_id=${row.item_id}`);
          } else {
            _warnOnce(traceId, `sentences-missing-identity-${row.item_id}`,
            `[VibeDBCloudSync][${traceId}] sentences: 跳过缺少 paragraph_key 的记录 item_id=${row.item_id}`);
          }
          skipped++;
          continue;
        }
        toUpsert.push({
          user_id: userId,
          item_id: row.item_id,
          attachment_library_id: attachmentIdentity.attachment_library_id,
          attachment_key: attachmentIdentity.attachment_key,
          paragraph_key: paragraphKey,
          sentence_idx: row.sentence_idx,
          sentence_text: row.sentence_text || null,
          char_mapping: _safeJSONParse(row.char_mapping, null),
          start_char_offset: row.start_char_offset,
          end_char_offset: row.end_char_offset,
          rects: _safeJSONParse(row.rects, null),
          updated_at: new Date(row.updated_at * 1000).toISOString(),
          __local_updated_at: row.updated_at
        });
        uploadedSentenceIDs.push(row.sentence_id);
      }
      if (toUpsert.length) {
        const result = await this._batchUpsert('sentences', toUpsert, BATCH_SIZE_LARGE, 'user_id,attachment_library_id,attachment_key,paragraph_key,sentence_idx', traceId, (r) => r.__local_updated_at);
        uploaded += result.succeeded;
        failed += result.failed;
        minFailedAt = Math.min(minFailedAt, result.minFailedAt);
        if (result.succeededIndices.length) {
          await _markLocalRowsSyncClean('sentences', 'sentence_id', result.succeededIndices.map((i) => uploadedSentenceIDs[i]));
        }
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] sentences 上行异常:`, e);
      failed++;
    }
    return { uploaded, skipped, failed, minFailedAt };
  };

  this._pullRemoteSentences = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0,skipped = 0,failed = 0,minFailedAt = Infinity,maxRemoteRevision = 0;
    try {
      let endpoint = `sentences?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (rows) => {
        await conn.executeTransaction(async () => {
          for (const row of rows) {
            try {
              const localPaper = await _resolveLocalPaperByRemoteIdentity(row);
              if (!localPaper) {
                skipped++;
                continue;
              }
              const paragraphId = await Zotero.VibeDB.findParagraphByKey(localPaper.paper_id, row.paragraph_key);
              if (!paragraphId) {
                skipped++;
                continue;
              }
              const existing = await conn.rowQueryAsync('SELECT sentence_id, last_synced_revision, sync_dirty FROM sentences WHERE paragraph_id = ? AND sentence_idx = ?', [paragraphId, row.sentence_idx]);
              const cloudUpdatedAt = _toUnixTimestamp(row.updated_at);
              const remoteRevision = _toSyncRevision(row.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = existing ? _toSyncRevision(existing.last_synced_revision) : 0;
              if (remoteRevision <= localRevision) {
                skipped++;
                continue;
              }
              // 本地有未上传修改时跳过远端覆盖
              if (existing && existing.sync_dirty === 1) {
                skipped++;
                continue;
              }
              await _upsertLocalSentence(paragraphId, {
                sentence_idx: row.sentence_idx,
                sentence_text: row.sentence_text,
                char_mapping: row.char_mapping,
                start_char_offset: row.start_char_offset,
                end_char_offset: row.end_char_offset,
                rects: row.rects,
                updated_at: cloudUpdatedAt,
                sync_revision: remoteRevision
              });
              downloaded++;
            } catch (e) {
              failed++;
              minFailedAt = Math.min(minFailedAt, _toUnixTimestamp(row.updated_at));
              console.error(`[VibeDBCloudSync][${traceId}] sentences 下行失败 sentence_idx=${row.sentence_idx}:`, e);
            }
          }
        });
      });
      if (!totalRows) return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] sentences 下行异常:`, e);
      failed++;
    }
    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  /**
   * 同步 ai_chats 表（上行，批量优化版）
   */
  this._syncAiChats = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0,skipped = 0,failed = 0;
    let minFailedAt = Infinity;

    try {
      const conn = Zotero.VibeDB.getConnection();
      let sql,params = [];
      if (paperJob && paperJob.paper_id) {
        if (isFirstSync) {
          sql = 'SELECT ac.*, p.item_id, p.attachment_library_id, p.attachment_key FROM ai_chats ac JOIN papers p ON ac.paper_id = p.paper_id WHERE ac.paper_id = ?';
          params = [paperJob.paper_id];
        } else
        {
          sql = 'SELECT ac.*, p.item_id, p.attachment_library_id, p.attachment_key FROM ai_chats ac JOIN papers p ON ac.paper_id = p.paper_id WHERE ac.paper_id = ? AND ac.sync_dirty = 1';
          params = [paperJob.paper_id];
        }
      } else
      if (isFirstSync) {
        sql = 'SELECT ac.*, p.item_id, p.attachment_library_id, p.attachment_key FROM ai_chats ac JOIN papers p ON ac.paper_id = p.paper_id';
      } else {
        sql = 'SELECT ac.*, p.item_id, p.attachment_library_id, p.attachment_key FROM ai_chats ac JOIN papers p ON ac.paper_id = p.paper_id WHERE ac.sync_dirty = 1';
      }

      const localChats = await conn.queryAsync(sql, params);
      if (!localChats.length) return { uploaded, skipped, failed, minFailedAt };

      // ① 批量 GET 云端状态
      const filter = _buildRemotePaperFilter(paperJob);
      const cloudRecords = filter ?
      await this._collectPagedRemoteRows(`ai_chats?user_id=eq.${userId}&${filter}&select=aichat_id,item_id,attachment_library_id,attachment_key,updated_at`, { traceId, pageSize: CLOUD_SCAN_PAGE_SIZE }) :
      await this._batchGetCloud('ai_chats', userId, 'aichat_id,item_id,attachment_library_id,attachment_key,updated_at', traceId);
      const cloudByAttachment = new Map();
      const cloudByItemId = new Map();
      for (const r of cloudRecords) {
        const entry = {
          id: r.aichat_id,
          updated_at: Math.floor(new Date(r.updated_at).getTime() / 1000)
        };
        if (r.attachment_library_id && r.attachment_key) {
          cloudByAttachment.set(`${r.attachment_library_id}:${r.attachment_key}`, entry);
        }
        cloudByItemId.set(r.item_id, entry);
      }

      // ② LWW 过滤
      const toInsert = [];
      const toUpdate = [];
      for (const chat of localChats) {
        let cloud = null;
        if (_hasAttachmentIdentity(chat)) {
          cloud = cloudByAttachment.get(`${chat.attachment_library_id}:${chat.attachment_key}`);
        }
        if (!cloud && chat.item_id) {
          cloud = cloudByItemId.get(chat.item_id);
        }

        const chatData = {
          user_id: userId,
          item_id: chat.item_id,
          attachment_library_id: chat.attachment_library_id || null,
          attachment_key: chat.attachment_key || null,
          messages: chat.messages ? JSON.parse(chat.messages) : [],
          updated_at: new Date(chat.updated_at * 1000).toISOString()
        };

        if (cloud) {
          toUpdate.push({ cloudId: cloud.id, data: chatData, ts: chat.updated_at, localID: chat.aichat_id });
        } else {
          toInsert.push({ data: chatData, ts: chat.updated_at });
        }
      }

      // ③ 批量 POST
      if (toInsert.length) {
        const insertLocalIDs = localChats.
        filter((chat) => !cloudByAttachment.get(`${chat.attachment_library_id}:${chat.attachment_key}`) && !cloudByItemId.get(chat.item_id)).
        map((chat) => chat.aichat_id);
        const insertResult = await this._batchInsert(
          'ai_chats',
          toInsert.map((r) => ({ ...r.data, __local_updated_at: r.ts })),
          UPLOAD_BATCH_SIZE,
          traceId,
          (record) => record.__local_updated_at
        );
        uploaded += insertResult.succeeded;
        failed += insertResult.failed;
        if (insertResult.minFailedAt < minFailedAt) minFailedAt = insertResult.minFailedAt;
        if (insertResult.succeededIndices.length) {
          await _markLocalRowsSyncClean('ai_chats', 'aichat_id', insertResult.succeededIndices.map((i) => insertLocalIDs[i]));
        }
      }

      // ④ 并发 PATCH
      if (toUpdate.length) {
        const patchTasks = toUpdate.map(({ cloudId, data }) => () =>
        this._supabaseRequest(`ai_chats?aichat_id=eq.${cloudId}`, 'PATCH', data, { traceId })
        );
        const results = await _concurrentRun(patchTasks, PATCH_CONCURRENCY);
        for (let i = 0; i < results.length; i++) {
          if (results[i].ok) {
            uploaded++;
            await _markLocalRowsSyncClean('ai_chats', 'aichat_id', [toUpdate[i].localID]);
          } else {
            console.error(`[VibeDBCloudSync][${traceId}] patch ai_chat failed:`, results[i].error);
            failed++;
            minFailedAt = Math.min(minFailedAt, toUpdate[i].ts);
          }
        }
      }

    } catch (e) {
      console.error('[VibeDBCloudSync] ai_chats 上行同步异常:', e);
      failed++;
    }

    return { uploaded, skipped, failed, minFailedAt };
  };

  /**
   * 拉取 ai_chats 云端变更（下行）
   */
  this._pullRemoteAiChats = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    let maxRemoteRevision = 0;

    try {
      let endpoint = `ai_chats?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) {
        endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      }
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (remoteChats) => {
        await conn.executeTransaction(async () => {
          for (const remoteChat of remoteChats) {
            try {
              let localChat = null;
              if (_hasAttachmentIdentity(remoteChat)) {
                const localPaper = await Zotero.VibeDB.Papers.getByAttachmentIdentity(
                  remoteChat.attachment_library_id,
                  remoteChat.attachment_key
                );
                if (localPaper) {
                  const localRows = await conn.queryAsync(
                    'SELECT aichat_id, last_synced_revision, sync_dirty FROM ai_chats WHERE paper_id = ?',
                    [localPaper.paper_id]
                  );
                  localChat = localRows && localRows.length ? localRows[0] : null;
                }
              }
              if (!localChat && remoteChat.item_id) {
                const localRows = await conn.queryAsync(
                  `SELECT ac.aichat_id, ac.last_synced_revision, ac.sync_dirty FROM ai_chats ac
									 JOIN papers p ON ac.paper_id = p.paper_id
									 WHERE p.item_id = ?`,
                  [remoteChat.item_id]
                );
                localChat = localRows && localRows.length ? localRows[0] : null;
              }
              const cloudUpdatedAt = Math.floor(new Date(remoteChat.updated_at).getTime() / 1000);
              const remoteRevision = _toSyncRevision(remoteChat.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = localChat ? _toSyncRevision(localChat.last_synced_revision) : 0;

              if (remoteRevision > localRevision) {
                // 本地有未上传修改时跳过远端覆盖
                if (localChat && localChat.sync_dirty === 1) {
                  skipped++;
                  continue;
                }
                let localItemID = await _resolveLocalItemIDFromAttachmentIdentity(remoteChat);
                if (!localItemID && !_hasAttachmentIdentity(remoteChat)) {
                  localItemID = remoteChat.item_id;
                }
                if (!localItemID) {
                  skipped++;
                  continue;
                }
                const messages = Array.isArray(remoteChat.messages) ? remoteChat.messages : [];
                await Zotero.VibeDB.AIChats.save(localItemID, messages, {
                  isRemoteTrigger: true,
                  updatedAt: cloudUpdatedAt,
                  syncRevision: remoteRevision
                });
                downloaded++;
              } else {
                skipped++;
              }
            } catch (e) {
              console.error(`[VibeDBCloudSync][${traceId}] 拉取 ai_chat 失败 item_id=${remoteChat.item_id}:`, e);
              failed++;
              const cloudUpdatedAt = Math.floor(new Date(remoteChat.updated_at).getTime() / 1000);
              if (Number.isFinite(cloudUpdatedAt)) {
                minFailedAt = Math.min(minFailedAt, cloudUpdatedAt);
              }
            }
          }
        });
      });
      if (!totalRows) {
        return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] 拉取 ai_chats 异常:`, e);
      failed++;
    }

    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  /**
   * 同步 flash_cards 表（上行）
   * 匹配键：(user_id, client_uuid)
   */
  this._syncFlashCards = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;

    try {
      const conn = Zotero.VibeDB.getConnection();
      let sql,params = [];
      if (paperJob && paperJob.paper_id) {
        if (isFirstSync) {
          sql = 'SELECT fc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM flash_cards fc JOIN papers p ON fc.paper_id = p.paper_id WHERE fc.paper_id = ?';
          params = [paperJob.paper_id];
        } else
        {
          sql = 'SELECT fc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM flash_cards fc JOIN papers p ON fc.paper_id = p.paper_id WHERE fc.paper_id = ? AND fc.sync_dirty = 1';
          params = [paperJob.paper_id];
        }
      } else
      if (isFirstSync) {
        sql = 'SELECT fc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM flash_cards fc JOIN papers p ON fc.paper_id = p.paper_id';
      } else
      {
        sql = 'SELECT fc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM flash_cards fc JOIN papers p ON fc.paper_id = p.paper_id WHERE fc.sync_dirty = 1';
      }

      const localCards = await conn.queryAsync(sql, params);
      if (!localCards.length) {
        return { uploaded, skipped, failed, minFailedAt };
      }

      const toUpsert = [];
      const uploadedFlashCardIDs = [];
      for (const card of localCards) {
        try {
          if (!card.client_uuid) {
            skipped++;
            continue;
          }

          const paragraphKey = await Zotero.VibeDB.getParagraphKeyById(card.paragraph_id);
          toUpsert.push({
            user_id: userId,
            item_id: card.item_id,
            attachment_library_id: card.attachment_library_id || null,
            attachment_key: card.attachment_key || null,
            client_uuid: card.client_uuid,
            page_idx: card.page_idx,
            paragraph_key: paragraphKey,
            messages: card.messages ? JSON.parse(card.messages) : [],
            position_rects: card.position_rects ? JSON.parse(card.position_rects) : [],
            updated_at: new Date(card.updated_at * 1000).toISOString(),
            __local_updated_at: card.updated_at
          });
          uploadedFlashCardIDs.push(card.flashcard_id);
        } catch (e) {
          console.error(`[VibeDBCloudSync] 同步 flash_card 失败 uuid=${card.client_uuid}:`, e);
          failed++;
          minFailedAt = Math.min(minFailedAt, card.updated_at);
        }
      }

      if (toUpsert.length) {
        const upsertResult = await this._batchUpsert(
          'flash_cards',
          toUpsert,
          UPLOAD_BATCH_SIZE,
          'user_id,client_uuid',
          traceId,
          (record) => record.__local_updated_at
        );
        uploaded += upsertResult.succeeded;
        failed += upsertResult.failed;
        if (upsertResult.minFailedAt < minFailedAt) {
          minFailedAt = upsertResult.minFailedAt;
        }
        if (upsertResult.succeededIndices.length) {
          await _markLocalRowsSyncClean('flash_cards', 'flashcard_id', upsertResult.succeededIndices.map((i) => uploadedFlashCardIDs[i]));
        }
      }
    } catch (e) {
      console.error('[VibeDBCloudSync] flash_cards 上行同步异常:', e);
      failed++;
    }

    return { uploaded, skipped, failed, minFailedAt };
  };

  /**
   * 拉取 flash_cards 云端变更（下行）
   */
  this._pullRemoteFlashCards = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    let maxRemoteRevision = 0;

    try {
      let endpoint = `flash_cards?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) {
        endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      }
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (remoteCards) => {
        await conn.executeTransaction(async () => {
          for (const remoteCard of remoteCards) {
            try {
              const localRows = await conn.queryAsync(
                'SELECT flashcard_id, last_synced_revision, sync_dirty FROM flash_cards WHERE client_uuid = ?',
                [remoteCard.client_uuid]
              );
              const localCard = localRows && localRows.length ? localRows[0] : null;
              const cloudUpdatedAt = Math.floor(new Date(remoteCard.updated_at).getTime() / 1000);
              const remoteRevision = _toSyncRevision(remoteCard.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = localCard ? _toSyncRevision(localCard.last_synced_revision) : 0;

              if (remoteRevision > localRevision) {
                // 本地有未上传修改时跳过远端覆盖
                if (localCard && localCard.sync_dirty === 1) {
                  skipped++;
                  continue;
                }
                let localItemID = await _resolveLocalItemIDFromAttachmentIdentity(remoteCard);
                if (!localItemID && !_hasAttachmentIdentity(remoteCard)) {
                  localItemID = remoteCard.item_id;
                }
                const paper = localItemID ? await Zotero.VibeDB.Papers.get(localItemID) : null;
                if (!paper) {
                  _warnOnce(traceId, `flashcard-no-paper-${remoteCard.client_uuid || `${remoteCard.attachment_library_id}:${remoteCard.attachment_key}:${remoteCard.item_id}`}`,
                  `[VibeDBCloudSync] 拉取 flash_card: 本地无 paper，跳过`,
                  {
                    item_id: remoteCard.item_id,
                    attachment_library_id: remoteCard.attachment_library_id,
                    attachment_key: remoteCard.attachment_key
                  });
                  skipped++;
                  continue;
                }

                const paragraphId = await Zotero.VibeDB.findParagraphByKey(paper.paper_id, remoteCard.paragraph_key);

                await Zotero.VibeDB.FlashCards.save(localItemID, {
                  page_idx: remoteCard.page_idx,
                  paragraph_id: paragraphId,
                  messages: Array.isArray(remoteCard.messages) ? remoteCard.messages : [],
                  position_rects: Array.isArray(remoteCard.position_rects) ? remoteCard.position_rects : [],
                  client_uuid: remoteCard.client_uuid,
                  updatedAt: cloudUpdatedAt,
                  syncRevision: remoteRevision
                }, { isRemoteTrigger: true });
                downloaded++;
              } else {
                skipped++;
              }
            } catch (e) {
              console.error(`[VibeDBCloudSync][${traceId}] 拉取 flash_card 失败 uuid=${remoteCard.client_uuid}:`, e);
              failed++;
              const cloudUpdatedAt = Math.floor(new Date(remoteCard.updated_at).getTime() / 1000);
              if (Number.isFinite(cloudUpdatedAt)) {
                minFailedAt = Math.min(minFailedAt, cloudUpdatedAt);
              }
            }
          }
        });
      });
      if (!totalRows) {
        return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] 拉取 flash_cards 异常:`, e);
      failed++;
    }

    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  /**
   * 同步 summary_cards 表（上行）
   * 匹配键：(user_id, client_uuid)
   */
  this._syncSummaryCards = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;

    try {
      const conn = Zotero.VibeDB.getConnection();
      let sql,params = [];
      if (paperJob && paperJob.paper_id) {
        if (isFirstSync) {
          sql = 'SELECT sc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM summary_cards sc JOIN papers p ON sc.paper_id = p.paper_id WHERE sc.paper_id = ?';
          params = [paperJob.paper_id];
        } else
        {
          sql = 'SELECT sc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM summary_cards sc JOIN papers p ON sc.paper_id = p.paper_id WHERE sc.paper_id = ? AND sc.sync_dirty = 1';
          params = [paperJob.paper_id];
        }
      } else
      if (isFirstSync) {
        sql = 'SELECT sc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM summary_cards sc JOIN papers p ON sc.paper_id = p.paper_id';
      } else
      {
        sql = 'SELECT sc.*, p.item_id, p.attachment_library_id, p.attachment_key FROM summary_cards sc JOIN papers p ON sc.paper_id = p.paper_id WHERE sc.sync_dirty = 1';
      }

      const localCards = await conn.queryAsync(sql, params);
      if (!localCards.length) {
        return { uploaded, skipped, failed, minFailedAt };
      }

      const toUpsert = [];
      const uploadedSummaryCardIDs = [];
      for (const card of localCards) {
        try {
          if (!card.client_uuid) {
            skipped++;
            continue;
          }

          const paragraphKey = await Zotero.VibeDB.getParagraphKeyById(card.paragraph_id);
          toUpsert.push({
            user_id: userId,
            item_id: card.item_id,
            attachment_library_id: card.attachment_library_id || null,
            attachment_key: card.attachment_key || null,
            client_uuid: card.client_uuid,
            page_idx: card.page_idx,
            paragraph_key: paragraphKey,
            summarycard_name: card.summarycard_name,
            position_rects: card.position_rects ? JSON.parse(card.position_rects) : [],
            updated_at: new Date(card.updated_at * 1000).toISOString(),
            __local_updated_at: card.updated_at
          });
          uploadedSummaryCardIDs.push(card.summarycard_id);
        } catch (e) {
          console.error(`[VibeDBCloudSync] 同步 summary_card 失败 uuid=${card.client_uuid}:`, e);
          failed++;
          minFailedAt = Math.min(minFailedAt, card.updated_at);
        }
      }

      if (toUpsert.length) {
        const upsertResult = await this._batchUpsert(
          'summary_cards',
          toUpsert,
          UPLOAD_BATCH_SIZE,
          'user_id,client_uuid',
          traceId,
          (record) => record.__local_updated_at
        );
        uploaded += upsertResult.succeeded;
        failed += upsertResult.failed;
        if (upsertResult.minFailedAt < minFailedAt) {
          minFailedAt = upsertResult.minFailedAt;
        }
        if (upsertResult.succeededIndices.length) {
          await _markLocalRowsSyncClean('summary_cards', 'summarycard_id', upsertResult.succeededIndices.map((i) => uploadedSummaryCardIDs[i]));
        }
      }
    } catch (e) {
      console.error('[VibeDBCloudSync] summary_cards 上行同步异常:', e);
      failed++;
    }

    return { uploaded, skipped, failed, minFailedAt };
  };

  /**
   * 拉取 summary_cards 云端变更（下行）
   */
  this._pullRemoteSummaryCards = async function (userId, isFirstSync, options = {}) {
    const traceId = options.traceId || _currentSyncTraceId || 'no-trace';
    const paperJob = options.paperJob || null;
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let minFailedAt = Infinity;
    let maxRemoteRevision = 0;

    try {
      let endpoint = `summary_cards?user_id=eq.${userId}`;
      const filter = _buildRemotePaperFilter(paperJob);
      if (filter) endpoint += `&${filter}`;
      endpoint += `&order=sync_revision.asc`;
      if (!isFirstSync && _lastRemoteRevision > 0) {
        endpoint += `&sync_revision=gt.${_lastRemoteRevision}`;
      }
      const conn = Zotero.VibeDB.getConnection();
      const totalRows = await this._forEachRemotePage(endpoint, { traceId, pageSize: CLOUD_DOWNLOAD_PAGE_SIZE }, async (remoteCards) => {
        await conn.executeTransaction(async () => {
          for (const remoteCard of remoteCards) {
            try {
              const localRows = await conn.queryAsync(
                'SELECT summarycard_id, last_synced_revision, sync_dirty FROM summary_cards WHERE client_uuid = ?',
                [remoteCard.client_uuid]
              );
              const localCard = localRows && localRows.length ? localRows[0] : null;
              const cloudUpdatedAt = Math.floor(new Date(remoteCard.updated_at).getTime() / 1000);
              const remoteRevision = _toSyncRevision(remoteCard.sync_revision);
              if (remoteRevision > maxRemoteRevision) {
                maxRemoteRevision = remoteRevision;
              }
              const localRevision = localCard ? _toSyncRevision(localCard.last_synced_revision) : 0;

              if (remoteRevision > localRevision) {
                // 本地有未上传修改时跳过远端覆盖
                if (localCard && localCard.sync_dirty === 1) {
                  skipped++;
                  continue;
                }
                let localItemID = await _resolveLocalItemIDFromAttachmentIdentity(remoteCard);
                if (!localItemID && !_hasAttachmentIdentity(remoteCard)) {
                  localItemID = remoteCard.item_id;
                }
                const paper = localItemID ? await Zotero.VibeDB.Papers.get(localItemID) : null;
                if (!paper) {
                  _warnOnce(traceId, `summarycard-no-paper-${remoteCard.client_uuid || `${remoteCard.attachment_library_id}:${remoteCard.attachment_key}:${remoteCard.item_id}`}`,
                  `[VibeDBCloudSync] 拉取 summary_card: 本地无 paper，跳过`,
                  {
                    item_id: remoteCard.item_id,
                    attachment_library_id: remoteCard.attachment_library_id,
                    attachment_key: remoteCard.attachment_key
                  });
                  skipped++;
                  continue;
                }

                const paragraphId = await Zotero.VibeDB.findParagraphByKey(paper.paper_id, remoteCard.paragraph_key);
                if (!paragraphId) {
                  // console.warn(`[VibeDBCloudSync] 拉取 summary_card: 无法定位段落 key=${remoteCard.paragraph_key}，跳过`);
                  skipped++;
                  continue;
                }

                await Zotero.VibeDB.SummaryCards.save(localItemID, {
                  page_idx: remoteCard.page_idx,
                  paragraph_id: paragraphId,
                  summarycard_name: remoteCard.summarycard_name,
                  position_rects: Array.isArray(remoteCard.position_rects) ? remoteCard.position_rects : [],
                  client_uuid: remoteCard.client_uuid,
                  updatedAt: cloudUpdatedAt,
                  syncRevision: remoteRevision
                }, { isRemoteTrigger: true });
                downloaded++;
              } else {
                skipped++;
              }
            } catch (e) {
              console.error(`[VibeDBCloudSync][${traceId}] 拉取 summary_card 失败 uuid=${remoteCard.client_uuid}:`, e);
              failed++;
              const cloudUpdatedAt = Math.floor(new Date(remoteCard.updated_at).getTime() / 1000);
              if (Number.isFinite(cloudUpdatedAt)) {
                minFailedAt = Math.min(minFailedAt, cloudUpdatedAt);
              }
            }
          }
        });
      });
      if (!totalRows) {
        return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
      }
    } catch (e) {
      console.error(`[VibeDBCloudSync][${traceId}] 拉取 summary_cards 异常:`, e);
      failed++;
    }

    return { downloaded, skipped, failed, minFailedAt, maxRemoteRevision };
  };

  /**
   * 构建论文的解析层整包 payload（用于云同步上传）
   * 将 article_summary / sections / paragraphs / points / sentences 打包成一个 JSON
   * @param {Number} paperID - 本地 paper_id
   * @returns {Object|null} parse_payload JSON 或 null（无解析数据时）
   */
  this._buildParsePayload = async function (paperID) {
    try {
      // 1. article_summary
      const articleSummaries = await Zotero.VibeDB.ArticleSummary.getByPaperID(paperID);

      // 2. sections tree（递归）
      const sectionsTree = await Zotero.VibeDB.Sections.buildSectionTree(paperID);

      // 3. paragraphs 带嵌套 points + sentences
      const paragraphs = await Zotero.VibeDB.Paragraphs.getByItemID(null, paperID);

      // 无解析数据时返回 null
      if (!paragraphs.length && !articleSummaries.length && !sectionsTree.length) {
        return null;
      }

      const paragraphsWithChildren = [];
      for (const para of paragraphs) {
        const points = await Zotero.VibeDB.Points.getByParagraphID(para.paragraph_id);
        const sentences = await Zotero.VibeDB.Sentences.getByParagraphID(para.paragraph_id);

        // 解析 JSON 字符串字段（getByItemID 返回原始字符串）
        let bbox = para.bbox;
        let rects = para.rects;
        if (typeof bbox === 'string') {
          try {bbox = JSON.parse(bbox);} catch (e) {bbox = null;}
        }
        if (typeof rects === 'string') {
          try {rects = JSON.parse(rects);} catch (e) {rects = null;}
        }

        paragraphsWithChildren.push({
          page_idx: para.page_idx,
          paragraph_idx: para.paragraph_idx,
          minerU_id: para.minerU_id || null,
          paragraph_type: para.paragraph_type,
          paragraph_text: para.paragraph_text,
          paragraph_summary: para.paragraph_summary,
          importance_level: para.importance_level,
          bbox,
          rects,
          points: points.map((p) => ({
            point_idx: p.point_idx,
            point_summary: p.point_summary,
            point_translation: p.point_translation,
            sentence_indices: p.sentence_indices,
            char_mapping: p.char_mapping,
            rects: p.rects,
            importance_level: p.importance_level
          })),
          sentences: sentences.map((s) => ({
            sentence_idx: s.sentence_idx,
            sentence_text: s.sentence_text,
            char_mapping: s.char_mapping,
            start_char_offset: s.start_char_offset,
            end_char_offset: s.end_char_offset,
            rects: s.rects
          }))
        });
      }

      // 清理 sections tree（去除本地 ID）
      const cleanSection = (section) => {
        const cleaned = {
          title_block_id: section.title_block_id,
          level: section.level,
          title: section.title,
          summary: section.summary,
          points: section.points,
          children_order: section.children_order,
          children: (section.children || []).map(cleanSection)
        };
        return cleaned;
      };

      return {
        version: 1,
        article_summary: articleSummaries.map((s) => ({
          title: s.title,
          content: s.content,
          sort_order: s.sort_order
        })),
        sections: sectionsTree.map(cleanSection),
        paragraphs: paragraphsWithChildren
      };
    } catch (e) {
      console.error('[VibeDBCloudSync] _buildParsePayload 失败:', e);
      return null;
    }
  };

  /**
   * 将云端拉取的 parse_payload 恢复到本地解析层表
   * @param {Number} paperID - 本地 paper_id
   * @param {Number} itemID - Zotero item_id
   * @param {Object} payload - parse_payload JSON
   */
  this._applyParsePayload = async function (paperID, itemID, payload) {
    if (!payload || payload.version !== 1) {
      console.warn('[VibeDBCloudSync] _applyParsePayload: 无效 payload 或不支持的版本');
      return;
    }

    try {
      const conn = Zotero.VibeDB.getConnection();

      // 1. 清除已有解析数据（paragraphs 级联删除 points/sentences）
      await conn.queryAsync('DELETE FROM paragraphs WHERE paper_id = ?', [paperID]);
      await conn.queryAsync('DELETE FROM sections WHERE paper_id = ?', [paperID]);
      await conn.queryAsync('DELETE FROM article_summary WHERE paper_id = ?', [paperID]);

      // 2. 恢复 article_summary
      if (payload.article_summary && payload.article_summary.length) {
        await Zotero.VibeDB.ArticleSummary.saveBatch(paperID, payload.article_summary);
      }

      // 3. 恢复 sections tree（可能有多个根节点）
      if (payload.sections && payload.sections.length) {
        for (const sectionRoot of payload.sections) {
          await Zotero.VibeDB.Sections.saveSection(paperID, sectionRoot, null);
        }
      }

      // 4. 恢复 paragraphs（内嵌 points + sentences）
      if (payload.paragraphs && payload.paragraphs.length) {
        // 先批量保存 paragraphs
        await Zotero.VibeDB.Paragraphs.saveBatch(itemID, payload.paragraphs, paperID);

        // 然后为每个 paragraph 恢复 points + sentences
        for (const para of payload.paragraphs) {
          // 通过 paragraph_key 查找新插入的 paragraph_id
          const paragraphId = await Zotero.VibeDB.findParagraphByKey(
            paperID,
            Zotero.VibeDB.buildParagraphKey(para)
          );
          if (!paragraphId) {
            console.warn(`[VibeDBCloudSync] _applyParsePayload: 无法定位段落 page=${para.page_idx} idx=${para.paragraph_idx}`);
            continue;
          }

          if (para.points && para.points.length) {
            await Zotero.VibeDB.Points.saveBatch(paragraphId, para.points);
          }
          if (para.sentences && para.sentences.length) {
            await Zotero.VibeDB.Sentences.saveBatch(paragraphId, para.sentences);
          }
        }
      }

      // console.log(`[VibeDBCloudSync] _applyParsePayload 完成: paperID=${paperID}`, {
      // 	articleSummary: payload.article_summary ? payload.article_summary.length : 0,
      // 	sections: payload.sections ? payload.sections.length : 0,
      // 	paragraphs: payload.paragraphs ? payload.paragraphs.length : 0
      // });
    } catch (e) {
      console.error('[VibeDBCloudSync] _applyParsePayload 失败:', e);
      throw e;
    }
  };

  /**
   * 获取同步状态
   */
  this.getSyncStatus = function () {
    return {
      isSyncing: _isSyncing,
      lastSyncTime: _lastSyncTime,
      lastRemoteRevision: _ensureLastRemoteRevisionLoaded(),
      isAutoSyncEnabled: _syncTimer !== null
    };
  };

  /**
   * 获取上次同步时间
   */
  this.getLastSyncTime = function () {
    return _lastSyncTime;
  };

  /**
   * 检查是否正在同步
   */
  this.isSyncing = function () {
    return _isSyncing;
  };
}();