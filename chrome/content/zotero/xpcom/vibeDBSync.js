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
 * VibeDB 同步管理器 —— 开源版（无云端账号）
 *
 * 本文件是本地构建的“免登录 / 免扣费”外观层（facade）：
 * - 保留商业版全部调用面（21 处 ensureLoggedIn / 13 处 handleAuthInvalid /
 *   12 处 getAccessToken / 12 处 clearUser / 4 处 getSupabaseConfig / …），
 *   使 reader.js、pdfParsing、ai-chat 等模块无需改动即可在本地自由使用。
 * - 不连接任何远程账号 / 订阅 / 计费服务；所有余额为本地无限，订阅恒为 ULTIMATE。
 * - 云同步相关方法（原 vibeDBCloudSync 的入口）全部为 no-op。
 *
 * 若你需要自建代理（AI Chat 预设模型 / MinerU 云端解析），参见 README 的
 * “自建后端”章节；相关端点可通过 prefs 覆盖，默认留空。
 */

Zotero.VibeDBSync = new function () {
	// ---------- 余额 / 计费（本地无限，不与任何服务器交互） ----------
	// PAGE 保留字段：reader.js 的 _checkBalance 用 pricing.PAGE 计算展示用“预计消耗”，
	// 与扣费无关（开源版不扣费）。设为 0 表示本地解析免费。
	this.PRICING = { PAGE: 0, CHAT: 0 };

	// ---------- 配置（供 ai-chat / MinerU 读取端点；默认为空，不指向任何服务器） ----------
	// 可通过 prefs 覆盖：
	//   extensions.zotero.vibeProxy.baseUrl      自建 Supabase 兼容网关（cn）
	//   extensions.zotero.vibeProxy.anonKey      网关 anon key
	this.getSupabaseConfig = function () {
		let url = '';
		let anonKey = '';
		try {
			url = String(Zotero.Prefs.get('vibeProxy.baseUrl') || '');
			anonKey = String(Zotero.Prefs.get('vibeProxy.anonKey') || '');
		}
		catch (e) {}
		return { url, anonKey };
	};

	// ---------- 登录态（恒“已登录”的本地身份） ----------
	this._currentUser = { id: 'local-user', email: 'local@vibero' };
	this._supabaseSession = null;

	this.init = async function () {
		Zotero.debug('[VibeDBSync] OSS build: local mode, no cloud account');
		return true;
	};

	this.isLoggedIn = function () {
		return true; // 开源版：无云账号概念，但 reader 的解析/大纲入口以“已登录”放行
	};

	this.ensureLoggedIn = function () {
		return true; // 所有功能本地可用，永不弹登录
	};

	this.getCurrentUser = function () {
		return this._currentUser;
	};

	this.getAccessToken = async function () {
		return null; // 不携带任何远程 JWT；自建网关时也无需客户端 token
	};

	this.getUserBalance = async function () {
		return {
			credits: 999999999,
			subscription_info: { status: 'active', plan_tier: 'ULTIMATE' },
			user_balance: { credits: 999999999 },
			subscription_check_reset: { skipped: 'oss' }
		};
	};

	this.deductCredits = async function () {
		return true; // 本地不扣费
	};

	this.logUsage = async function () {
		return true;
	};

	// ---------- 会话 / 失效处理（no-op） ----------
	this.clearUser = function () {};

	this.saveSupabaseSession = function () {};

	this.loadSupabaseSession = this._loadSessionFromPrefs = function () {
		return null;
	};

	this.handleAuthInvalid = function () {}; // 旧版收到 401 会清会话并弹登录；开源版无事可做

	this.isTokenFromCurrentProject = function () {
		return true;
	};

	this.isSessionFromCurrentProject = function () {
		return true;
	};

	this.notifyAuthStatusChanged = function () {};

	this.debugExpireToken = function () {};

	this.refreshRunnerState = function () {};

	// ---------- 云同步入口（开源版禁用；保留签名避免调用方报错） ----------
	this.openLoginPanel = function () {
		Zotero.debug('[VibeDBSync] OSS build: cloud sync disabled');
	};

	this.enableSync = this.disableSync = async function () {
		return false;
	};
};
