import { describe, expect, it } from 'vitest';

import { addReply, addThread, openThreads, setResolved } from './comments';

describe('comments (LT-239)', () => {
  it('starts a thread, replies to it, resolves it, and a reply reopens it', () => {
    let t = addThread(undefined, 'Sam', '  Is Gi0/1 fibre?  ', 1, 't1');
    expect(t).toEqual([{ id: 't1', author: 'Sam', at: 1, text: 'Is Gi0/1 fibre?', resolved: false, replies: [] }]);
    t = addReply(t, 't1', 'Alex', 'Yes, SMF', 2, 'r1');
    expect(t[0]!.replies).toEqual([{ id: 'r1', author: 'Alex', at: 2, text: 'Yes, SMF' }]);
    t = setResolved(t, 't1', true);
    expect(openThreads(t)).toBe(0);
    t = addReply(t, 't1', 'Sam', 'Actually, check the patch lead', 3, 'r2');
    expect(t[0]!.resolved).toBe(false);
    expect(openThreads(t)).toBe(1);
  });

  it('ignores empty text and names an unnamed author', () => {
    expect(addThread([], 'x', '   ', 1, 't')).toEqual([]);
    expect(addThread([], '  ', 'hello', 1, 't')[0]!.author).toBe('Someone');
    expect(addReply([{ id: 't', author: 'a', at: 0, text: 'q', resolved: true, replies: [] }], 't', 'b', '', 1, 'r')[0]!.replies).toEqual([]);
  });
});
