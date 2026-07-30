#!/usr/bin/env python3
"""import_structure.py — structure-file importer for dft-autopilot-mcp.

Reads JSON from stdin: {"file_path": str, "file_format": str|None}
Writes JSON to stdout: a structure_data dict consumable by create_qe_input:
  {formula, n_atoms, elements, atoms:[{element, position:[x,y,z]}],
   cell_parameters:[[...]], coords_are_cartesian: bool}

Uses ASE (auto-detects cif/poscar/contcar/vasp/xyz/pdb). On error prints
JSON {error, traceback} to stdout and exits 1 (the JS bridge parses it).
"""
import sys
import json
import traceback
from collections import Counter


def structure_to_dict(struct):
    """pymatgen Structure -> structure_data dict (cartesian Angstrom)."""
    species = [str(sp) for sp in struct.species]
    cart = struct.cart_coords
    cell = struct.lattice.matrix
    c = Counter(species)
    formula = "".join(
        f"{el}{n if n > 1 else ''}" for el, n in sorted(c.items())
    )
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


def to_structure_data(atoms):
    symbols = list(atoms.get_chemical_symbols())
    positions = atoms.get_positions()
    cell = atoms.get_cell()
    atoms_list = [
        {"element": s, "position": [float(x), float(y), float(z)]}
        for s, (x, y, z) in zip(symbols, positions.tolist())
    ]
    # ASE cell may be 3x3; coerce to plain floats
    cell_params = [[float(cell[i][j]) for j in range(3)] for i in range(3)]
    c = Counter(symbols)
    formula = "".join(
        f"{el}{n if n > 1 else ''}" for el, n in sorted(c.items())
    )
    return {
        "formula": formula,
        "n_atoms": len(atoms_list),
        "elements": sorted(set(symbols)),
        "atoms": atoms_list,
        "cell_parameters": cell_params,
        "coords_are_cartesian": True,
    }


def _from_pymatgen(fp, fmt):
    """Try pymatgen (lenient CIF/POSCAR, applies symmetry). Returns Atoms-like or None."""
    try:
        from pymatgen.core import Structure
        if fmt and fmt.lower() in ("cif", "poscar", "vasp", "contcar", "json"):
            return Structure.from_file(fp)  # Structure object
        if fmt is None:
            return Structure.from_file(fp)  # auto-detect by extension
    except Exception:
        return None
    return None


def _atoms_from_ase(fp, fmt):
    from ase.io import read as ase_read
    return ase_read(fp, format=fmt) if fmt else ase_read(fp)


def main():
    try:
        raw = sys.stdin.read()
        args = json.loads(raw) if raw.strip() else {}
    except Exception:
        print(json.dumps({"error": "无法解析 stdin JSON", "traceback": traceback.format_exc()}))
        sys.exit(1)

    fp = args.get("file_path")
    fmt = args.get("file_format")
    if not fp:
        print(json.dumps({"error": "缺少 file_path"}))
        sys.exit(1)

    # 1) pymatgen first (lenient, symmetry-aware for CIF/POSCAR)
    pmg_obj = _from_pymatgen(fp, fmt)
    if pmg_obj is not None:
        try:
            data = structure_to_dict(pmg_obj)
            print(json.dumps(data))
            return
        except Exception:
            pass  # fall through to ASE

    # 2) ASE fallback (xyz/pdb/cif/vasp ...)
    try:
        atoms = _atoms_from_ase(fp, fmt)
        data = to_structure_data(atoms)
        print(json.dumps(data))
    except Exception:
        print(json.dumps({
            "error": f"导入结构失败: {fp}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
