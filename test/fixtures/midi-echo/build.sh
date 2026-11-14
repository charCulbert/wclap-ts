#!/bin/sh
# Builds ../MidiEcho.wasm: `WASI_SDK_PATH=... CLAP_INCLUDE=... ./build.sh` (WASI SDK 27, CLAP 1.2 headers).
set -e
cd "$(dirname "$0")"
"$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 -O2 -mexec-model=reactor -I "$CLAP_INCLUDE" midi-echo.c \
    -o ../MidiEcho.wasm -Wl,--export=malloc,--export=clap_entry,--export-table,--growable-table
