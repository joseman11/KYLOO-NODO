#!/bin/sh
# Arranque de Nodo {{VERSION}} (macOS y Linux). Cierra con Ctrl+C.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$NODO_DATA_DIR" ]; then
  case "$(uname -s)" in
    Darwin) NODO_DATA_DIR="$HOME/Library/Application Support/Nodo" ;;
    *) NODO_DATA_DIR="/var/lib/nodo" ;;
  esac
  export NODO_DATA_DIR
fi
exec "$HERE/node" --disable-warning=ExperimentalWarning "$HERE/app/server.mjs"
