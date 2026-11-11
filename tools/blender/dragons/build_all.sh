#!/usr/bin/env bash
# Full dragon build: paint -> Blender build/export/previews -> optimize + manifests -> sheets.
#   bash tools/blender/dragons/build_all.sh [class ...]        (Git Bash, from the repo root)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
CLASSES="${*:-talon bastion tempest wraith}"
SCR="$REPO/art-source/_scratch/dragons"; PREV="$REPO/art-source/dragons/previews"
mkdir -p "$SCR" "$PREV"
STILLS="front34,side,top,back34,below,head"
POSES="front34:flap0,front34:flap1,front34:flap2,front34:flap3,front34:dive,top:dive,front34:hover,front34:roar,front34:bank,front34:death"
cd "$REPO"
python "$HERE/paint_dragon.py" $CLASSES
for c in $CLASSES; do
  (
    "$BL" -b -P "$HERE/build_dragon.py" -- $c --views "$STILLS,$POSES" --res 1200x800 2>&1 | grep -E "Error|Traceback|EXPORTED" || true
    "$BL" -b -P "$HERE/build_dragon.py" -- $c --no-export --no-anim --silhouette --views side,top,front34 --res 480x320 --tag _sil 2>&1 | grep -E "Error|Traceback" || true
    "$BL" -b -P "$HERE/build_dragon.py" -- $c --no-export --no-anim --team frost --views front34 --res 1200x800 --tag _frost 2>&1 | grep -E "Error|Traceback" || true
    "$BL" -b -P "$HERE/build_dragon.py" -- $c --no-export --no-anim --lod 1 --views front34 --res 1200x800 --tag _lod1 2>&1 | grep -E "Error|Traceback" || true
    "$BL" -b -P "$HERE/build_dragon.py" -- $c --no-export --no-anim --lod 2 --views front34 --res 1200x800 --tag _lod2 2>&1 | grep -E "Error|Traceback" || true
  ) &
done
wait
node "$HERE/finish.mjs" $CLASSES
cd "$SCR"
for c in $CLASSES; do
  f=""; for v in ${STILLS//,/ }; do f="$f ${c}_${v}_rest.png"; done
  python "$HERE/sheet.py" "$PREV/${c}_turntable.png" 3 800 $f
  f=""; for v in ${POSES//,/ }; do f="$f ${c}_${v/:/_}.png"; done
  python "$HERE/sheet.py" "$PREV/${c}_poses.png" 5 560 $f
  python "$HERE/sheet.py" "$PREV/${c}_lods_frost.png" 4 600 ${c}_front34_rest.png ${c}_front34_rest_lod1.png ${c}_front34_rest_lod2.png ${c}_front34_rest_frost.png
done
if [ "$CLASSES" = "talon bastion tempest wraith" ]; then
  python "$HERE/sheet.py" "$PREV/all_front34.png" 2 900 talon_front34_rest.png bastion_front34_rest.png tempest_front34_rest.png wraith_front34_rest.png
  python "$HERE/sheet.py" "$PREV/all_top.png" 4 600 talon_top_rest.png bastion_top_rest.png tempest_top_rest.png wraith_top_rest.png
  f=""; for v in side top front34; do for c in $CLASSES; do f="$f ${c}_${v}_rest_sil.png"; done; done
  python "$HERE/sheet.py" "$PREV/all_silhouettes.png" 4 240 $f
fi
echo done
