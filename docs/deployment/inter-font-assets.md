# Inter font assets

The interface uses four complete Inter weights. Native platforms resolve
`src/hooks/app-font-assets.ts` and retain the original TTFs; Metro resolves
`src/hooks/app-font-assets.web.ts` for browsers and loads WOFF2 assets.
Feather remains the interface icon family.

The web files total 522,444 bytes, compared with 1,373,000 source bytes.
No glyphs are removed. Conversion preserves glyph outlines, components,
hinting, Unicode mappings, metrics, naming/licensing and shaping tables.
Only the documented SFNT header representation fields differ. Glyph and
metric transforms are disabled to retain all source flags.

To reproduce the conversion in an isolated development environment:

```sh
python3 -m venv output/operations/font-compression-runtime
output/operations/font-compression-runtime/bin/python -m pip install fonttools==4.66.1 brotli==1.2.0 zopfli==0.4.3
output/operations/font-compression-runtime/bin/python scripts/compress-app-fonts.py --check
```

Omit `--check` only when intentionally regenerating the WOFF2 files and
their audit manifest. Review and verify the new manifest before committing.
These Python tools are development tools, not application dependencies.
CI verifies the committed asset hashes, full weight set, platform mapping
and a 576 KiB web text-font budget with `npm run test:font-assets`.

Browser workflow tests explicitly decode registered Inter FontFaces and
check their loaded status. Unsigned iOS/Android JavaScript exports verify
native packaging only. Neither those exports nor viewport tests establish
signed binary or physical-device acceptance. Reduced download size alone
does not establish a regional latency target or availability guarantee.
