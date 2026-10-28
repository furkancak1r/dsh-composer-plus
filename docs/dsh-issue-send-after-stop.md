# dsh issue: after Stop, a new message runs after the whole queue, and an older queued message runs instead

## Summary

When you stop a chat that has queued messages and then send a new message, dsh adds the new message at the end of the `next-turn` queue. The turn that the new message wakes claims the queue head. So the first queued message runs, not the message that you just sent. The new message runs only after all the queued messages.

The chat view shows the new message as sent (a transcript echo) next to the first queued message. To the user, it looks as if more than one message went at the same time, and the queue order looks broken.

## Steps to reproduce

1. Start a turn in a chat. While it runs, send five messages (busy Enter = Queue). They wait in the queue.
2. Click Stop. The turn ends as `aborted` (`{kind: 'user'}`), and the queue stays (`keepInbox: true`).
3. Type a sixth message and send it at once.

Expected: the sixth message runs now, alone. The five queued messages keep their order and run after it.

Actual: the next turn runs queued message 1. The sixth message waits at the end of the queue and runs last.

Seen on dsh 0.2.0-rc.2, 0.2.1-rc.2 and 0.2.1-rc.3 (desktop 0.2.1-rc.3), with no plugins (`@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` only) and a fake OpenAI-compatible model. The same code is in 0.2.1-rc.4 and 0.2.2-alpha.2.

## Cause (`@deepseek-ai/dsh-agent-loop`)

- `ReactLoopAgent.send(message, target, wakeup)` appends the message: `this.inbox.splice(resolvedTarget, Infinity, 0, [message])`. When the stopped turn still ends (`wakingAfterAbort`), the target is also `next-turn`.
- When the agent is idle, `wakeDriver()` opens a turn, and `preStep('next-turn')` calls `inbox.claim('next-turn')`. This takes the next-step messages plus `next-turn[0]`, which is the oldest queued message.

The two rules are correct while a turn runs. After Stop, the user expects the message that they send to be the next turn.

## Suggested fix

When `send` wakes an idle (or stopped) agent for a user prompt and other messages wait in `next-turn`, insert the new message at index 0 (or let the turn claim the message that woke it). Keep the append for a message that a running turn queues.

## Workaround

dsh-composer-plus has the feature "Send after Stop goes first" (on by default, from the next release). It moves the new message to the head of the queue in an `agent/inbox/inserted` listener, before the turn opens.
