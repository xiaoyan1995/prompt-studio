# Prompt Studio API Reference

Prompt management base URL: `http://127.0.0.1:8768`

Independent Asset Browser base URL: `http://127.0.0.1:5177`

Both services have an `/api/projects` endpoint with different meanings and response schemas. Always select the base URL before constructing a request.

---

## GET endpoints

| Path | Params | Returns |
|------|--------|---------|
| `/api/cli/projects` | — | `{ projects: [{id, name, skill_count, image_count, video_count}] }` |
| `/api/cli/prompts` | `project`, `type`, `limit` | `{ count, items: [summary…] }` |
| `/api/cli/prompt` | `id` **or** `project`+`title`+`type` | `{ type, project_name, item }` |
| `/api/cli/search` | `q` (required), `project`, `type`, `limit` | `{ count, items }` |
| `/api/cli/docs` | `project`, `q`, `limit` | `{ count, items: [doc…] }` |
| `/api/cli/audio/folders` | `project` | `{ count, folders: […] }` |
| `/api/cli/audio/files` | `project`, `folder`, `q`, `starred`, `limit` | `{ count, items: [file…] }` |
| `/api/media/integrity` | — | `{ integrity: { summary, missing_files, remote_urls, orphan_files } }` |
| `/api/security/status` | — | `{ server_origin, blocked_count, recent_blocks }` |
| `/api/local-audio` | `path` (abs path, URL-encoded) | audio stream (Range-capable) |
| `/uploads/<file>` | — | binary file |

### Item summary fields (list)
`id` · `type` · `project_id` · `project_name` · `title` · `model` · `tags` · `aspect` · `image` · `gallery` · `video` · `ref_images` · `created_at` · `prompt_preview`

### Item full fields (get)
All of the above plus: `prompt` · `ref_image` · `analysis` · `outfit_prompt` · `char_prompt` · `scene_prompt` · `style_prompt` · `cam_prompt`

---

## POST /api/cli/push {#push}

```json
{
  "type":         "image",
  "project_name": "我的项目",
  "project_id":   "abc123",
  "title":        "标题",
  "prompt":       "提示词正文（Skill 类型必填；图片/视频可留空）",
  "model":        "GPT Image 2",
  "tags":         ["tag1", "tag2"],
  "aspect":       "16:9",
  "analysis":     "备注",
  "pageUrl":      "https://example.com/source-page",
  "pageTitle":    "来源页面标题",

  // ── Agent 生成的图片（三选一）──────────────────
  "image_url":      "https://cdn.example.com/gen.jpg",   // 外部 URL，server 自动下载保存
  "image_base64":   "data:image/png;base64,iVBOR…",      // base64（含/不含 data: 前缀均可）
  "image_filename": "my_image.jpg",                       // 可选，文件名提示

  // ── 多张画廊图片 ────────────────────────────────
  "gallery_images": [
    "https://cdn.example.com/img1.jpg",                  // 纯 URL 字符串
    { "url": "https://cdn.example.com/img2.jpg" },       // 对象格式
    { "base64": "data:image/png;base64,…", "filename": "img3.png" }
  ],

  // ── Agent 生成的视频 ────────────────────────────
  "video_url":      "https://cdn.example.com/gen.mp4",
  "video_base64":   "data:video/mp4;base64,AAAA…",
  "video_filename": "my_video.mp4"
}
```

- `type`: `"image"` | `"video"` | `"skill"` (default `"skill"`)
- `prompt`: required only when `type` is `"skill"`; image and video imports may leave it empty and edit it later
- `project_name` **or** `project_id`: omit to use first project; unknown name is auto-created
- `tags`: array or comma-separated string
- 图片/视频字段可选，省略则记录无媒体
- `pageUrl` / `pageTitle` / `source`: optional provenance metadata; the server stores it on the saved item as `source`

Response: `{ ok, id, project_id, project_name, type, image, gallery, video }`

---

---

## Document Library API (文档库)

### GET /api/cli/docs

| Param | Required | Description |
|-------|----------|-------------|
| `project` | no | Project name or id; omit to list all projects |
| `q` | no | Search in title, filename, or notes |
| `limit` | no | Max results (default 200) |

Response item fields: `id` · `project_id` · `project_name` · `title` · `filename` · `path` · `size` · `tags` · `notes` · `color` · `created_at` · `download_url`

Download file: `GET http://localhost:8768` + `item.download_url`

---

## Audio Library API

### GET /api/cli/audio/folders

| Param | Required | Description |
|-------|----------|-------------|
| `project` | no | Project name or id; omit to list all projects |

Response:
```json
{
  "ok": true,
  "count": 2,
  "folders": [
    { "project_id": "abc", "project_name": "我的项目", "folder_id": "f1", "folder_name": "SFX", "local_path": "/Users/…/SFX", "added_at": "2025-01-01T12:00:00" }
  ]
}
```

### GET /api/cli/audio/files

| Param | Required | Description |
|-------|----------|-------------|
| `project` | yes | Project name or id |
| `folder` | no | Folder name or id; omit to use first folder |
| `q` | no | Search in filename or Chinese name |
| `starred` | no | `1` or `true` to return starred files only |
| `limit` | no | Max results (default 500) |

Response item fields: `name` · `nameNoExt` · `ext` · `relPath` · `absPath` · `size` · `cnName` · `starred` · `stream_url`

### GET /api/local-audio

Stream a local audio file. Supports HTTP Range requests (seek works in browsers and media players).

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | Absolute local path (URL-encoded) — use `item.stream_url` from audio/files response |

---

## Independent Asset Browser API

These endpoints use `http://127.0.0.1:5177`, not the prompt-management service.

### GET /api/projects

Lists monitored local directories.

Response: `{ projects: [{ id, name, path, scanRoots, exists, assetCount, typeCounts, previewUrls }] }`

`typeCounts` contains `image`, `video`, and `audio` totals. These projects are directory registrations, not prompt-management projects.

### GET /api/cases

| Param | Required | Description |
|-------|----------|-------------|
| `project` | yes | Asset Browser project id from `/api/projects` |

Response: `{ projectRoot, project, cases }`

Each case/folder contains: `id` · `projectId` · `name` · `relPath` · `scanRoot` · `parentId` · `depth` · `isRoot` · `directAssetCount` · `assetCount` · `mtimeMs`.

### GET /api/assets

| Param | Required | Description |
|-------|----------|-------------|
| `project` | yes | Asset Browser project id |
| `case` | yes | Folder id from `/api/cases` |

Response: `{ projectId, caseId, assets }`

Asset fields: `id` · `projectId` · `projectName` · `caseId` · `kind` · `version` · `name` · `relPath` · `caseRelPath` · `dir` · `mediaUrl` · `downloadUrl` · `size` · `mtimeMs` · `mtime` · `initialStatus` · `userStatus` · `notes` · `favorite` · `tags`.

Use `http://127.0.0.1:5177` + `mediaUrl` for preview/streaming and the same base URL + `downloadUrl` for download.

### POST /api/import

Query parameters: `project`, `case`, and `name`. Send the raw image/video/audio bytes as the request body. Supported media extensions are determined by the Asset Browser service. Duplicate names receive a numbered suffix instead of overwriting existing files.

Response status `201`: `{ ok, imported: { name, path, relPath, caseRelPath } }`

### POST /api/mark

Updates Asset Browser metadata without changing the media file.

```json
{
  "projectId": "project-id",
  "caseId": "folder-id",
  "assetId": "relative-file-name.png",
  "userStatus": "可用",
  "notes": "备注",
  "favorite": true,
  "tags": ["角色", "定稿"]
}
```

### Directory registration

- `POST /api/projects` with `{ name, path, scanRoots }` adds a monitored directory.
- `DELETE /api/projects` with `{ projectId }` removes only the registration; it does not delete local files.

Only add or remove monitored directories when the user explicitly requests that configuration change.

---

## Examples

```python
import requests
B = "http://localhost:8768"

# List all skills
items = requests.get(f"{B}/api/cli/prompts?type=skill").json()["items"]

# Get prompt text by title
r = requests.get(f"{B}/api/cli/prompt?type=skill&title=代码审查").json()
print(r["item"]["prompt"])

# Search
hits = requests.get(f"{B}/api/cli/search?q=赛博&type=image").json()["items"]

# Push
requests.post(f"{B}/api/cli/push", json={
    "type": "skill", "project_name": "AI工具箱",
    "title": "摘要助手", "prompt": "请将以下内容概括为三句话…"
})

# Download image
img_path = items[0]["image"]   # e.g. "/uploads/proj/foo.jpg"
data = requests.get(B + img_path).content
open("out.jpg", "wb").write(data)

# Push image prompt WITH agent-generated image (URL)
requests.post(f"{B}/api/cli/push", json={
    "type": "image", "project_name": "AI生成",
    "title": "赛博武士", "prompt": "A cyberpunk samurai…",
    "model": "GPT Image 2",
    "image_url": "https://cdn.openai.com/result/xxx.jpg",  # server auto-downloads
})

# Push with multiple gallery images
requests.post(f"{B}/api/cli/push", json={
    "type": "image", "project_name": "AI生成",
    "title": "批量生成", "prompt": "…",
    "gallery_images": [
        "https://cdn.example.com/img1.jpg",
        "https://cdn.example.com/img2.jpg",
    ]
})

# Push video prompt WITH generated video
requests.post(f"{B}/api/cli/push", json={
    "type": "video", "project_name": "视频项目",
    "title": "城市航拍", "prompt": "Aerial shot of city at night…",
    "video_url": "https://storage.example.com/output.mp4",
})

# List audio folders
folders = requests.get(f"{B}/api/cli/audio/folders?project=我的项目").json()["folders"]

# Search audio files (returns absPath + stream_url per item)
items = requests.get(f"{B}/api/cli/audio/files", params={
    "project": "我的项目", "folder": "SFX", "q": "door"
}).json()["items"]

# Stream / download an audio file
audio = requests.get(B + items[0]["stream_url"]).content
open("door.wav", "wb").write(audio)
```
