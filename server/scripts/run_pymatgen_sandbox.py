#!/usr/bin/env python3
"""run_pymatgen_sandbox.py — pymatgen/ASE code sandbox for dft-autopilot-mcp.

Reads JSON from stdin:
  {"code": str, "structure_data": dict|null, "extra_imports": [str]}
Injects pre-imported pymatgen/ASE symbols + helper functions, and (if
structure_data given) a `structure` pymatgen Structure. Executes `code`
with stdout redirected (user print() isolated to _stdout). The code must
assign `result`. Converts result (pymatgen Structure/Molecule | ASE Atoms |
dict | scalar) to a structure_data dict.

Writes JSON to stdout:
  success -> {formula, n_atoms, elements, atoms, cell_parameters,
              coords_are_cartesian, _stdout, [warning], [result_value],
              [_analysis], [_image_base64]}
  error   -> {error, traceback, _stdout}  (exit 1)
"""
import sys
import json
import io
import contextlib
import traceback
from collections import Counter


# ---- conversion helpers (exposed to user code as builtins) ----
def structure_to_dict(struct):
    """pymatgen Structure -> structure_data dict (cartesian Angstrom)."""
    species = [str(sp) for sp in struct.species]
    cart = struct.cart_coords
    cell = struct.lattice.matrix
    c = Counter(species)
    formula = "".join(f"{el}{n if n > 1 else ''}" for el, n in sorted(c.items()))
    return {
        "formula": formula,
        "n_atoms": len(species),
        "elements": sorted(set(species)),
        "atoms": [
            {"element": el, "position": [float(x), float(y), float(z)]}
            for el, (x, y, z) in zip(species, cart.tolist())
        ],
        "cell_parameters": [[float(cell[i][j]) for j in range(3)] for i in range(3)],
        "coords_are_cartesian": True,
    }


def dict_to_structure(d):
    from pymatgen.core import Structure
    cell = d["cell_parameters"]
    species = [a["element"] for a in d["atoms"]]
    coords = [a["position"] for a in d["atoms"]]
    cart = bool(d.get("coords_are_cartesian", False))
    return Structure(cell, species, coords, coords_are_cartesian=cart)


def pmg_to_ase(struct):
    from pymatgen.io.ase import AseAtomsAdaptor
    return AseAtomsAdaptor.get_atoms(struct)


def ase_to_pmg(atoms):
    from pymatgen.io.ase import AseAtomsAdaptor
    return AseAtomsAdaptor.get_structure(atoms)


def ase_to_dict(atoms):
    symbols = list(atoms.get_chemical_symbols())
    positions = atoms.get_positions()
    cell = atoms.get_cell()
    c = Counter(symbols)
    formula = "".join(f"{el}{n if n > 1 else ''}" for el, n in sorted(c.items()))
    return {
        "formula": formula,
        "n_atoms": len(symbols),
        "elements": sorted(set(symbols)),
        "atoms": [
            {"element": s, "position": [float(x), float(y), float(z)]}
            for s, (x, y, z) in zip(symbols, positions.tolist())
        ],
        "cell_parameters": [[float(cell[i][j]) for j in range(3)] for i in range(3)],
        "coords_are_cartesian": True,
    }


def empty_struct():
    return {
        "formula": "",
        "n_atoms": 0,
        "elements": [],
        "atoms": [],
        "cell_parameters": [[0.0, 0.0, 0.0]] * 3,
        "coords_are_cartesian": True,
    }


def main():
    try:
        raw = sys.stdin.read()
        args = json.loads(raw) if raw.strip() else {}
    except Exception:
        print(json.dumps({"error": "无法解析 stdin JSON", "traceback": traceback.format_exc()}))
        sys.exit(1)

    code = args.get("code", "")
    sd = args.get("structure_data")
    extra_imports = args.get("extra_imports", []) or []

    g = {"__name__": "__sandbox__", "__builtins__": __builtins__}
    # pre-installed modules
    try:
        from pymatgen.core import Structure, Lattice, Molecule
        g.update(Structure=Structure, Lattice=Lattice, Molecule=Molecule)
    except Exception:
        pass
    try:
        from pymatgen.analysis.interfaces import SlabGenerator
        g["SlabGenerator"] = SlabGenerator
    except Exception:
        pass
    try:
        from ase import Atoms
        from ase import build
        g.update(Atoms=Atoms, build=build)
    except Exception:
        pass
    import numpy
    g["numpy"] = numpy
    g["np"] = numpy
    g.update(
        dict_to_structure=dict_to_structure,
        structure_to_dict=structure_to_dict,
        pmg_to_ase=pmg_to_ase,
        ase_to_dict=ase_to_dict,
        ase_to_pmg=ase_to_pmg,
    )

    if sd is not None:
        try:
            g["structure"] = dict_to_structure(sd)
        except Exception:
            g["structure"] = None

    for stmt in extra_imports:
        try:
            exec(stmt, g)
        except Exception:
            pass

    captured = ""
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            exec(code, g)
        captured = buf.getvalue()
    except Exception:
        # error path: print JSON {error, traceback, _stdout}, exit 1
        out = {
            "error": "沙盒代码执行异常",
            "traceback": traceback.format_exc(),
            "_stdout": captured[:2000],
        }
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(1)

    result = g.get("result", None)
    out = {}
    try:
        from pymatgen.core import Structure, Molecule
        if result is None:
            out = empty_struct()
            out["warning"] = "代码未将结果赋值给 result 变量"
        elif isinstance(result, Structure):
            out = structure_to_dict(result)
        elif isinstance(result, Molecule):
            species = [str(s) for s in result.species]
            cart = result.cart_coords
            cc = Counter(species)
            formula = "".join(f"{el}{n if n > 1 else ''}" for el, n in sorted(cc.items()))
            out = {
                "formula": formula,
                "n_atoms": len(species),
                "elements": sorted(set(species)),
                "atoms": [
                    {"element": el, "position": [float(x), float(y), float(z)]}
                    for el, (x, y, z) in zip(species, cart.tolist())
                ],
                "cell_parameters": [[10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]],
                "coords_are_cartesian": True,
            }
        elif hasattr(result, "get_chemical_symbols"):
            out = ase_to_dict(result)
        elif isinstance(result, dict):
            out = dict(result)
            out.setdefault("coords_are_cartesian", True)
        else:
            out = empty_struct()
            out["warning"] = f"result 类型 {type(result).__name__} 非结构对象，无法提取结构"
            out["result_value"] = str(result)
    except Exception:
        out = empty_struct()
        out["warning"] = f"结果转换失败: {traceback.format_exc().splitlines()[-1]}"

    out["_stdout"] = captured[:2000]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
