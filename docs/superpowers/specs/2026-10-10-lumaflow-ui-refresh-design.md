# LumaFlow workspace UI refresh — 視覺質感、版面節奏與設計語言校準

## Status

提出待審（Awaiting review）。本文件為設計規格，經使用者確認後才進入 implementation plan。

## Problem

LumaFlow 現有介面（`src/app/AppShell.tsx`、`src/styles/tokens.css`、`src/styles/glass.css`）在無障礙面已相當完整（skip link、focus ring、`prefers-reduced-transparency`、`forced-colors`、`prefers-contrast`），但視覺質感與資訊架構存在可量化的缺陷。以下每一項均已在現有原始碼中確認，非推測：

1. **全站沒有任何動態過渡。** `glass.css` 全檔 0 個 `transition` / `@keyframes` / `animation`。所有 hover、focus、狀態切換皆為硬切。
2. **`.workspace-card` 寫死 `min-height: 20rem`**（`glass.css:221`）。來源卡片僅含 1 個檔案時，底部留下大片死白。
3. **標題規則衝突。** `h1 { font-size: 2rem }`（`glass.css:145`）被 `.workspace-title { font-size: var(--font-size-heading) }`（`glass.css:152`）覆蓋，前者為死代碼。
4. **Drop zone 是主要動作卻無互動回饋。** `.drop-zone` 為靜態 flex row，無 `:hover`、無拖曳中狀態；`DropZone.tsx` 本身也沒有 drag 事件處理，`aria-busy` 只反映分析中。
5. **Queue 版面位階過低。** `glass.css:187-205` 以 `grid-template-areas` 將 `.queue-panel` 放在第二列左欄（`grid-area: queue`），寬度僅 `0.85fr`，且在設定欄之後、易被推出視窗。
6. **eyebrow 標籤過度使用。** topbar「Lossless-first media converter」、intro「Workspace」、來源卡「Source media」、設定卡「Configuration」、queue「Processing workspace」共 5 處全大寫小字，彼此搶奪焦點。
7. **步驟編號語意不一致。** 卡片有 `card-step` 顯示 `01` / `02`（序號），但 `QueuePanel.tsx:160` 重用同一 class 顯示**任務計數**（`jobs.length`），語意不同卻共用樣式，且序號序列本身不完整。
8. **圓角偏軟。** `--radius-lg: 1.5rem`(24px)、`--radius-md: 1rem`、`--radius-sm: 0.75rem`（`tokens.css:22-24`），整體偏向消費級 App 的柔軟感，與「本地媒體轉換工具」的專業定位不符。
9. **主色為單一平色。** `--color-accent: #155dcc` 為平面純色，主要 CTA 缺乏層次與重量感。
10. **缺乏全域進度回饋。** 每個 queue row 有獨立進度條，但頂部區域看不到「轉換中 X/Y」的全域狀態。

## Goals

- 在不改變任何轉換、入列、拖放、偏好持久化邏輯的前提下，提升視覺質感與版面節奏。
- 讓 queue 取得與其重要性相符的版面位階。
- 建立一組一致的 motion / radius / elevation 設計 token，供後續功能沿用。
- 維持並強化現有無障礙保證（所有既有 `@media` 無障礙分支必須繼續生效）。
- 保持既有測試語意；因版面重構而需調整的 markup 斷言，以「反映新結構」方式更新，不弱化覆蓋。

## Non-goals

- 不新增側邊導航欄、路由或第二個頁面。
- 不引入任何 UI 框架、CSS-in-JS 或動畫函式庫（維持原生 CSS custom properties）。
- 不改動 `DropZone` 的檔案選取邏輯、`useFileIntake`、`useQueueEvents`、`useConversionSettings` 的資料流。
- 不改動 Rust 後端或 Tauri 指令。
- 不新增全域進度所需的後端事件；第 10 項僅以現有 queue snapshot 資料推導。
- 不重寫 `glass.css`；採就地增補與局部替換。

## Design

### A. 設計 token 校準（`tokens.css`）

新增一組可傳承的 token，並調整既有數值：

```css
/* Motion */
--motion-fast: 120ms;
--motion-base: 180ms;
--motion-slow: 260ms;
--ease-standard: cubic-bezier(0.22, 1, 0.36, 1); /* decelerate */

/* Radius — tighter, tool-like */
--radius-sm: 0.5rem;   /* was 0.75rem */
--radius-md: 0.75rem;  /* was 1rem */
--radius-lg: 1rem;     /* was 1.5rem */
--radius-pill: 999px;  /* 抽出既有的硬編 999px */

/* Elevation — 分層取代單一 shadow */
--shadow-panel: 0 1rem 3rem rgba(35, 61, 93, 0.12);      /* 保留：浮起面板 */
--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08); /* 新增：內層卡片 */
```

深色主題（`:root[data-theme="dark"]`、`@media (prefers-color-scheme: dark)`、以及 `prefers-contrast: more` 分支）需同步提供對應的 `--shadow-raised`，而 `prefers-contrast: more` 分支維持 `--shadow-panel: none` 並將 `--shadow-raised` 亦設為 `none`。

驗收：`prefers-contrast: more` 下仍不得出現任何陰影。

### B. 過渡與互動態（`glass.css`）

1. 對下列選擇器加 `transition: <property> var(--motion-base) var(--ease-standard)`，僅過渡會變動的屬性（`background-color`、`border-color`、`color`、`box-shadow`、`transform`）：
   `.button`、`.theme-toggle`、`.icon-button`、`.preset-option`、`.drop-zone`、`.source-list__item`、`.queue-row`、`.advanced-toggle`。
2. 於檔案末端（`@media (prefers-reduced-transparency: reduce)` 之前）新增全域降級：
   ```css
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after {
       transition-duration: 0.01ms !important;
       animation-duration: 0.01ms !important;
     }
   }
   ```
3. `.button--primary` 加極輕微的 hover 抬升：`transform: translateY(-1px)` ＋ `box-shadow: var(--shadow-raised)`；`:active` 回歸 `translateY(0)`。不得造成 layout shift（不使用 margin）。
4. `.drop-zone` 新增 `.drop-zone:hover`（accent 邊框）與 `.drop-zone--active`（拖曳中：accent 實線邊框 ＋ `--color-accent-soft` 底色 ＋ `--shadow-raised`）兩個狀態。**注意**：`DropZone.tsx` 目前不處理 drag 事件，故 `.drop-zone--active` 僅在 B-4 的元件層補充後才會被套用（見 C-2）。

### C. 版面與元件（`AppShell.tsx`、`DropZone.tsx`、`QueuePanel.tsx`）

1. **移除死代碼**：刪除 `glass.css:145` 的 `h1 { margin-top / font-size: 2rem / line-height / letter-spacing }` 整條區塊（其餘 `h1` 選擇器於 `glass.css:85` 為 reset，保留）。
2. **`DropZone.tsx` 補上拖曳態**：為符合 B-4，元件新增 `useState<boolean>` 追蹤 drag-over，並掛 `onDragEnter` / `onDragLeave` / `onDrop`（僅切換 class，不執行實際檔案處理 — 實際 drop 仍由既有 `registerFileDropHandler` 負責）。若評估後認為與既有 Tauri 原生拖放衝突，則**降級**為純 `:hover` 態並在 plan 中註明。
3. **Queue 提升為滿寬列**：`glass.css` 的 `@media (min-width: 52rem)` 區塊改為：
   ```css
   grid-template-areas:
     "source settings"
     "queue  queue";
   ```
   queue 橫跨整列，取得完整寬度。
4. **卡片高度改為內容驅動**：`.workspace-card` 的 `min-height: 20rem` 改為 `min-height: 0`。
5. **eyebrow 收斂**：移除 topbar 內的 `<p className="eyebrow">Lossless-first media converter</p>`（`AppShell.tsx:221`），品牌區只留 `.brand-name`。intro 的 eyebrow 保留為頁面級唯一標籤。
6. **步驟編號語意分離**：`.card-step` 僅用於卡片序號；`QueuePanel.tsx:160` 的任務計數改用新 class `.queue-count__value`（沿用 tabular-nums 樣式），避免語意混淆。計畫中同時決定是否保留卡片 `01`/`02` 序號（預設：保留，因為它已成序列且對流程有指引作用）。
7. **全域進度指示**：在 topbar 的 `.topbar-actions` 內，依 queue snapshot 推導並顯示 `Offline mode` 徽章旁的一個唯讀狀態，例如「Converting 2/5」。資料來源為既有 `queue.controller` 的 snapshot（`jobs` 陣列），不新增後端事件。無進行中任務時不顯示。

### D. 保留的無障礙契約

以下既有分支必須在改動後仍生效，並於 plan 的驗收步驟逐一確認：`.skip-link`、focus-visible 群組、`@media (prefers-contrast: more)`、`@media (prefers-reduced-transparency: reduce)`、`@media (forced-colors: active)`、`.sr-only` 的 `#status-announcements` 區塊。

## Testing plan

### 需更新的既有測試（因結構重構）

- `src/app/App.test.tsx:124-130`：現行斷言要求 `.queue-panel` 為 `.workspace-source-column` 的**子節點**且排序在 `.workspace-settings-column` 之前。改成滿寬列後，`.queue-panel` 將上移為 `.workspace-layout` 的直接子節點。此斷言需改為：`.queue-panel` 為 layout 直接子節點，且在 DOM 中位於 `.workspace-settings-column` 之後（視覺上為其下）。
- `src/app/App.test.tsx:92,107-109`：`.workspace-intro .supporting-text` 文字斷言不變（intro 文案不動）。
- `src/app/App.test.tsx:110`：`root.querySelector('[role="note"]')` 為 null 的斷言需在新增全域進度後重新確認（進度指示不得使用 `role="note"`）。

### 新增測試

- **全域進度顯示**：queue snapshot 有進行中任務時，topbar 顯示對應計數文字；無任務時不渲染該節點。
- **`.card-step` 與 `.queue-count__value` 語意分離**：`QueuePanel` 不再輸出 `.card-step`。

### 既有測試須全數通過

- `npm test -- --run`：基線 122 tests / 16 files 全綠，改動後不得下降。
- `npm run typecheck`、`npm run build`：須通過。

### 人工驗收（CSS 視覺，無法自動化）

- 桌面寬（≥52rem）：queue 滿寬置底、來源卡不再有死白、hover 有過渡、主 CTA hover 抬升。
- 窄螢幕（≤720px）：單欄堆疊、控制項不裁切。
- 手動切換 `prefers-reduced-motion: reduce` 與 `prefers-contrast: more`：確認動畫關閉、陰影消失。
- 明／暗主題各檢視一次。

## Risks and mitigations

- **拖放態與 Tauri 原生拖放衝突**：`.drop-zone--active` 的實作若與 `registerFileDropHandler` 的原生事件重疊，可能造成雙重處理。緩解：元件層僅切換視覺 class，不攔截檔案；若衝突則降級為 `:hover` 態，並於 plan 記錄。
- **滿寬 queue 造成長列表時頁面過長**：緩解：`.queue-list` 維持現有 gap，必要時在後續迭代加 `max-height` ＋ 內部捲動（本次不做，列入 Non-goals）。
- **radius 縮小影響既有視覺平衡**：緩解：一次只調 radius，先跑完整測試再進其他項目，保留可回退的 commit 邊界。
- **`prefers-contrast: more` 遺漏新增陰影**：緩解：D 節列為必檢項目，plan 中設為獨立驗收步驟。
- **改測試而非改實作以迎合測試**：緩解：僅更新因版位重構而失效的結構斷言，語意與覆蓋不得降低；若某斷言在新結構下失去意義，須在 plan 中明示理由。
