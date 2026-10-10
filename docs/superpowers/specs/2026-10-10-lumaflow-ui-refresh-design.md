# LumaFlow workspace UI refresh — 視覺質感、版面節奏與設計語言校準

## Status

Approved design（使用者已於 2026-10-10 確認三項決策：移除步驟編號、不做拖曳態、進行圓角校準）。本文件為設計規格；實作細節見後續 implementation plan。

## Problem

LumaFlow 現有介面（`src/app/AppShell.tsx`、`src/styles/tokens.css`、`src/styles/glass.css`）在無障礙面已相當完整（skip link、focus ring、`prefers-reduced-transparency`、`forced-colors`、`prefers-contrast`），但視覺質感與資訊架構存在可量化的缺陷。以下每一項均已在現有原始碼中確認，非推測：

1. **全站沒有任何動態過渡。** `glass.css` 全檔 0 個 `transition` / `@keyframes` / `animation`。所有 hover、focus、狀態切換皆為硬切。
2. **`.workspace-card` 寫死 `min-height: 20rem`**（`glass.css:221`）。來源卡片僅含 1 個檔案時，底部留下大片死白。
3. **標題規則衝突。** `h1 { font-size: 2rem }`（`glass.css:145-150`）被 `.workspace-title { font-size: var(--font-size-heading) }`（`glass.css:152`）覆蓋，前者為死代碼。
4. **Drop zone 是主要動作卻完全靜止。** `.drop-zone` 為靜態 flex row，無任何 `:hover` 回饋。
5. **Queue 版面位階過低。** `glass.css:187-205` 以 `grid-template-areas` 將 `.queue-panel` 放在第二列左欄（`grid-area: queue`），寬度僅 `0.85fr`，且在設定欄之後、易被推出視窗。
6. **eyebrow 標籤過度使用。** topbar「Lossless-first media converter」、intro「Workspace」、來源卡「Source media」、設定卡「Configuration」、queue「Processing workspace」共 5 處全大寫小字，彼此搶奪焦點。
7. **步驟編號語意不一致。** 卡片有 `card-step` 顯示 `01` / `02`（序號，`AppShell.tsx:265,290`），但 `QueuePanel.tsx:160` 重用同一 class 顯示**任務計數**（`jobs.length`），語意不同卻共用樣式。
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
- **不實作拖曳中（drag-over）視覺狀態**；`DropZone.tsx` 本次不新增任何 drag 事件處理，僅提供 CSS `:hover` 回饋。
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
--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08); /* 新增：內層卡片／互動抬升 */
```

深色主題（`:root[data-theme="dark"]` 與 `@media (prefers-color-scheme: dark)` 分支）需同步提供對應的 `--shadow-raised`（建議 `0 0.5rem 1.5rem rgba(0, 0, 0, 0.3)`）。`@media (prefers-contrast: more)` 分支在既有 `--shadow-panel: none` 之外，**必須同時**將 `--shadow-raised` 設為 `none`。

既有硬編 `border-radius: 999px`（`.theme-toggle`、`.status-badge`、`.queue-status`）改用 `var(--radius-pill)`。

驗收：`prefers-contrast: more` 下不得出現任何陰影。

### B. 過渡與互動態（`glass.css`）

1. 對下列選擇器加 `transition`，僅過渡會變動的屬性（`background-color`、`border-color`、`color`、`box-shadow`、`transform`），時長與曲線用 `var(--motion-base) var(--ease-standard)`：
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
3. `.button--primary` 加極輕微 hover 抬升：`transform: translateY(-1px)` ＋ `box-shadow: var(--shadow-raised)`；`:active` 回歸 `translateY(0)`。不得造成 layout shift（不使用 margin）。
4. `.drop-zone` 新增 `.drop-zone:hover`：accent 邊框 ＋ `--color-accent-soft` 極淡底色。**不**實作拖曳中狀態（見 Non-goals）。此態的價值在於讓全頁最主要的動作在滑鼠移入時有明確回饋。

### C. 版面與元件

1. **移除死代碼**：刪除 `glass.css:145-150` 的 `h1 { margin-top / font-size: 2rem / line-height / letter-spacing }` 整條區塊（`glass.css:85` 的 `h1` reset 群組保留）。
2. **Queue 提升為滿寬列**：`glass.css` 的 `@media (min-width: 52rem)` 區塊改為：
   ```css
   grid-template-areas:
     "source settings"
     "queue  queue";
   ```
   queue 橫跨整列取得完整寬度。對應需調整 `AppShell.tsx` 的 JSX：`.queue-panel` 移出 `.workspace-source-column`，成為 `.workspace-layout` 的直接子節點，且置於 `.workspace-settings-column` 之後（配合新版位）。`.workspace-source-column` 至此只含來源卡。
3. **卡片高度改為內容驅動**：`.workspace-card` 的 `min-height: 20rem`（`glass.css:221`）改為 `min-height: 0`。
4. **eyebrow 收斂**：移除 topbar 內的 `<p className="eyebrow">Lossless-first media converter</p>`（`AppShell.tsx:221`），品牌區只留 `.brand-name`。intro 的「Workspace」eyebrow 保留為頁面級唯一標籤。
5. **移除卡片步驟編號**：刪除 `AppShell.tsx:265` 與 `AppShell.tsx:290` 兩處 `<span className="card-step" aria-hidden="true">01/02</span>`，並移除 `.card-step` 樣式規則（`glass.css:237-242`）。`QueuePanel.tsx:160` 的任務計數不再重用已刪除的 class，改用新 class `.queue-count__value`，樣式沿用 `font-variant-numeric: tabular-nums`、`color: var(--color-text-subtle)`、`font-weight: var(--font-weight-bold)`（新增於 `.queue-count` 規則附近）。
6. **全域進度指示**：在 topbar 的 `.topbar-actions` 內，依 queue snapshot 推導並顯示一個唯讀狀態文字，例如「Converting 2/5」（進行中 / 總數）。資料來源為既有 `queue.controller` 的 snapshot `jobs` 陣列，不新增後端事件。無進行中任務時**不渲染**該節點（保持現有 topbar 外觀不變）。

### D. 保留的無障礙契約

以下既有分支必須在改動後仍生效，並於 plan 的驗收步驟逐一確認：`.skip-link`、focus-visible 群組、`@media (prefers-contrast: more)`、`@media (prefers-reduced-transparency: reduce)`、`@media (forced-colors: active)`、`.sr-only` 的 `#status-announcements` 區塊。

## Testing plan

### 需更新的既有測試（因結構重構）

- `src/app/App.test.tsx:124-130`：現行斷言要求 `.queue-panel` 為 `.workspace-source-column` 的**子節點**且排序在 `.workspace-settings-column` 之前。改為滿寬列後，`.queue-panel` 上移為 `.workspace-layout` 的直接子節點。斷言改為：`.queue-panel` 為 layout 直接子節點、且其在 layout children 中的索引 **大於** `.workspace-settings-column`（視覺上位於設定欄下方）。
- `src/app/App.test.tsx:116`：`sourceColumn?.querySelectorAll(".queue-panel")` 由 `toHaveLength(1)` 改為 `toHaveLength(0)`（queue 已不在來源欄內）。
- `src/app/App.test.tsx:92,107-109`：`.workspace-intro .supporting-text` 文字斷言不變（intro 文案不動）。
- `src/app/App.test.tsx:110`：`root.querySelector('[role="note"]')` 為 null 的斷言需在新增全域進度後重新確認 — 進度指示**不得**使用 `role="note"`（建議用純文字或 `role="status"`；若改用 `role="status"` 則須同步更新此斷言）。

### 新增測試

- **全域進度顯示**：queue snapshot 有進行中任務時，topbar 顯示對應計數文字；無任務時該節點不存在。
- **步驟編號已移除**：`AppShell` 渲染結果不含 `.card-step`。
- **計數語意分離**：`QueuePanel` 不再輸出 `.card-step`，改輸出 `.queue-count__value`。

### 既有測試須全數通過

- `npm test -- --run`：基線 **122 tests / 16 files 全綠**，改動後不得下降。
- `npm run typecheck`、`npm run build`：須通過。

### 人工驗收（CSS 視覺，無法自動化）

- 桌面寬（≥52rem）：queue 滿寬置底、來源卡不再有死白、hover 有過渡、主 CTA hover 抬升、topbar 在 idle 時外觀與改動前一致。
- 窄螢幕（≤720px）：單欄堆疊、控制項不裁切。
- 手動切換 `prefers-reduced-motion: reduce`、`prefers-contrast: more`、`prefers-reduced-transparency: reduce`、`forced-colors: active`：確認對應分支生效（動畫關閉、陰影消失、玻璃與背景置換）。
- 明／暗主題各檢視一次。

## Risks and mitigations

- **滿寬 queue 造成長列表時頁面過長**：緩解：`.queue-list` 維持現有 gap；本輪不加 `max-height`／內部捲動，若實際過長列入下一輪。
- **radius 縮小影響既有視覺平衡**：緩解：radius 校準獨立成一個 commit，先跑完整測試再進其他項目，保留可回退的邊界。
- **`prefers-contrast: more` 遺漏新增陰影**：緩解：D 節列為必檢項目，plan 中設為獨立驗收步驟。
- **topbar 新增進度節點在 idle 時改變外觀**：緩解：idle 時完全不渲染，並以既有 idle 渲染測試（`App.test.tsx` 首個測試）作為回歸保護。
- **改測試而非改實作以迎合測試**：緩解：僅更新因版位重構而失效的結構斷言，語意與覆蓋不得降低；若某斷言在新結構下失去意義，須在 plan 中明示理由。
