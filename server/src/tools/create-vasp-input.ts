/**
 * create_vasp_input — 生成 VASP 输入文件（INCAR + POSCAR + KPOINTS）
 *
 * NOTE: POTCAR 不在本地生成（版权问题），而是在 SCNet 作业脚本中动态拼接。
 * 工具返回 potcar_order 列表，由 run_command 路由层传递给作业脚本生成器。
 *
 * 设计原则一：工具只做确定的事情（格式生成、路径解析、一致性校验），
 * 物理参数选择（ENCUT/ISMEAR/ISPIN 等）全部交给 Agent 决策。
 *
 * NEB 支持：calc_type="neb" 时生成多目录结构（00/ 01/ ... N+1/），
 * 通过 pymatgen IDPP 或线性插值生成中间 image。
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { DFTTool, type ToolResult } from "./base.js";
import { appConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// NOTE: _reasons 审计中必须覆盖的关键 INCAR 参数
// 这些参数对计算结果影响最大，Agent 不提供理由则拒绝生成
const CRITICAL_INCAR_PARAMS = new Set([
  "ENCUT", "ISPIN", "ISMEAR", "SIGMA", "EDIFF", "EDIFFG",
  "ISIF", "IBRION", "NSW", "MAGMOM",
  "LDAU", "LDAUU", "LDAUL", "LDAUJ",
]);

/** POTCAR 推荐变体映射 */
const POTCAR_RECOMMENDED: Record<string, string> = {
  // 碱金属/碱土金属 — 半芯态重要
  Li: "Li_sv", Be: "Be_sv", Na: "Na_pv", Mg: "Mg_pv",
  K: "K_sv", Ca: "Ca_sv", Rb: "Rb_sv", Sr: "Sr_sv",
  Cs: "Cs_sv", Ba: "Ba_sv",
  // 3d 过渡金属 — p 半芯态
  Sc: "Sc_sv", Ti: "Ti_pv", V: "V_pv", Cr: "Cr_pv",
  Mn: "Mn_pv", Fe: "Fe_pv", Co: "Co", Ni: "Ni_pv",
  Cu: "Cu_pv", Zn: "Zn",
  // 4d 过渡金属
  Y: "Y_sv", Zr: "Zr_sv", Nb: "Nb_pv", Mo: "Mo_pv",
  Tc: "Tc_pv", Ru: "Ru_pv", Rh: "Rh_pv", Pd: "Pd",
  Ag: "Ag", Cd: "Cd",
  // 5d 过渡金属
  Hf: "Hf_pv", Ta: "Ta_pv", W: "W_pv", Re: "Re_pv",
  Os: "Os_pv", Ir: "Ir", Pt: "Pt", Au: "Au",
  // 主族元素 — 标准版即可
  H: "H", He: "He", B: "B", C: "C", N: "N", O: "O",
  F: "F", Ne: "Ne", Al: "Al", Si: "Si", P: "P", S: "S",
  Cl: "Cl", Ar: "Ar", Ga: "Ga_d", Ge: "Ge_d",
  As: "As", Se: "Se", Br: "Br", Kr: "Kr",
  In: "In_d", Sn: "Sn_d", Sb: "Sb", Te: "Te",
  I: "I", Xe: "Xe", Tl: "Tl_d", Pb: "Pb_d",
  Bi: "Bi", Po: "Po_d",
  // 镧系
  La: "La", Ce: "Ce", Pr: "Pr_3", Nd: "Nd_3",
  Sm: "Sm_3", Eu: "Eu_2", Gd: "Gd_3",
};

/** 原子数据接口，支持选择性动力学 */
interface VaspAtom {
  element: string;
  position: number[];
  /** 选择性动力学：true = 完全固定（F F F） */
  fixed?: boolean;
  /** 选择性动力学：精细控制各方向 [true,false,true] 或 [1,0,1] = x/z 可动 y 固定 */
  if_pos?: (boolean | number)[];
}

export class CreateVaspInputTool extends DFTTool {
  readonly name = "create_vasp_input";

  readonly description =
    "生成 VASP 计算输入文件（INCAR + POSCAR + KPOINTS）。\n" +
    "POTCAR 由系统在超算上自动从赝势库拼接，无需手动处理。\n" +
    "每个物理参数必须在 _reasons 中提供选择依据。\n\n" +
    "**选择性动力学（Slab 固定底层原子）**：\n" +
    "在 atoms 数组中设置 `fixed: true`（完全固定 F F F）或 `if_pos: [true, false, true]`（精细控制各方向）。";

  readonly inputSchema = {
    type: "object",
    properties: {
      calc_type: {
        type: "string",
        enum: ["scf", "relax", "band", "dos", "md", "neb"],
        description: "计算类型。neb = NEB 过渡态搜索（需要 structure_data_final）",
      },
      structure_data: {
        type: "object",
        description: "结构数据",
        properties: {
          atoms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                element: { type: "string" },
                position: { type: "array", items: { type: "number" } },
                fixed: { type: "boolean", description: "完全固定（Selective Dynamics F F F）" },
                if_pos: { type: "array", description: "各方向可动性 [x, y, z]，true/1=可动 false/0=固定" },
              },
              required: ["element", "position"],
            },
          },
          cell_parameters: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description: "3×3 晶胞矩阵（Å）",
          },
          coords_are_cartesian: {
            type: "boolean",
            description: "坐标是否为笛卡尔坐标（默认 false = 分数坐标）",
          },
        },
        required: ["atoms", "cell_parameters"],
      },
      incar: {
        type: "object",
        description: "INCAR 参数字典（key=参数名, value=参数值）",
      },
      kpoints: {
        type: "object",
        description: "K 点设置",
        properties: {
          grid: { type: "array", items: { type: "number" }, description: "Monkhorst-Pack 网格 [k1, k2, k3]" },
          shift: { type: "array", items: { type: "number" }, description: "K 点平移 [s1, s2, s3]" },
          mode: { type: "string", enum: ["monkhorst-pack", "gamma", "line"], description: "K 点模式" },
          kpath: {
            type: "array",
            description:
              "能带 K 路径（仅 line 模式）。每个元素是一个高对称点对象 {label, coords}，" +
              "工具按相邻两点连成一段路径。示例：" +
              '[{"label":"GAMMA","coords":[0,0,0]},{"label":"X","coords":[0.5,0,0.5]}]。' +
              "字段名是 coords（倒易空间分数坐标），不是 point。可用 run_pymatgen 调 HighSymmKpath 自动生成标准路径。",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "高对称点标签（如 GAMMA, X, L, W, K）" },
                coords: { type: "array", items: { type: "number" }, description: "倒易空间分数坐标 [k1, k2, k3]" },
              },
              required: ["label", "coords"],
            },
          },
          npoints: { type: "number", description: "K 路径每段采样点数（默认 20）" },
        },
      },
      potcar_variants: {
        type: "object",
        description: "元素 → POTCAR 变体映射（如 {Fe: 'Fe_pv'}），未指定的元素使用推荐默认值",
      },
      structure_data_final: {
        type: "object",
        description:
          "NEB 终态结构（仅 neb 类型必须）。格式与 structure_data 完全一致。\n" +
          "初态和终态的原子数、元素种类和顺序必须完全一致。",
        properties: {
          atoms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                element: { type: "string" },
                position: { type: "array", items: { type: "number" } },
              },
              required: ["element", "position"],
            },
          },
          cell_parameters: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description: "3×3 晶胞矩阵（Å）— 应与初态一致",
          },
          coords_are_cartesian: {
            type: "boolean",
            description: "坐标是否为笛卡尔坐标（默认 false）",
          },
        },
        required: ["atoms", "cell_parameters"],
      },
      neb_images: {
        type: "integer",
        description: "NEB 中间 image 数量（默认 4，通常 4-8）。不含初态和终态。",
      },
      output_dir: {
        type: "string",
        description: "输出目录（支持绝对路径或相对于 workspace 的相对路径）",
      },
      system_name: {
        type: "string",
        description: "体系名称（用于 POSCAR 注释行）",
      },
      _reasons: {
        type: "object",
        description: "参数选择理由（key=参数名, value=理由）。ENCUT/ISPIN/ISMEAR 等关键参数必须覆盖。",
      },
    },
    required: ["calc_type", "structure_data", "incar", "kpoints", "output_dir", "_reasons"],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.structure_data) return "缺少 structure_data";
    if (!args.incar) return "缺少 incar 参数";
    if (!args.kpoints) return "缺少 kpoints 参数";
    if (!args._reasons) return "缺少 _reasons 参数审计";
    const sd = args.structure_data as Record<string, unknown>;
    if (!sd.atoms || !Array.isArray(sd.atoms) || sd.atoms.length === 0) return "structure_data.atoms 不能为空";
    if (!sd.cell_parameters) return "structure_data.cell_parameters 不能为空";

    const calcType = args.calc_type as string;

    // NOTE: band 计算必须使用 line 模式 K 路径，不能用 MP 网格
    if (calcType === "band") {
      const kp = args.kpoints as Record<string, unknown>;
      if (!kp.kpath || kp.mode !== "line") {
        return (
          "band 计算需要 K 路径（kpoints.mode='line' + kpoints.kpath），不能使用 Monkhorst-Pack 网格。\n" +
          "请提供 kpath 数组，每个元素: {label: 'G', coords: [0, 0, 0]}。\n" +
          "可使用 run_pymatgen 调用 pymatgen 的 HighSymmKpath 自动生成标准路径。"
        );
      }
    }

    // NOTE: NEB 必须提供终态结构，且初态/终态原子数和元素必须一致
    if (calcType === "neb") {
      if (!args.structure_data_final) {
        return "NEB 计算必须提供 structure_data_final（终态结构），格式与 structure_data 一致。";
      }
      const sdFinal = args.structure_data_final as Record<string, unknown>;
      if (!sdFinal.atoms || !Array.isArray(sdFinal.atoms) || (sdFinal.atoms as unknown[]).length === 0) {
        return "structure_data_final.atoms 不能为空";
      }
      const atomsI = sd.atoms as { element: string }[];
      const atomsF = sdFinal.atoms as { element: string }[];
      if (atomsI.length !== atomsF.length) {
        return `初态和终态原子数不一致：初态 ${atomsI.length} 个，终态 ${atomsF.length} 个。NEB 要求完全一一对应。`;
      }
      // 检查元素顺序一致性
      for (let i = 0; i < atomsI.length; i++) {
        if (atomsI[i].element !== atomsF[i].element) {
          return `第 ${i + 1} 个原子元素不一致：初态 ${atomsI[i].element}，终态 ${atomsF[i].element}。NEB 要求原子顺序完全一致。`;
        }
      }
    }

    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const calcType = args.calc_type as string;
    const sd = args.structure_data as {
      atoms: VaspAtom[];
      cell_parameters: number[][];
      coords_are_cartesian?: boolean;
    };
    const incar = args.incar as Record<string, unknown>;
    const kpoints = args.kpoints as Record<string, unknown>;
    const userVariants = (args.potcar_variants as Record<string, string>) ?? {};
    const systemName = (args.system_name as string) ?? "VASP_calc";
    const reasons = args._reasons as Record<string, string>;

    // --- P0 修复：路径锚定逻辑，与 create_qe_input 保持一致 ---
    // NOTE: 相对路径锚定到 workspace/{sessionId}，绝对路径直接使用
    const rawOutputDir = args.output_dir as string;
    let outputDir: string;
    if (rawOutputDir.startsWith("/") || /^[A-Z]:\\/.test(rawOutputDir)) {
      outputDir = rawOutputDir;
    } else if (this.workspaceDir) {
      outputDir = join(this.workspaceDir, rawOutputDir);
    } else {
      console.warn(`[CreateVaspInput] workspaceDir 未设置，output_dir 将相对于 cwd 解析: ${rawOutputDir}`);
      outputDir = rawOutputDir;
    }

    // --- NEB 过渡态搜索：独立处理分支 ---
    // NOTE: NEB 目录结构和文件生成逻辑与常规 VASP 完全不同，单独处理
    if (calcType === "neb") {
      return this.executeNEB(args, outputDir);
    }

    // --- P2 修复：_reasons 关键参数覆盖率校验 ---
    const missingReasons: string[] = [];
    for (const key of Object.keys(incar)) {
      if (CRITICAL_INCAR_PARAMS.has(key.toUpperCase()) && !(key in reasons) && !(key.toUpperCase() in reasons)) {
        missingReasons.push(key);
      }
    }
    if (missingReasons.length > 0) {
      return {
        success: false,
        error:
          `参数审计失败：以下关键 INCAR 参数缺少 _reasons 论证：${missingReasons.join(", ")}。\n` +
          "请在 _reasons 中为每个关键参数添加选择依据后重试。",
      };
    }

    // --- P2 修复：EDIFF 合理性校验 ---
    const ediffKey = Object.keys(incar).find((k) => k.toUpperCase() === "EDIFF");
    if (ediffKey !== undefined) {
      const ediffVal = incar[ediffKey] as number;
      if (typeof ediffVal === "number" && ediffVal > 0.01) {
        return {
          success: false,
          error:
            `EDIFF = ${ediffVal} 明显不合理（典型值 1E-5 ~ 1E-7）。\n` +
            "请检查是否为数量级错误。推荐值：SCF 1E-6，高精度 1E-7。",
        };
      }
    }

    // 确保输出目录存在
    await mkdir(outputDir, { recursive: true });

    // 提取元素顺序（POSCAR 规范：按出现顺序去重）
    const elementOrder: string[] = [];
    for (const atom of sd.atoms) {
      if (!elementOrder.includes(atom.element)) {
        elementOrder.push(atom.element);
      }
    }

    // 确定 POTCAR 变体
    const potcarOrder: string[] = elementOrder.map((el) =>
      userVariants[el] ?? POTCAR_RECOMMENDED[el] ?? el
    );

    // --- P1 修复：ISPIN + MAGMOM 一致性校验（确定性检查） ---
    const magneticWarnings: string[] = [];
    const ispinKey = Object.keys(incar).find((k) => k.toUpperCase() === "ISPIN");
    const magmomKey = Object.keys(incar).find((k) => k.toUpperCase() === "MAGMOM");
    if (ispinKey !== undefined && incar[ispinKey] === 2) {
      if (magmomKey === undefined) {
        magneticWarnings.push(
          "⚠️ ISPIN=2 但未设置 MAGMOM，VASP 将默认所有原子初始磁矩 1.0 μB（FM 排列）。" +
          "如需特定磁序（AFM/FiM），必须显式设置 MAGMOM。"
        );
      } else {
        // 检查 MAGMOM 值的一致性
        const magmomVal = incar[magmomKey];
        if (typeof magmomVal === "string") {
          // NOTE: VASP MAGMOM 格式 "4*1.0 4*-1.0" 或 "1.0 1.0 -1.0 -1.0"
          const nums = magmomVal.replace(/(\d+)\*/g, (_, n) => {
            return Array(parseInt(n)).fill("0").join(" ") + " ";
          }).trim().split(/\s+/).map(Number).filter((v) => !isNaN(v));

          if (nums.length > 0) {
            const allPositive = nums.every((v) => v >= 0);
            const allNegative = nums.every((v) => v <= 0);
            const allZero = nums.every((v) => Math.abs(v) < 0.001);
            if (allZero) {
              magneticWarnings.push(
                "⚠️ MAGMOM 全部 ≈ 0 → 等同于非磁性计算，ISPIN=2 无实际效果。"
              );
            } else if (allPositive || allNegative) {
              magneticWarnings.push(
                "⚠️ MAGMOM 全部同号 → 将得到铁磁(FM)解。" +
                "如需反铁磁(AFM)，请设置正负相反的磁矩值。"
              );
            }
          }
        }
      }
    }

    // 1. 生成 POSCAR（含 Selective Dynamics 支持）
    const poscar = this.buildPoscar(systemName, sd, elementOrder);
    await writeFile(join(outputDir, "POSCAR"), poscar);

    // 2. 生成 INCAR
    const incarContent = this.buildIncar(incar, calcType);
    await writeFile(join(outputDir, "INCAR"), incarContent);

    // 3. 生成 KPOINTS
    const kpointsContent = this.buildKpoints(kpoints, calcType);
    await writeFile(join(outputDir, "KPOINTS"), kpointsContent);

    // 4. 保存 POTCAR 顺序信息（供 run_command 路由使用）
    const potcarMeta = {
      elements: elementOrder,
      variants: potcarOrder,
      potcar_dir: appConfig.scnetPotcarDir,
    };
    await writeFile(join(outputDir, ".potcar_meta.json"), JSON.stringify(potcarMeta, null, 2));

    // 5. 导出 VASP 格式结构文件到 structures/ 目录
    const parentDir = dirname(outputDir);
    const structDir = join(parentDir, "structures");
    if (!existsSync(structDir)) await mkdir(structDir, { recursive: true });
    const structName = `${systemName}_initial.vasp`;
    await writeFile(join(structDir, structName), poscar);

    // 审计记录
    const auditEntry = {
      timestamp: new Date().toISOString(),
      calc_type: calcType,
      elements: elementOrder,
      potcar_variants: potcarOrder,
      n_atoms: sd.atoms.length,
      reasons,
    };

    const display =
      `📝 VASP 输入文件已生成\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• 计算类型: ${calcType}\n` +
      `• 原子数: ${sd.atoms.length}\n` +
      `• 元素: ${elementOrder.join(", ")}\n` +
      `• POTCAR: ${potcarOrder.join(" + ")}\n` +
      `• 目录: ${outputDir}\n` +
      `• 文件: INCAR, POSCAR, KPOINTS` +
      (magneticWarnings.length > 0 ? `\n\n${magneticWarnings.join("\n")}` : "");

    return {
      success: true,
      data: {
        files: ["INCAR", "POSCAR", "KPOINTS"],
        output_dir: outputDir,
        potcar_order: potcarOrder,
        potcar_meta: potcarMeta,
        element_order: elementOrder,
        n_atoms: sd.atoms.length,
        // NOTE: 磁性一致性校验警告，Agent 应据此判断是否需要调整
        ...(magneticWarnings.length > 0 ? { magnetic_warnings: magneticWarnings } : {}),
      },
      display,
      // P1 修复：审计记录作为顶层字段返回，与 create_qe_input 一致
      audit: auditEntry,
    };
  }

  /**
   * 生成 POSCAR 内容
   *
   * NOTE: 支持 Selective Dynamics（slab 计算固定底层原子）
   * atoms[].fixed = true → F F F（完全固定）
   * atoms[].if_pos = [true, false, true] → T F T（精细控制）
   */
  private buildPoscar(
    systemName: string,
    sd: { atoms: VaspAtom[]; cell_parameters: number[][]; coords_are_cartesian?: boolean },
    elementOrder: string[],
  ): string {
    const lines: string[] = [systemName, "1.0"];

    // 晶胞向量
    for (const vec of sd.cell_parameters) {
      lines.push(`  ${vec.map((v) => v.toFixed(10).padStart(16)).join("")}`);
    }

    // 元素行
    lines.push(elementOrder.join("  "));

    // 每种元素的原子数
    const counts = elementOrder.map((el) => sd.atoms.filter((a) => a.element === el).length);
    lines.push(counts.join("  "));

    // 检测是否有任何原子需要 Selective Dynamics
    const hasSelectiveDynamics = sd.atoms.some(
      (a) => a.fixed === true || (a.if_pos && Array.isArray(a.if_pos))
    );

    // Selective Dynamics 行（必须在坐标类型行之前）
    if (hasSelectiveDynamics) {
      lines.push("Selective Dynamics");
      const nFixed = sd.atoms.filter((a) => a.fixed === true).length;
      console.log(`[CreateVaspInput] 🔒 选择性动力学: ${nFixed}/${sd.atoms.length} 原子固定`);
    }

    // 坐标类型
    lines.push(sd.coords_are_cartesian ? "Cartesian" : "Direct");

    // 原子坐标（按元素顺序排列）
    for (const el of elementOrder) {
      for (const atom of sd.atoms.filter((a) => a.element === el)) {
        const [x, y, z] = atom.position;
        let line = `  ${x.toFixed(10).padStart(16)}${y.toFixed(10).padStart(16)}${z.toFixed(10).padStart(16)}`;

        if (hasSelectiveDynamics) {
          if (atom.fixed === true) {
            line += "  F  F  F";
          } else if (atom.if_pos && Array.isArray(atom.if_pos) && atom.if_pos.length === 3) {
            // NOTE: if_pos 中 truthy 值(true/1) = 可动(T)，falsy 值(false/0) = 固定(F)
            line += atom.if_pos.map((v) => (v ? "  T" : "  F")).join("");
          } else {
            // 未指定约束的原子默认全部可动
            line += "  T  T  T";
          }
        }

        lines.push(line);
      }
    }

    return lines.join("\n") + "\n";
  }

  /** 生成 INCAR 内容 */
  private buildIncar(incar: Record<string, unknown>, calcType: string): string {
    const lines: string[] = [`# INCAR for ${calcType} calculation`, ""];

    // 按分类排列参数
    const categories: Record<string, string[]> = {
      "# Electronic": ["ENCUT", "EDIFF", "NELM", "ALGO", "LREAL", "PREC", "ISMEAR", "SIGMA"],
      "# Ionic": ["NSW", "IBRION", "ISIF", "EDIFFG", "POTIM"],
      "# Magnetic": ["ISPIN", "MAGMOM"],
      "# DFT+U": ["LDAU", "LDAUU", "LDAUL", "LDAUJ", "LDAUTYPE", "LDAUPRINT"],
      "# Output": ["LWAVE", "LCHARG", "LORBIT", "NEDOS", "NPAR", "KPAR"],
      "# Other": [],
    };

    const written = new Set<string>();
    for (const [cat, keys] of Object.entries(categories)) {
      const catLines: string[] = [];
      for (const key of keys) {
        const upperKey = key.toUpperCase();
        // 在 incar 中查找（不区分大小写）
        const matchKey = Object.keys(incar).find((k) => k.toUpperCase() === upperKey);
        if (matchKey !== undefined) {
          catLines.push(this.formatIncarParam(upperKey, incar[matchKey]));
          written.add(matchKey);
        }
      }
      if (catLines.length > 0) {
        lines.push(cat);
        lines.push(...catLines);
        lines.push("");
      }
    }

    // 剩余未分类参数
    const remaining = Object.entries(incar).filter(([k]) => !written.has(k));
    if (remaining.length > 0) {
      lines.push("# Other");
      for (const [key, val] of remaining) {
        lines.push(this.formatIncarParam(key.toUpperCase(), val));
      }
    }

    return lines.join("\n") + "\n";
  }

  /** 格式化单个 INCAR 参数 */
  private formatIncarParam(key: string, value: unknown): string {
    if (typeof value === "boolean") {
      return `${key} = .${value ? "TRUE" : "FALSE"}.`;
    }
    if (Array.isArray(value)) {
      return `${key} = ${value.join(" ")}`;
    }
    return `${key} = ${value}`;
  }

  /** 生成 KPOINTS 内容 */
  private buildKpoints(kp: Record<string, unknown>, calcType: string): string {
    const mode = (kp.mode as string) ?? "monkhorst-pack";

    if (mode === "line" && kp.kpath) {
      // 能带模式
      const kpath = kp.kpath as { label: string; coords: number[] }[];
      const npoints = (kp.npoints as number) ?? 20;
      const lines = ["K-path for band structure", `${npoints}`];
      lines.push("Line-mode");
      lines.push("Reciprocal");
      for (let i = 0; i < kpath.length - 1; i++) {
        const start = kpath[i];
        const end = kpath[i + 1];
        lines.push(`${start.coords.join(" ")}  ! ${start.label}`);
        lines.push(`${end.coords.join(" ")}  ! ${end.label}`);
        lines.push("");
      }
      return lines.join("\n") + "\n";
    }

    // 标准网格模式
    const grid = (kp.grid as number[]) ?? [1, 1, 1];
    const shift = (kp.shift as number[]) ?? [0, 0, 0];
    const methodLabel = mode === "gamma" ? "Gamma" : "Monkhorst-Pack";
    return [
      `Automatic mesh`,
      "0",
      methodLabel,
      `${grid[0]}  ${grid[1]}  ${grid[2]}`,
      `${shift[0]}  ${shift[1]}  ${shift[2]}`,
    ].join("\n") + "\n";
  }

  // ==========================================================================
  // NEB 过渡态搜索 — 多目录结构生成
  // ==========================================================================

  /**
   * 执行 NEB 输入文件生成
   *
   * 与常规 VASP 计算的核心区别：
   * 1. 需要初态 + 终态两套结构
   * 2. 自动插值生成 N 个中间 image（IDPP 或线性）
   * 3. 创建 00/ 01/ ... N+1/ 多目录结构，每个目录一个 POSCAR
   * 4. INCAR/KPOINTS/POTCAR 共享在根目录
   *
   * 设计原则：
   * - IMAGES 参数由 neb_images 确定性映射，工具自动注入
   * - IBRION/SPRING/LCLIMB/POTIM 等算法参数由 Agent 决策，工具只校验+警告
   */
  private async executeNEB(
    args: Record<string, unknown>,
    outputDir: string,
  ): Promise<ToolResult> {
    const sd = args.structure_data as {
      atoms: VaspAtom[];
      cell_parameters: number[][];
      coords_are_cartesian?: boolean;
    };
    const sdFinal = args.structure_data_final as {
      atoms: VaspAtom[];
      cell_parameters: number[][];
      coords_are_cartesian?: boolean;
    };
    const incar = { ...(args.incar as Record<string, unknown>) };
    const kpoints = args.kpoints as Record<string, unknown>;
    const userVariants = (args.potcar_variants as Record<string, string>) ?? {};
    const systemName = (args.system_name as string) ?? "NEB_calc";
    const reasons = args._reasons as Record<string, string>;
    const nImages = (args.neb_images as number) ?? 4;

    // --- _reasons 审计：NEB 固定参数（IMAGES）免审计，其他参数正常校验 ---
    const NEB_AUTO_PARAMS = new Set(["IMAGES"]);
    const missingReasons: string[] = [];
    for (const key of Object.keys(incar)) {
      if (
        CRITICAL_INCAR_PARAMS.has(key.toUpperCase()) &&
        !NEB_AUTO_PARAMS.has(key.toUpperCase()) &&
        !(key in reasons) &&
        !(key.toUpperCase() in reasons)
      ) {
        missingReasons.push(key);
      }
    }
    if (missingReasons.length > 0) {
      return {
        success: false,
        error:
          `参数审计失败：以下关键 INCAR 参数缺少 _reasons 论证：${missingReasons.join(", ")}。\n` +
          "请在 _reasons 中为每个关键参数添加选择依据后重试。",
      };
    }

    // --- 确定性注入：IMAGES = neb_images（唯一确定映射） ---
    const imagesKey = Object.keys(incar).find((k) => k.toUpperCase() === "IMAGES");
    if (imagesKey) {
      // Agent 手动设了 IMAGES，校验是否与 neb_images 一致
      if (incar[imagesKey] !== nImages) {
        return {
          success: false,
          error:
            `INCAR 中 IMAGES=${incar[imagesKey]} 与 neb_images=${nImages} 不一致。\n` +
            "请保持一致，或只设置 neb_images（工具会自动注入 IMAGES）。",
        };
      }
    } else {
      // 自动注入（确定性：IMAGES = neb_images）
      incar.IMAGES = nImages;
    }

    // --- 物理合理性警告（不拦截，Agent 负责决策） ---
    const warnings: string[] = [];

    const ibrionKey = Object.keys(incar).find((k) => k.toUpperCase() === "IBRION");
    const ibrionVal = ibrionKey ? incar[ibrionKey] : undefined;
    const ioptKey = Object.keys(incar).find((k) => k.toUpperCase() === "IOPT");
    if (!ibrionKey) {
      warnings.push(
        "⚠️ 未设置 IBRION。NEB 通常使用 IBRION=3（配合 VTST IOPT）或 IBRION=1（准牛顿法）。"
      );
    } else if (ibrionVal === 1 || ibrionVal === 2) {
      // NOTE: Bug #19 — 原生 IBRION=1/2 做 NEB 收敛"尾巴"极差，建议改用 VTST IOPT
      warnings.push(
        "⚠️ IBRION=" + ibrionVal + " 做 NEB 收敛'尾巴'常很差：能量早早 settle 但 1–2 个原子的力" +
        "在 0.05–0.10 eV/Å 反复横跳，几百步触发不了力收敛。建议改用 VTST 优化器：" +
        "IBRION=3, POTIM=0, IOPT=7(FIRE) 或 IOPT=1(LBFGS)，尾部收敛远好于原生 IBRION。"
      );
    } else if (ibrionVal === 3 && !ioptKey) {
      warnings.push(
        "⚠️ IBRION=3 但未设 IOPT：这是阻尼 MD 而非 VTST 优化器。NEB 建议加 POTIM=0 + " +
        "IOPT=7(FIRE) 或 IOPT=1(LBFGS) 启用 VTST，收敛更稳（需 VASP 编入 VTST 插件）。"
      );
    }

    // NOTE: Bug #14 — NEB 中间 image 几乎不需要 WAVECAR/CHGCAR 输出，徒增每 image 几百 MB。
    // VASP 默认 LWAVE/LCHARG=.TRUE.，未显式关闭则提醒（遵循"工具警告、Agent 决策"原则，不强制覆盖）
    const isExplicitlyOff = (key: string | undefined): boolean => {
      if (key === undefined) return false;
      const v = incar[key];
      return v === false || /\.?false\.?/i.test(String(v));
    };
    const lwaveKey = Object.keys(incar).find((k) => k.toUpperCase() === "LWAVE");
    const lchargKey = Object.keys(incar).find((k) => k.toUpperCase() === "LCHARG");
    if (!isExplicitlyOff(lwaveKey) || !isExplicitlyOff(lchargKey)) {
      warnings.push(
        "⚠️ NEB 中间 image 通常无需 WAVECAR/CHGCAR 输出，建议显式设 LWAVE=.FALSE. 和 LCHARG=.FALSE. " +
        "省下每 image 数百 MB（VASP 默认 .TRUE.，不关则每个 image 目录都会写出）。"
      );
    }

    const lclimbKey = Object.keys(incar).find((k) => k.toUpperCase() === "LCLIMB");
    if (!lclimbKey) {
      warnings.push(
        "⚠️ 未设置 LCLIMB。建议 LCLIMB=.TRUE.（CI-NEB）以精确定位过渡态和活化能。"
      );
    }

    const springKey = Object.keys(incar).find((k) => k.toUpperCase() === "SPRING");
    if (!springKey) {
      warnings.push(
        "⚠️ 未设置 SPRING。NEB 弹簧常数默认 -5 eV/Å²。"
      );
    }

    const isifKey = Object.keys(incar).find((k) => k.toUpperCase() === "ISIF");
    if (isifKey && [0, 3].includes(incar[isifKey] as number)) {
      warnings.push(
        "⚠️ ISIF=" + incar[isifKey] + " 可能导致 NEB 晶格变化，通常应使用 ISIF=2（固定晶格）。"
      );
    }

    // --- 元素和 POTCAR ---
    const elementOrder: string[] = [];
    for (const atom of sd.atoms) {
      if (!elementOrder.includes(atom.element)) {
        elementOrder.push(atom.element);
      }
    }
    const potcarOrder: string[] = elementOrder.map((el) =>
      userVariants[el] ?? POTCAR_RECOMMENDED[el] ?? el
    );

    // --- 确保输出目录存在 ---
    await mkdir(outputDir, { recursive: true });

    // --- 生成中间 images：优先 IDPP，回退线性插值 ---
    let interpolatedImages: VaspAtom[][];
    let interpolationMethod: string;

    try {
      const pyResult = await this.callNebInterpolate({
        structure_data: {
          atoms: sd.atoms.map((a) => ({ element: a.element, position: a.position })),
          cell_parameters: sd.cell_parameters,
          coords_are_cartesian: sd.coords_are_cartesian ?? false,
        },
        structure_data_final: {
          atoms: sdFinal.atoms.map((a) => ({ element: a.element, position: a.position })),
          cell_parameters: sdFinal.cell_parameters,
          coords_are_cartesian: sdFinal.coords_are_cartesian ?? false,
        },
        n_images: nImages,
        method: "idpp",
      });

      if (pyResult.success && pyResult.images) {
        interpolatedImages = pyResult.images.map((imgAtoms: { element: string; position: number[] }[]) =>
          imgAtoms.map((a) => ({ element: a.element, position: a.position }))
        );
        interpolationMethod = pyResult.method ?? "idpp";
      } else {
        // pymatgen 调用失败，回退到内置线性插值
        console.warn(`[CreateVaspInput] pymatgen IDPP 失败: ${pyResult.error}，回退到线性插值`);
        interpolatedImages = this.linearInterpolate(sd.atoms, sdFinal.atoms, nImages);
        interpolationMethod = "linear (pymatgen fallback)";
      }
    } catch {
      // Python 桥接完全不可用，使用内置线性插值
      console.warn("[CreateVaspInput] Python 桥接不可用，使用内置线性插值");
      interpolatedImages = this.linearInterpolate(sd.atoms, sdFinal.atoms, nImages);
      interpolationMethod = "linear (built-in)";
    }

    // --- 创建多目录结构并写文件 ---
    const totalDirs = nImages + 2; // 00(初态) + N(images) + N+1(终态)

    // 写 INCAR（根目录）
    const incarContent = this.buildIncar(incar, "neb");
    await writeFile(join(outputDir, "INCAR"), incarContent);

    // 写 KPOINTS（根目录）
    const kpointsContent = this.buildKpoints(kpoints, "neb");
    await writeFile(join(outputDir, "KPOINTS"), kpointsContent);

    // 写 POTCAR meta（根目录）
    const potcarMeta = {
      elements: elementOrder,
      variants: potcarOrder,
      potcar_dir: appConfig.scnetPotcarDir,
    };
    await writeFile(join(outputDir, ".potcar_meta.json"), JSON.stringify(potcarMeta, null, 2));

    // 创建各 image 目录并写 POSCAR
    for (let i = 0; i < totalDirs; i++) {
      const dirName = i.toString().padStart(2, "0");
      const dirPath = join(outputDir, dirName);
      await mkdir(dirPath, { recursive: true });

      let atoms: VaspAtom[];
      let label: string;
      if (i === 0) {
        atoms = sd.atoms;
        label = `${systemName} - Initial (image 00)`;
      } else if (i === totalDirs - 1) {
        atoms = sdFinal.atoms;
        label = `${systemName} - Final (image ${dirName})`;
      } else {
        atoms = interpolatedImages[i - 1];
        label = `${systemName} - Image ${dirName} (${interpolationMethod})`;
      }

      const poscar = this.buildPoscar(label, { atoms, cell_parameters: sd.cell_parameters, coords_are_cartesian: sd.coords_are_cartesian }, elementOrder);
      await writeFile(join(dirPath, "POSCAR"), poscar);
    }

    // --- 审计记录 ---
    const auditEntry = {
      timestamp: new Date().toISOString(),
      calc_type: "neb",
      n_images: nImages,
      interpolation_method: interpolationMethod,
      elements: elementOrder,
      potcar_variants: potcarOrder,
      n_atoms: sd.atoms.length,
      reasons,
    };

    const dirList = Array.from({ length: totalDirs }, (_, i) => i.toString().padStart(2, "0"));

    const display =
      `📝 VASP NEB 输入文件已生成\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• 计算类型: NEB (过渡态搜索)\n` +
      `• 中间 images: ${nImages} (${interpolationMethod})\n` +
      `• 原子数: ${sd.atoms.length}\n` +
      `• 元素: ${elementOrder.join(", ")}\n` +
      `• POTCAR: ${potcarOrder.join(" + ")}\n` +
      `• 目录: ${outputDir}\n` +
      `• 子目录: ${dirList.join(", ")} (共 ${totalDirs} 个)\n` +
      `• 文件: INCAR, KPOINTS, ${dirList.map(d => d + "/POSCAR").join(", ")}` +
      (warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "");

    return {
      success: true,
      data: {
        files: ["INCAR", "KPOINTS", ...dirList.map((d) => `${d}/POSCAR`)],
        output_dir: outputDir,
        potcar_order: potcarOrder,
        potcar_meta: potcarMeta,
        element_order: elementOrder,
        n_atoms: sd.atoms.length,
        n_images: nImages,
        interpolation_method: interpolationMethod,
        image_dirs: dirList,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      display,
      audit: auditEntry,
    };
  }

  /**
   * 内置线性插值（TypeScript 实现，pymatgen 不可用时的兜底方案）
   *
   * 在初态和终态之间按等比例插值生成 N 个中间结构的坐标。
   * 假设使用分数坐标，原子顺序一一对应。
   *
   * 局限：不处理周期性边界跨越（原子跨越晶胞边界时可能产生非物理路径），
   * 也不避免原子重叠。生产环境建议使用 IDPP。
   */
  private linearInterpolate(
    atomsInitial: VaspAtom[],
    atomsFinal: VaspAtom[],
    nImages: number,
  ): VaspAtom[][] {
    const images: VaspAtom[][] = [];
    for (let i = 1; i <= nImages; i++) {
      const fraction = i / (nImages + 1);
      const imageAtoms = atomsInitial.map((atomI, idx) => {
        const atomF = atomsFinal[idx];
        return {
          element: atomI.element,
          position: atomI.position.map(
            (v, j) => v + fraction * (atomF.position[j] - v),
          ),
        };
      });
      images.push(imageAtoms);
    }
    return images;
  }

  /**
   * 调用 Python 脚本执行 NEB 插值（IDPP 或线性）
   *
   * 通过 stdin/stdout JSON 通信，与 run_pymatgen 的桥接模式一致。
   * 30 秒超时保护。
   */
  private callNebInterpolate(
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; images?: { element: string; position: number[] }[][]; method?: string; error?: string }> {
    return new Promise((resolve) => {
      const scriptPath = join(
        __dirname, "..", "..", "scripts", "neb_interpolate.py",
      );

      const isWindows = process.platform === "win32";
      let proc;
      if (isWindows) {
        proc = spawn("python", [scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
      } else {
        const venvPython = "/opt/dft-venv/bin/python3";
        const pythonCmd = `${venvPython} "${scriptPath}" 2>/dev/null || python3 "${scriptPath}"`;
        proc = spawn("bash", ["-c", pythonCmd], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
      }

      let stdout = "";
      let stderr = "";
      let killed = false;

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, 30_000);

      proc.stdin.on("error", () => { /* EPIPE — close 事件中处理 */ });
      proc.stdin.write(JSON.stringify(params));
      proc.stdin.end();

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ success: false, error: "IDPP 插值超时 (30s)" });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch {
          resolve({ success: false, error: `Python 输出解析失败: ${stderr.slice(0, 200)}` });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: `Python 进程启动失败: ${err.message}` });
      });
    });
  }
}
