# Publishing checklist

This repo is assembled and committed locally but **not yet published**. When you're
ready, follow these steps (or just ask Claude to run them — only the *auth* steps
need you personally).

> Everywhere below, replace `<USER>` with your GitHub username and pick a final npm
> package name (default `dft-autopilot-mcp`; or scoped `@<scope>/dft-autopilot-mcp`).

## 0. Fill in placeholders

The repo ships with `YOUR_GITHUB_USERNAME` placeholders. Replace them all:

```bash
cd /d/WorkSpace/dft-autopilot-oss
git grep -l YOUR_GITHUB_USERNAME            # see which files
grep -rl --null YOUR_GITHUB_USERNAME . | xargs -0 sed -i 's/YOUR_GITHUB_USERNAME/<USER>/g'
```

Files touched: `server/package.json`, `server/server.json`, `server/manifest.json`,
`plugins/dft-autopilot/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`README.md`. If you choose a scoped npm name, also update `name` in `server/package.json`
and `identifier` in `server/server.json` + the `npx` arg in `plugins/dft-autopilot/.mcp.json`.

## 1. GitHub CLI auth (you do this once)

```powershell
winget install --id GitHub.cli -e        # if gh not installed
gh auth login                            # browser / device-code — only you can do this
```

## 2. Create the repo (private first, recommended)

```bash
cd /d/WorkSpace/dft-autopilot-oss
gh repo create dft-autopilot --private --source=. --remote=origin --push
```

Review it on github.com (README, LICENSE, no stray files). When satisfied:

```bash
gh repo edit <USER>/dft-autopilot --visibility public
```

## 3. npm package (the foundation everything else points at)

```bash
npm login                                # you authenticate
cd server
npm install
npm run build
npm publish --access public              # scoped names require --access public
```

Verify: https://www.npmjs.com/package/dft-autopilot-mcp

## 4. Claude Code plugin / marketplace (already in the repo)

Once the repo is public, users install with:

```
/plugin marketplace add <USER>/dft-autopilot
/plugin install dft-autopilot@dft-autopilot-marketplace
```

## 5. MCPB one-click bundle (Claude Desktop)

```bash
npm install -g @anthropic-ai/mcpb
cd server
npm install --production                 # vendor node_modules into the bundle
npm run build
mcpb validate manifest.json
mcpb pack .                              # -> dft-autopilot.mcpb
```

Attach `dft-autopilot.mcpb` as a GitHub Release asset. (Reminder: the bundle ships the
Node server only — pymatgen/ASE and the DFT engines must already be on the user's machine.)

## 6. Official MCP Registry (discovery)

```bash
# install mcp-publisher (see https://modelcontextprotocol.io/registry/quickstart)
cd server
mcp-publisher login github                # GitHub device-code; authorizes io.github.<USER>/*
mcp-publisher publish                      # reads ./server.json
```

`server.json` `name` must equal `package.json` `mcpName` (`io.github.<USER>/dft-autopilot`),
and with GitHub auth it must start with `io.github.<USER>/`.

## 7. Optional discovery

- PR to `punkpeye/awesome-mcp-servers` (one alphabetical line).
- Claim listings on Glama / PulseMCP / Smithery (they ingest the official registry).

---

**Only steps 1 (`gh auth login`), 3 (`npm login`), and 6 (`mcp-publisher login`) need you
personally** — they're authentication. Everything else can be run for you.
