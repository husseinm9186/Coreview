# stencils/

Ships empty, on purpose (D-028).

Coreview draws its own shapes (`src/components/icons.tsx`) and treats vendor and
model as data. No vendor's icons, logos or stencil packs are committed here or
bundled into the installer. The folder stays because the installer bundles it
as a resource; `.gitignore` refuses anything else in it, and a Rust test
(`the_shipped_stencils_folder_carries_no_artwork`) fails CI if artwork reappears.

Your own stencils — including vendor packs you have the right to use — go in a
folder of your own that you point the icon library at. See
`docs/BRAND_AND_LICENSING.md`.
