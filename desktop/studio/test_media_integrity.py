from pathlib import Path
import tempfile

import server


def demo():
    old_upload_dir = server.UPLOAD_DIR
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server.UPLOAD_DIR = root
            (root / "proj" / "images").mkdir(parents=True)
            (root / "proj" / "images" / "local.jpg").write_bytes(b"ok")
            (root / "orphan.jpg").write_bytes(b"orphan")

            data = {
                "projects": [{
                    "id": "p1",
                    "name": "Proj",
                    "image_prompts": [{
                        "id": "i1",
                        "title": "Item",
                        "image": "/uploads/proj/images/local.jpg",
                        "gallery": [
                            "/uploads/proj/images/missing.jpg",
                            "https://cdn.example.com/remote.jpg",
                        ],
                    }],
                    "video_prompts": [],
                    "skill_prompts": [],
                }]
            }

            report = server._media_integrity_report(data)
            assert report["ok"] is False
            assert report["summary"]["local_refs"] == 2
            assert report["summary"]["missing_files"] == 1
            assert report["summary"]["remote_urls"] == 1
            assert report["summary"]["orphan_files"] == 1
    finally:
        server.UPLOAD_DIR = old_upload_dir


if __name__ == "__main__":
    demo()
