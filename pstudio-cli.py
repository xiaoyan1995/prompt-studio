#!/usr/bin/env python3
"""
pstudio-cli.py  —  Read & write Prompt Studio from any agent or shell.

Usage examples
--------------
# List all projects
python pstudio-cli.py projects

# List all skill prompts in a project
python pstudio-cli.py list --project "我的项目" --type skill

# Get full details of a prompt (by id or title)
python pstudio-cli.py get --id abc123def456
python pstudio-cli.py get --project "我的项目" --type image --title "赛博武士"

# Full-text search across all prompts
python pstudio-cli.py search --query "赛博" --type image

# Download the main image of a prompt to a local file
python pstudio-cli.py download --id abc123 --out /tmp/img.jpg

# Push a skill prompt
python pstudio-cli.py push --type skill --title "My Skill" --prompt "You are a helpful assistant…"

# Push an image prompt (with tags and model)
python pstudio-cli.py push --type image --project "游戏角色" --title "赛博武士" \
    --prompt "A cyberpunk samurai, neon lights…" --model "GPT Image 2" --tags "游戏,角色"

# Read prompt text from stdin
echo "Describe the scene…" | python pstudio-cli.py push --type image --title "Scene"

# MCP / JSON mode (agent-friendly)
python pstudio-cli.py push --json '{"type":"skill","title":"T","prompt":"P…"}'

# List audio folders linked to a project
python pstudio-cli.py audio-folders --project "我的项目"

# List / search audio files
python pstudio-cli.py audio-files --project "我的项目" --folder "SFX" --query "door"
python pstudio-cli.py audio-files --project "我的项目" --starred --raw

Environment
-----------
PSTUDIO_PORT      override server port (default 8768)
PSTUDIO_PROJECT   default project name
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = f"http://localhost:{os.environ.get('PSTUDIO_PORT', '8768')}"


def _post(path: str, data: dict) -> dict:
    payload = json.dumps(data).encode()
    req = urllib.request.Request(
        BASE_URL + path,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {"ok": False, "error": body}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _get(path: str) -> dict:
    try:
        with urllib.request.urlopen(BASE_URL + path, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_push(args):
    # Resolve payload from --json flag or individual flags
    if args.json:
        try:
            payload = json.loads(args.json)
        except json.JSONDecodeError as e:
            print(f"Error: invalid JSON — {e}", file=sys.stderr)
            sys.exit(1)
    else:
        prompt = args.prompt
        if not prompt:
            if not sys.stdin.isatty():
                prompt = sys.stdin.read().strip()
            if not prompt:
                print("Error: --prompt is required (or pipe text via stdin)", file=sys.stderr)
                sys.exit(1)

        payload = {
            "type":         args.type,
            "title":        args.title or "",
            "prompt":       prompt,
            "model":        args.model or "",
            "tags":         [t.strip() for t in (args.tags or "").split(",") if t.strip()],
            "aspect":       args.aspect or "",
            "analysis":     args.analysis or "",
        }

    # Project resolution: CLI flag > env var > first project
    project_name = (getattr(args, "project", None) or
                    os.environ.get("PSTUDIO_PROJECT") or
                    payload.get("project_name") or "")
    if project_name:
        payload["project_name"] = project_name

    result = _post("/api/cli/push", payload)

    if result.get("ok"):
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Error: {result.get('error', result)}", file=sys.stderr)
        sys.exit(1)


def _get_url(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.read()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_projects(_args):
    result = _get("/api/cli/projects")
    if result.get("ok"):
        for p in result.get("projects", []):
            print(f"{p['id']}  {p['name']}")
    else:
        print(f"Error: {result.get('error', result)}", file=sys.stderr)
        sys.exit(1)


def cmd_list(args):
    params = []
    if args.project: params.append(f"project={urllib.parse.quote(args.project)}")
    if args.type:    params.append(f"type={args.type}")
    if args.limit:   params.append(f"limit={args.limit}")
    qs = "?" + "&".join(params) if params else ""
    result = _get(f"/api/cli/prompts{qs}")
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    if args.raw:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    items = result.get("items", [])
    print(f"{'ID':<18} {'TYPE':<7} {'PROJECT':<16} {'TITLE':<30} TAGS")
    print("-" * 90)
    for it in items:
        tags = ",".join(it.get("tags") or [])
        print(f"{it['id']:<18} {it['type']:<7} {it['project_name']:<16} {(it.get('title') or '')[:30]:<30} {tags}")


def cmd_get(args):
    params = []
    if args.id:      params.append(f"id={args.id}")
    if args.project: params.append(f"project={urllib.parse.quote(args.project)}")
    if args.title:   params.append(f"title={urllib.parse.quote(args.title)}")
    if args.type:    params.append(f"type={args.type}")
    qs = "?" + "&".join(params) if params else ""
    result = _get(f"/api/cli/prompt{qs}")
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    item = result.get("item", {})
    if args.field:
        val = item.get(args.field, "")
        print(val if isinstance(val, str) else json.dumps(val, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_search(args):
    q = args.query
    params = [f"q={urllib.parse.quote(q)}"]
    if args.project: params.append(f"project={urllib.parse.quote(args.project)}")
    if args.type:    params.append(f"type={args.type}")
    if args.limit:   params.append(f"limit={args.limit}")
    result = _get("/api/cli/search?" + "&".join(params))
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    if args.raw:
        print(json.dumps(result, ensure_ascii=False, indent=2)); return
    items = result.get("items", [])
    print(f"Found {result['count']} result(s) for '{q}':\n")
    for it in items:
        print(f"  [{it['type']}] {it['project_name']} / {it.get('title','(no title)')}  id={it['id']}")
        snippet = (it.get("prompt") or "")[:100].replace("\n", " ")
        print(f"         {snippet}")
        print()


def cmd_download(args):
    # First get the prompt to find the image/video URL
    if not args.id:
        print("Error: --id is required", file=sys.stderr); sys.exit(1)
    result = _get(f"/api/cli/prompt?id={args.id}")
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    item = result["item"]
    ptype = result.get("type", "")
    # Pick URL
    if args.gallery is not None:
        gallery = item.get("gallery", [])
        url_path = gallery[args.gallery] if args.gallery < len(gallery) else ""
    elif ptype == "video":
        url_path = item.get("video", "")
    else:
        url_path = item.get("image", "")
    if not url_path:
        print("Error: no media found for this prompt", file=sys.stderr); sys.exit(1)
    full_url = BASE_URL + url_path if url_path.startswith("/") else url_path
    data = _get_url(full_url)
    out = args.out or url_path.split("/")[-1]
    with open(out, "wb") as f:
        f.write(data)
    print(f"Saved {len(data)} bytes → {out}")


def cmd_audio_folders(args):
    params = []
    if args.project: params.append(f"project={urllib.parse.quote(args.project)}")
    qs = "?" + "&".join(params) if params else ""
    result = _get(f"/api/cli/audio/folders{qs}")
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    if args.raw:
        print(json.dumps(result, ensure_ascii=False, indent=2)); return
    folders = result.get("folders", [])
    print(f"{'FOLDER_ID':<18} {'PROJECT':<18} {'NAME':<24} LOCAL_PATH")
    print("-" * 90)
    for f in folders:
        print(f"{f['folder_id']:<18} {f['project_name']:<18} {f['folder_name']:<24} {f['local_path']}")


def cmd_audio_files(args):
    params = []
    if args.project: params.append(f"project={urllib.parse.quote(args.project)}")
    if args.folder:  params.append(f"folder={urllib.parse.quote(args.folder)}")
    if args.query:   params.append(f"q={urllib.parse.quote(args.query)}")
    if args.starred: params.append("starred=1")
    if args.limit:   params.append(f"limit={args.limit}")
    result = _get("/api/cli/audio/files?" + "&".join(params))
    if not result.get("ok"):
        print(f"Error: {result.get('error', result)}", file=sys.stderr); sys.exit(1)
    if args.raw:
        print(json.dumps(result, ensure_ascii=False, indent=2)); return
    items = result.get("items", [])
    print(f"Found {result['count']} file(s) in '{result.get('folder_name','')}'\n")
    print(f"{'EXT':<6} {'STARRED':<8} {'CN_NAME':<24} NAME")
    print("-" * 80)
    for it in items:
        star = "★" if it.get("starred") else " "
        cn = (it.get("cnName") or "")[:24]
        print(f"{it['ext']:<6} {star:<8} {cn:<24} {it['name']}")


def main():
    parser = argparse.ArgumentParser(
        prog="pstudio-cli",
        description="Read & write Prompt Studio from any agent or shell.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # ── projects ──────────────────────────────────────────────────────────
    p_proj = sub.add_parser("projects", help="List all projects")
    p_proj.set_defaults(func=cmd_projects)

    # ── list ──────────────────────────────────────────────────────────────
    p_list = sub.add_parser("list", help="List prompts in a project")
    p_list.add_argument("--project", help="Project name or id")
    p_list.add_argument("--type",    choices=["image", "video", "skill"], help="Filter by type")
    p_list.add_argument("--limit",   type=int, default=200)
    p_list.add_argument("--raw",     action="store_true", help="Output raw JSON")
    p_list.set_defaults(func=cmd_list)

    # ── get ───────────────────────────────────────────────────────────────
    p_get = sub.add_parser("get", help="Get full details of a prompt")
    p_get.add_argument("--id",      help="Prompt id")
    p_get.add_argument("--project", help="Project name or id")
    p_get.add_argument("--title",   help="Prompt title (partial match)")
    p_get.add_argument("--type",    choices=["image", "video", "skill"])
    p_get.add_argument("--field",   help="Extract a single field, e.g. --field prompt")
    p_get.set_defaults(func=cmd_get)

    # ── search ────────────────────────────────────────────────────────────
    p_search = sub.add_parser("search", help="Full-text search across prompts")
    p_search.add_argument("--query",   required=True, help="Search text")
    p_search.add_argument("--project", help="Limit to project")
    p_search.add_argument("--type",    choices=["image", "video", "skill"])
    p_search.add_argument("--limit",   type=int, default=20)
    p_search.add_argument("--raw",     action="store_true", help="Output raw JSON")
    p_search.set_defaults(func=cmd_search)

    # ── download ──────────────────────────────────────────────────────────
    p_dl = sub.add_parser("download", help="Download image / video from a prompt")
    p_dl.add_argument("--id",      required=True, help="Prompt id")
    p_dl.add_argument("--out",     help="Output file path (default: original filename)")
    p_dl.add_argument("--gallery", type=int, metavar="N",
                      help="Download gallery image at index N (0-based) instead of main")
    p_dl.set_defaults(func=cmd_download)

    # ── push ──────────────────────────────────────────────────────────────
    p_push = sub.add_parser("push", help="Push a new prompt / skill into Prompt Studio")
    p_push.add_argument("--type",     default="skill",
                        choices=["image", "video", "skill"],
                        help="Prompt type (default: skill)")
    p_push.add_argument("--project",  help="Project name (created if not exists)")
    p_push.add_argument("--title",    help="Prompt title")
    p_push.add_argument("--prompt",   help="Prompt text (omit to read from stdin)")
    p_push.add_argument("--model",    help="Model name, e.g. 'GPT Image 2'")
    p_push.add_argument("--tags",     help="Comma-separated tags, e.g. 'game,npc'")
    p_push.add_argument("--aspect",   help="Aspect ratio, e.g. '16:9' (image only)")
    p_push.add_argument("--analysis", help="Analysis / notes")
    p_push.add_argument("--json",     metavar="JSON",
                        help="Pass all fields as a single JSON object instead of flags")
    p_push.set_defaults(func=cmd_push)

    # ── audio-folders ─────────────────────────────────────────────────────
    p_af = sub.add_parser("audio-folders", help="List audio folders linked to a project")
    p_af.add_argument("--project", help="Project name or id (omit for all projects)")
    p_af.add_argument("--raw",     action="store_true", help="Output raw JSON")
    p_af.set_defaults(func=cmd_audio_folders)

    # ── audio-files ───────────────────────────────────────────────────────
    p_aff = sub.add_parser("audio-files", help="List / search audio files in a folder")
    p_aff.add_argument("--project", required=True, help="Project name or id")
    p_aff.add_argument("--folder",  help="Folder name or id (omit for first folder)")
    p_aff.add_argument("--query",   help="Search keyword (matches filename or Chinese name)")
    p_aff.add_argument("--starred", action="store_true", help="Return starred files only")
    p_aff.add_argument("--limit",   type=int, default=500)
    p_aff.add_argument("--raw",     action="store_true", help="Output raw JSON")
    p_aff.set_defaults(func=cmd_audio_files)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
