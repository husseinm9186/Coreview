//! The device's screen, kept the way a terminal keeps it (LT-383).
//!
//! A network device does not print lines. It draws a screen: clear it, set a
//! scroll region, move the cursor, overwrite in place, ask how big the
//! terminal is, repaint. Read as a stream of text with some noise in it, that
//! is unintelligible — a prompt can arrive, be followed by a repaint, and the
//! last byte of the buffer is then the tail of an escape sequence rather than
//! the `#` that says the device is ready.
//!
//! That is exactly what happened on an Aruba 2930M, four times: the prompt was
//! drawn on every attempt and recognised on none of them, because
//! `cli::find_prompt` judged the raw buffer. Answering one more escape
//! sequence each round was never going to reach the end of that.
//!
//! So the bytes are applied to a grid, and the prompt is read off the rendered
//! screen — which is what PuTTY does, and why PuTTY could always log into the
//! switch this crawler could not.
//!
//! **The escape parser is lifted from [`crate::sessionlog`]**, which has had a
//! correct, chunk-boundary-safe one since LT-324 and was only ever pointed at
//! the terminal's log file. The state machine is the same; what changes is
//! what each sequence *does* — applied to the grid here, discarded there.
//!
//! **It is stateful on purpose.** A chunk off the network can end anywhere,
//! including halfway through a sequence, so what is in hand at the end of one
//! chunk is remembered for the next.
//!
//! What this is not: a terminal emulator. There is no colour, no alternate
//! buffer, no scrollback, no character sets. It exists to answer one question
//! — *has the device finished talking, and what does the line under the cursor
//! say* — and everything it does not need, it consumes and throws away.

/// Where the machine is between bytes of a sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Ordinary text.
    Text,
    /// An `ESC` was seen; the next byte says what kind of sequence it is.
    Escape,
    /// Inside `ESC [ … final`, a control sequence.
    Csi,
    /// Inside `ESC ] … BEL` or `ESC ] … ESC \`, usually the window title.
    Osc,
    /// Inside an OSC and an `ESC` has been seen: a `\` ends it.
    OscEscape,
    /// Inside a two-byte sequence whose second byte is a character set.
    Charset,
}

/// A device's screen, as a terminal would keep it.
///
/// Rows and columns are 1-based everywhere they are visible from outside,
/// because that is what the escape sequences use and reading the two
/// conventions against each other is how off-by-one bugs get written.
#[derive(Debug)]
pub struct Screen {
    rows: u16,
    cols: u16,
    /// `rows` rows of `cols` cells.
    grid: Vec<Vec<char>>,
    /// 1-based, and may sit one past the last column while waiting to wrap.
    row: u16,
    col: u16,
    /// The scrolling region, 1-based and inclusive (`DECSTBM`).
    top: u16,
    bottom: u16,
    state: State,
    /// The bytes of the CSI currently being read, without the `ESC [`.
    params: String,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1);
        let cols = cols.max(1);
        Self {
            rows,
            cols,
            grid: vec![vec![' '; cols as usize]; rows as usize],
            row: 1,
            col: 1,
            top: 1,
            bottom: rows,
            state: State::Text,
            params: String::new(),
        }
    }

    /// Applies one chunk to the screen, and returns whatever the device is
    /// owed in reply.
    ///
    /// The only reply there is: a cursor-position report. A device that wants
    /// to know how big the terminal is drives the cursor past the end of any
    /// real screen and asks where it landed, and it will not draw a prompt
    /// until it is told. D-054 permits answering it — nothing is decided,
    /// nothing runs, and no person is being addressed.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut replies = Vec::new();
        for &b in bytes {
            match self.state {
                State::Text => self.text_byte(b),
                State::Escape => {
                    self.state = match b {
                        b'[' => {
                            self.params.clear();
                            State::Csi
                        }
                        b']' => State::Osc,
                        b'(' | b')' | b'*' | b'+' => State::Charset,
                        // `ESC D` and `ESC M` move a line without moving the
                        // column; everything else two-byte is not ours.
                        b'D' => {
                            self.line_feed();
                            State::Text
                        }
                        b'M' => {
                            self.reverse_line_feed();
                            State::Text
                        }
                        _ => State::Text,
                    };
                }
                // A CSI runs until a byte in the range `@`..`~`.
                State::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.control(b as char, &mut replies);
                        self.state = State::Text;
                    } else {
                        self.params.push(b as char);
                    }
                }
                State::Osc => {
                    self.state = match b {
                        0x07 => State::Text,
                        0x1b => State::OscEscape,
                        _ => State::Osc,
                    };
                }
                State::OscEscape => {
                    self.state = if b == b'\\' { State::Text } else { State::Osc };
                }
                State::Charset => self.state = State::Text,
            }
        }
        replies
    }

    /// Every row, right-trimmed. The index is the row number minus one.
    pub fn lines(&self) -> Vec<String> {
        self.grid
            .iter()
            .map(|r| r.iter().collect::<String>().trim_end().to_string())
            .collect()
    }

    /// The row the cursor is sitting on, right-trimmed.
    ///
    /// This is where a prompt is, by definition: a device draws its prompt and
    /// leaves the cursor after it, waiting for typing. It is a far better
    /// place to look than the last non-empty row, which on a painted screen
    /// may be part of a banner further down.
    pub fn cursor_line(&self) -> String {
        let row = (self.row.min(self.rows) - 1) as usize;
        self.grid[row].iter().collect::<String>().trim_end().to_string()
    }

    /// The cursor, 1-based, as `(row, column)`.
    pub fn cursor(&self) -> (u16, u16) {
        (self.row.min(self.rows), self.col.min(self.cols))
    }

    // --- the text path ------------------------------------------------------

    fn text_byte(&mut self, b: u8) {
        match b {
            0x1b => self.state = State::Escape,
            b'\r' => self.col = 1,
            b'\n' => self.line_feed(),
            // Backspace moves; it does not erase. A device that means to erase
            // sends the space and the second backspace itself.
            0x08 => self.col = self.col.saturating_sub(1).max(1),
            b'\t' => {
                let next = ((self.col - 1) / 8 + 1) * 8 + 1;
                self.col = next.min(self.cols);
            }
            // Control characters that are not movement paint nothing. A bell
            // in a banner must not become a character on the screen.
            b if b < 0x20 || b == 0x7f => {}
            b => self.put(b as char),
        }
    }

    fn put(&mut self, c: char) {
        if self.col > self.cols {
            // The previous character filled the last column and the cursor has
            // been waiting at the edge; this one starts the next line.
            self.col = 1;
            self.line_feed();
        }
        let (r, c_idx) = ((self.row - 1) as usize, (self.col - 1) as usize);
        self.grid[r][c_idx] = c;
        self.col += 1;
    }

    fn line_feed(&mut self) {
        if self.row == self.bottom {
            self.scroll_up();
        } else if self.row < self.rows {
            self.row += 1;
        }
    }

    fn reverse_line_feed(&mut self) {
        if self.row == self.top {
            self.scroll_down();
        } else if self.row > 1 {
            self.row -= 1;
        }
    }

    fn scroll_up(&mut self) {
        let (t, b) = ((self.top - 1) as usize, (self.bottom - 1) as usize);
        self.grid[t..=b].rotate_left(1);
        self.blank_row(b);
    }

    fn scroll_down(&mut self) {
        let (t, b) = ((self.top - 1) as usize, (self.bottom - 1) as usize);
        self.grid[t..=b].rotate_right(1);
        self.blank_row(t);
    }

    fn blank_row(&mut self, row: usize) {
        self.grid[row].fill(' ');
    }

    // --- the control path ---------------------------------------------------

    /// One CSI parameter, or `default` when it was left out or empty.
    fn param(&self, at: usize, default: u16) -> u16 {
        self.params
            .split(';')
            .nth(at)
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|n| *n > 0 || default == 0)
            .unwrap_or(default)
    }

    fn control(&mut self, final_byte: char, replies: &mut Vec<u8>) {
        // A private sequence — `ESC [ ? … ` — is a mode change: cursor
        // visibility, autowrap, origin mode. None of them change what the text
        // says, and `ESC [ ? 6 n` is a different question from `ESC [ 6 n`,
        // which is why the marker is checked before anything else.
        if self.params.starts_with('?') || self.params.starts_with('>') {
            return;
        }
        match final_byte {
            'H' | 'f' => {
                self.row = self.param(0, 1).clamp(1, self.rows);
                self.col = self.param(1, 1).clamp(1, self.cols);
            }
            'A' => self.row = self.row.saturating_sub(self.param(0, 1)).max(1),
            'B' => self.row = (self.row + self.param(0, 1)).min(self.rows),
            'C' => self.col = (self.col + self.param(0, 1)).min(self.cols),
            'D' => self.col = self.col.saturating_sub(self.param(0, 1)).max(1),
            'E' => {
                self.row = (self.row + self.param(0, 1)).min(self.rows);
                self.col = 1;
            }
            'F' => {
                self.row = self.row.saturating_sub(self.param(0, 1)).max(1);
                self.col = 1;
            }
            'G' => self.col = self.param(0, 1).clamp(1, self.cols),
            'd' => self.row = self.param(0, 1).clamp(1, self.rows),
            'J' => self.erase_display(self.param(0, 0)),
            'K' => self.erase_line(self.param(0, 0)),
            'r' => {
                let top = self.param(0, 1).clamp(1, self.rows);
                let bottom = self.param(1, self.rows).clamp(1, self.rows);
                if top < bottom {
                    self.top = top;
                    self.bottom = bottom;
                    // Setting the region homes the cursor, which is what puts
                    // a device's first line where it expects it.
                    self.row = top;
                    self.col = 1;
                }
            }
            'S' => {
                for _ in 0..self.param(0, 1) {
                    self.scroll_up();
                }
            }
            'T' => {
                for _ in 0..self.param(0, 1) {
                    self.scroll_down();
                }
            }
            // The cursor-position report, and only that one. `ESC [ 5 n` asks
            // after the device's health and is left alone.
            'n' if self.params == "6" => {
                let (r, c) = self.cursor();
                replies.extend_from_slice(format!("\x1b[{r};{c}R").as_bytes());
            }
            // Colour, and everything else that does not move or erase.
            _ => {}
        }
    }

    fn erase_display(&mut self, how: u16) {
        let last = (self.rows - 1) as usize;
        let here = (self.row.min(self.rows) - 1) as usize;
        match how {
            // To the end of the screen, this line included from the cursor on.
            0 => {
                self.erase_line(0);
                for r in here + 1..=last {
                    self.blank_row(r);
                }
            }
            1 => {
                self.erase_line(1);
                for r in 0..here {
                    self.blank_row(r);
                }
            }
            // The whole screen. The cursor does not move: a device that wants
            // it home says so with the `ESC [ 1 ; 1 H` that usually follows.
            _ => {
                for r in 0..=last {
                    self.blank_row(r);
                }
            }
        }
    }

    fn erase_line(&mut self, how: u16) {
        let r = (self.row.min(self.rows) - 1) as usize;
        let here = (self.col.min(self.cols) - 1) as usize;
        let last = (self.cols - 1) as usize;
        let range = match how {
            0 => here..=last,
            1 => 0..=here,
            _ => 0..=last,
        };
        for c in range {
            self.grid[r][c] = ' ';
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 200x200 screen, the size the crawl's pty actually asks for.
    fn screen() -> Screen {
        Screen::new(200, 200)
    }

    fn feed(s: &mut Screen, text: &str) -> Vec<u8> {
        s.feed(text.as_bytes())
    }

    /// LT-383, and the whole reason for this module. These are the bytes the
    /// production Aruba sent, in the order it sent them, taken from the
    /// failure the LT-379 build reported.
    const ARUBA_MEASURING: &str = concat!(
        "\x1b[13;1H\x1b[?25h\x1b[200;27H\x1b[?6l\x1b[1;200r\x1b[?7h",
        "\x1b[2J\x1b[1;1H",
        "\x1b[1920;1920H\x1b[6n",
        "\x1b[1;1HYour previous successful login",
    );

    #[test]
    fn the_measurement_is_answered_from_where_the_cursor_really_is() {
        let mut s = screen();
        let reply = feed(&mut s, ARUBA_MEASURING);
        // Driven to 1920;1920 on a 200x200 screen, the cursor is in the far
        // corner, and the clamped position is the size the device asked for.
        assert_eq!(reply, b"\x1b[200;200R");
        // And the screen shows what a person would have seen.
        assert_eq!(s.lines()[0], "Your previous successful login");
        assert_eq!(s.cursor(), (1, 31));
    }

    #[test]
    fn clearing_the_screen_clears_what_came_before() {
        let mut s = screen();
        feed(&mut s, "old banner text\r\nand more of it\r\n");
        assert_eq!(s.lines()[0], "old banner text");
        feed(&mut s, "\x1b[2J");
        assert_eq!(s.lines()[0], "");
        assert_eq!(s.lines()[1], "");
    }

    #[test]
    fn a_screen_painted_by_cursor_positioning_has_real_lines() {
        // This is the case `buffer.lines()` could never see: the device emits
        // no newlines at all, it positions the cursor. Read as a stream it is
        // one enormous line; rendered, it is three.
        let mut s = screen();
        feed(&mut s, "\x1b[1;1HFirst\x1b[2;1HSecond\x1b[3;1HThird");
        assert_eq!(&s.lines()[..3], &["First", "Second", "Third"]);
    }

    #[test]
    fn a_line_rewritten_in_place_shows_only_the_newer_text() {
        let mut s = screen();
        feed(&mut s, "Password: \rSW1#");
        // The device overwrote its own line. Four characters replaced the
        // first four, so the tail of the older text still shows — which is
        // what a real terminal does, and why `\r` alone is not an erase.
        // (Read as a raw stream this line is `Password: \rSW1#`, whose
        // "hostname" contains a space, which is one more way the old reader
        // could never have found this prompt.)
        assert_eq!(s.lines()[0], "SW1#word:");
        // With an erase-to-end-of-line, which is what a device that means it
        // sends, nothing of the older line survives.
        let mut s = screen();
        feed(&mut s, "Password: \r\x1b[KSW1#");
        assert_eq!(s.lines()[0], "SW1#");
    }

    #[test]
    fn relative_moves_move_the_cursor() {
        // The thing a scan for the last `ESC[…H` could never do.
        let mut s = screen();
        feed(&mut s, "\x1b[10;10H");
        assert_eq!(s.cursor(), (10, 10));
        feed(&mut s, "\x1b[3A\x1b[2B\x1b[5C\x1b[1D");
        assert_eq!(s.cursor(), (9, 14));
        // And a move off the edge stops at the edge rather than wrapping.
        feed(&mut s, "\x1b[500A\x1b[500D");
        assert_eq!(s.cursor(), (1, 1));
    }

    #[test]
    fn erasing_parts_of_a_line_erases_the_right_parts() {
        let mut s = screen();
        feed(&mut s, "abcdefghij\x1b[1;5H\x1b[K");
        assert_eq!(s.lines()[0], "abcd", "erase to the end");

        let mut s = screen();
        feed(&mut s, "abcdefghij\x1b[1;5H\x1b[1K");
        assert_eq!(s.lines()[0], "     fghij", "erase to the start, inclusive");

        let mut s = screen();
        feed(&mut s, "abcdefghij\x1b[1;5H\x1b[2K");
        assert_eq!(s.lines()[0], "", "erase the whole line");
    }

    #[test]
    fn text_wraps_at_the_right_edge() {
        let mut s = Screen::new(4, 6);
        feed(&mut s, "abcdefgh");
        assert_eq!(&s.lines()[..2], &["abcdef", "gh"]);
        assert_eq!(s.cursor(), (2, 3));
    }

    #[test]
    fn the_screen_scrolls_when_it_runs_off_the_bottom() {
        let mut s = Screen::new(3, 10);
        feed(&mut s, "one\r\ntwo\r\nthree\r\nfour");
        assert_eq!(s.lines(), vec!["two", "three", "four"]);
        assert_eq!(s.cursor(), (3, 5));
    }

    #[test]
    fn a_scroll_region_scrolls_only_itself() {
        let mut s = Screen::new(4, 10);
        // Row 1 is a status line the device means to keep.
        feed(&mut s, "keep me\x1b[2;4r\x1b[2;1Ha\r\nb\r\nc\r\nd");
        assert_eq!(s.lines()[0], "keep me");
        assert_eq!(&s.lines()[1..], &["b", "c", "d"]);
    }

    #[test]
    fn backspace_moves_back_without_erasing_by_itself() {
        let mut s = screen();
        feed(&mut s, "abc\x08\x08X");
        assert_eq!(s.lines()[0], "aXc");
    }

    #[test]
    fn a_chunk_split_anywhere_reads_the_same() {
        // Reads land wherever the network splits them, including halfway
        // through an escape sequence. Feeding one byte at a time must give
        // the same screen as feeding it whole.
        let whole = {
            let mut s = screen();
            feed(&mut s, ARUBA_MEASURING);
            s
        };
        let mut split = screen();
        let mut replies = Vec::new();
        for b in ARUBA_MEASURING.as_bytes() {
            replies.extend(split.feed(&[*b]));
        }
        assert_eq!(split.lines(), whole.lines());
        assert_eq!(split.cursor(), whole.cursor());
        assert_eq!(replies, b"\x1b[200;200R");
    }

    #[test]
    fn what_is_not_understood_is_consumed_and_not_printed() {
        // Colour, cursor visibility, window titles, character sets: none of
        // them mean anything here, but every one of them must be swallowed
        // whole or its bytes end up on the screen as text.
        let mut s = screen();
        feed(
            &mut s,
            "\x1b[1;32mgreen\x1b[0m\x1b[?25l\x1b]0;a window title\x07\x1b(B done",
        );
        assert_eq!(s.lines()[0], "green done");
    }

    #[test]
    fn only_a_request_for_the_cursor_is_answered() {
        // `ESC[?6n` asks something else and `ESC[5n` asks after the device's
        // health. A made-up answer to either is worse than silence.
        let mut s = screen();
        assert!(feed(&mut s, "\x1b[?6n\x1b[5n\x1b[?6l").is_empty());
        assert_eq!(feed(&mut s, "\x1b[6n"), b"\x1b[1;1R");
    }
}
