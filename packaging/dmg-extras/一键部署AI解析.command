#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  ForPaper「AI 全文解析」一键部署（MinerU 本地服务）
#
#  做什么：
#    1. 安装 uv（Python 包管理器，如已装则跳过）
#    2. 在 ~/mineru/env 创建独立 Python 环境（不影响系统 Python）
#    3. 安装 MinerU（PDF 解析引擎）+ ForPaper 适配层依赖
#    4. 下载解析模型（约 2 GB，仅首次）
#    5. 写入 ForPaper ↔ MinerU 协议适配层 ~/mineru/adapter.py
#    6. 注册开机自启（launchd）并立即启动：
#         127.0.0.1:8003  MinerU 解析后端
#         127.0.0.1:8004  ForPaper 适配层（ForPaper 默认连这个端口）
#
#  全程约 10-30 分钟（取决于网速），只需运行一次。
#  数据不出本机，纯本地解析。
# ═══════════════════════════════════════════════════════════════

set -e

MINERU_DIR="$HOME/mineru"
BACKEND_PORT=8003
ADAPTER_PORT=8004

step() { echo; echo "════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════"; }

clear
echo "ForPaper「AI 全文解析」一键部署"
echo "部署位置: $MINERU_DIR"
echo

step "1/6 检查运行环境"
ARCH="$(uname -m)"
echo "芯片架构: $ARCH（Intel / Apple 芯片均支持，使用 CPU 解析）"
if [ "$(id -u)" -eq 0 ]; then
    echo "❌ 请不要用 sudo 运行本脚本（直接双击即可）"
    exit 1
fi

step "2/6 准备 uv 与 Python 环境"
if command -v uv >/dev/null 2>&1; then
    UV="uv"
elif [ -x "$HOME/.local/bin/uv" ]; then
    UV="$HOME/.local/bin/uv"
else
    echo "安装 uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    UV="$HOME/.local/bin/uv"
fi
echo "uv 版本: $("$UV" --version)"

mkdir -p "$MINERU_DIR"
if [ ! -x "$MINERU_DIR/env/bin/python" ]; then
    "$UV" venv "$MINERU_DIR/env"
fi
PY="$MINERU_DIR/env/bin/python"
echo "Python: $("$PY" --version)"

step "3/6 安装 MinerU 与适配层依赖（约 1-2 GB）"
export VIRTUAL_ENV="$MINERU_DIR/env"
# jieba 0.42.1 源码构建与 setuptools>=77 冲突：先钉老版构建工具，再单独装 jieba
"$UV" pip install "setuptools<77" wheel
"$UV" pip install --no-build-isolation "jieba==0.42.1" 2>/dev/null || "$UV" pip install "jieba==0.42.1"
"$UV" pip install "mineru[pipeline]" --index-url https://pypi.tuna.tsinghua.edu.cn/simple
"$UV" pip install fastapi uvicorn httpx

step "4/6 下载解析模型（约 2 GB，仅首次需要）"
env -u PYTHONPATH "$MINERU_DIR/env/bin/mineru-models-download" --tier basic --small-backend torch -s modelscope

step "5/6 写入 ForPaper 适配层 adapter.py"
cat > "$MINERU_DIR/adapter.py" <<'PYEOF'
#!/usr/bin/env python3
"""
ForPaper ↔ MinerU v4 适配层
把 ForPaper 期待的老接口 POST /file_parse (multipart files 字段, ZIP 响应)
翻译成 MinerU 4.x 的新 REST 工作流:
  POST /v1/uploads → PUT 上传 → POST /v1/uploads/{id}/complete
  → POST /v1/parse/jobs → 轮询 → 下载 markdown/middle_json/structured_content
  → 打包成 ZIP（顶层目录 = PDF 文件名），返回 application/zip

用法: python3 adapter.py [port]   (默认 8003 后端 → 本服务监听 8004)
"""
import hashlib
import io
import json
import os
import shutil
import sys
import time
import zipfile
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

BACKEND = os.environ.get("MINERU_BACKEND", "http://127.0.0.1:8003")
TIER = os.environ.get("MINERU_TIER", "basic")

app = FastAPI(title="ForPaper-MinerU Adapter")


def _job_source_upload(client: httpx.Client, filename: str, content: bytes, mime: str):
    """上传文件到 v4 后端，返回 {type: file_id, file_id: ...}"""
    r = client.post(
        f"{BACKEND}/v1/uploads",
        json={
            "filename": filename,
            "bytes": len(content),
            "mime_type": mime,
            "purpose": "parse",
        },
        timeout=30,
    )
    r.raise_for_status()
    up = r.json()
    upload_id = up["id"]

    # upload_url 存在则 PUT 直传（Content-Type 必须是 octet-stream，v4 服务端校验）
    if up.get("upload_url"):
        pr = client.put(up["upload_url"], content=content, timeout=120)
        pr.raise_for_status()
    else:
        pr = client.put(
            f"{BACKEND}/v1/uploads/{upload_id}/content",
            content=content,
            headers={"Content-Type": "application/octet-stream"},
            timeout=120,
        )
        pr.raise_for_status()

    cr = client.post(
        f"{BACKEND}/v1/uploads/{upload_id}/complete",
        json={},
        timeout=60,
    )
    cr.raise_for_status()
    cdata = cr.json()
    file_id = (cdata.get("file") or {}).get("id") or cdata.get("file_id")
    if not file_id:
        raise HTTPException(500, f"complete 未返回 file_id: {cdata}")
    return {"type": "file_id", "file_id": file_id}


def _download_output(client: httpx.Client, ref: dict, dest_dir: str, name: str):
    """从 OutputFileRef 下载产物到 dest_dir/name
    v4 的 ref 是 {file_id, bytes}，下载端点是 GET /v1/files/{file_id}/content
    """
    file_id = ref.get("file_id")
    url = ref.get("url") or ref.get("download_url")
    if not url:
        if not file_id:
            raise HTTPException(500, f"产物 {name} 无 file_id 也没有 url: {ref}")
        url = f"{BACKEND}/v1/files/{file_id}/content"
    if url.startswith("/"):
        url = f"{BACKEND}{url}"
    rr = client.get(url, timeout=180)
    rr.raise_for_status()
    with open(os.path.join(dest_dir, name), "wb") as f:
        f.write(rr.content)
    return len(rr.content)


def _flatten_structured_content(data: dict) -> list:
    """v4 structured_content 是 {"pages":[{page_idx, blocks:[...]}]} 嵌套结构，
    ForPaper (pdfParser.js) 要求顶层数组、每项自带 page_idx。展平：
      页级 blocks 提出来，每块补 page_idx。
    """
    out = []
    for page in data.get("pages", []):
        pidx = page.get("page_idx", 0)
        for block in page.get("blocks", []):
            item = dict(block)
            item.setdefault("page_idx", pidx)
            out.append(item)
    return out


@app.get("/health")
def health():
    try:
        with httpx.Client() as c:
            r = c.get(f"{BACKEND}/v1/health", timeout=5)
            return {"status": "ok", "backend": BACKEND, "backend_health": r.json()}
    except Exception as e:
        return {"status": "degraded", "backend": BACKEND, "error": str(e)}


@app.post("/file_parse")
async def file_parse(
    files: UploadFile = File(...),
    backend: str = Form(None),
    parse_method: str = Form("auto"),
    return_md: str = Form("true"),
    return_middle_json: str = Form("true"),
    return_content_list: str = Form("true"),
    return_images: str = Form("true"),
    response_format_zip: str = Form("true"),
):
    pdf_bytes = await files.read()
    filename = files.filename or "document.pdf"
    t0 = time.time()

    with httpx.Client() as client:
        # 1. 上传
        source = _job_source_upload(client, filename, pdf_bytes, "application/pdf")

        # 2. 提交任务
        jr = client.post(
            f"{BACKEND}/v1/parse/jobs",
            json={
                "files": [{"source": source}],
                "tier": TIER,
                "output_formats": ["markdown", "middle_json", "structured_content"],
            },
            timeout=30,
        )
        jr.raise_for_status()
        job = jr.json()
        job_id = job["job_id"]

        # 3. 轮询（ForPaper 侧有自己的轮询 UI，这里同步等待完成）
        #    注意：首次解析时后端要加载全部模型（可能阻塞 1-2 分钟），轮询超时必须放宽
        deadline = time.time() + 1800  # 30 分钟上限
        while True:
            try:
                pr = client.get(f"{BACKEND}/v1/parse/jobs/{job_id}", timeout=120)
                pr.raise_for_status()
            except httpx.ReadTimeout:
                if time.time() > deadline:
                    raise HTTPException(504, "解析超时（30 分钟）")
                time.sleep(3)
                continue
            st = pr.json()
            status = st.get("status")
            if status in ("succeeded", "completed", "done", "failed", "error", "canceled"):
                break
            if time.time() > deadline:
                raise HTTPException(504, "解析超时（30 分钟）")
            time.sleep(2)

        if status not in ("succeeded", "completed", "done"):
            err = None
            for fr in st.get("files", []):
                if fr.get("error"):
                    err = fr["error"]
                    break
            raise HTTPException(500, f"任务 {status}: {err or st}")

        # 4. 下载产物打包 ZIP（顶层目录 = PDF 主名）
        stem = os.path.splitext(filename)[0]
        tmp_dir = f"/tmp/mineru_adapter_{int(time.time()*1000)}"
        os.makedirs(tmp_dir, exist_ok=True)
        out_dir = os.path.join(tmp_dir, stem)
        os.makedirs(out_dir, exist_ok=True)

        downloaded = []
        for fr in st.get("files", []):
            outputs = fr.get("output_files") or {}
            # 先下 markdown / middle_json 原样保存
            for fmt, fname in (("markdown", f"{stem}.md"), ("middle_json", f"{stem}_middle.json")):
                ref = outputs.get(fmt)
                if ref:
                    _download_output(client, ref, out_dir, fname)
                    downloaded.append(fname)
            # structured_content → 展平成顶层数组，文件名必须以 content_list.json 结尾
            # （ForPaper pdfParser.js 用 endsWith("content_list.json") 匹配 + Array.isArray 校验）
            ref = outputs.get("structured_content")
            if ref:
                raw_path = os.path.join(out_dir, "_sc_raw.json")
                _download_output(client, ref, out_dir, "_sc_raw.json")
                with open(raw_path, "r", encoding="utf-8") as f:
                    sc = json.load(f)
                flat = _flatten_structured_content(sc)
                cl_name = f"{stem}_content_list.json"
                with open(os.path.join(out_dir, cl_name), "w", encoding="utf-8") as f:
                    json.dump(flat, f, ensure_ascii=False)
                os.remove(raw_path)
                downloaded.append(cl_name)

        if not downloaded:
            raise HTTPException(500, f"任务成功但无产物: {st.get('files')}")

        # 5. 打 ZIP
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _, fs in os.walk(tmp_dir):
                for fn in fs:
                    full = os.path.join(root, fn)
                    zf.write(full, os.path.relpath(full, tmp_dir))
        buf.seek(0)
        shutil.rmtree(tmp_dir, ignore_errors=True)

        dur = round(time.time() - t0, 1)
        print(f"[adapter] {filename} 解析完成 {dur}s 产物: {downloaded}")

        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{stem}_mineru.zip"',
                "X-Parse-Duration": str(dur),
            },
        )


if __name__ == "__main__":
    import uvicorn

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8004
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
PYEOF
echo "适配层已写入: $MINERU_DIR/adapter.py"

step "6/6 注册开机自启并启动服务"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR"

# 后端（8003）
cat > "$AGENTS_DIR/com.forpaper.mineru.backend.plist" <<PLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.forpaper.mineru.backend</string>
  <key>ProgramArguments</key>
  <array>
    <string>$MINERU_DIR/env/bin/mineru-api</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$BACKEND_PORT</string>
    <string>--tier</string><string>basic</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$MINERU_DIR/backend.log</string>
  <key>StandardErrorPath</key><string>$MINERU_DIR/backend.log</string>
</dict>
</plist>
PLEOF

# 适配层（8004）
cat > "$AGENTS_DIR/com.forpaper.mineru.adapter.plist" <<PLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.forpaper.mineru.adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>$MINERU_DIR/env/bin/python</string>
    <string>$MINERU_DIR/adapter.py</string>
    <string>$ADAPTER_PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$MINERU_DIR/adapter.log</string>
  <key>StandardErrorPath</key><string>$MINERU_DIR/adapter.log</string>
</dict>
</plist>
PLEOF

UID_NUM="$(id -u)"
for SVC in backend adapter; do
    launchctl bootout "gui/$UID_NUM/com.forpaper.mineru.$SVC" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/com.forpaper.mineru.$SVC.plist"
done

echo "等待服务启动（后端首次加载模型可能需要 1-2 分钟）..."
sleep 8
for i in 1 2 3 4 5 6; do
    if curl -sf "http://127.0.0.1:$ADAPTER_PORT/health" >/dev/null 2>&1; then
        break
    fi
    sleep 10
done

echo
if curl -s "http://127.0.0.1:$ADAPTER_PORT/health" | grep -q '"status"'; then
    echo "✅ 部署完成！服务状态："
    curl -s "http://127.0.0.1:$ADAPTER_PORT/health"
    echo
    echo
    echo "现在打开 ForPaper，点文献的「AI 解析 PDF」即可使用全文解析。"
    echo "（ForPaper 默认连接 127.0.0.1:$ADAPTER_PORT，无需任何设置）"
else
    echo "⚠️ 服务尚未就绪。后端首次启动需加载模型，请 1-2 分钟后执行："
    echo "   curl http://127.0.0.1:$ADAPTER_PORT/health"
    echo "   日志查看：tail -f $MINERU_DIR/backend.log $MINERU_DIR/adapter.log"
fi

echo
echo "卸载方法："
echo "  launchctl bootout gui/\$(id -u)/com.forpaper.mineru.backend"
echo "  launchctl bootout gui/\$(id -u)/com.forpaper.mineru.adapter"
echo "  rm -rf ~/mineru ~/Library/LaunchAgents/com.forpaper.mineru.*.plist"
echo
read -n 1 -s -r -p "按任意键关闭窗口..."
