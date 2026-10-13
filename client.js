/**
 * dsh-composer-plus: composer history (ArrowUp/ArrowDown), Shift+Tab `/plan` toggle, a one-click
 * Continue button, drag-and-drop reordering of queued messages, a session "Copy deeplink" menu item and an
 * Auto Review "Allow for this chat" grant per exact tool (saved until revoked), and OS notifications while dsh is in the
 * background (turn finished, approval/question/plan review waiting), and a Codex-style "Changes" page in the right
 * sidebar. The Host half (index.js) serves read-only git changes and persists Auto Review grants.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-plus',
  factory(require) {
    const React = require('react');

    /** Human-sent message texts in transcript order, newest last, repeats collapsed. */
    function sentTexts(order, nodes) {
      const list = [];
      for (const key of order) {
        const node = nodes.get(key);
        if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue;
        const { content, source } = node.data;
        // Skip parent-agent, schedule and other non-human inputs.
        if ((source !== undefined && source.kind !== 'user') || !Array.isArray(content)) continue;
        const text = content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim();
        if (text !== '' && list[list.length - 1] !== text) list.push(text);
      }
      return list;
    }

    function ComposerHistory({ useChat, useInput, inputActions }) {
      // Hooks run only here, during render; the key handler reads their latest values from `live`.
      const order = useChat((snapshot) => snapshot.order);
      const nodes = useChat((snapshot) => snapshot.nodes);
      const draft = useInput((state) => state.draft);
      const live = React.useRef(null);
      live.current = { order, nodes, draft, inputActions };
      /** Last recalled entry; browsing lasts only while the draft still equals its text. */
      const recalled = React.useRef(null);
      const anchor = React.useRef(null);

      React.useEffect(() => {
        const seat = anchor.current.closest('[data-composer-seat]');
        if (seat === null) return undefined;

        const onKeyDown = (event) => {
          const up = event.key === 'ArrowUp';
          if (!up && event.key !== 'ArrowDown') return;
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
          const input = event.target instanceof Element ? event.target.closest('[data-composer-input]') : null;
          if (input === null || !input.isContentEditable || input.closest('[data-composer-seat]') !== seat) return;
          if (seat.querySelector('[data-trigger-menu]') !== null) return; // an open slash/@ menu owns the arrows

          const { order, nodes, draft, inputActions } = live.current;
          const history = sentTexts(order, nodes);
          const last = recalled.current;
          // Browsing position; re-found by text when older history was prepended.
          const at = last === null || draft !== last.text ? -1
            : history[last.index] === draft ? last.index : history.lastIndexOf(draft);
          if (at === -1 && (!up || draft !== '')) return; // not browsing: normal caret keys
          // ponytail: lines are '\n' paragraphs; a soft-wrapped long line counts as one line.
          // Like zsh, the caret first walks a multi-line entry and switches entries from its first/last line.
          const { start, end } = inputActions.captureInsertion();
          if (up ? draft.slice(0, start).includes('\n') : draft.slice(end).includes('\n')) return;

          const next = up ? (at === -1 ? history.length - 1 : at - 1) : at + 1;
          if (next < 0 && at === -1) return; // nothing sent yet
          event.preventDefault();
          event.stopPropagation();
          if (next < 0) return; // already at the oldest entry
          // Past the newest entry: back to the empty prompt.
          const text = next < history.length ? history[next] : '';
          recalled.current = text === '' ? null : { index: next, text };
          inputActions.setDraft(text);
        };

        // Capture on the seat runs before the editor's own keydown handling.
        seat.addEventListener('keydown', onKeyDown, true);
        return () => {
          seat.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      return React.createElement('span', { ref: anchor, hidden: true });
    }

    /** `/plan` at the very start (not `/planning`) plus at most one following space/tab. */
    const PLAN_PREFIX = /^\/plan(?=$|\s)[ \t]?/;
    /** Shift+Tab edit: drop a leading `/plan` command, otherwise prepend one. */
    function planToggle(draft) {
      const match = PLAN_PREFIX.exec(draft);
      return match === null ? { start: 0, end: 0, text: '/plan ' } : { start: 0, end: match[0].length, text: '' };
    }

    /** Shift+Tab on every platform. */
    const isPlanKey = (event) => event.key === 'Tab' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

    /** The plan key leaves plan mode when the chat is in it (as dsh's plan chip does: `/plan off`); otherwise it
     * toggles a leading `/plan` and leaves the caret at the end. Rides `conversation.input.right` because, unlike
     * the composer dock, it also renders on a blank chat. */
    function PlanToggle({ useInput, inputActions, useProjection, exitPlanMode, notify }) {
      const draft = useInput((state) => (state === undefined ? '' : state.draft));
      const plan = typeof useProjection === 'function' ? useProjection('plan') : undefined;
      // Same effective target as dsh's PlanChip: a pending switch flips the folded host value.
      const planOn = plan !== undefined && (plan.pending ? !plan.active : plan.active);
      const live = React.useRef(null);
      live.current = { draft, inputActions, planOn, exitPlanMode, notify };
      const anchor = React.useRef(null);

      React.useEffect(() => {
        const seat = anchor.current === null ? null : anchor.current.closest('[data-composer-seat]');
        if (seat === null) return undefined;
        const onKeyDown = (event) => {
          if (!isPlanKey(event)) return;
          const input = event.target instanceof Element ? event.target.closest('[data-composer-input]') : null;
          if (input === null || !input.isContentEditable || input.closest('[data-composer-seat]') !== seat) return;
          if (seat.querySelector('[data-trigger-menu]') !== null) return; // Shift+Tab closes an open slash/@ menu
          event.preventDefault();
          event.stopPropagation();
          const { draft, inputActions, planOn, exitPlanMode, notify } = live.current;
          if (event.repeat || event.isComposing || event.keyCode === 229) return;
          if (planOn && exitPlanMode !== undefined) {
            exitPlanMode().then((failure) => { if (failure !== null && notify !== undefined) notify('error', failure); },
              (reason) => { if (notify !== undefined) notify('error', reason instanceof Error ? reason.message : String(reason)); });
            return;
          }
          if (inputActions === undefined) return;
          const { start, end, text } = planToggle(draft);
          // Edit only the prefix so the rest of the draft, its file chips and attachments stay intact.
          if (!inputActions.insertText(text, { ...inputActions.captureInsertion(), start, end })) return;
          // Lexical commits the edit and its own caret asynchronously; move the caret after that commit.
          requestAnimationFrame(() => {
            if (!input.isConnected) return;
            const range = document.createRange();
            range.selectNodeContents(input);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          });
        };
        seat.addEventListener('keydown', onKeyDown, true);
        return () => {
          seat.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      return React.createElement('span', { ref: anchor, hidden: true });
    }

    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    /** dsh's canonical session URI: `dsh-session:` + base64url of the JSON-encoded id (as `dsh-session-reference`
     * encodes it). Pasted into another chat, dsh attaches that session as read-only context. */
    function sessionDeeplink(sessionId) {
      let binary = '';
      for (const byte of new TextEncoder().encode(JSON.stringify(sessionId))) binary += String.fromCharCode(byte);
      return `dsh-session:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    }

    /** "Copy deeplink" row in a session's "…" menu. */
    function CopyDeeplinkItem({ sessionId, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return React.createElement(primitives.MenuItemButton, {
        icon: React.createElement(primitives.IconLinkOutlineRegular, {}),
        onSelect: () => {
          setMenuOpen(false);
          primitives.writeClipboard(sessionDeeplink(sessionId));
        },
      }, t('copyDeeplink'));
    }

    /** Right-click on a session row opens its "…" menu; dsh rows have no context menu of their own.
     * shortcut: finds the "…" button in the row's DOM; if a dsh update changes that markup, right-click falls back
     * to the default menu. Upgrade when dsh adds a row context-menu slot. */
    function RowContextMenu() {
      const anchor = React.useRef(null);
      React.useEffect(() => {
        const row = anchor.current === null ? null : anchor.current.closest('[data-row-key^="session:"]');
        if (row === null) return undefined;
        const onContextMenu = (event) => {
          // The "…" button is the row's only button outside a plugin slot.
          const menuButton = [...row.querySelectorAll('button')].find((button) => {
            const slot = button.closest('[data-slot]');
            return slot === null || !row.contains(slot);
          });
          if (menuButton === undefined) return;
          event.preventDefault();
          menuButton.click();
        };
        row.addEventListener('contextmenu', onContextMenu);
        return () => {
          row.removeEventListener('contextmenu', onContextMenu);
        };
      }, []);
      return React.createElement('span', { ref: anchor, hidden: true });
    }

    /** Dictionary namespace for this plugin's menu copy; dsh ships `en` and `zh`. */
    const LOCALE_NS = 'dsh-composer-plus';
    let createPortal;
    try { createPortal = require('react-dom').createPortal; } catch { createPortal = undefined; }
    /** The composer's Send button (class `<hash>_primary`); the stop button shares it but only while running. */
    function findSend(anchor) {
      const seat = anchor.closest('[data-composer-seat]');
      if (seat === null) return null;
      const buttons = [...seat.querySelectorAll('button')].filter((b) => /(^|\s)\w+_primary(\s|$)/.test(b.className));
      return buttons.length === 0 ? null : buttons[buttons.length - 1];
    }
    /** Codex-style resume: when the turn has stopped, the composer is empty and the chat has history,
     * Send turns into a play button that submits "continue". Send is not a slot, so the play button is
     * portaled into Send's row with Send's own class and Send is hidden meanwhile.
     * Hidden on a blank chat, while running, in subagent views, or as soon as the user types or attaches. */
    function ContinueButton({ useSession, useInput, inputActions, t }) {
      const show = useSession((s) => s !== undefined && !s.blank && !s.running && s.subagent === null && !s.removed);
      const idle = useInput((s) => s !== undefined && s.phase === 'plain' && s.draft.trim() === '' && s.attachmentIds.length === 0);
      const visible = show && idle && inputActions !== undefined;
      const anchorRef = React.useRef(null);
      const [host, setHost] = React.useState(null);
      React.useLayoutEffect(() => {
        const send = !visible || anchorRef.current === null || createPortal === undefined ? null : findSend(anchorRef.current);
        if (send === null) { setHost(null); return undefined; }
        send.style.display = 'none';
        setHost({ parent: send.parentElement, className: send.className });
        return () => { send.style.display = ''; };
      }, [visible]);
      const anchor = React.createElement('span', { ref: anchorRef, hidden: true, 'aria-hidden': true });
      if (!visible || host === null) return anchor;
      const onClick = () => {
        // The sent message follows dsh's language, so the model reads it in the user's own language.
        const text = t('continue.message');
        if (React.flushSync !== undefined) React.flushSync(() => inputActions.setDraft(text));
        else inputActions.setDraft(text);
        inputActions.submit();
      };
      const button = React.createElement('button', {
        type: 'button',
        className: host.className,
        title: t('continue.label'),
        'aria-label': t('continue.label'),
        onMouseDown: (event) => event.preventDefault(),
        onClick,
      }, React.createElement('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        React.createElement('path', { d: 'M4.5 2.6v10.8c0 .8.9 1.3 1.6.8l8-5.4c.6-.4.6-1.2 0-1.6l-8-5.4c-.7-.5-1.6 0-1.6.8Z', fill: 'currentColor' })));
      return React.createElement(React.Fragment, null, anchor, createPortal(button, host.parent));
    }

    /** Text of an all-text queue row, or null when it carries images/files (queue edits are text-only). */
    const textOf = (content) => (content.every((block) => block.type === 'text') ? content.map((block) => block.text).join('') : null);
    const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    const GRIP = 'data-queue-grip';
    const DROP_LINE = 'var(--dsw-alias-state-business-primary)';
    /** Queue reorder by drag and drop: a grip at the left of each queued row. Keyboard: ↑/↓ on a focused grip.
     * The Host has no move operation, so a move rotates row texts through the existing `edit` action, from the
     * tail toward the head (the agent only claims the head); any failure reverts the edits already applied,
     * so nothing is lost or duplicated.
     * shortcut: grips are portaled into QueueDock rows found in the DOM; if a dsh update changes that markup the
     * grips just stop appearing — upgrade when dsh exposes a queue row slot or a native move action. */
    function QueueReorder({ useSession, useProjection, updateQueue, notify, t }) {
      const inbox = useProjection('inbox');
      const pending = useSession((s) => (s === undefined ? undefined : s.pendingSubmissions));
      const mutable = useSession((s) => s !== undefined && (s.subagent === null || s.subagent.address.mode === 'continuable'));
      const rows = React.useMemo(() => {
        const all = (inbox && inbox['next-turn']) || [];
        // Same filter as QueueDock: rows already echoed in the transcript are not shown in the dock.
        const inChat = new Set((pending || []).filter((p) => p.placement === 'transcript').map((p) => p.requestId));
        return all.filter(({ source }) => source.kind !== 'user' || !('rpcId' in source) || !inChat.has(source.rpcId));
      }, [inbox, pending]);
      const anchorRef = React.useRef(null);
      // Rows plus each row's grip host (null while the row is being edited); re-scanned on every dock mutation.
      const [dom, setDom] = React.useState({ items: [], hosts: [] });
      const items = dom.items;
      const [busy, setBusy] = React.useState(false);
      const active = createPortal !== undefined && updateQueue !== undefined && mutable && rows.length >= 2;
      React.useLayoutEffect(() => {
        const anchor = anchorRef.current;
        const seat = anchor === null ? null : anchor.closest('[data-composer-seat]');
        if (seat === null || !active) { setDom({ items: [], hosts: [] }); return undefined; }
        const scan = () => {
          const dock = seat.querySelector('[data-queue-dock]');
          const lis = dock === null ? [] : [...dock.querySelectorAll('li:not([data-submission-echo])')];
          for (const li of lis) {
            if (li.firstElementChild !== null && li.firstElementChild.hasAttribute(GRIP)) continue;
            const host = document.createElement('span');
            host.setAttribute(GRIP, '');
            host.style.display = 'contents';
            li.insertBefore(host, li.firstChild);
          }
          // Editing swaps the row body; when it ends the grip must be portaled again, so hosts are part of the state.
          const hosts = lis.map((li) => (li.querySelector('textarea') === null ? li.firstElementChild : null));
          setDom((prev) => (sameList(prev.items, lis) && sameList(prev.hosts, hosts) ? prev : { items: lis, hosts }));
        };
        scan();
        const observer = new MutationObserver(scan);
        observer.observe(seat, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          for (const host of seat.querySelectorAll(`[${GRIP}]`)) host.remove();
        };
      }, [active]);
      const anchor = React.createElement('span', { ref: anchorRef, hidden: true, 'aria-hidden': true });
      if (!active || items.length !== rows.length) return anchor;
      const texts = rows.map((row) => textOf(row.content));
      const movable = (from, to) => from !== to && to >= 0 && to < rows.length
        && texts.slice(Math.min(from, to), Math.max(from, to) + 1).every((text) => text !== null);
      const move = async (from, to) => {
        if (busy || !movable(from, to)) return;
        const order = texts.map((_, index) => index);
        order.splice(to, 0, order.splice(from, 1)[0]);
        const changes = [];
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (order[index] !== index) changes.push({ row: rows[index], next: texts[order[index]], prev: texts[index] });
        }
        const edit = (row, text) => updateQueue(row.id, { kind: 'edit', content: [{ type: 'text', text }] });
        setBusy(true);
        const done = [];
        try {
          for (const change of changes) {
            await edit(change.row, change.next);
            done.push(change);
          }
        } catch {
          for (const change of done.reverse()) await edit(change.row, change.prev).catch(() => undefined);
          notify('error', t('queue.failed'));
        } finally {
          setBusy(false);
        }
      };
      const mark = (target, from, to) => {
        items.forEach((li) => { li.style.boxShadow = ''; li.style.opacity = ''; });
        if (target === null) return;
        items[from].style.opacity = '0.5';
        if (to !== from) items[to].style.boxShadow = `inset 0 ${to < from ? 2 : -2}px 0 ${DROP_LINE}`;
      };
      const startDrag = (from, event) => {
        if (busy || event.button !== 0) return;
        event.preventDefault();
        let to = from;
        const slot = (y) => {
          // Insertion index among the other rows, by row midpoints.
          let index = 0;
          items.forEach((li, i) => {
            if (i === from) return;
            const rect = li.getBoundingClientRect();
            if (y > rect.top + rect.height / 2) index += 1;
          });
          return index;
        };
        const onMove = (e) => {
          const next = slot(e.clientY);
          to = movable(from, next) ? next : from;
          mark(true, from, to);
          document.body.style.cursor = 'grabbing';
        };
        const finish = (commit) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onKey, true);
          document.body.style.cursor = '';
          mark(null);
          if (commit && to !== from) move(from, to);
        };
        const onUp = () => finish(true);
        const onCancel = () => finish(false);
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('keydown', onKey, true);
        mark(true, from, from);
      };
      const portals = rows.map((row, index) => {
        const host = dom.hosts[index];
        if (host === null || !host.hasAttribute(GRIP) || !host.isConnected) return null;
        const draggable = texts[index] !== null && !busy;
        const grip = React.createElement('button', {
          type: 'button',
          title: draggable ? t('queue.drag') : t('queue.locked'),
          'aria-label': t('queue.grip'),
          disabled: !draggable,
          onPointerDown: (event) => startDrag(index, event),
          onKeyDown: (event) => {
            const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
            if (delta === 0) return;
            event.preventDefault();
            move(index, index + delta);
          },
          style: { flex: 'none', display: 'grid', placeItems: 'center', width: 16, height: 24, padding: 0, marginLeft: -6,
            border: 'none', background: 'none', color: 'var(--dsw-alias-label-tertiary)', cursor: draggable ? 'grab' : 'default',
            opacity: draggable ? 1 : 0.35, touchAction: 'none' },
        }, React.createElement('svg', { viewBox: '0 0 10 16', width: 10, height: 16, 'aria-hidden': true },
          ...[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => React.createElement('circle', { key: `${x}-${y}`, cx: x, cy: y, r: 1.3, fill: 'currentColor' })))));
        return createPortal(grip, host, row.id);
      });
      return React.createElement(React.Fragment, null, anchor, ...portals.filter((portal) => portal !== null));
    }

    /** Auto Review per-chat tool grants: session id -> exact tool names (a fresh Set per change, so React sees it).
     * Saved by the Host half so they survive a restart; revoking deletes them there too. Only Auto Review denials that reached the user are
     * answered, through the approval card's own `answer('allowed-once')`; review failures never get that far. */
    const grants = new Map();
    const grantListeners = new Set();
    const subscribeGrants = (listener) => { grantListeners.add(listener); return () => { grantListeners.delete(listener); }; };
    const grantsChanged = () => { for (const listener of [...grantListeners]) listener(); };
    const isGranted = (sessionId, toolName) => grants.get(sessionId)?.has(toolName) === true;
    /** Host-side copy of the grants (`/api/composer-plus.grants`) so they survive a restart. Absent host half: memory only. */
    const GRANTS_ROUTE = '/api/composer-plus.grants';
    const saveGrant = (body) => {
      try { fetch(GRANTS_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch { /* best-effort */ }
    };
    async function loadGrants() {
      try {
        const response = await fetch(GRANTS_ROUTE);
        if (!response.ok) return;
        const data = await response.json();
        if (data === null || typeof data !== 'object') return;
        for (const [sessionId, tools] of Object.entries(data)) {
          if (Array.isArray(tools)) grants.set(sessionId, new Set([...(grants.get(sessionId) ?? []), ...tools.filter((x) => typeof x === 'string')]));
        }
        grantsChanged();
      } catch { /* host half missing or offline: grants stay in memory */ }
    }
    function grant(sessionId, toolName) {
      grants.set(sessionId, new Set([...(grants.get(sessionId) ?? []), toolName]));
      grantsChanged();
      saveGrant({ action: 'grant', sessionId, tool: toolName });
    }
    function revoke(sessionId) {
      if (grants.delete(sessionId)) grantsChanged();
      saveGrant({ action: 'revoke', sessionId });
    }
    const AUTO_REVIEW_ASK = 'Auto review denied tool ';
    const isAutoReviewAsk = (p) => p !== undefined && p !== null && p.kind === 'approval' && typeof p.reason === 'string' && p.reason.startsWith(AUTO_REVIEW_ASK);
    /** Requests this plugin already answered (or is answering), so concurrent updates never answer twice. */
    const claimed = new WeakSet();
    /** Allow every pending Auto Review ask whose exact tool is granted in its own chat. */
    function answerGranted(snapshot) {
      for (const [sessionId, status] of snapshot) {
        const p = status === undefined ? undefined : status.pendingInteraction;
        if (!isAutoReviewAsk(p) || p.sessionId !== sessionId || !p.answerable || claimed.has(p) || !isGranted(sessionId, p.toolName)) continue;
        claimed.add(p);
        p.answer('allowed-once').catch(() => {}); // already settled elsewhere: nothing to do
      }
    }

    /** "Allow for this chat" on the Auto Review approval card, plus a header chip that lists and revokes the grants.
     * shortcut: the button is portaled into the card's button row found in the DOM (`data-approval-key`); if a dsh
     * update changes that markup the button just stops appearing. Upgrade when dsh adds an approval action slot. */
    function ChatToolGrants({ sessionId, useSessionStatus, t }) {
      const pending = useSessionStatus((snapshot) => snapshot.get(sessionId)?.pendingInteraction);
      const granted = React.useSyncExternalStore(subscribeGrants, () => grants.get(sessionId));
      const ask = isAutoReviewAsk(pending) && pending.sessionId === sessionId && !isGranted(sessionId, pending.toolName) ? pending : null;
      const [host, setHost] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        setHost(null);
        setBusy(false);
        if (ask === null || createPortal === undefined) return undefined;
        let frame = 0;
        const find = () => {
          const card = document.querySelector(`[data-approval-key="${CSS.escape(ask.key)}"]`);
          const buttons = card === null ? [] : card.querySelectorAll('button');
          if (buttons.length > 0) setHost(buttons[buttons.length - 1].parentElement); // Reject / Allow once row
          else frame = requestAnimationFrame(find);
        };
        find();
        return () => { cancelAnimationFrame(frame); };
      }, [ask]);
      const allow = () => {
        if (busy || claimed.has(ask) || !ask.answerable) return;
        setBusy(true);
        claimed.add(ask);
        // Grant only after this click really answered the request; a cancelled or already answered one throws.
        ask.answer('allowed-once').then(() => { grant(sessionId, ask.toolName); }, () => { setBusy(false); });
      };
      const tools = [...(granted ?? [])];
      const chip = tools.length === 0 ? null : React.createElement(primitives.Button, {
        variant: 'toolbar',
        size: 'sm',
        title: t('grantsTitle', { tools: tools.join('\n') }),
        onClick: () => { revoke(sessionId); },
      }, t('grants', { count: String(tools.length) }));
      const button = ask === null || host === null ? null : createPortal(React.createElement(primitives.Button, {
        variant: 'outline',
        disabled: busy,
        title: t('allowChatTitle', { toolName: ask.toolName }),
        style: { order: -1, marginRight: 'auto' },
        onClick: allow,
      }, t('allowChat')), host, ask.key);
      return chip === null && button === null ? null : React.createElement(React.Fragment, null, chip, button);
    }

    /** macOS/OS notifications while dsh is in the background: a turn finished, or a chat waits for an approval,
     * a question or a plan review. Built on dsh's own Session status (`running`, `pendingInteraction`);
     * clicking a notification focuses dsh and opens that chat. Uses the web Notification API, which the desktop
     * app permits. Nothing is shown while the dsh window is focused. */
    function attentionKind(previous, status) {
      const pending = status === undefined ? undefined : status.pendingInteraction;
      if (pending !== undefined && pending !== null && (previous === undefined || previous.pendingInteraction !== pending)) {
        return pending.kind === 'approval' ? 'approval' : pending.kind === 'plan-review' ? 'planReview' : 'question';
      }
      // dsh sets `completionUnread` only for chats that are not open, so the open chat's finish is its running → idle edge.
      if (status !== undefined && previous !== undefined && previous.running === true && status.running === false && pending == null) return 'done';
      return null;
    }
    /** First non-empty line of a text, trimmed to a notification-friendly length. */
    const firstLine = (text, max = 140) => {
      const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
      return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    };
    /** Notification body: the tool an approval is for, a question's first line, or the reply's opening line. */
    function attentionBody(kind, pending, reply, t) {
      if (kind === 'approval' && pending?.toolName) return t('notify.approvalTool', { tool: pending.toolName });
      if (kind === 'question') {
        const q = pending?.questions?.[0];
        const text = firstLine(q?.question ?? q?.header);
        if (text !== '') return t('notify.questionText', { text });
      }
      if (kind === 'done') {
        const text = firstLine(reply);
        if (text !== '') return text;
      }
      return t(`notify.${kind}`);
    }
    /** Latest reply preview from dsh's `turnOutline` projection, when the session list carries it. */
    const replyOf = (sessionsList, sessionId) => {
      const outline = sessionsList.getSnapshot().projectionsBySession?.[sessionId]?.values?.turnOutline;
      return Array.isArray(outline) && outline.length > 0 ? outline[outline.length - 1]?.response : undefined;
    };
    function watchAttention(status, sessionsList, t, open) {
      let last = status.getSnapshot();
      const shown = new Map();
      const notify = () => {
        const next = status.getSnapshot();
        const before = last;
        last = next;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.hasFocus()) return;
        for (const [sessionId, current] of next) {
          const kind = attentionKind(before.get(sessionId), current);
          if (kind === null) continue;
          const row = sessionsList.getSnapshot().byId[sessionId];
          if (row !== undefined && row.origin === 'subagent') continue; // the parent chat reports for its children
          const title = row === undefined ? 'DeepSeek Harness' : row.displayTitle;
          shown.get(sessionId)?.close();
          const body = attentionBody(kind, current.pendingInteraction, kind === 'done' ? replyOf(sessionsList, sessionId) : undefined, t);
          const n = new Notification(title, { body, tag: `dsh:${sessionId}`, silent: false });
          n.onclick = () => { window.focus(); open(sessionId); n.close(); unread.delete(sessionId); badge(); };
          shown.set(sessionId, n);
          unread.add(sessionId);
        }
        badge();
      };
      // Dock / taskbar badge: chats that notified while dsh was in the background. Cleared when dsh is focused.
      const unread = new Set();
      const badge = () => {
        try {
          if (unread.size === 0) navigator.clearAppBadge?.()?.catch?.(() => {});
          else navigator.setAppBadge?.(unread.size)?.catch?.(() => {});
        } catch { /* badges are best-effort */ }
      };
      const onFocus = () => { if (unread.size > 0) { unread.clear(); badge(); } };
      window.addEventListener('focus', onFocus);
      // Delivered notifications stay in Notification Center until clicked; only a newer one for the same chat replaces them.
      const off = status.subscribe(notify);
      return () => { off(); window.removeEventListener('focus', onFocus); unread.clear(); badge(); };
    }

    /** Codex-style "Changes" page in the right sidebar: Uncommitted / Unstaged / Staged / Branch (vs upstream) with
     * per-file diffs from the Host half, plus "Last turn", which opens dsh's own turn review tab. */
    const CHANGES_KIND = 'composer-plus-changes';
    const CHANGES_ID = 'dsh-composer-plus/changes';
    const CHANGE_MODES = ['uncommitted', 'unstaged', 'staged', 'branch'];
    const changesUrl = (sessionId, mode) => `/api/composer-plus.changes?${new URLSearchParams({ sessionId, mode })}`;
    const diffUrl = (sessionId, mode, path) => `/api/composer-plus.diff?${new URLSearchParams({ sessionId, mode, path })}`;
    const LINE_COLORS = {
      '+': { background: 'var(--dsw-alias-state-success-tertiary, rgba(46,160,67,.15))' },
      '-': { background: 'var(--dsw-alias-state-error-tertiary, rgba(248,81,73,.15))' },
      '@': { color: 'var(--dsw-alias-label-tertiary)' },
    };
    /** Unified patch body (from the first hunk on) as rows; headers are dropped. */
    function patchRows(patch) {
      const lines = String(patch ?? '').split('\n');
      const start = lines.findIndex((l) => l.startsWith('@@'));
      return start === -1 ? [] : lines.slice(start).filter((l, i, all) => !(i === all.length - 1 && l === ''));
    }
    function ChangesDiff({ sessionId, mode, file, t }) {
      const [state, setState] = React.useState({ status: 'loading' });
      React.useEffect(() => {
        const ac = new AbortController();
        setState({ status: 'loading' });
        fetch(diffUrl(sessionId, mode, file.path), { signal: ac.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((v) => setState({ status: 'ready', value: v }), () => { if (!ac.signal.aborted) setState({ status: 'error' }); });
        return () => ac.abort();
      }, [sessionId, mode, file.path, file.added, file.deleted]);
      if (state.status === 'loading') return React.createElement('div', { style: { padding: '6px 12px', opacity: 0.7 } }, t('changes.loading'));
      if (state.status === 'error') return React.createElement('div', { style: { padding: '6px 12px' } }, t('changes.diffFailed'));
      if (file.binary) return React.createElement('div', { style: { padding: '6px 12px', opacity: 0.7 } }, t('changes.binary'));
      const rows = patchRows(state.value.patch);
      return React.createElement('pre', {
        style: { margin: 0, padding: '4px 0', overflowX: 'auto', fontFamily: 'var(--ds-font-family-code)', fontSize: 12, lineHeight: '18px' },
      }, rows.map((line, i) => React.createElement('div', { key: i, style: { padding: '0 12px', whiteSpace: 'pre', ...(LINE_COLORS[line[0]] ?? {}) } }, line === '' ? ' ' : line)),
      state.value.truncated ? React.createElement('div', { style: { padding: '4px 12px', opacity: 0.7 } }, t('changes.truncated')) : null);
    }
    function ChangesTab({ sessionId, t, openLastTurn }) {
      const [mode, setMode] = React.useState('uncommitted');
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [state, setState] = React.useState({ status: 'loading' });
      const [open, setOpen] = React.useState(() => new Set());
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const ac = new AbortController();
        setState((prev) => (prev.status === 'ready' && prev.mode === mode ? prev : { status: 'loading' }));
        fetch(changesUrl(sessionId, mode), { signal: ac.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((v) => setState({ status: 'ready', mode, value: v }), () => { if (!ac.signal.aborted) setState({ status: 'error' }); });
        return () => ac.abort();
      }, [sessionId, mode, tick]);
      // Refresh while visible: the agent edits files in the background.
      React.useEffect(() => {
        const timer = setInterval(() => { if (document.visibilityState === 'visible') setTick((n) => n + 1); }, 4000);
        return () => clearInterval(timer);
      }, []);
      const v = state.status === 'ready' ? state.value : undefined;
      const items = [
        { id: 'last-turn', label: t('changes.mode.lastTurn'), disabled: v?.lastTurn === undefined },
        { type: 'separator', id: 'sep1' },
        ...CHANGE_MODES.slice(0, 3).map((id) => ({ id, label: t(`changes.mode.${id}`) })),
        { type: 'separator', id: 'sep2' },
        { id: 'branch', label: t('changes.mode.branch') },
      ];
      const pill = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))', background: 'none', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer' };
      const trigger = React.createElement('button', { type: 'button', style: pill, 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen((x) => !x) },
        t(`changes.mode.${mode}`), React.createElement('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, '▾'));
      const header = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', flexWrap: 'wrap' } },
        primitives.Menu === undefined ? trigger : React.createElement(primitives.Menu, {
          open: menuOpen, anchor: trigger, items, selectedId: mode, selection: 'check', compact: true,
          onClose: () => setMenuOpen(false),
          onSelect: (id) => { setMenuOpen(false); if (id === 'last-turn') { if (v?.lastTurn) openLastTurn(sessionId, v.lastTurn); } else { setMode(id); setOpen(new Set()); } },
        }),
        v?.repo ? React.createElement('span', { style: { ...pill, cursor: 'default' }, title: v.root },
          v.branch ?? 'HEAD', v.upstream ? React.createElement(React.Fragment, null, React.createElement('span', { style: { opacity: 0.5 } }, '→'), v.upstream) : null) : null,
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', { type: 'button', style: { ...pill, padding: '0 8px' }, title: t('changes.refresh'), 'aria-label': t('changes.refresh'), onClick: () => setTick((n) => n + 1) }, '⟳'));
      let body;
      if (state.status === 'loading') body = React.createElement('div', { style: { padding: 16, opacity: 0.7 } }, t('changes.loading'));
      else if (state.status === 'error') body = React.createElement('div', { style: { padding: 16 } }, t('changes.failed'));
      else if (!v.repo) body = React.createElement('div', { style: { padding: 16, opacity: 0.8 } }, t('changes.noRepo'));
      else if (v.noUpstream) body = React.createElement('div', { style: { padding: 16, opacity: 0.8 } }, t('changes.noUpstream'));
      else if (v.files.length === 0) body = React.createElement('div', { style: { padding: '48px 16px', textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 500 } }, t('changes.empty')),
        React.createElement('div', { style: { opacity: 0.7, marginTop: 6 } }, t('changes.emptyHint')));
      else body = React.createElement('div', null,
        React.createElement('div', { style: { padding: '0 12px 8px', opacity: 0.8, fontSize: 13 } },
          t('changes.summary', { count: String(v.total) }), ' ',
          React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary, #2ea043)' } }, `+${v.added}`), ' ',
          React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, `-${v.deleted}`)),
        v.files.map((file) => {
          const expanded = open.has(file.path);
          const toggle = () => setOpen((prev) => { const next = new Set(prev); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; });
          return React.createElement('div', { key: file.path, style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))' } },
            React.createElement('button', { type: 'button', onClick: toggle, 'aria-expanded': expanded,
              style: { display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '6px 12px', border: 'none', background: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' } },
              React.createElement('span', { 'aria-hidden': true, style: { width: 10, opacity: 0.6 } }, expanded ? '▾' : '▸'),
              React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--ds-font-family-code)', fontSize: 12 }, title: file.from ? `${file.from} → ${file.path}` : file.path },
                file.from ? `${file.from} → ${file.path}` : file.path),
              file.untracked ? React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, t('changes.untracked')) : null,
              file.binary ? React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, t('changes.binary'))
                : React.createElement('span', { style: { fontSize: 12, whiteSpace: 'nowrap' } },
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary, #2ea043)' } }, `+${file.added}`), ' ',
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f85149)' } }, `-${file.deleted}`))),
            expanded ? React.createElement(ChangesDiff, { sessionId, mode, file, t }) : null);
        }),
        v.total > v.files.length ? React.createElement('div', { style: { padding: 12, opacity: 0.7 } }, t('changes.more', { count: String(v.total - v.files.length) })) : null);
      return React.createElement('section', { 'data-composer-plus-changes': '', style: { height: '100%', overflowY: 'auto', fontSize: 13 } }, header, body);
    }

    return {
      inject: ['slots', 'sessions', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'queue-reorder',
          order: 21,
          locale: LOCALE_NS,
          inject: (sessionId) => {
            const actx = ctx.sessions.scope(sessionId);
            const conversation = actx === undefined ? undefined : actx.get('conversation');
            return {
              updateQueue: conversation === undefined ? undefined : (itemId, action) => conversation.updateQueue(itemId, action),
              notify: (level, text) => { try { conversation.input.for(actx).notify(level, text); } catch { /* notice is best-effort */ } },
            };
          },
        }, QueueReorder));
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'composer-plan-toggle',
          order: 999,
          inject: (sessionId) => {
            const commands = ctx.remote === undefined ? undefined : ctx.remote.commands;
            const actx = ctx.sessions === undefined ? undefined : ctx.sessions.scope(sessionId);
            return {
              exitPlanMode: commands === undefined ? undefined : async () => {
                const result = await commands.execute(sessionId, '/plan off', []);
                if (!result.ok) return `${result.error.message} (${result.error.code})`;
                return result.value === undefined ? 'unknown command: /plan off' : null;
              },
              notify: (level, text) => { try { actx.get('conversation').input.for(actx).notify(level, text); } catch { /* notice is best-effort */ } },
            };
          },
        }, PlanToggle));
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'composer-continue',
          order: 1000,
          locale: LOCALE_NS,
        }, ContinueButton));
        if (ctx.locale !== undefined) ctx.effect(() => ctx.locale.register(LOCALE_NS, {
          en: {
            'continue.label': 'Continue',
            'continue.message': 'continue',
            'queue.drag': 'Drag to reorder (or ↑/↓)',
            'queue.locked': 'Messages with images/files cannot be moved',
            'queue.grip': 'Reorder queued message',
            'queue.failed': 'Reorder failed: a message may have already started sending.',
            copyDeeplink: 'Copy deeplink',
            allowChat: 'Allow for this chat',
            allowChatTitle: 'Allow {toolName} without asking for the rest of this chat, with any arguments. If the tool can write, that includes any write.',
            grants: '{count} tool(s) allowed · Revoke',
            grantsTitle: 'Allowed in this chat without asking:\n{tools}\nClick to revoke all.',
            'notify.done': 'Finished.',
            'notify.approval': 'Waiting for your approval.',
            'notify.question': 'Has a question for you.',
            'notify.planReview': 'Plan ready for review.',
            'notify.approvalTool': 'Approve {tool}?',
            'notify.questionText': 'Question: {text}',
            'changes.title': 'Changes',
            'changes.guide': 'Changes',
            'changes.guideDescription': 'Uncommitted, staged and branch changes of this chat\'s repository',
            'changes.mode.lastTurn': 'Last Turn',
            'changes.mode.uncommitted': 'Uncommitted',
            'changes.mode.unstaged': 'Unstaged',
            'changes.mode.staged': 'Staged',
            'changes.mode.branch': 'Branch',
            'changes.loading': 'Loading…',
            'changes.failed': 'Could not read changes.',
            'changes.diffFailed': 'Could not load this diff.',
            'changes.noRepo': 'This chat\'s folder is not a git repository.',
            'changes.noUpstream': 'This branch has no upstream to compare with.',
            'changes.empty': 'No file changes yet',
            'changes.emptyHint': 'Changes in this project will appear here.',
            'changes.summary': '{count} file(s)',
            'changes.untracked': 'new',
            'changes.binary': 'binary',
            'changes.truncated': 'Diff truncated.',
            'changes.more': '{count} more file(s) not shown',
            'changes.refresh': 'Refresh',
          },
          zh: {
            'continue.label': '继续',
            'continue.message': '继续',
            'queue.drag': '拖动以排序（或按 ↑/↓）',
            'queue.locked': '含图片或文件的消息无法移动',
            'queue.grip': '调整排队消息顺序',
            'queue.failed': '排序失败：某条消息可能已开始发送。',
            copyDeeplink: '复制深层链接',
            allowChat: '本对话内允许',
            allowChatTitle: '本对话剩余时间内，{toolName} 的任何参数调用都无需再询问。若该工具可写入，也包括任何写入操作。',
            grants: '已允许 {count} 个工具 · 撤销',
            grantsTitle: '本对话内无需询问即可使用：\n{tools}\n点击撤销全部。',
            'notify.done': '已完成。',
            'notify.approval': '等待你的批准。',
            'notify.question': '有问题需要你回答。',
            'notify.planReview': '计划已就绪，等待审阅。',
            'notify.approvalTool': '是否批准 {tool}？',
            'notify.questionText': '问题：{text}',
            'changes.title': '改动',
            'changes.guide': '改动',
            'changes.guideDescription': '查看本对话仓库的未提交、已暂存和分支改动',
            'changes.mode.lastTurn': '上一轮',
            'changes.mode.uncommitted': '未提交',
            'changes.mode.unstaged': '未暂存',
            'changes.mode.staged': '已暂存',
            'changes.mode.branch': '分支',
            'changes.loading': '加载中…',
            'changes.failed': '无法读取改动。',
            'changes.diffFailed': '无法加载此差异。',
            'changes.noRepo': '本对话的目录不是 git 仓库。',
            'changes.noUpstream': '当前分支没有可比较的上游分支。',
            'changes.empty': '暂无文件改动',
            'changes.emptyHint': '本项目的改动会显示在这里。',
            'changes.summary': '{count} 个文件',
            'changes.untracked': '新',
            'changes.binary': '二进制',
            'changes.truncated': '差异已截断。',
            'changes.more': '还有 {count} 个文件未显示',
            'changes.refresh': '刷新',
          },
        }), 'dsh-composer-plus: dictionaries');
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'chat-tool-grants',
          order: 0,
          locale: LOCALE_NS,
        }, ChatToolGrants));
        if (ctx.inject !== undefined) ctx.inject(['uiSession', 'uiWorkspace', 'sessions'], (scope) => {
          const t = ctx.locale.bind(LOCALE_NS);
          scope.effect(() => watchAttention(scope.uiSession.sessionStatus, scope.sessions.list, t,
            (sessionId) => scope.uiWorkspace.openSession(sessionId)), 'dsh-composer-plus: attention notifications');
          // First use asks the OS once; a denied permission stays denied (re-enable it in System Settings).
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        });
        if (ctx.inject !== undefined) ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const t = ctx.locale.bind(LOCALE_NS);
          scope.effect(() => scope.sidebarRightTabs.register({
            id: CHANGES_ID,
            kind: CHANGES_KIND,
            priority: 'extension',
            title: () => t('changes.title'),
            guide: [{ id: 'open', order: 25, title: () => t('changes.guide'), description: () => t('changes.guideDescription'),
              ...(primitives.GuideArtworkFiles === undefined ? {} : { icon: primitives.GuideArtworkFiles }) }],
          }), 'dsh-composer-plus: changes tab type');
          scope.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: CHANGES_ID,
            locale: LOCALE_NS,
            inject: () => ({
              // "Last turn" reuses dsh's own changes-review tab for the newest recorded turn.
              openLastTurn: (sessionId, { seq, turn }) => scope.sidebarRight.openResource(`dsh-resource://changes-review/session/${encodeURIComponent(sessionId)}/${seq}/${turn}`),
            }),
          }, ChangesTab)), 'dsh-composer-plus: changes tab body');
        });
        if (ctx.inject !== undefined) ctx.inject(['uiSession'], (scope) => {
          const status = scope.uiSession.sessionStatus;
          // Deferred so answering never re-enters the status notification that triggered it.
          const scan = () => { queueMicrotask(() => answerGranted(status.getSnapshot())); };
          scope.effect(() => {
            const offStatus = status.subscribe(scan);
            const offGrants = subscribeGrants(scan);
            scan();
            return () => { offStatus(); offGrants(); };
          }, 'dsh-composer-plus: chat tool grants');
        });
        if (ctx.effect !== undefined) ctx.effect(() => () => { grants.clear(); grantsChanged(); }, 'dsh-composer-plus: forget grants on unload');
        if (typeof fetch === 'function') loadGrants();
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'copy-deeplink',
          order: 350,
          locale: LOCALE_NS,
        }, CopyDeeplinkItem));
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'session-context-menu',
          order: 0,
        }, RowContextMenu));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'composer-history',
          order: 20,
        }, ComposerHistory));
      },
    };
  },
});
