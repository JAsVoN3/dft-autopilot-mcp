#!/usr/bin/env python3
"""plot_chart.py — matplotlib chart backend for dft-autopilot-mcp.

Reads JSON args from stdin (the full tool args object). Writes JSON to stdout:
  success -> {image_path, image_base64, chart_type, style, output_format}
  error   -> {error, traceback}   (exit 1)

Supports: bands, dos, pdos, convergence, gibbs, bands_dos.
Uses the Agg backend (headless). Saves PNG (or svg/pdf) to args.output_path.
"""
import sys
import json
import os
import glob
import base64
import traceback

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# ---- style palettes ----
PALETTES = {
    "nature": ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
               "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"],
    "aps": ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#F0E442",
            "#56B4E9", "#E69F00", "#000000"],
    "acs": ["#0B3D91", "#E63946", "#06A77D", "#F4A261", "#9D4EDD",
            "#1D3557", "#52B788"],
    "dark": ["#5DA5DA", "#FAA43A", "#60BD68", "#F17CB0", "#B2926C",
             "#B276B2", "#DECF6F", "#F15854"],
}


def palette(style):
    return PALETTES.get(style, PALETTES["nature"])


def dark_style(style):
    if style == "dark":
        plt.rcParams.update({
            "axes.facecolor": "#1b1b1b",
            "figure.facecolor": "#1b1b1b",
            "axes.edgecolor": "#cccccc",
            "axes.labelcolor": "#cccccc",
            "xtick.color": "#cccccc",
            "ytick.color": "#cccccc",
            "text.color": "#cccccc",
        })
    else:
        plt.rcParams.update({"axes.facecolor": "white", "figure.facecolor": "white"})


def emit(fig, args):
    """Save figure, print result JSON, close."""
    out_path = args.get("output_path")
    fmt = args.get("output_format", "png")
    if not out_path:
        out_path = os.path.join("/tmp", f"chart.{fmt}")
    dpi = int(args.get("dpi", 300))
    fig.savefig(out_path, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    b64 = ""
    if fmt == "png":
        try:
            with open(out_path, "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode("ascii")
        except Exception:
            b64 = ""
    print(json.dumps({
        "image_path": out_path,
        "image_base64": b64,
        "chart_type": args.get("chart_type"),
        "style": args.get("style", "nature"),
        "output_format": fmt,
    }))


# ---- chart builders ----
def plot_gibbs(args):
    steps = args.get("steps", [])
    style = args.get("style", "nature")
    dark_style(style)
    fig, ax = plt.subplots(figsize=args.get("figsize", [8, 4.5]))
    labels = [s.get("label", str(i)) for i, s in enumerate(steps)]
    energies = [float(s.get("energy", 0.0)) for s in steps]
    xs = list(range(len(steps)))
    # staircase
    ax.step(xs, energies, where="mid", color=palette(style)[0], linewidth=2.2, zorder=3)
    ax.scatter(xs, energies, color=palette(style)[1], s=35, zorder=4)
    # ΔG annotations
    for i in range(1, len(steps)):
        dg = energies[i] - energies[i - 1]
        ax.annotate(f"ΔG={dg:+.2f}", xy=(i - 0.5, max(energies[i], energies[i - 1])),
                    fontsize=8, ha="center", va="bottom",
                    color=palette(style)[3])
    ref = args.get("reference_potential")
    if ref is not None:
        ax.axhline(float(ref), ls="--", color=palette(style)[2], lw=1.2,
                  label=f"平衡电位 {ref} V")
        ax.legend(loc="best", fontsize=8)
    ax.set_xticks(xs)
    ax.set_xticklabels(labels, rotation=20, ha="right", fontsize=8)
    ax.set_ylabel("ΔG (eV)")
    ax.set_title(args.get("title", "自由能台阶图"))
    ax.grid(axis="y", ls=":", alpha=0.4)
    return fig


def _parse_scf_energies(path):
    """Extract per-SCF-iteration total energies (Ry) from a QE scf.out."""
    es = []
    try:
        with open(path) as fh:
            for line in fh:
                if "total energy" in line and "=" in line:
                    try:
                        es.append(float(line.split("=")[-1].strip().split()[0]))
                    except Exception:
                        pass
                elif line.strip().startswith("E(TS)"):
                    try:
                        es.append(float(line.split("=")[-1].strip().split()[0]))
                    except Exception:
                        pass
    except Exception:
        pass
    return es


def plot_convergence(args):
    style = args.get("style", "nature")
    dark_style(style)
    energies = []
    if args.get("data") and isinstance(args["data"], (list, dict)):
        d = args["data"]
        if isinstance(d, dict):
            # extract_dft_results scf shape: energy_history / scf_energies
            energies = d.get("scf_energies") or d.get("energy_history") or []
        else:
            energies = d
    elif args.get("data_file"):
        energies = _parse_scf_energies(args["data_file"])
    if not energies:
        raise RuntimeError("无 SCF 能量数据可绘制（data_file/data 均无有效能量）")
    es = [float(e) for e in energies]
    fig, ax = plt.subplots(figsize=args.get("figsize", [7, 4.5]))
    xs = list(range(1, len(es) + 1))
    ax.plot(xs, es, "-o", color=palette(style)[0], lw=1.8, ms=4)
    ax.set_xlabel("SCF iteration")
    ax.set_ylabel("Total energy (Ry)")
    ax.set_title(args.get("title", "SCF 收敛曲线"))
    ax.grid(ls=":", alpha=0.4)
    return fig


def plot_bands(args):
    style = args.get("style", "nature")
    dark_style(style)
    f = args.get("data_file")
    if not f:
        raise RuntimeError("bands 需要 data_file (.dat.gnu)")
    data = np.loadtxt(f)
    k = data[:, 0]
    bands = data[:, 1:]
    fermi = float(args.get("fermi_energy") or 0.0)
    fig, ax = plt.subplots(figsize=args.get("figsize", [7, 5]))
    for i in range(bands.shape[1]):
        ax.plot(k, bands[:, i] - fermi, color=palette(style)[0], lw=0.8)
    ax.axhline(0, color="gray", lw=0.6, ls="--")
    kp = args.get("k_positions")
    kl = args.get("k_labels")
    if kp and kl:
        ax.set_xticks(kp)
        ax.set_xticklabels(kl)
        for x in kp:
            ax.axvline(x, color="gray", lw=0.5, ls="-", alpha=0.5)
    er = args.get("energy_range", [-6, 6])
    ax.set_ylim(float(er[0]), float(er[1]))
    ax.set_ylabel("E - E_F (eV)")
    ax.set_title(args.get("title", "能带结构"))
    return fig


def plot_dos(args):
    style = args.get("style", "nature")
    dark_style(style)
    f = args.get("data_file")
    if not f and args.get("data"):
        f = args["data_file"]
    if not f:
        raise RuntimeError("dos 需要 data_file (.dos)")
    data = np.loadtxt(f)
    e = data[:, 0]
    fermi = float(args.get("fermi_energy") or 0.0)
    fig, ax = plt.subplots(figsize=args.get("figrama", [6, 5]) if False else [6, 5])
    spin = args.get("spin_resolved")
    if data.shape[1] >= 3 and (spin is True or
                              (spin is None and data.shape[1] >= 4)):
        ax.plot(e - fermi, data[:, 1], color=palette(style)[0], label="up")
        ax.plot(e - fermi, -data[:, 2], color=palette(style)[1], label="down")
        ax.legend(fontsize=8)
    else:
        ax.plot(e - fermi, data[:, 1], color=palette(style)[0])
    ax.axvline(0, color="gray", lw=0.6, ls="--")
    ax.set_xlabel("E - E_F (eV)")
    ax.set_ylabel("DOS (states/eV)")
    ax.set_title(args.get("title", "态密度"))
    er = args.get("energy_range", [-6, 6])
    ax.set_xlim(float(er[0]), float(er[1]))
    return fig


def plot_pdos(args):
    style = args.get("style", "nature")
    dark_style(style)
    wd = args.get("work_dir") or os.path.dirname(args.get("data_file", "") or "")
    if not wd or not os.path.isdir(wd):
        raise RuntimeError("pdos 需要 work_dir 含 .pdos_atm* 文件")
    files = sorted(glob.glob(os.path.join(wd, "*.pdos_atm*")))
    if not files:
        raise RuntimeError(f"未在 {wd} 找到 .pdos_atm* 文件")
    fig, ax = plt.subplots(figsize=args.get("figsize", [7, 5]))
    fermi = float(args.get("fermi_energy") or 0.0)
    elem_filter = args.get("elements_filter") or []
    orb_filter = args.get("orbital_filter") or []
    colors = palette(style)
    ci = 0
    for fp in files:
        try:
            data = np.loadtxt(fp)
        except Exception:
            continue
        e = data[:, 0]
        # header like: #...atom Si 1 ... l=0 ...; derive a label
        label = os.path.basename(fp)
        if elem_filter:
            if not any(el.lower() in label.lower() for el in elem_filter):
                continue
        ax.plot(e - fermi, data[:, 1], color=colors[ci % len(colors)], lw=1.0,
                label=label)
        ci += 1
    ax.axvline(0, color="gray", lw=0.6, ls="--")
    ax.set_xlabel("E - E_F (eV)")
    ax.set_ylabel("pDOS (states/eV)")
    ax.set_title(args.get("title", "投影态密度"))
    er = args.get("energy_range", [-6, 6])
    ax.set_xlim(float(er[0]), float(er[1]))
    if ci <= 12:
        ax.legend(fontsize=7, loc="best")
    return fig


def plot_bands_dos(args):
    style = args.get("style", "nature")
    dark_style(style)
    fig, (axb, axd) = plt.subplots(1, 2, figsize=args.get("figsize", [10, 5]),
                                   sharey=False, gridspec_kw={"width_ratios": [3, 1]})
    # bands
    bf = args.get("bands_data_file")
    fermi = float(args.get("fermi_energy") or 0.0)
    if bf and os.path.exists(bf):
        data = np.loadtxt(bf)
        k = data[:, 0]
        bands = data[:, 1:]
        for i in range(bands.shape[1]):
            axb.plot(k, bands[:, i] - fermi, color=palette(style)[0], lw=0.7)
    axb.axhline(0, color="gray", lw=0.6, ls="--")
    axb.set_ylabel("E - E_F (eV)")
    # dos
    df = args.get("dos_data_file")
    if df and os.path.exists(df):
        d = np.loadtxt(df)
        axd.plot(d[:, 1], d[:, 0] - fermi, color=palette(style)[1])
    axd.axhline(0, color="gray", lw=0.6, ls="--")
    axd.set_xlabel("DOS")
    fig.suptitle(args.get("title", "能带 + DOS"))
    return fig


def main():
    try:
        raw = sys.stdin.read()
        args = json.loads(raw) if raw.strip() else {}
    except Exception:
        print(json.dumps({"error": "无法解析 stdin JSON", "traceback": traceback.format_exc()}))
        sys.exit(1)

    ct = args.get("chart_type")
    try:
        if ct == "gibbs":
            fig = plot_gibbs(args)
        elif ct == "convergence":
            fig = plot_convergence(args)
        elif ct == "bands":
            fig = plot_bands(args)
        elif ct == "dos":
            fig = plot_dos(args)
        elif ct == "pdos":
            fig = plot_pdos(args)
        elif ct == "bands_dos":
            fig = plot_bands_dos(args)
        else:
            raise RuntimeError(f"不支持的 chart_type: {ct}")
        emit(fig, args)
    except Exception:
        print(json.dumps({
            "error": "绘图失败",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
