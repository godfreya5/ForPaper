/*
	***** BEGIN LICENSE BLOCK *****
	Simple local SQLite for OSS: per-item AI chat JSON + full-text summary.
	***** END LICENSE BLOCK *****
*/

'use strict';

Zotero.PaperAiDB = new function () {
	const SCHEMA_TYPE = 'paperai';
	const SCHEMA_VERSION = 1;

	let _connection = null;
	let _initDeferred = Zotero.Promise.defer();
	this.initPromise = _initDeferred.promise;

	this.init = async function () {
		if (_connection) {
			_initDeferred.resolve(true);
			return _connection;
		}
		try {
			_connection = new Zotero.DBConnection('paperAi');
			await _connection.test();
			await _ensureSchema();
			_initDeferred.resolve(true);
			Zotero.debug('[PaperAiDB] initialized');
			return _connection;
		}
		catch (e) {
			Zotero.logError(e);
			_initDeferred.reject(e);
			throw e;
		}
	};

	async function _ensureSchema() {
		const ver = await _getVersion();
		if (ver === null) {
			await _connection.queryAsync(
				`CREATE TABLE IF NOT EXISTS version (
					schema TEXT PRIMARY KEY,
					version INTEGER NOT NULL
				)`
			);
			await _connection.queryAsync(
				`CREATE TABLE IF NOT EXISTS paper_ai_store (
					item_id INTEGER PRIMARY KEY,
					full_summary TEXT,
					chat_messages TEXT NOT NULL DEFAULT '[]',
					github_url TEXT,
					updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
				)`
			);
			await _connection.queryAsync(
				'INSERT INTO version (schema, version) VALUES (?, ?)',
				[SCHEMA_TYPE, SCHEMA_VERSION]
			);
			return;
		}
		if (ver !== SCHEMA_VERSION) {
			Zotero.debug('[PaperAiDB] unexpected version ' + ver + ', expected ' + SCHEMA_VERSION);
		}
	}

	async function _getVersion() {
		try {
			const exists = await _connection.tableExists('version');
			if (!exists) {
				return null;
			}
			const v = await _connection.valueQueryAsync(
				'SELECT version FROM version WHERE schema = ?',
				[SCHEMA_TYPE]
			);
			return v != null ? parseInt(v, 10) : null;
		}
		catch (e) {
			return null;
		}
	}

	this.saveChatMessages = async function (itemId, messagesArray) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return;
		}
		const json = JSON.stringify(messagesArray || []);
		await _connection.queryAsync(
			`INSERT INTO paper_ai_store (item_id, chat_messages, updated_at)
			VALUES (?, ?, strftime('%s', 'now'))
			ON CONFLICT(item_id) DO UPDATE SET
				chat_messages = excluded.chat_messages,
				updated_at = excluded.updated_at`
			, [id, json]
		);
	};

	this.getChatMessages = async function (itemId) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return { messages: [] };
		}
		const row = await _connection.rowQueryAsync(
			'SELECT chat_messages FROM paper_ai_store WHERE item_id = ?',
			[id]
		);
		if (!row || !row.chat_messages) {
			return { messages: [] };
		}
		try {
			const messages = JSON.parse(row.chat_messages);
			return { messages: Array.isArray(messages) ? messages : [] };
		}
		catch (_e) {
			return { messages: [] };
		}
	};

	this.saveFullSummary = async function (itemId, text) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return;
		}
		const t = text == null ? '' : String(text);
		await _connection.queryAsync(
			`INSERT INTO paper_ai_store (item_id, full_summary, chat_messages, updated_at)
			VALUES (?, ?, '[]', strftime('%s', 'now'))
			ON CONFLICT(item_id) DO UPDATE SET
				full_summary = excluded.full_summary,
				updated_at = excluded.updated_at`
			, [id, t]
		);
	};

	this.getFullSummary = async function (itemId) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return '';
		}
		const row = await _connection.rowQueryAsync(
			'SELECT full_summary FROM paper_ai_store WHERE item_id = ?',
			[id]
		);
		return row && row.full_summary != null ? String(row.full_summary) : '';
	};

	this.setGitHubUrl = async function (itemId, url) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return;
		}
		const u = url == null ? '' : String(url);
		await _connection.queryAsync(
			`INSERT INTO paper_ai_store (item_id, chat_messages, github_url, updated_at)
			VALUES (?, '[]', ?, strftime('%s', 'now'))
			ON CONFLICT(item_id) DO UPDATE SET
				github_url = excluded.github_url,
				updated_at = excluded.updated_at`
			, [id, u]
		);
	};

	this.getGitHubUrl = async function (itemId) {
		await this.init();
		const id = parseInt(itemId, 10);
		if (!Number.isFinite(id)) {
			return null;
		}
		const row = await _connection.rowQueryAsync(
			'SELECT github_url FROM paper_ai_store WHERE item_id = ?',
			[id]
		);
		if (!row || !row.github_url) {
			return null;
		}
		return String(row.github_url);
	};

	this.close = async function () {
		if (_connection) {
			try {
				await _connection.closeDatabase();
			}
			catch (_e) {}
			_connection = null;
		}
	};
};

/** 兼容 ai-chat / contextPane：轻量外观，底层为 PaperAiDB */
Zotero.VibeDB = {
	get schemaUpdatePromise() {
		return Zotero.PaperAiDB.initPromise;
	},
	Papers: {
		updateGitHubUrl: async (itemID, githubUrl) => {
			await Zotero.PaperAiDB.setGitHubUrl(itemID, githubUrl);
		},
		getGitHubUrl: async (itemID) => Zotero.PaperAiDB.getGitHubUrl(itemID),
	},
	AIChats: {
		save: async (itemId, messages) => Zotero.PaperAiDB.saveChatMessages(itemId, messages),
		get: async (itemId) => Zotero.PaperAiDB.getChatMessages(itemId),
	},
};

/** 开源版：无云端账号，供 ai-chat 跳过登录 / 扣费校验 */
Zotero.VibeDBSync = new function () {
	this.PRICING = { PAGE: 0, CHAT: 0 };

	this.ensureLoggedIn = function () {
		return true;
	};

	this.getUserBalance = async function () {
		return {
			credits: 999999,
			subscription_info: { status: 'active', plan_tier: 'ULTIMATE' },
		};
	};

	this.deductCredits = async function () {
		return true;
	};

	this.getAccessToken = async function () {
		return null;
	};

	this.clearUser = function () {};
};

Zotero.addShutdownListener(() => {
	Zotero.PaperAiDB.close().catch((e) => Zotero.logError(e));
});
