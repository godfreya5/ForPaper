<div align="center">

<img src="./assets/vibero-logo.png" width="132" alt="ForPaper logo"/>

# ForPaper

<p>
  <a href="https://github.com/chenyu-xjtu/Vibero/stargazers"><img src="https://img.shields.io/github/stars/chenyu-xjtu/Vibero?style=for-the-badge&logo=github&color=ffc107&label=Stars" alt="GitHub Stars"/></a>
  <a href="https://github.com/chenyu-xjtu/Vibero/network/members"><img src="https://img.shields.io/github/forks/chenyu-xjtu/Vibero?style=for-the-badge&logo=github&color=0891b2&label=Forks" alt="GitHub Forks"/></a>
  <a href="https://github.com/chenyu-xjtu/Vibero/releases/tag/vibero-latest"><img src="https://img.shields.io/badge/Release-vibero--latest-7c3aed?style=for-the-badge&logo=github" alt="Latest release tag"/></a>
</p>

<p>
  <a href="https://vibero.dev"><img src="https://img.shields.io/badge/website-vibero.dev-0f172a?style=for-the-badge" alt="Website"/></a>
  <a href="https://github.com/chenyu-xjtu/Vibero/releases/tag/vibero-latest"><img src="https://img.shields.io/badge/download-GitHub_Release-2563eb?style=for-the-badge&logo=github" alt="Download"/></a>
</p>

</div>

---

## ✨ Redirect your attention — faster, yet deeper ✨📚

---

## 🌐 Website

👉 **[https://vibero.dev](https://vibero.dev)**

---

## 📦 Full installers

Latest offline packages: **[vibero-latest](https://github.com/chenyu-xjtu/Vibero/releases/tag/vibero-latest)**

| Platform | Download |
| --- | --- |
| 🍎 **macOS** | **[Vibero-mac.zip](https://github.com/chenyu-xjtu/Vibero/releases/download/vibero-latest/Vibero-mac.zip)** |
| 🪟 **Windows (x64)** | **[Vibero-win-x64.zip](https://github.com/chenyu-xjtu/Vibero/releases/download/vibero-latest/Vibero-win-x64.zip)** |

---

## 🗺️ Roadmap (living document)

> This roadmap will keep evolving. ⏳

### ✅ Shipped

- 💬 **AI chat**
- 📄 **Full-document summary**
- 🧑‍💻 **Collaborative code reading**

### 🚧 Planned / TODO

- 📌 **Paragraph summaries**
- 🖱️ **Draggable chat / layout**
- ✨ **More reading-centric AI features**

---

## 🛠️ Local development

See the official [source code guide](https://www.zotero.org/support/dev/source_code) for dependencies and environment (Node, Firefox/XULRunner, etc.).

### `./app/scripts/build_and_run`

Build from source and launch Zotero from the staging directory (the script picks the right binary on macOS / Linux / Windows).

```bash
./app/scripts/build_and_run -r
```

- **`-r`** 🧱: Run a full JS build (`npm run build`, etc.) before launch; **use on first clone or when you change non-reader JS**
- Without `-r`: Launch only (expects existing build artifacts)
- **`-b`**: `-ZoteroSkipBundledFiles`; **`-d`**: attach JS debugger (see script comments)
- Optional **`ZOTERO_PROFILE`**: profile directory to use

### `./build_reader_dev.sh`

Builds only the **reader** `zotero` webpack target and copies output to `build/resource/reader/`—handy when iterating on the PDF reader UI instead of a full build; the script ends by running **`./app/scripts/build_and_run -r`**.

```bash
./build_reader_dev.sh
```

For **ai-chat** and other frontends, run `npm run build` in the relevant subfolder, or use **`./app/scripts/build_and_run -r`** for a full build.

The DeepWiki shell is in place; wire up your own **DeepWiki proxy** to use it 🔗

## 🧩 Open-source edition

This tree is the **open-source edition** of ForPaper: it contains **no account system, no subscription tiers, and no credit-based billing**. Everything runs locally — the login/subscription/balance checks in the codebase are pass-through stubs (`Zotero.VibeDBSync` in `chrome/content/zotero/xpcom/vibeDBSync.js`) that always report "logged in / unlimited balance", so all AI features work without any server.

Two commercial-only pieces were removed:

- **Cloud item sync** (`vibeDBCloudSync.js`, Supabase-backed) — removed along with its account panel
- **Managed AI gateway & preset models** — the hardcoded proxy endpoints, bundled API keys, and all built-in preset models are gone. AI chat works exclusively with **your own model API** (see below)

### Bring-your-own model API

The chat panel has **no preset models**. You configure your own provider — OpenAI-compatible or Anthropic format — directly in the UI:

1. Open any PDF → **AI 聊天** panel
2. Click the model menu (bottom-left of the input box) → **管理自定义模型**
3. Fill in **Base URL** (e.g. `https://api.openai.com/v1`, or any compatible endpoint — DeepSeek, Kimi, Qwen, OpenRouter, a local Ollama, …), your **API Key**, and the **model name**
4. Save and select the configuration — done

Keys are stored locally in Zotero prefs and are never sent anywhere except the endpoint you configured.

Other self-hostable endpoints (Zotero prefs via `about:config`):

| Pref | Purpose | Default |
|---|---|---|
| `extensions.zotero.vibeProxy.mineruLocalUrl` | Local MinerU FastAPI endpoint for PDF parsing | `http://127.0.0.1:8000/file_parse` |
| `extensions.zotero.vibeProxy.deepwikiUrl` | Your DeepWiki proxy (Cloudflare Worker or compatible) | *(empty)* |

### Local PDF parsing (MinerU)

PDF parsing defaults to **local mode**: it expects a self-hosted [MinerU](https://github.com/opendatalab/MinerU) FastAPI server at `vibeProxy.mineruLocalUrl` (default `http://127.0.0.1:8000/file_parse`). Cloud parsing code is retained for self-hosters who wire their own endpoint; it is simply no longer used by default.

### Frontend bundles

`ai-chat/` and `code-pane/` are self-contained React apps. After editing their sources, rebuild with:

```bash
cd ai-chat && npm install && npm run build   # → chrome/content/zotero/ai-chat/ai-chat-bundle.js
cd code-pane && npm install && npm run build # → chrome/content/zotero/code-pane/code-pane-bundle.js
```

## 🥰 Acknowledgements
**Built With**
**[Zotero](https://github.com/zotero/zotero)**
