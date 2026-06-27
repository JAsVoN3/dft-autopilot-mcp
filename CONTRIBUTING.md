# Contributing to DFT AutoPilot

Thanks for your interest! This document covers the architecture and conventions.

## Repository layout

```
dft-autopilot/
├── server/                      # the MCP server (published to npm as dft-autopilot-mcp)
│   ├── src/
│   │   ├── mcp-server.ts        # entry point (stdio MCP server)
│   │   ├── config.ts            # all config from env vars
│   │   ├── compute/             # ComputeProvider abstraction (BYO-HPC)
│   │   │   ├── provider.ts      #   interface + shared types
│   │   │   ├── scnet-provider.ts
│   │   │   ├── slurm-ssh-provider.ts
│   │   │   ├── local-provider.ts
│   │   │   └── index.ts         #   getComputeProvider() factory
│   │   ├── infra/scnet-manager.ts
│   │   └── tools/               # the MCP tools (one class per tool, extends DFTTool)
│   ├── knowledge/               # bundled reference data (SSSP, params, tutorials)
│   ├── templates/               # QE input templates (.in.j2)
│   ├── server.json              # official MCP Registry metadata
│   └── manifest.json            # MCPB (Claude Desktop) bundle manifest
├── plugins/dft-autopilot/       # the Claude Code plugin (skill + server)
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   └── skills/dft-compute/SKILL.md
└── .claude-plugin/marketplace.json
```

## Build & run

```bash
cd server
npm install
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm run dev        # tsx src/mcp-server.ts (for local dev)
```

## Adding a compute backend

Implement the `ComputeProvider` interface (`server/src/compute/provider.ts`) and register it in the `getComputeProvider()` factory. The 10 methods cover submit / status / download / preview / list / cancel — the job tools call only this interface, never a specific backend. `slurm-ssh-provider.ts` (system `ssh`/`scp` + `sbatch`/`squeue`/`sacct`/`scancel`) is a good template.

## Tool conventions

- Each tool is a class extending `DFTTool` with `name`, `description`, `inputSchema`, and `execute()`. Keep tools single‑purpose.
- **`_reasons` audit (important):** `create_qe_input` / `create_vasp_input` / `create_gaussian_input` require a `_reasons` map justifying every physical parameter (cutoff, U value, smearing, magnetism, …). This is a core design principle — every parameter choice must be traceable to a source. Do not weaken or bypass it.
- Stdout carries **only** JSON‑RPC; all logging goes to stderr (`mcp-server.ts` hijacks `console.log`). Keep it that way.

## Conventions

- TypeScript `strict`; ESM (`"type": "module"`, `.js` import specifiers).
- No secrets, accounts, IPs, or personal paths in committed code — everything sensitive comes from env vars. CI / review should reject hardcoded credentials.
- Match the surrounding comment style and density.

## Pull requests

- Run `npm run typecheck` before submitting.
- Describe what you changed and how you tested it (which backend, which engine).
- By contributing, you agree your contributions are licensed under Apache‑2.0.
