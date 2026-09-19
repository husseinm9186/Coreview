/**
 * What the keyboard does. Opened with "?", because a shortcut nobody can
 * discover is a shortcut nobody has.
 */
const GROUPS: [string, [string, string][]][] = [
  ['Getting around', [
    ['Space + drag', 'Move the whole diagram'],
    ['F', 'Fit the sheet in the window'],
    ['Shift+F', 'Zoom to the selection'],
    ['Alt+1 … 9', 'Go back to a saved view (canvas menu: Save this view)'],
    ['Ctrl+PageUp / PageDown', 'Previous or next page (☰ by the page tabs lists them all)'],
    ['F5', 'Present: the diagram alone; arrows or Page Up/Down change page, Esc leaves'],
    ['Ctrl+F', 'Find a device'],
    ['?', 'This list'],
  ]],
  ['Selecting', [
    ['Drag on empty canvas', 'Select what the box covers'],
    ['Ctrl+click', 'Add or remove one device'],
    ['Alt + drag', 'Lasso: select what the outline goes round (with Shift, add to the selection)'],
    ['Ctrl+A', 'Select everything'],
    ['Esc', 'Select nothing'],
  ]],
  ['Editing', [
    ['Arrows', 'Nudge the selection a pixel'],
    ['Shift+arrows', 'Nudge a grid step'],
    ['Alt while dragging', 'Refuse the guides, and do the opposite of grid snap'],
    ['Ctrl+Shift+G', 'Grid snap on or off for this project'],
    ['Ctrl+D', 'Duplicate, one grid step over'],
    ['Ctrl+K', 'Search everything, or > for commands'],
    ['Alt+Arrow keys', 'Select the nearest device in that direction'],
    ['F6 / Shift+F6', 'Move between toolbar, shapes, diagram, inspector and panel'],
    ['Ctrl+C / Ctrl+V', 'Copy and paste'],
    ['Ctrl+Shift+V', 'Paste in place: where it was copied from, on any page'],
    ['Delete', 'Remove the selection'],
    ['Ctrl+Z / Ctrl+Y', 'Undo and redo'],
  ]],
  ['Arranging', [
    ['Ctrl+Alt+L / C / R', 'Line up left edges, centres, right edges'],
    ['Ctrl+Alt+T / M / B', 'Line up tops, middles, bottoms'],
    ['Ctrl+Alt+H / V', 'Even the gaps, across or down'],
    ['Ctrl+] / Ctrl+[', 'Bring the selection forward or send it backward'],
    ['Ctrl+Shift+] / [', 'Bring to front or send to back'],
  ]],
  ['Writing', [
    ['Double-click a name', 'Rename it in place'],
    ['Double-click empty canvas', 'Write text there'],
  ]],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="cv-help-scrim" onClick={onClose} role="presentation">
      <div
        className="cv-help-card"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cv-help-head">
          <h2>Keyboard</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="cv-help-cols">
          {GROUPS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              {rows.map(([keys, what]) => (
                <div key={keys} className="cv-help-row">
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
