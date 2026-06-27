/**
 * create_qe_input — 创建 QE 输入文件（参数审计版）
 *
 * 工具只负责"机械性组装"，所有 QE 物理参数由 Agent 决定。
 * 每个参数必须附带独立的 _reasons 论证，否则工具拒绝生成。
 *
 * 完整移植自 Python 版 create_qe_input.py，功能无删减。
 */

import { DFTTool, type ToolResult } from "./base.js";
import { getSpeciesInfo, getMaxCutoffs, getTotalValenceElectrons } from "./data/sssp-db.js";
import { appConfig } from "../config.js";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname, basename, resolve } from "path";

// NOTE: 以下参数由工具从结构数据和 calc_type 自动推导，Agent 无法控制
// NOTE: 以下参数由工具自动处理或属于样板配置，Agent 无需提供 _reasons
const AUTO_PARAMS = new Set([
  "ibrav", "nat", "ntyp", "calculation",
  // 路径/IO 类样板参数，无需科学论证
  "pseudo_dir", "outdir", "prefix", "restart_mode", "verbosity",
  "tprnfor", "tstress", "disk_io", "max_seconds", "nstep",
  // 优化算法参数（有固定默认值）
  "ion_dynamics", "cell_dynamics", "conv_thr",
]);

// NOTE: HUBBARD 卡片中元素→壳层映射
const SHELL_MAP: Record<string, string> = {
  Sc: "3d", Ti: "3d", V: "3d", Cr: "3d", Mn: "3d",
  Fe: "3d", Co: "3d", Ni: "3d", Cu: "3d", Zn: "3d",
  Mo: "4d", Ru: "4d", Rh: "4d", Pd: "4d", Ag: "4d",
  Ce: "4f",
};

/**
 * 从自定义 species 标签提取纯元素符号
 * 支持 AFM 等场景下的 Ni1/Ni2、Fe_up/Fe_dn 等标记
 *
 * 策略：从标签开头提取 1-2 个字母组成的合法元素符号
 * 例如：Ni1 → Ni, Fe_up → Fe, O → O, Co2 → Co
 */
function extractBaseElement(label: string): string {
  // 尝试匹配 1-2 个字母开头（首字母大写 + 可选小写字母）
  const match = label.match(/^([A-Z][a-z]?)/);
  return match ? match[1] : label;
}

interface Atom {
  element: string;
  symbol?: string;
  species?: string;
  position?: number[];
  x?: number;
  y?: number;
  z?: number;
  /** 选择性动力学：true = 完全固定（0 0 0） */
  fixed?: boolean;
  /** 选择性动力学：精细控制各方向 [0,1,0] = 只允许 y 方向移动 */
  if_pos?: number[];
}

export class CreateQEInputTool extends DFTTool {
  readonly name = "create_qe_input";

  readonly description =
    "根据参数生成 QE 输入文件。工具自动处理 nat/ntyp/赝势匹配/原子坐标/HUBBARD 卡。\n\n" +
    "**参数审计机制**：control / system / electrons / hubbard 中每个物理参数，\n" +
    "都必须在同一 dict 的 `_reasons` 子字典中有对应条目，否则工具拒绝生成。\n" +
    "`_reasons` 不会出现在 QE 输入文件中，仅用于审计。\n\n" +
    "调用示例：\n" +
    "```\n" +
    "create_qe_input(\n" +
    "  calc_type='relax',\n" +
    "  structure_data=...,\n" +
    "  kpoints=[3,3,1],\n" +
    "  kpoints_reason='a≈9.84Å → k_spacing=1/(9.84×3)≈0.034 1/Å < 0.04 阈值',\n" +
    "  system={\n" +
    "    'ecutwfc': 50, 'ecutrho': 400, 'nspin': 2,\n" +
    "    'assume_isolated': '2D', 'vdw_corr': 'dft-d3',\n" +
    "    '_reasons': {\n" +
    "      'ecutwfc': 'SSSP efficiency Co PAW 45 Ry + N rrkjus 余量 → 50',\n" +
    "      'ecutrho': '8x ecutwfc (PAW 标准)',\n" +
    "      'nspin': 'Co²⁺ d⁷ 有未配对电子',\n" +
    "      'assume_isolated': '2D 库仑截断消除镜像偶极',\n" +
    "      'vdw_corr': 'DFT-D3(BJ) Grimme 2010, 石墨烯 vdW 必需'\n" +
    "    }\n" +
    "  },\n" +
    "  control={'forc_conv_thr': 0.001, '_reasons': {'forc_conv_thr': 'relax 标准阈值'}},\n" +
    "  electrons={'mixing_beta': 0.3, '_reasons': {'mixing_beta': '磁性体系需保守值 ≤0.3'}},\n" +
    "  hubbard={'U': {'Co-3d': 3.32}, '_reasons': {'U_Co-3d': 'Wang PRB 2006'}}\n" +
    ")\n" +
    "```\n" +
    "注意：ibrav/nat/ntyp/calculation 由工具自动推导，不需要 _reasons。\n" +
    "pseudo_dir/outdir/prefix/ion_dynamics/cell_dynamics 有默认值，Agent 可按需覆盖并提供 _reasons。\n\n" +
    "**选择性动力学（Slab 固定底层原子）**：\n" +
    "在 atoms 数组中设置 `fixed: true`（完全固定 0 0 0）或 `if_pos: [0, 1, 0]`（精细控制各方向）。\n" +
    "例如 Pt(111) slab 计算：底层 2 层固定，表面 2 层弛豫。";

  readonly inputSchema = {
    type: "object",
    properties: {
      calc_type: {
        type: "string",
        enum: [
          "scf", "relax", "vc-relax", "nscf", "bands", "dos",
          "projwfc", "pp-charge",
          "dos-post", "bands-post", "phonon", "hp", "epsilon", "neb",
        ],
        description:
          "计算类型。pw.x 系列: scf/relax/vc-relax/nscf/bands/dos（需要 structure_data）。\n" +
          "后处理系列: projwfc(pDOS)/pp-charge(电荷密度)/dos-post(dos.x)/bands-post(bands.x)/" +
          "phonon(ph.x)/hp(hp.x)/epsilon(epsilon.x)（不需要 structure_data，参数通过 post_process 传入）。\n" +
          "NEB 过渡态: neb（需要 structure_data + structure_data_final 两套结构）。",
      },
      structure_data: {
        type: "object",
        description:
          "结构数据。必须包含 atoms 数组和 cell_parameters 矩阵。\n" +
          "atoms[].element: 元素符号或自定义 species 标签（Ni1/Ni2），工具自动提取纯元素符号匹配赝势。\n" +
          "atoms[].position: [x, y, z] 坐标数组。\n" +
          "cell_parameters: 3×3 晶胞矩阵 [[a1,a2,a3],[b1,b2,b3],[c1,c2,c3]]（Å）。也可用 lattice 字段。\n" +
          "coords_are_cartesian: 布尔值。true=笛卡尔坐标(Å)，false=分数坐标。默认 true。\n" +
          "position_units: 字符串替代方式，'crystal'=分数坐标，'angstrom'=笛卡尔坐标。\n" +
          "示例: {atoms:[{element:'Si',position:[0,0,0]},{element:'Si',position:[0.25,0.25,0.25]}]," +
          "cell_parameters:[[5.43,0,0],[0,5.43,0],[0,0,5.43]], coords_are_cartesian:false}",
      },
      kpoints: {
        type: "array", items: { type: "integer" },
        description: "K 网格 [k1,k2,k3] 或含偏移 [k1,k2,k3,s1,s2,s3]，默认偏移为 0 0 0",
      },
      kpoints_reason: {
        type: "string",
        description: "K 网格选择理由。必须包含 k_spacing 计算过程：\n例: 'a≈9.84 Å → k_spacing = 1/(9.84×3) ≈ 0.034 1/Å < 0.04 阈值'",
      },
      control: {
        type: "object",
        description: "&CONTROL 参数。必须包含 _reasons 字典，键为参数名，值为该参数的选择依据。",
      },
      system: {
        type: "object",
        description: "&SYSTEM 参数。必须包含 _reasons 字典，为每个物理参数逐一论证。",
      },
      electrons: {
        type: "object",
        description: "&ELECTRONS 参数。必须包含 _reasons 字典。",
      },
      ions: { type: "object", description: "&IONS 参数（可不含 _reasons）" },
      cell: { type: "object", description: "&CELL 参数（可不含 _reasons）" },
      hubbard: {
        type: "object",
        description: "HUBBARD 卡片参数。必须包含 _reasons 字典。",
      },
      pseudo_map: {
        type: "object",
        description:
          "自定义 species→赝势文件映射。AFM 体系中磁不等价原子共用同一赝势时必须提供。\n" +
          "示例: { \"Ni1\": \"Ni.pbe-spn-kjpaw_psl.1.0.0.UPF\", \"Ni2\": \"Ni.pbe-spn-kjpaw_psl.1.0.0.UPF\" }",
      },
      mass_map: {
        type: "object",
        description:
          "自定义 species→原子质量映射。\n" +
          "示例: { \"Ni1\": 58.693, \"Ni2\": 58.693 }",
      },
      output_dir: {
        type: "string",
        description: "输出目录（相对于 workspace）。如 'NiO_AFM_U/01_vcrelax'，文件将写入该子目录。",
      },
      constraints: {
        type: "string",
        description:
          "可选。CONSTRAINTS 卡片原始内容（不含 CONSTRAINTS 标题行）。\n" +
          "格式: 第一行 'nconstr constr_tol'，后续每行一个约束。\n" +
          "示例: '1 0.01\n\'distance\' 1 2 2.5'",
      },
      occupations_card: {
        type: "string",
        description:
          "可选。OCCUPATIONS 卡片原始内容（不含 OCCUPATIONS 标题行）。\n" +
          "仅当 system.occupations='from_input' 时使用。\n" +
          "每行为一个 k 点的占据数列表。",
      },
      atomic_forces: {
        type: "string",
        description:
          "可选。ATOMIC_FORCES 卡片原始内容（不含 ATOMIC_FORCES 标题行）。\n" +
          "格式: 每行 'Element fx fy fz'（单位 Ry/au）。",
      },
      post_process: {
        type: "object",
        description:
          "后处理/非 pw.x 类型的专用参数。所有后处理类型均可在此传入 prefix 和 outdir（优先于 control 中的值）。\n" +
          "各类型可用参数：\n" +
          "projwfc: {prefix, outdir, degauss, Emin, Emax, DeltaE, filpdos}\n" +
          "pp-charge: {prefix, outdir, plot_num, filplot, iflag, output_format, fileout}\n" +
          "dos-post: {prefix, outdir, fildos, degauss, Emin, Emax, DeltaE}\n" +
          "bands-post: {prefix, outdir, filband, lsym, spin_component}\n" +
          "phonon: {prefix, outdir, tr2_ph, ldisp, nq1, nq2, nq3, fildyn, alpha_mix, niter_ph, recover}\n" +
          "hp: {prefix, outdir, nq1, nq2, nq3, conv_thr_chi, find_atpert}\n" +
          "epsilon: {prefix, outdir, calculation('eps'/'jdos'/'offdiag'), broadening, nw, wmin, wmax}\n" +
          "示例: {plot_num: 17} 使用 PAW 全电子密度重构（Bader 分析必须）",
      },
      structure_data_final: {
        type: "object",
        description:
          "NEB 终态结构数据（仅 neb 类型必须）。格式与 structure_data 完全一致。\n" +
          "NEB 需要初始态（structure_data）和终态（structure_data_final）两套原子坐标。",
      },
      neb_path: {
        type: "object",
        description:
          "NEB &PATH namelist 参数（仅 neb 类型使用）。\n" +
          "可用参数: {string_method, nstep_path, num_of_images, CI_scheme, opt_scheme, " +
          "ds, path_thr, first_last_opt}\n" +
          "示例: {num_of_images: 7, CI_scheme: 'auto', nstep_path: 50}",
      },
      description: {
        type: "string",
        description: "整体计算科学目的（不是参数论证，参数论证在各 _reasons 中）",
      },
      kpath: {
        type: "array",
        description:
          "能带计算高对称 K 路径（仅 calc_type='bands' 必须）。\n" +
          "数组中每个元素: {point: [kx,ky,kz], label: 'G', npts: 40}\n" +
          "其中 npts 为该段到下一个高对称点之间的采样点数（最后一个点的 npts 设为 0）。\n" +
          "示例: [{point:[0,0,0], label:'G', npts:40}, {point:[0.5,0,0.5], label:'X', npts:40}, " +
          "{point:[0.5,0.25,0.75], label:'W', npts:0}]",
        items: {
          type: "object",
          properties: {
            point: { type: "array", items: { type: "number" } },
            label: { type: "string" },
            npts: { type: "integer" },
          },
        },
      },
    },
    required: ["calc_type"],
  };

  // NOTE: 不需要结构数据的后处理类型（projwfc / pp-charge 也属于后处理）
  private static readonly POST_ONLY_TYPES = new Set([
    "projwfc", "pp-charge",
    "dos-post", "bands-post", "phonon", "hp", "epsilon",
  ]);

  validateInput(args: Record<string, unknown>): string | null {
    const valid = new Set([
      "scf", "relax", "vc-relax", "nscf", "bands", "dos",
      "projwfc", "pp-charge",
      "dos-post", "bands-post", "phonon", "hp", "epsilon", "neb",
    ]);
    if (!valid.has(args.calc_type as string)) {
      return `不支持的计算类型: ${args.calc_type}`;
    }
    const calcType = args.calc_type as string;
    // NOTE: 后处理类型不需要结构数据
    if (!CreateQEInputTool.POST_ONLY_TYPES.has(calcType)) {
      const sd = args.structure_data as Record<string, unknown> | undefined;
      if (!sd?.atoms) {
        return "structure_data 必须包含 atoms 字段";
      }
    }
    // NOTE: NEB 需要两套结构
    if (calcType === "neb") {
      const sdFinal = args.structure_data_final as Record<string, unknown> | undefined;
      if (!sdFinal?.atoms) {
        return "NEB 计算需要 structure_data_final（终态结构），格式与 structure_data 一致";
      }
    }
    // NOTE: bands 类型必须提供高对称 K 路径，不能用 automatic K 网格
    if (calcType === "bands" && !args.kpath) {
      return (
        "bands 计算需要指定高对称 K 路径（kpath 参数）。\n" +
        "请提供 kpath 数组，每个元素: {point: [kx,ky,kz], label: 'G', npts: 40}。\n" +
        "可使用 run_pymatgen 调用 pymatgen 的 HighSymmKpath 自动生成标准路径。\n" +
        "示例 FCC: [{point:[0,0,0], label:'Γ', npts:40}, {point:[0.5,0.5,0], label:'X', npts:40}, ...]"
      );
    }
    return null;
  }

  /**
   * 校验 namelist 中每个物理参数是否有对应的 _reasons 条目。
   * 返回缺失理由的参数名列表。
   */
  private validateReasons(namelistName: string, params: Record<string, unknown>): string[] {
    if (!params) return [];
    const reasons = (params._reasons ?? {}) as Record<string, unknown>;
    const missing: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      // 跳过内部字段、reason 本身、以及工具自动设置的参数
      if (k.startsWith("_") || k === "reason" || AUTO_PARAMS.has(k)) continue;
      // 跳过嵌套结构（如 HUBBARD 的 U: {"Co-3d": 3.3}）
      if (typeof v === "object" && v !== null) continue;
      if (!(k in reasons)) {
        missing.push(k);
      }
    }
    return missing;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const calcType = args.calc_type as string;

    // --- 简单后处理类型：无需结构数据/审计，直接生成 namelist ---
    if (CreateQEInputTool.POST_ONLY_TYPES.has(calcType)) {
      return this.executeSimplePost(calcType, args);
    }

    // --- NEB 过渡态：特殊格式，需要两套结构 ---
    if (calcType === "neb") {
      return this.executeNEB(args);
    }

    // --- 以下为需要结构数据的标准 pw.x / projwfc / pp 类型 ---
    const sd = args.structure_data as Record<string, unknown>;
    const kpoints = (args.kpoints as number[]) ?? [4, 4, 1];
    const kpointsReason = (args.kpoints_reason as string) ?? "";
    const desc = (args.description as string) ?? "";
    const ctrlP = (args.control ?? {}) as Record<string, unknown>;
    const sysP = (args.system ?? {}) as Record<string, unknown>;
    const elecP = (args.electrons ?? {}) as Record<string, unknown>;
    const ionsP = (args.ions ?? {}) as Record<string, unknown>;
    const cellP = (args.cell ?? {}) as Record<string, unknown>;
    const hubP = (args.hubbard ?? {}) as Record<string, unknown>;

    // NOTE: A9 修复 — 检测旧版 Hubbard 参数，QE 7.4 已不兼容 lda_plus_u 语法
    const systemArgs = sysP as Record<string, unknown>;
    const oldHubbardKeys = Object.keys(systemArgs).filter(k =>
      k.startsWith("lda_plus_u") || k === "Hubbard_U" || k === "Hubbard_J" ||
      k === "Hubbard_J0" || k === "Hubbard_alpha" || k === "Hubbard_beta",
    );
    if (oldHubbardKeys.length > 0) {
      return {
        success: false,
        error:
          `检测到旧版 Hubbard 参数: ${oldHubbardKeys.join(", ")}。` +
          `QE 7.4 请使用 HUBBARD (ortho-atomic) 新格式。` +
          `在 hubbard 参数中传入 { U: { "Ni-3d": 5.0 } } 对象，` +
          `不要在 system 中设置 lda_plus_u 相关字段。`,
      };
    }

    // NOTE: bands 类型的高对称 K 路径，临时存储供 renderPw 使用
    (this as any)._currentKpath = args.kpath ?? undefined;

    // --- 校验 _reasons 覆盖率 ---
    // NOTE: Bug #3/A7 修复 — NSCF/bands/dos 计算大部分参数继承自 SCF，
    // 不应要求 Agent 对每个继承参数重复论证。只需为核心差异参数提供 _reasons。
    const isInheritedCalc = ["nscf", "bands", "dos"].includes(calcType);
    const allMissing: Record<string, string[]> = {};
    for (const [nlName, nlParams] of [
      ["CONTROL", ctrlP], ["SYSTEM", sysP],
      ["ELECTRONS", elecP], ["HUBBARD", hubP],
    ] as const) {
      const missing = this.validateReasons(nlName, nlParams as Record<string, unknown>);
      if (missing.length > 0) {
        if (isInheritedCalc) {
          // NSCF/bands/dos：只报告核心差异参数缺失（nbnd/occupations 等），其余跳过
          const criticalParams = new Set(["nbnd", "occupations", "nosym", "noinv"]);
          const criticalMissing = missing.filter(k => criticalParams.has(k));
          if (criticalMissing.length > 0) {
            allMissing[nlName] = criticalMissing;
          }
        } else {
          allMissing[nlName] = missing;
        }
      }
    }

    if (Object.keys(allMissing).length > 0) {
      const parts = Object.entries(allMissing)
        .map(([nl, keys]) => `  ${nl}: ${keys.join(", ")}`);
      const missingMsg = parts.join("\n");
      return {
        success: false,
        error:
          `参数审计失败：以下参数缺少 _reasons 论证。\n${missingMsg}\n` +
          "请在对应 namelist 的 _reasons 字典中为每个参数添加独立的选择依据后重试。",
      };
    }

    // --- 收集完整审计记录 ---
    const auditReasons = {
      kpoints: { value: kpoints, reason: kpointsReason },
      CONTROL: (ctrlP._reasons ?? {}) as Record<string, unknown>,
      SYSTEM: (sysP._reasons ?? {}) as Record<string, unknown>,
      ELECTRONS: (elecP._reasons ?? {}) as Record<string, unknown>,
      HUBBARD: (hubP._reasons ?? {}) as Record<string, unknown>,
    };

    try {
      // NOTE: Agent 可能传 symbol/species 而非 element，归一化处理
      const atoms = (sd.atoms as Atom[]).map((a) => ({
        ...a,
        element: String(a.element ?? a.symbol ?? a.species ?? "X"),
      }));
      // NOTE: species 标签保持原始值（Ni1/Ni2），用于 ATOMIC_SPECIES / POSITIONS
      const speciesLabels = [...new Set(atoms.map((a) => a.element))].sort();
      // NOTE: 纯元素符号用于 SSSP 赝势查询和截断能计算
      const baseElements = [...new Set(speciesLabels.map(extractBaseElement))].sort();
      // NOTE: 支持多种坐标类型声明方式（Bug #13 修复）
      // 1. coords_are_cartesian: boolean — Agent 最常用
      // 2. position_units / coordinate_type: string — 兼容旧格式
      let posUnits: string;
      const coordsAreCartesian = sd.coords_are_cartesian;
      if (coordsAreCartesian === false) {
        posUnits = "crystal";
      } else if (coordsAreCartesian === true) {
        posUnits = "angstrom";
      } else {
        posUnits = (sd.position_units ?? sd.coordinate_type ?? "angstrom") as string;
      }

      // NOTE: cell_parameters 支持多种传入格式：
      // 1. 直接 3×3 数组
      // 2. { vectors: [...] } 或 { matrix: [...] }
      // 3. 顶层 lattice 字段（Agent 常用）
      let cell: number[][];
      const cellRaw = sd.cell_parameters ?? sd.lattice;
      if (cellRaw && typeof cellRaw === "object" && !Array.isArray(cellRaw)) {
        cell = ((cellRaw as Record<string, unknown>).vectors ??
          (cellRaw as Record<string, unknown>).matrix ?? []) as number[][];
      } else {
        cell = (cellRaw ?? []) as number[][];
      }

      // NOTE: 自定义赝势/质量映射 — AFM 体系中多个 species 共用同一 UPF
      const pseudoMap = (args.pseudo_map ?? {}) as Record<string, string>;
      const massMap = (args.mass_map ?? {}) as Record<string, number>;

      // 构建 species 信息：优先用 pseudo_map/mass_map，回退到 SSSP 自动匹配
      // NOTE: 非本地模式使用相对路径，SCNet/云端会自动替换为远程赝势路径（Bug #8 修复）
      const pseudoDir = appConfig.computeProvider === "local"
        ? appConfig.pseudoDir
        : "./pseudo";
      const spInfo = speciesLabels.map((label) => {
        const base = extractBaseElement(label);
        const ssspInfo = getSpeciesInfo([base], pseudoDir)[0];
        return {
          element: label,  // 保持自定义标签（Ni1/Ni2）
          mass: massMap[label] ?? ssspInfo?.mass ?? 1.0,
          pseudo_file: pseudoMap[label] ?? ssspInfo?.pseudo_file ?? `${base}.UPF`,
        };
      });

      // NOTE: 仅在 Agent 未指定截断能时才从 SSSP 数据库动态获取推荐值
      // 使用 baseElements（纯元素符号）查询，而非自定义标签
      let ssspFallback = false;
      if (!("ecutwfc" in sysP) || !("ecutrho" in sysP)) {
        const [ssspWfc, ssspRho] = getMaxCutoffs(baseElements, pseudoDir);
        if (!("ecutwfc" in sysP)) {
          (sysP as Record<string, unknown>).ecutwfc = ssspWfc;
          ssspFallback = true;
        }
        if (!("ecutrho" in sysP)) {
          (sysP as Record<string, unknown>).ecutrho = ssspRho;
          ssspFallback = true;
        }
      }

      // NOTE: projwfc / pp-charge 已移至 executeSimplePost（Bug #1 修复），
      // 此处仅处理需要结构数据的 pw.x 系列类型
      const constraintsCard = (args.constraints as string) ?? "";
      const occupationsCard = (args.occupations_card as string) ?? "";
      const atomicForcesCard = (args.atomic_forces as string) ?? "";

      // NOTE: prefix 必须在并行作业间唯一，防止 SCNet 共享 scratch 下
      // 多个作业的 tmp/prefix.* 文件互相覆盖导致 EOF / MPI crash
      // 如果 Agent 未通过 control_params 显式指定 prefix，则从 output_dir 目录名推导
      if (!("prefix" in ctrlP)) {
        const od = args.output_dir as string | undefined;
        if (od) {
          ctrlP.prefix = basename(resolve(od)).slice(0, 12).replace(/[^a-zA-Z0-9_]/g, "_") || "sac";
        }
      }

      const content = this.renderPw(
        calcType, atoms, cell, posUnits, spInfo, pseudoDir,
        kpoints, ctrlP, sysP, elecP, ionsP, cellP, hubP, speciesLabels,
        constraintsCard, occupationsCard, atomicForcesCard,
      );

      // NOTE: 文件名中连字符替换为下划线，防止 SCNet 上传失败（vc-relax → vc_relax）
      const safeCalcType = calcType.replace(/-/g, "_");
      const filename = `${safeCalcType}.in`;

      // NOTE: Issue #4 修复 — output_dir 路径始终锚定在 session workspace
      // 相对路径必须解析为相对于 workspace/{sessionId}，防止写入错误目录
      const outputDir = args.output_dir as string | undefined;
      let writeDir = this.workspaceDir;
      if (outputDir) {
        // NOTE: Windows 盘符（D:\）也是绝对路径
        if (outputDir.startsWith("/") || /^[A-Za-z]:[\\\/]/.test(outputDir)) {
          writeDir = outputDir;
        } else if (this.workspaceDir) {
          // 相对路径 → 相对于当前 session workspace
          writeDir = join(this.workspaceDir, outputDir);
        } else {
          // workspaceDir 未设置时，使用 cwd 作为 fallback 并警告
          console.warn(`[CreateQEInput] workspaceDir 未设置，output_dir 将相对于 cwd 解析: ${outputDir}`);
          writeDir = outputDir;
        }
      } else if (!writeDir) {
        // 既无 output_dir 也无 workspaceDir → 使用 cwd
        console.warn("[CreateQEInput] workspaceDir 和 output_dir 均未设置，文件将写入当前目录");
      }

      let writtenPath = filename;
      if (writeDir) {
        await mkdir(writeDir, { recursive: true });
        writtenPath = join(writeDir, filename);
        await writeFile(writtenPath, content, "utf-8");
      }

      // NOTE: 自动生成 VASP (POSCAR) 格式的结构文件，供 VESTA 等可视化工具使用
      // 仅对含结构信息的计算类型生成（排除纯后处理类型）
      let vaspPath: string | undefined;
      const structuralCalcTypes = new Set(["scf", "relax", "vc-relax", "nscf", "bands"]);
      // NOTE: VASP 文件使用实际写入目录推导路径，而非 workspaceDir（Bug #9 修复）
      const vaspBaseDir = writeDir ?? this.workspaceDir;
      if (vaspBaseDir && cell.length === 3 && atoms.length > 0 && structuralCalcTypes.has(calcType)) {
        try {
          vaspPath = await this.writeVaspFile(atoms, cell, posUnits, vaspBaseDir, calcType);
        } catch (e) {
          // VASP 文件生成失败不影响主流程，仅记录警告
          console.warn(`[CreateQEInput] VASP 文件生成失败: ${e instanceof Error ? e.message : e}`);
        }
      }

      // NOTE: Bug #NiO-P4 — nspin=2 时磁性一致性校验
      // 防止 Agent 犯低级错误（忘记设磁矩、AFM 全同号等）
      const magneticWarnings: string[] = [];
      if (sysP.nspin === 2) {
        const startMagValues = Object.entries(sysP)
          .filter(([k]) => k.startsWith("starting_magnetization("))
          .map(([, v]) => v as number);

        if (startMagValues.length === 0 && !sysP._starting_mag) {
          magneticWarnings.push(
            "⚠️ nspin=2 但未设置任何 starting_magnetization，SCF 可能收敛到非磁性解。" +
            "建议通过 system._starting_mag 设置各 species 的初始磁矩。",
          );
        } else if (startMagValues.length > 1) {
          const allSameSign = startMagValues.every(v => v > 0) || startMagValues.every(v => v < 0);
          if (allSameSign) {
            magneticWarnings.push(
              "⚠️ 所有 starting_magnetization 同号 → 将得到铁磁(FM)解。" +
              "如需反铁磁(AFM)，请为不同 species 设置正负相反的磁矩。",
            );
          }
          const allZero = startMagValues.every(v => Math.abs(v) < 0.001);
          if (allZero) {
            magneticWarnings.push(
              "⚠️ 所有 starting_magnetization ≈ 0 → 等同于非磁性计算，nspin=2 无实际效果。",
            );
          }
        }
      }

      return {
        success: true,
        data: {
          filename,
          path: writtenPath,
          content,
          calc_type: calcType,
          n_atoms: atoms.length,
          species: speciesLabels,
          elements: baseElements,
          ecutwfc: sysP.ecutwfc,
          ecutrho: sysP.ecutrho,
          kpoints,
          ...(ssspFallback ? {
            sssp_fallback: true,
            note: "ecutwfc/ecutrho 未由 Agent 指定，已从 SSSP 数据库自动获取推荐值",
          } : {}),
          ...(vaspPath ? { vasp_path: vaspPath } : {}),
          ...((this as any)._nbndAuto ? {
            nbnd_auto: true,
            nbnd_info: (this as any)._nbndAuto,
          } : {}),
          // NOTE: Bug #NiO-P4 — 磁性一致性校验警告
          ...(magneticWarnings.length > 0 ? { magnetic_warnings: magneticWarnings } : {}),
        },
        display: `📄 QE 输入: \`${filename}\` → ${writtenPath} | ${atoms.length} atoms | K=${JSON.stringify(kpoints)}` +
          (vaspPath ? ` | 🔬 VASP: ${vaspPath}` : ""),
        audit: {
          calc_type: calcType,
          description: desc,
          parameter_reasons: auditReasons,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `生成失败: ${msg}` };
    }
  }

  // -------------------------------------------------------------------
  // 渲染 pw.x 输入文件
  // -------------------------------------------------------------------

  private renderPw(
    calcType: string, atoms: Atom[], cell: number[][], posUnits: string,
    spInfo: Array<{ element: string; mass: number; pseudo_file: string }>,
    pseudoDir: string, kpoints: number[],
    ctrlP: Record<string, unknown>, sysP: Record<string, unknown>,
    elecP: Record<string, unknown>, ionsP: Record<string, unknown>,
    cellP: Record<string, unknown>, hubP: Record<string, unknown>,
    elements: string[],
    constraintsCard = "", occupationsCard = "", atomicForcesCard = "",
  ): string {
    const nat = atoms.length;
    const ntyp = elements.length;
    const calcMap: Record<string, string> = {
      scf: "scf", relax: "relax", "vc-relax": "vc-relax",
      nscf: "nscf", bands: "bands", dos: "nscf",
    };
    const calculation = calcMap[calcType] ?? "scf";
    const sections: string[] = [];

    // &CONTROL
    const ctrl: Record<string, unknown> = {
      calculation, pseudo_dir: pseudoDir, outdir: "./tmp", prefix: "sac",
      ...ctrlP,
    };
    sections.push(this.renderNamelist("CONTROL", ctrl));

    // &SYSTEM（含 starting_magnetization 展开）
    // NOTE: ntyp 使用 species 标签数量（Ni1/Ni2/O = 3），不是纯元素数
    const sysD: Record<string, unknown> = { ibrav: 0, nat, ntyp, ...sysP };
    // NOTE: NSCF/DOS/Bands 类型自动注入关键参数
    if (calcType === "nscf" || calcType === "dos") {
      if (!("nosym" in sysD)) sysD.nosym = ".true.";
      if (!("noinv" in sysD)) sysD.noinv = ".true.";
      if (!("occupations" in sysD)) sysD.occupations = "tetrahedra";
    }
    // NOTE: Bug B4 修复 — NSCF/bands 自动注入 diago_full_acc，
    // 确保对角化使用与 SCF 完全一致的精度，避免能带/DOS 结果出现伪影
    if ((calcType === "nscf" || calcType === "bands") && !("diago_full_acc" in elecP)) {
      (elecP as Record<string, unknown>).diago_full_acc = ".true.";
    }
    // NOTE: bands/nscf/dos 自动计算 nbnd，确保包含足够导带（Bug #6 修复）
    // Agent 未指定 nbnd 时，工具从价电子数表自动推导合理值
    if ((calcType === "bands" || calcType === "nscf" || calcType === "dos") && !("nbnd" in sysD)) {
      const atomElements = atoms.map(a => extractBaseElement(a.element));
      const totCharge = (sysP.tot_charge as number) ?? 0;
      const nElectrons = getTotalValenceElectrons(atomElements, totCharge);
      const nspin = (sysP.nspin as number) ?? 1;
      // nspin=2 时每个通道 n_electrons/2 条占据带，需额外 20% + 4 条导带
      const nOccupied = nspin === 2 ? Math.ceil(nElectrons / 2) : Math.ceil(nElectrons / 2);
      const autoNbnd = Math.max(Math.ceil(nOccupied * 1.2) + 4, nOccupied + 4);
      sysD.nbnd = autoNbnd;
      // 标记到实例变量，供返回值使用
      (this as any)._nbndAuto = { nbnd: autoNbnd, n_electrons: nElectrons, n_occupied: nOccupied };
    }
    const startMag = sysD._starting_mag as Record<string, number> | undefined;
    delete sysD._starting_mag;
    if (startMag) {
      // NOTE: starting_magnetization 索引基于 species 标签（Ni1/Ni2），不是纯元素名
      for (const [label, m] of Object.entries(startMag)) {
        const idx = elements.indexOf(label);
        if (idx >= 0) {
          sysD[`starting_magnetization(${idx + 1})`] = m;
        }
      }
    }
    sections.push(this.renderNamelist("SYSTEM", sysD));

    // &ELECTRONS
    // NOTE: conv_thr 默认值为 1.0e-8，Agent 可覆盖但必须在合理范围内
    // Kimi K2 反复出现 conv_thr=1 的问题，这里做兜底校验
    if (!("conv_thr" in elecP)) {
      (elecP as Record<string, unknown>).conv_thr = 1.0e-8;
    } else {
      const ct = elecP.conv_thr as number;
      if (ct > 0.01) {
        console.warn(`[CreateQEInput] ⚠️ conv_thr=${ct} 不合理，已修正为 1.0e-8`);
        (elecP as Record<string, unknown>).conv_thr = 1.0e-8;
      }
    }
    sections.push(
      Object.keys(elecP).filter((k) => !k.startsWith("_")).length > 0
        ? this.renderNamelist("ELECTRONS", elecP)
        : "&ELECTRONS\n/\n",
    );

    // &IONS（relax / vc-relax）
    if (calcType === "relax" || calcType === "vc-relax") {
      const ions: Record<string, unknown> = { ion_dynamics: "bfgs", ...ionsP };
      sections.push(this.renderNamelist("IONS", ions));
    }

    // &CELL（vc-relax）
    if (calcType === "vc-relax") {
      const cel: Record<string, unknown> = { cell_dynamics: "bfgs", ...cellP };
      sections.push(this.renderNamelist("CELL", cel));
    }

    // ATOMIC_SPECIES
    const specLines = ["ATOMIC_SPECIES"];
    for (const sp of spInfo) {
      specLines.push(`    ${sp.element.padEnd(4)} ${sp.mass.toFixed(4).padStart(10)}  ${sp.pseudo_file}`);
    }
    sections.push(specLines.join("\n") + "\n");

    // CELL_PARAMETERS
    const cellLines = ["CELL_PARAMETERS {angstrom}"];
    for (const row of cell) {
      cellLines.push(`    ${row[0].toFixed(10).padStart(14)}  ${row[1].toFixed(10).padStart(14)}  ${row[2].toFixed(10).padStart(14)}`);
    }
    sections.push(cellLines.join("\n") + "\n");

    // ATOMIC_POSITIONS
    // NOTE: 支持选择性动力学 (if_pos)
    // atoms[].fixed = true → 0 0 0（完全固定）
    // atoms[].if_pos = [0,1,0] → 精细控制各方向
    // 用于 slab 计算固定底层原子
    const u = posUnits === "crystal" || posUnits === "crystal_sg" ? "crystal" : "angstrom";
    const posLines = [`ATOMIC_POSITIONS {${u}}`];
    let hasSelectiveDynamics = false;
    for (const a of atoms) {
      const pos = a.position ?? [a.x ?? 0, a.y ?? 0, a.z ?? 0];
      let ifPosStr = "";
      if (a.fixed === true) {
        ifPosStr = "  0 0 0";
        hasSelectiveDynamics = true;
      } else if (a.if_pos && Array.isArray(a.if_pos) && a.if_pos.length === 3) {
        ifPosStr = `  ${a.if_pos[0]} ${a.if_pos[1]} ${a.if_pos[2]}`;
        hasSelectiveDynamics = true;
      }
      posLines.push(`    ${a.element.padEnd(4)} ${pos[0].toFixed(10).padStart(14)}  ${pos[1].toFixed(10).padStart(14)}  ${pos[2].toFixed(10).padStart(14)}${ifPosStr}`);
    }
    if (hasSelectiveDynamics) {
      const nFixed = atoms.filter((a: any) => a.fixed === true).length;
      console.log(`[CreateQEInput] 🔒 选择性动力学: ${nFixed}/${atoms.length} 原子固定`);
    }
    sections.push(posLines.join("\n") + "\n");

    // K_POINTS
    if (calcType === "bands") {
      // NOTE: bands 类型使用 K_POINTS {crystal_b} 格式（高对称路径）
      // kpath 在 validateInput 中已强制要求
      const kpath = (this as any)._currentKpath as Array<{ point: number[]; label: string; npts: number }> | undefined;
      if (kpath && kpath.length > 0) {
        const kLines = [`K_POINTS {crystal_b}`, `${kpath.length}`];
        for (const kp of kpath) {
          kLines.push(
            `    ${kp.point[0].toFixed(10).padStart(14)}  ${kp.point[1].toFixed(10).padStart(14)}  ${kp.point[2].toFixed(10).padStart(14)}  ${kp.npts}  ! ${kp.label}`,
          );
        }
        sections.push(kLines.join("\n") + "\n");
      } else {
        // 不应该到达这里（validateInput 已拦截），但做兜底
        const s1 = kpoints[3] ?? 0, s2 = kpoints[4] ?? 0, s3 = kpoints[5] ?? 0;
        sections.push(`K_POINTS {automatic}\n    ${kpoints[0]} ${kpoints[1]} ${kpoints[2]}  ${s1} ${s2} ${s3}\n`);
      }
    } else {
      // NOTE: 非 bands 类型使用 K_POINTS {automatic}，偏移默认 0 0 0
      const s1 = kpoints[3] ?? 0, s2 = kpoints[4] ?? 0, s3 = kpoints[5] ?? 0;
      sections.push(`K_POINTS {automatic}\n    ${kpoints[0]} ${kpoints[1]} ${kpoints[2]}  ${s1} ${s2} ${s3}\n`);
    }

    // HUBBARD
    if (Object.keys(hubP).filter((k) => !k.startsWith("_")).length > 0) {
      const h = this.renderHubbard(hubP, elements);
      if (h) sections.push(h);
    }

    // CONSTRAINTS（可选）
    if (constraintsCard.trim()) {
      sections.push(`CONSTRAINTS\n${constraintsCard}\n`);
    }

    // OCCUPATIONS（可选，仅 occupations='from_input' 时）
    if (occupationsCard.trim()) {
      sections.push(`OCCUPATIONS\n${occupationsCard}\n`);
    }

    // ATOMIC_FORCES（可选）
    if (atomicForcesCard.trim()) {
      sections.push(`ATOMIC_FORCES\n${atomicForcesCard}\n`);
    }

    return sections.join("\n");
  }

  /** 渲染 QE namelist 段，跳过内部字段（_reasons 等） */
  private renderNamelist(name: string, params: Record<string, unknown>): string {
    const lines = [`&${name}`];
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith("_") || k === "reason") continue;
      if (typeof v === "object" && v !== null) continue;

      let fv: string;
      if (typeof v === "boolean") {
        fv = v ? ".true." : ".false.";
      } else if (typeof v === "string") {
        fv = v.startsWith("'") || v === ".true." || v === ".false." ? v : `'${v}'`;
      } else if (typeof v === "number") {
        // NOTE: QE 要求浮点数用 'd' 代替 'e'
        const s = String(v);
        fv = s.includes("e") || s.includes("E") ? s.replace(/[eE]/g, "d") : s;
      } else {
        fv = String(v);
      }
      lines.push(`    ${k} = ${fv}`);
    }
    lines.push("/\n");
    return lines.join("\n");
  }

  /** 渲染 HUBBARD 卡片 */
  private renderHubbard(hubP: Record<string, unknown>, elements: string[]): string {
    const lines = ["HUBBARD (ortho-atomic)"];
    let ok = false;

    if ("U" in hubP || "V" in hubP) {
      for (const t of ["U", "V", "J"]) {
        const block = hubP[t];
        if (block && typeof block === "object") {
          for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
            if (typeof v === "number") {
              lines.push(`${t} ${k} ${v}`);
              ok = true;
            }
          }
        }
      }
    } else {
      // NOTE: 简写格式支持自定义 species 标签（Ni1、Ni2 等）
      for (const [label, u] of Object.entries(hubP)) {
        if (label.startsWith("_")) continue;
        if (typeof u === "number") {
          const base = extractBaseElement(label);
          const shell = SHELL_MAP[base] ?? "3d";
          // 用原始标签（Ni1-3d）而非纯元素名，QE 支持 species 标签
          lines.push(`U ${label}-${shell} ${u}`);
          ok = true;
        }
      }
    }

    return ok ? lines.join("\n") + "\n" : "";
  }

  // -------------------------------------------------------------------
  // 简单后处理类型（dos-post / bands-post / phonon / hp / epsilon）
  // 无需结构数据和参数审计，直接生成对应程序的 namelist 输入
  // -------------------------------------------------------------------

  private async executeSimplePost(
    calcType: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ctrlP = (args.control ?? {}) as Record<string, unknown>;
    const pp = (args.post_process ?? {}) as Record<string, unknown>;
    // NOTE: prefix/outdir 优先从 post_process 读取（Bug #2 修复）
    // 后处理程序的 prefix/outdir 应与前序 pw.x 的输出一致
    const prefix = (pp.prefix as string) ?? (ctrlP.prefix as string) ?? "sac";
    const outdir = (pp.outdir as string) ?? (ctrlP.outdir as string) ?? "./tmp";
    const desc = (args.description as string) ?? "";

    let content: string;

    switch (calcType) {
      case "dos-post": {
        // dos.x — 从 NSCF 计算的 tmp/ 中提取态密度
        const fildos = (pp.fildos as string) ?? "dos.dat";
        const degauss = (pp.degauss as number) ?? 0.005;
        const emin = (pp.Emin as number) ?? -20.0;
        const emax = (pp.Emax as number) ?? 10.0;
        const deltaE = (pp.DeltaE as number) ?? 0.01;
        content =
          `&DOS\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    fildos='${fildos}'\n` +
          `    degauss=${degauss}\n` +
          `    Emin=${emin}\n` +
          `    Emax=${emax}\n` +
          `    DeltaE=${deltaE}\n` +
          `/\n`;
        break;
      }
      case "bands-post": {
        // bands.x — 从 bands 计算的 tmp/ 中提取能带数据
        const filband = (pp.filband as string) ?? "bands.dat";
        const lsym = (pp.lsym as boolean) ?? true;
        content =
          `&BANDS\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    filband='${filband}'\n` +
          `    lsym=${lsym ? ".true." : ".false."}\n`;
        // NOTE: 可选参数追加
        if (pp.spin_component !== undefined) {
          content += `    spin_component=${pp.spin_component}\n`;
        }
        content += `/\n`;
        break;
      }
      case "phonon": {
        // ph.x — 声子计算（DFPT 线性响应）
        const fildyn = (pp.fildyn as string) ?? "dyn";
        const tr2_ph = (pp.tr2_ph as number) ?? 1.0e-14;
        const ldisp = (pp.ldisp as boolean) ?? true;
        const nq1 = (pp.nq1 as number) ?? 2;
        const nq2 = (pp.nq2 as number) ?? 2;
        const nq3 = (pp.nq3 as number) ?? 2;
        content =
          `&INPUTPH\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    fildyn='${fildyn}'\n` +
          `    tr2_ph=${String(tr2_ph).replace(/[eE]/g, "d")}\n` +
          `    ldisp=${ldisp ? ".true." : ".false."}\n`;
        if (ldisp) {
          content += `    nq1=${nq1}\n    nq2=${nq2}\n    nq3=${nq3}\n`;
        }
        // NOTE: 可选参数（alpha_mix, niter_ph, recover 等）
        const phononOptionals = ["alpha_mix", "niter_ph", "recover", "epsil", "trans"];
        for (const k of phononOptionals) {
          if (pp[k] !== undefined) {
            const v = pp[k];
            if (typeof v === "boolean") {
              content += `    ${k}=${v ? ".true." : ".false."}\n`;
            } else if (typeof v === "number") {
              content += `    ${k}=${String(v).replace(/[eE]/g, "d")}\n`;
            }
          }
        }
        content += `/\n`;
        break;
      }
      case "hp": {
        // hp.x — Hubbard U 自洽校准（DFPT 线性响应）
        const nq1 = (pp.nq1 as number) ?? 2;
        const nq2 = (pp.nq2 as number) ?? 2;
        const nq3 = (pp.nq3 as number) ?? 2;
        const convThr = (pp.conv_thr_chi as number) ?? 1.0e-6;
        content =
          `&INPUTHP\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    nq1=${nq1}\n` +
          `    nq2=${nq2}\n` +
          `    nq3=${nq3}\n` +
          `    conv_thr_chi=${String(convThr).replace(/[eE]/g, "d")}\n`;
        // NOTE: 可选参数
        if (pp.find_atpert !== undefined) {
          content += `    find_atpert=${pp.find_atpert}\n`;
        }
        content += `/\n`;
        break;
      }
      case "epsilon": {
        // epsilon.x — 光学性质（介电函数）
        const epsCalc = (pp.calculation as string) ?? "eps";
        content =
          `&INPUTPP\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    calculation='${epsCalc}'\n`;
        // NOTE: 可选参数
        const epsilonOptionals = ["broadening", "nw", "wmin", "wmax"];
        for (const k of epsilonOptionals) {
          if (pp[k] !== undefined) {
            content += `    ${k}=${pp[k]}\n`;
          }
        }
        content += `/\n`;
        break;
      }
      case "projwfc": {
        // projwfc.x — 投影态密度（pDOS）
        const degauss = (pp.degauss as number) ?? 0.005;
        const emin = (pp.Emin as number) ?? -20.0;
        const emax = (pp.Emax as number) ?? 10.0;
        const deltaE = (pp.DeltaE as number) ?? 0.01;
        const filpdos = (pp.filpdos as string) ?? "pdos";
        content =
          `&PROJWFC\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    degauss=${degauss}\n` +
          `    filpdos='${filpdos}'\n` +
          `    Emin=${emin}\n` +
          `    Emax=${emax}\n` +
          `    DeltaE=${deltaE}\n` +
          `/\n`;
        break;
      }
      case "pp-charge": {
        // NOTE: plot_num=0 仅输出价电子伪电荷；plot_num=17 输出 PAW 全电子密度（Bader 必须）
        const plotNum = (pp.plot_num as number) ?? 0;
        const filplot = (pp.filplot as string) ?? "charge.dat";
        const iflag = (pp.iflag as number) ?? 3;
        const outputFormat = (pp.output_format as number) ?? 6;
        const fileout = (pp.fileout as string) ?? "charge.cube";
        content =
          `&INPUTPP\n` +
          `    outdir='${outdir}'\n` +
          `    prefix='${prefix}'\n` +
          `    filplot='${filplot}'\n` +
          `    plot_num=${plotNum}\n` +
          `/\n` +
          `&PLOT\n` +
          `    iflag=${iflag}\n` +
          `    output_format=${outputFormat}\n` +
          `    fileout='${fileout}'\n` +
          `/\n`;
        break;
      }
      default:
        return { success: false, error: `未知后处理类型: ${calcType}` };
    }

    // --- 写入文件 ---
    const safeCalcType = calcType.replace(/-/g, "_");
    const filename = `${safeCalcType}.in`;
    const outputDir = args.output_dir as string | undefined;
    let writeDir = this.workspaceDir;
    if (outputDir) {
      // NOTE: Windows 盘符（D:\）也是绝对路径
      if (outputDir.startsWith("/") || /^[A-Za-z]:[\\\/]/.test(outputDir)) {
        writeDir = outputDir;
      } else if (this.workspaceDir) {
        writeDir = join(this.workspaceDir, outputDir);
      }
    }

    let writtenPath = filename;
    if (writeDir) {
      await mkdir(writeDir, { recursive: true });
      writtenPath = join(writeDir, filename);
      await writeFile(writtenPath, content, "utf-8");
    }

    return {
      success: true,
      data: { filename, path: writtenPath, content, calc_type: calcType },
      display: `📄 QE 后处理输入: \`${filename}\` → ${writtenPath}`,
      audit: { calc_type: calcType, description: desc },
    };
  }

  // -------------------------------------------------------------------
  // NEB 过渡态搜索 — 需要初始态 + 终态两套结构
  // neb.x 输入格式与标准 pw.x 不同，使用 BEGIN/END 包裹结构
  // -------------------------------------------------------------------

  private async executeNEB(args: Record<string, unknown>): Promise<ToolResult> {
    const sd = args.structure_data as Record<string, unknown>;
    const sdFinal = args.structure_data_final as Record<string, unknown>;
    const kpoints = (args.kpoints as number[]) ?? [4, 4, 1];
    const kpointsReason = (args.kpoints_reason as string) ?? "";
    const desc = (args.description as string) ?? "";
    const ctrlP = (args.control ?? {}) as Record<string, unknown>;
    const sysP = (args.system ?? {}) as Record<string, unknown>;
    const elecP = (args.electrons ?? {}) as Record<string, unknown>;
    const hubP = (args.hubbard ?? {}) as Record<string, unknown>;
    const pathP = (args.neb_path ?? {}) as Record<string, unknown>;
    const pseudoMap = (args.pseudo_map ?? {}) as Record<string, string>;
    const massMap = (args.mass_map ?? {}) as Record<string, number>;

    try {
      // --- 处理初始态结构 ---
      const atoms = (sd.atoms as Atom[]).map((a) => ({
        ...a,
        element: String(a.element ?? a.symbol ?? a.species ?? "X"),
      }));
      const speciesLabels = [...new Set(atoms.map((a) => a.element))].sort();
      const baseElements = [...new Set(speciesLabels.map(extractBaseElement))].sort();

      let posUnits: string;
      const coordsAreCartesian = sd.coords_are_cartesian;
      if (coordsAreCartesian === false) posUnits = "crystal";
      else if (coordsAreCartesian === true) posUnits = "angstrom";
      else posUnits = (sd.position_units ?? sd.coordinate_type ?? "angstrom") as string;

      const cellRaw = sd.cell_parameters ?? sd.lattice;
      let cell: number[][];
      if (cellRaw && typeof cellRaw === "object" && !Array.isArray(cellRaw)) {
        cell = ((cellRaw as Record<string, unknown>).vectors ??
          (cellRaw as Record<string, unknown>).matrix ?? []) as number[][];
      } else {
        cell = (cellRaw ?? []) as number[][];
      }

      // --- 处理终态结构 ---
      const atomsFinal = (sdFinal.atoms as Atom[]).map((a) => ({
        ...a,
        element: String(a.element ?? a.symbol ?? a.species ?? "X"),
      }));

      // --- 赝势和截断能 ---
      const pseudoDir = appConfig.computeProvider === "local"
        ? appConfig.pseudoDir
        : "./pseudo";
      const spInfo = speciesLabels.map((label) => {
        const base = extractBaseElement(label);
        const ssspInfo = getSpeciesInfo([base], pseudoDir)[0];
        return {
          element: label,
          mass: massMap[label] ?? ssspInfo?.mass ?? 1.0,
          pseudo_file: pseudoMap[label] ?? ssspInfo?.pseudo_file ?? `${base}.UPF`,
        };
      });

      if (!("ecutwfc" in sysP) || !("ecutrho" in sysP)) {
        const [ssspWfc, ssspRho] = getMaxCutoffs(baseElements, pseudoDir);
        if (!("ecutwfc" in sysP)) (sysP as Record<string, unknown>).ecutwfc = ssspWfc;
        if (!("ecutrho" in sysP)) (sysP as Record<string, unknown>).ecutrho = ssspRho;
      }

      const prefix = (ctrlP.prefix as string) ?? "neb";
      const outdir = (ctrlP.outdir as string) ?? "./tmp";

      // --- 渲染 NEB 输入 ---
      const sections: string[] = ["BEGIN", "BEGIN_PATH_INPUT"];

      // &PATH namelist
      const pathLines = ["&PATH"];
      const pathDefaults: Record<string, unknown> = {
        string_method: "neb",
        nstep_path: 50,
        num_of_images: 7,
        CI_scheme: "auto",
        opt_scheme: "broyden",
        ...pathP,
      };
      for (const [k, v] of Object.entries(pathDefaults)) {
        if (k.startsWith("_")) continue;
        if (typeof v === "string") pathLines.push(`    ${k}='${v}'`);
        else if (typeof v === "boolean") pathLines.push(`    ${k}=${v ? ".true." : ".false."}`);
        else if (typeof v === "number") pathLines.push(`    ${k}=${String(v).replace(/[eE]/g, "d")}`);
      }
      pathLines.push("/");
      sections.push(pathLines.join("\n"));
      sections.push("END_PATH_INPUT");

      // BEGIN_ENGINE_INPUT — 标准 pw.x 格式（不含原子坐标）
      sections.push("BEGIN_ENGINE_INPUT");

      // &CONTROL
      const ctrl: Record<string, unknown> = {
        pseudo_dir: pseudoDir, outdir, prefix,
        ...ctrlP,
      };
      sections.push(this.renderNamelist("CONTROL", ctrl));

      // &SYSTEM
      const nat = atoms.length;
      const ntyp = speciesLabels.length;
      const sysD: Record<string, unknown> = { ibrav: 0, nat, ntyp, ...sysP };
      const startMag = sysD._starting_mag as Record<string, number> | undefined;
      delete sysD._starting_mag;
      if (startMag) {
        for (const [label, m] of Object.entries(startMag)) {
          const idx = speciesLabels.indexOf(label);
          if (idx >= 0) sysD[`starting_magnetization(${idx + 1})`] = m;
        }
      }
      sections.push(this.renderNamelist("SYSTEM", sysD));

      // &ELECTRONS
      if (!("conv_thr" in elecP)) (elecP as Record<string, unknown>).conv_thr = 1.0e-8;
      sections.push(this.renderNamelist("ELECTRONS", elecP));

      // ATOMIC_SPECIES
      const specLines = ["ATOMIC_SPECIES"];
      for (const sp of spInfo) {
        specLines.push(`    ${sp.element.padEnd(4)} ${sp.mass.toFixed(4).padStart(10)}  ${sp.pseudo_file}`);
      }
      sections.push(specLines.join("\n") + "\n");

      // CELL_PARAMETERS
      if (cell.length === 3) {
        const cellLines = ["CELL_PARAMETERS {angstrom}"];
        for (const row of cell) {
          cellLines.push(`    ${row[0].toFixed(10).padStart(14)}  ${row[1].toFixed(10).padStart(14)}  ${row[2].toFixed(10).padStart(14)}`);
        }
        sections.push(cellLines.join("\n") + "\n");
      }

      // K_POINTS
      const s1 = kpoints[3] ?? 0, s2 = kpoints[4] ?? 0, s3 = kpoints[5] ?? 0;
      sections.push(`K_POINTS {automatic}\n    ${kpoints[0]} ${kpoints[1]} ${kpoints[2]}  ${s1} ${s2} ${s3}\n`);

      // HUBBARD
      if (Object.keys(hubP).filter((k) => !k.startsWith("_")).length > 0) {
        const h = this.renderHubbard(hubP, speciesLabels);
        if (h) sections.push(h);
      }

      // BEGIN_POSITIONS — 初始态和终态坐标
      const u = posUnits === "crystal" || posUnits === "crystal_sg" ? "crystal" : "angstrom";
      sections.push("BEGIN_POSITIONS");

      // FIRST_IMAGE
      const firstLines = ["FIRST_IMAGE", `ATOMIC_POSITIONS {${u}}`];
      for (const a of atoms) {
        const pos = a.position ?? [a.x ?? 0, a.y ?? 0, a.z ?? 0];
        firstLines.push(`    ${a.element.padEnd(4)} ${pos[0].toFixed(10).padStart(14)}  ${pos[1].toFixed(10).padStart(14)}  ${pos[2].toFixed(10).padStart(14)}`);
      }
      sections.push(firstLines.join("\n"));

      // LAST_IMAGE
      const lastLines = ["LAST_IMAGE", `ATOMIC_POSITIONS {${u}}`];
      for (const a of atomsFinal) {
        const pos = a.position ?? [a.x ?? 0, a.y ?? 0, a.z ?? 0];
        lastLines.push(`    ${a.element.padEnd(4)} ${pos[0].toFixed(10).padStart(14)}  ${pos[1].toFixed(10).padStart(14)}  ${pos[2].toFixed(10).padStart(14)}`);
      }
      sections.push(lastLines.join("\n"));
      sections.push("END_POSITIONS");

      sections.push("END_ENGINE_INPUT");
      sections.push("END");

      const content = sections.join("\n") + "\n";

      // --- 写入文件 ---
      const filename = "neb.in";
      const outputDir = args.output_dir as string | undefined;
      let writeDir = this.workspaceDir;
      if (outputDir) {
        if (outputDir.startsWith("/") || /^[A-Za-z]:[\\\/]/.test(outputDir)) writeDir = outputDir;
        else if (this.workspaceDir) writeDir = join(this.workspaceDir, outputDir);
      }

      let writtenPath = filename;
      if (writeDir) {
        await mkdir(writeDir, { recursive: true });
        writtenPath = join(writeDir, filename);
        await writeFile(writtenPath, content, "utf-8");
      }

      return {
        success: true,
        data: {
          filename, path: writtenPath, content, calc_type: "neb",
          n_atoms: nat, species: speciesLabels, elements: baseElements,
          num_of_images: pathDefaults.num_of_images, kpoints,
        },
        display: `📄 NEB 输入: \`${filename}\` → ${writtenPath} | ${nat} atoms × ${pathDefaults.num_of_images} images`,
        audit: {
          calc_type: "neb", description: desc,
          parameter_reasons: { kpoints: { value: kpoints, reason: kpointsReason } },
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `NEB 输入生成失败: ${msg}` };
    }
  }

  /**
   * 将结构数据导出为 VASP POSCAR 格式，写入 structures/ 子目录
   *
   * 目录推导逻辑：
   * - workspaceDir = ".../Si_bulk/01_relax" → structuresDir = ".../Si_bulk/structures/"
   * - 文件命名根据 calcType 区分初始/松弛结构
   *
   * POSCAR 格式：
   * - 行1: 注释行
   * - 行2: 缩放因子 (1.0)
   * - 行3-5: 晶胞矢量 (Å)
   * - 行6: 元素符号
   * - 行7: 每种元素原子数
   * - 行8: Direct (分数坐标) 或 Cartesian (笛卡尔坐标)
   * - 行9+: 原子坐标
   */
  private async writeVaspFile(
    atoms: Atom[],
    cell: number[][],
    posUnits: string,
    workspaceDir: string,
    calcType: string,
  ): Promise<string> {
    // 从 workspaceDir 推导体系根目录和 structures/ 路径
    // workspaceDir 形如 ".../Si_bulk/01_relax"，需要回退到体系根目录
    const systemDir = dirname(workspaceDir);
    const systemName = basename(systemDir);
    const structuresDir = join(systemDir, "structures");

    await mkdir(structuresDir, { recursive: true });

    // 根据计算类型确定文件名
    const suffix = calcType.includes("relax") ? "initial" : calcType;
    const vaspFilename = `${systemName}_${suffix}.vasp`;
    const vaspPath = join(structuresDir, vaspFilename);

    // 按元素排序并分组
    const elementOrder = [...new Set(atoms.map((a) => a.element))].sort();
    const sortedAtoms = elementOrder.flatMap((el) =>
      atoms.filter((a) => a.element === el),
    );
    const elementCounts = elementOrder.map(
      (el) => atoms.filter((a) => a.element === el).length,
    );

    // 判断坐标类型
    const isDirect = posUnits.toLowerCase().includes("crystal") ||
      posUnits.toLowerCase().includes("fractional");

    // 构建 POSCAR 内容
    const lines: string[] = [];
    lines.push(`${elementOrder.join(" ")} | Generated by DFT AutoPilot`);
    lines.push("1.0");

    // 晶胞矢量（假设 Å）
    for (const vec of cell) {
      lines.push(`  ${vec.map((v) => v.toFixed(10).padStart(16)).join("")}`);
    }

    // 元素和计数
    lines.push(`  ${elementOrder.join("  ")}`);
    lines.push(`  ${elementCounts.join("  ")}`);

    // 坐标类型
    lines.push(isDirect ? "Direct" : "Cartesian");

    // 原子坐标
    for (const atom of sortedAtoms) {
      const coords = atom.position ?? [atom.x ?? 0, atom.y ?? 0, atom.z ?? 0];
      lines.push(
        `  ${(coords as number[]).map((c) => c.toFixed(10).padStart(16)).join("")}  ${atom.element}`,
      );
    }
    lines.push(""); // 尾部空行

    await writeFile(vaspPath, lines.join("\n"), "utf-8");
    return vaspPath;
  }
}
