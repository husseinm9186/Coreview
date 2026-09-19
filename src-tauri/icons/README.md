Generated from `brand/coreview-mark.svg`, which is the source of truth — the
mark is drawn as geometry so it holds together from a 16px tray entry to a
1024px tile, and because Coreview ships no third-party artwork (D-028).

To regenerate after changing the SVG:

    convert -background none -density 400 brand/coreview-mark.svg \
      -resize 1024x1024 /tmp/icon-1024.png
    npx tauri icon /tmp/icon-1024.png

That writes every size Tauri bundles, plus Android and iOS sets. Coreview is a
desktop application with no mobile target, so those two folders are deleted
again afterwards rather than committed.
