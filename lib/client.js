/**
 * dsh-session-outline — browser half (会话大纲).
 *
 * A single hand-written classic script: no build step, no JSX, no TypeScript.
 * The shell evaluates it and calls `window.__ModuleLoader__.load`, which keeps
 * the factory's closure alive; `apply(ctx)` then contributes one slot:
 *
 *   conversation.session.header.utilities — the 「大纲」 button in the Session
 *   header, plus (only while open) a right-side drawer listing every turn of
 *   the Session.
 *
 * Data comes from the host's existing `turnOutline` projection (projection key
 * `turnOutline`: `{ turn, seq, prompt, response }`, ascending by turn). The
 * drawer fetches nothing: jumping rides the Chat view's own DOM contract —
 * anchor rows carry `data-chat-turn`, and history that has not been paged in
 * yet is pulled first through the Session's `loadThrough(seq)`.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-outline",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;
    /* react-dom is a platform seed word; a harness without it degrades to an
       inline (non-portal) drawer instead of failing to load. */
    var ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch (error) { ReactDOM = null; }

    /* =====================================================================
     * 1. Constants.
     * ===================================================================== */

    /** Drawer width in pixels (fixed; the plugin is a reader, not a layout). */
    var PANEL_WIDTH = 336;
    /** How long a landed row stays highlighted after a jump. */
    var FLASH_MS = 1400;
    /** Upper bound on waiting for a row that history paging should produce. */
    var JUMP_TIMEOUT_MS = 6000;
    /** Poll cadence while waiting for a row (or for the Chat view) to appear. */
    var POLL_MS = 100;
    /** How long the Chat tab switch may take to mount the Chat view. */
    var VIEW_SWITCH_MS = 1200;
    /** Preview clamp for list rows (host previews are already bounded). */
    var ROW_CLAMP = 220;
    /** Scroll-sync throttle while the drawer follows the reader. */
    var ACTIVE_SYNC_MS = 80;
    /** Tab labels that identify the Chat view (it registers with `order: 0`). */
    var CHAT_TAB_LABELS = ["对话", "对话记录", "chat"];

    /* =====================================================================
     * 2. Module-level open state. The button and the drawer live in the same
     *    component, so this store exists only to survive per-session remounts
     *    (a strict session entry remounts on a Session switch).
     * ===================================================================== */

    var openState = false;
    var openListeners = new Set();

    /** Subscribe to the open flag (useSyncExternalStore contract). */
    function subscribeOpen(listener) {
      openListeners.add(listener);
      return function () { openListeners.delete(listener); };
    }

    /** Current open flag (useSyncExternalStore contract). */
    function readOpen() {
      return openState;
    }

    /** Set the open flag, notifying only on a real change. */
    function writeOpen(next) {
      var value = next === true;
      if (openState === value) return;
      openState = value;
      openListeners.forEach(function (listener) { listener(); });
    }

    /* =====================================================================
     * 3. Pure helpers (unit-tested without a DOM).
     * ===================================================================== */

    /**
     * Normalize the `turnOutline` projection value into rows the drawer can
     * render. The value crosses the wire, so every field is untrusted: `turn`
     * is load-bearing (no valid turn drops the row), `seq` is required only for
     * paging in an unloaded turn, and both previews degrade to `''`.
     *
     * @param {unknown} value - projection value (expected `TurnOutlineEntry[]`).
     * @returns {Array<{turn: number, seq: number|null, prompt: string, response: string}>} ascending rows.
     */
    function normalizeEntries(value) {
      if (!Array.isArray(value)) return [];
      var rows = [];
      var seen = Object.create(null);
      for (var index = 0; index < value.length; index += 1) {
        var raw = value[index];
        if (raw === null || typeof raw !== "object") continue;
        var turn = raw.turn;
        if (typeof turn !== "number" || !isFinite(turn) || turn < 0) continue;
        if (Math.floor(turn) !== turn) continue;
        if (seen[turn] === true) continue;
        seen[turn] = true;
        var seq = raw.seq;
        rows.push({
          turn: turn,
          seq: typeof seq === "number" && isFinite(seq) && seq >= 0 && Math.floor(seq) === seq ? seq : null,
          prompt: typeof raw.prompt === "string" ? raw.prompt : "",
          response: typeof raw.response === "string" ? raw.response : "",
        });
      }
      rows.sort(function (left, right) { return left.turn - right.turn; });
      return rows;
    }

    /**
     * Filter rows by a free-text query over the turn number and both previews.
     * @param {ReadonlyArray<{turn: number, prompt: string, response: string}>} entries - normalized rows.
     * @param {string} query - raw search-box value.
     * @returns {ReadonlyArray<object>} matching rows, still ascending.
     */
    function filterEntries(entries, query) {
      var needle = String(query === undefined || query === null ? "" : query).trim().toLowerCase();
      if (needle === "") return entries;
      var hits = [];
      for (var index = 0; index < entries.length; index += 1) {
        var entry = entries[index];
        if (String(entry.turn).indexOf(needle) >= 0
          || entry.prompt.toLowerCase().indexOf(needle) >= 0
          || entry.response.toLowerCase().indexOf(needle) >= 0) {
          hits.push(entry);
        }
      }
      return hits;
    }

    /** Clamp one preview for display, keeping the ellipsis honest. */
    function clampText(text, limit) {
      var value = typeof text === "string" ? text : "";
      var max = typeof limit === "number" && limit > 0 ? limit : ROW_CLAMP;
      if (value.length <= max) return value;
      return value.slice(0, max) + "…";
    }

    /** Whether one row knows the seq needed to page its history in. */
    function canPageTo(entry) {
      return entry !== null && entry !== undefined && entry.seq !== null && entry.seq !== undefined;
    }

    /** Substitute `{name}` placeholders (no Intl dependency). */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (match, key) {
        return values !== undefined && values[key] !== undefined ? String(values[key]) : match;
      });
    }

    /** All copy in one place; the plugin ships Chinese only (the product locale is zh). */
    var COPY = {
      button: "会话大纲",
      title: "会话大纲",
      close: "关闭大纲",
      search: "检索轮次、提问或回答",
      empty: "本会话还没有轮次。",
      emptyFilter: "没有匹配的轮次。",
      failed: "第 {turn} 轮不在当前窗口内，且无法回补历史。",
      noChat: "找不到对话视图，请先切回「对话」页签。",
      turn: "第 {turn} 轮",
      unloaded: "未载入",
      jump: "跳到第 {turn} 轮",
      count: "{count} 轮",
      filtered: "{shown}/{total} 轮",
      projectionMissing: "暂时还没有轮次数据（宿主未提供 turnOutline 投影）。",
    };

    /* =====================================================================
     * 4. DOM bridge — the Chat view's own anchor contract.
     * ===================================================================== */

    /** The transcript column; present only while the Chat view is mounted. */
    function chatColumn() {
      if (typeof document === "undefined" || document === null) return null;
      return document.querySelector("[data-chat-flow]");
    }

    /**
     * The element that actually scrolls the transcript.
     *
     * Desktop builds (dsh 0.2.x) mount a shared Conversation scrollport:
     * `list.closest("[data-conversation-scroll]")` is the scroller, and the
     * Chat view's own `.scroll` layer becomes `overflow:clip visible`, i.e. it
     * does NOT scroll. Taking `column.parentElement` (the old code) therefore
     * wrote scrollTop to a non-scrolling layer and every jump did nothing.
     * Standalone / older layouts scroll the `.scroll` layer itself, so fall
     * back to the first ancestor whose computed overflow-y can scroll.
     */
    function chatScroller(column) {
      if (column === null || column === undefined) return null;
      if (typeof column.closest === "function") {
        var shared = column.closest("[data-conversation-scroll]");
        if (shared !== null && shared !== undefined) return shared;
      }
      var node = column.parentElement;
      while (node !== null && node !== undefined) {
        if (typeof getComputedStyle === "function") {
          var overflowY = getComputedStyle(node).overflowY;
          if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
        }
        node = node.parentElement;
      }
      return column.parentElement;
    }

    /** Locate the anchor row of one turn inside the loaded window. */
    function rowOfTurn(turn) {
      var column = chatColumn();
      if (column === null) return null;
      var rows = column.querySelectorAll("[data-chat-turn]:not([hidden])");
      for (var index = 0; index < rows.length; index += 1) {
        var raw = rows[index].getAttribute("data-chat-turn");
        if (raw !== null && Number(raw) === turn) return rows[index];
      }
      return null;
    }

    /**
     * How long a landed jump owns the current-turn highlight. A smooth scroll
     * passes through every intermediate turn, and letting the follower write
     * during that sweep would make the drawer's highlight sprint and settle on
     * the wrong row.
     */
    var JUMP_HOLD_MS = 900;

    /** Every turn currently rendered in the transcript (the loaded window). */
    function loadedTurns() {
      var column = chatColumn();
      var set = new Set();
      if (column === null) return set;
      var rows = column.querySelectorAll("[data-chat-turn]");
      for (var index = 0; index < rows.length; index += 1) {
        var raw = rows[index].getAttribute("data-chat-turn");
        if (raw !== null && raw !== "") set.add(Number(raw));
      }
      return set;
    }

    /** Cheap equality for the loaded-window turn sets (size + membership). */
    function sameTurns(left, right) {
      if (left.size !== right.size) return false;
      var equal = true;
      left.forEach(function (turn) { if (right.has(turn) === false) equal = false; });
      return equal;
    }

    /** Minimum visible height for a row to count as the reader's place. */
    var MIN_VISIBLE_PX = 24;

    /**
     * Turn number of the topmost anchor row the reader is actually reading.
     *
     * A row that only pokes into the top edge is skipped: a jump parks its
     * target 12px below the scrollport top, so the previous row keeps a thin
     * sliver on screen and would otherwise win the "topmost" comparison.
     */
    function activeTurnFromDom() {
      var column = chatColumn();
      var scroller = chatScroller(column);
      if (column === null || scroller === null) return null;
      var box = scroller.getBoundingClientRect();
      var rows = column.querySelectorAll("[data-chat-turn]:not([hidden])");
      var best = null;
      var bestTop = Infinity;
      for (var index = 0; index < rows.length; index += 1) {
        var rect = rows[index].getBoundingClientRect();
        if (rect.bottom - box.top < MIN_VISIBLE_PX) continue;
        if (rect.top < bestTop) {
          bestTop = rect.top;
          best = Number(rows[index].getAttribute("data-chat-turn"));
        }
      }
      return best === null || isNaN(best) ? null : best;
    }

    /**
     * Bring the Chat view on screen when the reader sits on another tab: the
     * Session header renders one tab per registered Conversation view, and the
     * Chat entry registers with `order: 0`, so it is also the first tab.
     *
     * @returns {boolean} whether a Chat tab click was issued.
     */
    function clickChatTab() {
      if (typeof document === "undefined" || document === null) return false;
      var tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
      if (tabs.length === 0) return false;
      var target = null;
      for (var index = 0; index < tabs.length && target === null; index += 1) {
        var label = String(tabs[index].textContent === null ? "" : tabs[index].textContent).trim().toLowerCase();
        for (var key = 0; key < CHAT_TAB_LABELS.length; key += 1) {
          if (label === CHAT_TAB_LABELS[key].toLowerCase()) { target = tabs[index]; break; }
        }
      }
      if (target === null) target = tabs[0];
      if (typeof target.click !== "function") return false;
      target.click();
      return true;
    }

    /** Wait for a probe to yield a non-null value, bounded by a deadline. */
    function waitFor(probe, timeoutMs) {
      return new Promise(function (resolve) {
        var deadline = Date.now() + timeoutMs;
        var first = probe();
        if (first !== null && first !== undefined) { resolve(first); return; }
        var timer = null;
        function tick() {
          var found = probe();
          if (found !== null && found !== undefined) {
            if (timer !== null) clearTimeout(timer);
            resolve(found);
            return;
          }
          if (Date.now() >= deadline) {
            if (timer !== null) clearTimeout(timer);
            resolve(null);
            return;
          }
          timer = setTimeout(tick, POLL_MS);
        }
        timer = setTimeout(tick, POLL_MS);
      });
    }

    /** Scroll an anchor row to the top of the transcript without moving focus. */
    function scrollRowIntoView(row) {
      var scroller = chatScroller(chatColumn());
      if (scroller === null) {
        if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "start" });
        return;
      }
      var delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      var reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: scroller.scrollTop + delta - 12, behavior: reduced ? "auto" : "smooth" });
      } else {
        scroller.scrollTop = scroller.scrollTop + delta - 12;
      }
    }

    /** Flash the landed row so the eye finds it after a long jump. */
    function flashRow(row) {
      if (typeof row.setAttribute === "function") row.setAttribute("data-outline-landed", "true");
      setTimeout(function () {
        if (typeof row.removeAttribute === "function") row.removeAttribute("data-outline-landed");
      }, FLASH_MS);
    }

    /**
     * Jump to one turn, paging history in first when that turn is not loaded.
     *
     * @param {{turn: number, seq: number|null}} entry - target row.
     * @param {{loadThrough?: Function, timeoutMs?: number}} [deps] - Session-scoped history pager
     *   and an optional wait override (tests shorten it; the UI never sets it).
     * @returns {Promise<{ok: boolean, reason?: string}>} outcome; never rejects.
     */
    async function jumpToTurn(entry, deps) {
      var budget = deps !== undefined && typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
        ? deps.timeoutMs
        : JUMP_TIMEOUT_MS;
      if (chatColumn() === null) {
        if (clickChatTab() === false) return { ok: false, reason: "no-chat" };
        var mounted = await waitFor(chatColumn, VIEW_SWITCH_MS);
        if (mounted === null) return { ok: false, reason: "no-chat" };
      }
      var row = rowOfTurn(entry.turn);
      if (row === null && canPageTo(entry) && deps !== undefined && typeof deps.loadThrough === "function") {
        try {
          await deps.loadThrough(entry.seq);
        } catch (error) {
          // A refused load leaves the row absent; the bounded wait below reports it.
        }
        row = await waitFor(function () { return rowOfTurn(entry.turn); }, budget);
      }
      if (row === null) return { ok: false, reason: "not-loaded" };
      scrollRowIntoView(row);
      flashRow(row);
      return { ok: true };
    }

    /* =====================================================================
     * 5. Styles (one injected <style>, owned by plugin id).
     * ===================================================================== */

    var STYLES = [
      ".so-root{position:relative;display:flex;align-items:center;}",
      ".so-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid transparent;border-radius:calc(var(--dsw-radius, 8px) - 2px);background:transparent;color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap;}",
      ".so-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));}",
      ".so-btn:focus-visible{outline:2px solid var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));outline-offset:1px;}",
      ".so-btn[data-active='true']{color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));}",
      ".so-glyph{display:block;flex:0 0 auto;}",
      ".so-count{padding:0 5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;}",
      ".so-panel{position:fixed;top:0;right:8px;bottom:8px;width:" + PANEL_WIDTH + "px;max-width:92vw;display:flex;flex-direction:column;z-index:30;border:1px solid var(--dsw-border, var(--dsw-alias-border-l2, #34343a));border-radius:12px;background:var(--dsw-alias-bg-layer-1, #1f1f23);color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));box-shadow:0 12px 36px rgba(0,0,0,.28);font-family:var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif);font-size:13px;line-height:1.5;}",
      ".so-head{display:flex;align-items:center;gap:8px;padding:12px 12px 10px 14px;border-bottom:1px solid var(--dsw-border, var(--dsw-alias-border-l2, #34343a));flex:0 0 auto;}",
      ".so-title{font-size:13.5px;font-weight:600;flex:0 0 auto;}",
      ".so-meta{color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-size:11.5px;font-variant-numeric:tabular-nums;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".so-x{flex:0 0 auto;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-size:17px;line-height:1;cursor:pointer;}",
      ".so-x:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));}",
      ".so-search{flex:0 0 auto;padding:10px 12px 8px;}",
      ".so-input{width:100%;box-sizing:border-box;height:30px;padding:0 10px;border:1px solid var(--dsw-border, var(--dsw-alias-border-l2, #34343a));border-radius:var(--dsw-radius, 8px);background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));font:inherit;font-size:12.5px;}",
      ".so-input:focus-visible{outline:2px solid var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));outline-offset:1px;}",
      ".so-note{margin:0 12px 8px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-size:11.5px;line-height:1.55;flex:0 0 auto;}",
      ".so-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 8px 14px;display:flex;flex-direction:column;gap:2px;}",
      ".so-row{display:flex;flex-direction:column;gap:3px;min-width:0;padding:7px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
      ".so-row:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));}",
      ".so-row:focus-visible{outline:2px solid var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));outline-offset:-2px;}",
      ".so-row[data-current='true']{border-color:var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));}",
      ".so-row[data-busy='true']{opacity:.65;}",
      ".so-row-head{display:flex;align-items:center;gap:6px;min-width:0;}",
      ".so-turn{flex:0 0 auto;font-size:11px;font-weight:600;color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-variant-numeric:tabular-nums;}",
      ".so-row[data-current='true'] .so-turn{color:var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));}",
      ".so-tag{flex:0 0 auto;margin-left:auto;padding:0 5px;border:1px solid currentColor;border-radius:999px;font-size:10px;line-height:14px;color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));}",
      ".so-prompt{color:var(--dsw-text, var(--dsw-alias-label-primary, #e6e6e9));font-size:12.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}",
      ".so-response{color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-size:11.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word;}",
      ".so-empty{margin:0;padding:18px 14px;color:var(--dsw-text-secondary, var(--dsw-alias-label-secondary, #9a9aa3));font-size:12px;text-align:center;}",
      "[data-outline-landed='true']{outline:2px solid var(--dsw-accent, var(--dsw-alias-brand-primary, #4d6bfe));outline-offset:2px;border-radius:8px;}",
    ].join("\n");

    /** Install the stylesheet once; returns its disposer. */
    function injectStyles() {
      if (typeof document === "undefined" || document === null) return function noop() {};
      var selector = 'style[data-plugin="dsh-session-outline"]';
      var existing = typeof document.querySelector === "function" ? document.querySelector(selector) : null;
      if (existing !== null && existing !== undefined) return function noop() {};
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin", "dsh-session-outline");
      tag.textContent = STYLES;
      var host = document.head || document.documentElement;
      if (host === null || host === undefined) return function noop() {};
      host.appendChild(tag);
      return function dispose() { if (tag.parentNode) tag.parentNode.removeChild(tag); };
    }

    /* =====================================================================
     * 6. Presentational pieces.
     * ===================================================================== */

    /** Three-line list glyph for the header button. */
    function OutlineGlyph() {
      return h("svg", {
        className: "so-glyph", width: 14, height: 14, viewBox: "0 0 16 16",
        fill: "none", stroke: "currentColor", strokeWidth: 1.4,
        strokeLinecap: "round", "aria-hidden": "true",
      }, h("path", { d: "M3 4.5h10M3 8h10M3 11.5h6" }));
    }

    /** One outline row. */
    function OutlineRow(props) {
      var entry = props.entry;
      var current = entry.turn === props.currentTurn;
      var busy = entry.turn === props.busyTurn;
      return h("button", {
        type: "button",
        className: "so-row",
        "data-current": current ? "true" : undefined,
        "data-busy": busy ? "true" : undefined,
        title: format(COPY.jump, { turn: entry.turn }),
        onClick: function () { props.onJump(entry); },
      },
        h("span", { className: "so-row-head" },
          h("span", { className: "so-turn" }, format(COPY.turn, { turn: entry.turn })),
          props.loaded === true ? null : h("span", { className: "so-tag" }, COPY.unloaded)),
        entry.prompt === "" ? null : h("span", { className: "so-prompt" }, clampText(entry.prompt)),
        entry.response === "" ? null : h("span", { className: "so-response" }, clampText(entry.response)));
    }

    /* =====================================================================
     * 7. The header entry: button + drawer over the Session's own projection.
     * ===================================================================== */

    /**
     * Session-header entry.
     *
     * @param {object} props - runtime slot props: the standard session kit
     *   (`useProjection`, `sessionId`, `useSession`) plus the injected jump
     *   face (`loadThrough`).
     * @returns {object} the header button and, while open, the drawer.
     */
    function OutlineAction(props) {
      var useProjection = props.useProjection;
      var sessionId = props.sessionId;
      var loadThrough = props.loadThrough;

      var outline = typeof useProjection === "function" ? useProjection("turnOutline") : undefined;
      var entries = React.useMemo(function () { return normalizeEntries(outline); }, [outline]);
      var isOpen = React.useSyncExternalStore(subscribeOpen, readOpen, readOpen);
      var state = React.useState("");
      var query = state[0];
      var setQuery = state[1];
      var turnState = React.useState(null);
      var currentTurn = turnState[0];
      var setCurrentTurn = turnState[1];
      var busyState = React.useState(null);
      var busyTurn = busyState[0];
      var setBusyTurn = busyState[1];
      var loadedState = React.useState(function () { return new Set(); });
      var loadedSet = loadedState[0];
      var setLoadedSet = loadedState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var rootRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var listRef = React.useRef(null);
      var searchRef = React.useRef(null);
      var triggerRef = React.useRef(null);
      var jumpHoldUntilRef = React.useRef(0);
      var panelStyle = React.useState(null);
      var panelTop = panelStyle[0];
      var setPanelTop = panelStyle[1];

      var shown = React.useMemo(function () { return filterEntries(entries, query); }, [entries, query]);

      // A Session switch remounts this entry; the drawer must not stay open.
      React.useEffect(function () { writeOpen(false); }, [sessionId]);

      // While open: follow the reader's position, dismiss on outside press / Esc.
      React.useEffect(function () {
        if (!isOpen) return undefined;
        if (typeof document === "undefined" || document === null) return undefined;
        setCurrentTurn(activeTurnFromDom());
        measurePanelTop();
        var initialLoaded = loadedTurns();
        setLoadedSet(function (current) { return sameTurns(current, initialLoaded) ? current : initialLoaded; });
        var scroller = chatScroller(chatColumn());
        var pending = null;
        function sync() {
          if (pending !== null) return;
          pending = setTimeout(function () {
            pending = null;
            if (Date.now() < jumpHoldUntilRef.current) return;
            setCurrentTurn(activeTurnFromDom());
            var nextLoaded = loadedTurns();
            setLoadedSet(function (current) { return sameTurns(current, nextLoaded) ? current : nextLoaded; });
          }, ACTIVE_SYNC_MS);
        }
        function onResize() { measurePanelTop(); }
        function contains(node) {
          return node !== null && node !== undefined
            && (rootRef.current !== null && rootRef.current !== undefined
              && typeof rootRef.current.contains === "function" && rootRef.current.contains(node))
            || (panelRef.current !== null && panelRef.current !== undefined
              && typeof panelRef.current.contains === "function" && panelRef.current.contains(node));
        }
        function onPointerDown(event) {
          if (contains(event.target) === true) return;
          writeOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === "Escape") writeOpen(false);
        }
        if (scroller !== null) scroller.addEventListener("scroll", sync, { passive: true });
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        if (typeof window !== "undefined" && window !== null
          && typeof window.addEventListener === "function") {
          window.addEventListener("resize", onResize);
        }
        if (searchRef.current !== null && searchRef.current !== undefined
          && typeof searchRef.current.focus === "function") searchRef.current.focus();
        return function () {
          if (pending !== null) clearTimeout(pending);
          if (scroller !== null) scroller.removeEventListener("scroll", sync);
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
          if (typeof window !== "undefined" && window !== null
            && typeof window.removeEventListener === "function") {
            window.removeEventListener("resize", onResize);
          }
        };
      }, [isOpen]);

      // Keep the current row visible inside the drawer list.
      React.useEffect(function () {
        if (!isOpen || currentTurn === null) return;
        var list = listRef.current;
        if (list === null || list === undefined || typeof list.querySelector !== "function") return;
        var marked = list.querySelector("[data-current='true']");
        if (marked !== null && marked !== undefined && typeof marked.scrollIntoView === "function") {
          marked.scrollIntoView({ block: "nearest" });
        }
      }, [isOpen, currentTurn]);

      /**
       * Park the drawer just under the header row that owns the toggle, so the
       * button (and every other header utility) stays visible and clickable.
       * The header's real height is whatever the shell made it: measure, never
       * assume. Falls back to a full-height drawer when the toggle is gone.
       */
      function measurePanelTop() {
        var trigger = triggerRef.current;
        if (trigger === null || trigger === undefined || typeof trigger.getBoundingClientRect !== "function") {
          setPanelTop(function (current) { return current === null ? current : null; });
          return;
        }
        var rect = trigger.getBoundingClientRect();
        var top = Math.round(rect.bottom + 8);
        setPanelTop(function (current) { return current === top ? current : top; });
      }

      async function onJump(entry) {
        setNotice(null);
        setBusyTurn(entry.turn);
        var result = await jumpToTurn(entry, { loadThrough: loadThrough });
        setBusyTurn(null);
        if (result.ok) {
          // Own the highlight through the smooth scroll, then let the follower
          // resume from wherever the reader actually is.
          jumpHoldUntilRef.current = Date.now() + JUMP_HOLD_MS;
          setCurrentTurn(entry.turn);
          setLoadedSet(loadedTurns());
          return;
        }
        if (result.reason === "no-chat") { setNotice(COPY.noChat); return; }
        setNotice(format(COPY.failed, { turn: entry.turn }));
      }

      var meta = String(query).trim() === ""
        ? format(COPY.count, { count: entries.length })
        : format(COPY.filtered, { shown: shown.length, total: entries.length });

      var body = null;
      if (entries.length === 0) {
        body = h("p", { className: "so-empty" }, outline === undefined ? COPY.projectionMissing : COPY.empty);
      } else if (shown.length === 0) {
        body = h("p", { className: "so-empty" }, COPY.emptyFilter);
      } else {
        body = h("div", { className: "so-list", ref: listRef },
          shown.map(function (entry) {
            return h(OutlineRow, {
              key: entry.turn,
              entry: entry,
              currentTurn: currentTurn,
              busyTurn: busyTurn,
              loaded: loadedSet.has(entry.turn),
              onJump: onJump,
            });
          }));
      }

      var panelNode = !isOpen ? null : h("aside", {
        className: "so-panel",
        ref: panelRef,
        style: panelTop === null || panelTop === undefined ? undefined : { top: panelTop + "px" },
        role: "dialog",
        "aria-label": COPY.title,
      },
        h("div", { className: "so-head" },
          h("span", { className: "so-title" }, COPY.title),
          h("span", { className: "so-meta" }, meta),
          h("button", {
            type: "button", className: "so-x", title: COPY.close, "aria-label": COPY.close,
            onClick: function () { writeOpen(false); },
          }, "×")),
        h("div", { className: "so-search" },
          h("input", {
            ref: searchRef,
            className: "so-input",
            type: "search",
            value: query,
            placeholder: COPY.search,
            "aria-label": COPY.search,
            onChange: function (event) { setQuery(event.target.value); },
          })),
        notice === null ? null : h("p", { className: "so-note", role: "status" }, notice),
        body);

      var panel = null;
      if (panelNode !== null && ReactDOM !== null && typeof ReactDOM.createPortal === "function"
        && typeof document !== "undefined" && document !== null && document.body !== null) {
        panel = ReactDOM.createPortal(panelNode, document.body);
      } else {
        panel = panelNode;
      }

      return h("div", { className: "so-root", ref: rootRef },
        h("button", {
          type: "button",
          ref: triggerRef,
          className: "so-btn",
          "data-active": isOpen ? "true" : undefined,
          "aria-expanded": isOpen ? "true" : "false",
          "aria-label": COPY.button,
          title: COPY.button,
          onClick: function () { writeOpen(!openState); },
        },
          h(OutlineGlyph),
          h("span", null, COPY.title),
          entries.length === 0 ? null : h("span", { className: "so-count" }, String(entries.length))),
        panel);
    }

    /* =====================================================================
     * 8. apply(): styles + the header registration.
     * ===================================================================== */

    /**
     * Mount the browser half.
     * @param {{slots: object, effect?: Function, sessions?: object}} ctx - browser plugin context.
     */
    function apply(ctx) {
      var disposer = injectStyles();
      if (typeof ctx.effect === "function") {
        ctx.effect(function () { return disposer; }, "session-outline: styles");
      }
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "session-outline",
          order: 50,
          inject: function (sessionId) {
            return {
              /**
               * Page history in until the target turn is loaded. The Chat view
               * exposes the same loader; this reaches it through the Session
               * object layer so the drawer needs no Chat-view coupling.
               */
              loadThrough: function (seq) {
                var sessions = ctx.sessions;
                if (sessions === undefined || sessions === null || typeof sessions.binding !== "function") {
                  return Promise.reject(new Error("session-outline: sessions service unavailable"));
                }
                var binding = sessions.binding(sessionId);
                if (binding === undefined || binding === null) {
                  return Promise.reject(new Error("session-outline: no binding for " + String(sessionId)));
                }
                return binding.session.loadThrough(seq);
              },
            };
          },
        }, OutlineAction);
      });
    }

    exports.name = "session-outline-ui";
    exports.inject = ["slots", "sessions"];
    exports.apply = apply;
    // Test surface: the headless harness drives the pure helpers and the view.
    exports.__internals = {
      normalizeEntries: normalizeEntries,
      filterEntries: filterEntries,
      clampText: clampText,
      canPageTo: canPageTo,
      format: format,
      jumpToTurn: jumpToTurn,
      clickChatTab: clickChatTab,
      rowOfTurn: rowOfTurn,
      activeTurnFromDom: activeTurnFromDom,
      readOpen: readOpen,
      writeOpen: writeOpen,
      OutlineAction: OutlineAction,
      OutlineRow: OutlineRow,
      STYLES: STYLES,
      COPY: COPY,
    };
    return module.exports;
  },
});
