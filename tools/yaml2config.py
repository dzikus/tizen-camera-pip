#!/usr/bin/env python3
"""Turn app/config.yaml into the config.js the TV app loads.

The app runs on Tizen 4, whose WebKit has no YAML parser and no module loading
worth the trouble. The config is authored in YAML and compiled to a single
`window.PIP_CONFIG = {...}` assignment at build time. Nobody has to edit
JavaScript by hand, and the app stays a plain widget with no runtime
dependencies.

    python3 tools/yaml2config.py app/config.yaml app/config.js
"""

import json
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml (or apt install python3-yaml)")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]

    try:
        with open(src, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    except OSError as exc:
        sys.exit(f"{src}: {exc.strerror}")
    except yaml.YAMLError as exc:
        sys.exit(f"{src}: {exc}")

    if not isinstance(config, dict):
        sys.exit(f"{src}: expected a mapping at the top level")

    body = json.dumps(config, indent=4, ensure_ascii=False, sort_keys=False)
    with open(dst, "w", encoding="utf-8") as handle:
        handle.write(
            "// GENERATED FROM config.yaml - DO NOT EDIT.\n"
            "// Edit app/config.yaml and rebuild; the build container makes this.\n"
            f"window.PIP_CONFIG = {body};\n"
        )
    print(f"==> config: {src} -> {dst} ({len(config)} keys)")


if __name__ == "__main__":
    main()
