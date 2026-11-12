# My fork — to-do

Things to come back to once the editing is done.

## Make it a normal Mac app (no Terminal)
- [ ] Check the packaging setup works with the new features (song fixer, fingerprinting, ffmpeg) inside a packaged app
- [ ] Build the installer: `npm run dist`, then open `dist/` and use the **arm64** `.dmg` (Apple chip) or **x64** (Intel)
- [ ] Drag **Zune Explorer** to Applications; first launch: right-click → Open (the app isn't registered with Apple)
- [ ] Optional: turn on GitHub Actions in this fork so installers can be built without Terminal

## Clean-up and sync
- [ ] Duplicates on the Zune: settings → library → fix songs & find duplicates → duplicates on zune
- [ ] Duplicates on the Mac: same page → duplicates (identical copies first, then different versions)
- [ ] Fix songs (needs fixing tab), delete the ones that can't be fixed
- [ ] Zune music list → rescan → **update zune** to apply fixes and deletions

## Share the fixes
- [ ] Open pull requests to NiceBeard/zune-explorer for the copy-from-Zune fixes (`fix/pull-from-device`) and, if wanted, the song fixer
