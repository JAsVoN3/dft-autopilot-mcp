/**
 * extract_gaussian_results — 从 Gaussian 16 输出文件（.log）提取结构化结果
 *
 * 支持 result_type: sp / opt / freq / td / irc / scan / pop
 */

import { readFileSync, existsSync } from "fs";
import { DFTTool, type ToolResult } from "./base.js";

export class ExtractGaussianResultsTool extends DFTTool {
  readonly name = "extract_gaussian_results";

  readonly description =
    "从 Gaussian 16 输出文件（.log）提取结构化计算结果。\n" +
    "支持 result_type: sp / opt / freq / td / irc / scan / pop。\n" +
    "不指定 result_type 时自动检测。";

  readonly inputSchema = {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: ".log 输出文件的完整路径",
      },
      result_type: {
        type: "string",
        enum: ["sp", "opt", "freq", "td", "irc", "scan", "pop"],
        description: "结果类型（可选，不传则自动检测）",
      },
    },
    required: ["file_path"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = args.file_path as string;
    const resultType = args.result_type as string | undefined;

    if (!existsSync(filePath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const results: Record<string, unknown> = { file_path: filePath };

      // 检查是否正常结束
      results.normal_termination = content.includes("Normal termination of Gaussian");

      // 提取 SCF 能量
      const scfMatches = [...content.matchAll(/SCF Done:\s+E\([^)]+\)\s*=\s*([-\d.]+)/g)];
      if (scfMatches.length > 0) {
        results.scf_energies_hartree = scfMatches.map((m) => parseFloat(m[1]));
        results.final_energy_hartree = parseFloat(scfMatches[scfMatches.length - 1][1]);
        results.final_energy_ev = (results.final_energy_hartree as number) * 27.21138602;
      }

      // 提取零点能和热力学数据
      const zpveMatch = content.match(/Zero-point correction=\s+([-\d.]+)/);
      if (zpveMatch) results.zpve_hartree = parseFloat(zpveMatch[1]);

      const thermalMatch = content.match(/Thermal correction to Energy=\s+([-\d.]+)/);
      if (thermalMatch) results.thermal_energy_hartree = parseFloat(thermalMatch[1]);

      const enthalpyMatch = content.match(/Thermal correction to Enthalpy=\s+([-\d.]+)/);
      if (enthalpyMatch) results.thermal_enthalpy_hartree = parseFloat(enthalpyMatch[1]);

      const gibbsMatch = content.match(/Thermal correction to Gibbs Free Energy=\s+([-\d.]+)/);
      if (gibbsMatch) results.thermal_gibbs_hartree = parseFloat(gibbsMatch[1]);

      // 提取偶极矩
      const dipoleMatch = content.match(/Dipole moment \(field-independent basis.*?\):\s*\n\s*X=\s*([-\d.]+)\s+Y=\s*([-\d.]+)\s+Z=\s*([-\d.]+)\s+Tot=\s*([-\d.]+)/);
      if (dipoleMatch) {
        results.dipole_moment = {
          x: parseFloat(dipoleMatch[1]),
          y: parseFloat(dipoleMatch[2]),
          z: parseFloat(dipoleMatch[3]),
          total: parseFloat(dipoleMatch[4]),
        };
      }

      // 几何优化收敛
      if (content.includes("Stationary point found")) {
        results.opt_converged = true;
      } else if (content.includes("Converged?")) {
        results.opt_converged = false;
      }

      // 优化步数
      const optSteps = (content.match(/Step number\s+\d+/g) ?? []).length;
      if (optSteps > 0) results.n_opt_steps = optSteps;

      // 频率
      const freqMatches = [...content.matchAll(/Frequencies --\s+([-\d.]+(?:\s+[-\d.]+)*)/g)];
      if (freqMatches.length > 0) {
        const allFreqs: number[] = [];
        for (const m of freqMatches) {
          allFreqs.push(...m[1].trim().split(/\s+/).map(Number));
        }
        results.frequencies_cm1 = allFreqs;
        results.n_imaginary = allFreqs.filter((f) => f < 0).length;
        results.min_frequency_cm1 = Math.min(...allFreqs);
        results.max_frequency_cm1 = Math.max(...allFreqs);
        // NOTE: 负频数量判断结构稳定性
        if (allFreqs.filter((f) => f < 0).length === 0) {
          results.structure_type = "minimum";
        } else if (allFreqs.filter((f) => f < 0).length === 1) {
          results.structure_type = "transition_state";
        } else {
          results.structure_type = "higher_order_saddle";
        }
      }

      // TD-DFT 激发态
      const exciteMatches = [...content.matchAll(/Excited State\s+(\d+):\s+\S+\s+([-\d.]+)\s+eV\s+([-\d.]+)\s+nm\s+f=([-\d.]+)/g)];
      if (exciteMatches.length > 0) {
        results.excited_states = exciteMatches.map((m) => ({
          state: parseInt(m[1]),
          energy_ev: parseFloat(m[2]),
          wavelength_nm: parseFloat(m[3]),
          oscillator_strength: parseFloat(m[4]),
        }));
      }

      // Mulliken 电荷
      const mullikenStart = content.lastIndexOf("Mulliken charges:");
      if (mullikenStart !== -1) {
        const block = content.slice(mullikenStart, mullikenStart + 2000);
        const chargeMatches = [...block.matchAll(/^\s+\d+\s+([A-Z][a-z]?)\s+([-\d.]+)/gm)];
        if (chargeMatches.length > 0) {
          results.mulliken_charges = chargeMatches.map((m) => ({
            element: m[1],
            charge: parseFloat(m[2]),
          }));
        }
      }

      // 提取最终优化结构
      const structData = this.extractFinalStructure(content);
      if (structData) results.structure_data = structData;

      // 自动检测结果类型
      const detected = resultType ?? this.detectType(results);
      results.result_type = detected;

      const display = this.buildDisplay(results, detected);
      return { success: true, data: results, display };
    } catch (e) {
      return { success: false, error: `解析失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  /** 从 Gaussian 输出中提取最终结构坐标 */
  private extractFinalStructure(content: string): Record<string, unknown> | null {
    // 查找最后一个 "Standard orientation" 或 "Input orientation" 坐标块。
    // NOTE: orientation: 之后的结构是【分隔线 → 两行表头 → 分隔线 → 坐标数据 → 分隔线】。
    // 旧正则只跳过第一条分隔线就开始捕获，结果抓到的是表头两行；表头第 2 行
    // "Number Number Type X Y Z" 恰好 6 列，被当成坐标解析 → parseInt("Number")=NaN
    // → element="XNaN"、position=[NaN,NaN,NaN]。这里显式跳过表头，捕获第二条分隔线之后的数据。
    const orientRegex = /(?:Standard|Input) orientation:\s*\n\s*-{10,}\n[\s\S]*?-{10,}\n([\s\S]*?)\n\s*-{10,}/g;
    const matches = [...content.matchAll(orientRegex)];
    if (matches.length === 0) return null;

    const lastBlock = matches[matches.length - 1][1];
    const atoms: { element: string; position: number[] }[] = [];
    // 原子序数 → 元素符号映射
    const atomicSymbols: Record<number, string> = {
      1: "H", 2: "He", 3: "Li", 4: "Be", 5: "B", 6: "C", 7: "N", 8: "O",
      9: "F", 10: "Ne", 11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",
      16: "S", 17: "Cl", 18: "Ar", 19: "K", 20: "Ca", 21: "Sc", 22: "Ti",
      23: "V", 24: "Cr", 25: "Mn", 26: "Fe", 27: "Co", 28: "Ni", 29: "Cu",
      30: "Zn", 31: "Ga", 32: "Ge", 33: "As", 34: "Se", 35: "Br", 36: "Kr",
      44: "Ru", 45: "Rh", 46: "Pd", 47: "Ag", 48: "Cd", 49: "In", 50: "Sn",
      77: "Ir", 78: "Pt", 79: "Au", 82: "Pb",
    };

    for (const line of lastBlock.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        const atomicNum = parseInt(parts[1]);
        const x = parseFloat(parts[3]), y = parseFloat(parts[4]), z = parseFloat(parts[5]);
        // 防御：跳过任何非坐标行（如残留表头），避免 NaN 污染结构（与正则修复构成双保险）
        if (!Number.isFinite(atomicNum) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const element = atomicSymbols[atomicNum] ?? `X${atomicNum}`;
        atoms.push({ element, position: [x, y, z] });
      }
    }

    if (atoms.length === 0) return null;
    return { atoms, coords_are_cartesian: true };
  }

  /** 自动检测结果类型 */
  private detectType(results: Record<string, unknown>): string {
    if (results.excited_states) return "td";
    if (results.frequencies_cm1) return "freq";
    if (results.n_opt_steps && (results.n_opt_steps as number) > 0) return "opt";
    return "sp";
  }

  /** 构建展示内容 */
  private buildDisplay(results: Record<string, unknown>, resultType: string): string {
    const lines = [`📊 Gaussian 结果提取 (${resultType})\n━━━━━━━━━━━━━━━━━━━━━━━━━━`];

    if (results.final_energy_hartree !== undefined) {
      lines.push(`• 能量: ${(results.final_energy_hartree as number).toFixed(8)} Hartree`);
      lines.push(`        ${(results.final_energy_ev as number).toFixed(6)} eV`);
    }
    lines.push(`• 正常结束: ${results.normal_termination ? "✅" : "❌"}`);

    if (results.opt_converged !== undefined) {
      lines.push(`• 优化收敛: ${results.opt_converged ? "✅" : "❌"}`);
      if (results.n_opt_steps) lines.push(`• 优化步数: ${results.n_opt_steps}`);
    }

    if (results.zpve_hartree !== undefined) {
      lines.push(`• 零点能: ${(results.zpve_hartree as number).toFixed(6)} Hartree`);
    }
    if (results.thermal_gibbs_hartree !== undefined) {
      lines.push(`• Gibbs 校正: ${(results.thermal_gibbs_hartree as number).toFixed(6)} Hartree`);
    }

    if (results.n_imaginary !== undefined) {
      lines.push(`• 虚频数: ${results.n_imaginary} (${results.structure_type})`);
    }

    if (results.dipole_moment) {
      const dp = results.dipole_moment as { total: number };
      lines.push(`• 偶极矩: ${dp.total.toFixed(4)} Debye`);
    }

    if (results.excited_states) {
      const states = results.excited_states as { state: number; energy_ev: number; wavelength_nm: number; oscillator_strength: number }[];
      lines.push(`• 激发态: ${states.length} 个`);
      const strongest = states.reduce((a, b) => a.oscillator_strength > b.oscillator_strength ? a : b);
      lines.push(`  最强: S${strongest.state} = ${strongest.wavelength_nm.toFixed(1)} nm (f=${strongest.oscillator_strength.toFixed(4)})`);
    }

    return lines.join("\n");
  }
}
