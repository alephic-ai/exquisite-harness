#!/usr/bin/env bash
set -euo pipefail

REPO='alephic-ai/exquisite-harness'
INSTALL_DIR="${EH_INSTALL_DIR:-$HOME/.local/bin}"

if ! command -v curl >/dev/null 2>&1; then
  echo 'Error: curl is required to install eh.' >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) platform='darwin' ;;
  Linux) platform='linux' ;;
  *)
    echo "Error: unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch='arm64' ;;
  x86_64 | amd64) arch='x64' ;;
  *)
    echo "Error: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

asset="eh-$platform-$arch"
url="https://github.com/$REPO/releases/latest/download/$asset"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Downloading $asset …"
curl --fail --location --silent --show-error "$url" --output "$tmp_dir/eh"
chmod +x "$tmp_dir/eh"
mkdir -p "$INSTALL_DIR"
mv -f "$tmp_dir/eh" "$INSTALL_DIR/eh"

if [[ "$platform" == 'darwin' ]]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/eh" 2>/dev/null || true
fi

echo "Installed eh to $INSTALL_DIR/eh"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to your PATH, then run: eh doctor" ;;
esac
