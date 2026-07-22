---
name: prompt-studio
description: Read and write Prompt Studio content through the prompt service (http://127.0.0.1:8768), and browse or import monitored local media through the independent Asset Browser service (http://127.0.0.1:5177). Covers prompt projects, skills, images, videos, documents, audio folders, monitored directories, nested folders, and local assets. Use when the user asks to list, search, read, save, push, import, or inspect anything in Prompt Studio or Asset Browser.
---

# Prompt Studio

The desktop app exposes two independent loopback services:

- Prompt management: `http://127.0.0.1:8768`
- Asset Browser: `http://127.0.0.1:5177`

Do not mix their similarly named `/api/projects` endpoints. Port `8768` projects are prompt-management projects; port `5177` projects are monitored local directories. If either service is unreachable, ask the user to start the desktop app instead of guessing from the other service.

This edition exposes prompt management and independent asset browsing only. Use only the endpoints documented here and in [REFERENCE.md](REFERENCE.md).

## All commands → HTTP endpoints

| What you want to do | HTTP call |
|---|---|
| List projects (with item counts) | `GET /api/cli/projects` |
| List prompts in a project | `GET /api/cli/prompts?project=X&type=skill&limit=50` |
| Get full prompt (by id) | `GET /api/cli/prompt?id=abc123` |
| Get only the prompt text | `GET /api/cli/prompt?id=abc123` → read `item.prompt` |
| Full-text search | `GET /api/cli/search?q=关键词&type=image` |
| Download main image | `GET /uploads/<path from item.image>` |
| Download gallery image N | `GET /uploads/<path from item.gallery[N]>` |
| Push new prompt / skill | `POST /api/cli/push` with JSON body |
| Push with agent image/video | add `image_url`, `gallery_images`, `video_url` to push body |
| Check offline media integrity | `GET /api/media/integrity` |
| Check local API security status | `GET /api/security/status` |
| List audio folders | `GET /api/cli/audio/folders?project=X` |
| List / search audio files | `GET /api/cli/audio/files?project=X&folder=Y&q=keyword&starred=1` |
| Stream audio file | `GET /api/local-audio?path=<absPath>` (Range-request capable) |
| List / search documents (文档库) | `GET /api/cli/docs?project=X&q=keyword&limit=50` |
| Download a document | `GET /uploads/<path from item.path>` |

All operations use plain HTTP — no CLI, no Python, no extra tools needed.

## Quick start

```js
// Push a new skill
await fetch('http://localhost:8768/api/cli/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'skill',           // "image" | "video" | "skill"
    project_name: '项目名',  // auto-created if missing
    title: '标题',
    prompt: '提示词正文',
    tags: ['tag1', 'tag2']
  })
});

// Search
const { items } = await fetch('http://localhost:8768/api/cli/search?q=关键词&type=skill').then(r => r.json());

// Push image with generated result (URL or base64)
await fetch('http://localhost:8768/api/cli/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'image', project_name: 'AI生成', title: '赛博武士',
    prompt: 'A cyberpunk samurai…',
    image_url: 'https://cdn.example.com/result.jpg',   // server auto-saves
    gallery_images: ['https://…/v2.jpg', 'https://…/v3.jpg'],
    pageUrl: 'https://example.com/source-page',
    pageTitle: '来源页面标题'
  })
});
```

## Independent Asset Browser

The Asset Browser reads media directly from user-configured local directories. Start with projects, then folders, then assets:

```js
const ASSET = 'http://127.0.0.1:5177';

// 1. Monitored local directories
const { projects } = await fetch(`${ASSET}/api/projects`).then(r => r.json());
const project = projects[0];

// 2. Nested folders containing media
const { cases } = await fetch(
  `${ASSET}/api/cases?project=${encodeURIComponent(project.id)}`
).then(r => r.json());
const folder = cases[0];

// 3. Images, videos, and audio in that folder and its descendants
const { assets } = await fetch(
  `${ASSET}/api/assets?project=${encodeURIComponent(project.id)}&case=${encodeURIComponent(folder.id)}`
).then(r => r.json());

// Stream/preview or download an asset using the returned relative URL.
const preview = await fetch(ASSET + assets[0].mediaUrl);
const download = await fetch(ASSET + assets[0].downloadUrl);
```

Asset kinds are `image`, `video`, `audio`, `frame`, and `contact`. The service returns nested folders as a flat `cases` list with `parentId` and `depth`; preserve that hierarchy when presenting results.

To import a local binary into the selected folder, POST the raw file body to:

```text
POST /api/import?project=<project_id>&case=<folder_id>&name=<filename>
```

Use the Asset Browser only when the user asks about monitored directories, local folders, or the independent asset section. Do not treat those entries as prompt cards and do not push them through port `8768` unless the user explicitly asks to create a prompt card from an asset.

## Document library (文档库)

Supported file types: **PDF · Word (.docx/.doc) · Excel (.xlsx/.xls) · PowerPoint (.pptx/.ppt) · TXT · Markdown (.md) · CSV · RTF · ODT/ODS/ODP · HTML**

```js
// List docs in a project
const { items } = await fetch('http://localhost:8768/api/cli/docs?project=我的项目').then(r => r.json());
// items[n]: { id, project_id, project_name, title, filename, path, size, tags, notes, download_url }

// Download a document
const file = await fetch('http://localhost:8768' + items[0].download_url).then(r => r.arrayBuffer());
```

## Audio library

> **Note**: Audio folders are local paths linked via the app UI. The server scans them live from disk.
> Always call `/api/cli/audio/folders` first to get `folder_id` and `project_name`, then pass both to `/api/cli/audio/files`.

```js
// Step 1 — list all linked audio folders (already includes file_count per folder)
const { folders } = await fetch('http://localhost:8768/api/cli/audio/folders').then(r => r.json());
// folders[n]: { project_id, project_name, folder_id, folder_name, local_path, file_count, accessible, added_at }
// file_count tells you how many audio files are in the folder WITHOUT fetching them all

// Step 2 — list files in a specific folder (use project_name + folder_id from step 1)
const f = folders[0];
const { items } = await fetch(
  `http://localhost:8768/api/cli/audio/files?project=${encodeURIComponent(f.project_name)}&folder=${f.folder_id}&q=door`
).then(r => r.json());
// items[n]: { name, nameNoExt, ext, relPath, absPath, size, cnName, starred, stream_url }

// Stream an audio file
// Use item.stream_url directly: GET /api/local-audio?path=<absPath>
// Supports Range requests (seek works).
```

## Workflows

### Push a prompt / skill
1. Choose `type`: `skill` (AI agent prompt) · `image` · `video`
2. POST `/api/cli/push` with fields from [REFERENCE.md](REFERENCE.md#push)
3. UI auto-refreshes via SSE — no restart needed

### Read an existing prompt
1. Search: `GET /api/cli/search?q=<keyword>` → get `id`
2. Get full content: `GET /api/cli/prompt?id=<id>`
3. Extract field: add `?id=<id>` → read `item.prompt`, `item.analysis`, etc.

### Get complete asset library overview
Always start with this sequence to see everything:
```
1. GET /api/cli/projects
   → returns each project with skill_count, image_count, video_count
   → does NOT include doc_count or audio_count (fetch separately if needed)

2. GET /api/cli/docs?project=<name>
   → lists all documents in 文档库 (PDF / Word / Excel / TXT etc.)

3. GET /api/cli/audio/folders?project=<name>
   → lists linked audio folders in 音效库
   → then GET /api/cli/audio/files?project=<name>&folder=<id> to list files

4. GET http://127.0.0.1:5177/api/projects
   → lists monitored local directories in the independent Asset Browser
   → for each directory, GET /api/cases?project=<id>
   → for each relevant folder, GET /api/assets?project=<id>&case=<folder_id>
```
Never skip steps 2, 3, or 4 when the user asks about their complete Prompt Studio content across all sections.

### List items in a project
```
GET /api/cli/prompts?project=<name>&type=skill&limit=50
GET /api/cli/prompts?project=<name>&type=image&limit=50
GET /api/cli/prompts?project=<name>&type=video&limit=50
```
Always pass `limit` (default 200). For large libraries use `limit=20` and paginate via search.

### Download an image / video
```
GET /uploads/<filename>   ← path from item.image or item.gallery[n]
```

See [REFERENCE.md](REFERENCE.md) for all endpoints and fields.
