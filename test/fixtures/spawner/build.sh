#!/bin/sh
# Builds ../Spawner.wasm: `WASI_SDK_PATH=... CLAP_INCLUDE=... ./build.sh` (WASI SDK 27, CLAP 1.2 headers).
set -e
cd "$(dirname "$0")"
"$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1-threads -pthread -O2 -mexec-model=reactor \
    -I "$CLAP_INCLUDE" spawner.c -o ../Spawner.wasm \
    -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=67108864 \
    -Wl,--export=__stack_pointer,--export=__wasm_init_tls,--export=__tls_size,--export=__tls_align \
    -Wl,--export=__wasi_init_tp,--export=malloc,--export=clap_entry,--export-table,--growable-table
