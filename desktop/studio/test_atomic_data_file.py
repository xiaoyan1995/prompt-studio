import json
from pathlib import Path
import tempfile
import threading

import server


def demo():
    with tempfile.TemporaryDirectory() as tmp:
        data_file = server._AtomicDataFile(Path(tmp) / "data.json")
        data_file.write_text('{"projects":[]}', encoding="utf-8")
        errors = []

        def writer(marker):
            payload = json.dumps({"projects": [{"id": marker, "text": marker * 20000}]})
            for _ in range(20):
                data_file.write_text(payload, encoding="utf-8")

        def reader():
            for _ in range(200):
                try:
                    json.loads(data_file.read_text(encoding="utf-8"))
                except Exception as exc:
                    errors.append(exc)

        threads = [
            threading.Thread(target=writer, args=("a",)),
            threading.Thread(target=writer, args=("b",)),
            threading.Thread(target=reader),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert not errors
        assert json.loads(data_file.read_text(encoding="utf-8"))["projects"][0]["id"] in {"a", "b"}


if __name__ == "__main__":
    demo()
