# LumaFlow probe 活動 watchdog — Design

Date: 2026-10-17
Status: 定稿待批准（builder check 已跑完，四個問題已結算，見最後一節）
Related: `src-tauri/src/media/probe.rs`。測量帳本：`.superpowers/sdd/2026-10-17-probe-deadline/progress.md`。
先前已合併的同族機制：`src-tauri/src/jobs/runner.rs` 的 FFmpeg silence watchdog（PR #9，`82ef980`）。

## 為什麼

`probe_media` 目前用 `std::process::Command::output()` 一路阻塞到底（`probe.rs:47-71`），沒有任何上限。一個永不返回的 ffprobe 是**可重現的真實形態**：對一個沒有寫入者的 `mkfifo` 執行 `ffprobe -v error … <fifo>`，程序卡在 `open()` 裡，超過 20 秒的観察窗都沒有返回。

它造成的傷害比「轉檔卡住」更大，因為探測發生在**持有 `command_lock` 的時候**：

- `commands/queue.rs:286` 取 `command_lock` → `:322` 在鎖內呼叫探測（`probe_selected_path`，`:159`）。
- `clear_completed_inner`（`:411`）要同一把鎖。
- 探測不返回 → `enqueue_jobs` 的 promise 永不解決 → 前端 `src/features/queue/useQueueEvents.ts` 的 `enqueueMutation` 把 Cancel／Pause／Retry／Reorder／Clear 全部串在 `mutationTail` 後面。此時佇列裡**連一列 job 都還沒有**，使用者連可點的列都沒有。

結果是整個 app 凍結，只能把程序殺掉。

原本的計畫是「給 probe 一個 wall-clock deadline」。**測量把這個計畫推翻了**（見下節），所以這份設計改做另一件事。

## 測量推翻了什麼（完整數字在進度帳本）

1. **「必須先把 `.output()` 改成併排抽取 stdout/stderr」這個前置 PR 不該存在。** `Command::output()`／`wait_with_output()` 本來就併排抽取：8 MiB × 2 條 pipe，順序寫、交錯寫、直接 `output()` 三種形態都完整取回、不 deadlock（`/tmp/opencode/output_drain.rs`）。若照原計畫做，會留下一個錯誤的機制故事。
2. **wall-clock deadline 會誤殺合法 probe。** 合法 probe 在本地儲存只要 ≤ 0.07 s（970 MB mkv、2 GB lossless 1080p60、30 分鐘 MPEG-TS、損壞 payload 都是），但真正會被慢儲存放大的是**子程序自己選擇讀多少位元組**：
   - ffprobe 那條命令對一般容器讀 66 KB–1.05 MB（受 probesize／analyzeduration 約束）。
   - `aspectralstats` 那條讀 **16–51 MB**：`-t 20` 只限制輸出，interleaved 容器的影音位元組仍要全部 demux。參數順序救不了（`-vn`／`-t` 前置、拿掉 `-vn`，全在 ±1 % 內）。
   - **反例**：`frag.mp4`（18 000 個 fragment 的 fragmented MP4，269 MB）讓 **ffprobe 讀 241 MB**（7 363 次 read），probesize／analyzeduration／`-show_format` only 都壓不下來。在 1 MiB/s 的儲存上這是**合法的 230 秒 probe**。fragmented MP4 是現實中常見的形態（HLS／DASH 下載、手機與螢幕錄影）。
3. **ffmpeg 自己的輸出無法區分「慢」與「卡死」。** 把餵源停掉但保持寫入端開啟（子程序停在 `read()` 內）之後：預設 stats 仍每 0.5 s 吐一行、`time=` 凍在 `00:00:15.37`、只有 `elapsed=` 在走；`-progress pipe:2` 同樣吐 88 行、`out_time_us` 全凍在 `12863855`。所以「N 秒沒有輸出」永遠不會觸發，「輸出時間凍結」則對停滯與合法慢啟動（frag 的索引走查）都會觸發。兩個都不能用。（附带修正：ffmpeg 8.1.2 對 pipe 的 stats 用 `\r` 分隔，只按 `\n` 切行會把它們全部合併，先前一輪「stats 停止」的結論就是這個假象。）
4. **核心的計數器分得出來。** 每秒輪詢 `/proc/<pid>/io`：

   | 情形 | `rchar` 有進展 | 最大 1 秒空窗 |
   |---|---|---|
   | 1 MiB/s 慢但真的在讀 | 15 秒內 +15.4 MB | 1 028 KiB（從不為 0） |
   | 停在 `read()` 中途 | **25 秒內 0 KiB**（程序仍活著） | 0 |
   | 停在啟動期（還沒開始解碼） | **25 秒內 0 KiB**（程序仍活著） | 0 |

   `/proc` 用 `std::fs` 讀即可，不需要新依賴、不需要 FFI。代價是 Linux only。

## 目標

1. 永不返回的 probe 在**有界時間內**被終止，UI 解凍，使用者得到一個可讀的錯誤。
2. **合法但慢的 probe 永遠不被殺**，不管儲存多慢——只要它真的在讀或真的在算。
3. 生產行為中性：不動 ffmpeg／ffprobe 的參數、不加 retry、不改 `CommandRunner` trait 的簽名。

## 非目標

1. **不修「合法慢 probe 也凍 UI」那個 case。** 一個合法的 230 秒 frag.mp4 探測凍結 UI 的程度跟卡死完全一樣（同一把 `command_lock`、同一條 `mutationTail`）。那需要讓探測不跨越鎖、並把前端 mutation 串列解耦，是另一份 spec。
2. 不動 `runner.rs` 已合併的 watchdog，也不把兩套機制抽成共用模組（訊號不同：那邊是 stdout 進度 silence，這邊是 OS I/O 計數）。
3. 不做 macOS 的真實活動訊號（`proc_pidinfo` 需要 unsafe FFI，且 `libc` 目前不是直接依賴）。
4. 不加任何 npm／cargo 依賴。
5. 不處理 273 處 mutex `.expect("… lock should succeed")`、不加 React error boundary、不碰 `TempOutput::commit()` 的非空守衛。

## 反目標

1. **殺掉一個還在幹活的子程序。** 這會讓情況比現狀更糟，也是本設計全部複雜度的來源。
2. **用 wall-clock 總執行時間當判準。** 已被 §測量 2 證明不安全。
3. 為了偵測而改變送給 ffprobe／ffmpeg 的參數（不加 `-progress`、不拿掉 `-nostats`）。

## 約束

- MSRV `1.88.0`（`src-tauri/Cargo.toml:11`）必須能編，CI 的 `msrv` job 是阻擋性檢查。
- `cargo fmt --all --check` 與 `cargo clippy --all-targets -- -D warnings` 在阻擋性 `check` job 裡。
- 基線不得退化：`cargo test --lib` 133、`cargo test --test real_media_fixtures` 3、`npm test -- --run` 156（18 files）、`npm run test:e2e` 5 passed｜1 skipped。
- 平台現況：受支援的是 `linux-x64` 與 `darwin-x64`。本設計只在 Linux 提供 watchdog，macOS 保持今天的行為，並在文件裡**明確寫出這個缺口**（不藏）。

## 設計（已決定的部分）

### 1. 位置

改在 `ProcessCommandRunner::run`（`probe.rs:47`）內部。這是探測唯一 spawn 子程序的地方，兩條命令都經過它。不抽共用模組、不動 trait。

### 2. 活動訊號

- `/proc/<pid>/io` 的 `rchar`（經 `read()` 讀過的位元組數）與 `syscr`（`read()` 次數）。
- `/proc/<pid>/stat` 的 `utime` ＋ `stime`（CPU 時間）。**CPU 也算活動**——這是我的決定：一個已經讀完、正在做純解碼工作的子程序不該被殺。
- 輪詢間隔 1 秒。

### 3. 判定規則

相對於上一次樣本，`rchar`、`syscr`、`utime+stime` **全部沒有變化**，且子程序仍活著 → 停滯計時累積；任何一個有變化 → 計時重置。累積到上限 → `kill()`。

計時從 spawn 開始算，所以「從頭到尾沒讀過任何位元組」的形態（卡在 `open()` 的那個）也會被抓到。

### 4. 上限：120 秒

我的判斷，三層理由：

- 它要跨過「儲存只是卡一下又自己恢復」。NFS hard mount 的預設重試節奏（第一次約 60 秒、之後遞增）意味著一個暫時沒回應的掛載通常 60–180 秒才恢復或回報錯誤。15 或 30 秒會殺掉會自己好的情況。
- 它對「慢但真的在讀」其實是無限寬容：測量中進展中的每次輪詢都有增量。就算採最悲觀模型（一次 `read()` 要讀完 ffprobe 5 MB 的內部缓冲區才算進展），120 秒涵蓋到約 42 KB/s 的儲存。
- 它跟已合併的 runner watchdog 用同一個數字（`PROGRESS_STALL_TIMEOUT`、`EXIT_GRACE_TIMEOUT` 都是 120 s），repo 只需記住一個界線與一套理由。

最壞情況的代價量化：今天是永久凍結；改後是 120 秒後得到一個可 Cancel／重試的錯誤。會被誤殺的只有「停超過 120 秒但之後會自己恢復」的儲存。

### 5. 執行形態

spawn 時把 stdout、stderr 各派一條執行緒讀到 EOF（避免 pipe 塞住），主執行緒輪詢 `/proc` 並檢查子程序是否已退出。退出後 join 那兩條讀取執行緒、組出 `CommandOutput { status, stdout, stderr }`，語意與今天的 `.output()` 相同。

### 6. 終止之後

- 回 `MediaError::with_details("probe_stalled", <message>, <details>)`，`details` 帶程式名稱與靜止秒數。
- **A（ffprobe）被殺** → 錯誤照現有路徑傳到前端，使用者看到探測失敗。
- **B（`aspectralstats`）被殺** → `spectral_rolloff_hz` 現有的 `.ok()?`（`probe.rs:311`）把它變成 `None` → 品質評估變 unknown，不報錯、不炸。前端不需要任何改動。
- 探測不寫任何檔案，所以終止不會留下半成品。

### 7. 平台

`target_os = "linux"` → 有 watchdog。其他平台 → 今天的行為照原樣（無上限）。差異寫進 `docs/installation-and-deployment.md`，不在程式碼註解裡含糊帶過。

### 8. 測試放哪裡（已決定）

「watchdog 會殺卡死的子程序」這個行為由**假子程序**在阻擋性 lib suite 保護；真實 ffprobe 的卡死形態放在 **advisory** 的 `real_media_fixtures`。理由：`cargo test --lib`（阻擋性 `check` job）不準備 ffmpeg／ffprobe 資產，真實資產只存在于 advisory 的 `real-media` job；repo 的先例（`runner.rs` 的 watchdog 測試）本來就是 spawn 假 shell 子程序。**不動 `ci.yml` 的 job 結構**，不把真實資產拉進阻擋性 job。

### 9. 測試用的 fixture 形態

- **永不返回（卡在 `open()`）**：`mkfifo` 且沒有寫入者。已實測超過 20 秒不返回。lib suite 用 `cat <fifo>` 之類的假子程序重現同一個形態；advisory 層用真 ffprobe 打同一個 fifo。
- **停在 `read()` 中途**：餵 N 秒後停止餵、但保持寫入端開啟（讀端看不到 EOF）。
- 兩者都不 burn CPU、不留持有 pipe 的孤兒程序。若要一個「活著但完全不動」的假子程序，用 `exec sleep 30` 這類 idle 直子，不要用 `while :; do :; done`。
- 也要有**反向測試**：一個持續在讀、或持續在燒 CPU 的子程序，必須活到自然結束（這是本設計唯一真正的風險面）。

## 留給 builder 的

1. kill 之後如何有界地等收掉（`runner.rs` 已有 kill ＋ bounded join 的模式可参照）。
2. `/proc` 讀不到（程序已退出、權限、非 Linux）時的處理：不可因為讀不到 `/proc` 就殺掉子程序。
3. 停滯錯誤的 message 措辭。
4. 哪些文件需要同步（`docs/installation-and-deployment.md` 的 FAQ 目前已有「轉檔沒有進度輸出時會被中止」一條，probe 這條要新增並寫明平台缺口）。

## Builder check 的四個問題與結算

| 問題 | 結算 |
|---|---|
| 停滯測試要 gate 在哪一層、spawn 什麼程序？ | **使用者決定**：假子程序進阻擋性 lib suite，真 ffprobe 卡死案例進 advisory `real_media_fixtures`。不動 `ci.yml` 的 job 結構。 |
| 120 秒是每條命令還是整個探測？ | **已由 code 回答**：`probe_media` 先跑 A，A 失敗即 `?` 返回，B 不會執行。所以卡死的探測最壞就是**一個** 120 秒窗口。要湊出兩個窗口需要「A 合法地慢 ＋ B 卡死」，文件與 FAQ 照實寫，不宣稱 120 秒是整個探測的硬上限。 |
| 1 秒輪詢 vs `runner.rs` 的 100 ms `debug_assert!` 下限互相矛盾？ | **我的判斷**：輪詢間隔與時限都可在測試注入；下限斷言改成「時限 > 輪詢間隔」（例：poll 50 ms、deadline 300 ms），使健康子程序不可能在兩次輪詢之間被殺。測試時限要短到不影響 soak 預算。 |
| `rust-test-soak` 預算要不要重新校準？ | **沿用既有規則**：只有實測 lib suite 變慢才動 `ci.yml`，而且**只能往上調預算，不縮短測試的時限或餘裕**。`docs/releasing.md` 已寫明 `budget exhausted` ≠ 測試失敗。 |


## 本設計自己做的判斷（供使用者檢查）

- 時限 120 秒。
- CPU 時間也算活動。
- watchdog 放在 `probe.rs`，不抽共用模組。
- 錯誤碼 `probe_stalled`。
- macOS 保持現狀並公開標明缺口（而不是用一個超寬容的 wall-clock 上限去補）。
- 兩條探測命令都受保護（因為它們共用 `run`）。
- 測試注入的下限斷言改成「時限 > 輪詢間隔」，不是沿用 `runner.rs` 的固定 100 ms。
- 只有在實測 lib suite 變慢時才動 `ci.yml`，且只往上調預算。
- 探測被殺不留下半成品（探測不寫檔），所以不需要任何 commit／rollback 邏輯。
