#!/usr/bin/env bash
# Dev loop: paint + build + contact sheet.  ./run.sh <class> <sheet-name> <views> [extra build flags]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
CLS=$1; NAME=$2; VIEWS=$3; shift 3
BL="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
[ -n "$NOPAINT" ] || python "$HERE/paint_dragon.py" $CLS
"$BL" -b -P "$HERE/build_dragon.py" -- $CLS --views $VIEWS "$@" 2>&1 | grep -E "Error|error|Traceback|TRIS|EXPORTED|line [0-9]+" || true
cd "$REPO/art-source/_scratch/dragons"
files=""; for v in ${VIEWS//,/ }; do case $v in *:*) f="${CLS}_${v/:/_}.png";; *) f="${CLS}_${v}_rest.png";; esac; files="$files $f"; done
python "$HERE/sheet.py" "$NAME.png" ${COLS:-2} ${CELL:-900} $files
