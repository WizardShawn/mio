# Assets

The app loads assets from the first directory that contains a `.vrm`:

1. `%APPDATA%/cortana-desktop-assistant/assets/`
2. `./assets/` (this folder)

Expected shape:

```
assets/
├── vrm/                  # every .vrm here becomes one wardrobe outfit
├── animations/
│   ├── idle/             # picked at random, looped
│   ├── talking/          # picked at random while streaming
│   └── extras/           # staging area, not loaded
└── workflows/            # ComfyUI workflow graphs (optional)
```

Nothing here is hard-coded. `assets.ts` scans `vrm/` at boot and derives the
outfit list from the filenames, so dropping another `.vrm` into the folder makes
it reachable by the `change_clothes` tool on the next launch with zero code
changes.

## What ships in this repository

| Path | Status |
|---|---|
| `vrm/Mio_Kimono.vrm` | ✅ Included. Authored by the repository owner. |
| `animations/**` | ❌ Not included — see below. |
| `workflows/**` | ❌ Not included — environment-specific. |

**`Mio_Kimono.vrm`** is included because it is the author's own work. Its
embedded VRM 1.0 metadata declares `allowRedistribution: false`,
`modification: prohibited`, and `avatarPermission: onlyAuthor` — those terms
govern what *recipients* may do with the model and are intentional. They match
this repository's `LICENSE`: you may read and evaluate, not reuse. The model was
produced in VRoid Studio, so portions of the underlying base mesh and textures
remain subject to pixiv's VRoid Studio terms.

## What you need to supply

**Animations.** The avatar renderer expects `.vrma` (VRM Animation) files in
`animations/idle/` and `animations/talking/`. None are bundled, because the ones
used during development are pixiv's official VRM Animation samples and are not
mine to redistribute. Get them from the
[VRoid VRM Animation sample pack](https://vroid.com/en/news/6HoLKPWpgTUS4gCJcAGqDW),
or supply any `.vrma` files you like.

The app degrades gracefully: with no animations present the avatar loads and
renders in its rest pose, and everything else — chat, memory, the agent loop,
gestures — works normally.

**Additional outfits.** Drop any VRM 1.0 model into `vrm/`. The filename becomes
the outfit id.

## If you substitute your own model

Check the model's embedded license before using it in anything you publish.
Most VRM models distributed on BOOTH and similar marketplaces set
`allowRedistribution: false`, which means you may run them locally but may not
commit them to a public repository. You can read any model's terms with:

```bash
node -e "const b=require('fs').readFileSync(process.argv[1]);console.log(JSON.parse(b.slice(20,20+b.readUInt32LE(12)).toString()).extensions.VRMC_vrm.meta)" path/to/model.vrm
```
