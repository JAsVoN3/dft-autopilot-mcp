# DFT AutoPilot

**English** | [简体中文](README.zh-CN.md)

> Run first-principles DFT calculations (Quantum ESPRESSO · VASP · Gaussian) from a chat client — on **your own** HPC. An MCP server + a Claude skill that turns *"compute the DOS of NiO with Hubbard U"* into a full **model → compute → analyze → report** workflow.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)

DFT AutoPilot is **BYO‑HPC** (Bring Your Own HPC): it provides the *orchestration* — input generation, job submission, result extraction, literature/materials lookup, plotting and reporting — and runs everything on a compute backend **you** configure: a national SuperComputing network (SCNet), **any Slurm cluster over SSH**, or your **local** machine. It ships with **no** compute account of its own.

---

## ⚠️ Disclaimer & responsibility (read this)

DFT AutoPilot only orchestrates calculations using **credentials and compute allocations that you supply**. By using it you understand and agree that:

- **You run jobs on your own account / HPC allocation, at your own cost and risk.** You are solely responsible for all compute charges, resource usage, job behavior, and data produced.
- **You are responsible for complying with the Terms of Service of your compute provider** (e.g. your supercomputing center, SCNet, or institutional cluster), and with the licenses of the DFT engines you use (Quantum ESPRESSO is GPL; **VASP and Gaussian are proprietary and require your own valid license**).
- This software is provided **"AS IS", without warranty of any kind**, under the Apache‑2.0 License. The authors are **not liable** for compute costs, wasted allocation, data loss, failed or incorrect calculations, or any damages arising from its use (see LICENSE sections 7–8).
- The maintainers run **no hosted service** and have access to **none** of your accounts or data. This project is **not affiliated with or endorsed by** SCNet, the Quantum ESPRESSO project, VASP, or Gaussian.

Scientific results must be validated by a qualified researcher. An automated agent can make physics mistakes — always review the plan and the numbers.

---

## Features

- **3 engines**: Quantum ESPRESSO, VASP, Gaussian 16 — input generation, submission, and result parsing for each.
- **BYO‑HPC backends**: `local` · `slurm` (any Slurm cluster over SSH) · `scnet` (national SuperComputing network, with your own account).
- **19 MCP tools** covering the whole pipeline (see below).
- **`dft-compute` skill**: an autonomous "computational chemist" workflow with a mandatory plan‑before‑compute review and per‑parameter `_reasons` auditing.
- **Knowledge built in**: SSSP cutoff recommendations, DFT+U guidance, QE/VASP parameter references, troubleshooting notes.

### Tools

| Group | Tools |
|------|------|
| QE | `create_qe_input`, `extract_dft_results`, `lookup_pseudopotential`, `lookup_hubbard_u`, `import_structure` |
| VASP | `create_vasp_input`, `extract_vasp_results` |
| Gaussian | `create_gaussian_input`, `extract_gaussian_results` |
| Jobs (backend‑agnostic) | `submit_compute_job`, `check_job_status`, `download_job_results`, `preview_remote_file`, `cancel_job` |
| Helpers | `run_pymatgen`, `plot_chart`, `write_report`, `search_literature`, `search_materials` |

---

## Prerequisites

- **Node.js ≥ 18** (the MCP server is Node/TypeScript).
- For `run_pymatgen`, `import_structure`, and structure handling: **Python 3** with `pymatgen` and `ase` installed and on `PATH`.
- The **DFT engines** themselves on your chosen backend (QE / VASP / Gaussian — obtained and licensed by you).
- For `slurm`: **passwordless SSH** to your cluster's login node. For `scnet`: your own **SCNet account** (AccessKey/SecretKey).

> The MCP install does **not** install Python, the engines, or pseudopotentials — those are yours to provide.

---

## Install

### A. Claude Code plugin (recommended — skill + server in one)

```
/plugin marketplace add The66user/dft-autopilot-mcp
/plugin install dft-autopilot@dft-autopilot-marketplace
```

You'll be prompted for configuration (compute backend, API keys) at install time; secrets are stored in your OS keychain.

### B. Any MCP client via npm (e.g. Claude Code CLI)

```bash
claude mcp add --env COMPUTE_PROVIDER=local --env MP_API_KEY=YOUR_KEY \
  dft-autopilot -- npx -y dft-autopilot-mcp
```

### C. Claude Desktop (`claude_desktop_config.json`)

```jsonc
{
  "mcpServers": {
    "dft-autopilot": {
      "command": "npx",
      "args": ["-y", "dft-autopilot-mcp"],
      "env": {
        "COMPUTE_PROVIDER": "local",
        "MP_API_KEY": "YOUR_MATERIALS_PROJECT_KEY"
      }
    }
  }
}
```

A one‑click **`.mcpb`** bundle is also attached to GitHub Releases (Claude Desktop → Settings → Extensions). Note: the `.mcpb` bundles the Node server only — Python/pymatgen and the DFT engines must already be on your machine.

---

## Configure the compute backend

Set `COMPUTE_PROVIDER` and the matching variables (full list in [`server/.env.example`](server/.env.example)).

### `local`
Runs on this machine. Requires the engines installed locally.
```
COMPUTE_PROVIDER=local
```

### `slurm` — any Slurm cluster over SSH
```
COMPUTE_PROVIDER=slurm
SLURM_HOST=you@login.cluster.edu        # or a ~/.ssh/config alias; passwordless SSH required
SLURM_REMOTE_BASE_DIR=/scratch/you/dft-autopilot
SLURM_PARTITION=cpu
SLURM_MODULES=module load quantum-espresso/7.4
SLURM_PSEUDO_DIR=/scratch/you/pseudo    # optional: rewrites QE pseudo_dir
```

### `scnet` — national SuperComputing network (your own account)
```
COMPUTE_PROVIDER=scnet
SCNET_USER=...
SCNET_ACCESS_KEY=...
SCNET_SECRET_KEY=...
SCNET_CLUSTER_ID=...
SCNET_HPC_URL=...
SCNET_EFILE_URL=...
# ...see .env.example for the full set
```

> **No credentials are bundled.** Whatever backend you pick runs under *your* account.

---

## Connecting your DFT engines

DFT AutoPilot **calls** engines you have already installed — it never bundles or installs them. This section is only about **how the orchestrator finds and runs them** on each backend. (Compiling QE, or installing a licensed VASP/Gaussian build, is out of scope — see each engine's own docs.)

### `local`
Jobs run through `bash -lc` (your **login shell**), so the executables (`pw.x`, `vasp_std`, `g16`, …) just need to be on `PATH` in a login shell. Easiest is to activate the environment in your `~/.bashrc`:

```bash
# ~/.bashrc
conda activate qe          # or: module load quantum-espresso/7.4
```

- **QE pseudopotentials:** the `pseudo_dir` in the generated `.in` should point at your local UPF folder (`QE_PSEUDO_DIR`, or set it when generating input).
- **VASP:** make sure `POTCAR` is present in the job directory.

### `slurm`
Engines are loaded **inside the generated sbatch script** from `SLURM_MODULES` (and optionally `SLURM_QE_BIN_DIR`, prepended to `PATH`):

```
SLURM_MODULES=module load quantum-espresso/7.4; module load vasp/6.4
SLURM_QE_BIN_DIR=/opt/qe/bin            # optional, if the binaries aren't in a module
```

- **QE pseudopotentials:** set `SLURM_PSEUDO_DIR` — the `pseudo_dir` in your `.in` is **rewritten to this path automatically** at submit time.
- **VASP:** place `POTCAR` in the job dir (it's uploaded with the inputs); the Slurm backend does not assemble POTCAR from a library.

### `scnet`
Each engine loads from an env script you point it at; for VASP, `POTCAR` is auto-assembled from a library by element:

```
SCNET_QE_ENV_SCRIPT=/path/to/qe-env.sh        SCNET_QE_PATH=/path/to/pw.x
SCNET_PSEUDO_DIR=/path/to/pseudo
SCNET_VASP_ENV_SCRIPT=/path/to/vasp-env.sh    SCNET_POTCAR_DIR=/path/to/potcar-library
SCNET_GAUSSIAN_ENV_SCRIPT=/path/to/g16-env.sh
```

> Full variable list with comments: [`server/.env.example`](server/.env.example).

---

## Usage

Talk to your client in plain language — the `dft-compute` skill drives the whole pipeline. By default it **researches parameters, shows you a plan, and waits for your approval**, then generates inputs, submits to your backend, monitors, downloads, parses results, and writes a report. Every parameter it picks comes with a cited reason.

### A typical session

> **You:** Relax bulk Si with Quantum ESPRESSO, then compute its band structure, on my Slurm cluster.
>
> **Agent:** *(looks up SSSP cutoffs, scans literature)* Here's the plan:
> 1. `vc-relax` — ecutwfc 50 / ecutrho 400 Ry (SSSP efficiency), 8×8×8 k-grid
> 2. `scf` on the relaxed structure
> 3. `bands` along Γ–X–W–K–Γ–L
> 16 cores, ≈20 min. **Approve?**
>
> **You:** go
>
> **Agent:** *(generates inputs → submits → monitors → downloads → parses)* Done. Indirect gap **≈0.6 eV** (Γ→X), relaxed a = 5.47 Å. Report at `Si_bulk/report.md`, band plot under `Si_bulk/04_bands/`.

### More things you can ask

- *"Optimize a water molecule with Gaussian at B3LYP/6-311+G(d,p), then a frequency check."*
- *"Compute the DOS of NiO with Hubbard U — look up the U value first."*
- *"Find the Li-diffusion NEB barrier between these two structures with VASP."*

> Want to skip the review and run immediately? Just say so (e.g. "skip the plan, go ahead").

---

## License

Apache‑2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third‑party data/engine attributions (SSSP, QE/VASP/Gaussian) are in NOTICE.

Personal and academic use is free. If you'd like commercial support, a managed/end‑to‑end DFT service, or to collaborate, see the contact in the repository profile.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Installing any plugin runs code that talks to your HPC with your credentials — review the source and only configure backends you trust.
