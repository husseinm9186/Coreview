/**
 * A promise nobody caught reaches the status bar (LT-450).
 *
 * Twenty-nine `void ipc.…` calls fire and forget, and a rejected one used to
 * be logged to a console the bundle has no window for. This turns the
 * reason into one line for the status bar — the message of an `Error`, the
 * text of a string, and a plain description of anything else — so a call
 * that failed is at least seen. It never throws, whatever it is handed.
 */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name || 'Something failed.';
  if (typeof reason === 'string') return reason.trim() || 'Something failed.';
  if (reason && typeof reason === 'object') {
    const o = reason as { message?: unknown };
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim();
    try {
      const text = JSON.stringify(reason);
      if (text && text !== '{}') return text.slice(0, 200);
    } catch {
      // A cyclic object: fall through to the plain description.
    }
  }
  return 'Something failed.';
}

/** Installs the window handler; returns what removes it. `report` receives
 *  the one-line description and decides where it goes. */
export function watchUnhandled(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, report: (line: string) => void): () => void {
  const onRejection = (e: Event) => {
    const reason = (e as PromiseRejectionEvent).reason;
    report(describeRejection(reason));
  };
  target.addEventListener('unhandledrejection', onRejection);
  return () => target.removeEventListener('unhandledrejection', onRejection);
}
