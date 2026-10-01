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
 * VibeDB - 独立的 SQLite 数据库，用于存储 VibeReading 系统的数据
 * 包括：PDF 解析结果、VibeCards、FlashCards、ArticleSummary、AI Chat 等
 * 
 * 架构说明：
 * 1. 与 Zotero 主数据库完全独立，避免冲突
 * 2. 通过 attachment_library_id + attachment_key 作为稳定锚点，与 Zotero items 表关联
 * 3. item_id 仅作为当前设备上的本地附件 ID 缓存，允许在读取时自动重绑
 * 3. 使用相同的 DBConnection 基础架构
 * 4. 支持版本迁移和 schema 更新
 */

Zotero.VibeDB = new function () {
  // 数据库版本（与 vibeDB.sql 文件版本对应）
  const SCHEMA_VERSION = 17;
  const SYNCED_TABLES = [
  'papers',
  'article_summary',
  'sections',
  'paragraphs',
  'points',
  'sentences',
  'summary_cards',
  'flash_cards',
  'ai_chats'];


  // Schema 类型
  const SCHEMA_TYPE = 'vibedata';

  var _connection = null;
  var _dbInitialized = false;
  var _schemaUpdatePromise = null;
  var _schemaUpdateDeferred = Zotero.Promise.defer();
  var _itemNotifierID = null;
  /** 已有 summary_cards 的 papers.item_id 集合，供条目树同步判断（避免列表渲染时 async 查库） */
  var _paperItemIDSet = new Set();

  async function _invalidateItemsPaneVibeMarks(changedItemIDs = []) {
    try {
      let win = Zotero.getMainWindow && Zotero.getMainWindow();
      let ids = Array.from(new Set(
        (changedItemIDs || []).
        map((id) => parseInt(id, 10)).
        filter((id) => Number.isInteger(id) && id > 0)
      ));
      if (ids.length && Zotero.Notifier && Zotero.Notifier.trigger) {
        await Zotero.Notifier.trigger('refresh', 'item', ids, {});
      } else
      if (win && win.ZoteroPane && win.ZoteroPane.itemsView && win.ZoteroPane.itemsView.tree) {
        win.ZoteroPane.itemsView.tree.invalidate();
      }
      if (win && win.ZoteroPane && win.ZoteroPane.itemPane?.mode == 'message' && win.ZoteroPane.itemPane.render) {
        win.ZoteroPane.itemPane.render();
      }
    }
    catch (e) {
      Zotero.debug('[VibeDB] _invalidateItemsPaneVibeMarks: ' + e);
    }
  }

  function _dedupeAttachmentIdentities(identities) {
    const seen = new Set();
    const results = [];
    for (const identity of identities || []) {
      if (!identity?.attachmentLibraryID || !identity?.attachmentKey) {
        continue;
      }
      const dedupeKey = `${identity.attachmentLibraryID}:${identity.attachmentKey}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      results.push({
        attachmentLibraryID: identity.attachmentLibraryID,
        attachmentKey: identity.attachmentKey
      });
    }
    return results;
  }

  async function _getAttachmentIdentitiesForItemID(itemID) {
    if (!itemID) {
      return [];
    }

    try {
      const item = await Zotero.Items.getAsync(itemID);
      if (!item) {
        return [];
      }

      // 云同步中的稳定锚点必须尽量落到真正的 PDF 附件上。
      // 旧库里的 papers.item_id 可能是父条目、注释甚至其它子项，这里统一收集所有可能命中的附件身份。
      let attachmentItems = [];
      const pushAttachmentItem = (candidate) => {
        if (!candidate) {
          return;
        }
        attachmentItems.push(candidate);
      };
      if (item.isPDFAttachment && item.isPDFAttachment()) {
        pushAttachmentItem(item);
      } else
      if (item.isAttachment && item.isAttachment()) {
        pushAttachmentItem(item);
      } else
      if (item.isAnnotation && item.isAnnotation() && item.parentItemID) {
        const parentItem = await Zotero.Items.getAsync(item.parentItemID);
        if (parentItem) {
          if (parentItem.isPDFAttachment && parentItem.isPDFAttachment()) {
            pushAttachmentItem(parentItem);
          } else
          if (parentItem.isAttachment && parentItem.isAttachment()) {
            pushAttachmentItem(parentItem);
          }
        }
      } else
      if (item.isRegularItem && item.isRegularItem()) {
        if (item.getBestAttachment) {
          try {
            const bestAttachment = await item.getBestAttachment();
            if (bestAttachment) {
              pushAttachmentItem(bestAttachment);
            }
          }
          catch (e) {
            Zotero.debug(`[VibeDB] getBestAttachment() failed for item ${itemID}: ${e}`);
          }
        }

        if (item.getAttachments) {
          for (const attachmentID of item.getAttachments()) {
            const child = await Zotero.Items.getAsync(attachmentID);
            if (!child) {
              continue;
            }
            if (child.isPDFAttachment && child.isPDFAttachment()) {
              pushAttachmentItem(child);
            } else
            if (child.isAttachment && child.isAttachment()) {
              pushAttachmentItem(child);
            }
          }
        }
      }

      if (!attachmentItems.length) {
        pushAttachmentItem(item);
      }

      return _dedupeAttachmentIdentities(attachmentItems.map((candidate) => ({
        attachmentLibraryID: candidate.libraryID ?? null,
        attachmentKey: candidate.key ?? null
      })));
    }
    catch (e) {
      Zotero.debug(`[VibeDB] _getAttachmentIdentitiesForItemID(${itemID}) failed: ${e}`);
      return [];
    }
  }

  async function _getAttachmentIdentityForItemID(itemID) {
    const identities = await _getAttachmentIdentitiesForItemID(itemID);
    return identities[0] || {
      attachmentLibraryID: null,
      attachmentKey: null
    };
  }

  function _normalizePaperRow(row) {
    if (!row) {
      return null;
    }

    function _safeGet(name) {
      try {
        return row[name];
      }
      catch (e) {
        return null;
      }
    }

    const result = {
      paper_id: _safeGet('paper_id'),
      item_id: _safeGet('item_id'),
      attachment_library_id: _safeGet('attachment_library_id'),
      attachment_key: _safeGet('attachment_key'),
      result_dir: _safeGet('result_dir'),
      markdown_content: _safeGet('markdown_content'),
      article_summary: _safeGet('article_summary'),
      outline: _safeGet('outline'),
      block_mapping: _safeGet('block_mapping'),
      github_url: _safeGet('github_url'),
      created_at: _safeGet('created_at'),
      updated_at: _safeGet('updated_at'),
      sync_dirty: _safeGet('sync_dirty'),
      last_synced_revision: _safeGet('last_synced_revision')
    };

    if (result.outline) {
      try {
        result.outline = JSON.parse(result.outline);
      }
      catch (e) {
        console.error(`[VibeDB] Failed to parse outline for item ${result.item_id}:`, e);
        Zotero.logError(`[VibeDB] Failed to parse outline for item ${result.item_id}:`, e);
        result.outline = null;
      }
    }

    if (result.block_mapping) {
      try {
        result.block_mapping = JSON.parse(result.block_mapping);
      }
      catch (e) {
        console.error(`[VibeDB] Failed to parse block_mapping for item ${result.item_id}:`, e);
        Zotero.logError(`[VibeDB] Failed to parse block_mapping for item ${result.item_id}:`, e);
        result.block_mapping = null;
      }
    }

    return result;
  }

  function _paperRowMatchesAttachmentIdentity(row, identity) {
    if (!row || !identity?.attachmentLibraryID || !identity?.attachmentKey) {
      return true;
    }
    if (!row.attachment_library_id || !row.attachment_key) {
      return true;
    }
    return String(row.attachment_library_id) === String(identity.attachmentLibraryID) &&
    String(row.attachment_key) === String(identity.attachmentKey);
  }

  function _normalizeSyncRevision(syncRevision) {
    const value = Number(syncRevision);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function _normalizeChangedTables(changedTables) {
    if (!changedTables) {
      return [];
    }
    let values = changedTables;
    if (typeof values === 'string') {
      try {
        values = JSON.parse(values);
      }
      catch (e) {
        values = [values];
      }
    }
    if (!Array.isArray(values)) {
      values = [values];
    }
    return Array.from(new Set(values.filter((table) => SYNCED_TABLES.includes(table)))).sort();
  }

  function _getLocalSyncState(isRemoteTrigger = false, syncRevision = null) {
    return {
      syncDirty: isRemoteTrigger ? 0 : 1,
      lastSyncedRevision: isRemoteTrigger ? _normalizeSyncRevision(syncRevision) : 0
    };
  }

  async function _touchPaperByPaperID(paperID) {
    if (!_connection || !paperID) {
      return;
    }
    await _connection.queryAsync(
      "UPDATE papers SET updated_at = strftime('%s', 'now') WHERE paper_id = ?",
      [paperID]
    );
  }

  async function _upsertLocalPaperSyncIndex(paperID, tableName) {
    if (!_connection || !paperID || !SYNCED_TABLES.includes(tableName)) {
      return;
    }
    const row = await _connection.rowQueryAsync(
      'SELECT changed_tables FROM local_paper_sync_index WHERE paper_id = ?',
      [paperID]
    );
    const changedTables = _normalizeChangedTables([
    ...(row ? _normalizeChangedTables(row.changed_tables) : []),
    tableName]
    );
    await _connection.queryAsync(
      `INSERT INTO local_paper_sync_index (paper_id, changed_tables, updated_at)
			 VALUES (?, ?, strftime('%s', 'now'))
			 ON CONFLICT(paper_id) DO UPDATE SET
				changed_tables = excluded.changed_tables,
				updated_at = excluded.updated_at`,
      [paperID, JSON.stringify(changedTables)]
    );

    // 事件驱动云同步：本地数据发生变化后，触发防抖同步
    // 注意：这里不判断登录态/自动同步开关，让上层自己决定是否真正执行同步
    try {
      Zotero.VibeDBCloudSync?.markDataChanged?.();
    } catch (e) {

      // 不影响本地写入
    }}

  async function _clearLocalPaperSyncIndexTables(paperID, tableNames) {
    if (!_connection || !paperID) {
      return;
    }
    const tablesToClear = _normalizeChangedTables(tableNames);
    if (!tablesToClear.length) {
      return;
    }
    const row = await _connection.rowQueryAsync(
      'SELECT changed_tables FROM local_paper_sync_index WHERE paper_id = ?',
      [paperID]
    );
    if (!row) {
      return;
    }
    const remainingTables = _normalizeChangedTables(row.changed_tables).
    filter((table) => !tablesToClear.includes(table));
    if (!remainingTables.length) {
      await _connection.queryAsync('DELETE FROM local_paper_sync_index WHERE paper_id = ?', [paperID]);
      return;
    }
    await _connection.queryAsync(
      `UPDATE local_paper_sync_index
			 SET changed_tables = ?, updated_at = strftime('%s', 'now')
			 WHERE paper_id = ?`,
      [JSON.stringify(remainingTables), paperID]
    );
  }

  async function _rebuildLocalPaperSyncIndex() {
    if (!_connection) {
      return;
    }
    await _connection.queryAsync('DELETE FROM local_paper_sync_index');
    const queryDefs = [
    { table: 'papers', sql: 'SELECT paper_id FROM papers WHERE sync_dirty = 1' },
    { table: 'article_summary', sql: 'SELECT DISTINCT paper_id FROM article_summary WHERE sync_dirty = 1' },
    { table: 'sections', sql: 'SELECT DISTINCT paper_id FROM sections WHERE sync_dirty = 1' },
    { table: 'paragraphs', sql: 'SELECT DISTINCT paper_id FROM paragraphs WHERE sync_dirty = 1' },
    { table: 'points', sql: 'SELECT DISTINCT para.paper_id FROM points pt JOIN paragraphs para ON pt.paragraph_id = para.paragraph_id WHERE pt.sync_dirty = 1' },
    { table: 'sentences', sql: 'SELECT DISTINCT para.paper_id FROM sentences s JOIN paragraphs para ON s.paragraph_id = para.paragraph_id WHERE s.sync_dirty = 1' },
    { table: 'summary_cards', sql: 'SELECT DISTINCT paper_id FROM summary_cards WHERE sync_dirty = 1' },
    { table: 'flash_cards', sql: 'SELECT DISTINCT paper_id FROM flash_cards WHERE sync_dirty = 1' },
    { table: 'ai_chats', sql: 'SELECT DISTINCT paper_id FROM ai_chats WHERE sync_dirty = 1' }];

    for (const queryDef of queryDefs) {
      const rows = await _connection.queryAsync(queryDef.sql);
      for (const row of rows || []) {
        if (row.paper_id) {
          await _upsertLocalPaperSyncIndex(row.paper_id, queryDef.table);
        }
      }
    }
  }

  async function _getPaperIDByParagraphID(paragraphID) {
    if (!_connection || !paragraphID) {
      return null;
    }
    const row = await _connection.rowQueryAsync(
      'SELECT paper_id FROM paragraphs WHERE paragraph_id = ?',
      [paragraphID]
    );
    return row ? row.paper_id : null;
  }

  async function _getPaperIDBySummaryID(summaryID) {
    if (!_connection || !summaryID) {
      return null;
    }
    const row = await _connection.rowQueryAsync(
      'SELECT paper_id FROM article_summary WHERE summary_id = ?',
      [summaryID]
    );
    return row ? row.paper_id : null;
  }

  async function _getPaperIDBySummaryCardID(summaryCardID) {
    if (!_connection || !summaryCardID) {
      return null;
    }
    const row = await _connection.rowQueryAsync(
      'SELECT paper_id FROM summary_cards WHERE summarycard_id = ?',
      [summaryCardID]
    );
    return row ? row.paper_id : null;
  }

  async function _getPaperIDByPointID(pointID) {
    if (!_connection || !pointID) {
      return null;
    }
    const row = await _connection.rowQueryAsync(
      `SELECT p.paper_id
			 FROM points pt
			 JOIN paragraphs p ON p.paragraph_id = pt.paragraph_id
			 WHERE pt.point_id = ?`,
      [pointID]
    );
    return row ? row.paper_id : null;
  }

  async function _deletePapersForZoteroItemID(itemID) {
    if (!_connection || !itemID) {
      return;
    }

    try {
      let item = null;
      try {
        item = await Zotero.Items.getAsync(itemID);
      }
      catch (e) {
        item = null;
      }

      const candidateItemIDs = new Set([itemID]);
      if (item) {
        if (item.isAnnotation && item.isAnnotation() && item.parentItemID) {
          candidateItemIDs.add(item.parentItemID);
        }
        if (item.isRegularItem && item.isRegularItem() && item.getAttachments) {
          for (const attachmentID of item.getAttachments(true)) {
            candidateItemIDs.add(attachmentID);
          }
        }
      }

      const paperIDs = new Set();
      for (const candidateID of candidateItemIDs) {
        const directRows = await _connection.queryAsync(
          'SELECT paper_id FROM papers WHERE item_id = ?',
          [candidateID]
        );
        for (const row of directRows || []) {
          paperIDs.add(row.paper_id);
        }

        const identity = await _getAttachmentIdentityForItemID(candidateID);
        if (identity.attachmentLibraryID && identity.attachmentKey) {
          const identityRows = await _connection.queryAsync(
            `SELECT paper_id
						 FROM papers
						 WHERE attachment_library_id = ? AND attachment_key = ?`,
            [identity.attachmentLibraryID, identity.attachmentKey]
          );
          for (const row of identityRows || []) {
            paperIDs.add(row.paper_id);
          }
        }
      }

      for (const paperID of paperIDs) {
        await _connection.queryAsync('DELETE FROM papers WHERE paper_id = ?', [paperID]);
      }

      if (paperIDs.size) {
        Zotero.debug(`[VibeDB] Cleaned ${paperIDs.size} paper(s) for deleted/trashed Zotero item ${itemID}`);
      }
    }
    catch (e) {
      Zotero.logError(`[VibeDB] Failed to cleanup papers for Zotero item ${itemID}: ${e}`);
    }
  }

  function _registerItemDeletionObserver() {
    if (_itemNotifierID) {
      return;
    }

    const observer = {
      notify: async function (event, type, ids) {
        if (type !== 'item' || !['trash', 'delete'].includes(event) || !_connection) {
          return;
        }

        for (const id of ids || []) {
          await _deletePapersForZoteroItemID(parseInt(id, 10));
        }

        try {
          await Zotero.VibeDB.Papers.refreshItemIDCache();
        }
        catch (e) {
          Zotero.debug('[VibeDB] refreshItemIDCache after item cleanup failed: ' + e);
        }
      }
    };

    _itemNotifierID = Zotero.Notifier.registerObserver(observer, ['item'], 'vibeDB-item-cleanup');
  }

  function _generateSyncUUID() {
    return Zotero.Utilities.generateObjectKey() + '-' + Date.now();
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

  function _normalizeLocalSectionTitleBlockID(titleBlockID, fallbackKey = '') {
    if (titleBlockID === null || titleBlockID === undefined || titleBlockID === '') {
      return _stableIntegerFromString(`null:${fallbackKey}`);
    }

    if (typeof titleBlockID === 'number' && Number.isFinite(titleBlockID)) {
      return Math.trunc(titleBlockID);
    }

    const numeric = parseInt(titleBlockID, 10);
    if (!Number.isNaN(numeric) && String(numeric) === String(titleBlockID).trim()) {
      return numeric;
    }

    return _stableIntegerFromString(`tb:${titleBlockID}:${fallbackKey}`);
  }

  async function _getSafePersistedItemID(paperID, desiredItemID) {
    if (!desiredItemID) {
      return null;
    }

    const conflict = await _connection.rowQueryAsync(
      'SELECT paper_id FROM papers WHERE item_id = ?',
      [desiredItemID]
    );
    if (!conflict || conflict.paper_id === paperID) {
      return desiredItemID;
    }

    console.warn(`[VibeDB] item_id=${desiredItemID} 已被 paper_id=${conflict.paper_id} 占用，保留原绑定，依赖稳定键匹配`);
    return null;
  }

  async function _backfillMissingCardClientUUIDs() {
    if (!_connection) {
      return { flashCards: 0, summaryCards: 0 };
    }

    // Skip entirely once we've confirmed all cards have UUIDs
    if (Zotero.Prefs.get('vibedb.cardUUIDBackfillDone')) {
      return { flashCards: 0, summaryCards: 0 };
    }

    let flashCardIDs = [];
    await _connection.queryAsync(
      'SELECT flashcard_id FROM flash_cards WHERE client_uuid IS NULL OR client_uuid = ?',
      [''],
      { onRow(row) {flashCardIDs.push(row.getResultByName('flashcard_id'));} }
    );
    if (flashCardIDs.length) {
      await _connection.executeTransaction(async () => {
        for (const id of flashCardIDs) {
          await _connection.queryAsync(
            'UPDATE flash_cards SET client_uuid = ? WHERE flashcard_id = ?',
            [Zotero.Utilities.generateObjectKey() + '-' + Date.now(), id]
          );
        }
      });
    }

    let summaryCardIDs = [];
    await _connection.queryAsync(
      'SELECT summarycard_id FROM summary_cards WHERE client_uuid IS NULL OR client_uuid = ?',
      [''],
      { onRow(row) {summaryCardIDs.push(row.getResultByName('summarycard_id'));} }
    );
    if (summaryCardIDs.length) {
      await _connection.executeTransaction(async () => {
        for (const id of summaryCardIDs) {
          await _connection.queryAsync(
            'UPDATE summary_cards SET client_uuid = ? WHERE summarycard_id = ?',
            [Zotero.Utilities.generateObjectKey() + '-' + Date.now(), id]
          );
        }
      });
    }

    // Mark done so subsequent startups skip the SELECT queries entirely
    if (!flashCardIDs.length && !summaryCardIDs.length) {
      Zotero.Prefs.set('vibedb.cardUUIDBackfillDone', true);
    }

    return { flashCards: flashCardIDs.length, summaryCards: summaryCardIDs.length };
  }

  /**
   * 初始化 VibeDB 数据库
   * 在 Zotero 启动时调用
   */
  this.init = async function () {
    if (_dbInitialized) {
      // console.log('[VibeDB] Database already initialized');
      Zotero.debug('[VibeDB] Database already initialized');
      return _connection;
    }

    try {
      // console.log('[VibeDB] 🚀 开始初始化 VibeDB 数据库');
      Zotero.debug('[VibeDB] Initializing database');

      // 创建数据库连接（使用 'vibeDB' 作为数据库名）
      // console.log('[VibeDB] 步骤 1: 创建数据库连接...');
      _connection = new Zotero.DBConnection('vibeDB');
      // console.log('[VibeDB] ✓ 数据库连接对象已创建');

      // 测试数据库连接
      // console.log('[VibeDB] 步骤 2: 测试数据库连接...');
      await _connection.test();
      // console.log('[VibeDB] ✓ 数据库连接测试成功');

      // 检查并更新 schema
      // console.log('[VibeDB] 步骤 3: 检查并更新 schema...');
      await this.updateSchema();
      // console.log('[VibeDB] ✓ Schema 检查/更新完成');

      try {
        const repaired = await _backfillMissingCardClientUUIDs();
        if (repaired.flashCards || repaired.summaryCards) {
          console.log(`[VibeDB] ✓ 启动修复完成：补齐 flash_cards.client_uuid=${repaired.flashCards}，summary_cards.client_uuid=${repaired.summaryCards}`);
        }
      }
      catch (e) {
        console.warn('[VibeDB] 启动修复 client_uuid 失败:', e);
      }

      _dbInitialized = true;
      _schemaUpdateDeferred.resolve(true);
      _registerItemDeletionObserver();

      // Do not build the paper/item cache here. It depends on
      // Zotero.Items.getByLibraryAndKey(), whose key index is populated later
      // in startup during Zotero.Items.init().

      console.log('[VibeDB] ✅ VibeDB 初始化完成！');
      Zotero.debug('[VibeDB] Database initialized successfully');
      return _connection;
    }
    catch (e) {
      console.error('[VibeDB] ❌ 初始化失败:', e);
      Zotero.logError(e);
      _schemaUpdateDeferred.reject(e);
      throw e;
    }
  };

  /**
   * 获取数据库连接
   */
  this.getConnection = function () {
    if (!_connection) {
      throw new Error('[VibeDB] Database not initialized');
    }
    return _connection;
  };

  /**
   * 检查并更新数据库 schema
   */
  this.updateSchema = async function () {
    try {
      // console.log('[VibeDB]   -> 开始 Schema 检查...');
      // 获取当前数据库版本
      const currentVersion = await this.getDBVersion();
      // console.log(`[VibeDB]   -> 当前数据库版本: ${currentVersion === null ? '数据库不存在' : currentVersion}`);
      // console.log(`[VibeDB]   -> 代码版本: ${SCHEMA_VERSION}`);

      // 如果数据库不存在（版本为 null），则创建
      if (!currentVersion) {
        // console.log('[VibeDB]   -> 数据库不存在，开始创建新数据库...');
        Zotero.debug('[VibeDB] Database does not exist -- creating');
        await this._initializeSchema();
        // console.log('[VibeDB]   -> ✓ 新数据库创建完成');
        return true;
      }

      // 如果版本号相同，无需更新
      if (currentVersion === SCHEMA_VERSION) {
        // console.log('[VibeDB]   -> ✓ 数据库版本已是最新，无需更新');
        Zotero.debug(`[VibeDB] Database is up to date (version ${SCHEMA_VERSION})`);
        return false;
      }

      // 如果数据库版本较新，抛出错误（可能是降级导致）
      if (currentVersion > SCHEMA_VERSION) {
        console.error(`[VibeDB]   -> ❌ 数据库版本 (${currentVersion}) 高于代码版本 (${SCHEMA_VERSION})`);
        throw new Error(
          `[VibeDB] Database version (${currentVersion}) is newer than code version (${SCHEMA_VERSION}). ` +
          `Please upgrade VibeZotero.`
        );
      }

      // 执行版本迁移
      // console.log(`[VibeDB]   -> 开始迁移: v${currentVersion} → v${SCHEMA_VERSION}`);
      Zotero.debug(`[VibeDB] Migrating database from version ${currentVersion} to ${SCHEMA_VERSION}`);
      await this._migrateSchema(currentVersion, SCHEMA_VERSION);
      // console.log('[VibeDB]   -> ✓ 版本迁移完成');

      return true;
    }
    catch (e) {
      console.error('[VibeDB] ❌ Schema 更新失败:', e);
      Zotero.logError('[VibeDB] Schema update failed:', e);
      throw e;
    }
  };

  /**
   * 获取当前数据库版本
   */
  this.getDBVersion = async function () {
    try {
      // 检查 version 表是否存在
      const tableExists = await _connection.tableExists('version');
      if (!tableExists) {
        return null;
      }

      // 查询版本号
      const sql = "SELECT version FROM version WHERE schema = ?";
      const version = await _connection.valueQueryAsync(sql, [SCHEMA_TYPE]);

      return version ? parseInt(version) : null;
    }
    catch (e) {
      Zotero.debug('[VibeDB] Error getting DB version:', e);
      return null;
    }
  };

  /**
   * 更新数据库版本号
   */
  this._updateDBVersion = async function (version) {
    const sql = "REPLACE INTO version (schema, version) VALUES (?, ?)";
    await _connection.queryAsync(sql, [SCHEMA_TYPE, parseInt(version)]);
    Zotero.debug(`[VibeDB] Updated version to ${version}`);
  };

  /**
   * 初始化数据库 schema（首次创建）
   */
  this._initializeSchema = async function () {
    await _connection.executeTransaction(async () => {
      try {
        // console.log('[VibeDB]     -> 开始创建数据库表...');
        Zotero.debug('[VibeDB] Creating database tables');

        // 设置 SQLite pragmas
        // console.log('[VibeDB]     -> 设置 SQLite pragmas...');
        await _connection.queryAsync("PRAGMA page_size = 4096");
        await _connection.queryAsync("PRAGMA encoding = 'UTF-8'");
        await _connection.queryAsync("PRAGMA auto_vacuum = 1");
        await _connection.queryAsync("PRAGMA foreign_keys = ON");
        // console.log('[VibeDB]     -> ✓ SQLite pragmas 设置完成');

        // 读取并执行 schema SQL 文件
        // console.log('[VibeDB]     -> 读取 schema SQL 文件...');
        const schemaSQL = await this._getSchemaSQL();
        // console.log('[VibeDB]     -> ✓ Schema SQL 文件读取成功');

        // console.log('[VibeDB]     -> 执行 SQL 语句创建表...');
        await _connection.executeSQLFile(schemaSQL);
        // console.log('[VibeDB]     -> ✓ 所有表创建完成');

        // 设置初始版本
        // console.log('[VibeDB]     -> 设置数据库版本...');
        await this._updateDBVersion(SCHEMA_VERSION);
        // console.log(`[VibeDB]     -> ✓ 数据库版本已设置为 ${SCHEMA_VERSION}`);

        // console.log('[VibeDB]     -> ✓ Schema 初始化成功');
        Zotero.debug('[VibeDB] Schema initialized successfully');
      }
      catch (e) {
        console.error('[VibeDB] ❌ Schema 初始化失败:', e);
        Zotero.logError('[VibeDB] Failed to initialize schema:', e);
        throw e;
      }
    });
  };

  /**
   * 读取 schema SQL 文件
   */
  this._getSchemaSQL = async function () {
    try {
      // 从 resource 目录读取 vibeDB.sql 文件
      const sqlPath = 'resource://zotero/schema/vibeDB.sql';
      const sql = await Zotero.File.getResourceAsync(sqlPath);
      return sql;
    }
    catch (e) {
      Zotero.logError('[VibeDB] Failed to read schema SQL file:', e);
      throw e;
    }
  };

  /**
   * 执行数据库迁移
   * @param {Number} fromVersion - 起始版本
   * @param {Number} toVersion - 目标版本
   */
  this._migrateSchema = async function (fromVersion, toVersion) {
    await _connection.executeTransaction(async () => {
      Zotero.debug(`[VibeDB] Migrating from version ${fromVersion} to ${toVersion}`);

      // 逐步执行迁移
      for (let version = fromVersion + 1; version <= toVersion; version++) {
        Zotero.debug(`[VibeDB] Applying migration step ${version}`);
        await this._applyMigrationStep(version);
      }

      // 更新版本号
      await this._updateDBVersion(toVersion);

      Zotero.debug('[VibeDB] Migration completed successfully');
    });
  };

  /**
   * 应用特定版本的迁移步骤
   * @param {Number} version - 目标版本
   */
  this._applyMigrationStep = async function (version) {
    // 根据版本号执行对应的迁移逻辑
    switch (version) {
      case 7:
        // 版本 7: 重建 sections 表，确保包含 UNIQUE 约束
        await this._migrateToVersion7();
        break;

      case 8:
        // 版本 8: 为 points 表添加 importance_level 字段
        await this._migrateToVersion8();
        break;

      case 9:
        // 版本 9: 重构 article_summary 表，删除 img_ids 和 table_ids，重命名 title_block_ids 为 block_ids
        await this._migrateToVersion9();
        break;

      case 10:
        // 版本 10: 版本9的迁移已完成删除 block_ids 字段的功能，此版本为兼容性版本
        console.log('[VibeDB] 版本 10: article_summary 表已重构完成，无需额外迁移');
        break;

      case 11:
        // 版本 11: 删除 images 和 tables 表（不再使用）
        await this._migrateToVersion11();
        break;

      case 12:
        // 版本 12: 为 papers 表添加 github_url 字段
        await this._migrateToVersion12();
        break;

      case 13:
        // 版本 13: 为 flash_cards 和 summary_cards 添加 client_uuid 字段（云同步跨设备匹配）
        await this._migrateToVersion13();
        break;

      case 14:
        // 版本 14: 为 papers 增加稳定附件键（attachment_library_id + attachment_key）
        await this._migrateToVersion14();
        break;

      case 15:
        // 版本 15: 为全细粒度同步补齐 updated_at / client_uuid
        await this._migrateToVersion15();
        break;

      case 16:
        // 版本 16: 引入本地 dirty/revision，同步真相不再依赖本机时间
        await this._migrateToVersion16();
        break;

      case 17:
        // 版本 17: 引入本地论文级脏索引，上传发现改为论文优先
        await this._migrateToVersion17();
        break;

      default:
        Zotero.debug(`[VibeDB] No migration needed for version ${version}`);
    }
  };

  this._migrateToVersion7 = async function () {
    console.log('[VibeDB] 开始迁移到版本 7');
    // 7. 删除并重建 sections 表（确保包含 UNIQUE 约束）
    await _connection.queryAsync(`DROP TABLE IF EXISTS sections`);
    console.log('[VibeDB] ✓ 已删除旧的 sections 表');

    await _connection.queryAsync(`
			CREATE TABLE IF NOT EXISTS sections (
				section_id INTEGER PRIMARY KEY,
				paper_id INTEGER NOT NULL,
				parent_section_id INTEGER,      -- 父章节ID，支持层级嵌套
				title_block_id INTEGER NOT NULL, -- 关联到 block_mapping 中的 title_blocks
				level INTEGER NOT NULL,         -- 层级：0为根级，1为子章节等
				title TEXT NOT NULL,           -- 章节标题
				summary TEXT,                   -- 章节摘要
				points TEXT,                    -- JSON 数组，存储该章节的要点
				children_order INTEGER,         -- 在父章节中的排序
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE,
				FOREIGN KEY (parent_section_id) REFERENCES sections(section_id) ON DELETE CASCADE,
				CONSTRAINT sections_paper_id_title_block_id_unique UNIQUE (paper_id, title_block_id)
			)
		`);
    console.log('[VibeDB] ✓ 已重新创建 sections 表');
  };

  /**
   * 迁移到版本 8：为 points 表添加 importance_level 字段
   */
  this._migrateToVersion8 = async function () {
    console.log('[VibeDB] 开始迁移到版本 8');
    // 8. 为 points 表添加 importance_level 字段
    try {
      await _connection.queryAsync(`
				ALTER TABLE points ADD COLUMN importance_level INTEGER DEFAULT 1
			`);
      console.log('[VibeDB] ✓ 已为 points 表添加 importance_level 字段');
    } catch (e) {
      // 如果字段已存在，忽略错误
      if (e.message && e.message.includes('duplicate column name')) {
        console.log('[VibeDB] importance_level 字段已存在，跳过添加');
      } else {
        throw e;
      }
    }
  };

  /**
   * 迁移到版本 9：重构 article_summary 表
   * - 删除 img_ids 和 table_ids 字段
   * - 将 title_block_ids 重命名为 block_ids
   */
  this._migrateToVersion9 = async function () {
    console.log('[VibeDB] 开始迁移到版本 9');

    // SQLite 不支持直接删除列或重命名列，需要重建表
    // 1. 创建新表
    await _connection.queryAsync(`
			CREATE TABLE IF NOT EXISTS article_summary_new (
				summary_id INTEGER PRIMARY KEY,
				paper_id INTEGER NOT NULL,
				title TEXT NOT NULL,
				content TEXT,
				sort_order INTEGER NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
			)
		`);
    console.log('[VibeDB] ✓ 已创建新的 article_summary_new 表');

    // 2. 复制数据（移除 block_ids 字段，points 的 block_ids 已包含在 content JSON 中）
    await _connection.queryAsync(`
			INSERT INTO article_summary_new (summary_id, paper_id, title, content, sort_order, created_at)
			SELECT summary_id, paper_id, title, content, sort_order, created_at
			FROM article_summary
		`);
    console.log('[VibeDB] ✓ 已复制数据到新表');

    // 3. 删除旧表
    await _connection.queryAsync(`DROP TABLE article_summary`);
    console.log('[VibeDB] ✓ 已删除旧的 article_summary 表');

    // 4. 重命名新表
    await _connection.queryAsync(`ALTER TABLE article_summary_new RENAME TO article_summary`);
    console.log('[VibeDB] ✓ 已将 article_summary_new 重命名为 article_summary');

    // 5. 重建索引
    await _connection.queryAsync(`
			CREATE INDEX IF NOT EXISTS idx_article_summary_paper ON article_summary(paper_id)
		`);
    await _connection.queryAsync(`
			CREATE INDEX IF NOT EXISTS idx_article_summary_sort ON article_summary(paper_id, sort_order)
		`);
    console.log('[VibeDB] ✓ 已重建索引');
  };

  /**
   * 迁移到版本 11：删除 images 和 tables 表（不再使用）
   */
  this._migrateToVersion11 = async function () {
    console.log('[VibeDB] 开始迁移到版本 11');

    // 删除 images 表及其索引
    await _connection.queryAsync(`DROP TABLE IF EXISTS images`);
    console.log('[VibeDB] ✓ 已删除 images 表');

    // 删除 tables 表及其索引
    await _connection.queryAsync(`DROP TABLE IF EXISTS tables`);
    console.log('[VibeDB] ✓ 已删除 tables 表');

    console.log('[VibeDB] ✓ 版本 11 迁移完成：images 和 tables 表已删除');
  };

  /**
   * 迁移到版本 12：为 papers 表添加 github_url 字段
   */
  this._migrateToVersion12 = async function () {
    console.log('[VibeDB] 开始迁移到版本 12');
    try {
      await _connection.queryAsync(`
				ALTER TABLE papers ADD COLUMN github_url TEXT
			`);
      console.log('[VibeDB] ✓ 已为 papers 表添加 github_url 字段');
    } catch (e) {
      // 如果字段已存在，忽略错误
      if (e.message && e.message.includes('duplicate column name')) {
        console.log('[VibeDB] github_url 字段已存在，跳过添加');
      } else {
        throw e;
      }
    }
    console.log('[VibeDB] ✓ 版本 12 迁移完成');
  };

  /**
   * 迁移到版本 13：为 flash_cards 和 summary_cards 添加 client_uuid 字段
   * 用于云同步时跨设备匹配单条记录
   */
  this._migrateToVersion13 = async function () {
    console.log('[VibeDB] 开始迁移到版本 13');

    // 1. flash_cards 添加 client_uuid（SQLite 不支持 ALTER TABLE ADD COLUMN ... UNIQUE，需分两步）
    try {
      await _connection.queryAsync(`ALTER TABLE flash_cards ADD COLUMN client_uuid TEXT`);
      console.log('[VibeDB] ✓ 已为 flash_cards 表添加 client_uuid 字段');
    } catch (e) {
      if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
        console.log('[VibeDB] flash_cards.client_uuid 字段已存在，跳过');
      } else {
        throw e;
      }
    }

    // 2. summary_cards 添加 client_uuid
    try {
      await _connection.queryAsync(`ALTER TABLE summary_cards ADD COLUMN client_uuid TEXT`);
      console.log('[VibeDB] ✓ 已为 summary_cards 表添加 client_uuid 字段');
    } catch (e) {
      if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
        console.log('[VibeDB] summary_cards.client_uuid 字段已存在，跳过');
      } else {
        throw e;
      }
    }

    // 3. 为已有记录生成 client_uuid
    const fcRows = await _connection.queryAsync('SELECT flashcard_id FROM flash_cards WHERE client_uuid IS NULL');
    for (const row of fcRows) {
      await _connection.queryAsync(
        'UPDATE flash_cards SET client_uuid = ? WHERE flashcard_id = ?',
        [Zotero.Utilities.generateObjectKey() + '-' + Date.now(), row.flashcard_id]
      );
    }
    console.log(`[VibeDB] ✓ 已为 ${fcRows.length} 条 flash_cards 生成 client_uuid`);

    const scRows = await _connection.queryAsync('SELECT summarycard_id FROM summary_cards WHERE client_uuid IS NULL');
    for (const row of scRows) {
      await _connection.queryAsync(
        'UPDATE summary_cards SET client_uuid = ? WHERE summarycard_id = ?',
        [Zotero.Utilities.generateObjectKey() + '-' + Date.now(), row.summarycard_id]
      );
    }
    console.log(`[VibeDB] ✓ 已为 ${scRows.length} 条 summary_cards 生成 client_uuid`);

    // 4. 创建唯一索引（已有记录填充完 UUID 后再建，避免 NULL 冲突）
    try {
      await _connection.queryAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_flash_cards_client_uuid ON flash_cards(client_uuid)`);
      console.log('[VibeDB] ✓ 已为 flash_cards.client_uuid 创建唯一索引');
    } catch (e) {
      console.warn('[VibeDB] 创建 flash_cards 唯一索引失败（可能已存在）:', e.message);
    }
    try {
      await _connection.queryAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_cards_client_uuid ON summary_cards(client_uuid)`);
      console.log('[VibeDB] ✓ 已为 summary_cards.client_uuid 创建唯一索引');
    } catch (e) {
      console.warn('[VibeDB] 创建 summary_cards 唯一索引失败（可能已存在）:', e.message);
    }

    console.log('[VibeDB] ✓ 版本 13 迁移完成');
  };

  /**
   * 迁移到版本 14：为 papers 添加稳定附件键
   * - attachment_library_id
   * - attachment_key
   * 用于跨设备和本地重绑时稳定定位同一 PDF 附件
   */
  this._migrateToVersion14 = async function () {
    console.log('[VibeDB] 开始迁移到版本 14');

    try {
      await _connection.queryAsync(`ALTER TABLE papers ADD COLUMN attachment_library_id INTEGER`);
      console.log('[VibeDB] ✓ 已为 papers 表添加 attachment_library_id 字段');
    }
    catch (e) {
      if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
        console.log('[VibeDB] papers.attachment_library_id 字段已存在，跳过');
      } else
      {
        throw e;
      }
    }

    try {
      await _connection.queryAsync(`ALTER TABLE papers ADD COLUMN attachment_key TEXT`);
      console.log('[VibeDB] ✓ 已为 papers 表添加 attachment_key 字段');
    }
    catch (e) {
      if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
        console.log('[VibeDB] papers.attachment_key 字段已存在，跳过');
      } else
      {
        throw e;
      }
    }

    const rows = [];
    await _connection.queryAsync(
      `SELECT paper_id, item_id
			 FROM papers
			 WHERE attachment_library_id IS NULL OR attachment_key IS NULL`,
      [],
      {
        onRow: function (row) {
          rows.push({
            paper_id: row.getResultByName('paper_id'),
            item_id: row.getResultByName('item_id')
          });
        }
      }
    );

    let backfilled = 0;
    for (const row of rows) {
      const identity = await _getAttachmentIdentityForItemID(row.item_id);
      if (!identity.attachmentLibraryID || !identity.attachmentKey) {
        console.warn(`[VibeDB] 版本 14 迁移：无法为 paper_id=${row.paper_id} item_id=${row.item_id} 回填稳定键`);
        continue;
      }

      await _connection.queryAsync(
        `UPDATE papers
				 SET attachment_library_id = ?, attachment_key = ?
				 WHERE paper_id = ?`,
        [identity.attachmentLibraryID, identity.attachmentKey, row.paper_id]
      );
      backfilled++;
    }
    console.log(`[VibeDB] ✓ 版本 14 迁移：已回填 ${backfilled} 条 papers 稳定键`);

    try {
      await _connection.queryAsync(`
				CREATE INDEX IF NOT EXISTS idx_papers_attachment_identity
				ON papers(attachment_library_id, attachment_key)
			`);
      console.log('[VibeDB] ✓ 已创建 papers 稳定键普通索引');
    }
    catch (e) {
      console.warn('[VibeDB] 创建 papers 稳定键普通索引失败:', e.message);
    }

    try {
      await _connection.queryAsync(`
				CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_attachment_identity_unique
				ON papers(attachment_library_id, attachment_key)
				WHERE attachment_library_id IS NOT NULL AND attachment_key IS NOT NULL
			`);
      console.log('[VibeDB] ✓ 已创建 papers 稳定键唯一索引');
    }
    catch (e) {
      // 历史坏数据可能导致唯一索引失败，不阻断迁移；运行时仍按最新记录兜底
      console.warn('[VibeDB] 创建 papers 稳定键唯一索引失败，将继续使用运行时兜底匹配:', e.message);
    }

    console.log('[VibeDB] ✓ 版本 14 迁移完成');
  };

  this._migrateToVersion15 = async function () {
    console.log('[VibeDB] 开始迁移到版本 15');

    const addColumnIfMissing = async (table, column, typeClause) => {
      try {
        await _connection.queryAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeClause}`);
        console.log(`[VibeDB] ✓ 已为 ${table} 表添加 ${column} 字段`);
      }
      catch (e) {
        if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
          console.log(`[VibeDB] ${table}.${column} 字段已存在，跳过`);
        } else
        {
          throw e;
        }
      }
    };

    await addColumnIfMissing('article_summary', 'client_uuid', 'TEXT');
    await addColumnIfMissing('article_summary', 'updated_at', 'INTEGER');
    await addColumnIfMissing('sections', 'client_uuid', 'TEXT');
    await addColumnIfMissing('sections', 'updated_at', 'INTEGER');
    await addColumnIfMissing('paragraphs', 'updated_at', 'INTEGER');
    await addColumnIfMissing('points', 'client_uuid', 'TEXT');
    await addColumnIfMissing('points', 'updated_at', 'INTEGER');
    await addColumnIfMissing('sentences', 'updated_at', 'INTEGER');

    const now = Math.floor(Date.now() / 1000);
    await _connection.queryAsync(`UPDATE article_summary SET updated_at = COALESCE(updated_at, created_at, ?)`, [now]);
    await _connection.queryAsync(`UPDATE sections SET updated_at = COALESCE(updated_at, created_at, ?)`, [now]);
    await _connection.queryAsync(`UPDATE paragraphs SET updated_at = COALESCE(updated_at, created_at, ?)`, [now]);
    await _connection.queryAsync(`UPDATE points SET updated_at = COALESCE(updated_at, created_at, ?)`, [now]);
    await _connection.queryAsync(`UPDATE sentences SET updated_at = COALESCE(updated_at, created_at, ?)`, [now]);

    const backfillUUIDs = async (table, idColumn) => {
      const rows = await _connection.queryAsync(
        `SELECT ${idColumn} FROM ${table} WHERE client_uuid IS NULL OR client_uuid = ''`
      );
      if (rows.length) {
        await _connection.executeTransaction(async () => {
          for (const row of rows) {
            await _connection.queryAsync(
              `UPDATE ${table} SET client_uuid = ? WHERE ${idColumn} = ?`,
              [_generateSyncUUID(), row[idColumn]]
            );
          }
        });
      }
      console.log(`[VibeDB] ✓ 已为 ${rows.length} 条 ${table} 生成 client_uuid`);
    };

    await backfillUUIDs('article_summary', 'summary_id');
    await backfillUUIDs('sections', 'section_id');
    await backfillUUIDs('points', 'point_id');

    const ensureIndex = async (sql, label) => {
      try {
        await _connection.queryAsync(sql);
        console.log(`[VibeDB] ✓ 已创建 ${label}`);
      }
      catch (e) {
        console.warn(`[VibeDB] 创建 ${label} 失败:`, e.message);
      }
    };

    await ensureIndex('CREATE UNIQUE INDEX IF NOT EXISTS idx_article_summary_client_uuid ON article_summary(client_uuid)', 'article_summary.client_uuid 唯一索引');
    await ensureIndex('CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_client_uuid ON sections(client_uuid)', 'sections.client_uuid 唯一索引');
    await ensureIndex('CREATE UNIQUE INDEX IF NOT EXISTS idx_points_client_uuid ON points(client_uuid)', 'points.client_uuid 唯一索引');
    await ensureIndex('CREATE INDEX IF NOT EXISTS idx_article_summary_updated_at ON article_summary(updated_at)', 'article_summary.updated_at 索引');
    await ensureIndex('CREATE INDEX IF NOT EXISTS idx_sections_updated_at ON sections(updated_at)', 'sections.updated_at 索引');
    await ensureIndex('CREATE INDEX IF NOT EXISTS idx_paragraphs_updated_at ON paragraphs(updated_at)', 'paragraphs.updated_at 索引');
    await ensureIndex('CREATE INDEX IF NOT EXISTS idx_points_updated_at ON points(updated_at)', 'points.updated_at 索引');
    await ensureIndex('CREATE INDEX IF NOT EXISTS idx_sentences_updated_at ON sentences(updated_at)', 'sentences.updated_at 索引');

    const ensureTrigger = async (name, bodySQL) => {
      try {
        await _connection.queryAsync(bodySQL);
        console.log(`[VibeDB] ✓ 已创建 ${name}`);
      }
      catch (e) {
        console.warn(`[VibeDB] 创建 ${name} 失败:`, e.message);
      }
    };

    await ensureTrigger('update_article_summary_timestamp', `
			CREATE TRIGGER IF NOT EXISTS update_article_summary_timestamp
			AFTER UPDATE ON article_summary BEGIN
				UPDATE article_summary SET updated_at = strftime('%s', 'now') WHERE summary_id = NEW.summary_id;
			END
		`);
    await ensureTrigger('update_sections_timestamp', `
			CREATE TRIGGER IF NOT EXISTS update_sections_timestamp
			AFTER UPDATE ON sections BEGIN
				UPDATE sections SET updated_at = strftime('%s', 'now') WHERE section_id = NEW.section_id;
			END
		`);
    await ensureTrigger('update_paragraphs_timestamp', `
			CREATE TRIGGER IF NOT EXISTS update_paragraphs_timestamp
			AFTER UPDATE ON paragraphs BEGIN
				UPDATE paragraphs SET updated_at = strftime('%s', 'now') WHERE paragraph_id = NEW.paragraph_id;
			END
		`);
    await ensureTrigger('update_points_timestamp', `
			CREATE TRIGGER IF NOT EXISTS update_points_timestamp
			AFTER UPDATE ON points BEGIN
				UPDATE points SET updated_at = strftime('%s', 'now') WHERE point_id = NEW.point_id;
			END
		`);
    await ensureTrigger('update_sentences_timestamp', `
			CREATE TRIGGER IF NOT EXISTS update_sentences_timestamp
			AFTER UPDATE ON sentences BEGIN
				UPDATE sentences SET updated_at = strftime('%s', 'now') WHERE sentence_id = NEW.sentence_id;
			END
		`);

    console.log('[VibeDB] ✓ 版本 15 迁移完成');
  };

  this._migrateToVersion16 = async function () {
    console.log('[VibeDB] 开始迁移到版本 16');

    const syncedTables = [
    'papers',
    'article_summary',
    'sections',
    'paragraphs',
    'points',
    'sentences',
    'summary_cards',
    'flash_cards',
    'ai_chats'];


    const addColumnIfMissing = async (table, column, typeClause) => {
      try {
        await _connection.queryAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeClause}`);
        console.log(`[VibeDB] ✓ 已为 ${table} 表添加 ${column} 字段`);
      }
      catch (e) {
        if (e.message && (e.message.includes('duplicate column name') || e.message.includes('already exists'))) {
          console.log(`[VibeDB] ${table}.${column} 字段已存在，跳过`);
        } else
        {
          throw e;
        }
      }
    };

    for (const table of syncedTables) {
      await addColumnIfMissing(table, 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');
      await addColumnIfMissing(table, 'last_synced_revision', 'INTEGER NOT NULL DEFAULT 0');
      await _connection.queryAsync(`UPDATE ${table} SET sync_dirty = COALESCE(sync_dirty, 0), last_synced_revision = COALESCE(last_synced_revision, 0)`);
    }

    const ensureIndex = async (sql, label) => {
      try {
        await _connection.queryAsync(sql);
        console.log(`[VibeDB] ✓ 已创建 ${label}`);
      }
      catch (e) {
        console.warn(`[VibeDB] 创建 ${label} 失败:`, e.message);
      }
    };

    for (const table of syncedTables) {
      await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_${table}_sync_dirty ON ${table}(sync_dirty)`, `${table}.sync_dirty 索引`);
      await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_${table}_last_synced_revision ON ${table}(last_synced_revision)`, `${table}.last_synced_revision 索引`);
    }

    console.log('[VibeDB] ✓ 版本 16 迁移完成');
  };

  this._migrateToVersion17 = async function () {
    console.log('[VibeDB] 开始迁移到版本 17');
    await _connection.queryAsync(`
			CREATE TABLE IF NOT EXISTS local_paper_sync_index (
				paper_id INTEGER PRIMARY KEY,
				changed_tables TEXT NOT NULL DEFAULT '[]',
				updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
			)
		`);
    await _connection.queryAsync(
      'CREATE INDEX IF NOT EXISTS idx_local_paper_sync_index_updated_at ON local_paper_sync_index(updated_at)'
    );
    await _rebuildLocalPaperSyncIndex();
    console.log('[VibeDB] ✓ 版本 17 迁移完成');
  };

  /**
   * 关闭数据库连接
   */
  this.close = async function () {
    if (_itemNotifierID) {
      Zotero.Notifier.unregisterObserver(_itemNotifierID);
      _itemNotifierID = null;
    }
    if (_connection) {
      await _connection.closeDatabase();
      _connection = null;
      _dbInitialized = false;
      Zotero.debug('[VibeDB] Database connection closed');
    }
  };

  /**
   * 获取 schema 更新 Promise（类似 Zotero.Schema.schemaUpdatePromise）
   */
  Object.defineProperty(this, 'schemaUpdatePromise', {
    get: function () {
      return _schemaUpdateDeferred.promise;
    }
  });

  // ==================== 数据访问方法 ====================

  /**
   * Papers 表 CRUD
   */
  this.Papers = {
    touchByPaperID: async function (paperID) {
      await _touchPaperByPaperID(paperID);
    },

    touchByParagraphID: async function (paragraphID) {
      const paperID = await _getPaperIDByParagraphID(paragraphID);
      if (paperID) {
        await _touchPaperByPaperID(paperID);
      }
    },

    touchBySummaryID: async function (summaryID) {
      const paperID = await _getPaperIDBySummaryID(summaryID);
      if (paperID) {
        await _touchPaperByPaperID(paperID);
      }
    },

    touchBySummaryCardID: async function (summaryCardID) {
      const paperID = await _getPaperIDBySummaryCardID(summaryCardID);
      if (paperID) {
        await _touchPaperByPaperID(paperID);
      }
    },

    touchByPointID: async function (pointID) {
      const paperID = await _getPaperIDByPointID(pointID);
      if (paperID) {
        await _touchPaperByPaperID(paperID);
      }
    },

    markSyncDirtyForTable: async function (paperID, tableName) {
      await _upsertLocalPaperSyncIndex(paperID, tableName);
    },

    clearSyncIndexTables: async function (paperID, tableNames) {
      await _clearLocalPaperSyncIndexTables(paperID, tableNames);
    },

    rebuildLocalSyncIndex: async function () {
      await _rebuildLocalPaperSyncIndex();
    },

    /**
     * 根据稳定附件键获取论文记录
     * 若存在多条历史脏数据，优先返回最新一条
     */
    getByAttachmentIdentity: async function (attachmentLibraryID, attachmentKey) {
      if (!attachmentLibraryID || !attachmentKey) {
        return null;
      }

      const row = await _connection.rowQueryAsync(
        `SELECT *
				 FROM papers
				 WHERE attachment_library_id = ? AND attachment_key = ?
				 ORDER BY updated_at DESC, paper_id DESC
				 LIMIT 1`,
        [attachmentLibraryID, attachmentKey]
      );
      return _normalizePaperRow(row);
    },

    /**
     * 获取当前 item 对应的稳定附件键
     */
    getAttachmentIdentityForItem: async function (itemID) {
      return _getAttachmentIdentityForItemID(itemID);
    },

    /**
     * 创建或更新论文记录
     * @param {Number} itemID - Zotero item ID
     * @param {Object} data - 论文数据
     */
    save: async function (itemID, data, { isRemoteTrigger = false } = {}) {
      console.log('[VibeDB.Papers] save: 开始保存论文数据', {
        itemID,
        isRemoteTrigger,
        hasResultDir: !!data.resultDir,
        hasMarkdownContent: !!data.markdownContent,
        hasOutline: !!data.outline,
        hasBlockMapping: !!data.blockMapping,
        updatedAt: data.updatedAt || null
      });

      // 检查数据库连接
      if (!_connection) {
        console.error(`[VibeDB.Papers] ❌ 数据库连接未初始化！`);
        throw new Error('Database connection not initialized');
      }
      // console.log(`[VibeDB.Papers] ✓ 数据库连接已就绪`);

      const {
        resultDir = null,
        markdownContent = null,
        articleSummary = null,
        outline = null,
        blockMapping = null,
        githubUrl = null,
        attachmentLibraryID = null,
        attachmentKey = null,
        updatedAt = null, // 云端时间戳（仅远端触发时使用）
        syncRevision = null
      } = data;

      const outlineStr = outline ? JSON.stringify(outline) : null;
      const blockMappingStr = blockMapping ? JSON.stringify(blockMapping) : null;
      const derivedIdentity = await _getAttachmentIdentityForItemID(itemID);
      const stableLibraryID = attachmentLibraryID ?? derivedIdentity.attachmentLibraryID;
      const stableItemKey = attachmentKey ?? derivedIdentity.attachmentKey;

      const existingPaperByIdentity = stableLibraryID && stableItemKey ?
      await this.getByAttachmentIdentity(stableLibraryID, stableItemKey) :
      null;

      const tsValue = isRemoteTrigger && updatedAt ? updatedAt : null;
      const syncState = _getLocalSyncState(isRemoteTrigger, syncRevision);

      try {
        if (existingPaperByIdentity) {
          const persistedItemID = await _getSafePersistedItemID(existingPaperByIdentity.paper_id, itemID);
          const updateSql = `
						UPDATE papers
						SET ${persistedItemID ? 'item_id = ?,' : ''}
							attachment_library_id = ?,
							attachment_key = ?,
							result_dir = ?,
							markdown_content = ?,
							article_summary = ?,
							outline = ?,
							block_mapping = ?,
							github_url = ?,
							updated_at = ${tsValue ? '?' : "strftime('%s', 'now')"},
							sync_dirty = ?,
							last_synced_revision = CASE WHEN ? = 0 THEN ? ELSE last_synced_revision END
						WHERE paper_id = ?
					`;
          const params = [
          ...(persistedItemID ? [persistedItemID] : []),
          stableLibraryID,
          stableItemKey,
          resultDir,
          markdownContent,
          articleSummary,
          outlineStr,
          blockMappingStr,
          githubUrl];

          if (tsValue) {
            params.push(tsValue);
          }
          params.push(syncState.syncDirty, syncState.syncDirty, syncState.lastSyncedRevision);
          params.push(existingPaperByIdentity.paper_id);
          await _connection.queryAsync(updateSql, params);
        } else
        {
          const tsExpr = tsValue ? '?' : "strftime('%s', 'now')";
          const insertSql = `
						INSERT INTO papers (
							item_id, attachment_library_id, attachment_key,
							result_dir, markdown_content, article_summary,
							outline, block_mapping, github_url, updated_at, sync_dirty, last_synced_revision
						)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${tsExpr}, ?, ?)
						ON CONFLICT(item_id) DO UPDATE SET
							attachment_library_id = excluded.attachment_library_id,
							attachment_key = excluded.attachment_key,
							result_dir = excluded.result_dir,
							markdown_content = excluded.markdown_content,
							article_summary = excluded.article_summary,
							outline = excluded.outline,
							block_mapping = excluded.block_mapping,
							github_url = excluded.github_url,
							updated_at = ${tsExpr},
							sync_dirty = excluded.sync_dirty,
							last_synced_revision = CASE
								WHEN excluded.sync_dirty = 0 THEN excluded.last_synced_revision
								ELSE papers.last_synced_revision
							END
					`;
          const params = [
          itemID,
          stableLibraryID,
          stableItemKey,
          resultDir,
          markdownContent,
          articleSummary,
          outlineStr,
          blockMappingStr,
          githubUrl];

          if (tsValue) {
            params.push(tsValue);
          }
          params.push(syncState.syncDirty, syncState.lastSyncedRevision);
          if (tsValue) {
            params.push(tsValue);
          }
          await _connection.queryAsync(insertSql, params);
        }

        console.log('[VibeDB.Papers] save: SQL 执行成功', {
          itemID,
          isRemoteTrigger,
          attachmentLibraryID: stableLibraryID,
          attachmentKey: stableItemKey
        });

        if (!isRemoteTrigger) {
          const savedPaper = await this.get(itemID);
          if (savedPaper?.paper_id) {
            await _upsertLocalPaperSyncIndex(savedPaper.paper_id, 'papers');
          }
        }

        // 云同步改为手动触发，不再自动 markDataChanged
      } catch (e) {
        console.error(`[VibeDB.Papers] ❌ SQL 执行失败:`, e);
        throw e;
      }

      // console.log(`[VibeDB.Papers] ✓ 论文数据已保存: itemID=${itemID}`);
      Zotero.debug(`[VibeDB] Saved paper data for item ${itemID}`);
    },

    /**
     * 获取论文记录
     * @param {Number} itemID - Zotero item ID
     * @returns {Object|null}
     */
    get: async function (itemID) {
      let row = await _connection.rowQueryAsync("SELECT * FROM papers WHERE item_id = ?", [itemID]);
      const identities = await _getAttachmentIdentitiesForItemID(itemID);
      const primaryIdentity = identities[0] || {
        attachmentLibraryID: null,
        attachmentKey: null
      };
      if (row) {
        if (!identities.length || identities.some((identity) => _paperRowMatchesAttachmentIdentity(row, identity))) {
          return _normalizePaperRow(row);
        }
        Zotero.debug(
          `[VibeDB] Ignoring stale papers.item_id binding for item ${itemID}: ` +
          `paper_id=${row.paper_id}, stored=${row.attachment_library_id}:${row.attachment_key}, ` +
          `current=${primaryIdentity.attachmentLibraryID}:${primaryIdentity.attachmentKey}`
        );
      }

      // 兼容历史错绑：如果 item_id 查不到，则按当前 item 的所有可能附件稳定键回查，
      // 避免父条目 + 多附件时只看 bestAttachment 导致明明有解析数据却读取不到。
      if (!identities.length) {
        return null;
      }

      let matchedIdentity = null;
      for (const identity of identities) {
        row = await _connection.rowQueryAsync(
          `SELECT *
					 FROM papers
					 WHERE attachment_library_id = ? AND attachment_key = ?
					 ORDER BY updated_at DESC, paper_id DESC
					 LIMIT 1`,
          [identity.attachmentLibraryID, identity.attachmentKey]
        );
        if (row) {
          matchedIdentity = identity;
          break;
        }
      }
      if (!row) {
        return null;
      }

      if (row.item_id !== itemID) {
        const persistedItemID = await _getSafePersistedItemID(row.paper_id, itemID);
        if (persistedItemID) {
          await _connection.queryAsync(
            `UPDATE papers
						 SET item_id = ?, attachment_library_id = ?, attachment_key = ?
						 WHERE paper_id = ?`,
            [persistedItemID, matchedIdentity.attachmentLibraryID, matchedIdentity.attachmentKey, row.paper_id]
          );
          try {
            await this.refreshItemIDCache();
          }
          catch (e) {
            Zotero.debug('[VibeDB] refreshItemIDCache after paper rebinding failed: ' + e);
          }
          row = await _connection.rowQueryAsync("SELECT * FROM papers WHERE paper_id = ?", [row.paper_id]);
        }
      }

      return _normalizePaperRow(row);
    },

    /**
     * 确保 papers 表存在对应 item 的行（仅插入占位行，不覆盖已有解析数据）。
     * 供 AI 对话等在未解析前写入 ai_chats 使用；后续 Papers.save 会 ON CONFLICT 更新同一条 paper_id。
     */
    ensureRowForItem: async function (itemID) {
      let paper = await this.get(itemID);
      if (paper) {
        return paper;
      }
      try {
        const identity = await _getAttachmentIdentityForItemID(itemID);
        if (identity.attachmentLibraryID && identity.attachmentKey) {
          const existingByIdentity = await this.getByAttachmentIdentity(
            identity.attachmentLibraryID,
            identity.attachmentKey
          );
          if (existingByIdentity) {
            const persistedItemID = await _getSafePersistedItemID(existingByIdentity.paper_id, itemID);
            await _connection.queryAsync(
              `UPDATE papers
							 SET ${persistedItemID ? 'item_id = ?, ' : ''}attachment_library_id = ?, attachment_key = ?, updated_at = strftime('%s', 'now'), sync_dirty = 1
							 WHERE paper_id = ?`,
              [
              ...(persistedItemID ? [persistedItemID] : []),
              identity.attachmentLibraryID,
              identity.attachmentKey,
              existingByIdentity.paper_id]

            );
          } else
          {
            await _connection.queryAsync(
              `INSERT INTO papers (item_id, attachment_library_id, attachment_key, updated_at, sync_dirty, last_synced_revision)
							 VALUES (?, ?, ?, strftime('%s', 'now'), 1, 0)`,
              [itemID, identity.attachmentLibraryID, identity.attachmentKey]
            );
          }
        } else
        {
          await _connection.queryAsync(
            `INSERT INTO papers (item_id, updated_at, sync_dirty, last_synced_revision) VALUES (?, strftime('%s', 'now'), 1, 0)`,
            [itemID]
          );
        }
      }
      catch (e) {
        const msg = String(e.message || e);
        // 并发下可能已有同 item_id 行
        if (!msg.includes('UNIQUE') && !msg.includes('constraint')) {
          throw e;
        }
      }
      paper = await this.get(itemID);
      if (!paper) {
        throw new Error(`[VibeDB] Failed to ensure paper row for item ${itemID}`);
      }
      await _upsertLocalPaperSyncIndex(paper.paper_id, 'papers');
      return paper;
    },

    /**
     * 删除论文记录（级联删除相关数据）
     * @param {Number} itemID - Zotero item ID
     */
    delete: async function (itemID) {
      // 先获取 paper_id
      const paper = await this.get(itemID);
      if (!paper) {
        Zotero.debug(`[VibeDB] Paper not found for item ${itemID}`);
        return;
      }

      const sql = "DELETE FROM papers WHERE paper_id = ?";
      await _connection.queryAsync(sql, [paper.paper_id]);

      Zotero.debug(`[VibeDB] Deleted paper data for item ${itemID}`);
      await this.refreshItemIDCache();
    },



    /**
     * 删除论文的所有数据（包括级联删除所有相关表）
     * 用于重新解析论文时清空旧数据
     * @param {Number} itemID - Zotero item ID
     * @returns {Boolean} 是否成功删除
     */
    deleteAll: async function (itemID) {
      // console.log(`[VibeDB.Papers] 开始删除论文所有数据: itemID=${itemID}`);

      // 先获取 paper_id
      const paper = await this.get(itemID);
      if (!paper) {
        // console.log(`[VibeDB.Papers] 论文不存在，无需删除: itemID=${itemID}`);
        return false;
      }

      const paperID = paper.paper_id;
      // console.log(`[VibeDB.Papers] 找到论文记录: paper_id=${paperID}`);

      try {
        await _connection.executeTransaction(async () => {
          // 统计删除前的数据量（用于验证）
          const countQueries = [
          { name: 'paragraphs', sql: 'SELECT COUNT(*) as count FROM paragraphs WHERE paper_id = ?' },
          { name: 'summary_cards', sql: 'SELECT COUNT(*) as count FROM summary_cards WHERE paper_id = ?' },
          { name: 'flash_cards', sql: 'SELECT COUNT(*) as count FROM flash_cards WHERE paper_id = ?' },
          { name: 'ai_chats', sql: 'SELECT COUNT(*) as count FROM ai_chats WHERE paper_id = ?' }];


          // console.log(`[VibeDB.Papers] 删除前数据统计:`);
          for (const query of countQueries) {
            const count = await _connection.valueQueryAsync(query.sql, [paperID]);
            // console.log(`[VibeDB.Papers]   - ${query.name}: ${count} 条`);
          }

          // 由于设置了外键级联删除（ON DELETE CASCADE），
          // 删除 papers 表记录会自动删除所有相关数据：
          // - paragraphs (通过 paper_id 外键)
          //   - points (通过 paragraph_id 外键)
          //   - sentences (通过 paragraph_id 外键)
          // - summary_cards (通过 paper_id 外键)
          // - flash_cards (通过 paper_id 外键)
          // - ai_chats (通过 paper_id 外键)

          try {
            // console.log(`[VibeDB.Papers] 执行级联删除: paper_id=${paperID}`);
            const sql = "DELETE FROM papers WHERE paper_id = ?";
            await _connection.queryAsync(sql, [paperID]);
          } catch (error) {
            console.error(`[VibeDB.Papers] ❌ 删除失败:`, error);
          }

          // console.log(`[VibeDB.Papers] ✅ 论文所有数据已删除: itemID=${itemID}, paper_id=${paperID}`);
        });

        await this.refreshItemIDCache();

        return true;
      }
      catch (error) {
        console.error(`[VibeDB.Papers] ❌ 删除论文数据失败: itemID=${itemID}`, error);
        Zotero.logError(`[VibeDB] Failed to delete all data for item ${itemID}:`, error);
        throw error;
      }
    },

    /**
     * 删除论文的解析数据，但保留 FlashCards 和 AIChats
     * 用于重新解析论文时清空旧数据，但不丢失用户的重要数据
     * @param {Number} itemID - Zotero item ID
     * @returns {Boolean} 是否成功
     */
    deleteParsingResultsOnly: async function (itemID) {
      // console.log(`[VibeDB.Papers] 开始删除论文解析数据(保留用户数据): itemID=${itemID}`);

      // 先获取 paper_id
      const paper = await this.get(itemID);
      if (!paper) {
        return false;
      }

      const paperID = paper.paper_id;

      try {
        await _connection.executeTransaction(async () => {
          // 1. 删除段落 (级联删除 points, sentences, summary_cards)
          // 根据外键约束，flash_cards 的 paragraph_id 会被置为 NULL (ON DELETE SET NULL)
          await _connection.queryAsync("DELETE FROM paragraphs WHERE paper_id = ?", [paperID]);

          // 2. 删除 sections (单独的外键)
          await _connection.queryAsync("DELETE FROM sections WHERE paper_id = ?", [paperID]);

          // 3. 删除 article_summary (单独的外键)
          await _connection.queryAsync("DELETE FROM article_summary WHERE paper_id = ?", [paperID]);

          // 4. 不删除 papers 表记录，也不删除 ai_chats (仅关联 paper_id)
          // 5. 不删除 flash_cards (级联 set null 后保留，且关联 paper_id)
        });

        await this.refreshItemIDCache();
        return true;
      }
      catch (error) {
        console.error(`[VibeDB.Papers] ❌ 删除论文解析数据失败: itemID=${itemID}`, error);
        throw error;
      }
    },

    /**
     * 更新论文的 GitHub URL
     * @param {Number} itemID - Zotero item ID
     * @param {String} githubUrl - GitHub 仓库 URL
     */
    updateGitHubUrl: async function (itemID, githubUrl) {
      // console.log(`[VibeDB.Papers] 更新 GitHub URL: itemID=${itemID}, url=${githubUrl}`);

      // 先检查论文是否存在
      const paper = await this.get(itemID);
      if (!paper) {
        console.warn(`[VibeDB.Papers] 论文不存在，无法更新 GitHub URL: itemID=${itemID}`);
        return false;
      }

      const sql = `
				UPDATE papers 
				SET github_url = ?, updated_at = strftime('%s', 'now'), sync_dirty = 1
				WHERE paper_id = ?
			`;

      await _connection.queryAsync(sql, [githubUrl, paper.paper_id]);
      await _upsertLocalPaperSyncIndex(paper.paper_id, 'papers');
      // console.log(`[VibeDB.Papers] ✓ GitHub URL 已更新: itemID=${itemID}`);
      return true;
    },

    /**
     * 获取论文的 GitHub URL
     * @param {Number} itemID - Zotero item ID
     * @returns {String|null} GitHub URL 或 null
     */
    getGitHubUrl: async function (itemID) {
      const paper = await this.get(itemID);
      return paper ? paper.github_url || null : null;
    },

    /**
     * 重建 papers.item_id 内存缓存（启动时调用；外部若有直接写库可再调）
     */
    refreshItemIDCache: async function () {
      let previousItemIDSet = new Set(_paperItemIDSet);
      _paperItemIDSet.clear();
      if (!_connection) {
        return;
      }
      // 统一口径：有 summary_cards 的论文才视为「已解析」（与 onflow 缓存判断一致）
      let rows = [];
      await _connection.queryAsync(`
				SELECT DISTINCT p.item_id, p.attachment_library_id, p.attachment_key
				FROM papers p
				JOIN summary_cards sc ON sc.paper_id = p.paper_id
			`, [], {
        onRow: function (row) {
          rows.push({
            item_id: row.getResultByName('item_id'),
            attachment_library_id: row.getResultByName('attachment_library_id'),
            attachment_key: row.getResultByName('attachment_key')
          });
        }
      });
      for (const row of rows) {
        let resolvedItemID = null;
        if (row.attachment_library_id && row.attachment_key) {
          try {
            // Items.init() loads the library/key index before item objects
            // themselves. Use the ID index here so unloaded items still get
            // VIBE marks after restart.
            resolvedItemID = Zotero.Items.getIDFromLibraryAndKey(
              row.attachment_library_id,
              row.attachment_key
            );
          }
          catch (e) {
            Zotero.debug('[VibeDB] refreshItemIDCache resolve by stable key failed: ' + e);
          }
        } else
        {
          resolvedItemID = row.item_id;
        }
        if (resolvedItemID) {
          _paperItemIDSet.add(resolvedItemID);
        }
      }

      let changedItemIDs = new Set();
      for (const itemID of previousItemIDSet) {
        if (!_paperItemIDSet.has(itemID)) {
          changedItemIDs.add(itemID);
        }
      }
      for (const itemID of _paperItemIDSet) {
        if (!previousItemIDSet.has(itemID)) {
          changedItemIDs.add(itemID);
        }
      }

      let affectedItemIDs = new Set(changedItemIDs);
      for (const itemID of changedItemIDs) {
        try {
          let item = await Zotero.Items.getAsync(itemID);
          if (item?.parentItemID) {
            affectedItemIDs.add(item.parentItemID);
          }
        }
        catch (e) {
          Zotero.debug('[VibeDB] refreshItemIDCache parent refresh failed: ' + e);
        }
      }

      await _invalidateItemsPaneVibeMarks(Array.from(affectedItemIDs));
    },

    /**
     * 同步判断某条目是否已有 summary_cards（用于条目列表 VIBE 标记）
     */
    hasItemInPapersSync: function (itemID) {
      return _paperItemIDSet.has(itemID);
    },

    /**
     * 同步判断条目本身或其任一子附件是否已有 summary_cards（顶层文献折叠时仍能显示 VIBE 标记）
     * @param {Zotero.Item} item
     */
    hasItemOrChildAttachmentInPapersSync: function (item) {
      if (!item || !(item instanceof Zotero.Item)) {
        return false;
      }
      if (_paperItemIDSet.has(item.id)) {
        return true;
      }
      if (!item.isRegularItem()) {
        return false;
      }
      try {
        let attIDs = item.getAttachments();
        for (let i = 0; i < attIDs.length; i++) {
          if (_paperItemIDSet.has(attIDs[i])) {
            return true;
          }
        }
      }
      catch (e) {
        Zotero.debug('[VibeDB] hasItemOrChildAttachmentInPapersSync: ' + e);
      }
      return false;
    }
  };

  /**
   * Paragraphs 表 CRUD
   */
  this.Paragraphs = {
    /**
     * 批量保存段落数据
     * @param {Number} itemID - Zotero item ID
     * @param {Array} paragraphs - 段落数组
     * @param {Number} paperID - 可选，paper_id（如果已知，避免重复查询）
     */
    saveBatch: async function (itemID, paragraphs, paperID = null) {
      // 如果没有提供 paperID，则查询获取
      if (!paperID) {
        const paper = await Zotero.VibeDB.Papers.get(itemID);
        if (!paper) {
          throw new Error(`[VibeDB] Paper not found for item ${itemID}`);
        }
        paperID = paper.paper_id;
      }

      // console.log(`[VibeDB.Paragraphs] 批量保存段落: paper_id=${paperID}, 数量=${paragraphs.length}`);

      await _connection.executeTransaction(async () => {
        for (const para of paragraphs) {
          try {
            const sql = `
						INSERT INTO paragraphs (
							paper_id, page_idx, paragraph_idx, minerU_id, paragraph_type,
							paragraph_text, paragraph_summary, importance_level,
							bbox, rects, updated_at, sync_dirty, last_synced_revision
						)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
						ON CONFLICT(paper_id, page_idx, paragraph_idx) DO UPDATE SET
							minerU_id = excluded.minerU_id,
							paragraph_type = excluded.paragraph_type,
							paragraph_text = excluded.paragraph_text,
							paragraph_summary = excluded.paragraph_summary,
							importance_level = excluded.importance_level,
							bbox = excluded.bbox,
							rects = excluded.rects,
							updated_at = excluded.updated_at,
							sync_dirty = 1
						`;

            await _connection.queryAsync(sql, [
            paperID, // 使用参数传入的 paperID
            para.page_idx,
            para.paragraph_idx,
            para.minerU_id || null,
            para.paragraph_type,
            para.paragraph_text || null,
            para.paragraph_summary || null,
            para.importance_level || null,
            para.bbox ? JSON.stringify(para.bbox) : null,
            para.rects ? JSON.stringify(para.rects) : null,
            para.updated_at || Math.floor(Date.now() / 1000)]
            );
          } catch (error) {
            console.error(`[VibeDB.Paragraphs] ❌ 保存段落失败: sql=${sql};\n params=${[
            paperID, // 使用参数传入的 paperID
            para.page_idx,
            para.paragraph_idx,
            para.minerU_id || null,
            para.paragraph_type,
            para.paragraph_text || null,
            para.paragraph_summary || null,
            para.importance_level || null,
            para.bbox ? JSON.stringify(para.bbox) : null,
            para.rects ? JSON.stringify(para.rects) : null]};\n error=${
            error}`);
            throw error;
          }
        }
      });

      await _upsertLocalPaperSyncIndex(paperID, 'paragraphs');
      Zotero.debug(`[VibeDB] Saved ${paragraphs.length} paragraphs for item ${itemID}`);
      await Zotero.VibeDB.Papers.refreshItemIDCache();
    },

    /**
     * 获取论文的所有段落
     * @param {Number} itemID - Zotero item ID
     * @param {Number} paperID - 可选，paper_id（如果已知，避免重复查询）
     * @returns {Array}
     */
    getByItemID: async function (itemID, paperID = null) {
      // 如果没有提供 paperID，则查询获取
      if (!paperID) {
        const paper = await Zotero.VibeDB.Papers.get(itemID);
        if (!paper) {
          return [];
        }
        paperID = paper.paper_id;
      }

      const sql = `
		SELECT * FROM paragraphs
		WHERE paper_id = ?
		ORDER BY page_idx, paragraph_idx
	`;

      // console.log(`[VibeDB.Paragraphs] 执行查询 SQL:`, sql);
      // console.log(`[VibeDB.Paragraphs] 查询参数: paperID =`, paperID, typeof paperID);

      let rows = [];
      try {
        // 使用 onRow 回调来收集行数据
        await _connection.queryAsync(
          sql,
          [paperID],
          {
            onRow: function (row) {
              // 将行转换为普通对象
              const rowObj = {
                paragraph_id: row.getResultByName('paragraph_id'),
                paper_id: row.getResultByName('paper_id'),
                page_idx: row.getResultByName('page_idx'),
                paragraph_idx: row.getResultByName('paragraph_idx'),
                minerU_id: row.getResultByName('minerU_id'),
                paragraph_type: row.getResultByName('paragraph_type'),
                paragraph_text: row.getResultByName('paragraph_text'),
                paragraph_summary: row.getResultByName('paragraph_summary'),
                importance_level: row.getResultByName('importance_level'),
                bbox: row.getResultByName('bbox'),
                rects: row.getResultByName('rects'),
                updated_at: row.getResultByName('updated_at')
              };
              rows.push(rowObj);
            }
          }
        );
        // console.log("[VibeDB.Paragraphs] 查询成功，找到", rows.length, "条记录");
      } catch (e) {
        console.error("[VibeDB.Paragraphs] 查询失败:", e);
        throw e;
      }
      // 如果没有结果，返回空数组
      if (!rows || rows.length === 0) {
        // console.log(`[VibeDB.Paragraphs] 没有找到段落记录: paper_id=${paperID}`);
        return [];
      }
      // console.log(`[VibeDB.Paragraphs] 找到 ${rows.length} 条段落记录`);

      // 解析 JSON 字段
      return rows.map((row) => {
        if (row.bbox) {
          try {
            row.bbox = JSON.parse(row.bbox);
          } catch (e) {
            row.bbox = null;
          }
        }
        if (row.rects) {
          try {
            row.rects = JSON.parse(row.rects);
          } catch (e) {
            row.rects = null;
          }
        }
        return row;
      });
    },

    /**
     * 更新单个段落的摘要
     */
    updateSummary: async function (paragraphID, paragraphSummary) {
      const sql = `
				UPDATE paragraphs
				SET paragraph_summary = ?, sync_dirty = 1
				WHERE paragraph_id = ?
			`;
      await _connection.queryAsync(sql, [
      paragraphSummary || null,
      paragraphID]
      );
      const paperID = await _getPaperIDByParagraphID(paragraphID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'paragraphs');
      }
    },

    /**
     * 更新段落的 importance_level
     * @param {Number} paragraphID - 段落 ID
     * @param {Number} importanceLevel - 重要性等级 (1=普通, 2=重要)
     */
    updateImportanceLevel: async function (paragraphID, importanceLevel) {
      const sql = `UPDATE paragraphs SET importance_level = ?, sync_dirty = 1 WHERE paragraph_id = ?`;
      await _connection.queryAsync(sql, [importanceLevel, paragraphID]);
      const paperID = await _getPaperIDByParagraphID(paragraphID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'paragraphs');
      }
      Zotero.debug(`[VibeDB.Paragraphs] Updated importance_level to ${importanceLevel} for paragraph ${paragraphID}`);
    }
  };

  /**
   * Points 表 CRUD
   */
  this.Points = {
    /**
     * 批量保存 points 数据
     * @param {Number} paragraphID - 段落 ID
     * @param {Array} points - points 数组
     */
    saveBatch: async function (paragraphID, points) {
      // 参数验证：确保 paragraphID 是有效的数字
      if (paragraphID === null || paragraphID === undefined || typeof paragraphID !== 'number') {
        // console.log(`[VibeDB.Points.saveBatch] 无效的 paragraphID: ${paragraphID} (type: ${typeof paragraphID})，跳过保存`);
        return;
      }

      const list = Array.isArray(points) ? points : [];

      await _connection.executeTransaction(async () => {
        // ON CONFLICT 只会覆盖已有 point_idx；合并 3→2 时旧 point_idx=2 必须删掉，否则重启又从 DB 读出“幽灵点”
        await _connection.queryAsync(
          'DELETE FROM points WHERE paragraph_id = ? AND point_idx >= ?',
          [paragraphID, list.length]
        );

        for (const point of list) {
          // 确保 point_idx 是数字
          const pointIdx = typeof point.point_idx === 'number' ? point.point_idx : parseInt(point.point_idx, 10);
          if (isNaN(pointIdx)) {
            // console.log(`[VibeDB.Points.saveBatch] 无效的 point_idx: ${point.point_idx}，跳过`);
            continue;
          }

          const sql = `
						INSERT INTO points (
							paragraph_id, client_uuid, point_idx, point_summary, point_translation,
							sentence_indices, char_mapping, rects, importance_level, updated_at, sync_dirty, last_synced_revision
						)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
						ON CONFLICT(paragraph_id, point_idx) DO UPDATE SET
							client_uuid = COALESCE(points.client_uuid, excluded.client_uuid),
							point_summary = excluded.point_summary,
							point_translation = excluded.point_translation,
							sentence_indices = excluded.sentence_indices,
							char_mapping = excluded.char_mapping,
							rects = excluded.rects,
							importance_level = excluded.importance_level,
							updated_at = excluded.updated_at,
							sync_dirty = 1
					`;

          // 安全地序列化 JSON 字段
          const sentenceIndices = point.sentence_indices && Array.isArray(point.sentence_indices) ?
          JSON.stringify(point.sentence_indices) : null;
          const charMapping = point.char_mapping && Array.isArray(point.char_mapping) ?
          JSON.stringify(point.char_mapping) : null;
          const rects = point.rects && Array.isArray(point.rects) ?
          JSON.stringify(point.rects) : null;
          const importanceLevel = typeof point.importance_level === 'number' ? point.importance_level : 1;

          // 确保字符串字段是有效的字符串或 null（避免 undefined 导致 bindByIndex 失败）
          const pointSummary = typeof point.point_summary === 'string' && point.point_summary.length > 0 ?
          point.point_summary : null;
          const pointTranslation = typeof point.point_translation === 'string' && point.point_translation.length > 0 ?
          point.point_translation : null;

          // 构建参数数组
          const params = [
          paragraphID,
          point.client_uuid || _generateSyncUUID(),
          pointIdx,
          pointSummary,
          pointTranslation,
          sentenceIndices,
          charMapping,
          rects,
          importanceLevel,
          point.updated_at || Math.floor(Date.now() / 1000)];


          try {
            await _connection.queryAsync(sql, params);
          } catch (e) {
            // 详细记录每个参数的类型和值，便于调试
            console.error(`[VibeDB.Points.saveBatch] ❌ 保存点失败:`);
            console.error(`  paragraphID: ${paragraphID} (${typeof paragraphID})`);
            console.error(`  pointIdx: ${pointIdx} (${typeof pointIdx})`);
            console.error(`  pointSummary: ${pointSummary} (${typeof pointSummary})`);
            console.error(`  pointTranslation: ${pointTranslation} (${typeof pointTranslation})`);
            console.error(`  sentenceIndices: ${sentenceIndices} (${typeof sentenceIndices})`);
            console.error(`  charMapping: ${charMapping} (${typeof charMapping})`);
            console.error(`  rects: ${rects} (${typeof rects})`);
            console.error(`  importanceLevel: ${importanceLevel} (${typeof importanceLevel})`);
            console.error(`  错误: ${e.message || e}`);
            throw e;
          }
        }
      });
      const paperID = await _getPaperIDByParagraphID(paragraphID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'points');
      }
    },

    // Save points for ALL paragraphs of a paper in ONE transaction.
    // paragraphDataArray: [{paragraphID, points}]
    saveBatchForPaper: async function (paperID, paragraphDataArray) {
      if (!paragraphDataArray || paragraphDataArray.length === 0) return;
      const sql = `
				INSERT INTO points (
					paragraph_id, client_uuid, point_idx, point_summary, point_translation,
					sentence_indices, char_mapping, rects, importance_level, updated_at, sync_dirty, last_synced_revision
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
				ON CONFLICT(paragraph_id, point_idx) DO UPDATE SET
					client_uuid = COALESCE(points.client_uuid, excluded.client_uuid),
					point_summary = excluded.point_summary,
					point_translation = excluded.point_translation,
					sentence_indices = excluded.sentence_indices,
					char_mapping = excluded.char_mapping,
					rects = excluded.rects,
					importance_level = excluded.importance_level,
					updated_at = excluded.updated_at,
					sync_dirty = 1
			`;
      await _connection.executeTransaction(async () => {
        for (const { paragraphID, points } of paragraphDataArray) {
          const list = Array.isArray(points) ? points : [];
          await _connection.queryAsync(
            'DELETE FROM points WHERE paragraph_id = ? AND point_idx >= ?',
            [paragraphID, list.length]
          );
          for (const point of list) {
            const pointIdx = typeof point.point_idx === 'number' ? point.point_idx : parseInt(point.point_idx, 10);
            if (isNaN(pointIdx)) continue;
            const sentenceIndices = point.sentence_indices && Array.isArray(point.sentence_indices) ?
            JSON.stringify(point.sentence_indices) : null;
            const charMapping = point.char_mapping && Array.isArray(point.char_mapping) ?
            JSON.stringify(point.char_mapping) : null;
            const rects = point.rects && Array.isArray(point.rects) ?
            JSON.stringify(point.rects) : null;
            const importanceLevel = typeof point.importance_level === 'number' ? point.importance_level : 1;
            const pointSummary = typeof point.point_summary === 'string' && point.point_summary.length > 0 ?
            point.point_summary : null;
            const pointTranslation = typeof point.point_translation === 'string' && point.point_translation.length > 0 ?
            point.point_translation : null;
            await _connection.queryAsync(sql, [
            paragraphID,
            point.client_uuid || _generateSyncUUID(),
            pointIdx,
            pointSummary,
            pointTranslation,
            sentenceIndices,
            charMapping,
            rects,
            importanceLevel,
            point.updated_at || Math.floor(Date.now() / 1000)]
            );
          }
        }
      });
      await _upsertLocalPaperSyncIndex(paperID, 'points');
    },

    /**
     * 获取段落的所有 points
     * @param {Number} paragraphID - 段落 ID
     * @returns {Array}
     */
    /**
     * 批量获取某篇论文下所有段落的 points（避免 N+1 查询）
     * 返回结果与逐个调用 getByParagraphID 完全一致，按 paragraph_id 分组到 Map
     */
    getByPaperID: async function (paperID) {
      const sql = `
				SELECT pt.* FROM points pt
				JOIN paragraphs pg ON pt.paragraph_id = pg.paragraph_id
				WHERE pg.paper_id = ?
				ORDER BY pg.page_idx, pg.paragraph_idx, pt.point_idx
			`;

      let rows = [];
      await _connection.queryAsync(sql, [paperID], {
        onRow: function (row) {
          const rowObj = {
            point_id: row.getResultByName('point_id'),
            paragraph_id: row.getResultByName('paragraph_id'),
            client_uuid: row.getResultByName('client_uuid'),
            point_idx: row.getResultByName('point_idx'),
            point_summary: row.getResultByName('point_summary'),
            point_translation: row.getResultByName('point_translation'),
            sentence_indices: row.getResultByName('sentence_indices'),
            char_mapping: row.getResultByName('char_mapping'),
            rects: row.getResultByName('rects'),
            importance_level: row.getResultByName('importance_level'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 JSON 字段（与 getByParagraphID 完全一致）
      rows = rows.map((row) => {
        ['sentence_indices', 'char_mapping', 'rects'].forEach((field) => {
          if (row[field]) {
            try {
              row[field] = JSON.parse(row[field]);
            } catch (e) {
              row[field] = null;
            }
          }
        });
        if (row.importance_level === null || row.importance_level === undefined) {
          row.importance_level = 1;
        }
        return row;
      });

      // 按 paragraph_id 分组到 Map
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.paragraph_id)) map.set(row.paragraph_id, []);
        map.get(row.paragraph_id).push(row);
      }
      return map;
    },

    getByParagraphID: async function (paragraphID) {
      const sql = `
				SELECT * FROM points
				WHERE paragraph_id = ?
				ORDER BY point_idx
			`;

      let rows = [];
      await _connection.queryAsync(sql, [paragraphID], {
        onRow: function (row) {
          const rowObj = {
            point_id: row.getResultByName('point_id'),
            paragraph_id: row.getResultByName('paragraph_id'),
            client_uuid: row.getResultByName('client_uuid'),
            point_idx: row.getResultByName('point_idx'),
            point_summary: row.getResultByName('point_summary'),
            point_translation: row.getResultByName('point_translation'),
            sentence_indices: row.getResultByName('sentence_indices'),
            char_mapping: row.getResultByName('char_mapping'),
            rects: row.getResultByName('rects'),
            importance_level: row.getResultByName('importance_level'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 JSON 字段
      return rows.map((row) => {
        ['sentence_indices', 'char_mapping', 'rects'].forEach((field) => {
          if (row[field]) {
            try {
              row[field] = JSON.parse(row[field]);
            } catch (e) {
              row[field] = null;
            }
          }
        });
        // 确保 importance_level 有默认值
        if (row.importance_level === null || row.importance_level === undefined) {
          row.importance_level = 1;
        }
        return row;
      });
    },

    /**
     * 更新 point 的 importance_level
     * @param {String|Number} pointID - Point ID（可以是数据库 ID 或前端格式 "pageIdx_paragraphIdx_point_pointIdx"）
     * @param {Number} importanceLevel - 重要性等级 (1=普通, 2=重要)
     */
    updateImportanceLevel: async function (pointID, importanceLevel) {
      // 检查是否是前端格式的 ID（如 "0_1_point_2"）
      if (typeof pointID === 'string' && pointID.includes('_point_')) {
        // 解析前端格式：pageIdx_paragraphIdx_point_pointIdx
        const parts = pointID.split('_point_');
        if (parts.length === 2) {
          const [pageParaStr, pointIdxStr] = parts;
          const [pageIdx, paragraphIdx] = pageParaStr.split('_').map(Number);
          const pointIdx = parseInt(pointIdxStr, 10);

          // 通过 page_idx, paragraph_idx, point_idx 定位并更新
          const sql = `
						UPDATE points SET importance_level = ?, sync_dirty = 1
						WHERE paragraph_id IN (
							SELECT paragraph_id FROM paragraphs
							WHERE page_idx = ? AND paragraph_idx = ?
						) AND point_idx = ?
					`;
          await _connection.queryAsync(sql, [importanceLevel, pageIdx, paragraphIdx, pointIdx]);
          const paragraphRow = await _connection.rowQueryAsync(
            'SELECT paragraph_id FROM paragraphs WHERE page_idx = ? AND paragraph_idx = ? ORDER BY paragraph_id DESC LIMIT 1',
            [pageIdx, paragraphIdx]
          );
          Zotero.debug(`[VibeDB.Points] Updated importance_level to ${importanceLevel} for point at page ${pageIdx}, para ${paragraphIdx}, point ${pointIdx}`);
          return;
        }
      }

      // 原有逻辑：直接使用数据库 ID
      const sql = `UPDATE points SET importance_level = ?, sync_dirty = 1 WHERE point_id = ?`;
      await _connection.queryAsync(sql, [importanceLevel, pointID]);
      const paperID = await _getPaperIDByPointID(pointID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'points');
      }
      Zotero.debug(`[VibeDB.Points] Updated importance_level to ${importanceLevel} for point ${pointID}`);
    },

    /**
     * 删除段落的所有 points
     * @param {Number} paragraphID - 段落 ID
     */
    deleteByParagraphID: async function (paragraphID) {
      const sql = `DELETE FROM points WHERE paragraph_id = ?`;
      await _connection.queryAsync(sql, [paragraphID]);
      Zotero.debug(`[VibeDB.Points] Deleted all points for paragraph ${paragraphID}`);
    }
  };

  /**
   * Sentences 表 CRUD
   */
  this.Sentences = {
    /**
     * 批量保存句子
     * @param {Number} paragraphID - 段落 ID
     * @param {Array} sentences - 句子数组
     */
    saveBatch: async function (paragraphID, sentences) {
      if (!sentences || sentences.length === 0) return;
      const sql = `
				INSERT INTO sentences (
					paragraph_id, sentence_idx, sentence_text,
					char_mapping, start_char_offset, end_char_offset, rects, updated_at, sync_dirty, last_synced_revision
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
				ON CONFLICT(paragraph_id, sentence_idx) DO UPDATE SET
					sentence_text = excluded.sentence_text,
					char_mapping = excluded.char_mapping,
					start_char_offset = excluded.start_char_offset,
					end_char_offset = excluded.end_char_offset,
					rects = excluded.rects,
					updated_at = excluded.updated_at,
					sync_dirty = 1
			`;
      await _connection.executeTransaction(async () => {
        for (const sentence of sentences) {
          await _connection.queryAsync(sql, [
          paragraphID,
          sentence.sentence_idx,
          sentence.sentence_text,
          sentence.char_mapping ? JSON.stringify(sentence.char_mapping) : null,
          sentence.start_char_offset,
          sentence.end_char_offset,
          sentence.rects ? JSON.stringify(sentence.rects) : null,
          sentence.updated_at || Math.floor(Date.now() / 1000)]
          );
        }
      });
      const paperID = await _getPaperIDByParagraphID(paragraphID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'sentences');
      }
    },

    // Save sentences for ALL paragraphs of a paper in ONE transaction.
    // paragraphDataArray: [{paragraphID, sentences}]
    saveBatchForPaper: async function (paperID, paragraphDataArray) {
      if (!paragraphDataArray || paragraphDataArray.length === 0) return;
      const sql = `
				INSERT INTO sentences (
					paragraph_id, sentence_idx, sentence_text,
					char_mapping, start_char_offset, end_char_offset, rects, updated_at, sync_dirty, last_synced_revision
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
				ON CONFLICT(paragraph_id, sentence_idx) DO UPDATE SET
					sentence_text = excluded.sentence_text,
					char_mapping = excluded.char_mapping,
					start_char_offset = excluded.start_char_offset,
					end_char_offset = excluded.end_char_offset,
					rects = excluded.rects,
					updated_at = excluded.updated_at,
					sync_dirty = 1
			`;
      await _connection.executeTransaction(async () => {
        for (const { paragraphID, sentences } of paragraphDataArray) {
          for (const sentence of sentences) {
            await _connection.queryAsync(sql, [
            paragraphID,
            sentence.sentence_idx,
            sentence.sentence_text,
            sentence.char_mapping ? JSON.stringify(sentence.char_mapping) : null,
            sentence.start_char_offset,
            sentence.end_char_offset,
            sentence.rects ? JSON.stringify(sentence.rects) : null,
            sentence.updated_at || Math.floor(Date.now() / 1000)]
            );
          }
        }
      });
      await _upsertLocalPaperSyncIndex(paperID, 'sentences');
    },

    /**
     * 获取段落的所有句子
     * @param {Number} paragraphID - 段落 ID
     * @returns {Array}
     */
    /**
     * 批量获取某篇论文下所有段落的 sentences（避免 N+1 查询）
     * 返回结果与逐个调用 getByParagraphID 完全一致，按 paragraph_id 分组到 Map
     */
    getByPaperID: async function (paperID) {
      const sql = `
				SELECT s.* FROM sentences s
				JOIN paragraphs pg ON s.paragraph_id = pg.paragraph_id
				WHERE pg.paper_id = ?
				ORDER BY pg.page_idx, pg.paragraph_idx, s.sentence_idx
			`;

      let rows = [];
      await _connection.queryAsync(sql, [paperID], {
        onRow: function (row) {
          const rowObj = {
            sentence_id: row.getResultByName('sentence_id'),
            paragraph_id: row.getResultByName('paragraph_id'),
            sentence_idx: row.getResultByName('sentence_idx'),
            sentence_text: row.getResultByName('sentence_text'),
            char_mapping: row.getResultByName('char_mapping'),
            start_char_offset: row.getResultByName('start_char_offset'),
            end_char_offset: row.getResultByName('end_char_offset'),
            rects: row.getResultByName('rects'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 JSON 字段（与 getByParagraphID 完全一致）
      rows = rows.map((row) => {
        ['char_mapping', 'rects'].forEach((field) => {
          if (row[field]) {
            try {
              row[field] = JSON.parse(row[field]);
            } catch (e) {
              row[field] = null;
            }
          }
        });
        return row;
      });

      // 按 paragraph_id 分组到 Map
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.paragraph_id)) map.set(row.paragraph_id, []);
        map.get(row.paragraph_id).push(row);
      }
      return map;
    },

    getByParagraphID: async function (paragraphID) {
      const sql = `
				SELECT * FROM sentences
				WHERE paragraph_id = ?
				ORDER BY sentence_idx
			`;

      let rows = [];
      await _connection.queryAsync(sql, [paragraphID], {
        onRow: function (row) {
          const rowObj = {
            sentence_id: row.getResultByName('sentence_id'),
            paragraph_id: row.getResultByName('paragraph_id'),
            sentence_idx: row.getResultByName('sentence_idx'),
            sentence_text: row.getResultByName('sentence_text'),
            char_mapping: row.getResultByName('char_mapping'),
            start_char_offset: row.getResultByName('start_char_offset'),
            end_char_offset: row.getResultByName('end_char_offset'),
            rects: row.getResultByName('rects'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 JSON 字段
      return rows.map((row) => {
        ['char_mapping', 'rects'].forEach((field) => {
          if (row[field]) {
            try {
              row[field] = JSON.parse(row[field]);
            } catch (e) {
              row[field] = null;
            }
          }
        });
        return row;
      });
    }
  };

  /**
   * SummaryCards 表 CRUD（类似 VibeCards）
   */
  this.SummaryCards = {
    /**
     * 保存 SummaryCard
     * @param {Number} itemID - Zotero item ID
     * @param {Object} summaryCard - SummaryCard 数据
     * @param {Object} options - 选项
     * @param {boolean} options.isRemoteTrigger - 是否远端触发（防止回环）
     */
    save: async function (itemID, summaryCard, { isRemoteTrigger = false } = {}) {
      const paper = await Zotero.VibeDB.Papers.get(itemID);
      if (!paper) {
        throw new Error(`[VibeDB] Paper not found for item ${itemID}`);
      }

      // 生成 client_uuid（远端触发时使用传入的值，本地创建时自动生成）
      const clientUuid = summaryCard.client_uuid || Zotero.Utilities.generateObjectKey() + '-' + Date.now();
      const syncState = _getLocalSyncState(isRemoteTrigger, summaryCard.syncRevision);

      const tsExpr = isRemoteTrigger && summaryCard.updatedAt ? '?' : "strftime('%s', 'now')";
      const sql = `
				INSERT INTO summary_cards (
					paper_id, page_idx, paragraph_id, summarycard_name, position_rects, client_uuid, updated_at, sync_dirty, last_synced_revision
				)
				VALUES (?, ?, ?, ?, ?, ?, ${tsExpr}, ?, ?)
				ON CONFLICT(client_uuid) DO UPDATE SET
					page_idx = excluded.page_idx,
					paragraph_id = excluded.paragraph_id,
					summarycard_name = excluded.summarycard_name,
					position_rects = excluded.position_rects,
					updated_at = ${tsExpr},
					sync_dirty = excluded.sync_dirty,
					last_synced_revision = CASE
						WHEN excluded.sync_dirty = 0 THEN excluded.last_synced_revision
						ELSE summary_cards.last_synced_revision
					END
			`;

      const params = [
      paper.paper_id,
      summaryCard.page_idx,
      summaryCard.paragraph_id,
      summaryCard.summarycard_name || null,
      JSON.stringify(summaryCard.position_rects),
      clientUuid];

      if (isRemoteTrigger && summaryCard.updatedAt) {
        params.push(summaryCard.updatedAt); // INSERT
      }
      params.push(syncState.syncDirty, syncState.lastSyncedRevision);
      if (isRemoteTrigger && summaryCard.updatedAt) {
        params.push(summaryCard.updatedAt); // UPDATE
      }

      await _connection.queryAsync(sql, params);
      if (!isRemoteTrigger) {
        await _upsertLocalPaperSyncIndex(paper.paper_id, 'summary_cards');
      }

      // 云同步改为手动触发，不再自动 markDataChanged
    },

    /**
     * 更新 SummaryCard
     * @param {Number} summaryCardID - SummaryCard ID
     * @param {Object} updates - 要更新的字段（只更新提供的字段）
     */
    update: async function (summaryCardID, updates) {
      // 构建动态 SQL，只更新提供的字段
      const setParts = [];
      const params = [];

      if ('summarycard_name' in updates) {
        setParts.push('summarycard_name = ?');
        params.push(updates.summarycard_name || null);
      }

      if ('position_rects' in updates) {
        setParts.push('position_rects = ?');
        // 序列化 position_rects 为 JSON 字符串
        params.push(updates.position_rects !== undefined && updates.position_rects !== null ?
        JSON.stringify(updates.position_rects) :
        null);
      }

      // 拖拽换页时同步更新 page_idx，避免重载后渲染到错误页
      if ('page_idx' in updates && updates.page_idx !== undefined && updates.page_idx !== null) {
        setParts.push('page_idx = ?');
        params.push(updates.page_idx);
      }

      // 如果没有要更新的字段，直接返回
      if (setParts.length === 0) {
        return;
      }

      // 总是更新 updated_at
      setParts.push("updated_at = strftime('%s', 'now')");
      setParts.push('sync_dirty = 1');

      const sql = `
				UPDATE summary_cards
				SET ${setParts.join(', ')}
				WHERE summarycard_id = ?
			`;

      params.push(summaryCardID);

      await _connection.queryAsync(sql, params);
      const paperID = await _getPaperIDBySummaryCardID(summaryCardID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'summary_cards');
      }
    },

    /**
     * 获取论文的所有 SummaryCards
     */
    getByItemID: async function (itemID) {
      const paper = await Zotero.VibeDB.Papers.get(itemID);
      if (!paper) {
        return [];
      }

      const sql = `
		SELECT * FROM summary_cards
		WHERE paper_id = ?
		ORDER BY page_idx
	`;

      let rows = [];
      await _connection.queryAsync(
        sql,
        [paper.paper_id],
        {
          onRow: function (row) {
            const rowObj = {
              summarycard_id: row.getResultByName('summarycard_id'),
              paper_id: row.getResultByName('paper_id'),
              page_idx: row.getResultByName('page_idx'),
              paragraph_id: row.getResultByName('paragraph_id'),
              summarycard_name: row.getResultByName('summarycard_name'),
              position_rects: row.getResultByName('position_rects'),
              client_uuid: row.getResultByName('client_uuid')
            };
            rows.push(rowObj);
          }
        }
      );

      if (rows.length === 0) {
        return [];
      }

      return rows.map((row) => {
        if (row.position_rects) {
          try {
            row.position_rects = JSON.parse(row.position_rects);
          } catch (e) {
            row.position_rects = null;
          }
        }
        return row;
      });
    },

    /**
     * 删除 SummaryCard
     * @param {Number} summaryCardID - SummaryCard ID
     */
    delete: async function (summaryCardID) {
      const sql = `
				DELETE FROM summary_cards
				WHERE summarycard_id = ?
			`;
      await _connection.queryAsync(sql, [summaryCardID]);
      await Zotero.VibeDB.Papers.refreshItemIDCache();
    }
  };

  /**
   * ArticleSummary 表 CRUD
   */
  this.ArticleSummary = {
    /**
     * 批量保存文章总结
     * @param {Number} paperID - 论文 ID
     * @param {Array} summaries - 文章总结数组
     */
    saveBatch: async function (paperID, summaries) {
      const existingRows = await this.getByPaperID(paperID);
      const existingBySortOrder = new Map(existingRows.map((row) => [row.sort_order, row]));
      const persistedUUIDs = [];

      const insertSql = `
				INSERT INTO article_summary (
					paper_id, client_uuid, title, content, sort_order, updated_at, sync_dirty, last_synced_revision
				) VALUES (?, ?, ?, ?, ?, ?, 1, 0)
				ON CONFLICT(client_uuid) DO UPDATE SET
					paper_id = excluded.paper_id,
					title = excluded.title,
					content = excluded.content,
					sort_order = excluded.sort_order,
					updated_at = excluded.updated_at,
					sync_dirty = 1
			`;

      // Pre-compute UUIDs before entering the transaction
      const rowsToInsert = summaries.map((summary) => {
        const sortOrder = summary.sort_order || 0;
        const existing = existingBySortOrder.get(sortOrder);
        const clientUUID = summary.client_uuid || existing && existing.client_uuid || _generateSyncUUID();
        persistedUUIDs.push(clientUUID);
        return [
        paperID,
        clientUUID,
        summary.title,
        summary.content ? JSON.stringify(summary.content) : null,
        sortOrder,
        summary.updated_at || Math.floor(Date.now() / 1000)];

      });

      await _connection.executeTransaction(async () => {
        for (const params of rowsToInsert) {
          await _connection.queryAsync(insertSql, params);
        }
        if (persistedUUIDs.length) {
          const placeholders = persistedUUIDs.map(() => '?').join(', ');
          await _connection.queryAsync(
            `DELETE FROM article_summary WHERE paper_id = ? AND client_uuid NOT IN (${placeholders})`,
            [paperID, ...persistedUUIDs]
          );
        } else
        {
          await _connection.queryAsync('DELETE FROM article_summary WHERE paper_id = ?', [paperID]);
        }
      });
      await _upsertLocalPaperSyncIndex(paperID, 'article_summary');
    },

    /**
     * 根据论文 ID 获取所有文章总结
     * @param {Number} paperID - 论文 ID
     * @returns {Array}
     */
    getByPaperID: async function (paperID) {
      const sql = `
				SELECT * FROM article_summary
				WHERE paper_id = ?
				ORDER BY sort_order
			`;

      let rows = [];
      await _connection.queryAsync(sql, [paperID], {
        onRow: function (row) {
          const rowObj = {
            summary_id: row.getResultByName('summary_id'),
            paper_id: row.getResultByName('paper_id'),
            client_uuid: row.getResultByName('client_uuid'),
            title: row.getResultByName('title'),
            content: row.getResultByName('content'),
            sort_order: row.getResultByName('sort_order'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 content JSON 字段
      return rows.map((row) => {
        if (row.content) {
          try {
            row.content = JSON.parse(row.content);
          } catch (e) {
            console.error('[VibeDB] 解析 article_summary.content 失败:', e);
            row.content = null;
          }
        }
        return row;
      });
    },

    /**
     * 根据 ID 删除文章总结
     * @param {Number} summaryID - 文章总结 ID
     */
    deleteByID: async function (summaryID) {
      const sql = 'DELETE FROM article_summary WHERE summary_id = ?';
      await _connection.queryAsync(sql, [summaryID]);
    },

    /**
     * 更新单个文章总结
     * @param {Number} summaryID - 文章总结 ID
     * @param {Object} updates - 更新的字段 { title?, content? }
     * @returns {Boolean} 是否更新成功
     */
    update: async function (summaryID, updates) {
      // 构建动态 SQL
      const setClauses = [];
      const params = [];

      if (updates.title !== undefined) {
        setClauses.push('title = ?');
        params.push(updates.title);
      }

      if (updates.content !== undefined) {
        setClauses.push('content = ?');
        // content 需要序列化为 JSON
        params.push(updates.content ? JSON.stringify(updates.content) : null);
      }

      if (setClauses.length === 0) {
        console.warn('[VibeDB.ArticleSummary.update] 没有需要更新的字段');
        return false;
      }

      setClauses.push('sync_dirty = 1');
      params.push(summaryID);
      const sql = `UPDATE article_summary SET ${setClauses.join(', ')} WHERE summary_id = ?`;

      await _connection.queryAsync(sql, params);
      const paperID = await _getPaperIDBySummaryID(summaryID);
      if (paperID) {
        await _upsertLocalPaperSyncIndex(paperID, 'article_summary');
      }
      // console.log(`[VibeDB.ArticleSummary] 已更新 summary_id=${summaryID}`);
      return true;
    }
  };

  /**
   * Sections 表 CRUD
   */
  this.Sections = {
    /**
     * 保存章节数据（递归保存）
     * @param {Number} paperID - 论文 ID
     * @param {Object} section - 章节对象
     * @param {Number} parentSectionID - 父章节 ID（可选）
     */
    saveSection: async function (paperID, section, parentSectionID = null) {
      if (!section.client_uuid) {
        section.client_uuid = _generateSyncUUID();
      }
      const normalizedTitleBlockID = _normalizeLocalSectionTitleBlockID(
        section.title_block_id,
        section.client_uuid || `${paperID}:${section.title || ''}:${section.level || 0}:${section.children_order || 0}`
      );

      const sql = `
				INSERT INTO sections (
					paper_id, client_uuid, parent_section_id, title_block_id, level, title, summary, points, children_order, updated_at, sync_dirty, last_synced_revision
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
				ON CONFLICT(paper_id, title_block_id) DO UPDATE SET
					client_uuid = COALESCE(sections.client_uuid, excluded.client_uuid),
					parent_section_id = excluded.parent_section_id,
					level = excluded.level,
					title = excluded.title,
					summary = excluded.summary,
					points = excluded.points,
					children_order = excluded.children_order,
					updated_at = excluded.updated_at,
					sync_dirty = 1
			`;

      const pointsJson = section.points ? JSON.stringify(section.points) : null;

      await _connection.queryAsync(sql, [
      paperID,
      section.client_uuid,
      parentSectionID,
      normalizedTitleBlockID,
      section.level || 0,
      section.title || '',
      section.summary || null,
      pointsJson,
      section.children_order || 0,
      section.updated_at || Math.floor(Date.now() / 1000)]
      );

      // 获取刚插入/更新的章节 ID
      const sectionID = await this.getSectionIDByBlockID(paperID, normalizedTitleBlockID);

      // 递归保存子章节
      if (section.children && section.children.length > 0) {
        for (let i = 0; i < section.children.length; i++) {
          const childSection = section.children[i];
          childSection.children_order = i;
          await this.saveSection(paperID, childSection, sectionID);
        }
      }

      return sectionID;
    },

    /**
     * 批量保存章节（从 sections 对象开始保存）
     * @param {Number} paperID - 论文 ID
     * @param {Object} sectionsRoot - 根章节对象
     */
    saveBatch: async function (paperID, sectionsRoot) {
      const existingRows = [];
      await _connection.queryAsync(
        'SELECT section_id, title_block_id, client_uuid FROM sections WHERE paper_id = ?',
        [paperID],
        {
          onRow: function (row) {
            existingRows.push({
              section_id: row.getResultByName('section_id'),
              title_block_id: row.getResultByName('title_block_id'),
              client_uuid: row.getResultByName('client_uuid')
            });
          }
        }
      );

      const existingByBlockID = new Map(
        existingRows.
        filter((row) => row.title_block_id !== null && row.title_block_id !== undefined).
        map((row) => [row.title_block_id, row])
      );
      const seenBlockIDs = new Set();

      const assignStableUUID = (section) => {
        if (!section || typeof section !== 'object') {
          return;
        }
        if (!section.client_uuid && section.title_block_id !== null && section.title_block_id !== undefined) {
          const normalizedTitleBlockID = _normalizeLocalSectionTitleBlockID(
            section.title_block_id,
            `${paperID}:${section.title || ''}:${section.level || 0}:${section.children_order || 0}`
          );
          const existing = existingByBlockID.get(normalizedTitleBlockID);
          if (existing && existing.client_uuid) {
            section.client_uuid = existing.client_uuid;
          }
        }
        if (!section.client_uuid) {
          section.client_uuid = _generateSyncUUID();
        }
        section.title_block_id = _normalizeLocalSectionTitleBlockID(
          section.title_block_id,
          section.client_uuid || `${paperID}:${section.title || ''}:${section.level || 0}:${section.children_order || 0}`
        );
        seenBlockIDs.add(section.title_block_id);
        for (const child of section.children || []) {
          assignStableUUID(child);
        }
      };

      assignStableUUID(sectionsRoot);
      await this.saveSection(paperID, sectionsRoot, null);

      if (seenBlockIDs.size) {
        const ids = Array.from(seenBlockIDs);
        const placeholders = ids.map(() => '?').join(', ');
        await _connection.queryAsync(
          `DELETE FROM sections
					 WHERE paper_id = ?
					   AND title_block_id IS NOT NULL
					   AND title_block_id NOT IN (${placeholders})`,
          [paperID, ...ids]
        );
      }
      await _upsertLocalPaperSyncIndex(paperID, 'sections');
    },

    /**
     * 根据 title_block_id 获取章节 ID
     * @param {Number} paperID - 论文 ID
     * @param {Number} titleBlockID - 标题块 ID
     * @returns {Number|null}
     */
    getSectionIDByBlockID: async function (paperID, titleBlockID) {
      titleBlockID = _normalizeLocalSectionTitleBlockID(titleBlockID, String(paperID));
      const sql = 'SELECT section_id FROM sections WHERE paper_id = ? AND title_block_id = ?';
      let sectionID = null;

      await _connection.queryAsync(sql, [paperID, titleBlockID], {
        onRow: function (row) {
          sectionID = row.getResultByName('section_id');
        }
      });

      return sectionID;
    },

    /**
     * 递归构建章节树
     * @param {Number} paperID - 论文 ID
     * @param {Number} parentSectionID - 父章节 ID（null 时获取根章节）
     * @returns {Array}
     */
    buildSectionTree: async function (paperID, parentSectionID = null) {
      const sql = `
				SELECT * FROM sections
				WHERE paper_id = ? AND parent_section_id ${parentSectionID ? '= ?' : 'IS NULL'}
				ORDER BY children_order
			`;

      const params = parentSectionID ? [paperID, parentSectionID] : [paperID];
      let rows = [];

      await _connection.queryAsync(sql, params, {
        onRow: function (row) {
          const rowObj = {
            section_id: row.getResultByName('section_id'),
            paper_id: row.getResultByName('paper_id'),
            client_uuid: row.getResultByName('client_uuid'),
            parent_section_id: row.getResultByName('parent_section_id'),
            title_block_id: row.getResultByName('title_block_id'),
            level: row.getResultByName('level'),
            title: row.getResultByName('title'),
            summary: row.getResultByName('summary'),
            points: row.getResultByName('points'),
            children_order: row.getResultByName('children_order'),
            updated_at: row.getResultByName('updated_at')
          };
          rows.push(rowObj);
        }
      });

      // 解析 JSON 字段并递归获取子章节
      const sections = [];
      for (const row of rows) {
        if (row.points) {
          try {
            row.points = JSON.parse(row.points);
          } catch (e) {
            row.points = null;
          }
        }

        // 递归获取子章节
        row.children = await this.buildSectionTree(paperID, row.section_id);
        sections.push(row);
      }

      return sections;
    },

    /**
     * 根据论文 ID 获取完整的章节树
     * @param {Number} paperID - 论文 ID
     * @returns {Object|null}
     */
    getByPaperID: async function (paperID) {
      const sections = await this.buildSectionTree(paperID);
      return sections.length > 0 ? sections[0] : null;
    },

    /**
     * 根据 ID 删除章节（级联删除子章节）
     * @param {Number} sectionID - 章节 ID
     */
    deleteByID: async function (sectionID) {
      // SQLite 的外键约束会自动级联删除子章节
      const sql = 'DELETE FROM sections WHERE section_id = ?';
      await _connection.queryAsync(sql, [sectionID]);
    }
  };

  /**
   * FlashCards 表 CRUD
   */
  this.FlashCards = {
    /**
     * 保存 FlashCard
     * @param {Number} itemID - Zotero item ID
     * @param {Object} flashCard - FlashCard 数据
     * @param {Object} options - 选项
     * @param {boolean} options.isRemoteTrigger - 是否远端触发（防止回环）
     */
    save: async function (itemID, flashCard, { isRemoteTrigger = false } = {}) {
      const paper = await Zotero.VibeDB.Papers.get(itemID);
      if (!paper) {
        throw new Error(`[VibeDB] Paper not found for item ${itemID}`);
      }

      // 生成 client_uuid（远端触发时使用传入的值，本地创建时自动生成）
      const clientUuid = flashCard.client_uuid || Zotero.Utilities.generateObjectKey() + '-' + Date.now();
      const syncState = _getLocalSyncState(isRemoteTrigger, flashCard.syncRevision);

      const tsExpr = isRemoteTrigger && flashCard.updatedAt ? '?' : "strftime('%s', 'now')";
      const sql = `
				INSERT INTO flash_cards (
					paper_id, page_idx, paragraph_id, messages, position_rects, client_uuid, updated_at, sync_dirty, last_synced_revision
				)
				VALUES (?, ?, ?, ?, ?, ?, ${tsExpr}, ?, ?)
				ON CONFLICT(client_uuid) DO UPDATE SET
					messages = excluded.messages,
					position_rects = excluded.position_rects,
					updated_at = ${tsExpr},
					sync_dirty = excluded.sync_dirty,
					last_synced_revision = CASE
						WHEN excluded.sync_dirty = 0 THEN excluded.last_synced_revision
						ELSE flash_cards.last_synced_revision
					END
			`;

      const params = [
      paper.paper_id,
      flashCard.page_idx,
      flashCard.paragraph_id || null,
      JSON.stringify(flashCard.messages),
      JSON.stringify(flashCard.position_rects),
      clientUuid];

      if (isRemoteTrigger && flashCard.updatedAt) {
        params.push(flashCard.updatedAt); // INSERT
      }
      params.push(syncState.syncDirty, syncState.lastSyncedRevision);
      if (isRemoteTrigger && flashCard.updatedAt) {
        params.push(flashCard.updatedAt); // UPDATE
      }

      await _connection.queryAsync(sql, params);
      if (!isRemoteTrigger) {
        await _upsertLocalPaperSyncIndex(paper.paper_id, 'flash_cards');
      }

      // 云同步改为手动触发，不再自动 markDataChanged

      // 通过 SQLite 内置函数获取刚插入行的 rowid
      const lastID = await _connection.valueQueryAsync('SELECT last_insert_rowid()');
      return lastID;
    },

    /**
     * 更新 FlashCard
     */
    update: async function (flashCardID, updates) {
      const sql = `
				UPDATE flash_cards
				SET messages = ?, position_rects = ?, updated_at = strftime('%s', 'now'), sync_dirty = 1
				WHERE flashcard_id = ?
			`;

      await _connection.queryAsync(sql, [
      JSON.stringify(updates.messages),
      JSON.stringify(updates.position_rects),
      flashCardID]
      );
      const row = await _connection.rowQueryAsync('SELECT paper_id FROM flash_cards WHERE flashcard_id = ?', [flashCardID]);
      if (row?.paper_id) {
        await _upsertLocalPaperSyncIndex(row.paper_id, 'flash_cards');
      }
    },

    /**
     * 获取论文的所有 FlashCards
     */
    getByItemID: async function (itemID) {
      const paper = await Zotero.VibeDB.Papers.get(itemID);
      if (!paper) {
        return [];
      }

      const sql = `
		SELECT * FROM flash_cards
		WHERE paper_id = ?
		ORDER BY page_idx, created_at
	`;

      let rows = [];
      await _connection.queryAsync(
        sql,
        [paper.paper_id],
        {
          onRow: function (row) {
            const rowObj = {
              flashcard_id: row.getResultByName('flashcard_id'),
              paper_id: row.getResultByName('paper_id'),
              page_idx: row.getResultByName('page_idx'),
              paragraph_id: row.getResultByName('paragraph_id'),
              messages: row.getResultByName('messages'),
              position_rects: row.getResultByName('position_rects'),
              client_uuid: row.getResultByName('client_uuid'),
              created_at: row.getResultByName('created_at'),
              updated_at: row.getResultByName('updated_at')
            };
            rows.push(rowObj);
          }
        }
      );

      if (rows.length === 0) {
        return [];
      }

      return rows.map((row) => {
        ['messages', 'position_rects'].forEach((field) => {
          if (row[field]) {
            try {
              row[field] = JSON.parse(row[field]);
            } catch (e) {
              row[field] = null;
            }
          }
        });
        return row;
      });
    },

    /**
     * 删除 FlashCard
     */
    delete: async function (flashCardID) {
      console.log('[VibeDB.FlashCards] delete 被调用, flashCardID:', flashCardID);
      console.log('[VibeDB.FlashCards] flashCardID 类型:', typeof flashCardID);

      // 先检查卡片是否存在
      const checkSql = "SELECT flashcard_id FROM flash_cards WHERE flashcard_id = ?";
      let exists = false;
      await _connection.queryAsync(checkSql, [flashCardID], {
        onRow: function (row) {
          exists = true;
          console.log('[VibeDB.FlashCards] 找到要删除的卡片, flashcard_id:', row.getResultByName('flashcard_id'));
        }
      });

      if (!exists) {
        console.warn('[VibeDB.FlashCards] ⚠️ 要删除的卡片不存在, flashCardID:', flashCardID);
        return;
      }

      const sql = "DELETE FROM flash_cards WHERE flashcard_id = ?";
      console.log('[VibeDB.FlashCards] 执行 DELETE SQL, flashCardID:', flashCardID);
      await _connection.queryAsync(sql, [flashCardID]);
      console.log('[VibeDB.FlashCards] ✅ DELETE SQL 执行完成');

      // 验证删除是否成功
      let stillExists = false;
      await _connection.queryAsync(checkSql, [flashCardID], {
        onRow: function (row) {
          stillExists = true;
          console.error('[VibeDB.FlashCards] ❌ 删除后验证失败，卡片仍然存在！flashcard_id:', row.getResultByName('flashcard_id'));
        }
      });

      if (!stillExists) {
        console.log('[VibeDB.FlashCards] ✅ 删除验证成功，卡片已从数据库移除');
      }
    }
  };

  /**
   * AIChats 表 CRUD
   */
  this.AIChats = {
    /**
     * 保存或更新 AI Chat 消息
     * @param {Number} itemID - Zotero item ID
     * @param {Array} messages - 消息数组
     * @param {Object} options - 选项
     * @param {boolean} options.isRemoteTrigger - 是否远端触发（防止回环）
     * @param {Number} options.updatedAt - 云端时间戳（仅远端触发时使用）
     */
    save: async function (itemID, messages, { isRemoteTrigger = false, updatedAt = null, syncRevision = null } = {}) {
      const paper = await Zotero.VibeDB.Papers.ensureRowForItem(itemID);
      const syncState = _getLocalSyncState(isRemoteTrigger, syncRevision);

      const tsExpr = isRemoteTrigger && updatedAt ? '?' : "strftime('%s', 'now')";
      const sql = `
				INSERT INTO ai_chats (paper_id, messages, updated_at, sync_dirty, last_synced_revision)
				VALUES (?, ?, ${tsExpr}, ?, ?)
				ON CONFLICT(paper_id) DO UPDATE SET
					messages = excluded.messages,
					updated_at = ${tsExpr},
					sync_dirty = excluded.sync_dirty,
					last_synced_revision = CASE
						WHEN excluded.sync_dirty = 0 THEN excluded.last_synced_revision
						ELSE ai_chats.last_synced_revision
					END
			`;

      const params = [paper.paper_id, JSON.stringify(messages)];
      if (isRemoteTrigger && updatedAt) {
        params.push(updatedAt); // INSERT
      }
      params.push(syncState.syncDirty, syncState.lastSyncedRevision);
      if (isRemoteTrigger && updatedAt) {
        params.push(updatedAt); // UPDATE
      }

      await _connection.queryAsync(sql, params);
      if (!isRemoteTrigger) {
        await _upsertLocalPaperSyncIndex(paper.paper_id, 'ai_chats');
      }

      // 云同步改为手动触发，不再自动 markDataChanged
    },

    /**
     * 获取 AI Chat 历史
     */
    get: async function (itemID) {
      // 无 papers 行则尚无持久化对话；占位行仅由 save 创建，不在此隐式插入
      const paper = await Zotero.VibeDB.Papers.get(itemID);
      if (!paper) {
        return null;
      }

      const sql = "SELECT * FROM ai_chats WHERE paper_id = ?";
      const row = await _connection.rowQueryAsync(sql, [paper.paper_id]);

      if (!row) {
        return null;
      }

      // 创建新对象返回，避免修改 XPCOM WrappedNative 对象
      const result = {
        aichat_id: row.aichat_id,
        paper_id: row.paper_id,
        messages: [],
        created_at: row.created_at,
        updated_at: row.updated_at
      };

      if (row.messages) {
        try {
          result.messages = JSON.parse(row.messages);
        } catch (e) {
          result.messages = [];
        }
      }

      return result;
    }
  };

  // ==================== 同步辅助方法 ====================

  /**
   * 根据段落记录生成跨设备稳定的 paragraph_key
   * @param {Object} paragraph - 段落记录（需含 minerU_id 或 page_idx + paragraph_idx）
   * @returns {string} paragraph_key
   */
  this.buildParagraphKey = function (paragraph) {
    if (paragraph.minerU_id) {
      return `mineru:${paragraph.minerU_id}`;
    }
    return `pos:${paragraph.page_idx}:${paragraph.paragraph_idx}`;
  };

  /**
   * 根据 paragraph_key 查找本地 paragraph_id
   * @param {Number} paperID - 本地 paper_id
   * @param {string} paragraphKey - paragraph_key
   * @returns {Number|null} paragraph_id
   */
  this.findParagraphByKey = async function (paperID, paragraphKey) {
    if (!paragraphKey) return null;

    if (paragraphKey.startsWith('mineru:')) {
      const minerUId = paragraphKey.slice(7);
      const row = await _connection.rowQueryAsync(
        'SELECT paragraph_id FROM paragraphs WHERE paper_id = ? AND minerU_id = ?',
        [paperID, minerUId]
      );
      return row ? row.paragraph_id : null;
    }

    if (paragraphKey.startsWith('pos:')) {
      const parts = paragraphKey.split(':');
      const pageIdx = parseInt(parts[1]);
      const paragraphIdx = parseInt(parts[2]);
      const row = await _connection.rowQueryAsync(
        'SELECT paragraph_id FROM paragraphs WHERE paper_id = ? AND page_idx = ? AND paragraph_idx = ?',
        [paperID, pageIdx, paragraphIdx]
      );
      return row ? row.paragraph_id : null;
    }

    return null;
  };

  /**
   * 根据本地 paragraph_id 获取 paragraph_key
   * @param {Number} paragraphId - 本地 paragraph_id
   * @returns {string|null} paragraph_key
   */
  this.getParagraphKeyById = async function (paragraphId) {
    if (!paragraphId) return null;
    const row = await _connection.rowQueryAsync(
      'SELECT minerU_id, page_idx, paragraph_idx FROM paragraphs WHERE paragraph_id = ?',
      [paragraphId]
    );
    if (!row) return null;
    return this.buildParagraphKey(row);
  };
}();