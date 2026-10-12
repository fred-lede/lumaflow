# LumaFlow Topbar + Workspace Intro 重構 — Design

Date: 2026-10-12
Status: Approved by user（方案 C ＋ 常駐狀態 chip）
Supersedes layout only: round-2 polish spec (`2026-10-12-lumaflow-ui-polish-round2-design.md`) 的顏色／字型／token 決定全部維持，本 spec 只動 topbar 與 workspace intro 的**結構**。

## Scope

重新組織 `workspace-topbar` 與 `workspace-intro`：topbar 改為左右分欄的單列結構，intro 帶整塊移除。

**維持不變（round-2 約束仍有效）**

- 不新增 npm 依賴；不用 UI framework / CSS-in-JS / 動畫庫
- 圖示只用 Unicode glyph
- 佇列狀態的中文標籤不動（e2e `accessibility.spec.ts` 斷言「失敗」／「已完成」）
- 不更動 conversion / intake / queue / preference 邏輯；不動 Rust/Tauri 碼
- 所有既有 `@media` 無障礙分支（reduced-motion、high-contrast、forced-colors 等）繼續生效
- 顏色、字型、token（含 `--color-on-accent`）不動

**不在範圍**：佇列面板、Files／Output 卡片、拖放區、main 以下的任何版面。

## Approved design（方案 C：左右分欄）

### Topbar（單列）

```
┌──────────────────────────────────────────────────────────────┐
│ LumaFlow                          [狀態 chip]  [◐]          │
│ Batch media conversion, processed locally                    │
└──────────────────────────────────────────────────────────────┘
```

- **左半**：
  - 品牌 `LumaFlow` 改為 `<h1 id="app-title">`（原本 h1 是 intro 的 "Convert your media"）。`main` 的 `aria-labelledby="app-title"` 保持不變，改指向 topbar 內的這個 h1。
  - 副標一行：`Batch media conversion, processed locally`（取代 intro 的 eyebrow＋h1＋supporting text 三段）。
- **右半**：常駐狀態 chip ＋ icon-only 主題按鈕。
  - 主題按鈕只留 `◐` glyph，移除 `Theme: {label}` 可見文字；`aria-label`（`Change theme, currently {label}`）維持，無障礙不受影響。既有測試 `StatusBadge.test.tsx` 只斷言 `<button class="theme-toggle" type="button"`，不受影響。

### 狀態 chip（常駐，取代兩個靜態 badge）

沿用 `StatusBadge` 元件與既有四種 status tone，chip 狀態機（優先序由上而下）：

| 條件 | StatusBadge | Label |
|---|---|---|
| `queue.state.paused && jobs.length > 0` | `neutral` | `Paused` |
| `queueProgressSummary(...) !== null`（有處理中的工作） | `working` | 現有字串 `Converting X/Y` |
| 其他 | `ready` | `Ready` |

- 暫停時 `queueProgressSummary` 回傳 `null`；若不做第一條規則，暫停中的佇列會誤顯示 "Ready"。這是新增「Paused」狀態的原因。
- 失敗（failed jobs）**不**升級成 `attention` chip——佇列面板已逐筆呈現失敗，topbar 不重複。維持三狀態。
- 既有 `.topbar-progress` `<p>` 元素移除，進度改由 chip（`working` tone）呈現。

### 移除清單

| 元素 | 位置 | 理由 |
|---|---|---|
| `StatusBadge "Local mode"` | topbar | 寫死的裝飾；local 應用永遠 local |
| `StatusBadge "Ready for files"` | intro | 寫死的裝飾；轉換中仍顯示 "Ready"，誤導 |
| intro 帶整塊（eyebrow `Workspace`、h1 `Convert your media`、supporting text） | main 開頭 | 資訊整併進 topbar；垂直空間釋放給工作區 |

### CSS（`src/styles/glass.css`）

- 移除：`.workspace-intro` 相關規則、`.topbar-progress`、`.eyebrow`（round-2 後全站只剩 intro 使用 eyebrow，一併移除）。
- 新增：topbar 副標規則（沿用 `--color-text-muted` 系 token）、topbar 左右分欄 flex 配置。
- `.status-badge` 既有 tone 樣式直接沿用（idle=ready 綠、working=藍、neutral=灰），不新增顏色。
- 高對比／forced-colors／窄螢幕 `@media` 分支：凡引用被移除 selector 的分支同步移除，其餘不動。

## Accessibility

- Skip link、`main` 的 `tabIndex={-1}`、focus 管理不變。
- Chip 維持 `role="status"`（`StatusBadge` 內建），狀態變化仍會被螢幕閱讀器播報。
- `main` 的無障礙名稱仍由 `#app-title` 提供（換成品牌 h1，仍是有意義的頁面標題）。
- 對比：chip 三種 tone 都是 round-2 已驗證過的現成配色，不新增對比風險。

## Tests（TDD：先改測試讓它 RED，再實作）

`src/app/App.test.tsx` 需更新的斷言：

1. L103–116（h1 區）：`h1#app-title` 文字改為 `LumaFlow`；`.workspace-intro .supporting-text` 斷言改為 topbar 副標；`main aria-labelledby="app-title"` 維持。
2. L605：topbar 內 `.eyebrow` 為 0 — 維持通過（全站 eyebrow 變 0）。
3. L639–644（"keeps one page-level eyebrow"）：改為斷言全站 `.eyebrow` 為 0（eyebrow 已退役）。
4. L651–653：topbar badge 改為斷言閒置時 `data-status="ready"`、label 含 `Ready`；「Local mode」斷言移除。
5. L660（idle 無 `.topbar-progress`）：改為斷言 idle chip 是 `ready` tone。
6. L685（busy 有 `Converting 1/1`）：改為斷言 busy chip 是 `working` tone 且文字含 `Converting 1/1`。
7. 新增：paused 狀態 chip 為 `neutral` tone、文字含 `Paused`。

不動的測試：`StatusBadge.test.tsx`（元件本身不改）、`useQueueEvents.test.ts`、e2e 全部（已確認未引用 topbar/intro 元素）。

## Out of scope / 已記錄的取捨

- 副標文字為英文（與全站 UI 語言一致）。
- 佇列有完成／失敗紀錄但無處理中工作時，chip 顯示 `Ready`（佇列面板才是紀錄的來源）。
- `queueProgressSummary` 函數本身不改（字串 `Converting X/Y` 沿用）。
