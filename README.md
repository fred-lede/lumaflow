# LumaFlow

**繁體中文** | [English](README_En.md)

LumaFlow 是 Tauri 2、React、TypeScript 與 Rust 寫成的桌面媒體轉檔工具。FFmpeg 與 FFprobe
內嵌在每個發布目標裡，轉檔不依賴使用者電腦上的系統 FFmpeg。

目前版本 `0.1.0`。

## 快速開始

```sh
git clone https://github.com/fred-lede/lumaflow.git
cd lumaflow
npm ci
npm run tauri dev
```

`npm run tauri dev` 會先執行 `npm run prepare:ffmpeg`，依目前平台下載並驗證 `scripts/ffmpeg-assets.json`
鎖定的 FFmpeg/FFprobe 資產。第一次需要網路連線，之後可離線重複執行。支援的建置主機為
`darwin-arm64`、`darwin-x64`、`windows-x64`、`linux-x64`，其他主機（例如 linux-aarch64）會直接丟出
`Unsupported build host`。

只啟動前端預覽（`npm run dev`）可以看見介面，但沒有 Tauri 的檔案選擇器、原生拖曳授權與實際轉檔能力；
要測試真實轉檔請用 `npm run tauri dev`。

## 需求

- Node.js 22.6.0 或更新版本、npm
- Rust stable toolchain（建議用 [rustup](https://rustup.rs/)）；Windows 建置要用 MSVC toolchain
  （`rustup default stable-msvc`）
- Git
- 各平台的原生相依套件：macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio Build Tools
  與 WebView2 Runtime；Linux 需要 WebKitGTK、AppIndicator、librsvg、patchelf 等套件。

完整的平台設定步驟見 [docs/installation-and-deployment.md](docs/installation-and-deployment.md)。

## 測試

```sh
npm run typecheck
npm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run check:licenses
```

這幾條與 CI 的 `check` job 相同，都是擋合併的閘門。

真實媒體層（real-media fixtures 與 E2E）需要 pin 資產與現場生成的 fixtures，白名單為
`darwin-arm64` 與 `linux-x64`；CI 裡這層目前是警報，不擋合併：

```sh
npm run prepare:ffmpeg
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffprobe"
npm run fixtures
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
npm run test:e2e
```

`<target>` 用 `darwin-arm64` 或 `linux-x64`。兩個環境變數必須是絕對路徑，因為 cargo 執行
integration-test binary 時的工作目錄是 `src-tauri/`。細節見
[tests/fixtures/README.md](tests/fixtures/README.md) 與 [docs/releasing.md](docs/releasing.md)。

## 建置安裝包

```sh
npm run tauri build
```

產物在 `src-tauri/target/release/bundle/`（macOS `.dmg`、Windows NSIS `.exe`／`.msi`、
Linux `.AppImage`）。正式發布、資產驗證與簽署流程見 [docs/releasing.md](docs/releasing.md)。

## Repo 導覽

| 路徑 | 內容 |
| --- | --- |
| `src/` | React 前端：`app/`、`domain/`、`features/`、`shared/`、`ui/`、`styles/` |
| `src-tauri/` | Rust backend（`src-tauri/src/` 下的 `commands/`、`domain/`、`jobs/`、`media/`）、`Cargo.toml`、`tests/` |
| `scripts/` | FFmpeg 資產準備與驗證、fixtures 產生、license 檢查 |
| `tests/` | 前端單元測試與 `tests/e2e/` |
| `docs/` | 安裝部署、發布流程、設計文件 |
| `.github/workflows/ci.yml` | `check`（阻擋合併）、`real-media`（警報）、`release`／`publish`（tag 觸發） |

## 授權與第三方資產

LumaFlow 的原始碼以 [MIT License](LICENSE) 釋出，版權線 `Copyright (c) 2026 Fred Wang`。

FFmpeg/FFprobe 與字型等第三方元件**不適用**上述 MIT 授權。這些元件的授權義務由
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 記錄並在打包時一併帶出：選用的 FFmpeg 建置為
GPL-3.0-or-later，Geist 字型為 SIL Open Font License 1.1。FFmpeg/FFprobe 執行檔不進 Git，
由 `prepare:ffmpeg` 或 release job 依鎖定的 SHA-256 下載驗證。
