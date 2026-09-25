# Third-party notices

## AIChat

BotConnector's Rust CLI, provider integrations, HTTP API, and supporting code are derived from [AIChat by sigoden](https://github.com/sigoden/aichat). Upstream copyright notices and the MIT and Apache-2.0 license texts are preserved in `LICENSE-MIT` and `LICENSE-APACHE`.

## Electron

The desktop shell uses Electron, distributed under the MIT license. Electron's dependency notices are supplied by the installed Electron package and must be included in desktop distributions.

## Local inference components

The desktop app downloads these optional runtime components from their official GitHub releases instead of bundling them in the installer:

- [llama.cpp](https://github.com/ggml-org/llama.cpp), MIT. Its `LICENSE` is stored next to the installed runtime.
- [llama-swap](https://github.com/mostlygeek/llama-swap), MIT. Its `LICENSE.md` is stored next to the installed binary.
- [llmfit](https://github.com/AlexsJones/llmfit), MIT. Its `LICENSE` is stored next to the installed binary.

The installer includes the AIChat MIT and Apache-2.0 license texts and this notice at `resources/licenses/`.
