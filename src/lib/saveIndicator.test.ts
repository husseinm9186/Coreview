import { describe, expect, it } from 'vitest';

import { SAVE_ACK_MS, saveIndicator } from './saveIndicator';

const T = 1_700_000_000_000;

describe('what the save indicator says (LT-380)', () => {
  it('acknowledges a save a person asked for', () => {
    // The complaint: pressing Save on a document that was already saved
    // changed nothing on screen, so the button looked dead. It is the
    // acknowledgement, not the timestamp, that answers the press.
    expect(saveIndicator({ dirty: false, lastSavedAt: T, savedAck: T, now: T })).toEqual({
      label: 'Saved',
      tone: 'acknowledged',
      at: null,
    });
  });

  it('settles back to the timestamp once the acknowledgement is stale', () => {
    const later = T + SAVE_ACK_MS + 1;
    expect(saveIndicator({ dirty: false, lastSavedAt: T, savedAck: T, now: later })).toEqual({
      label: 'Saved',
      tone: 'idle',
      at: T,
    });
  });

  it('says nothing green for a save nobody asked for', () => {
    // Autosave runs every 2.5s while there are edits. If it flashed too, the
    // flash would stop meaning "your press landed" and start meaning nothing.
    expect(saveIndicator({ dirty: false, lastSavedAt: T, savedAck: null, now: T })).toEqual({
      label: 'Saved',
      tone: 'idle',
      at: T,
    });
  });

  it('an edit made after the save wins over the acknowledgement', () => {
    // Save, then type one character. The document is unsaved again, and
    // saying so matters more than confirming a save two hundred ms ago.
    expect(saveIndicator({ dirty: true, lastSavedAt: T, savedAck: T, now: T + 200 })).toEqual({
      label: 'Unsaved changes',
      tone: 'dirty',
      at: null,
    });
  });

  it('a project that has never been saved carries no timestamp', () => {
    expect(saveIndicator({ dirty: false, lastSavedAt: null, savedAck: null, now: T })).toEqual({
      label: 'Saved',
      tone: 'idle',
      at: null,
    });
  });

  it('is not confused by a clock that has gone backwards', () => {
    // The machine's clock can be corrected under a running session. An
    // acknowledgement stamped in the future is not fresh for hours; it is
    // simply not something to believe.
    expect(saveIndicator({ dirty: false, lastSavedAt: T, savedAck: T + 60_000, now: T }).tone)
      .toBe('idle');
  });
});
