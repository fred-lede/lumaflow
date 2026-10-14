# real-media／e2e 警報層（CI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓真實邊界測試（真實 FFprobe → planner → scheduler → 真實 FFmpeg → 真實 `AppShell`）在 linux-x64 上可跑，並在 CI 新增一個「紅了但不擋合併」的 `real-media` 警報 job。

**Architecture:** 三層變更，彼此獨立可各自審查：(1) 測試信任政策——`tests/fixtures/spec.json` 的 trusted identity 由 1 個擴為 2 個，Rust 端平台白名單同步；(2) `ci.yml` release job 的 archive 路徑錯配修正；(3) `ci.yml` 新增 `real-media` job（`continue-on-error: true`）。生產碼（`src/`、`src-tauri/src/`）完全不動。

**Tech Stack:** Rust（cargo test integration target）、TypeScript／Vitest、Node `--experimental-strip-types` 腳本、GitHub Actions YAML。

**Spec:** `docs/superpowers/specs/2026-10-14-lumaflow-ci-real-media-gate-design.md`（executors 必須同時讀 spec）

## Global Constraints

- 不新增 npm 或 cargo 依賴。
- 不動 `src/`、`src-tauri/src/` 的任何生產碼；不動 conversion / intake / queue / preference 邏輯與 UI。
- trusted identity 白名單**只准兩個**：`darwin-arm64`、`linux-x64`。白名單外的平台必須以明確訊息拒絕。
- digest 必須**實測得出**，不可推想或複製候選值而不核對。
- 環境變數名稱固定：`LUMAFLOW_FFMPEG_TEST_BIN`、`LUMAFLOW_FFPROBE_TEST_BIN`（`LUMAFLOW_FFMPEG_TEST_VERSION` 選填）。指向二進位的路徑一律用**絕對路徑**（cargo 執行 integration test 的 cwd 是 `src-tauri/`，相對路徑會失效）。
- `real-media` job：`continue-on-error: true`、`timeout-minutes: 20`、不設 `needs`；警報期間**嚴禁**設為 required check。
- 基線（不可退化）：`npm run test -- --run` → 156 tests／18 files 綠；`cargo test --manifest-path src-tauri/Cargo.toml --lib` → 130 tests 綠。
- 工作分支：`ci-real-media-gate`（主工作樹開分支，沿用上一輪做法）。
- commit 前綴沿用 repo 風格：`test:`、`fix(ci):`、`build(ci):`、`docs:`。

## Review Focus

spec 暗示但沒有哪個 task 的測試直接覆蓋的失敗模式——每一條都在 owning task 裡有對應步驟：

1. **trusted identity 被無聲擴大成第三個**（有人日後又加一個平台 digest 卻沒人審）→ TS 與 Rust 兩側都要立刻紅。→ Task 1 Step 2（TS key 集合斷言）／Step 3（Rust whitelist 對照 spec 身份的斷言）。
2. **白名單外的 host（linux-arm64、windows-x64）跑這層測試** → 必須在第一步就以指名平台的訊息拒絕，而不是在 digest 比對處模糊失敗。→ Task 1 Step 3（`should_panic` 測試，與 host 無關）。
3. **有人日後只改 ci.yml 其中一處 archive 路徑** → 路徑錯配再次出現，且因為 release job 只在 tag 上跑，紅燈要等到第一次發版才出現。→ Task 2 Step 1／3（grep pin）＋ Step 4（本地 dry-run 實跑修正後的命令序列）。
4. **`continue-on-error` 讓 workflow 變綠、job 仍紅**；若有人把 `real-media` 設成 required check，「不擋合併」的承諾直接失效。→ Task 3 Step 4／6（YAML 結構斷言 ＋ docs 明文規則）。
5. **未設 env／未生成 fixtures 的機器上跑 e2e** → 錯誤訊息要指向正確下一步（`npm run fixtures`），不可誤報成 digest 不符。→ Task 3 Step 7（負向觀察，不退化既有訊息）。

---

### Task 1: 信任政策 1 → 2（linux-x64 digest ＋ Rust 平台白名單）

**Files:**
- Modify: `tests/fixtures/spec.json`（`ffmpeg.assets`、`ffprobe.assets`）
- Modify: `src-tauri/tests/real_media_fixtures.rs:209-216`（`ensure_supported_platform`）、`:311-316`（trusted identity 斷言）
- Test: `tests/fixtures/contract.spec.ts:15-32`
- Test: `src-tauri/tests/real_media_fixtures.rs`（新增兩個 `#[test]`）
- Modify: `tests/fixtures/README.md:12-13`、`docs/releasing.md:121`（darwin 限定措辭 → 雙平台）

**Interfaces:**
- Consumes: `trusted_platform_key()`（`real_media_fixtures.rs:189-207`，compile-time cfg 驅動，已支援 `linux-x64`，本 task 不動它）；`load_trusted_spec()`（`:297-318`）。
- Produces:
  - `const SUPPORTED_PLATFORMS: [&str; 2] = ["darwin-arm64", "linux-x64"];`（module-level，`real_media_fixtures.rs`）
  - `fn assert_platform_supported(platform: &str) -> ()`；`fn ensure_supported_platform() -> ()` 呼叫它
  - `tests/fixtures/spec.json` 的 `ffmpeg.assets`／`ffprobe.assets` keys 恰好為 `["darwin-arm64", "linux-x64"]`

- [ ] **Step 1: 準備 linux-x64 pin 資產並實測 digest**

```bash
npm run prepare:ffmpeg -- --target linux-x64
sha256sum src-tauri/binaries/linux-x64/ffmpeg src-tauri/binaries/linux-x64/ffprobe
src-tauri/binaries/linux-x64/ffmpeg -version | head -1
```

Expected: `prepare:ffmpeg` 自印 `Prepared FFmpeg/FFprobe 8.1.2 assets for linux-x64`（它本身已內含 archive sha256 驗證與 `verifyTargetAssets`）；version 行含 `ffmpeg version 8.1.2`；兩個 64 字小寫 hex digest。

把它與 spec 的候選值 `90864f57b2572877d4fe9ecd1c0ec25539b4d1982286cd7522f92c3985e0d9fe`（ffmpeg）／`9fe8a3656406520d5fab158f1a2a04fb6c758063793a29a391fee4760d23d4ba`（ffprobe）核對。**不一致就以實測值為準**，並在 commit message 寫下差異。往後步驟把這兩個實測值稱為 `<measured-ffmpeg-digest>`／`<measured-ffprobe-digest>`。

- [ ] **Step 2: 寫出失敗的 TS 斷言（trusted identity 必須恰好兩個）**

在 `tests/fixtures/contract.spec.ts` 的 `accepts the committed generation specification` 內，`expect(spec.ffmpeg).toMatchObject({...})` 之後加入（既有的 `toMatchObject` 允許多餘 key，所以必須另外 pin key 集合）：

```ts
expect(Object.keys(spec.ffmpeg.assets).sort()).toEqual(["darwin-arm64", "linux-x64"]);
expect(Object.keys(spec.ffprobe.assets).sort()).toEqual(["darwin-arm64", "linux-x64"]);
expect(spec.ffmpeg.assets["linux-x64"]).toEqual({ sha256: "<measured-ffmpeg-digest>" });
expect(spec.ffprobe.assets["linux-x64"]).toEqual({ sha256: "<measured-ffprobe-digest>" });
```

`<measured-…>` 要換成 Step 1 實測到的 digest 字串，不可留佔位符。

- [ ] **Step 3: 寫出失敗的 Rust 測試（兩個，與 host 無關）**

在 `src-tauri/tests/real_media_fixtures.rs` 加入：

```rust
const SUPPORTED_PLATFORMS: [&str; 2] = ["darwin-arm64", "linux-x64"];

#[test]
fn platform_whitelist_matches_committed_trusted_asset_identities() {
    // load_trusted_spec() 只讀 spec.json，不需要二進位或 fixtures
    let spec = load_trusted_spec();
    let mut whitelist: Vec<&str> = SUPPORTED_PLATFORMS.to_vec();
    whitelist.sort_unstable();
    let mut ffmpeg_ids: Vec<&str> = spec.ffmpeg.assets.keys().map(String::as_str).collect();
    ffmpeg_ids.sort_unstable();
    let mut ffprobe_ids: Vec<&str> = spec.ffprobe.assets.keys().map(String::as_str).collect();
    ffprobe_ids.sort_unstable();
    assert_eq!(whitelist, ffmpeg_ids, "platform whitelist must match FFmpeg trusted identities");
    assert_eq!(whitelist, ffprobe_ids, "platform whitelist must match FFprobe trusted identities");
}

#[test]
#[should_panic(expected = "refusing unvalidated host linux-arm64")]
fn unvalidated_host_is_refused_with_an_explicit_message() {
    assert_platform_supported("linux-arm64");
}
```

`assert_platform_supported` 於 Step 5 實作；此步驟允許編譯失敗（undefined function）——那就是 RED。

- [ ] **Step 4: 跑測試確認 RED**

```bash
npm run test -- tests/fixtures/contract.spec.ts --run
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures platform_whitelist
```

Expected: TS 側 `Object.keys(...)` 斷言 FAIL（只有 `darwin-arm64`）；Rust 側編譯錯誤 `cannot find function assert_platform_supported` 或 whitelist 斷言 FAIL。

- [ ] **Step 5: 實作平台白名單**

在 `real_media_fixtures.rs:209-216` 把 `ensure_supported_platform` 拆成可測的檢查函式：

```rust
fn assert_platform_supported(platform: &str) {
    assert!(
        SUPPORTED_PLATFORMS.contains(&platform),
        "real-media verification is supported only on {}; refusing unvalidated host {platform}",
        SUPPORTED_PLATFORMS.join(", ")
    );
}

fn ensure_supported_platform() {
    assert_platform_supported(trusted_platform_key());
}
```

- [ ] **Step 6: 更新 trusted identity 斷言與 spec.json**

`real_media_fixtures.rs:311-316`：`assets.len()` 斷言由 `1` 改為 `2`（訊息維持「must contain only the supported asset identity」語意），並為 `linux-x64` 各加一條 digest 斷言（ffmpeg／ffprobe 皆 `Some("<measured digest>")`）。

`tests/fixtures/spec.json`：`ffmpeg.assets` 與 `ffprobe.assets` 各加入 `"linux-x64": { "sha256": "<measured digest>" }`。

- [ ] **Step 7: 跑測試確認 GREEN**

```bash
npm run test -- tests/fixtures/contract.spec.ts --run
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures platform_whitelist
```

Expected: 兩側皆 PASS。

- [ ] **Step 8: 生成 fixtures 並跑完整 real-media 整合測試**

```bash
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/src-tauri/binaries/linux-x64/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/src-tauri/binaries/linux-x64/ffprobe"
npm run fixtures
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
```

Expected: `npm run fixtures` 印 `Generated 10 deterministic fixtures with FFmpeg 8.1.2`；cargo 印 `test result: ok.` 且通過數為 **3**（既有整合測試 ＋ 本 task 兩個新測試）。

- [ ] **Step 9: 跑 e2e 套件**

```bash
npm run test:e2e
```

Expected: `Test Files 2 passed (2)`、`Tests 5 passed | 1 skipped (6)`（跳過的是 opt-in desktop E2E）。

- [ ] **Step 10: 同步 darwin 限定措辭**

`tests/fixtures/README.md:12-13` 與 `docs/releasing.md:121`：把「只支援 darwin-arm64」／「matching macOS ARM test assets」改為 darwin-arm64 ＋ linux-x64 雙平台，並保留「白名單外平台會被明確拒絕」一句。

- [ ] **Step 11: 基線不退化**

```bash
npm run test -- --run
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run check:licenses
```

Expected: 156 tests 綠；130 tests 綠；license 檢查綠。

- [ ] **Step 12: Commit**

```bash
git add tests/fixtures/spec.json tests/fixtures/contract.spec.ts tests/fixtures/README.md src-tauri/tests/real_media_fixtures.rs docs/releasing.md
git commit -m "test: trust linux-x64 pinned ffmpeg for real-media verification"
```

---

### Task 2: 修正 release job 的 archive 路徑錯配

**Files:**
- Modify: `.github/workflows/ci.yml:148`（Unix extract）、`:166`（Windows extract）、`:213`（Remove source archive）

**Interfaces:**
- Consumes: 既有 matrix 鍵 `matrix.archive_file`、`matrix.target`（`ci.yml:68-93`）。
- Produces: ci.yml 內所有 archive 引用統一為 `src-tauri/binaries/${{ matrix.archive_file }}`（本地 dry-run 與日後發版都假設這個慣例）。

- [ ] **Step 1: 先把慣例 pin 成可檢查的斷言（RED）**

```bash
grep -n 'src-tauri/binaries/\${{ matrix.target }}/\${{ matrix.archive_file }}' .github/workflows/ci.yml
grep -n 'src-tauri/binaries/\${{ matrix.archive_file }}' .github/workflows/ci.yml | wc -l
```

Expected RED：第一條 **3 hits**（148、166、213）；第二條 **7 hits**（130、131、138、139、183、204、209）。

- [ ] **Step 2: 修正三處引用**

把 `:148`、`:166`、`:213` 的 `src-tauri/binaries/${{ matrix.target }}/${{ matrix.archive_file }}` 改為 `src-tauri/binaries/${{ matrix.archive_file }}`（與下載步驟、`verify-ffmpeg-assets`、license 檢查同一個位置）。不動 `mkdir -p "src-tauri/binaries/${{ matrix.target }}"`（它為 binaries 與 licenses 而存在）。

- [ ] **Step 3: 確認慣例統一（GREEN）**

重跑 Step 1 兩條命令。Expected：第一條 **0 hits**；第二條 **10 hits**（原本 7 條加上修正後的 148、166、213）。

- [ ] **Step 4: 本地 dry-run 實跑修正後的 Unix 命令序列一次**

release job 只在 tag 上跑，無法在 CI 層驗證；所以在 scratch 目錄跑「修正後的同一組命令」證明路徑配對可行：

```bash
scratch="$(mktemp -d)"; cd "$scratch"
mkdir -p src-tauri/binaries
curl --fail --location --retry 3 \
  "https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/linux_x64.zip" \
  --output "src-tauri/binaries/linux_x64.zip"
printf '%s  %s\n' "150f20cfa659754115b74c2aa32f0e1aa150d08a14191156875c8efeb5713b29" "src-tauri/binaries/linux_x64.zip" | shasum -a 256 -c -
unzip -q "src-tauri/binaries/linux_x64.zip" -d "$scratch/work"
ffmpeg_path="$(find "$scratch/work" -type f -name ffmpeg -print -quit)"
test -n "$ffmpeg_path"
rm "src-tauri/binaries/linux_x64.zip"
```

Expected: `src-tauri/binaries/linux_x64.zip: OK`、`find` 找到 ffmpeg、`rm` 成功（錯配寫法在這裡會 `No such file or directory`）。結束後 `cd` 回 repo，scratch 目錄可留著不管。

- [ ] **Step 5: YAML 可解析**

```bash
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'));print('ci.yml parses')"
```

Expected: `ci.yml parses`。

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "fix(ci): read the pinned ffmpeg archive from the path the download step writes"
```

---

### Task 3: 新增 `real-media` 警報 job

**Files:**
- Modify: `.github/workflows/ci.yml`（新增 job，位置在 `check` 之後、`release` 之前；並修正 `:47-50` 的註解）
- Modify: `docs/releasing.md`（新增「real-media 警報政策」小節）

**Interfaces:**
- Consumes: Task 1 的 `linux-x64` trusted identity（沒有它，`cargo test --test real_media_fixtures` 第一步就紅）。本 job 不自已下載 archive，所以**不依賴** Task 2 的路徑慣例。
- Produces: GitHub check `Real-media boundary (advisory)`；docs 裡的升級條件與「嚴禁 required」規則。

- [ ] **Step 1: 修正不實的註解**

`ci.yml:47-50` 的註解改為事實描述，例如：asset-gated 的 real-media 整合測試由 `real-media` job 執行（advisory：失敗會標紅該 job，但不讓 workflow 變紅）。

- [ ] **Step 2: 新增 job 骨架**

```yaml
  real-media:
    name: Real-media boundary (advisory)
    runs-on: ubuntu-22.04
    timeout-minutes: 20
    continue-on-error: true
    env:
      LUMAFLOW_FFMPEG_TEST_BIN: ${{ github.workspace }}/src-tauri/binaries/linux-x64/ffmpeg
      LUMAFLOW_FFPROBE_TEST_BIN: ${{ github.workspace }}/src-tauri/binaries/linux-x64/ffprobe
```

不設 `needs`（與 `check` 平行）。步驟 1-5 直接沿用 `check` job 的寫法：checkout、Install Tauri Linux dependencies、Set up Node.js（`node-version: 22`、`cache: npm`）、Set up Rust（`dtolnay/rust-toolchain@stable`）、`npm ci`。

- [ ] **Step 3: 資產與測試步驟**

接在 Step 2 之後，依序四個步驟（名稱照 repo 風格）：

1. `Prepare pinned FFmpeg assets` → `npm run prepare:ffmpeg -- --target linux-x64`（該腳本已內含 archive sha256 驗證、解壓、`chmod 755`、`verifyTargetAssets`；不另寫 curl／unzip）
2. `Generate deterministic fixtures` → `npm run fixtures`
3. `Run real-media Cargo integration` → `cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures`，加 `id: cargo_real_media`
4. `Run real-media E2E suite` → `npm run test:e2e`，加 `id: e2e_suite`

- [ ] **Step 4: 失敗可見度步驟（`continue-on-error` 下唯一可靠的寫法）**

`if: failure()` 在 `continue-on-error: true` 的 job 內**不會觸發**（GitHub 會把 job 當前狀態重置回 success）。必須用 `if: always()` ＋ `steps.<id>.outcome`，作為 job 的最後一個步驟：

```yaml
      - name: Report advisory failure
        if: always()
        shell: bash
        run: |
          if [ "${{ steps.cargo_real_media.outcome }}" != "success" ] || [ "${{ steps.e2e_suite.outcome }}" != "success" ]; then
            echo "::warning::real-media advisory layer failed; merge is not blocked by this job"
            {
              echo "## real-media advisory failure"
              echo ""
              echo "- cargo outcome: \`${{ steps.cargo_real_media.outcome }}\`"
              echo "- e2e outcome: \`${{ steps.e2e_suite.outcome }}\`"
              echo ""
              echo "This job is advisory. Do not set it as a required check while it is advisory."
            } >> "$GITHUB_STEP_SUMMARY"
          fi
```

- [ ] **Step 5: YAML 結構斷言**

```bash
python3 - <<'PY'
import yaml
wf = yaml.safe_load(open(".github/workflows/ci.yml"))
job = wf["jobs"]["real-media"]
assert job["continue-on-error"] is True
assert job["timeout-minutes"] == 20
assert "needs" not in job
assert job["env"]["LUMAFLOW_FFMPEG_TEST_BIN"].endswith("src-tauri/binaries/linux-x64/ffmpeg")
assert "github.workspace" in job["env"]["LUMAFLOW_FFMPEG_TEST_BIN"]
steps = [s.get("name") for s in job["steps"]]
assert "Run real-media Cargo integration" in steps and "Run real-media E2E suite" in steps
print("real-media job shape ok")
PY
```

Expected: `real-media job shape ok`。

- [ ] **Step 6: docs 寫入警報政策**

`docs/releasing.md` 新增小節 `## real-media 警報政策`，內容三條（照 spec 的決定紀錄）：

1. `real-media` 是警報：失敗會標紅該 job、寫 warning 與 step summary，但 workflow 仍綠。
2. 警報期間**嚴禁**把它設為 required check——branch protection 讀的是 job 的 check 結論，紅 job 會直接擋 merge。
3. 升級條件：在 `main` 上連續 10 次綠之後，才可刪掉 `continue-on-error: true` 並設為 required。紅燈的處理紀律：修掉，或開 issue；若紅燈來自斷言過窄而非真實缺陷，放寬斷言必須附理由寫進 commit message。

- [ ] **Step 7: 本地重現 job 的負向與正向路徑**

正向（在 repo 根、env 已於 Task 1 Step 8 export）：

```bash
npm run fixtures && npm run test:e2e
```

Expected: `Test Files 2 passed (2)`。

負向（新 shell，不 export env）：

```bash
env -u LUMAFLOW_FFMPEG_TEST_BIN -u LUMAFLOW_FFPROBE_TEST_BIN npm run test:e2e 2>&1 | tail -20
```

Expected: 失敗訊息指名 `LUMAFLOW_FFMPEG_TEST_BIN is required for real media E2E; set it to the release-pinned executable`（`tests/e2e/harness.ts:267`），**不是** digest mismatch 類的誤導訊息。若訊息變成誤導型別，本 task 未完成。

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml docs/releasing.md
git commit -m "build(ci): add advisory real-media boundary job on linux-x64"
```

---

### Task 4: 本機跑法文件 ＋ 全綠閘門

**Files:**
- Modify: `docs/installation-and-deployment.md`（第 4 節「本機開發與測試」內補 real-media 層的跑法）

**Interfaces:**
- Consumes: Task 1 的雙平台白名單、Task 3 的 job 名稱與政策。
- Produces: 貢獻者可照抄的本機命令序列。

- [ ] **Step 1: 補上本機跑法**

在 `docs/installation-and-deployment.md` 的 `## 4. 本機開發與測試` 末尾新增一小段（中文，沿用該文件語氣），內容為以下命令與一句說明「這層需要 pin 資產與現場生成的 fixtures，白名單為 darwin-arm64 與 linux-x64」：

```bash
npm run prepare:ffmpeg
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffprobe"
npm run fixtures
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
npm run test:e2e
```

`<target>` 由平台決定（Mac 用 `darwin-arm64`、Linux 用 `linux-x64`）；說明裡要寫明 CI 的 `real-media` job 目前是警報、不擋合併。

- [ ] **Step 2: 全綠閘門**

```bash
npm run typecheck
npm run test -- --run
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
npm run check:licenses
npm run build
```

Expected: typecheck 無錯；156 tests 綠；e2e `2 passed (2)`／`5 passed | 1 skipped`；`--lib` 130 綠；`--test real_media_fixtures` 3 綠；license 綠；build 成功。

- [ ] **Step 3: 確認生產碼未被碰到**

```bash
git diff main --stat -- src src-tauri/src
```

Expected: **無輸出**（只有 `src-tauri/tests/`、`tests/`、`.github/`、`docs/`、`tests/fixtures/spec.json` 有變動）。若出現任何 `src/` 或 `src-tauri/src/` 的變動，本 plan 範圍被違反，停下回報。

- [ ] **Step 4: Commit**

```bash
git add docs/installation-and-deployment.md
git commit -m "docs: document how to run the real-media layer locally"
```
