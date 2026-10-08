//! Turning a terminal stream into a file worth reading.
//!
//! A session log is asked for so that what happened on a device can be read
//! back, diffed against a backup, or attached to a change record. What comes
//! off the wire is not that: it is a terminal stream, full of escape sequences
//! the device uses to colour, move the cursor and redraw a line while it is
//! being typed. Written to a file verbatim it is unreadable in an editor and
//! useless to `diff`.
//!
//! So the log is the text with the control sequences taken out. The terminal
//! on screen still gets every byte — this only shapes what is written down.
//!
//! **It is stateful on purpose.** A chunk off the network can end anywhere,
//! including halfway through an escape sequence, so what is in hand at the end
//! of one chunk has to be remembered for the next. Written as a struct with a
//! tiny state machine rather than a regular expression over a whole buffer,
//! which is what makes it correct at chunk boundaries and testable at them.

/// Where the machine is between bytes of a sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Ordinary text.
    Text,
    /// An `ESC` was seen; the next byte says what kind of sequence it is.
    Escape,
    /// Inside `ESC [ … final`, a control sequence — colour, cursor moves.
    Csi,
    /// Inside `ESC ] … BEL` or `ESC ] … ESC \`, usually the window title.
    Osc,
    /// Inside an OSC and an `ESC` has been seen: a `\` ends it.
    OscEscape,
    /// Inside a two-byte sequence whose second byte is a character set, e.g.
    /// `ESC ( B`.
    Charset,
}

/// Strips terminal control sequences from a byte stream, chunk by chunk.
#[derive(Debug, Default)]
pub struct SessionLog {
    state: Option<State>,
    /// A `\r` is held back until the next byte is known: `\r\n` is a line
    /// ending and becomes one `\n`, while a bare `\r` is a device redrawing
    /// the line it is on and there is nothing worth keeping before it.
    pending_cr: bool,
}

impl SessionLog {
    pub fn new() -> Self {
        Self {
            state: Some(State::Text),
            pending_cr: false,
        }
    }

    /// The readable part of one chunk. What is left mid-sequence is kept for
    /// the next call.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        let mut state = self.state.unwrap_or(State::Text);
        for &b in bytes {
            state = match state {
                State::Text => match b {
                    0x1b => State::Escape,
                    b'\r' => {
                        // Held: the next byte decides whether it was a line
                        // ending or a redraw.
                        self.pending_cr = true;
                        State::Text
                    }
                    _ => {
                        if self.pending_cr {
                            self.pending_cr = false;
                            // A bare `\r` means the device is rewriting the
                            // line; keep the newer text and drop the older.
                            if b != b'\n' {
                                while out.last().is_some_and(|&c| c != b'\n') {
                                    out.pop();
                                }
                            }
                        }
                        // Backspace is the device erasing what it just echoed.
                        if b == 0x08 {
                            if out.last().is_some_and(|&c| c != b'\n') {
                                out.pop();
                            }
                        } else if b == b'\n' || b == b'\t' || b >= 0x20 {
                            out.push(b);
                        }
                        State::Text
                    }
                },
                State::Escape => match b {
                    b'[' => State::Csi,
                    b']' => State::Osc,
                    b'(' | b')' | b'*' | b'+' => State::Charset,
                    // Anything else is a complete two-byte escape.
                    _ => State::Text,
                },
                // A CSI runs until a byte in the range `@`..`~`.
                State::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        State::Text
                    } else {
                        State::Csi
                    }
                }
                State::Osc => match b {
                    0x07 => State::Text,
                    0x1b => State::OscEscape,
                    _ => State::Osc,
                },
                State::OscEscape => {
                    if b == b'\\' {
                        State::Text
                    } else {
                        State::Osc
                    }
                }
                State::Charset => State::Text,
            };
        }
        self.state = Some(state);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::SessionLog;

    fn text(log: &mut SessionLog, s: &str) -> String {
        String::from_utf8(log.feed(s.as_bytes())).unwrap()
    }

    #[test]
    fn plain_output_comes_through_untouched() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "SW-A#show version\nCisco IOS\n"), "SW-A#show version\nCisco IOS\n");
    }

    #[test]
    fn colour_is_taken_out_and_the_words_kept() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "\x1b[31mdown\x1b[0m\n"), "down\n");
    }

    #[test]
    fn a_sequence_split_across_two_chunks_is_still_removed() {
        // The whole reason this is a state machine: a chunk off the network
        // ends where TCP says it does, not where a sequence does.
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "up \x1b["), "up ");
        assert_eq!(text(&mut log, "32mgood\x1b[0m\n"), "good\n");
    }

    #[test]
    fn a_window_title_is_not_part_of_the_transcript() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "\x1b]0;SW-A\x07ready\n"), "ready\n");
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "\x1b]0;SW-A\x1b\\ready\n"), "ready\n");
    }

    #[test]
    fn crlf_becomes_one_line_ending() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "one\r\ntwo\r\n"), "one\ntwo\n");
    }

    #[test]
    fn a_line_the_device_redrew_is_kept_once_in_its_final_form() {
        // A pager or a progress line writes, returns to column one and writes
        // again. Keeping both leaves a log full of half-drawn lines.
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "loading...\rdone\n"), "done\n");
    }

    #[test]
    fn a_backspace_rubs_out_what_it_was_meant_to() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "show verison\x08\x08\x08\x08sion\n"), "show version\n");
    }

    #[test]
    fn other_control_bytes_are_dropped_but_tabs_are_not() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "a\x00b\tc\x07\n"), "ab\tc\n");
    }

    #[test]
    fn utf8_survives_because_only_control_bytes_are_looked_at() {
        let mut log = SessionLog::new();
        assert_eq!(text(&mut log, "café — ½\n"), "café — ½\n");
    }
}
