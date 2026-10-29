# Changelog

All notable changes to this crate are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-10-03

### Changed

- Updated to AnyRender 0.14 and explicit clip fill rules (#105).
- Upgraded `skia-safe` to 0.153.3 (#101).
- Removed the unused `textlayout` feature except on Windows, where it is required for prebuilt binaries (#102).
- Use Metal-only Skia GPU features on macOS and iOS, avoiding unnecessary OpenGL/Vulkan builds (#106).

### Fixed

- Enabled subpixel font positioning (#97).

## [0.11.0] - 2026-08-16

### Changed

- Upgraded `skia-safe` to 0.99 (#82).

### Fixed

- Rounded rect corner radii mapping (#76).
- Box shadow blurs now respect the current transformation matrix (#75).
- The image `Blob` is now held alongside the cached image shader, preventing use-after-free of image data (#77).

## [0.10.0] - 2026-07-23

### Added

- Configurable composite alpha modes, transparency and base color via `SkiaRendererOptions` (#71).
- Implemented additional filter effects: Composite, Blend, Morphology, ConvolveMatrix, Turbulence, DisplacementMap, DiffuseLighting and SpecularLighting ([`c8f476b`](https://github.com/dioxuslabs/anyrender/commit/c8f476b)).

## [0.9.0] - 2026-06-04

### Added

- Support for filter effects (#64).
- Public constructors for `SkiaScenePainter` and `SkiaSceneCache` ([`44566e2`](https://github.com/dioxuslabs/anyrender/commit/44566e2)).

### Changed

- Upgraded `oaty` to 0.2 ([`fd67bcf`](https://github.com/dioxuslabs/anyrender/commit/fd67bcf)) and `hashbrown` to 0.17 ([`e52b858`](https://github.com/dioxuslabs/anyrender/commit/e52b858)).

## [0.8.1] - 2026-05-30

### Fixed

- Require a `skia-safe` version that builds documentation correctly ([`3c20f6b`](https://github.com/dioxuslabs/anyrender/commit/3c20f6b)).

## [0.8.0] - 2026-05-15

### Changed

- Upgraded `skia-safe` to 0.97.0 ([`d57a6cd`](https://github.com/dioxuslabs/anyrender/commit/d57a6cd)).

## [0.7.0] - 2026-05-15

### Changed

- Upgraded to WGPU v29, Vello 0.9 and Sparse Strips 0.0.8 (#62).

## [0.6.0] - 2026-05-10

### Added

- Render `Context` and resource (e.g. wgpu `Texture`) registration (#58).

### Changed

- Made `WindowRenderer::resume` async (with a callback) for wasm-friendly wgpu initialization (#59).

## [0.5.0] - 2026-03-25

### Added

- Support for dash intervals (#51).

### Changed

- Upgraded `skia-safe` to v0.93 (#54).

### Fixed

- Size `render_to_vec` buffers before wrapping pixels (#49).
- Convert `DynamicColor` to sRGB before creating `SkColor4f` (#48).

## [0.4.0] - 2026-01-15

### Changed

- Upgraded to kurbo 0.13, peniko 0.6, wgpu 27, vello 0.7 and vello_cpu/hybrid 0.0.6 (#37).

## [0.3.1] - 2025-12-29

### Fixed

- Fixed the crate on iOS ([`671142c`](https://github.com/dioxuslabs/anyrender/commit/671142c)).

## [0.3.0] - 2025-12-27

### Changed

- Upgraded `skia-safe` from v0.90.0 to v0.91.0 ([`0cdcedf`](https://github.com/dioxuslabs/anyrender/commit/0cdcedf)).

## [0.2.0] - 2025-11-03

### Changed

- Upgraded `skia-safe` to 0.90.0 ([`19696cb`](https://github.com/dioxuslabs/anyrender/commit/19696cb)).

## [0.1.4] - 2025-10-30

### Added

- `push_clip_layer` support (#30).

## [0.1.3] - 2025-10-29

### Added

- Skia raster (software) rendering support (#26).

## [0.1.2] - 2025-10-28

### Added

- Skia cache limits (#24).

### Changed

- Improved the Vulkan backend (#25).

## [0.1.1] - 2025-10-27

### Changed

- Further performance improvements (#23).

## [0.1.0] - 2025-10-27

### Changed

- First stable release, following the `0.1.0-beta` series ([`757c78f`](https://github.com/dioxuslabs/anyrender/commit/757c78f)).

## [0.1.0-beta.4] - 2025-10-27

### Fixed

- Push clip before layer ([`7d8ecb0`](https://github.com/dioxuslabs/anyrender/commit/7d8ecb0)).

## [0.1.0-beta.3] - 2025-10-27

### Added

- Font caching (#22).

### Changed

- Scene improvements (#21).

## [0.1.0-beta.2] - 2025-10-26

### Changed

- Use a mask filter for box shadow blur (#19).
- Use linear image sampling ([`613eeda`](https://github.com/dioxuslabs/anyrender/commit/613eeda)).
- Removed redundant save/restore calls ([`3273d3b`](https://github.com/dioxuslabs/anyrender/commit/3273d3b)).

### Fixed

- Fixed TTC font loading on macOS (#20).

## [0.1.0-beta.1] - 2025-10-25

### Added

- Initial Skia backend for anyrender (#17).
