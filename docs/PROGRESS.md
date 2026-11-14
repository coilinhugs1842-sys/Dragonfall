# Progress log

Newest entries at the top. Claude updates this at the end of every task and session, so a fresh chat can pick
up where the last one stopped.

## Current state

- **Phase:** 7 (ship). Phases 5 and 6 code are in; trailer rough cut is complete from in-game captures.
  Higgsfield mood boards / Seedance polish still need a paid plan or the 3-day trial (balance 10, free plan).
- **Next for the user:** start the Higgsfield trial or upgrade if you want mood boards + Seedance trailer
  polish; create an empty GitHub repo and say to push so Pages can deploy; run the U-series gates
  (T-4.9 / T-6.1 / T-7.3).
- **Next for Claude (after push / credits):** enable Pages on the repo, optional Seedance pass on trailer
  stills, close T-7.1.
- **Open issues:** spot-check nine-class lobby + inverted loops on U-series. Large uncommitted polish
  (dragon riders/tags/hit-flash, etc.) may still sit in the working tree from a parallel pass.

## Log

### 2026-11-13: secondary on V, chase-cam hysteresis, default TURN

- **Controls:** Secondary ability default is **V** (was RMB). Ultimate stays **R**. Bindings format v2
  so old localStorage tables reset to the new defaults.
- **Camera:** Soft-up invert uses hysteresis + a stable horizon near vertical so hard upright banks /
  laptop turn-pitch no longer flip the chase view.
- **Networking:** Online mode always offers free Open Relay TURN (plus Cloudflare STUN); connect
  timeout 25 s; clearer “found room but couldn’t link” copy for school Wi-Fi.
- **Verify:** typecheck + focused input / camera / signaling tests.

### 2026-11-12: ship to coilinhugs1842-sys GitHub Pages (T-7.1)

- Repo: https://github.com/coilinhugs1842-sys/Dragonfall
- Play URL: https://coilinhugs1842-sys.github.io/Dragonfall/
- Workflow `.github/workflows/pages.yml` builds with LFS and publishes `dist/`.

### 2026-11-12: Duel teammate spectate, light speed, higher ceiling

- **Duel:** after the death cam, a downed rider follows living teammates (Space / click / A to cycle).
- **Movement:** lighter classes get a bit more cruise speed and turn; Zephyr (scout) stays the fastest;
  nobody was slowed.
- **Ceiling:** flight ceiling raised 700 → 800 m on every map before the push-down starts.
- **Verify:** typecheck + focused tests.

### 2026-11-12: player kit pass (F / RMB abilities)

- **Verdant:** RMB mending pod → heal bubble (ally regen + light enemy tick); F spur haste bubble.
- **Aureate:** RMB flash orb (enemy whiteout with fade in/out); F drift haze (slow + steering nudge).
- **Zephyr:** faster / tighter turn / quicker lighter primary; RMB blink teleport (~42 m).
- **Granite:** magma spit cooks earlier; RMB proximity burst (falloff by range); wings raised in PARAMS + rebuild.
- **Mirage:** RMB phantom double decoy flies straight 3 s.
- **Controls:** Space unbound from flap; Space is a second primary fire.
- **Bots:** lower cruise band (higher ceiling margin) so they stop hugging the push-down.
- **Verify:** typecheck + 2945 tests green.

### 2026-11-12: inverted bank + bank-free chase cam

- Soft-up is now ±horizon for the heading (no dragon bank), so inverted turns no longer tip the camera.
- Camera roll from bank is upright-only; inverted bank lean flipped again so the correct wing dips toward the screen turn.

### 2026-11-12: inverted steer/cam polish + kit differentiation

- **Screen-relative yaw when inverted:** `steerX` flips with `cos(pitch)` so mouse-right still
  turns toward screen-right; bank follows that turn.
- **Camera:** soft-up eases (`softUpRate`); Q/E dodge zeros camera roll (no spin-follow); lookAt
  falls back when up∥view so upright recovery and barrel rolls do not whip.
- **Kits:** Granite utility → Stone mend (regen, not Bastion shield); Aureate utility → Prism
  skim (slowing dash, not Zephyr haste); Mirage/Granite glyphs rewritten so they no longer
  match Wraith/Bastion icons.
- **Verify:** typecheck + full tests green.

### 2026-11-12: unique kits, distinct meshes, stall look-up fix

- **Look-up force:** stall auto nose-drop only when `|steerY| < 0.2`, so a held climb / loop is
  not yanked level (control still weakened; release recovers). Flight test updated.
- **Unique abilities:** every class has its own kit fingerprint. New projectiles
  (`bloomBolt`, `rootSeed`, `prismShard`, `galeBolt`, `magmaSpit`, `decoyBolt`) and zones
  (`rootSnare`, `quakeField`, `crater`, `afterimage`, `phantasm`). Mirage no longer clones
  Wraith (veil/phase/blind cone); Granite no longer clones Bastion (cone/knock wave).
- **Distinct meshes:** rewritten PARAMS for verdant / aureate / zephyr / granite / mirage;
  painted, Blender-built, finished into `public/assets/dragons/*`. Death-cam half-spans
  refreshed from new wingspans.
- **Verify:** `npm run typecheck` green; `npm test` 2941+ passed.

### 2026-11-12: inverted flight, nine classes, anim polish, balance

- **Inverted flight:** pitch wraps freely (full loops). Climb bleed / dive gain sharpened
  (`gravityAccel`). Chase cam soft-up past ~90°. DECISIONS 47. Flight + camera tests updated.
- **Five new classes:** Verdant / Aureate / Zephyr / Granite / Mirage (nine total). Procedural
  PARAMS → paint → Blender → finish into `public/assets/dragons/*`. Lobby class grid wraps for
  nine. Kits reuse existing ability kinds + new zones (`updraftGarden`, `canopy`, `solarLattice`,
  `galeWall`).
- **Anim polish:** stronger dive tuck / flap / bank in `dragonlib/anim.py`; snappier locomotion
  blends and full dodge bank lean; roar→land no longer replays the land flare. All nine GLBs
  rebuilt. Perch / death-cam spans refreshed from manifests.
- **Balance:** Talon dash / HP up; Bastion shield/rally sustain down; role ladder across nine in
  `CLASS_TUNING` / `ABILITY_TABLE`.
- **Verify:** `npm run typecheck` green; `npm test` 2941 passed. `PROTOCOL_VERSION` 5 (`host.setAllowedClasses`
  bitmask is u16 for nine classes).

### 2026-11-12: Phase 7 trailer first; Phase 6 closed; ship docs (T-6.2–6.6, T-7.2, T-7.4)

- **Higgsfield:** still free plan, 10 credits. GPT Image / Soul Location refuse; Seedance trailer polish
  needs Plus/Ultra or the 3-day trial. Plans widget shown to the user. Phase 4 mood boards (T-4.1) stay
  blocked; STYLE FORMULA remains provisional (DECISIONS 37, 39).
- **Trailer (T-7.4, first in Phase 7 as asked):** unlocked the caldera-flyby and ember-relay shots in
  `tools/trailer/shots.mjs` (no longer placeholders). Re-recorded both and rebuilt the cut:
  `art-source/trailer/dragonfall-trailer.mp4` (~63 s / 86 MB, 1920×1080@60, game music under it). Contact
  sheets: Caldera intro title card reads; Ember Relay waits for an objective then holds the carrier shot.
  Rough also at `*-rough.*` (git-ignored). Seedance polish deferred until credits.
- **Phase 6 status check:** T-6.2 / T-6.3 / T-6.4 / T-6.6 were already in `7bf0061`. T-6.5 verified with
  `tools/capture/rejoin.mjs --only spectator-full,spectator-midmatch,reload-playing,reload-relay` — all
  PASS (mid-match reload, Ember Relay shard state after rejoin, 11th player spectates full 5v5, mid-match
  join then seat in lobby). T-6.1 remains the user's U-series 5v5 gate.
- **Ship docs (T-7.2 / T-7.1 groundwork):** README rewritten (play, LAN with `peer:lan` + `dev:lan`,
  deploy). `.github/workflows/pages.yml` builds with `lfs: true` and publishes `dist/` to GitHub Pages.
  No remote yet — push waits on the user's empty repo.
- **Phase 7 gate for the user (once Pages is live):** a friend who has never seen it hosts and plays from
  the URL using only `README.md`. Until then: trailer at `art-source/trailer/dragonfall-trailer.mp4`.

### 2026-11-11: Phase 5 cinematics + lobby (T-5.1 to T-5.6)
- The full flow now runs: title → aerie lobby → take-off → map flyby with title card → both gates → 3-2-1 →
  match → death cam on a takedown → podium with awards → back to the aerie with teams kept.
- **T-5.1** Host timeline (DECISIONS 42): lobby `starting` 3 s, `intro` 6 s on a room's first round, ceasefire
  outside `playing`, bots idle after the end, host-only skip from the second match, `?nocine`.
  `PROTOCOL_VERSION` 3.
- **T-5.2 / T-5.3** `src/cinematics/aerie`: two terraces of five perches cut from the map's own models;
  riders fly in and land, rear when ready, take off in sequence at the start; drifting camera, close-up on a
  rider (click a row or a name card, Esc to leave). The lobby UI docks round it: rosters left and right, class
  picker and Start at the bottom, the full host panel under "Match rules".
- **T-5.4** `match-intro.ts`: flyby along the map's `introSpline`, title card, far gate, own gate, ending on
  the chase camera's pose.
- **T-5.5** `death-cam.ts` (orbit round the killer for 3 s, never an enemy that is veiled) and
  `src/cinematics/podium` (formation pass, three winners land, awards, DECISIONS 44).
- **T-5.6** `src/game/show.ts` owns all four and the one directed camera (DECISIONS 43). Cuts go through a
  cream fade that waits for the shader warm-up (DECISIONS 45). Rigs are built at match load
  (`Dragons.prewarm`), late assets re-run the warm-up, the lobby's rigs are freed while a match is loaded and
  the aerie is freed with the room.
- Review fixes from the Phase 4 list are in (commit `1cf56e1`): loader failure paths, retry of a failed dragon
  class, dispose of instanced buffers, shadow map freed on Low, LOD cap hysteresis, textures capped by the
  preset's `maxTextureSize`, tests for the animator, the LOD pickers and worker/main map parity.
- 2517 tests in 119 files; typecheck, test, build pass. Entry chunk 591 kB (196 gzip).
- **Checked in headless Edge** with `tools/capture/timeline.mjs` (a page over time, with the game's clocks per
  frame) and `tools/capture/duo.mjs` (a host page and a guest page in one room over real WebRTC): host and
  guest show the same phase within 0.15 s through lobby, launch, intro, countdown and play; no console errors
  or warnings on either page; results, podium and the return to the lobby on the host.
- **`?bench`, production build, same set-up as the Phase 4 table (GTX 1660 SUPER, 1920 × 1080, 60 s):**

  | | Low | Medium | High | Budget (L / M / H) |
  | --- | --- | --- | --- | --- |
  | Avg fps | 293.4 | 297.0 | 294.4 | 60 |
  | 1 % low fps | 108.6 | 147.6 | 113.6 | |
  | Slowest frame, ms | 60.0 | 50.0 | 76.7 | |
  | Draw calls, max | 41 | 56 | 91 | 120 / 180 / 350 |
  | Triangles, max | 78.9k | 138.7k | 307.4k | 250k / 450k / 1.2M |
  | Particles, peak | 154 | 204 | 374 | 600 / 1200 / 3000 |
  | Audio voices, peak | 16 | 24 | 20 | 16 / 24 / 32 |
  | Render scale, min | 0.70 | 0.85 | 1.00 | |

  The 1 % lows are lower than in the Phase 4 table, so the Phase 4 commit was rebuilt and run back to back
  with this one on Medium: Phase 4 gave 150.8 and 133.1 (slowest frames 47 and 100 ms), this build 159.1
  (slowest 30 ms). The difference to the old table is the machine on the day, not the code. Both builds
  still have a few 30 to 100 ms frames in the first 15 s of a fight: first use of something (not yet found).
- Lobby cost (aerie viewer, ten dragons, whole frame): Low 23 draw calls / 38k triangles, Medium up to 41 /
  94k, High 64 / 152k. Podium: 5 to 6 draw calls, under 2.5k triangles.
- **Phase 5 gate for the user** (4+ players, real laptops):
  1. Host a room, share the code, have three or more people join. In the aerie: does everyone see every
     rider land, the ready rear, and the name cards over the right dragons? Click a rider for the close-up.
  2. Host: open Match rules, change mode, team size and a class restriction; move a rider; press Start.
  3. Everyone: take-off, flyby with the map's name, both gates, 3-2-1, all at the same moment on every screen.
  4. Get taken down once: the camera should circle whoever got you for about 3 s.
  5. Finish the match: formation pass, podium, awards, table, then the aerie again with the same teams.
  6. Start a second match: the host should see "skip" during the intro (Space or Enter).
- **Not verified:** all of it in motion by a person (only stills and clocks were read); sound during the
  cinematics; anything on U-series hardware; reduce-motion versions in the real game (viewer only).
- **Known gaps:** the first second of the intro is under the fade while shaders compile; a lone host in a
  hosted room still gets launch and intro; terrain and storm damage are not stopped by the ceasefire; the
  end of the flyby pushes into the pink sky-well crystal, which is flat-shaded up close; seat heights on the
  perches were measured for one class only.
- **Incident:** the capture tool leaked a browser profile per run (138 folders, 6.8 GB in the temp folder; C:
  ran out of space for a while). A workstream deleted the `dragonfall-cdp-*` folders. Fixed in
  `tools/capture/cdp.mjs`: the browser tree is killed, the profile is always deleted, the next launch sweeps
  what a hard kill left, and the profile's caches are capped (about 4 MB each now).

### 2026-11-11: Phase 4 art pass (T-4.2 to T-4.9; T-4.1 blocked)
- The game now has its real look: four skinned dragons with riders, the Shattered Spires map built from 12
  rock and 15 prop models, painted textures, sun shadows and light shafts, a post pass, and real sound effects,
  ambience and music. Nothing was generated with Higgsfield: see "Higgsfield" below.
- **T-4.2** `tools/pipeline`: optimize (gltf-transform, meshopt, KTX2), texture and audio encoders, a manifest
  builder that enforces `budgets.json`, a GLB inspector.
- **T-4.3 / T-4.4** Dragons built by Blender Python (`tools/blender/dragons`): one generator, four class
  scripts, 12 clips each, 3 LODs. Loader with KTX2 + meshopt, clip blending, team tint on membranes, a cap on
  skinned dragons per preset with the placeholder as the far tier. `?viewer=dragon:<class>` inspects one.
- **T-4.5 / T-4.6** Map layout is data (`src/shared/maps/shattered-spires.ts`, 165 placements, half-turn
  symmetric); the collision hulls are exported with the models, so the host, the worker and the clients collide
  with what is drawn. Instanced props with 3 LOD tiers, far clusters, vertex AO, sun shadow map on High, blob
  shadows on Medium, light shafts.
- **T-4.7** One composite pass on every preset (tone map, grade, vignette; FXAA + sharpen on Medium and High;
  3-level bloom and sun shafts on High). Low gets the pass too: DECISIONS 38.
- **T-4.8** 123 audio files (6.2 MB) synthesised by `tools/audio`, loudness-normalised, with loop points in a
  manifest. Two-layer match music follows the fight; the procedural sounds remain as the fallback.
- **T-4.9** `?bench` (DECISIONS 41) and `node tools/capture/bench.mjs`. Headless capture tools in
  `tools/capture` (screenshots, console errors, bench).
- 1849 tests in 92 files; typecheck, test, build pass. Build: entry 654 kB (218 gzip), three 879 kB, host
  worker 499 kB; `public/assets` is 17.9 MB.
- **`?bench`, production build, headless Edge on the dev desktop (GTX 1660 SUPER, 1920 × 1080, 60 s, 5v5
  bots). This is not the U-series target, and a headless browser is not held to 60 Hz:**

  | | Low | Medium | High | Budget (L / M / H) |
  | --- | --- | --- | --- | --- |
  | Avg fps | 298.7 | 299.0 | 297.0 | 60 |
  | 1 % low fps | 203.6 | 218.5 | 147.2 | |
  | Slowest frame, ms | 53.4 | 26.6 | 30.1 | |
  | Draw calls, max | 41 | 59 | 93 | 120 / 180 / 350 |
  | Triangles, max | 82.2k | 144.0k | 308.2k | 250k / 450k / 1.2M |
  | Particles, peak | 139 | 171 | 367 | 600 / 1200 / 3000 |
  | Audio voices, peak | 16 | 23 | 25 | 16 / 24 / 32 |
  | Render scale, min | 0.70 | 0.85 | 1.00 | |
  | Host work per frame, ms | 0.217 | 0.253 | 0.298 | |

  Before (Phase 3, greybox): 27 / 28 / 28 draw calls and 21.5k / 19.8k / 25.4k triangles. The 53 ms frame on
  Low is one hitch in 60 s, most likely a shader compiling on first use (review finding 1 below).
- **Higgsfield:** the account is on the free plan with 10 credits. GPT Image and Soul Location refuse free-plan
  jobs; Z Image accepted two mood-board jobs and both failed and were refunded. Balance is still 10. All seven
  attempts are in `art-source/LOG.md`; prompts come from `tools/pipeline/make-prompts.mjs`.
- **Review of the Phase 4 code (11 findings).** Fixed here: shader warm-up now compiles against the real scene
  target (`GameRenderer.precompile`, `Stage.warmUp`); `.pyc` files ignored. Recorded as a decision: Low's post
  pass (38). Being fixed next, before Phase 5 lands: dragons and a late map are built mid-match; a failed map
  load leaks and is not handled; a dragon class that fails to load is never retried; `PropField.dispose` leaves
  instanced buffers to the GC; the shadow map survives a switch to Low; the skinned-dragon cap has no
  hysteresis; map textures ignore the preset's `maxTextureSize`; no tests for the dragon animator, LOD pickers
  and worker/main map parity. Left as is: sessions default to the greybox world when no factory is passed
  (nothing does that today).
- **Phase 4 gate for the user:**
  1. `npm run dev`, then `http://localhost:5173/?solo&perf`: fly Shattered Spires. Does it look like the style
     in `docs/ART_DIRECTION.md`? Say what to change; a restyle is a script edit and a rebuild.
  2. On a U-series laptop: `http://<ip>:5173/?bench&quality=medium`, wait 70 s, read the box in the corner.
     Pass = avg fps 60 and 1 % low above 50. Repeat with `quality=low`; send both rows.
  3. Listen with speakers: lobby music, match music rising in a fight, each class's four abilities.
  4. `?viewer=dragon:talon` (also `bastion`, `tempest`, `wraith`): check each dragon and its clips.
- **Not verified:** anything on U-series hardware; nobody has listened to the audio; Low's composite pass cost
  on integrated graphics.
- **Incident:** a second dev server started by Claude wiped the Vite dependency cache of the user's running
  one (`?perf` / `?debug` answered 504 until it re-optimised). Fixed with a separate cache folder
  (DECISIONS 40).

### 2026-11-11: Phase 3 combat + MVP modes (T-3.1 to T-3.10)
- A full Duel and a full Skirmish play start to finish against bots or a second player: countdown, rounds,
  results table, back to the lobby with teams kept. Graphics are still greybox and placeholder dragons; the
  real look lands in Phase 4.
- **T-3.1** Health, damage, takedowns with assists, 5 s respawn with spawn protection, GameEvents.
- **T-3.2** All 16 abilities, data-driven in `src/shared/abilities.ts` (bolts, cones, beams, dash, shield,
  heal, zones, veil, phase dive, blind).
- **T-3.3** Host lag compensation (rewind at most 200 ms). Client on `netsim=bad` firing at a circling host:
  44.6 % hit rate with it, 6.7 % with `?lagcomp=0`.
- **T-3.4** Skirmish (first to N or time) and Duel (rounds, no respawn, storm wall closes after a 20 s hold).
- **T-3.5** Pooled instanced particles, beams and shield shells in `src/vfx`, capped per preset; storm wall
  view in `src/world/storm`.
- **T-3.6 / T-3.7** HUD: health, stamina, four ability slots, ultimate, reticle + hit marker, killfeed, score
  and timer, compass, status chips, respawn panel, damage arcs, low-health vignette, scoreboard (Tab,
  rebindable), results panel.
- **T-3.8** WebAudio engine with voice cap and panning; every sound is synthesised placeholder (DECISIONS 35).
- **T-3.9** Settings panel (Video, Controls, Audio, Game & Network): preset, dynamic resolution, frame cap,
  FOV, shake, sensitivity, invert Y, rebinding, volumes, UI scale. Saved in `localStorage`.
- **T-3.10** Bot pilots (Easy / Normal / Hard) fill seats from the lobby and fly inside the host sim.
- 1732 tests in 85 files; typecheck, test, build pass. Two reviews raised 12 findings: 11 fixed, bandwidth
  partly (DECISIONS 24-26).
- **Measured in headless Edge on the dev desktop, 5v5 bot Skirmish, 62 s per preset (not the U-series target):**

  | | Low | Medium | High | Budget (L / M / H) |
  | --- | --- | --- | --- | --- |
  | Draw calls, max | 27 | 28 | 28 | 120 / 180 / 350 |
  | Triangles, max | 21.5k | 19.8k | 25.4k | 250k / 450k / 1.2M |
  | Particles, peak | 176 | 254 | 406 | 600 / 1200 / 3000 |
  | Audio voices, peak | 14 | 13 | 15 | 16 / 24 / 32 |
  | Host tick in worker, ms | 0.052 | 0.080 | 0.066 | 1.5 |
  | KB/s per client | 6.20 | 6.46 | 6.31 | about 7 |

  Phase 2 figures for comparison: 20 draw calls on Medium, host tick 0.025 ms, 5.7 KB/s (flight only).
- Build: entry 550 kB (180 gzip), three 544 kB, host worker 435 kB, audio 30 kB and settings 18 kB lazy.
- New dev flags: `?autopilot=bot`, `?mode=`, `?score=`, `?time=`, `?teamsize=`, `?botlevel=`, `?fill`,
  `?lagcomp=0`, `?join=CODE`.
- **Phase 3 gate for the user (two real laptops):**
  1. Host: `npm run dev:lan` and `npm run peer:lan`, open `http://<ip>:5173/?lan&perf`, Host a room; the
     second laptop joins by code.
  2. Duel 1v1 to three round wins: 3-2-1, round pips, storm wall closing after 20 s, results, lobby.
  3. Skirmish 2v2 with "Fill with bots": killfeed, score, respawn count, Tab scoreboard, damage arcs point at
     the attacker.
  4. Each class: all four abilities read clearly; Talon dash hits once; a veiled enemy Wraith is fully hidden
     until it attacks; a phase dive that ends in rock pops you out.
  5. Client with `&netsim=bad`: own shots appear at once and hits feel fair.
  6. 60 fps on the U-series host with `?perf`; set a 30 fps cap and check the scale does not drop.
- **Not verified:** anything on real hardware; real pointer lock (headless Edge refuses it, so mouse aim ran
  with a simulated lock); nobody has listened to the audio; the storm wall has not been seen up close in a
  match; veil/phase translucency has no screenshot; spectator HUD and mid-match reconnect in a browser.
- **Open issues:** Talon looks weak 1v1 against Bastion (hard bots, 0-3); bots fly straight during round end
  and results; compass labels overlap when markers bunch; the debug GUI combat tables do not reach a worker
  host (use `?noworker`); rewind assumes a 100 ms interpolation delay instead of the client's real one; Duel
  storm fractions barely show on the greybox map (DECISIONS 34).
- **Repair:** `docs/TASKS.md` was committed empty in `d6bba62` by mistake. It is restored from `d41c844` with
  Phases 2 and 3 ticked.

### 2026-11-11: Phase 2 netcode core (T-2.1 to T-2.10)
- Full flow works: title → Host / Join by room code / Fly solo → lobby → match → back to lobby or title.
- **T-2.1** Transport abstraction with PeerJS and in-memory loopback implementations. Spike answers: PeerJS has
  no truly unreliable channel, so `fast` is our own negotiated channel (DECISIONS 19); plain-HTTP LAN works
  (DECISIONS 20).
- **T-2.2** Binary codec: defensive decode, 10-dragon snapshot inside the 360 B budget, fuzz-tested.
- **T-2.3** `HostSession` / `ClientSession`: handshake, lobby broadcast, reconnect token (30 s slot), kick ban.
- **T-2.4** 20 Hz snapshots, adaptive interpolation buffer, client prediction + reconciliation with smoothing.
- **T-2.5** `?netsim=<profile>` (off/lan/wifi/bad/awful or `ms,±ms,loss%`) and `?bots=N` net-bots
  (`&autostart` to host, fill and start at once).
- **T-2.6** Pure lobby state machine: teams 1-5, uneven toggle, move/auto-balance/shuffle/lock, class, ready,
  kick, start rules.
- **T-2.7 to T-2.9** Title, Host/Join, 2D lobby panel, connection chip, pause menu (host: End match / Close
  room), disconnect and host-left screens.
- **T-2.10** Host sim + snapshot encoding run in a Web Worker by default, main-thread fallback with `?noworker`
  (DECISIONS 21).
- 1206 tests in 60 files; typecheck, test, build pass. Two reviews raised 8 findings, all fixed.
- **Measured in headless Edge on the dev desktop (relative figures, not the U-series target):**
  - Host with 9 bots: 0.025 ms per tick in the worker; 0.02 ms of host work per frame on the main thread
    (0.13 ms with `?noworker`); 5.7 KB/s upload per client (budget 7).
  - Client under `netsim=bad`: remote position error mean 0.03 m, max 0.10 m; own dragon 0 corrections.
  - Draw calls and triangles unchanged from Phase 1 (no visual work in this phase).
- **Phase 2 gate for the user (two real laptops on Wi-Fi):** host runs `npm run dev:lan` and `npm run peer:lan`,
  opens `http://<ip>:5173/?lan&bots=8&perf`, picks Local network → Host a room; the second laptop opens
  `http://<host-ip>:5173/?lan&perf&netsim=bad` and joins by code. Fly a few minutes: no rubber-banding, own
  dragon never snaps. Also try: client tab hidden 20 s, Wi-Fi off 5 s, F5 on the client, kick, host End match.
- **Open questions (defaults chosen, change on request):** a hidden client's dragon flies straight on its last
  input; a hidden main-thread host freezes the sim (worker path does not); Close room has no confirm step.

### 2026-11-10: Phase 1 flight sandbox (T-1.1 to T-1.9)
- The app now boots straight into a flyable sandbox on the greybox Shattered Spires map ("click to fly").
- **T-1.1** Arcade flight model in `src/sim/flight.ts`: energy trade, stall, boost/stamina, flap, dive, barrel-roll
  dodge. Every number is in `FLIGHT_TUNING` (live-editable under `?debug` → Flight). Deterministic.
- **T-1.2** `src/input`: pointer-lock mouse reticle + keyboard → `InputFrame`, serialisable rebind table, keys
  cleared on blur.
- **T-1.3** `ChaseCamera`: frame-rate independent follow, bank lag, speed FOV, boost shake, terrain pull-in, held
  above the cloud sea.
- **T-1.4 / T-1.5** Gradient sky shader + sun + hemisphere + exp² fog matched to the horizon; opaque cloud-sea
  shader; instanced cloud puffs (1/2/3 layers per preset, billboarded in the vertex shader).
- **T-1.6** Greybox map as pure data in `src/shared/maps` (seeded, mirror-symmetric, spawn gates, storm wall);
  rendered as merged 500 m chunks with one material and baked vertex AO.
- **T-1.7** BVH terrain collision (swept sphere, bounce, speed-scaled damage, re-hit grace) and storm wall,
  floor and ceiling. Uses the same triangles as the renderer (DECISIONS 17, 18).
- **T-1.8** Placeholder dragons: one pooled instanced mesh, wings animated in the vertex shader, team colour on
  the membranes.
- **T-1.9** 576 tests in 29 files (no NaN under adversarial input, bounded speed/stamina, determinism, no
  tunnelling, launch from every gate slot, input → sim → camera axis chain). typecheck, test, build pass.
- Dev aids: `?autopilot` (scripted pilot), `?skip=<seconds>` (fast-forward at load).
- Built by six parallel agents, integrated, then two independent reviews; 4 findings, all fixed (outer spawn
  slots hit the gate arch; dragons could sink below all terrain; cloud sea hid the dragon from the camera; far
  chunks popped in on Low/Medium).
- **Perf HUD (headless Edge on the dev machine, so draw calls and triangles only; fps there is meaningless):**

  | | Phase 0 scene | Low | Medium | High | Medium budget |
  | --- | --- | --- | --- | --- | --- |
  | Draw calls | 1 | 19 | 20 | 21 | ≤ 180 |
  | Triangles | 20 | 5,509 | 5,813 | 6,125 | ≤ 450k |

  Sim cost with 10 dragons and collision is far below 1 ms per tick in the tests. **fps on a U-series laptop is
  still unmeasured: that is the gate.**
- **Known rough edges (not blocking the gate):**
  - Flight feel is untested by a human; expect a tuning pass.
  - A head-on bounce flips the heading 180° and the camera swings with it.
  - Lethal impact speed is 85 m/s while Talon can reach about 104 m/s on boost; check it feels fair.
  - No sun shadows on any preset yet (Medium "dragons only" and High shadows come with real assets, T-4.6).
  - Changing the preset live recompiles sky and sea shaders with a short hitch (loading screen is T-5.6).
  - Shadowed rock faces go near-black; edges are aliased at 0.7 to 0.85 render scale until the FXAA pass (T-4.7).
  - Open tuning questions: hard floor/ceiling depth (40 m), whether the cloud sea should throw a diving dragon
    back out, gate arch width (96 m).

### 2026-11-10: Phase 0 scaffold (T-0.1 to T-0.6)
- **T-0.1** `vite.config.ts` (three in its own chunk, `base: './'`, Basis/KTX2 transcoder copied to the git-ignored
  `public/vendor/basis/`; the meshopt decoder is an ES module and is imported, not copied), `index.html`,
  `src/style.css`, `src/main.ts` boot.
- **T-0.2** `src/shared` contracts: constants, `InputFrame`, `WorldView`, `GameEvents` + pooled event bus,
  `UiState`/`UiIntent`, lobby and match types, `QUALITY_PRESETS` (matches the PERFORMANCE.md table), manifests,
  classes, tuning stubs. No three.js or DOM imports.
- **T-0.3** `FixedStepLoop` (30 Hz accumulator, catch-up clamp, alpha), sim skeleton with prev/current state,
  `App` state machine (title/lobby/match/results), rAF `FrameDriver` that resets on tab hide.
- **T-0.4** `createGameRenderer` (one WebGL2 renderer, no MSAA, context-loss handling, render scale relative to
  1080p) and `DynamicResolution` (EMA + hysteresis, 0.05 steps, upward probing because vsync hides headroom,
  adapts to displays slower than 60 Hz).
- **T-0.5** `?perf` HUD (stats-gl + fps / frame ms avg, 1 % low, max / draw calls / triangles / geometries /
  textures / heap / render scale / sim ms, text at 4 Hz) and `?debug` lil-gui panel. Both load by dynamic import;
  the entry chunk is 16 kB and contains neither.
- **T-0.6** Vitest: 169 tests in 11 files (loop stability and determinism, scaler, contracts, App transitions,
  and an allow-list boundary test enforcing golden rule 3). `npm run typecheck`, `npm test`, `npm run build` pass.
- Also: `?quality=low|medium|high` override; the stored preset is read from `localStorage['dragonfall.settings']`
  (nothing writes it until T-3.9).
- Built by five parallel agents, then three independent reviews; all 10 findings were fixed or part-fixed.
- **Perf HUD:** no "before" (first runnable build). Only checked in headless Edge on the dev machine (scene, HUD
  and debug panel render, console clean, 1 draw call, 20 triangles); headless timings mean nothing. **Real
  numbers come from the user's gate check on a U-series laptop.**
- **Follow-ups decided (DECISIONS 14-16):** dragon flags widened to `u16`; ASSET_PIPELINE.md map budget corrected
  to 450k / 300 MB; no automatic refresh-rate re-test (Settings will call the scaler's `reset()`, T-3.9).
- **Still open:** `three-mesh-bvh` needs `BufferGeometry`, which the sim boundary test rejects (math-only three
  imports). Settle in T-1.7.

### 2026-11-10: setup finished
- Planning docs, config, folder skeleton, git + LFS on `main`. No game code yet.
- Laptops confirmed U-series, so the budgets in PERFORMANCE.md are tight and the host sim is planned for a Web
  Worker (T-2.10).
- Installed ffmpeg 9.0.2 + KTX-Software 4.4.2; npm dependencies installed.
- Reference video reviewed (differences in ART_DIRECTION.md), then deleted.
- Switched to Claude-only development: the Cursor worktree, rules and lane files are removed.
