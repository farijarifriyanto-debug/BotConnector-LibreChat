# BotConnector

BotConnector is a local-first AI workspace built from the AIChat Rust project. One Rust core powers three ways to work: a terminal CLI, a browser workspace, and an Electron desktop app. Model and provider settings stay in the core configuration, so each surface uses the same setup.

## What works in this foundation

- Chat in the terminal with AIChat's provider, session, role, RAG, tool, and agent support.
- Run the same core as an OpenAI-compatible local HTTP server.
- Use the BotConnector web workspace at the server root; the existing API remains available at `/v1`.
- Open that workspace in a sandboxed Electron desktop window.
- Keep the default server bound to `127.0.0.1`.
- In the desktop app, browse BotConnector's GGUF catalog, download models, and manage local inference.
- Use llama-swap as a separate model manager in front of llama.cpp, with per-model profiles, running-model status, and unload controls.
- Use llmfit's local REST API for hardware-fit recommendations, memory requirements, and estimated token speed.

The web workspace stores its conversation list in that browser profile. Provider credentials and model configuration remain in the core's local configuration directory. Local model management uses a separate BotConnector service on loopback; the web page never receives filesystem or process access directly.

## Requirements

- Rust toolchain supported by the included `Cargo.toml`.
- Node.js 22.12 or newer and npm for the Electron shell.
- A provider account/API key or a locally running OpenAI-compatible model endpoint.

## Run the CLI

```powershell
cargo run
cargo run -- "Explain how local inference works"
cargo run -- --info
```

The first CLI run initializes the BotConnector configuration. To configure it later, edit the config file shown by `cargo run -- --info`. The sample provider configurations are in [`config.example.yaml`](config.example.yaml).

## Run the web workspace

```powershell
cargo run -- --serve
```

This starts the local API and opens <http://127.0.0.1:8000> in your default browser. Add `--no-open` for headless use. When the desktop companion is installed, the server starts its local model-management service automatically, so the browser workspace can browse, download, and run GGUF models on this computer. For development, install the desktop dependencies with `npm install` before running the CLI server. Keep the server on localhost unless you put an authenticated boundary in front of it.

The chat workspace exposes read-only `web_search` and `web_fetch` tools to models that support function calling. Web search uses the Exa Search API and requires `BOTCONNECTOR_EXA_API_KEY`; add it to the `.env` file shown by `cargo run -- --info`, then restart BotConnector. Exa documents free credits for new accounts, after which its account pricing and limits apply. Search queries are sent to Exa, and retrieved page text is sent to the configured model provider. Direct page fetching is limited to public HTTP/HTTPS hosts, 5 MB, and 30,000 characters. A site may reject direct fetching, in which case the model should identify that limitation and rely only on returned search evidence. If a model rejects tool calling, the chat reports that web search is unavailable for that model and continues without claiming it searched. Intermediate model text is buffered so tool narration and reasoning do not flash in the chat before the final answer.

## Run the desktop app

```powershell
npm install
npm run desktop
```

The desktop command builds the Rust core, starts it on `127.0.0.1:18763`, and opens the shared web workspace in Electron. To create a platform installer, run `npm run dist` on the target platform.

The desktop app's **Temukan model**, **Model terpasang**, **Unduhan**, **Cocok untuk PC**, and **Runtime** sections manage local GGUF models. On Windows x64, **Pasang semua komponen** installs the selected llama.cpp backend and downloads the official llama-swap and llmfit release binaries. Their upstream MIT license files are kept beside the installed binaries. llama-swap listens only on `127.0.0.1:11435`; llmfit listens only on `127.0.0.1:18766`. The app exposes neither service to the network.

To chat locally, install the runtime components, download a GGUF, choose **Pakai model** under **Model terpasang**, then select **Model lokal (llama-swap)** in the chat model picker. The profile is selected immediately and the model loads on the first chat request. Use **Runtime** to select a profile or unload one or all running models.

The local model folder defaults to `%USERPROFILE%\BotConnector AI\models`. The catalog is served by the BotConnector website, while model files are downloaded from Hugging Face. The catalog origin can be overridden for development with `BOTCONNECTOR_CATALOG_URL`.

The hardware page shows what the installed llmfit build can detect on the current operating system. Its Windows support covers CPU and RAM, plus NVIDIA GPUs when `nvidia-smi` is available; AMD ROCm and Intel sysfs detection require Linux, and Apple unified memory detection requires macOS. The desktop app and browser workspace use the same loopback HTTP API for local model management. A standalone Rust binary without the desktop companion still serves provider chat, but cannot manage local runtimes or model files.

## Configure a model

The core supports AIChat's provider configuration format, including OpenAI-compatible endpoints. Run `cargo run -- --info` to see the active config path, then add provider credentials and model entries there. The browser and desktop setup panel points back to this shared local configuration; it never asks you to paste a secret into the web page.

## Upstream and licenses

This project currently builds on [sigoden/aichat](https://github.com/sigoden/aichat). Its upstream history is retained as the `upstream` Git remote. AIChat is available under either the MIT or Apache-2.0 license; see [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE). Product-specific changes are maintained in this repository.
## Web First

BotConnector memiliki track Web terpisah dari shell Electron. Build statis hanya berisi UI dan tidak memuat `desktop/` atau kredensial provider:

```powershell
npm run web:build
npm run web:dev
```

`npm run web:dev` melayani `dist/web` (default `http://127.0.0.1:8080`) dan meneruskan hanya endpoint cloud OpenAI-compatible ke gateway Rust pada `BOTCONNECTOR_WEB_GATEWAY` (default `http://127.0.0.1:8000`). Endpoint `/api/botconnector/local/*` tidak diekspos oleh server Web. Untuk fitur lokal, klik **Hubungkan Local Core**; browser menghubungi Local Core pada endpoint yang dikonfigurasi dan Core mengendalikan model, runtime, tools, serta MCP.

Endpoint Local Core untuk build dapat diubah dengan `BOTCONNECTOR_LOCAL_CORE_BASE` (default `http://127.0.0.1:18764`); port inference internal tidak ditanamkan ke bundle Web.

Production reverse proxy perlu menerapkan header dari `dist/web/security-headers.json` dan mengisi allowlist origin Local Core melalui `BOTCONNECTOR_ALLOWED_WEB_ORIGINS`. Jangan menaruh API key provider di bundle atau storage browser.
