/**
 * dsh-composer-plus: composer history (ArrowUp/ArrowDown), a one-click Continue button,
 * and drag-and-drop reordering of queued messages. Client half only; no Host state.
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

    const CONTINUE_TEXT = 'continue';
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
    function ContinueButton({ useSession, useInput, inputActions }) {
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
        if (React.flushSync !== undefined) React.flushSync(() => inputActions.setDraft(CONTINUE_TEXT));
        else inputActions.setDraft(CONTINUE_TEXT);
        inputActions.submit();
      };
      const button = React.createElement('button', {
        type: 'button',
        className: host.className,
        title: 'Continue',
        'aria-label': 'Continue',
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
    function QueueReorder({ useSession, useProjection, updateQueue, notify }) {
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
          notify('error', 'Reorder failed: a message may have already started sending.');
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
          title: draggable ? 'Drag to reorder (or ↑/↓)' : 'Messages with images/files cannot be moved',
          'aria-label': 'Reorder queued message',
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

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'queue-reorder',
          order: 21,
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
          id: 'composer-continue',
          order: 1000,
        }, ContinueButton));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'composer-history',
          order: 20,
        }, ComposerHistory));
      },
    };
  },
});
