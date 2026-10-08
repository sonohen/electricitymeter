"""Produce a distributable without local build paths in source maps."""
from pathlib import Path
import zipfile
import json
import shutil

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text())
source = root / "build" / (package['name'] + ".pbw")
if not source.exists():
    source = root / "build" / "src.pbw"
destination = root / "dist" / "electricitymeter.pbw"
destination.parent.mkdir(exist_ok=True)
private_prefix = str(Path.home()).encode()
with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as output:
    for info in original.infolist():
        content = original.read(info.filename)
        if info.filename.endswith((".js", ".map", ".json")):
            content = content.replace(private_prefix, b"BUILD_HOME")
        if private_prefix in content:
            raise RuntimeError("Unexpected local path in distributable")
        output.writestr(info, content)
print("Created dist/electricitymeter.pbw (local paths removed)")

version = package['version']
versioned = destination.with_name('electricitymeter-' + version + '.pbw')
shutil.copyfile(destination, versioned)
print('Created versioned distribution:', versioned.name)
