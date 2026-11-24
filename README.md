# GD Ruse30 Tagger (GitHub Pages)

Public GitHub Pages copy of the GD Ruse30 play-by-play tagger and stats shell. Source snapshot: private `gdr30-tagger` commit `c173b5f`. This repo is independent of the live stats site (`gdr30-stats-ibcnnx`) and of the private tagger repo — neither is modified from here.

**Live pages**

- Dashboard: https://pp-patrickpeng.github.io/gdr30-tagger-t5qcm7/
- Tag workspace: https://pp-patrickpeng.github.io/gdr30-tagger-t5qcm7/tag.html

## Legal & Video Policy

- **Own recordings only:** Use only local video recordings that Patrick owns.
- **No Glory League video:** Never load, copy, commit, or redistribute Glory League video files.
- Videos are opened strictly in-browser via `URL.createObjectURL`. Nothing is uploaded, and there is no backend or build step.

Roster short names and jersey numbers in this site are public, as on the existing GD Ruse30 stats site.

## How to tag a game

1. Open the Tag workspace link above.
2. Choose a local MP4 (or other video you own) — it stays in this browser tab.
3. Set the game date, opponent, and official scores, then tag events from the pad or keyboard.
4. Export `glory_pbp_<YYYYMMDD>.csv`, box-score JSON, or a full session backup from **Game & export**. Tags also autosave in this browser's `localStorage`.

## Default Roster Decision

Person IDs and official box-score full names come from the GD Ruse30 stats site. Short PBP names match historical `glory_pbp_*.csv` files where they exist; `R Zhang` is proposed for `#17`, and `A Wang` and `L Tian` are this project's short names (not present in older PBP CSVs).

| `personId` | Default jersey | PBP short | Box full name | Default active |
|---|---|---|---|---|
| `7` | `7` | `H Guo` | Hanze Guo | **Yes** |
| `17` | `17` | `R Zhang` | Ryan Zhang | **Yes** |
| `19` | `19` | `M Tan` | Marcus Tan | **Yes** |
| `23` | `23` | `R Li` | Roger Li | **Yes** |
| `24` | `24` | `A Peng` | Alex Peng | **Yes** |
| `30` | `30` | `J Ren` | Joel Ren | **Yes** |
| `74` | `74` | `E Sun` | Elison Sun | **Yes** |
| `15` | `17` | `A Wang` | Adrian Wang | **No** (later addition; default jersey conflicts with Ryan unless changed) |
| `7L` | `7` | `L Tian` | Luke Tian | **No** (later addition; default jersey conflicts with Hanze unless changed) |

- **Per-game jerseys:** Active flags and jersey numbers are editable per game in **Game & export → Tonight's GD Ruse30 roster** (recent s2 examples: 21 Oct Luke `17` / Adrian `7`; 28 Oct & 11 Nov Luke `7` / Adrian `17`).
- **Identity vs. jersey:** PBP CSV `num` records the **jersey worn** in that game. Box-score JSON `players` keys use the stable **`personId`**, and `meta.numbers` maps `personId` → jersey worn.

## Fouls

- Personal fouls (**PF**) are tracked only via the **`−` / `+` steppers** on the live box score (`pfSidecar` in the session).
- **No `FOUL` PBP rows:** The event pad and exported PBP CSV never emit `FOUL` rows.

## Locked Keyboard Shortcuts

Hotkeys are active whenever focus is **not** inside an `<input>`, `<textarea>`, `<select>`, or `contenteditable` element (except `Ctrl/Cmd+Z` undo, which always works).

Glory's `S` (slow) and `D` (add stat) are intentionally remapped so stat letters match basketball stats: **`S` = STEAL**, **`D` = DEFENSIVE REBOUND**, **`[` / `]` = playback speed**, **`G` = latch timestamp**.

| Key | Action |
|---|---|
| `Space` | Play / pause (prevents page scroll) |
| `←` / `→` | Seek `−3s` / `+3s` |
| `,` / `.` | Seek `−1s` / `+1s` |
| `[` / `]` | Slow down / speed up (`0.5×` … `2.0×`) — **not `S` / `F`** |
| `K` / `L` | Previous / next tag in PBP log |
| `Y` | Edit selected (or most recent) tag |
| `G` | Latch current video timestamp / add-stat |
| `S` | **STEAL** |
| `D` | **DEFENSIVE REBOUND** |
| `O` | OFFENSIVE REBOUND |
| `A` | ASSIST (`Shift+A` inserts assist immediately before last made 2PT/3PT) |
| `B` | BLOCK |
| `T` | TURNOVER |
| `1` / `2` / `3` | Made `1 POINT` / `2 POINT` / `3 POINT` |
| `Shift+1` / `Shift+2` / `Shift+3` | Missed `1 POINT MISS` / `2 POINT MISS` / `3 POINT MISS` |
| `M` | Flip pending or last-3s shot made ↔ miss |
| `Tab` | Toggle `GD RUSE30` / opponent |
| `Z` or `Ctrl/Cmd+Z` | Undo (up to 50 steps) |
| `Delete` | Delete selected tag |
| `Escape` | Cancel pending latch or close inline editor |
| `C` | Toast notice: clips are out of MVP |

## Exports

From **Game & export** on `tag.html`:

- `glory_pbp_<YYYYMMDD>.csv` — chronological `time,team,num,player,event` UTF-8 LF CSV (drops `CLIP`, `FOUL`, and any non-legal event; `GD RUSE30` team string; uppercase Hoops events).
- `boxscore_<YYYYMMDD>.json` — Hoops-compatible fragment with `meta` (including `meta.numbers`), `players` (keyed by `personId`, including active zero-stat players), and `team`. Preserves official `us`/`them` scores and includes `meta.box_pts` if PBP PTS differs.
- `gdr30_session_<YYYYMMDD>.json` — full session backup/restore JSON (also supports importing a `glory_pbp_*.csv`).
