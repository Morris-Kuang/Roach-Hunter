#!/usr/bin/env bash
# Merges mhacks.v2i.yolov11/ (our own webcam photos; a superset of
# mhacks.v1i.yolov8/ with identical splits) and ESP3902.v1i.yolov11/
# (public web photos of real cockroaches) into combined_dataset/ via
# symlinks, for train.py to fine-tune on. Not committed to git (see
# .gitignore) since the merge is trivial to regenerate and symlinks don't
# survive being committed/cloned portably.
#
# ESP3902 samples get a smaller per-image weight than ours: each of our
# train images is linked OURS_REPEAT times (default 2), so every epoch sees
# it that many times, i.e. an ESP3902 image weighs 1/OURS_REPEAT of one of
# ours. valid/test are never repeated so metrics stay unbiased.
#
# Also writes test_ours.yaml / test_esp.yaml so train.py can report test
# metrics per source (the demo camera is what we actually care about).
set -euo pipefail
cd "$(dirname "$0")"

OURS=mhacks.v2i.yolov11
ESP=ESP3902.v1i.yolov11
OURS_REPEAT="${OURS_REPEAT:-2}"

rm -rf combined_dataset
for split in train valid test; do
  mkdir -p "combined_dataset/$split/images" "combined_dataset/$split/labels"
  for src in "$OURS" "$ESP"; do
    reps=1
    if [[ "$split" == train && "$src" == "$OURS" ]]; then reps=$OURS_REPEAT; fi
    for ((r = 0; r < reps; r++)); do
      prefix=""
      if ((r > 0)); then prefix="rep${r}_"; fi
      for f in "$src/$split/images"/*; do
        ln -sf "$(pwd)/$f" "combined_dataset/$split/images/$prefix$(basename "$f")"
      done
      for f in "$src/$split/labels"/*; do
        ln -sf "$(pwd)/$f" "combined_dataset/$split/labels/$prefix$(basename "$f")"
      done
    done
  done
  echo "$split: $(ls "combined_dataset/$split/images" | wc -l) images"
done

cat > combined_dataset/data.yaml <<'EOF'
train: train/images
val: valid/images
test: test/images

nc: 1
names: ['cockroach']
EOF

for tag in ours esp; do
  src=$OURS; [[ $tag == esp ]] && src=$ESP
  ls "$(pwd)/$src/test/images"/* > "combined_dataset/test_$tag.txt"
  cat > "combined_dataset/test_$tag.yaml" <<EOF
train: test_$tag.txt
val: test_$tag.txt
test: test_$tag.txt

nc: 1
names: ['cockroach']
EOF
done

echo "Wrote combined_dataset/data.yaml (our train images x$OURS_REPEAT)"
