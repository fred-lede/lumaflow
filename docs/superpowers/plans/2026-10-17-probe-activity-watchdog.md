# probe 活動 watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓一個永不返回的 ffprobe／ffmpeg 探測無法凍結整個 app：在 Linux 上，探測子程序若連續 120 秒「既沒有讀取任何 bytes、也沒有燒 CPU」就被停止，並回報 `probe_stalled`。

**Architecture:** watchdog 完全住在 `src-tauri/src/media/probe.rs` 的 `ProcessCommandRunner::run` 內（spec 決定：不抽共用模組、不動 `src-tauri/src/jobs/runner.rs`）。`Command::output()` 換成 `spawn()` ＋ 兩條 stream 各自一條抽取執行緒 ＋ 每 1 秒讀一次 `/proc/<pid>/io`（`rchar`、`syscr`）與 `/proc/<pid>/stat`（`utime + stime`）的輪詢迴圈；三個計數器全部不動且子程序仍活著才殺。非 Linux 平台走今日同一條 `.output()` 路徑，缺口寫進 docs。`CommandRunner` trait、`probe_media` 的兩次呼叫序列、ffmpeg／ffprobe 參數全部不動。

**Tech Stack:** Rust（`src-tauri` 的 lib crate，純 `std`：`std::process`、`std::thread`、`std::fs`、`std::time`；無 FFI、無新依賴）、POSIX sh（dash）假子程序 fixtures、`mkfifo`、cargo test（lib target ＋ integration target）。

**Spec:** `docs/superpowers/specs/2026-10-17-probe-activity-watchdog-design.md`（executors 必須同時讀 spec）。測量帳本：`.superpowers/sdd/2026-10-17-probe-deadline/progress.md`（Finding 1–9；程式碼註解要引用的數字都在那裡）。

## Global Constraints

- 不新增 npm 或 cargo 依賴。`/proc` 用純 `std::fs::read_to_string` 讀，不用 `libc` FFI。
- 不動 `src-tauri/src/jobs/runner.rs`。watchdog 住在 `probe.rs`，不抽共用模組。
- `CommandRunner` trait 簽章不動；`probe_media` → `assess_source_quality` → `spectral_rolloff_hz` 的呼叫序列不動。
- 不為偵測改任何 ffmpeg／ffprobe 參數：不加 `-progress`、維持 `-nostats`。`ProcessCommandRunner` 不加重試。
- **不設牆鐘總時長期限。** 停滯窗口只計算「連續無活動的時間」，合法但慢的探測（實測 `frag.mp4`：ffprobe 讀 241 MB，1 MiB/s 下合法耗時 230 s）不得被殺。
- 生產值固定：停滯窗口 `120 s`、輪詢間隔 `1 s`。錯誤碼固定 `probe_stalled`；spawn／wait 失敗沿用既有 `probe_command_error`，工具解析失敗沿用 `media_tool_unavailable`。
- 僅 Linux 有 watchdog。非 Linux 必須與今日行為**完全相同**，且不得出現 dead-code 警告（`cargo clippy --all-targets -- -D warnings` 在 macOS 上也要綠）。
- MSRV 必須編得過：`cargo +1.88.0 check --manifest-path src-tauri/Cargo.toml --locked --all-targets`（單一事實來源是 `src-tauri/Cargo.toml` 的 `rust-version = "1.88.0"`）。
- `cargo fmt --all --check` 與 `cargo clippy --all-targets -- -D warnings` 必須綠。
- 基線不得退化：`cargo test --lib` 133 → 133 ＋新增；`cargo test --test real_media_fixtures` 3 → 4；`npm test -- --run` 156 tests／18 files；`npm run test:e2e` 5 passed｜1 skipped。
- cargo 指令一律從 `src-tauri/` 跑（repo 根沒有 `Cargo.lock`）。本地跑 real-media 層需要**絕對路徑**的 `LUMAFLOW_FFMPEG_TEST_BIN`／`LUMAFLOW_FFPROBE_TEST_BIN`，用 `src-tauri/binaries/linux-x64/{ffmpeg,ffprobe}`（8.1.2）；系統 ffmpeg 6.1.1 會被信任版本閘門拒絕，那是閘門照設計運作，不是 bug。
- `.github/workflows/ci.yml` 的 job 結構不動（不新增 job、不動 `needs`、不動 `continue-on-error`）。soak 預算與 `timeout-minutes` **只准往上調**，且必須由 Task 9 的實測驅動。
- 測試注入的期限必須滿足「時限 > 輪詢間隔」：lib 測試用 `300 ms`／`50 ms`，advisory 的真 ffprobe 案例用 `2 s`／`100 ms`。
- 工作分支：`feat/probe-activity-watchdog`（已存在，tip `efcf203` 是 spec commit）。commit 前綴沿用 repo 風格：`test(media):`、`feat(media):`、`docs:`、`build(ci):`。

## Review Focus

spec 暗示但沒有哪個 task 的測試直接覆蓋的失敗模式——每一條都在 owning task 裡有對應步驟：

1. **合法但「不讀、只在算」的子程序被殺**（輸入已讀完、濾鏡／解碼純燒 CPU 的階段）。多執行程 ffmpeg 的 main thread 卡在 `read()` 時，kernel 的 leader 視圖仍會把 worker 的 CPU 與 reads 算進去（帳本 Finding 8 實測：leader 視圖與 `task/*` 總和逐次樣本完全相同）。→ Task 2 Step 1（`cpu_ticks` 單獨也算活動的單元測試）＋ Task 5 Step 2（只燒 CPU 的活體反向測試）。
2. **讀得很慢但確實有在讀的子程序被殺**（NFS hard-mount 的 60–180 s cadence 縮影）。→ Task 5 Step 1（每 40 ms 餵 4 KB、總長超過停滯窗口的 FIFO 測試）。
3. **`/proc` 讀不到就殺程序**（hidepid、pid 已消失、權限限制）。watchdog 只能對「實際讀到的樣本」行動。→ Task 2 Step 4（gone child 回 Err）＋ Task 3 Step 3（迴圈結構明文要求）＋ Task 3 Step 4（程式碼自查步驟）。
4. **stdout／stderr 擷取或 exit code 與 `.output()` 不同形**（換成 spawn ＋ 抽取執行緒後最容易悄悄變的地方，尤其 `.stdin(Stdio::null())` 必須明設：`output()` 會自動把 stdin 關掉，`spawn()` 不會）。→ Task 1（行為守門測試，重構前先綠、重構後必須仍綠）＋ Task 5 Step 1（斷言 stdout 的 byte 數完全正確）。
5. **非 Linux 主機的行為被順手改動**，或 Linux-only 的欄位／常數在 macOS 上變成 dead code 讓 clippy 紅。→ Task 3 Step 2（cfg 切分與 cfg 化欄位的明文要求）＋ Task 8 Step 3（docs 明文缺口，不藏）。

## Files in this plan

- Modify `src-tauri/src/media/probe.rs` — 唯一動生產碼的檔案：watchdog 常數、`ProcessCommandRunner` 欄位、`run` 的平台切分、`run_guarded`、`/proc` 取樣與解析、`probe_stalled` 錯誤；以及新的 `#[cfg(all(test, unix))] mod process_runner_tests`。
- Modify `src-tauri/tests/real_media_fixtures.rs` — 真 ffprobe 卡死案例（advisory 層，Linux-gated）。
- Modify `docs/installation-and-deployment.md` §9 — 新增探測停滯 FAQ，並修正 §9 現行文字中「分析階段的 ffprobe 目前仍沒有期限」這句（本 PR 之後它變成錯的）。
- Possibly modify `.github/workflows/ci.yml` ＋ `docs/releasing.md` — 只在 Task 9 實測顯示 400 次 soak 超出 1 100 s 預算時，往上調。

---

### Task 1: 行為守門 — `ProcessCommandRunner` 的 stdout／stderr／exit code 同形

重構前先鎖住既有行為。這個 task 只加測試與測試用 fixture helpers，不動生產碼。

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（檔案底部新增 `#[cfg(all(test, unix))] mod process_runner_tests`）

**Interfaces:**
- Consumes: `ProcessCommandRunner::with_tools(ToolLocator)`（`probe.rs:35`）；`ToolLocator::bundled()`（`tools.rs:38`）＋ `ToolLocator::set_resource_dir(&Path)`（`tools.rs:45`）→ `resolve("ffprobe")` 回傳 `<resource_dir>/binaries/<target_directory()>/ffprobe`（`tools.rs:52-64`，**不檢查檔案是否存在**，所以 fixture 放對位置即可被 spawn）；`tools::target_directory()`（`tools.rs:99-124`，linux-x64 → `"linux-x64"`）。`executable_name()` 只接受 `"ffmpeg"`／`"ffprobe"`（`tools.rs:77-96`），所以假工具必須命名為 `ffprobe`。
- Produces（Task 3／4／5 沿用的測試 helpers，全部在 `process_runner_tests` 內）:
  - `fn fixture_directory(name: &str) -> PathBuf`
  - `fn prime_before_exec(path: &Path) -> ()`
  - `fn fake_tool(directory: &Path, tool: &str, body: &str) -> PathBuf`
  - `fn runner_for(directory: &Path) -> ProcessCommandRunner`

- [ ] **Step 1: 寫出 fixture helpers 與守門測試**

在 `probe.rs` 底部（既有 `#[cfg(test)] mod tests` 之後）新增：

```rust
#[cfg(all(test, unix))]
mod process_runner_tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    use super::{CommandRunner, ProcessCommandRunner};
    use crate::media::tools::{target_directory, ToolLocator};

    // A script written and then immediately exec'd can hit ETXTBSY: the loader still
    // holds the file open while the kernel refuses to map it as a program. The guard
    // line lets each fixture be primed with one harmless exec first. Same race and the
    // same remedy as the fixture helper in src-tauri/src/jobs/runner.rs's tests.
    const PRIME_ARGUMENT: &str = "--prime";
    const ETXTBSY: i32 = 26;

    fn fixture_directory(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("lumaflow-probe-{name}-{}", std::process::id()));
        // A panicking test leaves its fixture directory behind, and a later run that
        // reuses the same PID would inherit those files, so each test starts empty.
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("probe test directory should be creatable");
        directory
    }

    fn prime_before_exec(path: &Path) {
        for _ in 0..10 {
            match Command::new(path).arg(PRIME_ARGUMENT).status() {
                Ok(_) => return,
                Err(error) if error.raw_os_error() == Some(ETXTBSY) => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("fixture should be executable: {error}"),
            }
        }
        panic!("fixture stayed unexecutable: {}", path.display());
    }

    /// Writes a POSIX-sh fixture tool exactly where `ToolLocator` looks for it.
    fn fake_tool(directory: &Path, tool: &str, body: &str) -> PathBuf {
        let bin_directory = directory.join("binaries").join(target_directory());
        fs::create_dir_all(&bin_directory).expect("fixture binary directory should be creatable");
        let path = bin_directory.join(tool);
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$1\" = {PRIME_ARGUMENT} ] && [ \"$#\" -eq 1 ]; then exit 0; fi\n{body}\n"
            ),
        )
        .expect("fixture tool should be writable");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("fixture tool should be chmod-able");
        prime_before_exec(&path);
        path
    }

    fn runner_for(directory: &Path) -> ProcessCommandRunner {
        let tools = ToolLocator::bundled();
        tools.set_resource_dir(directory);
        ProcessCommandRunner::with_tools(tools)
    }

    #[test]
    fn captures_stdout_stderr_and_status_from_a_completed_child() {
        let directory = fixture_directory("output-capture");
        fake_tool(
            &directory,
            "ffprobe",
            "printf 'probe-json\\n'; printf 'probe-error\\n' >&2; exit 3",
        );
        let output = runner_for(&directory)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a completed child should produce a command output");

        assert_eq!(output.status, 3, "the child's exit code must survive");
        assert_eq!(output.stdout, "probe-json\n");
        assert_eq!(output.stderr, "probe-error\n");
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
}
```

- [ ] **Step 2: 跑測試**

```bash
cd src-tauri && cargo test --lib process_runner_tests 2>&1 | tail -20
```

Expected: `test captures_stdout_stderr_and_status_from_a_completed_child ... ok`，1 passed。

這是**故意先綠**的 characterization test：它鎖的是今日 `.output()` 已經有的行為。若它紅了，停下調查生產碼，不要改測試、不要改斷言。

- [ ] **Step 3: 格式與 lint**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
```

Expected: 兩者無輸出、exit 0。

- [ ] **Step 4: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "test(media): pin probe command output capture before the watchdog"
```

---

### Task 2: `/proc` 活動取樣（純函式層）

watchdog 的判定核心先當純函式做：給一段 kernel 格式的文字，解析出三個計數器；給兩個樣本，回答「有沒有前進」。這一層紅綠循環不依賴任何子程序。

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（新增 Linux-only 型別與函式；新增 `#[cfg(all(test, target_os = "linux"))] mod activity_tests`）

**Interfaces:**
- Consumes: 無（純函式）。
- Produces（Task 3 的輪詢迴圈消費這些）:
  - `#[cfg(target_os = "linux")] struct ActivitySample { read_bytes: u64, read_calls: u64, cpu_ticks: u64 }`
  - `#[cfg(target_os = "linux")] impl ActivitySample { fn progressed_since(&self, previous: &Self) -> bool }`
  - `#[cfg(target_os = "linux")] fn read_activity_sample(pid: u32) -> Result<ActivitySample, std::io::Error>`
  - `#[cfg(target_os = "linux")] fn parse_io_field(text: &str, field: &str) -> Option<u64>`
  - `#[cfg(target_os = "linux")] fn parse_stat_cpu(text: &str) -> Option<u64>`

- [ ] **Step 1: 寫出失敗的取樣測試**

```rust
#[cfg(all(test, target_os = "linux"))]
mod activity_tests {
    use super::{parse_io_field, parse_stat_cpu, read_activity_sample, ActivitySample};

    // The exact field set of a real /proc/<pid>/io (verified against a live one).
    const IO_TEXT: &str = "rchar: 1048576\nwchar: 4096\nsyscr: 8\nsyscw: 999\n\
        read_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n";

    // utime is field 14 and stime field 15, but the comm field (2) may contain spaces
    // and parentheses, so the parse must count from the last ')'. In this line utime=123
    // and stime=45.
    const STAT_TEXT: &str = "1234 (ffprobe (odd) name) S 1 1234 1234 0 -1 4207616 100 0 \
        0 0 123 45 0 0 20 0 1 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \n";

    #[test]
    fn parses_io_counters_without_matching_a_similarly_named_field() {
        assert_eq!(parse_io_field(IO_TEXT, "rchar"), Some(1_048_576));
        assert_eq!(parse_io_field(IO_TEXT, "syscr"), Some(8));
        assert_eq!(parse_io_field(IO_TEXT, "wchar"), Some(4096));
        assert_eq!(parse_io_field(IO_TEXT, "syscw"), Some(999));
        // A prefix of a real key must not match it. `wchar` is the near-miss for `rchar`
        // and `syscw` for `syscr`, so a parse that matches loosely returns the wrong
        // counter — and a wrong counter is a wrong watchdog decision.
        assert_eq!(parse_io_field(IO_TEXT, "rcha"), None);
        assert_eq!(parse_io_field(IO_TEXT, "sysc"), None);
        assert_eq!(parse_io_field(IO_TEXT, "absent"), None);
    }

    #[test]
    fn parses_cpu_ticks_from_a_stat_line_whose_command_contains_parentheses() {
        assert_eq!(parse_stat_cpu(STAT_TEXT), Some(168));
        assert_eq!(parse_stat_cpu("1234 (x) S"), None);
    }

    #[test]
    fn a_sample_progresses_when_any_counter_moves_but_not_when_all_are_frozen() {
        let previous = ActivitySample { read_bytes: 1_000, read_calls: 4, cpu_ticks: 10 };
        let frozen = ActivitySample { read_bytes: 1_000, read_calls: 4, cpu_ticks: 10 };
        let reading = ActivitySample { read_bytes: 1_001, read_calls: 4, cpu_ticks: 10 };
        let counting = ActivitySample { read_bytes: 1_000, read_calls: 5, cpu_ticks: 10 };
        // A child whose input is already fully read and whose filters are decoding burns
        // CPU without reading a byte. That is activity, not a stall.
        let computing = ActivitySample { read_bytes: 1_000, read_calls: 4, cpu_ticks: 11 };

        assert!(!frozen.progressed_since(&previous));
        assert!(reading.progressed_since(&previous));
        assert!(counting.progressed_since(&previous));
        assert!(computing.progressed_since(&previous));
    }

    #[test]
    fn a_child_that_is_gone_reports_an_error_instead_of_a_sample() {
        // u32::MAX is not a valid pid on any Linux box (pid_max tops out near 4 million),
        // so this is a guaranteed ENOENT. The watchdog must treat an unreadable child as
        // "do not act", never as "stalled".
        let error = read_activity_sample(u32::MAX)
            .expect_err("a pid that does not exist should not produce a sample");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
```

- [ ] **Step 2: 跑測試確認紅**

```bash
cd src-tauri && cargo test --lib activity_tests 2>&1 | tail -20
```

Expected: 編譯錯誤（`cannot find function parse_io_field`／`cannot find module activity_tests` 的 unresolved import）。這是紅的正確形態。

- [ ] **Step 3: 實作取樣層**

在 `probe.rs` 的 `ProcessCommandRunner` 區塊之前加入（全部 Linux-only；用完全限定路徑，避免非 Linux 側出現未使用的 `use`）：

```rust
/// A snapshot of the three kernel counters that separate "working" from "parked".
/// `rchar` and `syscr` count bytes and calls of `read()`/`write()`; `utime + stime`
/// counts CPU. Measured (see the ledger, Finding 8): the leader's `/proc/<pid>/io` and
/// `/proc/<pid>/stat` already sum the whole thread group, so a multi-threaded ffmpeg
/// whose main thread sits in `read()` while its filter threads work still shows
/// movement, and walking `/proc/<pid>/task/*` would add cost without adding signal.
#[cfg(target_os = "linux")]
struct ActivitySample {
    read_bytes: u64,
    read_calls: u64,
    cpu_ticks: u64,
}

#[cfg(target_os = "linux")]
impl ActivitySample {
    fn progressed_since(&self, previous: &Self) -> bool {
        self.read_bytes != previous.read_bytes
            || self.read_calls != previous.read_calls
            || self.cpu_ticks != previous.cpu_ticks
    }
}
```

`parse_io_field`：逐行 `split_once(':')`，**key 必須全等**（`trim` 後），再 `parse::<u64>()`。不可用 `starts_with` 或 `contains`：一個真實的 `/proc/<pid>/io` 同時有 `rchar:` 與 `wchar:`、`syscr:` 與 `syscw:`，寬鬆比對會回傳錯的 counter，而錯的 counter 就是錯的 watchdog 判定。

`parse_stat_cpu`：`text.rsplit_once(')')` 取最後一個 `)` 之後的餘額，`split_whitespace()`，索引 **11 = utime、12 = stime**（餘額索引 0 是 state，即 1-based 的欄位 3；utime／stime 是 1-based 的 14／15）。任何缺欄位或解析失敗回 `None`。

`read_activity_sample`：

```rust
#[cfg(target_os = "linux")]
fn read_activity_sample(pid: u32) -> Result<ActivitySample, std::io::Error> {
    let io_text = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
    let stat_text = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (Some(read_bytes), Some(read_calls), Some(cpu_ticks)) = (
        parse_io_field(&io_text, "rchar"),
        parse_io_field(&io_text, "syscr"),
        parse_stat_cpu(&stat_text),
    ) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("could not read the activity counters of pid {pid}"),
        ));
    };
    Ok(ActivitySample { read_bytes, read_calls, cpu_ticks })
}
```

- [ ] **Step 4: 跑測試確認綠，並自查 `/proc` 不可讀的語意**

```bash
cd src-tauri && cargo test --lib activity_tests 2>&1 | tail -10
```

Expected: 4 passed。

自查（讀自己剛寫的程式碼，寫成 commit message 的一部分或程式碼註解）：`read_activity_sample` 的錯誤**只**用來決定「這一次不重置計時器、也不殺」；它沒有任何一路徑會把 Err 轉成停滯判定。這條是 Review Focus #3 的落點。

- [ ] **Step 5: 格式、lint、全 lib suite**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
```

Expected: fmt／clippy 無輸出；lib suite `138 passed`（134 ＋ 4）。

- [ ] **Step 6: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "feat(media): read the kernel activity counters that separate a parked probe"
```

---

### Task 3: 停滯偵測 — 殺掉不再讀也不再算的子程序

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（`ProcessCommandRunner` 欄位與建構子、`with_stall_deadlines`、`run` 的平台切分、`run_guarded`、`stalled_probe_error`、`read_stream_to_end`、`humanize_window`、`tool_label`；`process_runner_tests` 內新增測試）

**Interfaces:**
- Consumes: Task 2 的 `ActivitySample`／`read_activity_sample`；`ToolLocator::resolve`（`probe.rs:48` 既有用法與 `media_tool_unavailable` 錯誤碼）；`MediaError::with_details`（`media/mod.rs:24`）。
- Produces:
  - `#[cfg(target_os = "linux")] pub const PROBE_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);`
  - `#[cfg(target_os = "linux")] const PROBE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);`
  - `ProcessCommandRunner { tools, #[cfg(target_os = "linux")] stall_timeout: Duration, #[cfg(target_os = "linux")] poll_interval: Duration }`
  - `#[cfg(all(target_os = "linux", any(test, debug_assertions)))] pub fn with_stall_deadlines(mut self, stall_timeout: Duration, poll_interval: Duration) -> Self`
  - `#[cfg(target_os = "linux")] fn run_guarded(&self, program: &str, executable: &Path, args: &[String]) -> Result<CommandOutput, MediaError>`
  - `#[cfg(not(target_os = "linux"))] fn run_unguarded(&self, program: &str, executable: &Path, args: &[String]) -> Result<CommandOutput, MediaError>`
  - `#[cfg(target_os = "linux")] fn stalled_probe_error(program: &str, child: std::process::Child, stdout: std::thread::JoinHandle<std::io::Result<Vec<u8>>>, stderr: std::thread::JoinHandle<std::io::Result<Vec<u8>>>, idle: std::time::Duration) -> MediaError`
  - `#[cfg(target_os = "linux")] fn read_stream_to_end<R: std::io::Read>(mut stream: R) -> std::io::Result<Vec<u8>>`
  - `#[cfg(target_os = "linux")] fn humanize_window(window: std::time::Duration) -> String`（`120 s` → `"120 seconds"`，`300 ms` → `"300 ms"`）
  - `#[cfg(target_os = "linux")] fn tool_label(program: &str) -> &str`（`ffprobe` → `FFprobe`、`ffmpeg` → `FFmpeg`、其他原樣）
  - 新錯誤碼：`probe_stalled`（`MediaError::with_details`，details 至少含 `program=<program> idle_for=<window>`，若 stderr 非空則附加在後）

- [ ] **Step 1: 寫出失敗的停滯測試**

在 `process_runner_tests` 內新增（`runner_with_windows` helper 也一起加）：

```rust
    // The injected window and poll interval live here because this is the task that first
    // consumes them: a constant nothing uses yet is a dead-code warning under
    // `clippy --all-targets -- -D warnings`. They are Linux-gated for the mirror-image
    // reason: their only consumers are Linux-gated, so on a macOS build these same two
    // lines would be the unused constants.
    #[cfg(target_os = "linux")]
    const STALL_WINDOW: Duration = Duration::from_millis(300);
    #[cfg(target_os = "linux")]
    const POLL_INTERVAL: Duration = Duration::from_millis(50);

    #[cfg(target_os = "linux")]
    fn runner_with_windows(
        directory: &Path,
        stall_timeout: Duration,
        poll_interval: Duration,
    ) -> ProcessCommandRunner {
        runner_for(directory).with_stall_deadlines(stall_timeout, poll_interval)
    }

    #[test]
    fn captures_empty_streams_from_a_child_that_writes_nothing() {
        // The other half of the guard Task 1 started, added here because this is the task
        // that replaces `Command::output()` with `spawn()` plus two drain threads: a real
        // `ffprobe -v error` on a clean file writes nothing at all, so the rewrite must
        // return empty vectors — not a truncated read, not a hang on a pipe nobody wrote.
        let directory = fixture_directory("probe-quiet");
        fake_tool(&directory, "ffprobe", "exit 0");
        let output = runner_for(&directory)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a quiet child is still a completed probe");

        assert_eq!(output.status, 0, "a clean exit must survive");
        assert!(
            output.stdout.is_empty(),
            "stdout: {:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            output.stderr.is_empty(),
            "stderr: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stops_a_probe_child_that_stops_reading() {
        // `exec` replaces the shell with an idle process: the watched child stays alive,
        // reads nothing and burns nothing, which is the shape of ffprobe blocked in
        // open() on a FIFO nobody writes to. The sleep is bounded so the pre-watchdog
        // red run fails in 20 s rather than forever.
        let directory = fixture_directory("probe-stall");
        fake_tool(&directory, "ffprobe", "exec sleep 20");
        let started = std::time::Instant::now();
        let error = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect_err("a probe child that reads nothing should be stopped");

        assert_eq!(error.code, "probe_stalled", "error details: {:?}", error.details);
        assert!(error.message.contains("stopped"), "error message: {error}");
        assert!(
            error
                .details
                .as_deref()
                .unwrap_or_default()
                .contains("program=ffprobe"),
            "error details: {:?}",
            error.details
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the watchdog should act inside its window, took {:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
```

- [ ] **Step 2: 跑測試確認紅**

```bash
cd src-tauri && cargo test --lib stops_a_probe_child_that_stops_reading 2>&1 | tail -20
```

Expected: 編譯錯誤（`with_stall_deadlines` 不存在）。這是紅的正確形態。

- [ ] **Step 3: 實作 watchdog**

常數（doc comment 必須寫清「不是總時長期限」與 120 s 的由來，數字取自帳本）：

```rust
/// How long a probe child may go without reading a byte or burning CPU before the
/// watchdog stops it. This is a gap between activity samples, not a total-runtime
/// deadline: a probe that really is reading is never stopped, and a throttled probe that
/// legitimately spends 230 s reading 241 MB of a fragmented MP4 (ledger Finding 4) stays
/// alive. 120 s is deliberately generous — a hard-mounted NFS source can take 60-180 s
/// between reads — and matches the FFmpeg watchdog's window in src-tauri/src/jobs/runner.rs.
#[cfg(target_os = "linux")]
pub const PROBE_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[cfg(target_os = "linux")]
const PROBE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
```

`ProcessCommandRunner` 的欄位與建構子：新增 `stall_timeout`／`poll_interval` 兩個欄位，**兩者都 gate 在 `#[cfg(target_os = "linux")]`**（非 Linux 側若留著未讀的欄位會變成 dead-code 警告，clippy `-D warnings` 在 macOS 上會紅）。`system()`／`with_tools()` 的初始化同样 cfg-gate。

`with_stall_deadlines`（注意它與 `runner.rs:80` 的 `#[cfg(test)] pub(crate)` 不同：advisory 的 integration test 在另一個 crate，`cfg(test)` 對它不成立，所以這裡用 `any(test, debug_assertions)`，release 建置（也就是真正出貨的 app）根本不會編出這個方法）：

```rust
    /// Overrides the watchdog window. Production release builds do not compile this
    /// method at all, so the shipped app always uses `PROBE_STALL_TIMEOUT`. Tests use a
    /// short window so the stall paths are exercised without waiting two minutes, and a
    /// window shorter than two polls would stop a healthy probe, so nothing may ask for
    /// one.
    #[cfg(all(target_os = "linux", any(test, debug_assertions)))]
    pub fn with_stall_deadlines(
        mut self,
        stall_timeout: std::time::Duration,
        poll_interval: std::time::Duration,
    ) -> Self {
        debug_assert!(
            stall_timeout > poll_interval * 2,
            "a stall window shorter than two polls would fire between samples of a healthy child"
        );
        self.stall_timeout = stall_timeout;
        self.poll_interval = poll_interval;
        self
    }
```

`run` 只保留共用的解析，然後平台切分（沿用 `tools.rs:81-83` 的 `#[cfg] return` 風格）：

```rust
impl CommandRunner for ProcessCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError> {
        let executable = self.tools.resolve(program).map_err(|error| {
            MediaError::with_details(
                "media_tool_unavailable",
                "The bundled media tool is not available",
                error.to_string(),
            )
        })?;
        #[cfg(target_os = "linux")]
        return self.run_guarded(program, &executable, args);
        #[cfg(not(target_os = "linux"))]
        return self.run_unguarded(program, &executable, args);
    }
}
```

`run_unguarded` 就是今日 `probe.rs:55-70` 的 `.output()` 主體原封不動搬過去，加上 `#[cfg(not(target_os = "linux"))]`，並在函式上方寫一句註解說明這是 macOS／Windows 的既有行為、缺口記錄在 docs FAQ。

`run_guarded` 的骨架（迴圈的**順序**是這 task 唯一無法由簽章推得的東西：先 `try_wait`、再取樣、再判定、最後才睡；這樣一個 0.07 s 的正常探測不會多睡一秒）：

```rust
    #[cfg(target_os = "linux")]
    fn run_guarded(
        &self,
        program: &str,
        executable: &Path,
        args: &[String],
    ) -> Result<CommandOutput, MediaError> {
        // Stdin must be nulled explicitly: Command::output() does it for you, spawn()
        // inherits the parent's stdin, and a probe that inherits a terminal would block
        // on a read of its own.
        let mut child = std::process::Command::new(executable)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| { /* probe_command_error, 同今日 message */ })?;

        // Both streams are drained on their own threads, so a child that fills a pipe
        // buffer never blocks on a write — which would look exactly like a stalled read.
        // Assumes the child is a leaf process: a grandchild holding a pipe open would
        // keep the join waiting after the child is gone (same documented assumption as
        // the FFmpeg watchdog in src-tauri/src/jobs/runner.rs).
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdout_thread = std::thread::spawn(move || read_stream_to_end(stdout));
        let stderr_thread = std::thread::spawn(move || read_stream_to_end(stderr));

        let pid = child.id();
        let mut last_activity = std::time::Instant::now();
        let mut previous: Option<ActivitySample> = None;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => { /* join both threads, build CommandOutput 同今日 */ }
                Ok(None) => {
                    if let Ok(sample) = read_activity_sample(pid) {
                        // A child we cannot sample is a child we must not kill: the
                        // watchdog only ever acts on counters it actually read.
                        if previous.as_ref().is_some_and(|was| sample.progressed_since(was)) {
                            last_activity = std::time::Instant::now();
                        }
                        previous = Some(sample);
                    }
                    if last_activity.elapsed() >= self.stall_timeout {
                        return Err(stalled_probe_error(
                            program, child, stdout_thread, stderr_thread, last_activity.elapsed(),
                        ));
                    }
                    std::thread::sleep(self.poll_interval);
                }
                Err(error) => { /* kill + join, 回 probe_command_error */ }
            }
        }
    }
```

`stalled_probe_error`：`let _ = child.kill(); let _ = child.wait();` → join 兩條抽取執行緒（join 失敗或 stream 讀取失敗時沿用 `probe_command_error`）→ 組 `MediaError::with_details("probe_stalled", message, details)`，其中：

- message：`format!("{label} made no progress reading or decoding for {} and was stopped", humanize_window(idle))`
- details：`format!("program={program} idle_for={}", humanize_window(idle))`，若 stderr 有內容則附加在後面（與 `runner.rs` 的 `stalled_error` 同形：把當時抓到的 stderr 交給使用者）

- [ ] **Step 4: 自查三個判定細節**

讀自己剛寫的 `run_guarded`，逐條確認並在程式碼註解或 commit message 留下痕跡（這是 Review Focus #3／#4 的落點）：

1. `/proc` 取樣失敗（`Err`）時**不重置**也**不殺**：該次迭代只是不更新 `previous`，判定只看 `last_activity.elapsed()`。
2. 計時起點是 spawn 那一刻，且第一次樣本沒有 `previous` 可比 → 一個從頭到尾沒讀過任何 bytes 的子程序會在窗口到期時被殺（不會因為「第一個樣本看起來有活動」而重置）。
3. 成功路徑與停滯路徑都 join 兩條執行緒，`CommandOutput` 的 `status`／`stdout`／`stderr` 三個欄位的組法與今日 `probe.rs:66-70` 相同（`status.code().unwrap_or(-1)`、`String::from_utf8_lossy`）。

- [ ] **Step 5: 跑測試確認綠，且守門測試仍綠**

```bash
cd src-tauri && cargo test --lib process_runner_tests 2>&1 | tail -10
```

Expected: 2 passed（`captures_stdout_stderr_and_status_from_a_completed_child` 與 `stops_a_probe_child_that_stops_reading`）。守門測試若在這裡變紅，代表重構改變了擷取行為——修生產碼，不要改斷言。

- [ ] **Step 6: 格式、lint、全 lib suite、MSRV**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
cd src-tauri && cargo +1.88.0 check --locked --all-targets 2>&1 | tail -5
```

Expected: fmt／clippy 無輸出；lib suite `140 passed`；MSRV check `Finished`。

- [ ] **Step 7: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "feat(media): stop a probe child that stops reading or computing"
```

---

### Task 4: 真實卡死形態 — 停在 `read()` 中途

Task 3 的測試打的是「從頭到尾沒讀」。帳本 Finding 7 的真實形態是「讀過一些、然後卡在 `read()`」：FIFO 餵一次、寫入端保持開啟，所以讀端永遠看不到 EOF。這一條走的是同一條判定路徑，**预期在 Task 3 之後直接綠**；它不是新的 red→green 循環，而是形態覆蓋。若它紅了，代表 watchdog 對「讀過之後才停」的判定有 bug。

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（`process_runner_tests` 內新增 helper 與測試）

**Interfaces:**
- Consumes: Task 1 的 `fixture_directory`／`fake_tool`；Task 3 的 `runner_with_windows`、`STALL_WINDOW`／`POLL_INTERVAL` 與 `probe_stalled`。
- Produces: `fn make_fifo(directory: &Path, name: &str) -> PathBuf`（測試 helper）。

- [ ] **Step 1: 寫出形態覆蓋測試**

```rust
    fn make_fifo(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        let status = Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("mkfifo should be runnable");
        assert!(status.success(), "mkfifo should succeed");
        path
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stops_a_probe_child_parked_midway_through_a_read() {
        // The real hang shape: a FIFO fed once, with the write end held open so the
        // reader never sees EOF. The child reads 64 KiB and then parks inside read().
        // The writer is this test process, so there is no orphan holding the FIFO.
        let directory = fixture_directory("probe-parked-read");
        let fifo = make_fifo(&directory, "silent.fifo");
        fake_tool(&directory, "ffprobe", &format!("exec cat '{}'", fifo.display()));

        let (keep_open_tx, keep_open_rx) = mpsc::channel::<()>();
        let writer_fifo = fifo.clone();
        let writer = thread::spawn(move || {
            let handle = OpenOptions::new()
                .write(true)
                .open(&writer_fifo)
                .expect("the FIFO write end should open");
            let _ = handle.write_all(&[7_u8; 64 * 1024]);
            // Hold the write end until the runner finishes, otherwise the child sees EOF.
            let _ = keep_open_rx.recv();
        });

        let started = std::time::Instant::now();
        let error = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect_err("a child parked inside read() should be stopped");
        let _ = keep_open_tx.send(());
        writer.join().expect("the FIFO writer should finish");

        assert_eq!(error.code, "probe_stalled", "error details: {:?}", error.details);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the watchdog should act inside its window, took {:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
```

（`use std::fs::OpenOptions;`、`use std::io::Write;` 與 `use std::sync::mpsc;` 加進 `process_runner_tests` 的 import 區塊，並各自 gate 在 `#[cfg(target_os = "linux")]`：它們只被 Linux-gated 的測試消費，在 macOS 建置會變成 unused import 而讓 `clippy --all-targets -- -D warnings` 變紅 — 同 Ruling 8。）

- [ ] **Step 2: 跑測試**

```bash
cd src-tauri && cargo test --lib stops_a_probe_child_parked_midway_through_a_read 2>&1 | tail -15
```

Expected: `ok`。若紅：不要改測試的 fixture 或斷言，回到 `run_guarded` 找判定 bug（最可能：樣本比較把「讀過之後才停」誤當成有前進）。

- [ ] **Step 3: 格式、lint、全 lib suite**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
```

Expected: `141 passed`。

- [ ] **Step 4: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "test(media): cover the probe hang parked inside a read"
```

---

### Task 5: 反向保護 — 還在讀、只在算的子程序必須活下來

這是「絕不殺合法子程序」的兩條活體保護（Review Focus #1、#2）。**预期直接綠**；任何一條紅都代表 watchdog 寫錯，只能改 watchdog。

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（`process_runner_tests` 內新增兩個測試）

**Interfaces:**
- Consumes: Task 4 的 `make_fifo`；Task 3 的 `run_guarded`。
- Produces: 無新介面。

- [ ] **Step 1: 寫出「持續有在讀」的測試**

```rust
    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_a_probe_child_that_keeps_reading_bytes() {
        // Slow but genuinely progressing: 4 KiB every 40 ms for 400 ms, which is longer
        // than the 300 ms stall window. Every poll sees the counters move, so the child
        // must run to its natural exit and its whole stdout must arrive.
        let directory = fixture_directory("probe-reading");
        let fifo = make_fifo(&directory, "steady.fifo");
        fake_tool(&directory, "ffprobe", &format!("exec cat '{}'", fifo.display()));

        let writer_fifo = fifo.clone();
        let writer = thread::spawn(move || {
            let handle = OpenOptions::new()
                .write(true)
                .open(&writer_fifo)
                .expect("the FIFO write end should open");
            for _ in 0..10 {
                if handle.write_all(&[9_u8; 4 * 1024]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
            // Closing the write end is what lets cat reach EOF and exit 0.
        });

        let output = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a child that keeps reading must not be stopped");
        writer.join().expect("the FIFO writer should finish");

        assert_eq!(output.status, 0, "stderr: {}", output.stderr);
        assert_eq!(output.stdout.len(), 10 * 4 * 1024, "every byte must be captured");
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
```

- [ ] **Step 2: 寫出「只燒 CPU、不讀任何 bytes」的測試**

```rust
    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_a_probe_child_that_burns_cpu_without_reading() {
        // The decode/filters phase of a probe: everything is already read and the child
        // only computes. A pure-builtin shell loop burns CPU in the watched pid itself
        // (dash runs about 1.25 M iterations per second on this machine, so 500 000 is
        // ~0.4 s here). `exec` keeps the same pid, so the counters being sampled are the
        // counters doing the work. The injected window is tighter than the other tests use
        // because the fixture's runtime is a property of the machine's core: a 300 ms window
        // would silently stop exercising the kill decision on a core fast enough to finish
        // the loop inside it. 150 ms over a 25 ms poll keeps the "window > 2 × poll" rule the
        // production constructor asserts, at zero extra runtime.
        let directory = fixture_directory("probe-computing");
        fake_tool(
            &directory,
            "ffprobe",
            "exec sh -c 'i=0; while [ $i -lt 500000 ]; do i=$((i+1)); done'",
        );

        let output = runner_with_windows(
            &directory,
            Duration::from_millis(150),
            Duration::from_millis(25),
        )
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a child that is computing must not be stopped");

        assert_eq!(output.status, 0, "stderr: {}", output.stderr);
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
```

- [ ] **Step 3: 跑兩個測試**

```bash
cd src-tauri && cargo test --lib keeps_a_probe_child 2>&1 | tail -15
```

Expected: 2 passed。任何一條紅 → 改 `run_guarded`（例如把 CPU 計數器漏掉、或把 `syscr` 的解析抓錯欄位），**不得**放寬斷言、不得拉長窗口、不得把測試改成 `#[ignore]`。

- [ ] **Step 4: 格式、lint、全 lib suite**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
```

Expected: `143 passed`。

- [ ] **Step 5: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "test(media): prove a working probe child survives the watchdog"
```

---

### Task 6: 頻譜分析被殺時降為 unknown（spec §6 的 B 路徑）

`probe_media` 的第二條命令（`spectral_rolloff_hz` 的 ffmpeg）被殺時，`.ok()?`（`probe.rs:311`）讓品質判定降為 `Unknown`，探測本身仍然成功——一個卡死的 B 只花掉一個 120 s 窗口，不會變成整個探測失敗。這個 task 把這個承諾釘成測試。

**Files:**
- Modify: `src-tauri/src/media/probe.rs`（既有 `#[cfg(test)] mod tests` 內新增 `ScriptedRunner` 與一個測試）

**Interfaces:**
- Consumes: `FLAC_JSON`（`probe.rs:497`）、`SourceQualityStatus::Unknown`、`probe_media`。
- Produces: 測試用 `struct ScriptedRunner`（依序吐出預先準備好的 `Result<CommandOutput, MediaError>`）。

- [ ] **Step 1: 寫出測試**

```rust
    #[derive(Debug)]
    struct ScriptedRunner {
        responses: RefCell<VecDeque<Result<CommandOutput, MediaError>>>,
    }

    impl ScriptedRunner {
        fn scripted(responses: Vec<Result<CommandOutput, MediaError>>) -> Self {
            Self { responses: RefCell::new(responses.into()) }
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, MediaError> {
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("scripted runner response")
        }
    }

    #[test]
    fn degrades_to_unknown_quality_when_the_spectral_pass_is_stopped() {
        let actual = probe_media(
            &ScriptedRunner::scripted(vec![
                Ok(CommandOutput { status: 0, stdout: FLAC_JSON.to_owned(), stderr: String::new() }),
                Err(MediaError::new("probe_stalled", "FFprobe was stopped")),
            ]),
            "/input/voice.flac",
        )
        .expect("a stopped spectral pass should still probe the file");

        assert_eq!(actual.source_quality.status, SourceQualityStatus::Unknown);
    }
```

（`use std::collections::VecDeque;` 加進既有 tests 模組的 import。）

- [ ] **Step 2: 跑測試**

```bash
cd src-tauri && cargo test --lib degrades_to_unknown_quality 2>&1 | tail -10
```

Expected: `ok`（`.ok()?` 已有這個行為；這個測試是把 spec §6 的承諾釘住）。若紅，代表 `assess_source_quality` 的錯誤處理被改動過——停下調查。

- [ ] **Step 3: 格式、lint、全 lib suite**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
```

Expected: `144 passed`。

- [ ] **Step 4: commit**

```bash
git add src-tauri/src/media/probe.rs
git commit -m "test(media): pin unknown quality when the spectral pass is stopped"
```

---

### Task 7: advisory 層 — 真 ffprobe 卡死在 `real_media_fixtures`

真實資產的卡死形態放在 advisory 的 integration target（spec 決定：阻擋性 `check` job 不準備 ffmpeg／ffprobe 資產，不把真實資產拉進阻擋性 job）。

**Files:**
- Modify: `src-tauri/tests/real_media_fixtures.rs`（檔案底部新增一個 Linux-gated `#[test]`）

**Interfaces:**
- Consumes: `ensure_supported_platform()`（`real_media_fixtures.rs:229`）、`load_trusted_spec()`（`:475`）、`required_executable(name, binary, label)`（`:589`，會驗證版本與 digest）、`TempDirectory`（`:112`，`Drop` 會 `remove_dir_all`）、`probe_media`、`ToolLocator::set_resource_dir` ＋ `target_directory()`。
- Produces: 無新介面。測試本身 `#[cfg(target_os = "linux")]`（watchdog 是 Linux-only；macOS 上這個測試不存在，缺口記錄在 Task 8 的 docs）。

- [ ] **Step 1: 寫出測試**

```rust
#[cfg(target_os = "linux")]
#[test]
fn real_ffprobe_hang_is_stopped_by_the_probe_watchdog() {
    // The production runner, pointed at the pinned FFprobe, against the hang shape
    // measured in the ledger: FFprobe blocked in open() on a FIFO nobody writes to.
    // A short injected window keeps the advisory job fast; the shipped window is 120 s.
    ensure_supported_platform();
    let spec = load_trusted_spec();
    let ffprobe = required_executable("LUMAFLOW_FFPROBE_TEST_BIN", &spec.ffprobe, "FFprobe");

    let directory = TempDirectory::new("lumaflow-probe-hang");
    let fifo = directory.path.join("silent.fifo");
    let status = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo should be runnable");
    assert!(status.success(), "mkfifo should succeed");

    let bin_directory = directory.path.join("binaries").join(target_directory());
    fs::create_dir_all(&bin_directory).expect("fixture binary directory should be creatable");
    symlink(&ffprobe, &bin_directory.join("ffprobe")).expect("FFprobe should be linked");

    let tools = ToolLocator::bundled();
    tools.set_resource_dir(&directory.path);
    let runner = ProcessCommandRunner::with_tools(tools)
        .with_stall_deadlines(Duration::from_secs(2), Duration::from_millis(100));

    let started = Instant::now();
    let error = probe_media(&runner, &fifo)
        .expect_err("a FFprobe hung in open() should be stopped by the watchdog");
    let elapsed = started.elapsed();

    assert_eq!(error.code, "probe_stalled", "error details: {:?}", error.details);
    assert!(
        elapsed < Duration::from_secs(30),
        "the watchdog should stop a hung FFprobe inside its window, took {elapsed:?}"
    );
}
```

新增 import（檔案頂部）：`use std::os::unix::fs::symlink;`、`use std::time::Instant;`、`use lumaflow_lib::media::probe::ProcessCommandRunner;`、`use lumaflow_lib::media::tools::{target_directory, ToolLocator};`。

- [ ] **Step 2: 本地跑 advisory 層**

```bash
cd src-tauri
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/binaries/linux-x64/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/binaries/linux-x64/ffprobe"
cargo test --test real_media_fixtures 2>&1 | tail -15
```

Expected: `4 passed`（原本 3 條 ＋ 這 1 條），且這一条只花約 2 s。若 `required_executable` 拒絕二進位，確認用的是 `src-tauri/binaries/linux-x64/` 的 8.1.2 資產與絕對路徑。

- [ ] **Step 3: 格式、lint**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
```

Expected: 無輸出、exit 0（`--all-targets` 會一併 lint 這個 integration target）。

- [ ] **Step 4: commit**

```bash
git add src-tauri/tests/real_media_fixtures.rs
git commit -m "test(media): cover the real FFprobe hang in the advisory layer"
```

---

### Task 8: docs — FAQ 條目、過時句子、macOS 缺口

**Files:**
- Modify: `docs/installation-and-deployment.md`（§9 新增一個 `###` 條目；修正 `:373` 那句）

**Interfaces:**
- Consumes: 無。
- Produces: 無。

- [ ] **Step 1: 新增 FAQ 條目**

在 `docs/installation-and-deployment.md` 的「### 轉檔沒有進度輸出時會被中止」條目之後、「## 10. 參考資料」之前新增 `### 探測卡住會被中止`，內容必須涵蓋以下每一點（措辭用 repo docs 的 zh-TW 風格，不要翻成行銷語）：

1. 探測（ffprobe／頻譜分析的 ffmpeg）若連續 **120 秒**既沒有讀取任何 bytes、也沒有燒 CPU，會被停止，job／選檔以 `probe_stalled` 失敗，錯誤訊息附上當時抓到的 FFmpeg stderr（若有）。
2. 120 秒計算的是「兩次活動之間的空檔」，**不是探測總時長**：真的在讀的探測不會被殺。實測例：一個 269 MB 的 fragmented MP4（18 000 個 fragment）會讓 ffprobe 為了走查每個 fragment 的索引合法讀 241 MB，1 MiB/s 的來源下這是 230 秒的合法探測，它不會被中止。
3. 活動訊號來自 kernel 的 I/O 與 CPU 計數器（`/proc/<pid>/io` 的 `rchar`／`syscr` 與 `/proc/<pid>/stat` 的 `utime + stime`），三個全部不動且子程序仍活著才殺；讀得慢但有在讀、或輸入已讀完只在解碼運算，都算活動。
4. 一個卡死的探測最壞是**一個 120 秒窗口**：ffprobe 失敗就不會再跑後面的頻譜分析；頻譜分析被殺則品質判定降為 unknown，探測本身仍然成功。
5. **平台缺口明文寫出**：活動 watchdog 目前只在 Linux 生效。macOS 沒有 `/proc`，探測沿用沒有上限的等待行為（也就是本條描述的問題在 macOS 上仍存在），這是已記錄的缺口而非已解決的支援。
6. 未被本條解決的相鄰問題：一個**合法但很慢**的探測仍會凍結 UI，因為探測發生在持有 `command_lock` 期間、且前端把後續操作串在 `enqueueMutation` 後面。殺掉卡死的子程序不會讓慢來源變成可操作。

- [ ] **Step 2: 修正過時句子**

`docs/installation-and-deployment.md:373` 現行文字結尾寫著「這與分析階段的 ffprobe 目前仍沒有期限一樣，都是已記錄的後續工作」。本 PR 之後 ffprobe 已有 watchdog。把該子句改成只保留 `out_time_us` 數值停滯那一項為後續工作，並把探測部分改為指向新 FAQ 條目（措辭範例：「……要偵測『數值停滯』需要追蹤 `out_time_us` 有沒有推進，這仍是已記錄的後續工作；分析階段的探測改由活動 watchdog 負責，見下條。」）。

- [ ] **Step 3: grep pin 驗證兩側都寫到了**

```bash
grep -n "probe_stalled" docs/installation-and-deployment.md
grep -n "沒有期限" docs/installation-and-deployment.md
grep -n "120 秒" docs/installation-and-deployment.md
```

Expected: 第一條至少 1 個命中；第二條 **0 個命中**（過時宣稱已移除）；第三條至少 2 個命中（轉檔條目 ＋ 探測條目）。

- [ ] **Step 4: commit**

```bash
git add docs/installation-and-deployment.md
git commit -m "docs: record the probe activity watchdog and the macOS gap"
```

---

### Task 9: 實測 lib suite 成本，必要時往上調 soak 預算

新增的 4 條活體測試各等一個刻意短的窗口。`rust-test-soak` 跑 400 次（1／16／64／128 各 100 次），預算 1 100 s 是按「一次全 suite 約 3.6 s（threads=1）／1.4 s（高執行緒數）」校準的（`ci.yml:295-301`）。規則：**預算只准往上調，且必須由實測驅動**；若實測顯示沒超，這個 task 什麼都不改。

**Files:**
- Possibly modify: `.github/workflows/ci.yml`（`deadline=$((SECONDS + 1100))`、`timeout-minutes: 25`、以及 `:295-300` 的校準註解）
- Possibly modify: `docs/releasing.md`（§Rust test soak advisory policy 的數字）

**Interfaces:**
- Consumes: 無。
- Produces: 無。

- [ ] **Step 1: 實測每次 run 的成本**

```bash
cd src-tauri
binary="$(cargo test --lib --no-run --message-format=json 2>/dev/null \
  | python3 -c 'import json,sys
found=""
for line in sys.stdin:
    try: m=json.loads(line)
    except ValueError: continue
    if m.get("reason")=="compiler-artifact" and m.get("profile",{}).get("test") and m.get("executable"): found=m["executable"]
print(found)' | tail --lines=1)"
time "$binary" --test-threads=1 >/dev/null
time "$binary" --test-threads=128 >/dev/null
```

把兩個實測值記為 `<t1>` 與 `<t128>`。

- [ ] **Step 2: 算 400 次的投影**

投影 = `100 × <t1> + 300 × <t128>`。與 1 100 s 相比：

- 投影 ≤ 900 s → **不動 `ci.yml`**，跳到 Step 4（只在 commit message 記錄投影數字）。
- 投影 > 900 s → 做 Step 3。預算設為「投影 × 1.25 再往上取整到 50 s」，`timeout-minutes` 必須至少 `ceil((預算 + 300 s 建置餘裕) / 60)`，且**只能比現值大**。

- [ ] **Step 3: 往上調預算與 job timeout**

在 `.github/workflows/ci.yml`：把 `deadline=$((SECONDS + 1100))` 換成實測驅動的新值，並把 `:295-300` 的校準註解更新成本次實測的數字（保留「watchdog 測試等的是刻意短的期限」這句話，它解釋為什麼 suite 不是 0.05 s）。同步 `timeout-minutes`。

在 `docs/releasing.md` 的 §Rust test soak advisory policy：把「一次全 suite 約 3.6 s／1.4 s」「400 runs 約 890 s」「1 100 s 預算」「25 分鐘 job timeout」替換成新的實測值，並保留既有語意：`budget exhausted` 是**截斷**、不是測試失敗（`docs/releasing.md` 已寫過這條規則，不要改它）。

不動：job 名稱、`continue-on-error: true`、`needs`、`runs-on`、四組 `--test-threads` 的組合、每組 100 次的迭代數。

- [ ] **Step 4: 驗證與 commit**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(d['jobs']['rust-test-soak']['timeout-minutes'])"
git add .github/workflows/ci.yml docs/releasing.md
git commit -m "build(ci): recalibrate the soak budget for the probe watchdog tests"
```

Expected: YAML 可解析、值為 Step 2 算出的數字。若 Step 2 判定不動，`git status --short` 應為空，跳過 commit 並在 commit message／PR 描述留下投影數字。

---

### Task 10: 全量驗證與交付

**Files:** 無（只有驗證與交付動作）。

- [ ] **Step 1: 全套阻擋性基線**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --lib 2>&1 | tail -5
cd src-tauri && cargo +1.88.0 check --locked --all-targets 2>&1 | tail -3
npm test -- --run 2>&1 | tail -8
npm run test:e2e 2>&1 | tail -8
```

Expected：fmt／clippy 無輸出；`cargo test --lib` → **144 passed**（133 ＋ 11）；MSRV `Finished`；前端 `156 tests`／18 files 綠；e2e `5 passed | 1 skipped`。任何一項退化 → 停下修復，不得用 `#[ignore]`、`--skip` 或調高斷言來「通過」。

- [ ] **Step 2: advisory 層全套**

```bash
cd src-tauri
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/binaries/linux-x64/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/binaries/linux-x64/ffprobe"
cargo test --test real_media_fixtures 2>&1 | tail -8
```

Expected: `4 passed`。

- [ ] **Step 3: 一次「合法慢探測不被殺」的實地確認（手動，不進 CI）**

用帳本裡的 `huge.mkv`（51.4 MB）與 1 MiB/s 節流，跑生產窗口（不注入）的探測，確認它跑完全程而不是在 120 s 被殺：

```bash
cd /tmp/opencode
# 1 MiB/s 節流的方式沿用帳本 Finding 3/4 的做法（FIFO 餵食端限速）
```

Expected: 探測完成（約 49 s），沒有 `probe_stalled`。這是 spec「不設牆鐘期限」承諾的實地證據，寫進 PR 描述。

- [ ] **Step 4: 推分支、開 PR、回報**

```bash
git log --oneline main..HEAD
/tmp/opencode/gh.sh pr create --fill
```

PR 標題風格沿用 repo：`feat(media): stop a probe child that stops producing activity`。PR 描述要寫：基線數字（144／4）、Task 9 的實測投影、Step 3 的實地確認結果、以及 macOS 缺口明文指向 docs。

- [ ] **Step 5: 新血審查（fresh review），等使用者批准後才合併**

REQUIRED SUB-SKILL: superpowers:requesting-code-review → 派一個**沒參與實作**的 subagent 讀 spec ＋ plan ＋ diff，重點是 Review Focus 五條。回報發現給使用者，**等使用者明確批准**才 squash-merge（`--delete-branch`）。合併後照慣例驗證 `main` 的 run 全綠，才把 promotion counter 往上加（目前 8/10，只有 `main` 的綠 run 計數）。

---

## Self-Review 記錄（planner 已跑）

- **Spec coverage**：spec §1（為何）→ Task 3／7 的錯誤碼與 FAQ；§2 測量結論 → Task 2 的註解要求與 Task 9 的實測；§3 活動訊號（三個計數器）→ Task 2；§4 判定規則（全部不動才殺、任何變動重置、`/proc` 不可讀不殺）→ Task 2 Step 4 ＋ Task 3 Step 4；§5 平台範圍 → Task 3 Step 3 的 cfg 切分 ＋ Task 8 Step 1 第 5 點；§6 錯誤與影響（`probe_stalled`、一個 120 s 窗口、B 被殺 → unknown）→ Task 3 ＋ Task 6；§7 測試分層（假子程序進阻擋性 lib suite、真 ffprobe 進 advisory）→ Task 1–6 ＋ Task 7；§8 非目標（不設總時長期限、不改 ffmpeg 參數、不重試、不動 runner.rs）→ Global Constraints ＋ Task 10 Step 3；§9 決策與判斷（120 s、CPU 也算活動、住在 probe.rs、測試時限「> 輪詢間隔」）→ 對應 task 的 Interfaces／常數。
- **Placeholder scan**：無 TBD／TODO；每個測試步都有可跑的指令與 Expected；Task 3 的 `run_guarded` 以骨架給出，三個 `/* … */` 槽都是「沿用今日同一個組法」的明確指向（`probe.rs:55-70`、`probe_command_error`），不是未決定的事。
- **Type consistency**：`ActivitySample` 欄位名（`read_bytes`／`read_calls`／`cpu_ticks`）在 Task 2 定義、Task 3 消費；`with_stall_deadlines` 的名字與簽章在 Task 3 定義、Task 5／7 消費；`probe_stalled` 在 Task 3 產生、Task 4／6／7 斷言；`STALL_WINDOW`／`POLL_INTERVAL` 在 Task 1 定義、Task 3／4／5 消費；`make_fifo` 在 Task 4 定義、Task 5 消費。測試總數累加：133 → 134（T1）→ 138（T2）→ 140（T3）→ 141（T4）→ 143（T5）→ 144（T6）；advisory 3 → 4（T7）。
