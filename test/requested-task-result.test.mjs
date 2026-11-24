// The result of a task that the user asked for in this chat is not news (2026-11-23): Damon writes it in its own reply,
// first line in bold, never in a reply about another topic, never as only `[quiet]`. A sub-step, an interim report or a
// review round that Damon started is still news. Three prompt texts say it: the to-do rule, the News rule of the status
// panel and the news note with cards. The other behavior stays (a finished task is news for the Done today card).
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { STATUS_SECTION, TODO_SECTION, assistantNewsNote } from '../index.js';

const exception = /when the work that ended is a task that the user asked for in this chat, it is not news\. Write its result in its own reply\. The first line of that reply is the result in bold\. Do not add the result to a reply about another topic, and do not reply with only `\[quiet\]`\. A sub-step, an interim report or a review round that you started is still news\./;
const approval = /put its line after the bold result line\./;
const item = { id: 'a', title: 'T', project: 'p', at: 1, kind: 'finished', task: true };

assert.match(TODO_SECTION, exception, 'to-do rule');
assert.match(STATUS_SECTION, exception, 'status panel News rule');
assert.match(assistantNewsNote([item]), exception, 'news note with cards');
// A new approval or a live risk in the same turn goes after the bold result line (news note and News rule).
assert.match(assistantNewsNote([item]), /When the same turn also has a new approval or a live risk, put its line after the bold result line\./);
assert.match(STATUS_SECTION, /When the same turn also has a new approval or a live risk, put its line after the bold result line\./);
// Without cards the note keeps its earlier rule, without the card exception.
assert.doesNotMatch(assistantNewsNote([item], 10, { cards: false }), exception);
assert.doesNotMatch(assistantNewsNote([item], 10, { cards: false }), approval);
// The exception stands in the rule that says "do not write it in the chat", and the user's request still comes first.
assert.match(TODO_SECTION, /so do not write it in the chat\. Exception: when the work/);
assert.match(STATUS_SECTION, /or a new error or risk on a live system\.[^\n]*Exception: when the work[^\n]*A request of the user in this chat comes before this rule\./);
console.log('requested-task-result ok');
