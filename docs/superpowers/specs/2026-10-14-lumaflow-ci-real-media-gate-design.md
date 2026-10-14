# LumaFlow real-media／e2e 警報層（CI）— Design

Date: 2026-10-14
Status: **Approved by user**（2026-10-14：信任政策 1 → 2、linux-x64、警報語意、release job 路徑 bug 一起修）
Related: 不動 UI、不動 conversion／queue 生產邏輯。這是 CI 與測試信任政策的變更。

## 為什麼（已確認）

repo 裡有一整套真實邊界測試（真實 FFprobe → planner → scheduler → 真實 FFmpeg → 再用真實 `AppShell` 跑無障礙檢查），但：

1. 它**從未在任何自動化裡跑過**：`ci.yml` 被改過 5 次，`git log -p` 中沒有任何一次加入 `test:e2e` 或 `real_media_fixtures`。`ci.yml:47-50` 那句「asset-gated target runs in the explicit release/E2E workflow」從寫下那天起就沒有對應步驟（repo 目前 0 tags，release job 也從未執行過）。
2. 它**結構上只在 darwin-arm64 可跑**：`tests/fixtures/spec.json` 只 commit 了 darwin-arm64 的 ffmpeg／ffprobe **二進位** sha256，`trustedBinaryIdentity()` 用 `process.platform + "-" + process.arch` 查這張表；而 `src-tauri/tests/real_media_fixtures.rs` 的 `ensure_supported_platform()` 更直接硬斷言 `platform == "darwin-arm64"`。CI 的 ubuntu runner 與本機 Linux 都跑不了。

結果：這層測試目前只在作者自己的 Mac 上可跑，實際上沒有在保護任何合併。使用者決定：**先當警報**（跑、報告、但不擋合併）。

## Scope

**在範圍**

1. `tests/fixtures/spec.json`：信任清單由 1 個身份（darwin-arm64）擴為 2 個（＋ linux-x64）。
2. `src-tauri/tests/real_media_fixtures.rs`：
   - `ensure_supported_platform()`（L209-216）由「只准 darwin-arm64」改為「准 darwin-arm64 ＋ linux-x64」，其餘平台照樣拒絕。
   - trust-policy 斷言（L311-316）由 `assets.len() == 1` 改為明確 `== 2` ＋ 兩個 digest 逐一斷言。
3. `.github/workflows/ci.yml`：新增 `real-media` job（linux-x64，`continue-on-error: true`）。
4. 修正 `ci.yml` 中不實的註解，讓它描述實際行為。
5. **修正 `ci.yml` release job 的 archive 路徑錯配**（使用者決定：一起修）。下載步驟把 archive 放到 `src-tauri/binaries/<archive_file>`（L130），解壓步驟卻讀 `src-tauri/binaries/<target>/<archive_file>`（L148；Windows 步驟與後續 `rm` 同樣）。修正後 ci.yml 內所有 archive 引用統一為 `src-tauri/binaries/<archive_file>`；`real-media` job 不複製這組命令，改用 `npm run prepare:ffmpeg`（見 §4）。
6. 文件同步（措辭一致性，屬本變更的必要副產物）：`tests/fixtures/README.md:12-13`（「只支援 darwin-arm64」）、`docs/releasing.md:121`（「matching macOS ARM test assets」）、`docs/installation-and-deployment.md` 補上環境變數與 `npm run fixtures` 的用法。

**不在範圍**（各自是獨立小專案）

- README ＋ LICENSE
- `cargo fmt --check` ＋ `cargo clippy -- -D warnings` 進 CI
- windows-x64／darwin-x64 的信任 digest
- 把警報升級成硬閘門（本 spec 只保留升級路徑，不執行）
- 任何 `src/`、`src-tauri/src/` 的生產碼改動

## 現況事實（已驗證，非推測）

| 事實 | 證據 |
|---|---|
| 環境變數是 `LUMAFLOW_FFMPEG_TEST_BIN`／`LUMAFLOW_FFPROBE_TEST_BIN`（`…_VERSION` 選填） | `scripts/generate-fixtures.ts:19-21`、`tests/e2e/harness.ts:297-298,339-341`、`real_media_fixtures.rs:493-494` |
| `npm run test:e2e` 會**自己去跑 cargo**：`runRealMediaTrace()` spawn `cargo test --test real_media_fixtures real_fixture_probe_and_planner_matrix_and_ui_trace -- --exact --nocapture`，用 `LUMAFLOW_E2E_EVENT_TRACE` 取得 trace.json，再餵給 jsdom 的 `AppShell` | `tests/e2e/harness.ts:320-345`、`tests/e2e/accessibility.spec.ts:22-33` |
| contract 驗證的是「manifest 形狀 ＋ ffmpeg digest 屬於 committed 信任清單」，**不比 golden fixture digest**；`spec.json` 內根本沒有 fixture digest | `tests/fixtures/contract.ts:260-261`；builder 於沙箱實測確認 |
| 生成的 fixtures 與 manifest 是 gitignored，每次現場產生 | `.gitignore:5-9`、`scripts/generate-fixtures.ts:217-249` |
| Rust 測試硬斷言**單一身份**信任政策，且 `ensure_supported_platform()` 是測試第一行 | `real_media_fixtures.rs:209-216, 311-316` |
| linux-x64 的 pin 資產本來就在出貨供應鏈裡 | `scripts/ffmpeg-assets.json`（`linux_x64.zip`, archive sha `150f20cf…`，builder 實下載核對吻合）、`ci.yml:88-93` |
| **linux-x64 端到端已實測全綠**：下載 pin 資產 → 生成 10 個 fixtures → 按本 spec 方式鬆綁 `ensure_supported_platform` ＋ `assets.len()==2` → `cargo test --test real_media_fixtures` 通過（2.42s）→ `npm run test:e2e` **2 files passed, 5 passed \| 1 skipped**（跳過的是 opt-in desktop E2E） | builder 沙箱實驗（`/tmp/opencode/lumaflow-review/`：`cargo-real-media2.log`、`e2e-patched.log`） |
| 實測 linux-x64 二進位 digest（寫入 `spec.json` 的候選值） | ffmpeg `90864f57b2572877d4fe9ecd1c0ec25539b4d1982286cd7522f92c3985e0d9fe`、ffprobe `9fe8a3656406520d5fab158f1a2a04fb6c758063793a29a391fee4760d23d4ba`；兩者皆回報 `ffmpeg version 8.1.2` |
| 該二進位最高要求 `GLIBC_2.35` = ubuntu-22.04 的 glibc → CI runner 可執行 | builder 沙箱 `objdump` 檢查 |
| `cargo test --lib` 基線是 **130** 綠（不是 131） | builder 沙箱實跑；`src-tauri/src` 共 130 個 `#[test]` |
| 本機 `npm run test:e2e` 曾跑出 `3 failed \| 2 passed \| 1 skipped` | 2026-10-14 實跑。**狀態依賴**：該數字反映「gitignored fixtures 已存在但 env 未設」；乾淨 checkout 會是 `4 failed \| 0 passed \| 1 skipped`。不可作為基線 |
| 這層測試**有**文件，但措辭是 darwin 限定 | `docs/releasing.md:120-128`（完整跑法＋「matching macOS ARM test assets」）、`docs/installation-and-deployment.md:113` → `tests/fixtures/README.md` |

**更正先前 review 報告的兩處錯誤**：(a) 環境變數我寫成 `FFMPEG_BINARY`／`FFPROBE_BINARY`，實際是 `LUMAFLOW_FFMPEG_TEST_BIN`／`LUMAFLOW_FFPROBE_TEST_BIN`；(b) Rust 基線我寫 131，實際 130。

## 設計

### 1. 信任清單 1 ＋ 平台 gate 鬆綁（需使用者批准）

`spec.json` 的 assets 擴為：

```json
"assets": {
  "darwin-arm64": { "sha256": "1332dc2d…" },
  "linux-x64":    { "sha256": "90864f57…" }
}
```

理由：linux-x64 的 archive 就是 release job 用來出貨 Linux 安裝包的**同一份 pin 資產**（archive sha256 已 pin 在 `scripts/ffmpeg-assets.json`，CI 已驗證它）。這是把信任延伸到既有出貨供應鏈，不是引入新來源。

原本的 guard 語意要保留並變嚴：`assets.len() == 1` → `== 2`，兩個 digest 逐一斷言，讓「無聲累積身份」仍然是會紅的變更。`ensure_supported_platform()` 同理：白名單 1 → 2，白名單外的平台照樣明確拒絕。

digest 必須**實測得出、不可推想**：plan 第一步是在本機 Linux 跑 `npm run prepare:ffmpeg`（下載 pin archive → 驗 archive sha256 → 解壓 → `chmod 755`），再對 `src-tauri/binaries/linux-x64/ffmpeg`、`ffprobe` 算 sha256，並與上列候選值核對；不一致就以實測值為準並記錄差異原因。

**記錄的替代方案**：e2e job 改跑 `macos-14`，沿用既有 darwin-arm64 身份，信任政策完全不動。代價：macOS runner 較慢較貴、Linux 依賴步驟要重寫、且 Linux 出貨路徑仍然沒有真實邊界測試。本 spec 選 linux-x64。

### 2. 新 CI job：`real-media`（警報語意）

```yaml
real-media:
  name: Real-media boundary (advisory)
  runs-on: ubuntu-22.04
  timeout-minutes: 20
  continue-on-error: true
```

不設 `needs`，與 `check` 平行跑（警報要獨立，不被其他 job 的紅燈掩蓋）。

步驟：

1. checkout、apt Tauri 依賴、Node 22、Rust stable、`npm ci`（沿用 `check` job 的寫法）
2. `npm run prepare:ffmpeg -- --target linux-x64`：這個腳本自己從 `scripts/ffmpeg-assets.json` 讀 URL 與 archive sha256，下載 → 驗 archive sha256 → 解壓 → `chmod 755` → 呼叫 `verifyTargetAssets`（版本與資產完整性）。**不另寫 curl／unzip、不在 ci.yml 硬編碼任何 digest**：新 job 不加入第三份真相（既有 release matrix 的重複屬既有問題，本 spec 不動它）。licenses 與 `-buildconf` 是 release job 的打包需求，警報層不需要。
3. `export LUMAFLOW_FFMPEG_TEST_BIN="$GITHUB_WORKSPACE/src-tauri/binaries/linux-x64/ffmpeg"`、`LUMAFLOW_FFPROBE_TEST_BIN=…/ffprobe`。**必須是絕對路徑**：cargo 跑 integration test 的 cwd 是 `src-tauri/`，相對路徑會失效。
4. `npm run fixtures`
5. `cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures`（直接跑，訊號比藏在 vitest 裡清楚）
6. `npm run test:e2e`
7. 收尾步驟（`if: always()`）：若步驟 5 或 6 的 `steps.<id>.outcome != 'success'`，寫 `::warning::` annotation ＋ `$GITHUB_STEP_SUMMARY`，內容明寫「real-media 警報層失敗，未擋合併」。

**警報語意（builder 更正，重要）**

- job 層 `continue-on-error: true` 的官方語意是「job 失敗不讓 **workflow** 變紅」；**job 本身仍以 failure 結論顯示**。所以可見度 = 紅色 job ＋ annotation，不是「只有 annotation」。
- `if: failure()` 在 `continue-on-error: true` 的 job 裡**不可靠**（continue-on-error 會把 job 當前狀態重置回 success，後面的 `failure()` 為 false）。可靠寫法只有 `if: always()` ＋ `steps.<id>.outcome`。
- **明文規則**：警報期間嚴禁把 `real-media` 設為 required check。branch protection 讀的是 job 的 check 結論——紅色 job 即使有 continue-on-error 也會擋 merge，「不擋合併」的承諾會直接失效。這條要寫進 docs。
- 升級成硬閘門的路徑：刪掉 `continue-on-error: true` ＋ 在 GitHub 端設為 required。本 spec 不執行。

### 3. 首次紅燈的風險：已被實測大幅消除

原本擔心 linux 的 ffmpeg-bins2 build 會產出與 darwin 不同的 probe 結果或 fixture bytes，導致 Rust matrix 斷言紅。builder 已在 linux-x64 端到端實測：probe 斷言、planner matrix（Remux／LosslessAudio／Transcoding／Unsupported）、scheduler cancel／retry、真實 mp3 轉檔、trace 寫入、jsdom `AppShell` 渲染**全部綠**。

所以斷言是平台無關的。plan 仍保留一條應變規則：若 CI 環境（而非本機）出現紅燈，要明確區分「修 production bug」與「放寬測試斷言」，後者必須附理由寫進 commit。

### 4. 順帶發現的既有 bug（本 spec 會碰到）

`ci.yml` 的 release job 有路徑錯配：下載步驟把 archive 放到 `src-tauri/binaries/<archive_file>`（L130），但 Unix 解壓步驟讀 `src-tauri/binaries/<target>/<archive_file>`（L148；Windows 步驟與後續 `rm` 同樣）。因為 repo 0 tags，release job 從未跑過，bug 未暴露。

影響：本 spec 若「照抄 release job 的步驟」會原樣繼承這個 bug，`real-media` job 會因純基建原因必紅。**使用者已決定：這個 PR 一起修掉它**——修正 release job 的 Unix／Windows 解壓步驟與後續 `rm` 的參照，使它與下載步驟寫入的 `src-tauri/binaries/<archive_file>` 一致（實測：ci.yml 內 10 處 archive 引用，7 處正確、3 處錯配在 148／166／213）。`real-media` job **不複製**這組命令，改用 repo 自己的 `npm run prepare:ffmpeg`，避免出現第三份寫法；因此修正後的配對由「本地 dry-run 實跑一次修正後的 Unix 命令序列（curl → `shasum -c` → unzip → find → rm）」證明，而不是由只在 tag 上跑的 release job 證明。這讓本 PR 從「純 CI 增量」變成也碰到出貨打包路徑。

### 5. 本機開發的副作用（正面）

`npm run test:e2e` 與 `cargo test --test real_media_fixtures` 在 Linux 上從「不可能」變成「可行」；Mac 行為不變。文件補上環境變數與 `npm run fixtures` 的用法，並把 darwin 限定措辭改成雙平台。

## 驗證方式（spec 層級）

1. 本機 Linux：`npm run prepare:ffmpeg` → 算 digest → 與候選值核對 → 寫進 `spec.json` → `npm run fixtures` → `cargo test --test real_media_fixtures` → `npm run test:e2e` 全綠。
2. `cargo test --manifest-path src-tauri/Cargo.toml --lib` 仍 **130** 綠。
3. `npm run test -- --run` 仍 **156** 綠。
4. `npm run check:licenses` 仍綠（script 本身已含 `--source-only`，不必再傳一次）。
5. push 到 PR 觀察 `real-media` job：workflow 保持綠、job 失敗時有 warning annotation 與 step summary。

## 風險取捨

| 風險 | 評估 |
|---|---|
| 信任清單擴大（1 → 2）＋ 平台白名單擴大 | 低。同一條已 pin 的出貨供應鏈；guard 斷言保留且變嚴（明確 2 個 digest、白名單外明確拒絕）。 |
| CI 分鐘數增加 | 一個 linux job，含全量 cargo build（ci.yml 目前沒有 cargo cache）＋ 真實轉檔，粗估數分鐘。可選加 rust-cache；第一版不加（忠於「不新寫邏輯」）。 |
| 首次紅燈 | 本機已實測全綠，風險主要剩 CI 環境差異。 |
| 警報長期被忽略 | 真實風險。GitHub 沒有內建通知；需定義升級條件與檢視機制（見「待批准」）。 |

## 決定紀錄（全部已批准，2026-10-14）

- 警報語意（跑、報告、不擋合併）：使用者決定。
- 平台選擇 linux-x64（而非 macOS runner）：builder check 後提出，使用者批准。
- release job 路徑 bug 一起修：使用者決定。
- **信任政策 1 → 2**：linux-x64 實測 digest 寫進 `tests/fixtures/spec.json`，`ensure_supported_platform()` 白名單擴為 darwin-arm64 ＋ linux-x64：使用者批准。
- **警報升級條件**（我的判斷，可隨時改）：docs 寫明「`real-media` 在 main 上連續 10 次綠之後，刪掉 `continue-on-error` 並設為 required check」；在此之前**嚴禁**把它設為 required（branch protection 讀 job 的 check 結論，紅 job 會直接擋 merge）。
- 紅燈處理紀律：`real-media` 紅燈要修或開 issue；若紅燈來自斷言過窄而非真實 bug，放寬斷言必須附理由寫進 commit message。
