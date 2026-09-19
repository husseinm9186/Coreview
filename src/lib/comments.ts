/**
 * Threaded comments on devices and links (LT-239): "who changed this port?",
 * "confirm the uplink is fibre before Saturday" — a question on the thing it is
 * about, answered where it was asked, kept with the project.
 *
 * A thread has a first comment and replies, and is resolved when it is done
 * rather than deleted, so the record of the question stays. Pure functions over
 * the thread list; the object's data holds it.
 */
export interface CommentReply {
  id: string;
  author: string;
  at: number;
  text: string;
}

export interface CommentThread extends CommentReply {
  resolved: boolean;
  replies: CommentReply[];
}

const clean = (text: string) => text.trim().slice(0, 4000);
const who = (author: string) => author.trim().slice(0, 80) || 'Someone';

export function addThread(threads: readonly CommentThread[] | undefined, author: string, text: string, at: number, id: string): CommentThread[] {
  const t = clean(text);
  if (!t) return [...(threads ?? [])];
  return [...(threads ?? []), { id, author: who(author), at, text: t, resolved: false, replies: [] }];
}

export function addReply(threads: readonly CommentThread[] | undefined, threadId: string, author: string, text: string, at: number, id: string): CommentThread[] {
  const t = clean(text);
  return (threads ?? []).map((th) =>
    th.id === threadId && t ? { ...th, resolved: false, replies: [...th.replies, { id, author: who(author), at, text: t }] } : th,
  );
}

export function setResolved(threads: readonly CommentThread[] | undefined, threadId: string, resolved: boolean): CommentThread[] {
  return (threads ?? []).map((th) => (th.id === threadId ? { ...th, resolved } : th));
}

export function openThreads(threads: readonly CommentThread[] | undefined): number {
  return (threads ?? []).filter((t) => !t.resolved).length;
}
