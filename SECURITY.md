# Security Policy

**English** | [简体中文](SECURITY.zh-CN.md)

## How DFT AutoPilot handles credentials & compute

- The server reads **all** credentials from environment variables (or your client's secure config / OS keychain). It bundles **no** account, key, IP, or allocation of its own.
- It connects **only** to the compute backend **you** configure, using **your** credentials, and acts under **your** account.
- The maintainers run no hosted service and never receive your keys, jobs, or data.

## What you are trusting when you install

Installing this MCP server / plugin lets an AI client:
- run shell commands on whatever backend you configure (`local` runs on **this machine**; `slurm`/`scnet` run on **your** cluster under **your** account);
- read/write files in the configured workspace and on the remote job directories;
- submit, monitor, and cancel HPC jobs that **consume your allocation and may incur cost**.

Only configure backends and directories you trust the client to operate, and review the source. There is **no warranty**; see the Disclaimer in the README and the Apache‑2.0 LICENSE (sections 7–8).

## Hardening recommendations

- Prefer a **dedicated SSH key** for `SLURM_HOST` with a restricted remote account; the provider runs SSH in `BatchMode` (no interactive password).
- Scope HPC credentials to the minimum needed; rotate them if exposed.
- Keep your real `.env` out of version control (it is git‑ignored; only `.env.example` ships).
- Review job plans before approving — the `dft-compute` skill requires a plan‑before‑compute step by default.

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories ("Report a vulnerability" on the repo's Security tab) rather than a public issue. Include reproduction steps and impact. We aim to acknowledge within a few days.

Agent Skills and MCP tool execution may not be covered by any data‑retention guarantees of your AI client — avoid running this on sensitive/confidential inputs unless your client and backend meet your data‑handling requirements.
