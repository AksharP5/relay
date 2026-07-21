# Changelog

## [0.2.0](https://github.com/AksharP5/relay/compare/v0.1.4...v0.2.0) (2026-07-21)


### Features

* make switch key configurable ([51e593b](https://github.com/AksharP5/relay/commit/51e593b80566eda07431465b2ec735f1831dbf0b))
* open relay in an explicit directory ([#12](https://github.com/AksharP5/relay/issues/12)) ([4b9d55a](https://github.com/AksharP5/relay/commit/4b9d55af445b5f3ba19c2d6fe48382bd892c73ed))


### Bug Fixes

* **cli:** tighten argument contracts ([#35](https://github.com/AksharP5/relay/issues/35)) ([b1c7af2](https://github.com/AksharP5/relay/commit/b1c7af2a4fe17a273860809c51047f90ba6d9674))
* explain uncertain headless recovery ([#11](https://github.com/AksharP5/relay/issues/11)) ([e4edce4](https://github.com/AksharP5/relay/commit/e4edce409abfbd1b3b527b4ddb85edb06dd1789b))
* fail doctor for unavailable harnesses ([#37](https://github.com/AksharP5/relay/issues/37)) ([1bc4ba9](https://github.com/AksharP5/relay/commit/1bc4ba9c7c494a7db4631ddf2fae9cc1d262d9b8))
* make orphan recovery actionable ([#36](https://github.com/AksharP5/relay/issues/36)) ([6be6327](https://github.com/AksharP5/relay/commit/6be63276233a2b1019b8cfa6c6fbd141e4c4f7dc))
* preserve OpenCode startup cancellation ([#14](https://github.com/AksharP5/relay/issues/14)) ([3302362](https://github.com/AksharP5/relay/commit/3302362914bda422323c664bce4117ef8bc734aa))
* validate vendor JSON at adapter boundaries ([#45](https://github.com/AksharP5/relay/issues/45)) ([e4a0b74](https://github.com/AksharP5/relay/commit/e4a0b74a2d5bbde659d93ddd28492ea7f325d2e6))

## [0.1.4](https://github.com/AksharP5/relay/compare/v0.1.3...v0.1.4) (2026-07-13)


### Bug Fixes

* **release:** allow tag recovery after skipped gates ([3847f12](https://github.com/AksharP5/relay/commit/3847f12ecc9f7e0985e8324dca204c7fd4e37eba))
* **release:** gate recovery jobs directly ([43a0d2c](https://github.com/AksharP5/relay/commit/43a0d2ccd21342bdd4a22149805ab83213077297))

## [0.1.3](https://github.com/AksharP5/relay/compare/v0.1.2...v0.1.3) (2026-07-13)


### Bug Fixes

* **release:** propagate recovery context ([c097f04](https://github.com/AksharP5/relay/commit/c097f046f7a389125caf891fc192788228c16daa))

## [0.1.2](https://github.com/AksharP5/relay/compare/v0.1.1...v0.1.2) (2026-07-13)


### Bug Fixes

* **release:** align recovery provenance with tags ([3c31605](https://github.com/AksharP5/relay/commit/3c31605f1db6f3e1dc59164b7ba92b12fc9ad701))
* **release:** isolate trusted publishing ([706abc4](https://github.com/AksharP5/relay/commit/706abc4da130379da2e38e3626bf72a047a89a18))
* **store:** serialize local index writers ([2f77f53](https://github.com/AksharP5/relay/commit/2f77f536bdf8378da89e29d6bac1b402a013eb8e))

## [0.1.1](https://github.com/AksharP5/relay/compare/v0.1.0...v0.1.1) (2026-07-13)


### Bug Fixes

* **docs:** clarify supported platforms ([902571a](https://github.com/AksharP5/relay/commit/902571a2100044db386f9981d0f569a7375a66b2))
* **release:** ignore generated changelog formatting ([c40d3dd](https://github.com/AksharP5/relay/commit/c40d3dd976f8c974b1bfc5e5d6b89efc4481a45b))

## 0.1.0 (2026-07-13)

The first public preview of Relay.

- Run the real Codex and OpenCode TUIs in one terminal workspace.
- Switch between native harnesses while preserving completed visible context.
- Adopt and resume existing native sessions from the current workspace.
- Keep native slash commands, dialogs, approvals, models, themes, and rendering.
- Install one platform-matched executable through npm without requiring Bun at runtime.
