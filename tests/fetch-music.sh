#!/usr/bin/env sh
# Downloads four Creative Commons tracks (from librosa's example data) used by
# tests/music.test.cjs, and checks them against librosa's published sha256 sums.
set -eu
cd "$(dirname "$0")"
mkdir -p .music
BASE=https://raw.githubusercontent.com/librosa/data/main/audio

fetch() {
  name=$1; sum=$2
  out=".music/$name.hq.ogg"
  if [ ! -f "$out" ]; then
    echo "Downloading $name"
    curl -fsSL -o "$out" "$BASE/$name.hq.ogg"
  fi
  echo "$sum  $out" | sha256sum -c --quiet - || { rm -f "$out"; echo "Checksum mismatch for $name" >&2; exit 1; }
}

fetch Kevin_MacLeod_-_Vibe_Ace 73d6443ef90a7c022f164e5aa90e56c2291585930b39b1656d0765abbc1f1779
fetch admiralbob77_-_Choice_-_Drum-bass 57b4d95473b92a8441c1d3ab20f836a3e0cbf501bf3afe1ce7a5d0d98d7d4576
fetch Karissa_Hobbs_-_Lets_Go_Fishin 85901bde0bc5f2cad28acb83487ccf99bd6908d7359f1a449fd799d8bebb3319
fetch 442789__lena-orsa__happy-music-pistachio-ice-cream-ragtime 1cc83b775e640a8dd409da9e29f5b5e0124bc5ec9bb4fda975919d31d1d893b8
echo "Test music ready in tests/.music"
