# Third-party software

This plugin is built with, and its binaries include, the following. CMake downloads them, at versions pinned by the template version (v0.6.1, GIT_TAG in CMakeLists.txt) and by CMakeLists.txt here; keep their notices with anything you distribute. Every build ships their full licence texts in THIRD_PARTY_LICENSES/.

- char-clap-template (its libs/): MIT. https://github.com/charCulbert/char-clap-template
- CLAP SDK: MIT. https://github.com/free-audio/clap
- clap-wrapper, and the VST3 SDK it downloads: MIT (see the SDK's own licence). https://github.com/free-audio/clap-wrapper
- AudioUnit SDK (clap-wrapper downloads it for the AU, on macOS): Apache-2.0. https://github.com/apple/AudioUnitSDK
- RtAudio (clap-wrapper downloads it for the standalone app's audio): MIT-style (RtAudio licence). https://github.com/thestk/rtaudio
- RtMidi (clap-wrapper downloads it for the standalone app's MIDI): MIT-style (RtMidi licence). https://github.com/thestk/rtmidi
- ghc::filesystem (clap-wrapper downloads it on macOS, unless CMAKE_OSX_DEPLOYMENT_TARGET is 10.15 or later): MIT. https://github.com/gulrak/filesystem
- The WASI SDK's runtime (wasi-libc, libc++, libc++abi, the LLVM runtime and dlmalloc), in the WCLAP only: Apache-2.0 with LLVM Exceptions, MIT, or CC0 (dlmalloc). https://github.com/WebAssembly/wasi-sdk
