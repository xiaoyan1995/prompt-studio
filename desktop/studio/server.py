#!/usr/bin/env python3
"""
Prompt Studio local server.
Usage:  python server.py
Then open:  http://127.0.0.1:8768/
"""
import base64, html, json, mimetypes, os, re, socket, sys, tempfile, threading, time, urllib.request, urllib.error, uuid, zipfile, hashlib, difflib
from urllib.parse import unquote, urljoin, parse_qs, quote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import shutil

# ── SSE broadcast registry ────────────────────────────────────────────────────
_sse_lock    = threading.Lock()
_sse_clients = []   # list of queue.Queue
import queue

def _sse_notify(event="data-changed", data="1"):
    msg = f"event: {event}\ndata: {data}\n\n".encode()
    with _sse_lock:
        dead = []
        for q in _sse_clients:
            try: q.put_nowait(msg)
            except: dead.append(q)
        for q in dead: _sse_clients.remove(q)

if os.environ.get("PROMPT_STUDIO_STATIC_DIR"):
    BASE_DIR = Path(os.environ["PROMPT_STUDIO_STATIC_DIR"]).resolve()
elif getattr(sys, "frozen", False):
    BASE_DIR = Path.cwd().resolve()
else:
    BASE_DIR = Path(__file__).resolve().parent
_STUDIO_CONFIG_FILE = BASE_DIR / "studio-config.json"
def _load_studio_config():
    try:
        return json.loads(_STUDIO_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
_studio_cfg = _load_studio_config()
_env_data_dir = os.environ.get("PROMPT_STUDIO_DATA_DIR")
_cfg_data_dir = _studio_cfg.get("data_dir")
def _resolve_data_dir():
    raw = _env_data_dir or _cfg_data_dir
    if not raw:
        return BASE_DIR
    p = Path(raw)
    return (BASE_DIR / p).resolve() if not p.is_absolute() else p.resolve()


_data_file_lock = threading.RLock()


class _AtomicDataFile(os.PathLike):
    def __init__(self, path):
        self._path = Path(path)

    def __fspath__(self):
        return os.fspath(self._path)

    def __str__(self):
        return str(self._path)

    def __getattr__(self, name):
        return getattr(self._path, name)

    def read_text(self, *args, **kwargs):
        with _data_file_lock:
            return self._path.read_text(*args, **kwargs)

    def write_text(self, data, *args, **kwargs):
        with _data_file_lock:
            temp_path = self._path.with_name(f".{self._path.name}.{uuid.uuid4().hex}.tmp")
            try:
                written = temp_path.write_text(data, *args, **kwargs)
                os.replace(temp_path, self._path)
                return written
            finally:
                temp_path.unlink(missing_ok=True)


DATA_DIR   = _resolve_data_dir()
DATA_FILE  = _AtomicDataFile(DATA_DIR / "data.json")
UPLOAD_DIR = DATA_DIR / "uploads"
CONFIG_FILE = DATA_DIR / "desktop_settings.json"
EXPORT_DIR = DATA_DIR / "exports"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
SMART_FOLDERS_FILE = DATA_DIR / "smart_folders.json"
PORT       = 8768

LOOPBACK_CORS_HOSTS = {"localhost", "127.0.0.1", "::1"}
EXTRA_TRUSTED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("PROMPT_STUDIO_TRUSTED_ORIGINS", "").split(",")
    if origin.strip()
}
SECURITY_EVENTS = []
SECURITY_EVENTS_LOCK = threading.Lock()

# ── ffmpeg on-demand ──────────────────────────────────────────────────────────
FFMPEG_TOOLS_DIR = DATA_DIR / "tools"
FFMPEG_EXE       = FFMPEG_TOOLS_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFMPEG_DL_URL    = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
_ffmpeg_install  = {"status": "idle", "percent": 0, "error": ""}

def find_ffmpeg():
    if FFMPEG_EXE.exists():
        return str(FFMPEG_EXE)
    return shutil.which("ffmpeg")

def _do_install_ffmpeg():
    global _ffmpeg_install
    try:
        FFMPEG_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        zip_path = FFMPEG_TOOLS_DIR / "ffmpeg_dl.zip"
        _ffmpeg_install = {"status": "downloading", "percent": 0, "error": ""}

        def _hook(count, block, total):
            if total > 0:
                _ffmpeg_install["percent"] = min(88, int(count * block * 88 / total))

        urllib.request.urlretrieve(FFMPEG_DL_URL, str(zip_path), _hook)
        _ffmpeg_install = {"status": "extracting", "percent": 92, "error": ""}

        with zipfile.ZipFile(zip_path) as zf:
            target_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
            for name in zf.namelist():
                if name.split("/")[-1] == target_name and "/bin/" in name:
                    FFMPEG_EXE.write_bytes(zf.read(name))
                    if os.name != "nt":
                        FFMPEG_EXE.chmod(0o755)
                    break

        zip_path.unlink(missing_ok=True)
        _ffmpeg_install = {"status": "done", "percent": 100, "error": ""}
    except Exception as exc:
        _ffmpeg_install = {"status": "error", "percent": 0, "error": str(exc)}


DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
if not DATA_FILE.exists():
    bundled_data = BASE_DIR / "data.json"
    if bundled_data.exists():
        shutil.copy2(bundled_data, DATA_FILE)
    else:
        DATA_FILE.write_text('{"projects":[]}', encoding="utf-8")

DEFAULT_DESKTOP_SETTINGS = {
    "imageApiBase": "https://api.openai.com/v1",
    "imageApiKey": "",
    "imageModel": "gpt-4o",
    "videoApiBase": "https://generativelanguage.googleapis.com/v1beta",
    "videoApiKey": "",
    "videoModel": "gemini-2.5-pro",
    "videoUploadTimeoutSec": "240",
    "llmApiBase": "https://api.openai.com/v1",
    "llmApiKey": "",
    "llmModel": "gpt-4o-mini",
    "videoUploadRetries": "1",
    "imageReverseInstruction": "",
    "videoReverseInstruction": "",
    "promptPresets": [],
}


def _load_settings():
    try:
        saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(saved, dict):
            saved = {}
    except Exception:
        saved = {}
    return {key: saved.get(key, default) for key, default in DEFAULT_DESKTOP_SETTINGS.items()}


def _save_settings(settings):
    # Load existing saved values so partial patch updates don't clobber unrelated keys
    try:
        existing = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            existing = {}
    except Exception:
        existing = {}
    merged = {**existing, **settings}
    clean = {}
    for key, default in DEFAULT_DESKTOP_SETTINGS.items():
        value = merged.get(key, default)
        if key == "promptPresets":
            presets = value if isinstance(value, list) else []
            clean[key] = [
                {
                    "name": str(p.get("name", "")).strip()[:80],
                    "content": str(p.get("content", "")),
                }
                for p in presets
                if isinstance(p, dict) and str(p.get("name", "")).strip() and str(p.get("content", "")).strip()
            ]
        else:
            clean[key] = str(value or "")
    # Backup before overwrite — keep last 5 copies so data loss is recoverable
    if CONFIG_FILE.exists():
        import datetime as _dt
        ts = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        bak = CONFIG_FILE.with_name(f"desktop_settings.{ts}.bak")
        try:
            import shutil as _shutil
            _shutil.copy2(CONFIG_FILE, bak)
            # Prune old backups, keep newest 5
            baks = sorted(CONFIG_FILE.parent.glob("desktop_settings.*.bak"))
            for old in baks[:-5]:
                old.unlink(missing_ok=True)
        except Exception:
            pass
    CONFIG_FILE.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    return clean


def _read_json_file(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json_file(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _project_name_map(data):
    return {str(p.get("id", "")): str(p.get("name", "")) for p in (data.get("projects", []) or []) if isinstance(p, dict)}


def _normalize_text(value):
    text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


def _extract_media_path(item):
    if not isinstance(item, dict):
        return ""
    media_path = item.get("image") or item.get("video") or ""
    return str(media_path)


def _safe_stat_size_for_upload_url(path_or_url):
    rel = _normalize_upload_ref(path_or_url)
    if not rel:
        return 0
    try:
        target = _upload_target(rel)
    except Exception:
        return 0
    try:
        return int(target.stat().st_size)
    except Exception:
        return 0


def _item_identity_signature(item):
    if not isinstance(item, dict):
        return ""
    media_path = _extract_media_path(item)
    prompt = _normalize_text(item.get("prompt", ""))
    model = _normalize_text(item.get("model", ""))
    title = _normalize_text(item.get("title", ""))
    size_hint = str(_safe_stat_size_for_upload_url(media_path) or "")
    raw = "|".join([media_path, title, model, prompt, size_hint])
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _item_version_id(item):
    if not isinstance(item, dict):
        return ""
    prompt = _normalize_text(item.get("prompt", ""))
    model = _normalize_text(item.get("model", ""))
    media_path = _extract_media_path(item)
    raw = "|".join([prompt, model, media_path])
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _build_item_doc(project_id, project_name, category, item):
    if not isinstance(item, dict):
        return None
    item_type = "image" if category == "image_prompts" else ("video" if category == "video_prompts" else "skill")
    tags = item.get("tags", []) if isinstance(item.get("tags", []), list) else []
    title = str(item.get("title", ""))
    prompt = str(item.get("prompt", ""))
    analysis = str(item.get("analysis", ""))
    model = str(item.get("model", ""))
    media_path = _extract_media_path(item)
    doc = {
        "id": str(item.get("id", "")),
        "project_id": str(project_id),
        "project_name": str(project_name),
        "category": category,
        "type": item_type,
        "title": title,
        "prompt": prompt,
        "analysis": analysis,
        "model": model,
        "tags": [str(t) for t in tags if str(t).strip()],
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
        "image": item.get("image", ""),
        "video": item.get("video", ""),
        "ref_images": item.get("ref_images", []) if isinstance(item.get("ref_images", []), list) else [],
        "version_id": _item_version_id(item),
        "identity_sig": _item_identity_signature(item),
        "quality": item.get("quality", {}) if isinstance(item.get("quality", {}), dict) else {},
        "lineage": item.get("lineage", {}) if isinstance(item.get("lineage", {}), dict) else {},
    }
    return doc


def _collect_docs(data):
    docs = []
    for proj in data.get("projects", []) or []:
        if not isinstance(proj, dict):
            continue
        pid = proj.get("id", "")
        pname = proj.get("name", "")
        for category in ("image_prompts", "video_prompts", "skill_prompts"):
            for item in (proj.get(category, []) or []):
                doc = _build_item_doc(pid, pname, category, item)
                if doc and doc["id"]:
                    docs.append(doc)
    return docs


def _match_score(doc, query):
    if not query:
        return 0
    q = _normalize_text(query)
    title = _normalize_text(doc.get("title", ""))
    tags = " ".join(_normalize_text(t) for t in (doc.get("tags", []) or []))
    prompt = _normalize_text(doc.get("prompt", ""))
    analysis = _normalize_text(doc.get("analysis", ""))
    model = _normalize_text(doc.get("model", ""))
    score = 0
    if q in title:
        score += 60
    if q in tags:
        score += 35
    if q in model:
        score += 20
    if q in prompt:
        score += 30
    if q in analysis:
        score += 18
    if score == 0:
        ratio = difflib.SequenceMatcher(None, q, title or prompt[: max(len(q), 1)]).ratio()
        if ratio >= 0.72:
            score = int(ratio * 25)
    return score


def _ensure_item_schema(item):
    if not isinstance(item, dict):
        return
    quality = item.get("quality")
    if not isinstance(quality, dict):
        quality = {}
    quality.setdefault("star", False)
    quality.setdefault("rating", 0)
    quality.setdefault("status", "")
    item["quality"] = quality
    lineage = item.get("lineage")
    if not isinstance(lineage, dict):
        lineage = {}
    lineage.setdefault("source_id", "")
    lineage.setdefault("version", 1)
    lineage.setdefault("version_id", _item_version_id(item))
    lineage.setdefault("history", [])
    if not isinstance(lineage.get("history"), list):
        lineage["history"] = []
    item["lineage"] = lineage


def _ensure_data_schema(data):
    if not isinstance(data, dict):
        data = {"projects": []}
    projects = data.get("projects", [])
    if not isinstance(projects, list):
        projects = []
    data["projects"] = projects
    changed = False
    for proj in projects:
        if not isinstance(proj, dict):
            continue
        for category in ("image_prompts", "video_prompts", "skill_prompts"):
            items = proj.get(category, [])
            if not isinstance(items, list):
                proj[category] = []
                changed = True
                continue
            for item in items:
                before = json.dumps(item, ensure_ascii=False, sort_keys=True) if isinstance(item, dict) else ""
                _ensure_item_schema(item)
                after = json.dumps(item, ensure_ascii=False, sort_keys=True) if isinstance(item, dict) else ""
                if before and after and before != after:
                    changed = True
    return data, changed


def _get_smart_folders():
    raw = _read_json_file(SMART_FOLDERS_FILE, {"folders": []})
    folders = raw.get("folders", []) if isinstance(raw, dict) else []
    if not isinstance(folders, list):
        folders = []
    clean = []
    for f in folders:
        if not isinstance(f, dict):
            continue
        clean.append({
            "id": str(f.get("id", uuid.uuid4().hex[:12])),
            "name": str(f.get("name", "")).strip() or "未命名智能文件夹",
            "rules": f.get("rules", {}) if isinstance(f.get("rules", {}), dict) else {},
            "created_at": str(f.get("created_at", "")),
            "updated_at": str(f.get("updated_at", "")),
        })
    return {"folders": clean}


def _save_smart_folders(payload):
    folders = payload.get("folders", []) if isinstance(payload, dict) else []
    if not isinstance(folders, list):
        folders = []
    clean = []
    for f in folders:
        if not isinstance(f, dict):
            continue
        clean.append({
            "id": str(f.get("id", uuid.uuid4().hex[:12])),
            "name": str(f.get("name", "")).strip()[:80] or "未命名智能文件夹",
            "rules": f.get("rules", {}) if isinstance(f.get("rules", {}), dict) else {},
            "created_at": str(f.get("created_at", "")) or time.strftime("%Y-%m-%dT%H:%M:%S"),
            "updated_at": str(f.get("updated_at", "")) or time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
    out = {"folders": clean}
    _write_json_file(SMART_FOLDERS_FILE, out)
    return out


def _apply_folder_rules(doc, rules):
    if not isinstance(rules, dict):
        return False
    doc_type = str(doc.get("type", ""))
    doc_model = str(doc.get("model", ""))
    doc_tags = set(str(t) for t in (doc.get("tags", []) or []))
    doc_quality = doc.get("quality", {}) if isinstance(doc.get("quality", {}), dict) else {}
    doc_lineage = doc.get("lineage", {}) if isinstance(doc.get("lineage", {}), dict) else {}

    type_filter = str(rules.get("type", "all") or "all")
    if type_filter != "all" and type_filter != doc_type:
        return False

    model_kw = str(rules.get("model", "")).strip().lower()
    if model_kw and model_kw not in doc_model.lower():
        return False

    include_tags = rules.get("include_tags", [])
    if isinstance(include_tags, list):
        inc_set = set(str(t).strip() for t in include_tags if str(t).strip())
        if inc_set and not inc_set.intersection(doc_tags):
            return False

    exclude_tags = rules.get("exclude_tags", [])
    if isinstance(exclude_tags, list):
        exc_set = set(str(t).strip() for t in exclude_tags if str(t).strip())
        if exc_set and exc_set.intersection(doc_tags):
            return False

    if rules.get("only_starred") and not bool(doc_quality.get("star")):
        return False

    min_rating = rules.get("min_rating")
    if min_rating is not None:
        try:
            if int(doc_quality.get("rating", 0)) < int(min_rating):
                return False
        except Exception:
            return False

    status = str(rules.get("status", "")).strip().lower()
    if status:
        if str(doc_quality.get("status", "")).strip().lower() != status:
            return False

    has_source = rules.get("has_source")
    if has_source is True and not str(doc_lineage.get("source_id", "")).strip():
        return False
    if has_source is False and str(doc_lineage.get("source_id", "")).strip():
        return False

    query = str(rules.get("query", "")).strip()
    if query and _match_score(doc, query) <= 0:
        return False
    return True


def _resolve_docs_by_refs(data, refs):
    docs = _collect_docs(data)
    lookup = {}
    for d in docs:
        lookup[f"{d.get('project_id')}::{d.get('category')}::{d.get('id')}"] = d
    resolved = []
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        key = f"{ref.get('project_id','')}::{ref.get('category','')}::{ref.get('id','')}"
        doc = lookup.get(key)
        if doc:
            resolved.append(doc)
    return resolved


def _snapshot_manifest():
    snaps = []
    for zf in sorted(SNAPSHOT_DIR.glob("*.zip"), reverse=True):
        try:
            stat = zf.stat()
            snaps.append({
                "name": zf.name,
                "path": str(zf),
                "size": stat.st_size,
                "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
            })
        except Exception:
            continue
    return snaps


def _as_int(value, default, min_value=None, max_value=None):
    try:
        n = int(str(value).strip())
    except Exception:
        n = default
    if min_value is not None and n < min_value:
        n = min_value
    if max_value is not None and n > max_value:
        n = max_value
    return n


def _is_timeout_error(err):
    if isinstance(err, (TimeoutError, socket.timeout)):
        return True
    if isinstance(err, urllib.error.URLError):
        reason = getattr(err, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return True
        if isinstance(reason, OSError) and "timed out" in str(reason).lower():
            return True
    return "timed out" in str(err).lower()


VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".ts", ".m3u8", ".mpd", ".flv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}


def _url_ext(url):
    try:
        return Path(urlparse(url).path).suffix.lower()
    except Exception:
        return ""


def _is_xinpianchang_page(url):
    try:
        u = urlparse(url or "")
        return u.scheme in ("http", "https") and u.netloc.lower().endswith("xinpianchang.com") and re.search(r"/a\d+", u.path)
    except Exception:
        return False


def _xpc_browser_headers(page_url):
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/136.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Sec-Fetch-Mode": "navigate",
        "Referer": page_url,
    }


def _pick_xpc_progressive(resource):
    progressive = resource.get("progressive") if isinstance(resource, dict) else None
    if not isinstance(progressive, list):
        return None
    candidates = [p for p in progressive if isinstance(p, dict) and p.get("url")]
    if not candidates:
        return None
    return max(candidates, key=lambda p: (int(p.get("width") or 0) * int(p.get("height") or 0), int(p.get("height") or 0)))


def _resolve_xinpianchang_video(page_url):
    if not _is_xinpianchang_page(page_url):
        return None
    headers = _xpc_browser_headers(page_url)
    raw, _ct = _fetch_url(page_url, headers, timeout=60)
    webpage = raw.decode("utf-8", errors="replace")
    m = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', webpage, re.S)
    if not m:
        raise RuntimeError("新片场页面未找到视频数据，请先在浏览器中打开并播放该视频后重试。")
    next_data = json.loads(html.unescape(m.group(1)))
    detail = (((next_data.get("props") or {}).get("pageProps") or {}).get("detail") or {})
    video = detail.get("video") or {}
    vid = video.get("vid")
    app_key = video.get("appKey")
    if not vid or not app_key:
        raise RuntimeError("新片场页面缺少 vid/appKey，无法解析真实视频地址。")

    api_url = f"https://mod-api.xinpianchang.com/mod/api/v2/media/{quote(str(vid))}?appKey={quote(str(app_key))}"
    api_raw, _ = _fetch_url(api_url, headers, timeout=60)
    payload = json.loads(api_raw.decode("utf-8", errors="replace"))
    data = payload.get("data") or {}
    resource = data.get("resource") or {}

    picked = _pick_xpc_progressive(resource)
    if picked:
        return {
            "url": picked["url"],
            "title": data.get("title") or detail.get("title") or "",
            "ext": ".mp4",
            "headers": {
                **_media_headers("video", page_url, ""),
                "Range": "bytes=0-",
                "Referer": page_url,
            },
        }
    for key, ext in (("hls", ".m3u8"), ("dash", ".mpd")):
        item = resource.get(key)
        if isinstance(item, dict) and item.get("url"):
            return {
                "url": item["url"],
                "title": data.get("title") or detail.get("title") or "",
                "ext": ext,
                "headers": _media_headers("video", page_url, ""),
            }
    raise RuntimeError("新片场接口未返回可下载的视频资源。")


def _normalize_upload_ref(value):
    if not isinstance(value, str) or not value.startswith("/uploads/"):
        return None
    rel = unquote(value[len("/uploads/"):]).replace("\\", "/").lstrip("/")
    if not rel or rel.startswith("../") or "/../" in f"/{rel}":
        return None
    return rel


def _upload_target(rel):
    target = (UPLOAD_DIR / rel).resolve()
    target.relative_to(UPLOAD_DIR.resolve())
    return target


def _item_upload_refs(item):
    refs = set()
    if not isinstance(item, dict):
        return refs
    for key in ("image", "video"):
        rel = _normalize_upload_ref(item.get(key))
        if rel:
            refs.add(rel)
    ref_images = item.get("ref_images", [])
    if isinstance(ref_images, list):
        for ref in ref_images:
            rel = _normalize_upload_ref(ref)
            if rel:
                refs.add(rel)
    gallery = item.get("gallery", [])
    if isinstance(gallery, list):
        for g in gallery:
            src = g.get("src") if isinstance(g, dict) else g
            rel = _normalize_upload_ref(src)
            if rel:
                refs.add(rel)
    return refs


def _data_upload_refs(data):
    refs = set()
    for proj in data.get("projects", []):
        if not isinstance(proj, dict):
            continue
        for key in ("image_prompts", "video_prompts", "skill_prompts"):
            for item in proj.get(key, []) or []:
                refs.update(_item_upload_refs(item))
    return refs


def _prune_empty_upload_dirs(start):
    root = UPLOAD_DIR.resolve()
    parent = start.parent.resolve()
    while parent != root:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent.resolve()


def _delete_upload_refs(refs, keep_refs=None):
    keep_refs = keep_refs or set()
    deleted, skipped = [], []
    total_bytes = 0
    for rel in sorted(set(refs)):
        if rel in keep_refs:
            skipped.append(rel)
            continue
        try:
            target = _upload_target(rel)
        except Exception:
            skipped.append(rel)
            continue
        if not target.exists() or not target.is_file():
            continue
        try:
            total_bytes += target.stat().st_size
            target.unlink()
            deleted.append(rel)
            _prune_empty_upload_dirs(target)
        except OSError:
            skipped.append(rel)
    return {"files": len(deleted), "bytes": total_bytes, "deleted": deleted, "skipped": skipped}


def _cleanup_unreferenced_uploads(data):
    keep_refs = _data_upload_refs(data)
    orphan_refs = set()
    if UPLOAD_DIR.exists():
        for target in UPLOAD_DIR.rglob("*"):
            if not target.is_file():
                continue
            rel = target.relative_to(UPLOAD_DIR).as_posix()
            if rel not in keep_refs:
                orphan_refs.add(rel)
    return _delete_upload_refs(orphan_refs)


def _source_meta_from_body(body, media_url="", saved_path="", media_urls=None):
    incoming = body.get("source") if isinstance(body.get("source"), dict) else {}
    page_url = body.get("pageUrl") or body.get("page_url") or incoming.get("page_url") or body.get("referer") or incoming.get("referer") or ""
    page_title = body.get("pageTitle") or body.get("page_title") or incoming.get("page_title") or ""
    urls = [str(u).strip() for u in (media_urls or []) if str(u).strip()]
    if media_url and media_url not in urls:
        urls.insert(0, media_url)
    meta = {
        "page_url": str(page_url).strip(),
        "page_title": str(page_title).strip(),
        "referer": str(body.get("referer") or incoming.get("referer") or "").strip(),
        "media_url": urls[0] if urls else "",
        "media_urls": urls[:20] if len(urls) > 1 else [],
        "saved_path": str(saved_path or "").strip(),
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    return {k: v for k, v in meta.items() if v}


def _iter_media_slots(data):
    for proj in data.get("projects", []) or []:
        if not isinstance(proj, dict):
            continue
        for category in ("image_prompts", "video_prompts", "skill_prompts"):
            for item in proj.get(category, []) or []:
                if not isinstance(item, dict):
                    continue
                base = {
                    "project_id": proj.get("id", ""),
                    "project_name": proj.get("name", ""),
                    "category": category,
                    "item_id": item.get("id", ""),
                    "title": item.get("title", ""),
                }
                for field in ("image", "video"):
                    yield {**base, "field": field, "value": item.get(field, "")}
                for field in ("gallery", "ref_images"):
                    values = item.get(field, [])
                    if not isinstance(values, list):
                        continue
                    for idx, value in enumerate(values):
                        src = value.get("src") if isinstance(value, dict) else value
                        yield {**base, "field": f"{field}[{idx}]", "value": src}


def _media_integrity_report(data):
    data, _ = _ensure_data_schema(data)
    refs, missing, remote = set(), [], []
    items_seen = set()
    for slot in _iter_media_slots(data):
        value = slot.get("value")
        if not isinstance(value, str) or not value:
            continue
        items_seen.add((slot.get("project_id"), slot.get("category"), slot.get("item_id")))
        rel = _normalize_upload_ref(value)
        if rel:
            refs.add(rel)
            try:
                target = _upload_target(rel)
                if not target.exists() or not target.is_file():
                    missing.append({**{k: slot[k] for k in ("project_id", "project_name", "category", "item_id", "title", "field")}, "path": value})
            except Exception:
                missing.append({**{k: slot[k] for k in ("project_id", "project_name", "category", "item_id", "title", "field")}, "path": value})
        elif value.startswith(("http://", "https://")):
            remote.append({**{k: slot[k] for k in ("project_id", "project_name", "category", "item_id", "title", "field")}, "url": value})

    orphan = []
    if UPLOAD_DIR.exists():
        for target in UPLOAD_DIR.rglob("*"):
            if target.is_file():
                rel = target.relative_to(UPLOAD_DIR).as_posix()
                if rel not in refs:
                    orphan.append(rel)
    return {
        "ok": not missing and not remote,
        "summary": {
            "items_with_media": len(items_seen),
            "local_refs": len(refs),
            "missing_files": len(missing),
            "remote_urls": len(remote),
            "orphan_files": len(orphan),
        },
        "missing_files": missing[:200],
        "remote_urls": remote[:200],
        "orphan_files": orphan[:200],
        "truncated": len(missing) > 200 or len(remote) > 200 or len(orphan) > 200,
    }


def _record_security_event(path, headers, client_address):
    event = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "path": path,
        "origin": (headers.get("Origin") or "").strip(),
        "sec_fetch_site": (headers.get("Sec-Fetch-Site") or "").strip(),
        "remote": client_address[0] if client_address else "",
    }
    with SECURITY_EVENTS_LOCK:
        SECURITY_EVENTS.append(event)
        del SECURITY_EVENTS[:-50]


def _media_headers(media_type="image", referer="", cookie=""):
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "video/*,audio/*,*/*;q=0.8" if media_type == "video"
                  else "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if referer and referer.startswith(("http://", "https://")):
        headers["Referer"] = referer
    if cookie:
        headers["Cookie"] = cookie
    return headers


def _fetch_url(url, headers, timeout=60):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        ct = (resp.headers.get_content_type() or "").split(";")[0].strip()
    return raw, ct


def _parse_m3u8_attrs(line):
    attrs = {}
    for key, value in re.findall(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', line):
        attrs[key] = value.strip('"')
    return attrs


def _next_uri(lines, start_index):
    for i in range(start_index + 1, len(lines)):
        line = lines[i].strip()
        if line and not line.startswith("#"):
            return line
    return ""


def _download_hls(url, headers, timeout=120):
    raw, _ct = _fetch_url(url, headers, timeout=30)
    text = raw.decode("utf-8", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if any(line.startswith("#EXT-X-KEY") and "METHOD=NONE" not in line for line in lines):
        ff = find_ffmpeg()
        if not ff:
            raise RuntimeError("检测到加密 HLS 视频流，需要先安装 ffmpeg 才能下载（在桌面端保存视频时会提示安装）。")
        # Use ffmpeg to download encrypted HLS to a temp file, then return bytes
        import subprocess as _sp, tempfile as _tf
        tmp_path = _tf.mktemp(suffix=".mp4")
        extra_hdrs = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items()
                             if k.lower() in ("cookie", "referer", "user-agent"))
        cmd = [ff, "-y", "-loglevel", "error"]
        if extra_hdrs:
            cmd += ["-headers", extra_hdrs]
        cmd += ["-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc", tmp_path]
        result = _sp.run(cmd, capture_output=True, timeout=timeout)
        if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
            with open(tmp_path, "rb") as f:
                data = f.read()
            os.unlink(tmp_path)
            return data, "video/mp4", "hd"
        err = (result.stderr or b"").decode("utf-8", errors="replace")[-400:]
        if os.path.exists(tmp_path): os.unlink(tmp_path)
        raise RuntimeError(f"ffmpeg 下载加密 HLS 失败: {err or 'unknown error'}")

    # Master playlist: choose the highest bandwidth variant.
    variants = []
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            attrs = _parse_m3u8_attrs(line)
            uri = _next_uri(lines, i)
            if uri:
                try:
                    bandwidth = int(attrs.get("BANDWIDTH", "0"))
                except ValueError:
                    bandwidth = 0
                variants.append((bandwidth, urljoin(url, uri)))
    if variants:
        variants.sort(reverse=True)
        return _download_hls(variants[0][1], headers, timeout=timeout)

    if "#EXT-X-ENDLIST" not in text:
        raise RuntimeError("检测到直播/未结束的 HLS 视频流，当前只支持下载点播视频。")

    init_url = ""
    for line in lines:
        if line.startswith("#EXT-X-MAP"):
            attrs = _parse_m3u8_attrs(line)
            if attrs.get("URI"):
                init_url = urljoin(url, attrs["URI"])
            break

    segment_urls = [urljoin(url, line) for line in lines if line and not line.startswith("#")]
    if not segment_urls:
        raise RuntimeError("HLS 播放列表里没有找到可下载的视频分片。")

    parts = []
    if init_url:
        init_raw, _ = _fetch_url(init_url, headers, timeout=30)
        parts.append(init_raw)
    for seg_url in segment_urls:
        seg_raw, _ = _fetch_url(seg_url, headers, timeout=30)
        parts.append(seg_raw)

    return b"".join(parts), "video/mp4" if init_url else "video/mp2t", ".mp4" if init_url else ".ts"


def _download_remote_media(url, media_type="image", referer="", cookie="", page_url="", timeout=60):
    if not url:
        raise RuntimeError("Missing media URL")
    xpc_page_url = page_url if _is_xinpianchang_page(page_url) else (url if _is_xinpianchang_page(url) else "")
    if media_type == "video" and xpc_page_url:
        resolved = _resolve_xinpianchang_video(xpc_page_url)
        if resolved:
            url = resolved["url"]
            referer = xpc_page_url
    if not url.startswith(("http://", "https://")):
        raise RuntimeError("Unsupported media URL")

    ext = _url_ext(url)
    if ext == ".mpd":
        raise RuntimeError("已识别到 DASH/MPD 视频流；当前版本先支持直连视频和 m3u8，MPD 需要后续接入音视频轨合并。")

    headers = _media_headers(media_type, referer, cookie)
    host = urlparse(url).netloc.lower()
    if media_type == "image" and "twimg.com" in host and not headers.get("Referer"):
        headers["Referer"] = "https://x.com/"
    if media_type == "video" and ("xpccdn.com" in host or "xinpianchang" in host):
        # Xinpianchang progressive MP4 returns 403 unless Range is present.
        headers["Range"] = "bytes=0-"
    if ext == ".m3u8":
        return _download_hls(url, headers, timeout=timeout)

    raw, ct = _fetch_url(url, headers, timeout=timeout)
    if "mpegurl" in ct or "m3u8" in ct:
        return _download_hls(url, headers, timeout=timeout)
    if "dash+xml" in ct or "mpd" in ct:
        raise RuntimeError("已识别到 DASH/MPD 视频流；当前版本先支持直连视频和 m3u8，MPD 需要后续接入音视频轨合并。")
    return raw, ct or ("video/mp4" if media_type == "video" else "image/jpeg"), ""


def _format_art_brief(obj):
    """Convert a JSON art-brief dict to a readable multi-section text."""
    lines = []
    if obj.get("title"):
        lines.append(f"【{obj['title']}】\n")
    if obj.get("coreExpression"):
        lines.append(f"▍核心表达\n{obj['coreExpression']}\n")
    section_labels = [
        ("composition","构图"), ("camera","镜头"), ("lighting","光线"),
        ("material","材质"), ("space","空间"), ("colorAesthetics","色彩"),
        ("postProcessing","后期"), ("technicalSketch","技术细节"), ("vision","画面语言"),
    ]
    secs = obj.get("sections") or {}
    for key, label in section_labels:
        if secs.get(key):
            lines.append(f"▍{label}\n{secs[key]}\n")
    colors = obj.get("colors") or []
    if colors:
        lines.append(f"▍色板\n{' '.join(str(c) for c in colors)}\n")
    tp = obj.get("technicalParams") or {}
    parts = []
    if tp.get("format"):       parts.append(f"画幅：{tp['format']}")
    if tp.get("renderEngine"): parts.append(f"渲染：{tp['renderEngine']}")
    if parts:
        lines.append(f"▍技术参数\n{'　'.join(parts)}\n")
    return "\n".join(lines).strip()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(BASE_DIR), **kw)

    def log_message(self, fmt, *args):
        print(f"[studio] {fmt % args}")

    # ── routing ──────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        if self._reject_untrusted_api_request():
            return
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self._reject_untrusted_api_request():
            return
        try:
            self._do_GET_inner()
        except Exception as exc:
            try:
                self._err(500, f"Server error: {exc}")
            except Exception:
                pass

    def _do_GET_inner(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query or "")
        if path == "/api/data":
            raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            fixed, changed = _ensure_data_schema(raw)
            if changed:
                DATA_FILE.write_text(json.dumps(fixed, ensure_ascii=False, indent=2), encoding="utf-8")
            self._json_resp(fixed)
        elif path == "/api/projects":
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            data, changed = _ensure_data_schema(data)
            if changed:
                DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            self._json_resp(data.get("projects", []))
        elif path == "/api/desktop/settings":
            self._json_resp({"ok": True, "settings": _load_settings()})
        elif path == "/api/health":
            self._json_resp({"ok": True})
        elif path == "/api/media/integrity":
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            self._json_resp({"ok": True, "integrity": _media_integrity_report(data)})
        elif path == "/api/security/status":
            with SECURITY_EVENTS_LOCK:
                recent = list(SECURITY_EVENTS)
            self._json_resp({
                "ok": True,
                "server_origin": f"http://127.0.0.1:{self._server_port()}",
                "loopback_hosts": sorted(LOOPBACK_CORS_HOSTS),
                "extra_trusted_origins": sorted(EXTRA_TRUSTED_ORIGINS),
                "blocked_count": len(recent),
                "recent_blocks": recent[-20:],
            })
        elif path == "/api/studio-config":
            self._json_resp({"ok": True, "data_dir": str(DATA_DIR), "config_file": str(_STUDIO_CONFIG_FILE)})
        elif path == "/api/smart-folders":
            self._json_resp({"ok": True, **_get_smart_folders()})
        elif path == "/api/snapshot/list":
            self._json_resp({"ok": True, "snapshots": _snapshot_manifest()})
        elif path == "/api/cli/projects":
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            projs = [{
                "id": p["id"], "name": p["name"],
                "skill_count": len(p.get("skill_prompts", [])),
                "image_count": len(p.get("image_prompts", [])),
                "video_count": len(p.get("video_prompts", [])),
            } for p in data.get("projects", [])]
            self._json_resp({"ok": True, "projects": projs})
        elif path == "/api/cli/prompts":
            self._handle_cli_list(query)
        elif path == "/api/cli/prompt":
            self._handle_cli_get(query)
        elif path == "/api/cli/search":
            self._handle_cli_search(query)
        elif path == "/api/cli/audio/folders":
            self._handle_cli_audio_folders(query)
        elif path == "/api/cli/audio/files":
            self._handle_cli_audio_files(query)
        elif path == "/api/cli/docs":
            self._handle_cli_docs(query)
        elif path == "/api/search-assets":
            self._handle_search_assets(query)
        elif path == "/api/detect-duplicates":
            self._handle_detect_duplicates(query)
        elif path == "/api/smart-folders/preview":
            self._handle_smart_folder_preview(query)
        elif path == "/api/events":
            self._handle_sse()
        elif path == "/api/ffmpeg-status":
            ff = find_ffmpeg()
            self._json_resp({"ok": bool(ff), "path": ff or "", "install": _ffmpeg_install})
        elif path == "/api/local-audio":
            self._serve_local_audio(query)
        elif path.startswith("/uploads/"):
            self._serve_upload(path)
        elif path.startswith("/exports/"):
            self._serve_export(path)
        else:
            super().do_GET()

    def _serve_upload(self, path):
        rel = unquote(path[len("/uploads/"):]).replace("\\", "/")
        if rel.startswith("../") or "/../" in rel:
            return self._err(400, "Invalid upload path")
        target = (UPLOAD_DIR / rel).resolve()
        try:
            target.relative_to(UPLOAD_DIR.resolve())
        except ValueError:
            return self._err(400, "Invalid upload path")
        if not target.exists() or not target.is_file():
            return self._err(404, "Not found")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        file_size = target.stat().st_size
        range_header = self.headers.get("Range")
        if range_header:
            try:
                spec = range_header.replace("bytes=", "").strip()
                parts = spec.split("-")
                start = int(parts[0]) if parts[0] else 0
                end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
                end = min(end, file_size - 1)
            except (ValueError, IndexError):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            if start >= file_size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self._cors_headers()
            self.end_headers()
            with target.open("rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except Exception:
                        break
                    remaining -= len(chunk)
        else:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self._cors_headers()
            self.end_headers()
            with target.open("rb") as f:
                shutil.copyfileobj(f, self.wfile)

    def _serve_export(self, path):
        rel = unquote(path[len("/exports/"):]).replace("\\", "/").strip()
        if not rel or "/" in rel or "\\" in rel or rel.startswith("."):
            return self._err(400, "Invalid export path")
        target = (EXPORT_DIR / rel).resolve()
        try:
            target.relative_to(EXPORT_DIR.resolve())
        except Exception:
            return self._err(400, "Invalid export path")
        if not target.exists() or not target.is_file():
            return self._err(404, "Not found")
        ctype = "application/zip"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(target.stat().st_size))
        self._cors_headers()
        self.end_headers()
        with target.open("rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def _handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._cors_headers()
        self.end_headers()
        q = queue.Queue()
        with _sse_lock: _sse_clients.append(q)
        try:
            while True:
                try:
                    msg = q.get(timeout=25)
                    self.wfile.write(msg)
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        finally:
            with _sse_lock:
                if q in _sse_clients: _sse_clients.remove(q)

    def do_POST(self):
        if self._reject_untrusted_api_request():
            return
        path = urlparse(self.path).path
        if path == "/api/upload-video":
            return self._handle_video_upload()
        if path == "/api/upload-pdf":
            return self._handle_pdf_upload()
        if path == "/api/preview-doc":
            try:
                body = self._read_body()
            except Exception as e:
                return self._err(400, str(e))
            return self._handle_preview_doc(body)
        try:
            body = self._read_body()
        except Exception as e:
            return self._err(400, str(e))

        if path == "/api/data":
            fixed, _changed = _ensure_data_schema(body if isinstance(body, dict) else {"projects": []})
            DATA_FILE.write_text(
                json.dumps(fixed, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._json_resp({"ok": True})
        elif path == "/api/upload-image":
            self._handle_upload(body)
        elif path == "/api/save-media":
            self._handle_save_media(body)
        elif path == "/api/save-prompt":
            self._handle_save_prompt(body)
        elif path == "/api/delete-prompt":
            self._handle_delete_prompt(body)
        elif path == "/api/delete-project":
            self._handle_delete_project(body)
        elif path == "/api/cleanup-media":
            self._handle_cleanup_media(body)
        elif path == "/api/reverse-prompt":
            self._handle_reverse_prompt(body)
        elif path == "/api/create-project":
            self._handle_create_project(body)
        elif path == "/api/rename-project":
            self._handle_rename_project(body)
        elif path == "/api/gen-title":
            self._handle_gen_title(body)
        elif path == "/api/rewrite-prompt":
            self._handle_rewrite_prompt(body)
        elif path == "/api/desktop/settings":
            self._json_resp({"ok": True, "settings": _save_settings(body)})
        elif path == "/api/export-bundle":
            self._handle_export_bundle(body)
        elif path == "/api/snapshot/create":
            self._handle_snapshot_create(body)
        elif path == "/api/snapshot/restore":
            self._handle_snapshot_restore(body)
        elif path == "/api/smart-folders":
            self._handle_save_smart_folders(body)
        elif path == "/api/delete-pdf":
            self._handle_delete_pdf(body)
        elif path == "/api/asset/quality":
            self._handle_asset_quality(body)
        elif path == "/api/asset/palette":
            self._handle_save_palette(body)
        elif path == "/api/asset/lineage":
            self._handle_asset_lineage(body)
        elif path == "/api/upload-to-public":
            self._handle_upload_to_public(body)
        elif path == "/api/import-bundle":
            return self._handle_import_bundle()
        elif path == "/api/studio-config":
            cfg = _load_studio_config()
            new_dir_str = body.get("data_dir", "").strip()
            if new_dir_str:
                new_dir = Path(new_dir_str).resolve()
                migrate = body.get("migrate", True)
                migrated, errors = [], []
                if migrate and new_dir != DATA_DIR:
                    new_dir.mkdir(parents=True, exist_ok=True)
                    for item in DATA_DIR.iterdir():
                        dest = new_dir / item.name
                        try:
                            if item.is_dir():
                                if dest.exists():
                                    shutil.copytree(str(item), str(dest), dirs_exist_ok=True)
                                else:
                                    shutil.copytree(str(item), str(dest))
                            else:
                                shutil.copy2(str(item), str(dest))
                            migrated.append(item.name)
                        except Exception as e:
                            errors.append(f"{item.name}: {e}")
                cfg["data_dir"] = str(new_dir)
                _STUDIO_CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
                self._json_resp({"ok": True, "saved": str(new_dir), "migrated": migrated, "errors": errors, "restart_required": True})
            else:
                self._json_resp({"ok": True, "data_dir": str(DATA_DIR), "config_file": str(_STUDIO_CONFIG_FILE)})
        elif path == "/api/install-ffmpeg":
            if _ffmpeg_install.get("status") not in ("downloading", "extracting"):
                threading.Thread(target=_do_install_ffmpeg, daemon=True).start()
            self._json_resp({"ok": True, "status": _ffmpeg_install["status"]})
        elif path == "/api/download-video":
            self._handle_download_video(body)
        elif path == "/api/cli/push":
            self._handle_cli_push(body)
        else:
            self._err(404, "Not found")

    # ── helpers ───────────────────────────────────────────────────────────
    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _handle_upload(self, body):
        data_url = body.get("data_url", "")
        filename  = body.get("filename", "image.jpg") or "image.jpg"
        # strip unsafe chars from filename
        filename = re.sub(r"[^\w.\-]", "_", Path(filename).name)[:60]
        m = re.match(r"data:([^;]+);base64,(.+)", data_url, re.DOTALL)
        if not m:
            return self._err(400, "Invalid data_url")
        mime, b64 = m.group(1), m.group(2)
        ext = mimetypes.guess_extension(mime) or ".jpg"
        ext = ext.replace(".jpe", ".jpg")
        stem = Path(filename).stem
        # sub-folder by project
        proj_raw = body.get("project", "") or ""
        proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj_raw)[:40] if proj_raw else "default"
        save_dir = UPLOAD_DIR / proj_folder / "images"
        save_dir.mkdir(parents=True, exist_ok=True)
        out_path = save_dir / f"{stem}{ext}"
        counter = 1
        while out_path.exists():
            out_path = save_dir / f"{stem}_{counter}{ext}"
            counter += 1
        out_path.write_bytes(base64.b64decode(b64))
        self._json_resp({"ok": True, "path": f"/uploads/{proj_folder}/images/{out_path.name}"})

    def _handle_video_upload(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        filename  = unquote(self.headers.get("X-Filename", "video.mp4") or "video.mp4")
        proj_raw  = unquote(self.headers.get("X-Project",  "default")  or "default")
        proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj_raw)[:40] if proj_raw else "default"
        stem = re.sub(r"[^\w.\-]", "_", Path(filename).stem)[:50]
        ext  = Path(filename).suffix or ".mp4"
        save_dir = UPLOAD_DIR / proj_folder / "videos"
        save_dir.mkdir(parents=True, exist_ok=True)
        out_path = save_dir / f"{stem}{ext}"
        counter = 1
        while out_path.exists():
            out_path = save_dir / f"{stem}_{counter}{ext}"
            counter += 1
        out_path.write_bytes(raw)
        self._json_resp({"ok": True, "path": f"/uploads/{proj_folder}/videos/{out_path.name}"})

    def _handle_pdf_upload(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            if not raw:
                return self._err(400, "Empty file")
            filename  = unquote(self.headers.get("X-Filename", "document.bin") or "document.bin")
            proj_raw  = unquote(self.headers.get("X-Project",  "default") or "default")
            proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj_raw)[:40] if proj_raw else "default"
            stem = re.sub(r"[^\w\u4e00-\u9fff.\-]", "_", Path(filename).stem)[:50] or "document"
            ext  = Path(filename).suffix or ".bin"
            save_dir = UPLOAD_DIR / proj_folder / "docs"
            save_dir.mkdir(parents=True, exist_ok=True)
            out_path = save_dir / f"{stem}{ext}"
            counter = 1
            while out_path.exists():
                out_path = save_dir / f"{stem}_{counter}{ext}"
                counter += 1
            out_path.write_bytes(raw)
            # Extract text content for full-text search
            content_text = ""
            try:
                ext_lower = ext.lower()
                if ext_lower == ".txt" or ext_lower in (".md", ".markdown"):
                    content_text = raw.decode("utf-8", errors="replace")[:50000]
                elif ext_lower == ".csv":
                    content_text = raw.decode("utf-8", errors="replace")[:50000]
                elif ext_lower == ".pdf":
                    # Try pdfminer
                    try:
                        from pdfminer.high_level import extract_text as _pdf_extract
                        content_text = _pdf_extract(str(out_path))[:50000]
                    except ImportError:
                        pass
                elif ext_lower == ".docx":
                    try:
                        import zipfile as _zf, xml.etree.ElementTree as _ET
                        with _zf.ZipFile(out_path) as zf:
                            xml_content = zf.read("word/document.xml")
                        root = _ET.fromstring(xml_content)
                        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                        content_text = "\n".join(t.text for t in root.iter("{%s}t" % ns["w"]) if t.text)[:50000]
                    except Exception:
                        pass
                elif ext_lower in (".xlsx", ".xls"):
                    try:
                        import zipfile as _zf, xml.etree.ElementTree as _ET
                        if ext_lower == ".xlsx":
                            with _zf.ZipFile(out_path) as zf:
                                shared = _ET.fromstring(zf.read("xl/sharedStrings.xml"))
                            ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
                            content_text = "\n".join(t.text for t in shared.iter("{%s}t" % ns["s"]) if t.text)[:50000]
                    except Exception:
                        pass
            except Exception:
                pass
            self._json_resp({
                "ok": True,
                "path": f"/uploads/{proj_folder}/docs/{out_path.name}",
                "filename": out_path.name,
                "size": len(raw),
                "content_text": content_text
            })
        except Exception as e:
            self._err(500, f"Upload failed: {e}")

    def _handle_preview_doc(self, body):
        try:
            rel = (body.get("path") or "").lstrip("/")
            file_path = (DATA_DIR / rel).resolve()
            if not file_path.exists():
                return self._err(404, "File not found")
            ext = file_path.suffix.lower()
            # Try mammoth (Python) for .docx first
            try:
                import mammoth as _mammoth
                with open(file_path, "rb") as f:
                    result = _mammoth.convert_to_html(f)
                return self._json_resp({"ok": True, "html": result.value})
            except ImportError:
                pass
            except Exception:
                pass
            # Fallback: win32com Word automation (Windows only)
            import tempfile
            try:
                import win32com.client
                word = win32com.client.Dispatch("Word.Application")
                word.Visible = False
                doc = word.Documents.Open(str(file_path))
                tmp = Path(tempfile.mktemp(suffix=".html"))
                doc.SaveAs2(str(tmp), FileFormat=10)  # wdFormatFilteredHTML
                doc.Close(False)
                word.Quit()
                html = tmp.read_text(encoding="utf-8", errors="replace")
                tmp.unlink(missing_ok=True)
                return self._json_resp({"ok": True, "html": html})
            except Exception as e:
                return self._err(500, f"Word conversion failed: {e}")
        except Exception as e:
            return self._err(500, str(e))

    def _handle_delete_pdf(self, body):
        project_id = body.get("projectId", "")
        pdf_id     = body.get("pdfId", "")
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        proj = next((p for p in data.get("projects", []) if p["id"] == project_id), None)
        if not proj:
            return self._err(404, "Project not found")
        pdfs = proj.get("pdf_files", [])
        item = next((p for p in pdfs if p["id"] == pdf_id), None)
        if item:
            try:
                rel = item.get("path", "").lstrip("/")[len("uploads/"):]
                full = (UPLOAD_DIR / rel).resolve()
                if UPLOAD_DIR.resolve() in full.parents and full.exists():
                    full.unlink()
            except Exception:
                pass
        proj["pdf_files"] = [p for p in pdfs if p["id"] != pdf_id]
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True})

    def _handle_cli_push(self, body):
        """CLI / agent endpoint: push a prompt into Prompt Studio."""
        project_name = (body.get("project_name") or "").strip()
        project_id   = (body.get("project_id") or "").strip()
        type_        = body.get("type", "skill")   # image | video | skill
        title        = (body.get("title") or "").strip()
        prompt       = (body.get("prompt") or "").strip()
        model        = body.get("model", "")
        tags         = body.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        if not prompt and type_ == "skill":
            return self._err(400, "prompt is required for skill type")
        cat_map = {"image": "image_prompts", "video": "video_prompts", "skill": "skill_prompts"}
        category = cat_map.get(type_, "skill_prompts")
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, _ = _ensure_data_schema(data)
        proj = None
        if project_id:
            proj = next((p for p in data.get("projects", []) if p["id"] == project_id), None)
        elif project_name:
            proj = next((p for p in data.get("projects", []) if p["name"] == project_name), None)
            if not proj:  # auto-create
                proj = {"id": uuid.uuid4().hex[:16], "name": project_name,
                        "image_prompts": [], "video_prompts": [], "skill_prompts": []}
                data.setdefault("projects", []).append(proj)
        else:
            projs = data.get("projects", [])
            if not projs:
                return self._err(400, "No projects found. Provide project_name.")
            proj = projs[0]
        pname = proj.get("name", project_name or "default")
        media_failures = []

        def _save_required_media(media_type, label, **kwargs):
            has_media = bool(kwargs.get("b64") or kwargs.get("url"))
            path = self._save_agent_media(pname, media_type, **kwargs)
            if has_media and not path:
                media_failures.append(label)
            return path

        # ── Save agent-generated images ────────────────────────────────────
        # Single main image: image_base64 / image_url
        img_path = _save_required_media("image", "image_url",
                        b64=body.get("image_base64",""), url=body.get("image_url",""),
                        filename=body.get("image_filename","agent_image.jpg"))
        # Gallery: list of {base64, url, filename} objects or plain URL strings
        gallery_in = body.get("gallery_images", [])
        gallery_paths = []
        if img_path: gallery_paths.append(img_path)
        for g in (gallery_in if isinstance(gallery_in, list) else []):
            if isinstance(g, str):
                p = _save_required_media("image", "gallery_image", url=g)
            elif isinstance(g, dict):
                p = _save_required_media("image", "gallery_image",
                        b64=g.get("base64",""), url=g.get("url",""),
                        filename=g.get("filename",""))
            else: p = ""
            if p: gallery_paths.append(p)
        # ── Save agent-generated video ─────────────────────────────────────
        vid_path = _save_required_media("video", "video_url",
                        b64=body.get("video_base64",""), url=body.get("video_url",""),
                        filename=body.get("video_filename","agent_video.mp4"))
        if media_failures:
            return self._err(502, "媒体下载失败，未写入远端 URL：" + ", ".join(media_failures[:5]))
        item_id  = uuid.uuid4().hex[:16]
        new_item = {
            "id": item_id, "title": title or "Agent 推送",
            "prompt": prompt, "analysis": body.get("analysis", ""),
            "model": model, "tags": tags,
            "image": img_path or (gallery_paths[0] if gallery_paths else ""),
            "gallery": gallery_paths, "ref_image": "",
            "video": vid_path, "ref_images": [], "aspect": body.get("aspect", ""),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
        }
        source_urls = []
        if body.get("image_url"):
            source_urls.append(body.get("image_url"))
        for g in (gallery_in if isinstance(gallery_in, list) else []):
            if isinstance(g, str):
                source_urls.append(g)
            elif isinstance(g, dict) and g.get("url"):
                source_urls.append(g.get("url"))
        if body.get("video_url"):
            source_urls.append(body.get("video_url"))
        source = _source_meta_from_body(body, media_urls=source_urls, saved_path=new_item.get("image") or new_item.get("video") or "")
        if source:
            new_item["source"] = source
        _ensure_item_schema(new_item)
        proj.setdefault(category, []).insert(0, new_item)
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "id": item_id,
                         "project_id": proj["id"], "project_name": proj["name"], "type": type_,
                         "image": new_item["image"], "gallery": gallery_paths, "video": vid_path})

    # ── CLI media helpers ─────────────────────────────────────────────────
    def _save_agent_media(self, proj_name: str, media_type: str,
                          b64: str = "", url: str = "", filename: str = "") -> str:
        """Save image/video from base64 or URL. Returns /uploads/... path or ''."""
        import urllib.request as _ur
        subdir = "images" if media_type == "image" else "videos"
        proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj_name)[:40] if proj_name else "default"
        save_dir = UPLOAD_DIR / proj_folder / subdir
        save_dir.mkdir(parents=True, exist_ok=True)
        raw = b""
        ext = ".jpg" if media_type == "image" else ".mp4"
        stem = re.sub(r"[^\w.\-]", "_", Path(filename).stem)[:50] if filename else "agent_gen"
        if b64:
            m = re.match(r"data:([^;]+);base64,(.+)", b64.strip(), re.DOTALL)
            if m:
                mime, data = m.group(1), m.group(2)
                ext = (mimetypes.guess_extension(mime) or ext).replace(".jpe", ".jpg")
                raw = base64.b64decode(data)
            else:
                try: raw = base64.b64decode(b64.strip())
                except Exception: return ""
        elif url:
            try:
                raw, ct, forced_ext = _download_remote_media(
                    url,
                    media_type=media_type,
                    timeout=120 if media_type == "video" else 30,
                )
                if forced_ext:
                    ext = forced_ext
                else:
                    guessed = mimetypes.guess_extension((ct or "").split(";")[0].strip())
                    if guessed: ext = guessed.replace(".jpe", ".jpg")
            except Exception: return ""
        if not raw: return ""
        if not stem or stem == "agent_gen":
            stem = Path(url).stem[:40] if url else "agent_gen"
            stem = re.sub(r"[^\w\-]", "_", stem) or "agent_gen"
        out = save_dir / f"{stem}{ext}"
        counter = 1
        while out.exists():
            out = save_dir / f"{stem}_{counter}{ext}"; counter += 1
        out.write_bytes(raw)
        return f"/uploads/{proj_folder}/{subdir}/{out.name}"

    # ── CLI audio helpers ─────────────────────────────────────────────────
    def _handle_cli_audio_folders(self, query):
        """GET /api/cli/audio/folders?project=<name|id>"""
        AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.opus', '.weba', '.m4r', '.aiff', '.au'}
        project_ref = (query.get("project") or [""])[0]
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        results = []
        for proj in data.get("projects", []):
            if project_ref and project_ref not in (proj["id"], proj["name"]):
                continue
            for folder in proj.get("audio_folders", []):
                local_path = folder.get("localPath", "")
                file_count = 0
                accessible = False
                if local_path and os.path.isdir(local_path):
                    accessible = True
                    try:
                        for _, _, files in os.walk(local_path):
                            file_count += sum(1 for f in files if os.path.splitext(f)[1].lower() in AUDIO_EXTS)
                    except Exception:
                        pass
                results.append({
                    "project_id":   proj["id"],
                    "project_name": proj["name"],
                    "folder_id":    folder["id"],
                    "folder_name":  folder["name"],
                    "local_path":   local_path,
                    "file_count":   file_count,
                    "accessible":   accessible,
                    "added_at":     folder.get("added_at", ""),
                })
        self._json_resp({"ok": True, "count": len(results), "folders": results})

    def _handle_cli_audio_files(self, query):
        """GET /api/cli/audio/files?project=<name|id>&folder=<folder_id|name>&q=<search>&starred=<1|true>&limit=500"""
        AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.opus', '.weba', '.m4r', '.aiff', '.au'}
        project_ref  = (query.get("project") or [""])[0]
        folder_ref   = (query.get("folder")  or [""])[0]
        q            = (query.get("q")       or [""])[0].lower()
        starred_only = (query.get("starred") or [""])[0].lower() in ("1", "true", "yes")
        limit        = int((query.get("limit") or ["500"])[0])
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        if project_ref:
            proj = next((p for p in data.get("projects", []) if project_ref in (p["id"], p["name"])), None)
        else:
            # pick first project that actually has audio folders
            proj = next((p for p in data.get("projects", []) if p.get("audio_folders")), None)
        if not proj:
            return self._err(404, "No project with audio folders found")
        folder = next((f for f in proj.get("audio_folders", [])
                       if not folder_ref or folder_ref in (f["id"], f["name"])), None)
        if not folder:
            return self._err(404, f"Audio folder not found in project '{proj['name']}'."
                             " Use /api/cli/audio/folders to list available folders.")
        local_path = folder.get("localPath", "")
        if not local_path or not os.path.isdir(local_path):
            return self._err(400, f"Local path not accessible: {local_path}")
        translations = proj.get("audio_translations", {}).get(folder["id"], {})
        stars = set(proj.get("audio_stars", []))
        items = []
        for root, dirs, files in os.walk(local_path):
            dirs.sort()
            for fname in sorted(files):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in AUDIO_EXTS:
                    continue
                abs_path = os.path.join(root, fname)
                rel_path = os.path.relpath(abs_path, local_path).replace('\\', '/')
                name_no_ext = os.path.splitext(fname)[0]
                cn_name = translations.get(name_no_ext, "")
                is_starred = abs_path in stars
                if starred_only and not is_starred:
                    continue
                if q and q not in fname.lower() and q not in cn_name.lower():
                    continue
                try:
                    size = os.path.getsize(abs_path)
                except Exception:
                    size = 0
                items.append({
                    "name":       fname,
                    "nameNoExt":  name_no_ext,
                    "ext":        ext.lstrip('.'),
                    "relPath":    rel_path,
                    "absPath":    abs_path,
                    "size":       size,
                    "cnName":     cn_name,
                    "starred":    is_starred,
                    "stream_url": f"/api/local-audio?path={quote(abs_path)}",
                })
                if len(items) >= limit:
                    break
            if len(items) >= limit:
                break
        self._json_resp({
            "ok":           True,
            "project_id":   proj["id"],
            "project_name": proj["name"],
            "folder_id":    folder["id"],
            "folder_name":  folder["name"],
            "local_path":   local_path,
            "count":        len(items),
            "items":        items,
        })

    # ── CLI read helpers ──────────────────────────────────────────────────
    def _handle_cli_list(self, query):
        """GET /api/cli/prompts?project=<name|id>&type=image|video|skill&limit=50"""
        project_ref = (query.get("project") or [""])[0]
        type_       = (query.get("type") or [""])[0] or None   # None = all
        limit       = int((query.get("limit") or ["200"])[0])
        data        = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        cat_map = {"image": "image_prompts", "video": "video_prompts", "skill": "skill_prompts"}
        cats = [cat_map[type_]] if type_ in cat_map else list(cat_map.values())
        results = []
        for proj in data.get("projects", []):
            if project_ref and project_ref not in (proj["id"], proj["name"]):
                continue
            for cat in cats:
                ptype = {v: k for k, v in cat_map.items()}[cat]
                for item in proj.get(cat, []):
                    results.append({
                        "id": item["id"], "type": ptype,
                        "project_id": proj["id"], "project_name": proj["name"],
                        "title": item.get("title",""), "model": item.get("model",""),
                        "tags": item.get("tags",[]), "aspect": item.get("aspect",""),
                        "image": item.get("image",""), "gallery": item.get("gallery",[]),
                        "video": item.get("video",""),
                        "ref_images": item.get("ref_images",[]),
                        "created_at": item.get("created_at",""),
                        "prompt_preview": (item.get("prompt") or "")[:120],
                    })
                    if len(results) >= limit:
                        break
        self._json_resp({"ok": True, "count": len(results), "items": results})

    def _handle_cli_get(self, query):
        """GET /api/cli/prompt?id=<id>  or  ?project=<name>&title=<title>&type=<type>"""
        item_id     = (query.get("id") or [""])[0]
        project_ref = (query.get("project") or [""])[0]
        title_q     = (query.get("title") or [""])[0].lower()
        type_       = (query.get("type") or [""])[0] or None
        data        = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        cat_map = {"image": "image_prompts", "video": "video_prompts", "skill": "skill_prompts"}
        cats = [cat_map[type_]] if type_ in cat_map else list(cat_map.values())
        for proj in data.get("projects", []):
            if project_ref and project_ref not in (proj["id"], proj["name"]):
                continue
            for cat in cats:
                ptype = {v: k for k, v in cat_map.items()}[cat]
                for item in proj.get(cat, []):
                    match_id    = item_id and item["id"] == item_id
                    match_title = title_q and title_q in (item.get("title") or "").lower()
                    if match_id or match_title:
                        return self._json_resp({"ok": True, "type": ptype,
                            "project_id": proj["id"], "project_name": proj["name"],
                            "item": item})
        self._err(404, "Prompt not found")

    def _handle_cli_search(self, query):
        """GET /api/cli/search?q=<text>&project=<name>&type=<type>&limit=20"""
        q           = (query.get("q") or [""])[0].lower()
        project_ref = (query.get("project") or [""])[0]
        type_       = (query.get("type") or [""])[0] or None
        limit       = int((query.get("limit") or ["20"])[0])
        if not q:
            return self._err(400, "q is required")
        data    = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        cat_map = {"image": "image_prompts", "video": "video_prompts", "skill": "skill_prompts"}
        cats    = [cat_map[type_]] if type_ in cat_map else list(cat_map.values())
        results = []
        for proj in data.get("projects", []):
            if project_ref and project_ref not in (proj["id"], proj["name"]):
                continue
            for cat in cats:
                ptype = {v: k for k, v in cat_map.items()}[cat]
                for item in proj.get(cat, []):
                    haystack = " ".join([
                        item.get("title",""), item.get("prompt",""),
                        item.get("analysis",""), " ".join(item.get("tags",[]))
                    ]).lower()
                    if q in haystack:
                        results.append({
                            "id": item["id"], "type": ptype,
                            "project_id": proj["id"], "project_name": proj["name"],
                            "title": item.get("title",""), "model": item.get("model",""),
                            "tags": item.get("tags",[]),
                            "image": item.get("image",""), "gallery": item.get("gallery",[]),
                            "video": item.get("video",""),
                            "prompt": item.get("prompt",""),
                            "analysis": item.get("analysis",""),
                        })
                        if len(results) >= limit:
                            break
        self._json_resp({"ok": True, "query": q, "count": len(results), "items": results})

    def _handle_save_prompt(self, body):
        project_id = body.get("projectId", "")
        category   = body.get("category", "skill_prompts")
        title      = body.get("title", "")
        prompt     = body.get("prompt", "")
        model      = body.get("model", "")
        tags       = body.get("tags", [])

        if not prompt:
            return self._err(400, "prompt is required")

        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj = next((p for p in data.get("projects", []) if p["id"] == project_id), None)
        if not proj:
            return self._err(404, "Project not found")

        analysis   = body.get("analysis", "")
        item_id    = body.get("id", "")

        existing_item = None
        if item_id:
            existing_item = next((item for item in proj.get(category, []) if item.get("id") == item_id), None)

        if existing_item:
            existing_item["title"] = title or existing_item.get("title", "未命名提示词")
            existing_item["prompt"] = prompt
            existing_item["model"] = model
            existing_item["tags"] = tags
            existing_item["analysis"] = analysis
            existing_item["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            new_item = existing_item
        else:
            if not item_id:
                item_id = uuid.uuid4().hex[:16]
            new_item = {
                "id": item_id, "title": title or "未命名提示词",
                "prompt": prompt, "analysis": analysis, "model": model, "tags": tags,
                "image": "", "video": "", "ref_images": [], "aspect": "",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            _ensure_item_schema(new_item)
            proj.setdefault(category, []).insert(0, new_item)

        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "item": new_item})

    def _handle_create_project(self, body):
        name = (body.get("name") or "").strip()
        if not name:
            return self._err(400, "Missing name")
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj = {"id": uuid.uuid4().hex[:16], "name": name,
                "image_prompts": [], "video_prompts": [], "skill_prompts": []}
        data.setdefault("projects", []).append(proj)
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "project": proj})

    def _handle_rename_project(self, body):
        project_id = body.get("projectId", "")
        name = (body.get("name") or "").strip()
        if not project_id:
            return self._err(400, "Missing projectId")
        if not name:
            return self._err(400, "Missing name")
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        proj = next((p for p in data.get("projects", []) if p["id"] == project_id), None)
        if not proj:
            return self._err(404, "Project not found")
        proj["name"] = name
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True})

    def _handle_delete_prompt(self, body):
        project_id = body.get("projectId", "")
        category = body.get("category", "")
        prompt_id = body.get("promptId", "")
        delete_media = bool(body.get("deleteMedia"))
        if category not in {"image_prompts", "video_prompts", "skill_prompts"}:
            return self._err(400, "Invalid category")

        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj = next((p for p in data.get("projects", []) if p.get("id") == project_id), None)
        if not proj:
            return self._err(404, "Project not found")
        items = proj.get(category, []) or []
        idx = next((i for i, item in enumerate(items) if item.get("id") == prompt_id), -1)
        if idx < 0:
            return self._err(404, "Prompt not found")

        media_refs = _item_upload_refs(items[idx])
        del items[idx]
        proj[category] = items

        media_result = {"files": 0, "bytes": 0, "deleted": [], "skipped": []}
        if delete_media and media_refs:
            media_result = _delete_upload_refs(media_refs, _data_upload_refs(data))

        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "media": media_result})

    def _handle_delete_project(self, body):
        project_id = body.get("projectId", "")
        delete_media = bool(body.get("deleteMedia"))

        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        projects = data.get("projects", []) or []
        proj = next((p for p in projects if p.get("id") == project_id), None)
        if not proj:
            return self._err(404, "Project not found")

        media_refs = set()
        for key in ("image_prompts", "video_prompts"):
            for item in proj.get(key, []) or []:
                media_refs.update(_item_upload_refs(item))

        data["projects"] = [p for p in projects if p.get("id") != project_id]
        media_result = {"files": 0, "bytes": 0, "deleted": [], "skipped": []}
        if delete_media and media_refs:
            media_result = _delete_upload_refs(media_refs, _data_upload_refs(data))

        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "media": media_result})

    def _handle_cleanup_media(self, _body):
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        media_result = _cleanup_unreferenced_uploads(data)
        self._json_resp({"ok": True, "media": media_result})

    def _handle_search_assets(self, query):
        q = (query.get("q", [""])[0] or "").strip()
        project_id = (query.get("projectId", [""])[0] or "").strip()
        item_type = (query.get("type", ["all"])[0] or "all").strip()
        limit = _as_int((query.get("limit", ["120"])[0] or "120"), default=120, min_value=1, max_value=500)
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        docs = _collect_docs(data)
        out = []
        for d in docs:
            if project_id and str(d.get("project_id", "")) != project_id:
                continue
            if item_type != "all" and str(d.get("type", "")) != item_type:
                continue
            score = _match_score(d, q) if q else 1
            if score <= 0:
                continue
            out.append({
                "id": d["id"],
                "project_id": d["project_id"],
                "project_name": d["project_name"],
                "category": d["category"],
                "type": d["type"],
                "title": d["title"],
                "tags": d["tags"],
                "model": d["model"],
                "prompt": d["prompt"][:400],
                "analysis": d["analysis"][:220],
                "created_at": d.get("created_at", ""),
                "updated_at": d.get("updated_at", ""),
                "quality": d.get("quality", {}),
                "lineage": d.get("lineage", {}),
                "score": score,
            })
        out.sort(key=lambda x: (x.get("score", 0), x.get("updated_at", "") or x.get("created_at", "")), reverse=True)
        self._json_resp({"ok": True, "query": q, "results": out[:limit], "total": len(out)})

    def _handle_detect_duplicates(self, query):
        project_id = (query.get("projectId", [""])[0] or "").strip()
        include_similar = (query.get("includeSimilar", ["1"])[0] or "1").strip() not in {"0", "false", "False"}
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        docs = _collect_docs(data)
        if project_id:
            docs = [d for d in docs if d.get("project_id") == project_id]

        exact_by_path = {}
        exact_by_sig = {}
        for d in docs:
            media_path = _extract_media_path(d)
            if media_path:
                exact_by_path.setdefault(media_path, []).append(d)
            sig = d.get("identity_sig", "")
            if sig:
                exact_by_sig.setdefault(sig, []).append(d)

        groups = []
        for source_map, reason in ((exact_by_path, "same_media_path"), (exact_by_sig, "same_signature")):
            for k, arr in source_map.items():
                if not k or len(arr) < 2:
                    continue
                refs = [{
                    "id": x["id"],
                    "project_id": x["project_id"],
                    "project_name": x["project_name"],
                    "category": x["category"],
                    "type": x["type"],
                    "title": x["title"],
                    "created_at": x.get("created_at", ""),
                    "updated_at": x.get("updated_at", ""),
                } for x in arr]
                groups.append({"reason": reason, "key": k, "count": len(refs), "items": refs})

        similar_pairs = []
        if include_similar:
            for i in range(len(docs)):
                a = docs[i]
                text_a = _normalize_text(a.get("prompt") or a.get("title"))
                if not text_a:
                    continue
                for j in range(i + 1, len(docs)):
                    b = docs[j]
                    if a.get("type") != b.get("type"):
                        continue
                    text_b = _normalize_text(b.get("prompt") or b.get("title"))
                    if not text_b:
                        continue
                    ratio = difflib.SequenceMatcher(None, text_a[:1800], text_b[:1800]).ratio()
                    if ratio >= 0.9:
                        similar_pairs.append({
                            "similarity": round(ratio, 4),
                            "a": {
                                "id": a["id"], "project_id": a["project_id"], "project_name": a["project_name"],
                                "category": a["category"], "type": a["type"], "title": a["title"],
                            },
                            "b": {
                                "id": b["id"], "project_id": b["project_id"], "project_name": b["project_name"],
                                "category": b["category"], "type": b["type"], "title": b["title"],
                            },
                        })
            similar_pairs.sort(key=lambda x: x["similarity"], reverse=True)

        self._json_resp({
            "ok": True,
            "projectId": project_id,
            "exact_groups": groups,
            "similar_pairs": similar_pairs[:120],
            "summary": {
                "items_scanned": len(docs),
                "exact_group_count": len(groups),
                "similar_pair_count": len(similar_pairs),
            }
        })

    def _handle_smart_folder_preview(self, query):
        folder_id = (query.get("id", [""])[0] or "").strip()
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        sf = _get_smart_folders()
        folder = next((f for f in sf.get("folders", []) if f.get("id") == folder_id), None)
        if not folder:
            return self._err(404, "Smart folder not found")
        docs = _collect_docs(data)
        matched = [d for d in docs if _apply_folder_rules(d, folder.get("rules", {}))]
        matched.sort(key=lambda x: (x.get("updated_at", "") or x.get("created_at", "")), reverse=True)
        self._json_resp({
            "ok": True,
            "folder": folder,
            "count": len(matched),
            "items": [{
                "id": x["id"],
                "project_id": x["project_id"],
                "project_name": x["project_name"],
                "category": x["category"],
                "type": x["type"],
                "title": x["title"],
                "model": x["model"],
                "tags": x["tags"],
                "quality": x["quality"],
                "lineage": x["lineage"],
                "updated_at": x.get("updated_at", ""),
                "created_at": x.get("created_at", ""),
            } for x in matched[:300]]
        })

    def _handle_save_smart_folders(self, body):
        saved = _save_smart_folders(body)
        self._json_resp({"ok": True, **saved})

    def _find_item_mut(self, data, project_id, category, item_id):
        projects = data.get("projects", []) or []
        proj = next((p for p in projects if p.get("id") == project_id), None)
        if not proj:
            return None, None
        if category not in {"image_prompts", "video_prompts", "skill_prompts"}:
            return proj, None
        items = proj.get(category, []) or []
        item = next((x for x in items if x.get("id") == item_id), None)
        return proj, item

    def _handle_asset_quality(self, body):
        project_id = body.get("projectId", "")
        category = body.get("category", "")
        item_id = body.get("itemId", "")
        quality_in = body.get("quality", {}) if isinstance(body.get("quality", {}), dict) else {}
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj, item = self._find_item_mut(data, project_id, category, item_id)
        if not proj or not item:
            return self._err(404, "Item not found")
        _ensure_item_schema(item)
        star = bool(quality_in.get("star", item["quality"].get("star", False)))
        rating = _as_int(quality_in.get("rating", item["quality"].get("rating", 0)), default=0, min_value=0, max_value=5)
        status = str(quality_in.get("status", item["quality"].get("status", ""))).strip()[:24]
        item["quality"] = {"star": star, "rating": rating, "status": status}
        item["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "quality": item["quality"], "itemId": item_id})

    def _handle_save_palette(self, body):
        project_id = body.get("projectId", "")
        category = body.get("category", "")
        item_id = body.get("itemId", "")
        palette = body.get("palette", [])
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj, item = self._find_item_mut(data, project_id, category, item_id)
        if not proj or not item:
            return self._err(404, "Item not found")
        item["palette_cache"] = palette
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._json_resp({"ok": True, "palette": palette, "itemId": item_id})

    def _handle_asset_lineage(self, body):
        project_id = body.get("projectId", "")
        category = body.get("category", "")
        item_id = body.get("itemId", "")
        lineage_in = body.get("lineage", {}) if isinstance(body.get("lineage", {}), dict) else {}
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj, item = self._find_item_mut(data, project_id, category, item_id)
        if not proj or not item:
            return self._err(404, "Item not found")
        _ensure_item_schema(item)
        lin = item.get("lineage", {})
        if not isinstance(lin.get("history"), list):
            lin["history"] = []
        source_id = str(lineage_in.get("source_id", lin.get("source_id", ""))).strip()
        version = _as_int(lineage_in.get("version", lin.get("version", 1)), default=1, min_value=1, max_value=9999)
        note = str(lineage_in.get("note", "")).strip()
        prev_vid = str(lin.get("version_id", ""))
        next_vid = _item_version_id(item)
        if note:
            lin["history"].insert(0, {
                "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "note": note[:240],
                "from_version_id": prev_vid,
                "to_version_id": next_vid,
            })
            lin["history"] = lin["history"][:100]
        lin["source_id"] = source_id
        lin["version"] = version
        lin["version_id"] = next_vid
        item["lineage"] = lin
        item["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "lineage": lin, "itemId": item_id})

    def _handle_export_bundle(self, body):
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        selected = body.get("selected", [])
        include_data_json = bool(body.get("includeDataJson", True))
        include_media = bool(body.get("includeMedia", True))
        include_prompts = bool(body.get("includePrompts", True))
        docs = _resolve_docs_by_refs(data, selected)
        if not docs:
            return self._err(400, "No valid selected items")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out_name = f"bundle-{stamp}-{uuid.uuid4().hex[:6]}.zip"
        out_path = EXPORT_DIR / out_name
        written_files = 0
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            manifest = {
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "items": docs,
                "includeMedia": include_media,
                "includePrompts": include_prompts,
            }
            z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            written_files += 1
            if include_prompts:
                prompt_lines = []
                for d in docs:
                    prompt_lines.append(f"# {d.get('title') or d.get('id')}")
                    prompt_lines.append(f"- 项目: {d.get('project_name')}")
                    prompt_lines.append(f"- 类型: {d.get('type')}")
                    prompt_lines.append(f"- 模型: {d.get('model')}")
                    prompt_lines.append(f"- 标签: {', '.join(d.get('tags', []))}")
                    prompt_lines.append("")
                    prompt_lines.append(d.get("prompt", ""))
                    prompt_lines.append("\n---\n")
                z.writestr("prompts.md", "\n".join(prompt_lines).strip() + "\n")
                written_files += 1
            if include_data_json:
                z.writestr("data.partial.json", json.dumps({"items": docs}, ensure_ascii=False, indent=2))
                written_files += 1
            if include_media:
                for d in docs:
                    media_candidates = []
                    if d.get("image"):
                        media_candidates.append(d.get("image"))
                    if d.get("video"):
                        media_candidates.append(d.get("video"))
                    for ref in d.get("ref_images", []) or []:
                        media_candidates.append(ref)
                    for media_url in media_candidates:
                        rel = _normalize_upload_ref(media_url)
                        if not rel:
                            continue
                        try:
                            target = _upload_target(rel)
                        except Exception:
                            continue
                        if not target.exists() or not target.is_file():
                            continue
                        arcname = f"media/{rel}"
                        try:
                            z.write(target, arcname=arcname)
                            written_files += 1
                        except Exception:
                            continue
        stat = out_path.stat()
        self._json_resp({
            "ok": True,
            "bundle": {
                "name": out_name,
                "path": str(out_path),
                "download_url": f"/exports/{out_name}",
                "size": stat.st_size,
                "files": written_files,
                "items": len(docs),
            }
        })

    def _handle_snapshot_create(self, body):
        note = str(body.get("note", "")).strip()[:120]
        stamp = time.strftime("%Y%m%d-%H%M%S")
        name_core = f"snapshot-{stamp}-{uuid.uuid4().hex[:6]}"
        out_path = SNAPSHOT_DIR / f"{name_core}.zip"
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("meta.json", json.dumps({
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "note": note,
                "data_file": DATA_FILE.name,
            }, ensure_ascii=False, indent=2))
            z.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=2))
            if CONFIG_FILE.exists():
                z.write(CONFIG_FILE, arcname="desktop_settings.json")
            if SMART_FOLDERS_FILE.exists():
                z.write(SMART_FOLDERS_FILE, arcname="smart_folders.json")
            if UPLOAD_DIR.exists():
                for fp in UPLOAD_DIR.rglob("*"):
                    if fp.is_file():
                        rel = fp.relative_to(UPLOAD_DIR).as_posix()
                        z.write(fp, arcname=f"uploads/{rel}")
        self._json_resp({"ok": True, "snapshot": {
            "name": out_path.name,
            "path": str(out_path),
            "size": out_path.stat().st_size,
            "note": note,
        }})

    def _handle_snapshot_restore(self, body):
        name = str(body.get("name", "")).strip()
        if not name:
            return self._err(400, "Missing snapshot name")
        target = (SNAPSHOT_DIR / name).resolve()
        try:
            target.relative_to(SNAPSHOT_DIR.resolve())
        except Exception:
            return self._err(400, "Invalid snapshot name")
        if not target.exists() or not target.is_file():
            return self._err(404, "Snapshot not found")
        try:
            with zipfile.ZipFile(target, "r") as z:
                names = set(z.namelist())
                if "data.json" not in names:
                    return self._err(400, "Invalid snapshot package")
                data_raw = z.read("data.json")
                data_obj = json.loads(data_raw.decode("utf-8"))
                data_obj, _ = _ensure_data_schema(data_obj)
                DATA_FILE.write_text(json.dumps(data_obj, ensure_ascii=False, indent=2), encoding="utf-8")
                if "desktop_settings.json" in names:
                    CONFIG_FILE.write_bytes(z.read("desktop_settings.json"))
                if "smart_folders.json" in names:
                    SMART_FOLDERS_FILE.write_bytes(z.read("smart_folders.json"))
                if UPLOAD_DIR.exists():
                    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
                UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
                for n in names:
                    if not n.startswith("uploads/") or n.endswith("/"):
                        continue
                    rel = n[len("uploads/"):]
                    out = (UPLOAD_DIR / rel).resolve()
                    try:
                        out.relative_to(UPLOAD_DIR.resolve())
                    except Exception:
                        continue
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(z.read(n))
        except Exception as e:
            return self._err(500, f"Restore failed: {e}")
        _sse_notify()
        self._json_resp({"ok": True, "restored": name})

    def _handle_gen_title(self, body):
        prompt   = (body.get("prompt") or "").strip()[:800]
        settings = _load_settings()
        api_key  = body.get("apiKey") or settings.get("imageApiKey") or settings.get("videoApiKey") or ""
        api_base = (body.get("apiBase") or settings.get("imageApiBase") or "https://api.openai.com/v1").rstrip("/")
        model    = body.get("model") or settings.get("imageModel") or settings.get("videoModel") or "gpt-4o-mini"
        if not prompt:
            return self._err(400, "Missing prompt")
        if not api_key:
            return self._err(400, "Missing apiKey")
        payload = json.dumps({
            "model": model,
            "temperature": 0.7,
            "messages": [
                {"role": "user", "content":
                    f"请根据下面这段 AI 绘图提示词，用一句极其直白、通俗的中文，概括出这张图片画了什么内容（核心主体 + 画面场景）。\n\n"
                    f"{prompt}\n\n"
                    f"【硬性要求】\n"
                    f"1. 必须使用大白话、通俗易懂地总结（例如：'和风霓虹少女海报'、'丛林遗迹废土风景' 这样直白、一眼能看懂画了什么的内容，绝对不要使用晦涩、文艺、矫情或华而不实的艺术词汇）。\n"
                    f"2. 字数必须控制在 4 到 12 个汉字之间。\n"
                    f"3. 只需要直接输出这几个字的标题文字本身，千万不要带任何标点、任何引号、引言、多余的字或解释。"
                }
            ]
        }).encode()
        req = urllib.request.Request(
            f"{api_base}/chat/completions",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                res_data = json.loads(resp.read().decode())
                title = res_data["choices"][0]["message"]["content"].strip()
                title = title.replace('"', '').replace('“', '').replace('”', '').replace('`', '')
                if not title:
                    return self._err(500, "大模型未能生成有效标题，API 实际返回为空。请检查设置中的模型名称是否支持。")
                return self._json_resp({"ok": True, "title": title})
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode('utf-8', errors='ignore')
            try:
                err_json = json.loads(err_msg)
                detail = err_json.get("error", {}).get("message", err_msg)
            except Exception:
                detail = err_msg
            return self._err(502, f"大模型接口服务报错 ({e.code}): {detail}")
        except socket.timeout:
            return self._err(504, "网络请求超时：大模型服务商响应过慢，请检查大模型网络或重试。")
        except urllib.error.URLError as e:
            if isinstance(e.reason, socket.timeout):
                return self._err(504, "网络请求超时：大模型服务商响应过慢，请检查大模型网络或重试。")
            return self._err(502, f"无法连接到大模型接口: {e.reason}")
        except Exception as e:
            return self._err(500, f"服务器内部错误: {str(e)}")

    def _handle_rewrite_prompt(self, body):
        original = (body.get("prompt") or "").strip()
        instruction = (body.get("instruction") or "").strip()
        if not original:
            return self._err(400, "Missing prompt")
        if not instruction:
            return self._err(400, "Missing instruction")
        settings = _load_settings()
        api_key = settings.get("llmApiKey") or settings.get("imageApiKey") or ""
        api_base = (settings.get("llmApiBase") or settings.get("imageApiBase") or "https://api.openai.com/v1").rstrip("/")
        model = settings.get("llmModel") or settings.get("imageModel") or "gpt-4o-mini"
        if not api_key:
            return self._err(400, "Missing API Key in desktop settings")
        payload = json.dumps({
            "model": model,
            "max_tokens": 20000,
            "temperature": 0.7,
            "messages": [
                {"role": "system", "content":
                    "你是一个 AI 绘图提示词改写助手。用户会给你一段原始提示词和一个修改指令。"
                    "请根据指令对原始提示词进行修改，保留原始结构和风格，只改变指令要求的部分。"
                    "只输出修改后的提示词，不要加任何解释、引号或前缀。"
                    "如果原始提示词是英文就输出英文，中文就输出中文。"},
                {"role": "user", "content": f"原始提示词：\n{original}\n\n修改指令：{instruction}"}
            ]
        }).encode()
        req = urllib.request.Request(
            f"{api_base}/chat/completions",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
            choice = data["choices"][0]
            result = (choice["message"]["content"] or "").strip()
            if choice.get("finish_reason") == "length":
                result += "\n\n⚠️ [输出被截断，提示词可能不完整]"
            self._json_resp({"ok": True, "prompt": result})
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:   msg = (json.loads(raw).get("error") or {}).get("message") or raw[:200]
            except: msg = raw[:200]
            self._err(502, f"AI API {e.code}: {msg}")
        except Exception as e:
            self._err(502, str(e))

    def _handle_save_media(self, body):
        url        = body.get("url", "")
        media_type = body.get("mediaType", "")
        project_id = body.get("projectId", "")
        category   = body.get("category", "image_prompts")
        title         = body.get("title", "")
        prompt        = body.get("prompt", "")
        aspect        = body.get("aspect", "")
        analysis      = body.get("analysis", "")
        model         = body.get("model", "")
        tags          = body.get("tags", [])
        outfit_prompt = body.get("outfit_prompt", "")
        char_prompt   = body.get("char_prompt", "")
        scene_prompt  = body.get("scene_prompt", "")
        style_prompt  = body.get("style_prompt", "")
        cam_prompt    = body.get("cam_prompt", "")
        referer       = body.get("referer") or body.get("pageUrl") or ""
        cookie        = body.get("cookie", "")

        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        data, changed = _ensure_data_schema(data)
        if changed:
            DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        proj = next((p for p in data.get("projects", []) if p["id"] == project_id), None)
        if not proj:
            return self._err(404, "Project not found")

        # Download media
        raw = None
        forced_ext = ""
        ct = ""
        try:
            if url.startswith("/uploads/"):
                rel_in = unquote(url[len("/uploads/"):]).replace("\\", "/")
                local_path = (UPLOAD_DIR / rel_in).resolve()
                local_path.relative_to(UPLOAD_DIR.resolve())
                raw = local_path.read_bytes()
                ct = mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"
                forced_ext = local_path.suffix.lower()
            elif url.startswith("data:"):
                m = re.match(r"data:([^;]+);base64,(.+)", url, re.DOTALL)
                if m:
                    ct = m.group(1)
                    raw = base64.b64decode(m.group(2))
                    forced_ext = mimetypes.guess_extension(ct) or ".jpg"
            else:
                if not media_type:
                    media_type = "video" if category == "video_prompts" else "image"
                raw, ct, forced_ext = _download_remote_media(
                    url, media_type=media_type, referer=referer, cookie=cookie,
                    page_url=body.get("pageUrl", ""),
                    timeout=120 if media_type == "video" else 30
                )
        except Exception as e:
            print(f"[save-media] Warning: download failed for {url}. Error: {e}")
            label = "视频" if (media_type == "video" or category == "video_prompts") else "图片"
            return self._err(502, f"{label}下载失败，未写入远端 URL：{e}")

        if raw:
            url_ext = _url_ext(url)
            is_video = (
                media_type == "video"
                or category == "video_prompts"
                or "video" in (ct or "")
                or url_ext in VIDEO_EXTS
                or forced_ext in VIDEO_EXTS
            )
            url_ext_ok = url_ext if url_ext in VIDEO_EXTS or url_ext in IMAGE_EXTS else ""
            mime_ext = "" if (ct == "application/octet-stream" and is_video) else (mimetypes.guess_extension(ct) or "")
            ext = forced_ext or url_ext_ok or mime_ext or (".mp4" if is_video else ".jpg")
            if ext == ".m3u8":
                ext = ".ts"
            ext = ext.replace(".jpe", ".jpg")
            proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj.get("name","default"))[:40]
            sub = "videos" if is_video else "images"
            save_dir = UPLOAD_DIR / proj_folder / sub
            save_dir.mkdir(parents=True, exist_ok=True)
            stem = f"clip_{uuid.uuid4().hex[:8]}"
            out_path = save_dir / f"{stem}{ext}"
            out_path.write_bytes(raw)
            rel = f"/uploads/{proj_folder}/{sub}/{out_path.name}"
        else:
            label = "视频" if (media_type == "video" or category == "video_prompts") else "图片"
            return self._err(400, f"{label}内容为空，未保存")

        item_id = uuid.uuid4().hex[:16]
        new_item = {
            "id": item_id, "title": title or stem,
            "prompt": prompt, "model": model, "tags": tags,
            "image": rel if sub == "images" else "",
            "video": rel if sub == "videos" else "",
            "ref_images": [], "aspect": aspect, "analysis": analysis,
            "outfit_prompt": outfit_prompt, "char_prompt": char_prompt,
            "scene_prompt": scene_prompt, "style_prompt": style_prompt,
            "cam_prompt": cam_prompt,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
        }
        source = _source_meta_from_body(body, media_url=url, saved_path=rel)
        if source:
            new_item["source"] = source
        _ensure_item_schema(new_item)
        proj.setdefault(category, []).insert(0, new_item)
        DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _sse_notify()
        self._json_resp({"ok": True, "item": new_item})

    def _handle_reverse_prompt(self, body):
        url      = body.get("url", "")
        media_type = body.get("mediaType", "image")   # 'image' | 'video'
        settings = _load_settings()
        is_video = media_type == "video"
        api_key  = body.get("apiKey") or (settings.get("videoApiKey") if is_video else settings.get("imageApiKey")) or ""
        api_base = (
            body.get("apiBase")
            or (settings.get("videoApiBase") if is_video else settings.get("imageApiBase"))
            or "https://api.openai.com/v1"
        ).rstrip("/")
        model    = body.get("model") or (settings.get("videoModel") if is_video else settings.get("imageModel")) or "gpt-4o"
        lang     = body.get("lang", "zh")
        referer  = body.get("referer") or body.get("pageUrl") or ""
        cookie   = body.get("cookie", "")
        video_upload_timeout = _as_int(
            body.get("videoUploadTimeoutSec") or settings.get("videoUploadTimeoutSec") or 240,
            default=240, min_value=60, max_value=1800
        )
        video_upload_retries = _as_int(
            body.get("videoUploadRetries") or settings.get("videoUploadRetries") or 1,
            default=1, min_value=0, max_value=5
        )

        if not api_key:
            return self._err(400, "Missing apiKey")

        img_w = int(body.get("imgWidth")  or 0)
        img_h = int(body.get("imgHeight") or 0)

        def _aspect_note(w, h):
            if not w or not h: return ""
            from math import gcd
            g = gcd(w, h); rw, rh = w // g, h // g
            # Simplify over-complex ratios to nearest common
            common = [(1,1),(4,3),(3,2),(16,9),(21,9),(2,1),(3,4),(2,3),(9,16)]
            best = min(common, key=lambda r: abs(r[0]/r[1] - rw/rh))
            orient = "竖版" if h > w else ("横版" if w > h else "方形")
            return f"【图片实际尺寸】{w}×{h}px，比例约 {best[0]}:{best[1]}，{orient}画幅。请直接使用此数据描述画幅，无需从画面猜测。\n"

        dim_note = _aspect_note(img_w, img_h)

        default_instruction = settings.get("videoReverseInstruction") if is_video else settings.get("imageReverseInstruction")
        custom = (body.get("customInstruction") or default_instruction or "").strip()
        if custom:
            prompt_instruction = dim_note + custom
        elif lang == "zh":
            prompt_instruction = dim_note + (
                "【第一步：判断图片类型】先判断这张图属于哪种类型，然后按对应规则输出提示词：\n"
                "A. 角色设定参考图（Character Reference Sheet）：图中包含多视角立绘、表情图、道具图、配色板、数值/文字说明区块等——输出：①整体类型说明（character reference sheet, multi-view layout）②版式结构（有哪些区块、排列方式）③角色完整外观（整合所有视角信息）④画风与渲染风格⑤配色方案⑥武器/道具/配件⑦所有文字区块的内容摘要\n"
                "B. 漫画页/分格图（Comic/Manga Page）：图中包含多个面板/格子，有对话框或叙事性连续画面——输出：①分格数量与布局②每格内容摘要③整体画风④对话框样式\n"
                "C. 信息图/海报/UI截图（Infographic/Poster/UI）：以文字、图表、排版为主要内容——输出：①整体设计类型②版式结构③主要视觉元素④字体与配色风格\n"
                "D. 单张插画/摄影（普通图）：单一场景、单张人像或风景——按以下5段输出：\n"
                "请仔细分析这个媒体内容，生成一段结构化的中文AI生成提示词，按以下5个段落依次输出，段落之间空一行：\n"
                "【画风】按以下顺序判断并输出：①【第一步：渲染真实度】是否存在真实皮肤质感（毛孔/次表面散射）、真实布料纹理、真实光源？→若是：输出 hyperrealistic anime / photorealistic anime illustration，渲染技术为 PBR-based rendering + anime aesthetics，不得误写赛璐璐/厚涂；→若否：继续下步②【第二步：描线】有明显黑色描边→thick outlines/lineart，无描边→no outlines③【第三步：着色】平涂→cel-shading/flat shading，厚涂→painterly，写实→PBR/photo-real④【第四步：作品引用】仅当明确识别时才引用具体作品/游戏/动漫/电影/艺术家，不确定则写通用风格描述，绝对不得猜测⑤绘画/摄影类型（anime/concept art/oil painting/3D CG/landscape photography等英文关键词）⑥精细度（highly detailed/photorealistic/semi-realistic/stylized等）。\n"
                "【主体】先判断画面类型——若有人物：每个人物单独说明：①画面位置（左/中/右、前景/中景/背景）②面朝方向（正面朝向镜头/斜45度小侧脸/正侧面/斜45度背面/完全背对镜头）③若多人则描述站位关系及互动④外貌特征（发型发色/脸部/肤色/表情）⑤姿态动作——【重要：描述四肢必须用画面方位，例如：画面右侧的手握着.../画面左侧的腿踩在...，禁止说左手/右脚，因为角色面对镜头时人体左右与画面左右相反，AI容易判断错误】⑥【服装从头到脚逐部位，不得遗漏】头饰→颈部→上衣/外套/内搭→手部/臂部→下装→腰带→袜子/腿部→鞋子（每部位写款式/颜色/材质）⑦【铁律：画面中所有道具/物品一个不漏】每件物品写清：名称/颜色/款式/上面的文字标识/位置（握在画面某侧手/靠在某处/踩在某物上等），不得一笔带过。若无人物（风景/建筑/静物）：描述①主体是什么②形态特征③位置占比④受光状态⑤视觉焦点。\n"
                "【镜头】①景别（大远景/远景/全景/中景/中近景/近景/特写/大特写）②垂直视角（仰视感→低角度仰拍；俯视感→高角度俯拍；否则→平视）③水平视角（正面/正侧面/斜45°/背面/过肩）④焦距感（鱼眼/超广角/广角/标准/中长焦/长焦/超长焦）⑤景深与散景（浅/中/深，虚化程度）⑥透视感（强透视/正常/压缩透视）⑦构图方式（居中/三分法/对角线/框架/引导线等）⑧画幅（竖版/横版/方形/宽银幕及比例）⑨镜头特效（光晕/眩光/色散/暗角，有则描述）。\n"
                "【场景】环境类型与具体设定、前景/中景/背景的层次关系、空间纵深感、背景元素细节、主体与背景距离关系、时间/天气/季节氛围。\n"
                "【色调光影】整体色调与主配色、光源位置与性质（硬光/软光/侧光/顶光/逆光/漫射光等）、光影对比强度、高光与暗部表现、材质质感的光效体现、整体氛围。\n"
                "【准确性第一原则】：严格基于图片中真实可见的内容，不猜测、不补脑。直接输出提示词，不需要任何额外说明。"
            )
        else:
            prompt_instruction = (
                "Analyze this media and generate a detailed AI generation prompt that would recreate it. "
                "Include subject, style, lighting, composition, colors, camera details. "
                "Output only the prompt, no explanations."
            )

        # 强制格式约束，仅当使用系统默认指令时，才拼上标准的 JSON 结构，从而 100% 提取出标题、视觉报告
        if not custom:
            json_suffix = (
                "\n\n【重要格式要求】请务必将你的全部分析结果整理并以标准的 JSON 格式返回，不要带有任何多余的解释，必须以 '{' 开头和 '}' 结尾。JSON 格式如下：\n"
                "{\n"
                '  "title": "请为这张图/视频起一个简短、有意境的创意中文标题（15字以内）",\n'
                '  "reversePrompt": "这是根据画面提炼出的、用于AI重新生成该媒体的最终核心英文提示词（即作为 SD/Midjourney 绘图的 Prompt）",\n'
                '  "coreExpression": "对媒体核心情感、主题与艺术表达的简要提炼",\n'
                '  "style": "分析画风、媒介类型、精细度、描线、着色风格等",\n'
                '  "subject": "分析画面中的主体人物、外貌、姿态、动作、服装细节与道具细节",\n'
                '  "camera": "分析镜头景别、视角、焦距感、透视与构图方式",\n'
                '  "scene": "分析环境类型、场景层次、背景元素与空间纵深感",\n'
                '  "lighting": "分析整体色调、光源、光影对比与材质质感"\n'
                "}\n"
                "注意：必须输出标准的、无任何语法错误的合法 JSON 字符串，确保可以直接被 json.loads 解析。"
            )
            prompt_instruction += json_suffix

        # Download media
        try:
            if url.startswith("/uploads/"):
                rel = unquote(url[len("/uploads/"):]).replace("\\", "/")
                local_path = (UPLOAD_DIR / rel).resolve()
                local_path.relative_to(UPLOAD_DIR.resolve())
                raw = local_path.read_bytes()
                ct = mimetypes.guess_type(str(local_path))[0] or ("video/mp4" if media_type == "video" else "image/jpeg")
            else:
                raw, ct, _forced_ext = _download_remote_media(
                    url, media_type=media_type, referer=referer, cookie=cookie,
                    timeout=120 if media_type == "video" else 60
                )
        except Exception as e:
            return self._err(502, f"Download failed: {e}")

        b64 = base64.b64encode(raw).decode()

        # Use native Gemini API only when pointing at Google's endpoint
        # Third-party proxies (yunwu.ai, etc.) use OpenAI-compatible path even with gemini models
        use_gemini = "generativelanguage.googleapis.com" in api_base

        try:
            if use_gemini and media_type == "video":
                result_text = self._gemini_reverse_video(
                    raw, ct, api_key, model, prompt_instruction,
                    upload_timeout=video_upload_timeout,
                    upload_retries=video_upload_retries
                )
            elif use_gemini:
                result_text = self._gemini_reverse_image(b64, ct, api_key, model, prompt_instruction)
            else:
                result_text = self._openai_reverse(
                    b64, ct, api_base, api_key, model, prompt_instruction, media_type=media_type
                )
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                j = json.loads(raw)
                # OpenAI: {"error":{"message":"..."}}
                # Gemini: {"error":{"message":"..."}}
                msg = (j.get("error") or {}).get("message") or raw[:400]
            except Exception:
                msg = raw[:400]
            return self._err(502, f"AI API {e.code} {e.reason}: {msg}")
        except Exception as e:
            if is_video and _is_timeout_error(e):
                if use_gemini:
                    return self._err(
                        504,
                        f"AI API timeout: 视频反推请求超时。"
                        f"当前上传超时阈值为 {video_upload_timeout}s，可在桌面端设置中调大，或缩短/压缩视频后重试。原始错误: {e}"
                    )
                return self._err(
                    504,
                    "AI API timeout: 非 Gemini 接口视频反推超时。"
                    "这通常是第三方 OpenAI 兼容接口不支持视频输入、或视频体积限制导致。"
                    "请确认该地址支持 `video_url` 输入并放宽上传限制，或改用 Gemini 官方地址。"
                    f"原始错误: {e}"
                )
            return self._err(502, f"AI API error: {e}")

        # If the AI returned a JSON art-brief structure, extract fields
        final_text  = result_text
        auto_title  = ""
        analysis    = ""
        stripped = result_text.strip()
        # Strip markdown code fences (```json ... ``` or ``` ... ```)
        if stripped.startswith("```"):
            stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
            stripped = re.sub(r"\n?```$", "", stripped).strip()
        if stripped.startswith("{"):
            try:
                obj = json.loads(stripped)
                if "reversePrompt" in obj:
                    final_text = obj["reversePrompt"]
                if "title" in obj:
                    auto_title = str(obj["title"]).strip()
                analysis = _format_art_brief(obj)
            except Exception:
                pass  # not valid JSON, use raw text as-is

        # 如果没有成功解析出 JSON（比如用户使用了自定义指令），我们智能使用正则尝试从纯文本里分流出标题和报告
        if not auto_title or not analysis:
            # 1. 寻找可能存在的标题：形如 【标题】或 标题: 或 Title:
            title_patterns = [
                r"(?:【标题】|标题[:：]|Title[:：])\s*([^\n]+)",
                r"^#\s*([^\n]+)", # markdown 一级标题
            ]
            for pat in title_patterns:
                m = re.search(pat, result_text, re.IGNORECASE)
                if m:
                    auto_title = m.group(1).strip()
                    # 移掉纯文本里的标题行，让提示词干净
                    final_text = re.sub(re.escape(m.group(0)), "", final_text)
                    break

            # 2. 寻找可能存在的视觉报告：形如 【视觉分析】或 【分析】或 分析[:：]
            analysis_patterns = [
                r"(?:【视觉分析报告】|【分析报告】|【分析】|视觉分析[:：]|分析报告[:：]|分析[:：]|Analysis[:：])\s*([\s\S]+)$"
            ]
            for pat in analysis_patterns:
                m = re.search(pat, result_text, re.IGNORECASE)
                if m:
                    analysis = m.group(1).strip()
                    # 移掉纯文本里的分析报告部分，保证提示词主框内只有纯净的描述语
                    final_text = final_text.replace(m.group(0), "").strip()
                    break

        resp = {"ok": True, "prompt": final_text}
        if auto_title: resp["title"]    = auto_title
        if analysis:   resp["analysis"] = analysis
        try:
            self._json_resp(resp)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _openai_reverse(self, b64, ct, api_base, api_key, model, instruction, media_type="image"):
        # Normalize mime for OpenAI-compatible payloads
        if media_type == "video":
            if not ct or ct in {"application/octet-stream", "binary/octet-stream"}:
                ct = "video/mp4"
            media_part = {"type": "video_url", "video_url": {"url": f"data:{ct};base64,{b64}"}}
        else:
            ct_map = {"image/jpg": "image/jpeg", "image/jpe": "image/jpeg"}
            ct = ct_map.get(ct, ct)
            media_part = {"type": "image_url", "image_url": {"url": f"data:{ct};base64,{b64}"}}

        payload = json.dumps({
            "model": model,
            "max_tokens": 4096,
            "messages": [{"role": "user", "content": [
                media_part,
                {"type": "text", "text": instruction}
            ]}]
        }).encode()
        req = urllib.request.Request(
            f"{api_base}/chat/completions", data=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        return data["choices"][0]["message"]["content"].strip()

    def _gemini_reverse_image(self, b64, ct, api_key, model, instruction):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = json.dumps({"contents": [{"parts": [
            {"inline_data": {"mime_type": ct, "data": b64}},
            {"text": instruction}
        ]}], "generationConfig": {"maxOutputTokens": 4096}}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()

    def _gemini_reverse_video(self, raw, ct, api_key, model, instruction, upload_timeout=240, upload_retries=1):
        # Step 1: upload to Gemini Files API
        size = len(raw)
        init_url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}"
        meta = json.dumps({"file": {"display_name": "clip", "mime_type": ct}}).encode()
        upload_url = None
        for attempt in range(upload_retries + 1):
            req = urllib.request.Request(init_url, data=meta, headers={
                "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(size),
                "X-Goog-Upload-Header-Content-Type": ct, "Content-Type": "application/json"
            }, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    upload_url = r.headers.get("X-Goog-Upload-URL")
                break
            except Exception:
                if attempt >= upload_retries:
                    raise
                time.sleep(min(2 * (attempt + 1), 6))
        if not upload_url:
            raise RuntimeError("No upload URL from Gemini Files API")

        file_info = None
        for attempt in range(upload_retries + 1):
            req2 = urllib.request.Request(upload_url, data=raw, headers={
                "Content-Length": str(size),
                "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize"
            }, method="POST")
            try:
                with urllib.request.urlopen(req2, timeout=upload_timeout) as r:
                    file_info = json.loads(r.read())
                break
            except Exception:
                if attempt >= upload_retries:
                    raise
                time.sleep(min(2 * (attempt + 1), 6))
        if not file_info:
            raise RuntimeError("Gemini upload failed without response")
        file_uri = file_info["file"]["uri"]

        # Step 2: wait for file to be ACTIVE
        for _ in range(20):
            check_url = f"https://generativelanguage.googleapis.com/v1beta/files/{file_uri.split('/')[-1]}?key={api_key}"
            with urllib.request.urlopen(check_url, timeout=10) as r:
                fdata = json.loads(r.read())
            if fdata.get("state") == "ACTIVE":
                break
            time.sleep(3)

        # Step 3: generate content
        gen_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = json.dumps({"contents": [{"parts": [
            {"file_data": {"mime_type": ct, "file_uri": file_uri}},
            {"text": instruction}
        ]}]}).encode()
        req3 = urllib.request.Request(gen_url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req3, timeout=120) as r:
            data = json.loads(r.read())
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()

    def _handle_download_video(self, body):
        """Download a remote video/stream URL via ffmpeg and save to uploads."""
        import subprocess as _sp
        data = body if isinstance(body, dict) else json.loads(body)
        video_url  = data.get("url", "").strip()
        project_id = data.get("projectId", "")
        referer    = data.get("referer", "")
        cookie     = data.get("cookie", "")
        page_url   = data.get("pageUrl", "") or referer

        if not video_url:
            self._json_resp({"ok": False, "error": "no_url"}); return

        resolved_headers = None
        xpc_page_url = page_url if _is_xinpianchang_page(page_url) else (video_url if _is_xinpianchang_page(video_url) else "")
        if xpc_page_url:
            try:
                resolved = _resolve_xinpianchang_video(xpc_page_url)
                if resolved:
                    video_url = resolved["url"]
                    referer = xpc_page_url
                    resolved_headers = resolved.get("headers") or {}
            except Exception as exc:
                self._json_resp({"ok": False, "error": f"xinpianchang_resolve_failed: {exc}"})
                return

        proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", project_id)[:40] or "default"
        save_dir = UPLOAD_DIR / proj_folder / "videos"
        save_dir.mkdir(parents=True, exist_ok=True)

        stem     = f"video_{int(time.time())}"
        direct_ext = _url_ext(video_url)
        out_path = save_dir / f"{stem}{direct_ext if direct_ext in VIDEO_EXTS and direct_ext not in {'.m3u8', '.mpd', '.ts'} else '.mp4'}"

        is_dash = re.search(r'\.mpd([?#]|$)', video_url, re.I) is not None
        is_hls  = re.search(r'\.(m3u8|ts)([?#]|$)', video_url, re.I) is not None

        browser_ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
        origin = ""
        if referer:
            try:
                u = urlparse(referer)
                if u.scheme and u.netloc:
                    origin = f"{u.scheme}://{u.netloc}"
            except Exception:
                origin = ""

        if not is_dash and not is_hls:
            try:
                headers = resolved_headers or _media_headers("video", referer, cookie)
                host = urlparse(video_url).netloc.lower()
                if "xpccdn.com" in host or "xinpianchang" in host:
                    headers["Range"] = "bytes=0-"
                req = urllib.request.Request(video_url, headers=headers)
                with urllib.request.urlopen(req, timeout=180) as resp, open(out_path, "wb") as f:
                    shutil.copyfileobj(resp, f, length=1024 * 1024)
                if out_path.exists() and out_path.stat().st_size > 0:
                    self._json_resp({
                        "ok": True,
                        "path": f"/uploads/{proj_folder}/videos/{out_path.name}",
                        "filename": out_path.name,
                        "size": out_path.stat().st_size
                    })
                else:
                    if out_path.exists(): out_path.unlink(missing_ok=True)
                    self._json_resp({"ok": False, "error": "download_empty"})
                return
            except Exception as exc:
                if out_path.exists(): out_path.unlink(missing_ok=True)
                # Fall through to ffmpeg for odd direct-looking URLs.
                direct_error = str(exc)

        ff = find_ffmpeg()
        if not ff:
            self._json_resp({"ok": False, "error": "ffmpeg_not_found",
                             "detail": locals().get("direct_error", ""),
                             "install": _ffmpeg_install}); return

        cmd = [ff, "-y", "-loglevel", "error"]
        extra_headers = f"User-Agent: {browser_ua}\r\nAccept: video/*,audio/*,*/*;q=0.8\r\n"
        if origin: extra_headers += f"Origin: {origin}\r\n"
        if referer: extra_headers += f"Referer: {referer}\r\n"
        if cookie:  extra_headers += f"Cookie: {cookie}\r\n"
        cmd += ["-user_agent", browser_ua]
        if extra_headers:
            cmd += ["-headers", extra_headers]
        if is_dash:
            # ffmpeg's DASH demuxer has a hardcoded manifest size limit (~100KB).
            # Bypass completely: Python parses the MPD, downloads every segment,
            # then ffmpeg only does the final audio+video merge.
            try:
                import xml.etree.ElementTree as _ET
                import urllib.request as _ur

                _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

                def _fetch(url):
                    _r2 = _ur.Request(url)
                    _r2.add_header('User-Agent', _UA)
                    if referer: _r2.add_header('Referer', referer)
                    if cookie:  _r2.add_header('Cookie', cookie)
                    with _ur.urlopen(_r2, timeout=120) as _rr:
                        return _rr.read()

                # 1. Download MPD (Python has no size limit)
                _mpd_bytes = _fetch(video_url)

                # 2. Parse MPD XML
                _root = _ET.fromstring(_mpd_bytes)
                _tag0 = _root.tag
                _ns = _tag0[1:_tag0.index('}')] if _tag0.startswith('{') else ''
                def _T(name): return f'{{{_ns}}}{name}' if _ns else name

                _base = video_url.rsplit('?', 1)[0].rsplit('/', 1)[0] + '/'
                _base_el = _root.find(f'.//{_T("BaseURL")}')
                if _base_el is not None and (_base_el.text or '').strip():
                    _b = _base_el.text.strip()
                    _base = _b if _b.startswith('http') else _base + _b

                def _abs(rel):
                    return rel if rel.startswith('http') else _base + rel

                # 3. Find best video + audio AdaptationSets
                _tracks = {}

                def _tmpl_apply(tmpl, rep_id, num=None):
                    t = tmpl.replace('$RepresentationID$', str(rep_id))
                    if num is not None:
                        t = re.sub(r'\$Number%0?(\d+)d\$', lambda m: str(num).zfill(int(m.group(1))), t)
                        t = t.replace('$Number$', str(num))
                    return t

                for _aset in _root.findall(f'.//{_T("AdaptationSet")}'):
                    # Determine type: mimeType or contentType on AdaptationSet
                    _mime = (_aset.get('mimeType') or _aset.get('contentType') or '').lower()
                    _kind = 'video' if 'video' in _mime else ('audio' if 'audio' in _mime else None)

                    # Fallback: check first Representation's mimeType or codecs
                    if not _kind:
                        _fr = _aset.find(f'{_T("Representation")}')
                        if _fr is not None:
                            _rm = (_fr.get('mimeType') or _fr.get('codecs') or '').lower()
                            _kind = 'video' if ('video' in _rm or _rm.startswith(('avc','hvc','hevc','vp9','av1'))) \
                                    else ('audio' if ('audio' in _rm or _rm.startswith(('mp4a','ac-3','ec-3','opus','flac'))) else None)

                    if not _kind:
                        continue

                    _reps = _aset.findall(f'{_T("Representation")}')
                    _best = max(_reps, key=lambda r: int(r.get('bandwidth', 0)), default=None)
                    if _best is None:
                        continue
                    _rep_id = _best.get('id', '')

                    # Try SegmentList (check rep → adaptation set)
                    _sl = _best.find(f'{_T("SegmentList")}') or _aset.find(f'{_T("SegmentList")}')
                    if _sl is not None:
                        _init_el = _sl.find(f'{_T("Initialization")}')
                        _init = _abs(_init_el.get('sourceURL', '')) if _init_el is not None else None
                        _segs = [_abs(s.get('media', '')) for s in _sl.findall(f'{_T("SegmentURL")}') if s.get('media')]
                        if _segs:
                            _tracks[_kind] = {'init': _init, 'segs': _segs}
                        continue

                    # Try SegmentTemplate (check rep → adaptation set → period → root)
                    _st = (_best.find(f'{_T("SegmentTemplate")}') or
                           _aset.find(f'{_T("SegmentTemplate")}') or
                           _root.find(f'.//{_T("SegmentTemplate")}'))
                    if _st is not None:
                        _init_tmpl = _st.get('initialization', '')
                        _media_tmpl = _st.get('media', '')
                        _start_num = int(_st.get('startNumber', 1))
                        _init = _abs(_tmpl_apply(_init_tmpl, _rep_id)) if _init_tmpl else None
                        _segs = []
                        _tl = _st.find(f'{_T("SegmentTimeline")}')
                        if _tl is not None:
                            _n = _start_num
                            for _s in _tl.findall(f'{_T("S")}'):
                                for _ in range(int(_s.get('r', 0)) + 1):
                                    _segs.append(_abs(_tmpl_apply(_media_tmpl, _rep_id, _n)))
                                    _n += 1
                        if _segs:
                            _tracks[_kind] = {'init': _init, 'segs': _segs}

                if not _tracks:
                    _rep_tag = _T("Representation")
                    _aset_tag = _T("AdaptationSet")
                    _dbg = '; '.join(
                        'aset[' + str(i) + '] mime=' + a.get('mimeType','') + ' ct=' + a.get('contentType','') + ' reps=' + str(len(a.findall(_rep_tag)))
                        for i, a in enumerate(_root.findall('.//' + _aset_tag))
                    )
                    raise Exception('MPD 中未找到可下载的流. AdaptationSets: [' + _dbg + ']')

                # 4. Download segments and concatenate per track
                def _dl_track(kind, info):
                    _tp = save_dir / f"{stem}_{kind}.mp4"
                    with open(_tp, 'wb') as _tf:
                        if info.get('init'):
                            _tf.write(_fetch(info['init']))
                        for _su in info['segs']:
                            _tf.write(_fetch(_su))
                    return _tp

                _vid_path = _dl_track('video', _tracks['video']) if 'video' in _tracks else None
                _aud_path = _dl_track('audio', _tracks['audio']) if 'audio' in _tracks else None

                # 5. Merge with ffmpeg
                if _vid_path and _aud_path:
                    _mc = [ff, '-y', '-loglevel', 'error',
                           '-i', str(_vid_path), '-i', str(_aud_path),
                           '-c', 'copy', str(out_path)]
                elif _vid_path:
                    _mc = [ff, '-y', '-loglevel', 'error',
                           '-i', str(_vid_path), '-c', 'copy', str(out_path)]
                else:
                    raise Exception('未找到视频轨道')

                _mr = _sp.run(_mc, capture_output=True, timeout=120)
                for _p in [_vid_path, _aud_path]:
                    if _p and _p.exists():
                        try: _p.unlink()
                        except Exception: pass

                if _mr.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                    self._json_resp({"ok": True,
                                     "path": f"/uploads/{proj_folder}/videos/{out_path.name}",
                                     "filename": out_path.name,
                                     "size": out_path.stat().st_size})
                else:
                    _err = (_mr.stderr or b'').decode('utf-8', errors='replace')[-600:]
                    if out_path.exists(): out_path.unlink(missing_ok=True)
                    self._json_resp({"ok": False, "error": _err or "ffmpeg_merge_failed"})
            except Exception as _de:
                self._json_resp({"ok": False, "error": f"dash_download_failed: {_de}"})
            return

        if is_hls:
            cmd += ["-i", video_url, "-c", "copy", "-bsf:a", "aac_adtstoasc", str(out_path)]
        else:
            cmd += ["-i", video_url, "-c", "copy", "-bsf:a", "aac_adtstoasc", str(out_path)]

        try:
            result = _sp.run(cmd, capture_output=True, timeout=600)
            if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                self._json_resp({
                    "ok": True,
                    "path": f"/uploads/{proj_folder}/videos/{out_path.name}",
                    "filename": out_path.name,
                    "size": out_path.stat().st_size
                })
            else:
                err = (result.stderr or b"").decode("utf-8", errors="replace")[-600:]
                if out_path.exists(): out_path.unlink(missing_ok=True)
                self._json_resp({"ok": False, "error": err or "ffmpeg_failed"})
        except _sp.TimeoutExpired:
            self._json_resp({"ok": False, "error": "timeout_600s"})
        except Exception as exc:
            self._json_resp({"ok": False, "error": str(exc)})

    def _handle_import_bundle(self):
        """Import a ZIP bundle exported by export-bundle. Extracts media, returns metadata for client merge."""
        import zipfile, io
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            proj_raw = unquote(self.headers.get("X-Project", "default") or "default")
            proj_folder = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", proj_raw)[:40] or "default"
            zf = zipfile.ZipFile(io.BytesIO(raw))
            meta = None
            extracted_files = {}
            partial_meta = None
            for name in zf.namelist():
                if name in ("manifest.json", "metadata.json") or name.endswith("metadata.json"):
                    if meta is None:
                        meta = json.loads(zf.read(name))
                elif name == "data.partial.json":
                    if partial_meta is None:
                        partial_meta = json.loads(zf.read(name))
                elif not name.endswith("/"):
                    parts = name.split("/")
                    # strip leading "media/" folder
                    if parts[0] == "media" and len(parts) > 1:
                        rel = "/".join(parts[1:])
                    else:
                        rel = "/".join(parts[1:]) if len(parts) > 1 else name
                    if not rel:
                        continue
                    import pathlib as _pl
                    filename = _pl.Path(rel).name
                    out_dir = UPLOAD_DIR / proj_folder
                    out_path = out_dir / filename
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    out_path.write_bytes(zf.read(name))
                    new_rel = f"/uploads/{proj_folder}/{filename}"
                    # map both /uploads/original_rel and /old_flat variants
                    extracted_files["/uploads/" + rel] = new_rel
                    extracted_files["/" + rel.replace("/", "_")] = new_rel
                    extracted_files["/" + rel] = new_rel
            if meta is None and partial_meta is not None:
                meta = partial_meta
            zf.close()
            self._json_resp({"ok": True, "meta": meta, "file_map": extracted_files})
        except Exception as e:
            self._err(500, f"Import failed: {e}")

    def _handle_cli_docs(self, query):
        """GET /api/cli/docs?project=<name|id>&q=keyword&limit=100"""
        project_ref = (query.get("project") or [""])[0]
        q           = (query.get("q") or [""])[0].lower().strip()
        limit       = int((query.get("limit") or ["200"])[0])
        data        = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        results = []
        for proj in data.get("projects", []):
            if project_ref and project_ref not in (proj["id"], proj["name"]):
                continue
            for doc in proj.get("pdf_files", []):
                if doc.get("is_folder"):
                    continue
                if q and q not in (doc.get("title") or "").lower() and q not in (doc.get("filename") or "").lower() and q not in (doc.get("notes") or "").lower():
                    continue
                results.append({
                    "id":           doc.get("id", ""),
                    "project_id":   proj["id"],
                    "project_name": proj["name"],
                    "title":        doc.get("title", ""),
                    "filename":     doc.get("filename", ""),
                    "path":         doc.get("path", ""),
                    "size":         doc.get("size", 0),
                    "tags":         doc.get("tags", []),
                    "notes":        doc.get("notes", ""),
                    "color":        doc.get("color", ""),
                    "created_at":   doc.get("created_at", ""),
                    "download_url": doc.get("path", ""),
                })
                if len(results) >= limit:
                    break
        self._json_resp({"ok": True, "count": len(results), "items": results})

    def _serve_local_audio(self, query):
        AUDIO_EXTS = {'.mp3','.wav','.ogg','.flac','.aac','.m4a','.opus','.weba','.aiff','.au','.m4r'}
        MIME_MAP = {'.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.flac':'audio/flac',
                    '.aac':'audio/aac','.m4a':'audio/mp4','.opus':'audio/opus','.weba':'audio/webm',
                    '.aiff':'audio/aiff','.au':'audio/basic','.m4r':'audio/mp4'}
        file_path = unquote((query.get('path') or [''])[0])
        if not file_path:
            return self._err(400, 'missing path')
        p = Path(file_path)
        if not p.is_file():
            return self._err(404, 'file not found')
        ext = p.suffix.lower()
        if ext not in AUDIO_EXTS:
            return self._err(400, 'not an audio file')
        mime = MIME_MAP.get(ext, 'audio/mpeg')
        file_size = p.stat().st_size
        range_header = self.headers.get('Range', '')
        try:
            with open(file_path, 'rb') as f:
                if range_header and range_header.startswith('bytes='):
                    parts = range_header[6:].split('-')
                    start = int(parts[0]) if parts[0] else 0
                    end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
                    end = min(end, file_size - 1)
                    length = end - start + 1
                    self.send_response(206)
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                    self.send_header('Content-Length', str(length))
                    self.send_header('Accept-Ranges', 'bytes')
                    self._cors_headers()
                    self.end_headers()
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk: break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                else:
                    self.send_response(200)
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Length', str(file_size))
                    self.send_header('Accept-Ranges', 'bytes')
                    self._cors_headers()
                    self.end_headers()
                    shutil.copyfileobj(f, self.wfile)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except Exception as e:
            try: self._err(500, str(e))
            except: pass

    def _handle_upload_to_public(self, body):
        """Upload a local file (by URL, path or base64) to a public image host (Catbox/Telegraph)."""
        local_url = body.get("url", "")
        file_path = body.get("file_path", "")
        base64_data = body.get("base64", "")
        try:
            file_data = None
            file_ext = "png"
            if base64_data:
                import base64
                if "," in base64_data:
                    header, base64_data = base64_data.split(",", 1)
                    if "image/jpeg" in header or "image/jpg" in header:
                        file_ext = "jpg"
                    elif "image/webp" in header:
                        file_ext = "webp"
                    elif "image/gif" in header:
                        file_ext = "gif"
                file_data = base64.b64decode(base64_data)
            elif file_path:
                p = Path(file_path)
                if not p.exists():
                    return self._err(400, f"File not found: {file_path}")
                file_data = p.read_bytes()
                file_ext = p.suffix.lstrip(".") or "png"
            elif local_url:
                # Resolve: blob or local URL → fetch
                if local_url.startswith("blob:"):
                    return self._err(400, "blob URLs must be converted to base64 by renderer process first")
                elif local_url.startswith("/"):
                    # Relative to DATA_DIR
                    rel = local_url.lstrip("/")
                    candidates = [DATA_DIR / rel, BASE_DIR / rel]
                    for c in candidates:
                        if c.exists():
                            file_data = c.read_bytes()
                            file_ext = c.suffix.lstrip(".") or "png"
                            break
                    if not file_data:
                        return self._err(400, f"Cannot resolve local path: {local_url}")
                elif "localhost" in local_url or "127.0.0.1" in local_url:
                    req = urllib.request.Request(local_url)
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        file_data = resp.read()
                    # Guess extension from URL
                    url_path = urlparse(local_url).path
                    file_ext = url_path.rsplit(".", 1)[-1] if "." in url_path else "png"
                else:
                    return self._err(400, "URL is not a local URL")
            else:
                return self._err(400, "Missing 'base64', 'url' or 'file_path'")

            if not file_data:
                return self._err(500, "Failed to read file data")

            safe_ext = file_ext.lower().replace("jpeg", "jpg")
            if safe_ext not in ("png", "jpg", "webp", "gif"):
                safe_ext = "png"
            filename = f"image.{safe_ext}"

            # Try Catbox.moe
            try:
                boundary = uuid.uuid4().hex
                body_parts = []
                body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"reqtype\"\r\n\r\nfileupload".encode())
                body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"fileToUpload\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + file_data)
                body_parts.append(f"--{boundary}--\r\n".encode())
                multipart_body = b"\r\n".join(body_parts)
                req = urllib.request.Request(
                    "https://catbox.moe/user/api.php",
                    data=multipart_body,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = resp.read().decode().strip()
                    if result.startswith("http"):
                        return self._json_resp({"ok": True, "public_url": result})
            except Exception as e:
                print(f"[upload-to-public] Catbox failed: {e}")

            # Try Telegraph
            try:
                boundary = uuid.uuid4().hex
                body_parts = []
                body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + file_data)
                body_parts.append(f"--{boundary}--\r\n".encode())
                multipart_body = b"\r\n".join(body_parts)
                req = urllib.request.Request(
                    "https://telegra.ph/upload",
                    data=multipart_body,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = json.loads(resp.read().decode())
                    if isinstance(result, list) and result and result[0].get("src"):
                        public_url = f"https://telegra.ph{result[0]['src']}"
                        return self._json_resp({"ok": True, "public_url": public_url})
            except Exception as e:
                print(f"[upload-to-public] Telegraph failed: {e}")

            # Try sm.ms (国内可访问)
            try:
                import base64 as b64mod
                boundary = uuid.uuid4().hex
                body_parts = []
                body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"smfile\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + file_data)
                body_parts.append(f"--{boundary}--\r\n".encode())
                multipart_body = b"\r\n".join(body_parts)
                req = urllib.request.Request(
                    "https://sm.ms/api/v2/upload",
                    data=multipart_body,
                    headers={
                        "Content-Type": f"multipart/form-data; boundary={boundary}",
                        "User-Agent": "Mozilla/5.0",
                    },
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = json.loads(resp.read().decode())
                    smurl = ""
                    if result.get("success") and result.get("data", {}).get("url"):
                        smurl = result["data"]["url"]
                    elif result.get("code") == "image_repeated" and result.get("images"):
                        smurl = result["images"]
                    if smurl:
                        print(f"[upload-to-public] sm.ms succeeded: {smurl}")
                        return self._json_resp({"ok": True, "public_url": smurl})
            except Exception as e:
                print(f"[upload-to-public] sm.ms failed: {e}")

            # Try freeimage.host (国内可访问, 免费无需注册)
            try:
                import base64 as b64mod
                b64_str = b64mod.b64encode(file_data).decode()
                req = urllib.request.Request(
                    "https://freeimage.host/api/1/upload",
                    data=urllib.parse.urlencode({"key": "6d207e02198a847aa98d0a2a901485a5", "source": b64_str, "format": "json"}).encode(),
                    headers={"User-Agent": "Mozilla/5.0"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = json.loads(resp.read().decode())
                    if result.get("status_code") == 200 and result.get("image", {}).get("url"):
                        furl = result["image"]["url"]
                        print(f"[upload-to-public] freeimage.host succeeded: {furl}")
                        return self._json_resp({"ok": True, "public_url": furl})
            except Exception as e:
                print(f"[upload-to-public] freeimage.host failed: {e}")

            self._err(500, "所有公网图床上传均失败（Catbox / Telegraph / sm.ms / freeimage.host），可能因网络原因无法连接。请配置 S3 存储或使用公网图片链接。")
        except Exception as e:
            self._err(500, f"Upload error: {e}")

    def _server_port(self):
        try:
            return int(self.server.server_address[1])
        except Exception:
            return PORT

    def _is_trusted_origin(self, origin):
        if not origin:
            return True
        origin = origin.rstrip("/")
        if origin in EXTRA_TRUSTED_ORIGINS:
            return True
        try:
            parsed = urlparse(origin)
        except Exception:
            return False
        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()
        if scheme == "chrome-extension" and parsed.netloc:
            return True
        if scheme in ("http", "https") and host in LOOPBACK_CORS_HOSTS:
            return (parsed.port or self._server_port()) == self._server_port()
        return False

    def _is_trusted_api_request(self):
        origin = (self.headers.get("Origin") or "").strip()
        if origin and not self._is_trusted_origin(origin):
            return False
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if fetch_site in ("cross-site", "same-site"):
            return bool(origin and self._is_trusted_origin(origin))
        if origin.lower() == "null":
            return False
        return True

    def _reject_untrusted_api_request(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return False
        if self._is_trusted_api_request():
            return False
        _record_security_event(path, self.headers, self.client_address)
        self._json_resp({"ok": False, "error": "Forbidden origin"}, status=403)
        return True

    def _cors_headers(self):
        origin = (self.headers.get("Origin") or "").strip()
        if origin and self._is_trusted_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Project")

    def _json_resp(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json_resp({"ok": False, "error": msg}, status=code)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Prompt Studio running at  http://127.0.0.1:{port}/")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
