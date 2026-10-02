from __future__ import annotations

import argparse
import hashlib
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

MODEL_URL = "https://tfhub.dev/google/yamnet/1?tf-hub-format=compressed"
MODEL_SHA256 = "b80da2a1a56926fb0767205051a200dd7b3beaf3ea1ea126c42a53943996e5e0"


def _safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.getmembers():
        target = (destination / member.name).resolve()
        if root != target and root not in target.parents:
            raise ValueError(f"Model archive contains an unsafe path: {member.name}")
        if member.issym() or member.islnk():
            raise ValueError(f"Model archive contains an unsupported link: {member.name}")
    archive.extractall(destination)


def download_model(destination: Path) -> None:
    marker = destination / ".archive-sha256"
    if (destination / "saved_model.pb").is_file() and marker.is_file():
        if marker.read_text(encoding="ascii").strip() == MODEL_SHA256:
            print(f"YAMNet is already installed at {destination}")
            return

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="yamnet-download-") as temporary:
        archive_path = Path(temporary) / "yamnet.tar.gz"
        request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "Session-Scribe/1"})
        digest = hashlib.sha256()
        with urllib.request.urlopen(request, timeout=120) as response, archive_path.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != MODEL_SHA256:
            raise ValueError("Downloaded YAMNet archive did not match the pinned SHA-256.")

        extracted = Path(temporary) / "model"
        extracted.mkdir()
        with tarfile.open(archive_path, "r:gz") as archive:
            _safe_extract(archive, extracted)
        if not (extracted / "saved_model.pb").is_file():
            raise ValueError("Downloaded YAMNet archive does not contain saved_model.pb.")
        (extracted / ".archive-sha256").write_text(f"{MODEL_SHA256}\n", encoding="ascii")

        replacement = destination.with_name(f"{destination.name}.installing")
        if replacement.exists():
            shutil.rmtree(replacement)
        shutil.copytree(extracted, replacement)
        if destination.exists():
            shutil.rmtree(destination)
        replacement.replace(destination)
    print(f"Installed YAMNet at {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the pinned official YAMNet SavedModel.")
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path(__file__).resolve().parent / "models" / "yamnet",
    )
    arguments = parser.parse_args()
    download_model(arguments.destination.resolve())


if __name__ == "__main__":
    main()
