#!/usr/bin/env bash
# Merges mhacks.v1i.yolov8/ (our own webcam photos) and ESP3902.v1i.yolov11/
# (public web photos of real cockroaches) into combined_dataset/ via
# symlinks, for train.py to fine-tune on. Not committed to git (see
# .gitignore) since the merge is trivial to regenerate and symlinks don't
# survive being committed/cloned portably.
set -euo pipefail
cd "$(dirname "$0")"

for split in train valid test; do
  mkdir -p "combined_dataset/$split/images" "combined_dataset/$split/labels"
  for src in mhacks.v1i.yolov8 ESP3902.v1i.yolov11; do
    for f in "$src/$split/images"/*; do
      ln -sf "$(pwd)/$f" "combined_dataset/$split/images/$(basename "$f")"
    done
    for f in "$src/$split/labels"/*; do
      ln -sf "$(pwd)/$f" "combined_dataset/$split/labels/$(basename "$f")"
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

echo "Wrote combined_dataset/data.yaml"
