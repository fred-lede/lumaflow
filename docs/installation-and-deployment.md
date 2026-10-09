# LumaFlow 安裝與部署指南

本文件說明 LumaFlow 的本機開發、跨平台建置、安裝方式，以及正式發布前的檢查流程。

LumaFlow 使用 Tauri 2、React、TypeScript、Rust 與內嵌的 FFmpeg/FFprobe。轉檔時不依賴使用者電腦上的系統 FFmpeg；每個發布目標都必須帶有對應的媒體工具。

## 1. 支援平台與目前狀態

| 目標 | Tauri target directory | 發布格式 | 目前 repository 狀態 |
| --- | --- | --- | --- |
| macOS Apple Silicon | darwin-arm64 | .dmg | 已準備本機工具資產 |
| macOS Intel | darwin-x64 | .dmg | 由 release workflow 注入 |
| Windows 64-bit | windows-x64 | NSIS .exe、.msi | 由 release workflow 注入 |
| Linux 64-bit | linux-x64 | .AppImage | 由 release workflow 注入 |

目前 source checkout 只保留 src-tauri/binaries/darwin-arm64/ 的本機 FFmpeg/FFprobe。Windows、Linux 與 macOS Intel 的發布資產由 GitHub Actions 依照 scripts/ffmpeg-assets.json 下載、驗證後再打包；不要直接用系統 PATH 上的 FFmpeg 代替發布資產。

## 2. 開發環境

### 共通需求

- Node.js 22.6.0 或更新版本
- npm
- Rust stable toolchain
- Git

安裝 Rust 建議使用 [rustup](https://rustup.rs/)。Windows 建置需使用 MSVC toolchain：

~~~powershell
rustup default stable-msvc
~~~

### macOS

安裝 Xcode Command Line Tools：

~~~sh
xcode-select --install
~~~

若要發布 macOS 應用程式，另外需要 Apple Developer ID、簽署與 notarization 設定。Tauri 官方要求 macOS Catalina 10.15 或更新版本。

### Windows

安裝以下元件：

1. Visual Studio Build Tools 的 Desktop development with C++ 工作負載。
2. Microsoft Edge WebView2 Runtime。
3. 若要產生 MSI，確認 Windows Optional Features 中的 VBScript 已啟用。

Windows 10 1803 及更新版本通常已包含 WebView2，但正式部署前仍應在乾淨電腦確認。

### Linux

以 Ubuntu/Debian 為例：

~~~sh
sudo apt update
sudo apt install --no-install-recommends \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  unzip
~~~

不同發行版的套件名稱可能不同，請參考 [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 3. 下載與安裝專案

~~~sh
git clone https://github.com/fred-lede/lumaflow.git
cd lumaflow
npm ci
~~~

確認工具版本：

~~~sh
node --version
npm --version
rustc --version
cargo --version
npm exec -- tauri info
~~~

## 4. 本機開發與測試

啟動完整 Tauri 桌面開發環境：

~~~sh
npm run tauri dev
~~~

只啟動前端 Vite 預覽：

~~~sh
npm run dev
~~~

前端預覽頁不具備完整的 Tauri 原生檔案選擇器、拖拉授權、FFmpeg 執行與輸出檔案預覽能力；要測試實際轉檔，請使用 npm run tauri dev。

建議在提交前執行：

~~~sh
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
node --experimental-strip-types scripts/check-third-party-licenses.ts --source-only
~~~

若要執行真實媒體 fixture 測試，請先依照 [tests/fixtures/README.md](../tests/fixtures/README.md) 設定受信任的 FFmpeg 與 FFprobe 路徑。

## 5. FFmpeg/FFprobe 資產

打包後，Rust backend 會從應用程式的 resource directory 讀取：

~~~text
resources/
└── binaries/
    └── <target>/
        ├── ffmpeg       # Windows 為 ffmpeg.exe
        ├── ffprobe      # Windows 為 ffprobe.exe
        ├── ffmpeg-buildconf.txt
        ├── licenses/
        └── THIRD_PARTY_NOTICES.md
~~~

Release target、來源 URL、版本與 SHA-256 都鎖定在 [scripts/ffmpeg-assets.json](../scripts/ffmpeg-assets.json)。目前鎖定版本為 FFmpeg/FFprobe 8.1.2。

### 驗證某個目標的資產

先將 archive 與解壓後的執行檔放到目標目錄，再執行：

~~~sh
target=darwin-arm64
asset_dir="src-tauri/binaries/$target"
archive="$asset_dir/darwin_arm64.zip"

"$asset_dir/ffmpeg" -buildconf > "$asset_dir/ffmpeg-buildconf.txt"

node --experimental-strip-types scripts/verify-ffmpeg-assets.ts \
  --target "$target" \
  --asset-dir "$asset_dir" \
  --archive "$archive"

node --experimental-strip-types scripts/check-third-party-licenses.ts \
  --target "$target" \
  --asset-dir "$asset_dir" \
  --archive "$archive" \
  --write
~~~

驗證會檢查 archive SHA-256、執行權限、FFmpeg/FFprobe 版本、build configuration、上游 license 與 generated notice。任何一項不符都應停止發布。

完整的 release asset 流程請參考 [releasing.md](releasing.md)。

## 6. 建置安裝包

所有命令都會先執行 npm run build，再由 Tauri 產生 bundle。輸出位於 src-tauri/target/release/bundle/。

### macOS Apple Silicon

在 Apple Silicon Mac 上：

~~~sh
npm run tauri build -- --bundles dmg
~~~

常見產物：

~~~text
src-tauri/target/release/bundle/macos/LumaFlow.app
src-tauri/target/release/bundle/dmg/LumaFlow_*.dmg
~~~

安裝時開啟 .dmg，將 LumaFlow.app 拖到 Applications。未簽署或未 notarize 的版本，macOS 可能會在第一次開啟時顯示安全性警告。

### macOS Intel

需準備 darwin-x64 的 FFmpeg/FFprobe 資產，並在 Intel Mac 或已完成交叉編譯設定的環境建置：

~~~sh
npm run tauri build -- --target x86_64-apple-darwin --bundles dmg
~~~

### Windows 64-bit

需準備 src-tauri/binaries/windows-x64/ffmpeg.exe 與 ffprobe.exe，在 Windows 建置：

~~~powershell
npm run tauri build
~~~

常見產物：

~~~text
src-tauri/target/release/bundle/nsis/LumaFlow_*-setup.exe
src-tauri/target/release/bundle/msi/LumaFlow_*.msi
~~~

一般使用者建議使用 NSIS setup；企業部署或需要 MSI 的環境才使用 MSI。未簽署的 Windows installer 可能觸發 SmartScreen 警告。

### Linux x64

需準備 src-tauri/binaries/linux-x64/ffmpeg 與 ffprobe，再於 Linux 建置：

~~~sh
npm run tauri build -- --bundles appimage
~~~

安裝／執行 AppImage：

~~~sh
chmod +x src-tauri/target/release/bundle/appimage/LumaFlow_*.AppImage
./src-tauri/target/release/bundle/appimage/LumaFlow_*.AppImage
~~~

## 7. GitHub Actions 正式發布

repository 的 release workflow 會在 push version tag 時執行：

~~~sh
git tag v0.1.0
git push origin v0.1.0
~~~

流程會依序下載並驗證各平台的 FFmpeg archive、產生 third-party notice、建置 macOS DMG、Windows NSIS installer、Linux AppImage、產生 checksum，最後上傳 artifacts 並建立 GitHub Release。

正式發布前仍需設定平台簽署憑證與 secrets。macOS 發布到 App Store 以外通常需要 Developer ID 簽署與 notarization；Windows 也建議使用正式的程式碼簽署憑證。

## 8. 發布後安裝驗證

每個平台至少執行一次乾淨環境 smoke test：

1. 驗證下載檔案的 SHA-256。
2. 安裝或啟動 LumaFlow。
3. 選擇一個小型 MP4 或 WAV 檔案。
4. 分別測試 MP3、WAV、FLAC 輸出。
5. 確認輸出檔案可由作業系統播放程式開啟。
6. 確認不需要在系統 PATH 額外安裝 FFmpeg。
7. 測試檔案選擇器、拖拉加入、輸出資料夾選擇、取消、重試與播放預覽。

Linux 另外確認 AppImage 可執行：

~~~sh
./LumaFlow_*.AppImage --appimage-version
~~~

## 9. 常見問題

### 啟動後顯示找不到 FFmpeg 或 FFprobe

確認目前平台對應的目錄與檔案名稱：

~~~text
src-tauri/binaries/darwin-arm64/ffmpeg
src-tauri/binaries/darwin-arm64/ffprobe
src-tauri/binaries/darwin-x64/ffmpeg
src-tauri/binaries/windows-x64/ffmpeg.exe
src-tauri/binaries/windows-x64/ffprobe.exe
src-tauri/binaries/linux-x64/ffmpeg
src-tauri/binaries/linux-x64/ffprobe
~~~

非 Windows 執行檔也必須有 executable permission：

~~~sh
chmod 755 src-tauri/binaries/<target>/ffmpeg src-tauri/binaries/<target>/ffprobe
~~~

### 瀏覽器預覽頁無法選檔或轉檔

這是預期行為。純 Vite 頁面沒有 Tauri command bridge 與內嵌 FFmpeg，請改用 npm run tauri dev。

### macOS 顯示無法驗證開發者

這通常表示 app 尚未完成簽署或 notarization。開發測試可在系統安全性設定中允許該 app；對外發布則應完成 Developer ID signing 與 notarization，不應要求一般使用者關閉系統安全性功能。

### Linux AppImage 啟動失敗

先確認檔案有執行權限，再檢查 WebKitGTK、AppIndicator、librsvg 與其他 Tauri 系統相依套件。請不要用新發行版建置後直接假設所有舊版 Linux 都能執行。

## 10. 參考資料

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri distribution overview](https://v2.tauri.app/distribute/)
- [Tauri macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri Linux AppImage](https://tauri.app/distribute/appimage/)
- [LumaFlow release verification](releasing.md)
