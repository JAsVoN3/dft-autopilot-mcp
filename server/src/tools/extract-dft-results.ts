/**
 * extract_dft_results — 从 QE 输出文件提取结构化结果
 *
 * 完整移植自 Python 版 extract_dft_results.py（817行）。
 * 纯正则解析，无 Python 依赖。
 *
 * 支持 10 种解析类型：
 * scf / relax / bands / dos / pdos / bader /
 * workfunction / neb / optical / phonon
 */

import { readFile, stat } from "fs/promises";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename, dirname, isAbsolute, resolve } from "path";
import { DFTTool, type ToolResult } from "./base.js";

export class ExtractDFTResultsTool extends DFTTool {
  readonly name = "extract_dft_results";
  readonly description =
    "从 QE 输出文件中提取结构化结果。" +
    "自动解析能量、收敛性、磁矩、Hubbard 占据、最终结构等关键数据，" +
    "避免 Agent 直接读取万行输出。\n" +
    "支持: scf, relax, bands, dos, pdos, bader, workfunction, neb, optical, phonon\n" +
    "relax 模式会返回 structure_data，可直接用于 create_qe_input。\n\n" +
    "**智能数据源定位**：\n" +
    "- bands 模式：可传入 bands.out 或 .dat.gnu 文件。若传 .out 且解析为空，自动搜索同目录 .dat.gnu 文件，" +
    "并自动计算 VBM/CBM/带隙及类型（直接/间接）。返回 auto_source 标记数据来源。\n" +
    "- dos 模式：可传入 dos_post.out 或 .dos 数据文件。若传 .out 且解析为空，自动搜索同目录 .dos 文件。" +
    "返回 auto_source 标记数据来源。\n" +
    "- pdos 模式：自动扫描 work_dir 下 .pdos_atm* 文件，按元素+轨道聚合。";

  readonly inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "QE 输出文件路径" },
      result_type: {
        type: "string",
        enum: ["scf","relax","bands","dos","pdos","bader","workfunction","neb","optical","phonon"],
        description: "结果类型。不确定时可不传，工具会自动检测。",
      },
      work_dir: { type: "string", description: "工作目录（pdos/bader 需要读取多个文件时使用）" },
    },
    required: ["file_path"],
  };

  get isReadOnly() { return true; }

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.file_path || typeof args.file_path !== "string") return "file_path 不能为空";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let fp = args.file_path as string;
    let resultType = args.result_type as string | undefined;
    let workDir = args.work_dir as string | undefined;

    // NOTE: 相对路径自动解析到 workspaceDir（与其他工具统一）
    if (!isAbsolute(fp) && this.workspaceDir) {
      fp = resolve(this.workspaceDir, fp);
    }
    if (workDir && !isAbsolute(workDir) && this.workspaceDir) {
      workDir = resolve(this.workspaceDir, workDir);
    }

    // NOTE: Issue #2 修复 — 文件读取 retry 逻辑
    // SCNet 下载大文件后可能尚未完全写入磁盘，首次读取会失败
    const content = await this.readFileWithRetry(fp);
    if (content === null) {
      return { success: false, error: `文件读取失败（重试 3 次）: ${fp}` };
    }
    if (!resultType) resultType = this.detectType(fp, content);

    try {
      let data: Record<string, unknown>;
      switch (resultType) {
        case "scf": data = this.parseSCF(content); break;
        case "relax": data = this.parseRelax(content, fp); break;
        case "bands": data = this.parseBands(content, fp); break;
        case "dos": data = this.parseDOS(content, fp); break;
        case "pdos": data = this.parsePDOS(workDir ?? dirname(fp)); break;
        case "bader": data = this.parseBader(workDir ?? dirname(fp)); break;
        case "workfunction": data = this.parseWorkfunction(content, fp); break;
        case "neb": data = this.parseNEB(content); break;
        case "optical": data = this.parseOptical(content, fp); break;
        case "phonon": data = this.parsePhonon(content); break;
        default: return { success: false, error: `未知类型: ${resultType}` };
      }
      data.result_type = resultType;
      data.source_file = fp;
      return { success: true, data, display: `📊 提取 ${resultType} 结果: ${basename(fp)}` };
    } catch (e) {
      return { success: false, error: `解析失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  // ---- 类型检测 ----
  private detectType(fp: string, content: string): string {
    const name = basename(fp).toLowerCase();
    if (name.includes("relax") || name.includes("vc-relax")) return "relax";
    if (name.includes("band")) return "bands";
    if (name.includes("pdos") || name.includes("projwfc")) return "pdos";
    if (name.includes("dos")) return "dos";
    if (name.includes("bader") || name.includes("ACF")) return "bader";
    if (name.includes("avg") || name.includes("workfunc")) return "workfunction";
    if (name.includes("neb") || name.includes("path")) return "neb";
    if (name.includes("epsi") || name.includes("epsilon") || name.includes("eels")) return "optical";
    if (name.includes("freq") || name.includes("phonon") || name.includes("matdyn")) return "phonon";
    if (/BFGS/i.test(content) || /bfgs converged/i.test(content)) return "relax";
    if (/activation energy/i.test(content)) return "neb";
    return "scf";
  }

  // ---- SCF / NSCF 解析 ----
  private parseSCF(content: string): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    // NOTE: 检测是否为 NSCF 计算（没有 SCF 收敛迭代，而是有固定 K 点遍历）
    const isNscf = /calculation\s*=\s*'nscf'/i.test(content) ||
      (/number of k points/i.test(content) && !/convergence has been achieved/i.test(content) && /End of self-consistent calculation/i.test(content));
    data.is_nscf = isNscf;

    // NOTE: 系统参数回读 — Agent 不需要再 read_file 看输入参数
    const calcTypeMatch = content.match(/calculation\s*=\s*'(\w[\w-]*)'/i);
    if (calcTypeMatch) data.calculation_type = calcTypeMatch[1];

    const natomMatch = content.match(/number of atoms\/cell\s*=\s*(\d+)/);
    if (natomMatch) data.n_atoms = parseInt(natomMatch[1]);

    const ntypeMatch = content.match(/number of atomic types\s*=\s*(\d+)/);
    if (ntypeMatch) data.n_types = parseInt(ntypeMatch[1]);

    const nelMatch = content.match(/number of electrons\s*=\s*([\d.]+)/);
    if (nelMatch) data.n_electrons = parseFloat(nelMatch[1]);

    // 原子种类 — 从赝势声明中提取
    const speciesNames = [...content.matchAll(/PseudoPot\.\s+#\s*\d+\s+for\s+(\w+)\s+read/g)].map(m => m[1]);
    if (speciesNames.length > 0) data.atom_species = speciesNames;

    const ecutwfcMatch = content.match(/kinetic-energy cutoff\s*=\s*([\d.]+)\s*Ry/);
    if (ecutwfcMatch) data.ecutwfc_ry = parseFloat(ecutwfcMatch[1]);

    const ecutrhoMatch = content.match(/charge density cutoff\s*=\s*([\d.]+)\s*Ry/);
    if (ecutrhoMatch) data.ecutrho_ry = parseFloat(ecutrhoMatch[1]);

    // 交换关联泛函
    const xcMatch = content.match(/Exchange-correlation\s*=\s*(.+)/);
    if (xcMatch) data.xc_functional = xcMatch[1].trim().split(/\s+/)[0];

    // 自旋设置
    const nspinNumMatch = content.match(/nspin\s*=\s*(\d+)/);
    if (nspinNumMatch) data.nspin = parseInt(nspinNumMatch[1]);
    else if (/spin polarization\s*=\s*yes/i.test(content)) data.nspin = 2;

    // 自旋轨道耦合
    data.spin_orbit_coupling = /spin-orbit/i.test(content);

    // 并行信息
    const nprocsMatch = content.match(/running on\s+(\d+)\s+processor/);
    if (nprocsMatch) data.n_processors = parseInt(nprocsMatch[1]);

    // 对称性
    const nsymMatch = content.match(/(\d+)\s+Sym\.\s*Ops\./);
    if (nsymMatch) data.n_symmetries = parseInt(nsymMatch[1]);

    // 晶格参数
    const alatMatch = content.match(/lattice parameter \(alat\)\s*=\s*([\d.]+)\s*a\.u\./);
    if (alatMatch) {
      const alatBohr = parseFloat(alatMatch[1]);
      data.lattice_parameter_angstrom = parseFloat((alatBohr * 0.529177).toFixed(6));
    }

    // 晶胞体积
    const volMatch = content.match(/unit-cell volume\s*=\s*([\d.]+)\s*\(a\.u\.\)/);
    if (volMatch) {
      const volBohr3 = parseFloat(volMatch[1]);
      data.cell_volume_angstrom3 = parseFloat((volBohr3 * 0.148185).toFixed(4));
    }

    // 晶格矢量（crystal axes → angstrom）
    const cellVectors: number[][] = [];
    const alatAng = alatMatch ? parseFloat(alatMatch[1]) * 0.529177 : null;
    for (const cm of content.matchAll(/a\((\d)\)\s*=\s*\(\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\)/g)) {
      cellVectors.push([parseFloat(cm[2]), parseFloat(cm[3]), parseFloat(cm[4])]);
    }
    if (cellVectors.length === 3 && alatAng) {
      data.cell_parameters_angstrom = cellVectors.map(row => row.map(v => parseFloat((v * alatAng).toFixed(6))));
    }

    // 收敛判断
    data.converged = /convergence has been achieved/i.test(content) ||
      // NSCF 完成标记不同：没有 SCF 收敛，但有 End of band structure / self-consistent
      (isNscf && /End of (band structure|self-consistent) calculation/i.test(content));

    // 总迭代数
    const iterMatch = [...content.matchAll(/iteration #\s*(\d+)/g)];
    data.total_iterations = iterMatch.length > 0 ? parseInt(iterMatch[iterMatch.length - 1][1]) : 0;

    // 最终能量（SCF 有 ! 标记，NSCF 可能没有）
    const energyMatch = [...content.matchAll(/!\s+total energy\s+=\s+([-\d.]+)\s+Ry/g)];
    data.final_energy_ry = energyMatch.length > 0 ? parseFloat(energyMatch[energyMatch.length - 1][1]) : null;

    // NOTE: NSCF 能量可能出现在不同格式中
    if (data.final_energy_ry === null) {
      const totalEMatch = content.match(/total energy\s+=\s+([-\d.]+)\s+Ry/);
      if (totalEMatch) data.final_energy_ry = parseFloat(totalEMatch[1]);
    }
    // Ry → eV 换算
    if (data.final_energy_ry !== null) {
      data.final_energy_ev = parseFloat(((data.final_energy_ry as number) * 13.6057).toFixed(6));
    }

    // 费米能级
    const fermiMatch = content.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
    data.fermi_energy_ev = fermiMatch ? parseFloat(fermiMatch[1]) : null;

    // HOMO / LUMO（绝缘体/半导体场景）
    const homoLumo = content.match(/highest occupied, lowest unoccupied level \(ev\):\s*([\d.]+)\s+([\d.]+)/);
    if (homoLumo) {
      data.highest_occupied_ev = parseFloat(homoLumo[1]);
      data.lowest_unoccupied_ev = parseFloat(homoLumo[2]);
    } else {
      const homoOnly = content.match(/highest occupied level \(ev\):\s*([\d.]+)/);
      if (homoOnly) data.highest_occupied_ev = parseFloat(homoOnly[1]);
    }

    // NOTE: NSCF 补充信息 — K 点数、能带数
    const nkMatch = content.match(/number of k points\s*=\s*(\d+)/);
    if (nkMatch) data.n_kpoints = parseInt(nkMatch[1]);

    // K 点网格描述（如 "4 4 4 1 1 1"）
    const kgridMatch = content.match(/nk1\s*=\s*(\d+)\s*nk2\s*=\s*(\d+)\s*nk3\s*=\s*(\d+)/);
    if (kgridMatch) data.k_grid = [parseInt(kgridMatch[1]), parseInt(kgridMatch[2]), parseInt(kgridMatch[3])];

    const nbandMatch = content.match(/number of Kohn-Sham states\s*=\s*(\d+)/);
    if (nbandMatch) data.n_bands = parseInt(nbandMatch[1]);

    // 总磁化
    const magMatch = content.match(/total magnetization\s+=\s+([-\d.]+)/);
    if (magMatch) data.total_magnetization = parseFloat(magMatch[1]);
    const absMag = content.match(/absolute magnetization\s+=\s+([-\d.]+)/);
    if (absMag) data.absolute_magnetization = parseFloat(absMag[1]);
    // 能量分项
    data.energy_components = this.parseEnergyComponents(content);
    // Hubbard 占据
    const hub = this.parseHubbardOccupations(content);
    if (hub) data.hubbard_occupations = hub;
    // 原子磁矩
    const atomMag = this.parseAtomicMagnetization(content);
    if (atomMag) data.atomic_magnetization = atomMag;
    // JOB DONE
    data.job_done = content.includes("JOB DONE");

    // SCF 收敛轨迹 — 每步的 estimated scf accuracy
    const accuracies = [...content.matchAll(/estimated scf accuracy\s*<\s*([\d.Ee+-]+)\s*Ry/g)]
      .map(m => parseFloat(m[1]));
    if (accuracies.length > 0) {
      data.scf_convergence_trajectory = accuracies.map((acc, i) => ({
        iteration: i + 1,
        accuracy: acc,
      }));
    }

    // 总力
    const totalForceMatch = content.match(/Total force\s*=\s*([+\-0-9.eEdD]+)/i);
    if (totalForceMatch) data.total_force_ry_bohr = parseFloat(totalForceMatch[1].replace(/D/ig, "e"));

    // 压力和应力张量
    const pressureMatch = content.match(/total\s+stress.*?P=\s*([-\d.]+)/);
    if (pressureMatch) data.pressure_kbar = parseFloat(pressureMatch[1]);

    // 应力张量 (kbar) — 紧跟在 "total   stress" 行之后的 3 行数据
    const stressBlock = content.match(/total\s+stress\s+\(Ry\/bohr\*\*3\)\s+\(kbar\)\s+P=\s*[-\d.]+\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[A-Z])/);
    if (stressBlock) {
      const stressTensor: number[][] = [];
      for (const line of stressBlock[1].trim().split("\n").slice(0, 3)) {
        const parts = line.trim().split(/\s+/);
        // 后 3 列是 kbar 单位
        if (parts.length >= 6) {
          stressTensor.push([parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5])]);
        }
      }
      if (stressTensor.length === 3) data.stress_tensor_kbar = stressTensor;
    }

    // Löwdin 电荷
    const lowdin = this.parseLowdinCharges(content);
    if (lowdin) data.lowdin_charges = lowdin;

    // 墙钟时间 / CPU 时间
    const wallMatch = content.match(/PWSCF\s+:\s+(.+?)\s+CPU\s+(.+?)\s+WALL/);
    if (wallMatch) {
      data.wall_time_seconds = this.parseTimeStr(wallMatch[2]);
      data.cpu_time_seconds = this.parseTimeStr(wallMatch[1]);
    }

    // NOTE: Issue #6 修复 — 错误诊断字段
    // 当计算未成功完成时，提供结构化错误分类，帮助 Agent 快速定位问题
    if (!data.converged || !data.job_done) {
      const diag = this.diagnoseError(content, data.converged as boolean, data.job_done as boolean);
      if (diag.error_type !== "none") {
        data.error_type = diag.error_type;
        data.error_detail = diag.error_detail;
      }
    }

    return data;
  }

  // ---- Relax 解析 ----
  private parseRelax(content: string, fp: string): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    data.converged = /bfgs converged/i.test(content) || /Final enthalpy/i.test(content);

    // NOTE: 系统参数回读（与 SCF 共享逻辑）
    const calcTypeMatch = content.match(/calculation\s*=\s*'(\w[\w-]*)'/i);
    if (calcTypeMatch) data.calculation_type = calcTypeMatch[1];

    const natomMatch = content.match(/number of atoms\/cell\s*=\s*(\d+)/);
    if (natomMatch) data.n_atoms = parseInt(natomMatch[1]);

    const speciesNames = [...content.matchAll(/PseudoPot\.\s+#\s*\d+\s+for\s+(\w+)\s+read/g)].map(m => m[1]);
    if (speciesNames.length > 0) data.atom_species = speciesNames;

    const ecutwfcMatch = content.match(/kinetic-energy cutoff\s*=\s*([\d.]+)\s*Ry/);
    if (ecutwfcMatch) data.ecutwfc_ry = parseFloat(ecutwfcMatch[1]);

    const xcMatch = content.match(/Exchange-correlation\s*=\s*(.+)/);
    if (xcMatch) data.xc_functional = xcMatch[1].trim().split(/\s+/)[0];

    const nspinNumMatch = content.match(/nspin\s*=\s*(\d+)/);
    if (nspinNumMatch) data.nspin = parseInt(nspinNumMatch[1]);

    // 力收敛阈值
    const forcThrMatch = content.match(/forc_conv_thr\s*=\s*([\d.Ee+-]+)/);
    if (forcThrMatch) data.force_threshold_ry_bohr = parseFloat(forcThrMatch[1]);
    // BFGS 步数
    const stepMatches = [...content.matchAll(/number of bfgs steps\s*=\s*(\d+)/g)];
    const nBfgsSteps = stepMatches.length > 0 ? parseInt(stepMatches[stepMatches.length - 1][1]) : 0;
    // NOTE: 拆分为明确的语义字段，避免歧义（Bug #12 修复）
    data.n_steps = nBfgsSteps; // 向后兼容
    data.n_bfgs_steps = nBfgsSteps;
    // 能量轨迹
    const energies = [...content.matchAll(/!\s+total energy\s+=\s+([-\d.]+)\s+Ry/g)].map(m => parseFloat(m[1]));
    data.energies_ry = energies;
    data.energies_ev = energies.map(e => parseFloat((e * 13.6057).toFixed(6)));
    data.n_scf_evaluations = energies.length;
    if (energies.length > 0) {
      data.final_energy_ry = energies[energies.length - 1];
      data.final_energy_ev = parseFloat((energies[energies.length - 1] * 13.6057).toFixed(6));
    }
    // 最后两步能量差（收敛判据参考）
    if (energies.length >= 2) {
      data.energy_change_ry = parseFloat((energies[energies.length - 1] - energies[energies.length - 2]).toExponential(4));
    }

    // 总 SCF 迭代数（所有离子步合计）
    const allScfIters = [...content.matchAll(/iteration #\s*(\d+)/g)];
    data.total_scf_iterations = allScfIters.length;
    // 最大力（增强正则以支持科学计数法和负号等特殊格式）
    const forces = [...content.matchAll(/Total force\s*=\s*([+\-0-9.eEdD]+)/gi)].map(m => {
      const valStr = m[1].replace(/D/ig, "e");
      return parseFloat(valStr);
    });
    data.forces_max = forces;
    if (forces.length > 0) data.final_force_ry_bohr = forces[forces.length - 1];
    // 费米能级
    const fermiMatch = content.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
    data.fermi_energy_ev = fermiMatch ? parseFloat(fermiMatch[1]) : null;
    data.job_done = content.includes("JOB DONE");
    // NOTE: 当计算完成但未收敛时，生成明确警示（Bug #16 + #14 修复）
    const warnings: string[] = [];
    if (data.job_done && !data.converged) {
      const lastForce = forces.length > 0 ? forces[forces.length - 1] : null;
      warnings.push(
        `BFGS 达到 nstep 上限未收敛。最终 forces_max=${lastForce?.toFixed(6) ?? "N/A"} Ry/Bohr。` +
        `请增大 nstep 或检查初始结构是否合理。`,
      );
    }
    if (warnings.length > 0) data.warnings = warnings;
    // 最终结构
    const finalCoords = this.extractFinalCoords(content);
    if (finalCoords) {
      const sd: Record<string, unknown> = {
        atoms: finalCoords, position_units: "angstrom", n_atoms: finalCoords.length,
      };
      const finalCell = this.extractFinalCell(content);
      if (finalCell) { sd.cell_parameters = finalCell; sd.cell_units = "angstrom"; }
      else {
        const inFile = fp.replace(/\.out$/, ".in");
        const cell = this.extractCellFromFiles(content, inFile);
        if (cell) { sd.cell_parameters = cell; sd.cell_units = "angstrom"; }
      }
      data.structure_data = sd;
    }
    // 磁化
    const magMatch = content.match(/total magnetization\s+=\s+([-\d.]+)/);
    if (magMatch) data.total_magnetization = parseFloat(magMatch[1]);

    // NOTE: vc-relax 压力轨迹（专家必看指标）
    // QE 输出格式: P= xxx (kbar)，每个 ionic step 都有
    const pressures = [...content.matchAll(/P=\s*([-\d.]+)/g)].map(m => parseFloat(m[1]));
    if (pressures.length > 0) {
      data.is_vc_relax = true;
      data.pressures_kbar = pressures;
      data.final_pressure_kbar = pressures[pressures.length - 1];
    }

    data.energy_components = this.parseEnergyComponents(content);

    // 应力张量（最终的）
    const stressBlocks = [...content.matchAll(/total\s+stress\s+\(Ry\/bohr\*\*3\)\s+\(kbar\)\s+P=\s*[-\d.]+\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[A-Z])/g)];
    if (stressBlocks.length > 0) {
      const lastStress = stressBlocks[stressBlocks.length - 1][1];
      const stressTensor: number[][] = [];
      for (const line of lastStress.trim().split("\n").slice(0, 3)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          stressTensor.push([parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5])]);
        }
      }
      if (stressTensor.length === 3) data.stress_tensor_kbar = stressTensor;
    }

    // vc-relax 体积轨迹
    const volumes = [...content.matchAll(/unit-cell volume\s*=\s*([\d.]+)\s*\(a\.u\.\)/g)]
      .map(m => parseFloat((parseFloat(m[1]) * 0.148185).toFixed(4)));
    if (volumes.length > 1) {
      data.cell_volumes_angstrom3 = volumes;
      data.initial_cell_volume_angstrom3 = volumes[0];
      data.final_cell_volume_angstrom3 = volumes[volumes.length - 1];
      data.volume_change_percent = parseFloat(
        (((volumes[volumes.length - 1] - volumes[0]) / volumes[0]) * 100).toFixed(3),
      );
    } else if (volumes.length === 1) {
      data.cell_volume_angstrom3 = volumes[0];
    }

    // Löwdin 电荷
    const lowdin = this.parseLowdinCharges(content);
    if (lowdin) data.lowdin_charges = lowdin;

    // 墙钟时间 / CPU 时间
    const wallMatch = content.match(/PWSCF\s+:\s+(.+?)\s+CPU\s+(.+?)\s+WALL/);
    if (wallMatch) {
      data.wall_time_seconds = this.parseTimeStr(wallMatch[2]);
      data.cpu_time_seconds = this.parseTimeStr(wallMatch[1]);
    }

    // 并行信息
    const nprocsMatch = content.match(/running on\s+(\d+)\s+processor/);
    if (nprocsMatch) data.n_processors = parseInt(nprocsMatch[1]);

    // NOTE: Issue #6 修复 — relax 模式的错误诊断
    if (!data.converged || !data.job_done) {
      const diag = this.diagnoseError(content, data.converged as boolean, data.job_done as boolean);
      if (diag.error_type !== "none") {
        data.error_type = diag.error_type;
        data.error_detail = diag.error_detail;
      }
    }

    return data;
  }

  // ---- Bands ----
  private parseBands(content: string, fp?: string): Record<string, unknown> {
    const kMatches = [...content.matchAll(/k =\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/g)];
    const bandMatch = content.match(/number of Kohn-Sham states\s*=\s*(\d+)/);
    const fermiMatch = content.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
    const nBands = bandMatch ? parseInt(bandMatch[1]) : null;
    const fermiEnergy = fermiMatch ? parseFloat(fermiMatch[1]) : null;

    // NOTE: 从 bands.out 中提取每个 k 点的能量
    const bandsData: { kIndex: number; kx: number; ky: number; kz: number; energies: number[] }[] = [];

    const kSections = content.split(/k =\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+/).slice(1);
    kMatches.forEach((km, idx) => {
      if (idx >= kSections.length) return;
      const section = kSections[idx];
      const bandSection = section.match(/bands?\s*\(ev\)\s*:\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*k\s*=|$)/i);
      if (bandSection) {
        const energies = bandSection[1].trim().split(/\s+/).map(Number).filter((v) => !isNaN(v));
        bandsData.push({ kIndex: idx + 1, kx: parseFloat(km[1]), ky: parseFloat(km[2]), kz: parseFloat(km[3]), energies });
      }
    });

    // NOTE: 如果从 .out 解析为空，自动搜索 bands.x 生成的 .dat.gnu 文件（Bug #4 修复）
    // .dat.gnu 格式：空行分隔的 k-E 数据块，每块一条能带
    let autoSource: string | undefined;
    if (bandsData.length === 0 && fp) {
      const dir = dirname(fp);
      try {
        const gnuFiles = readdirSync(dir).filter((f: string) => f.endsWith(".dat.gnu"));
        if (gnuFiles.length > 0) {
          const gnuPath = join(dir, gnuFiles[0]);
          autoSource = gnuPath;
          const gnuContent = readFileSync(gnuPath, "utf-8");
          // 解析 .dat.gnu：每行 "k_distance energy"，空行分隔不同能带
          const rawBands: { k: number; e: number }[][] = [[]];
          for (const line of gnuContent.trim().split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) {
              if (rawBands[rawBands.length - 1].length > 0) rawBands.push([]);
              continue;
            }
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
              const k = parseFloat(parts[0]);
              const e = parseFloat(parts[1]);
              if (!isNaN(k) && !isNaN(e)) rawBands[rawBands.length - 1].push({ k, e });
            }
          }
          const validBands = rawBands.filter(b => b.length > 0);
          // 重组为按 k 点索引的结构（与现有 bandsData 格式一致）
          if (validBands.length > 0) {
            const nk = validBands[0].length;
            for (let ki = 0; ki < nk; ki++) {
              bandsData.push({
                kIndex: ki + 1,
                kx: validBands[0][ki].k, ky: 0, kz: 0,
                energies: validBands.map(b => b[ki]?.e ?? 0),
              });
            }
          }
        }
      } catch { /* 搜索失败不影响主流程 */ }
    }

    // NOTE: Bug #NiO-1 修复 — 如果 bands.out 中没有费米能级，
    // 自动搜索同目录的 scf.out / nscf.out 获取。
    // bands 后处理文件通常不含 fermi_energy，但同目录的 SCF 输出有。
    let effectiveFermi = fermiEnergy;
    if (effectiveFermi === null && fp) {
      const dir = dirname(fp);
      for (const scfName of ["scf.out", "nscf.out"]) {
        try {
          const scfPath = join(dir, scfName);
          if (existsSync(scfPath)) {
            const scfContent = readFileSync(scfPath, "utf-8");
            const fm = scfContent.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
            if (fm) {
              effectiveFermi = parseFloat(fm[1]);
              break;
            }
          }
        } catch { /* 搜索失败不影响主流程 */ }
      }
    }

    // NOTE: 自动带隙分析（VBM/CBM/gap）— Agent 不需要自己写脚本计算
    let gapAnalysis: Record<string, unknown> | null = null;
    if (bandsData.length > 0 && effectiveFermi !== null) {
      let vbm = -Infinity, cbm = Infinity;
      let vbmK = 0, cbmK = 0;
      for (const kp of bandsData) {
        for (const e of kp.energies) {
          if (e <= effectiveFermi && e > vbm) { vbm = e; vbmK = kp.kIndex; }
          if (e > effectiveFermi && e < cbm) { cbm = e; cbmK = kp.kIndex; }
        }
      }
      if (vbm > -Infinity && cbm < Infinity) {
        gapAnalysis = {
          vbm_ev: parseFloat(vbm.toFixed(4)),
          cbm_ev: parseFloat(cbm.toFixed(4)),
          band_gap_ev: parseFloat((cbm - vbm).toFixed(4)),
          gap_type: vbmK === cbmK ? "direct" : "indirect",
          vbm_kindex: vbmK, cbm_kindex: cbmK,
          ...(fermiEnergy === null ? { fermi_auto_source: "同目录 scf.out/nscf.out" } : {}),
        };
      }
    }

    // NOTE: C1 修复 — 检测高对称 K 点位置
    // 在 .dat.gnu 的 k 路径中，k 值不单调递增的位置即为高对称点
    // 同时路径起点和终点也是高对称点
    let highSymKpoints: number[] | null = null;
    if (bandsData.length > 0) {
      const kPositions = new Set<number>();
      // 起点
      kPositions.add(bandsData[0].kx);
      // 终点
      kPositions.add(bandsData[bandsData.length - 1].kx);
      // 间断点：k(i+1) <= k(i) 或 k 值跳跃处
      for (let i = 1; i < bandsData.length; i++) {
        const curr = bandsData[i].kx;
        const prev = bandsData[i - 1].kx;
        if (curr <= prev + 1e-8) {
          // k 值回跳或重复 → 高对称点
          kPositions.add(prev);
          kPositions.add(curr);
        }
      }
      highSymKpoints = [...kPositions].sort((a, b) => a - b);
    }

    return {
      n_kpoints: bandsData.length > 0 ? bandsData.length : kMatches.length,
      n_bands: nBands ?? (bandsData.length > 0 ? bandsData[0]?.energies.length : null),
      reference_energy: effectiveFermi,
      ...(fermiEnergy === null && effectiveFermi !== null ? { fermi_auto_source: "同目录 scf.out/nscf.out" } : {}),
      bands_data: bandsData.length > 0 ? bandsData : null,
      ...(gapAnalysis ? { gap_analysis: gapAnalysis } : {}),
      ...(highSymKpoints ? { high_symmetry_kpoints: highSymKpoints } : {}),
      ...(autoSource ? { auto_source: autoSource, note: `数据自动从 ${basename(autoSource)} 提取` } : { note: `完整数据含 ${kMatches.length} 个 k 点` }),
    };
  }

  // ---- DOS ----
  private parseDOS(content: string, fp?: string): Record<string, unknown> {
    let autoSource: string | undefined;

    // NOTE: 尝试解析当前文件的多列数值数据
    const parseColumnarDos = (text: string) => {
      const result: { energy: number[]; dosUp: number[]; dosDown: number[] | null } = {
        energy: [], dosUp: [], dosDown: null,
      };
      let fermi: number | null = null;
      const fm = text.match(/EFermi\s*=\s*([-\d.]+)/);
      if (fm) fermi = parseFloat(fm[1]);
      let hasSpinDown = false;

      // NOTE: Issue #1 修复 — 通过头部注释精确判断列格式
      // QE nspin=2 .dos 头部: "# E (eV)  dosup(E)  dosdw(E)  Int dos(E)" → 4 列
      const headerLines = text.split("\n").slice(0, 5).filter(l => l.trim().startsWith("#"));
      const headerText = headerLines.join(" ").toLowerCase();
      const isSpinPolarizedHeader = headerText.includes("dosup") || headerText.includes("dos_up") ||
        headerText.includes("dosdw") || headerText.includes("dos_down");

      for (const line of text.trim().split("\n")) {
        const s = line.trim();
        if (!s || s.startsWith("#")) continue;
        const parts = s.split(/\s+/);
        if (parts.length < 2) continue;
        const e = parseFloat(parts[0]);
        const d = parseFloat(parts[1]);
        if (isNaN(e) || isNaN(d)) continue;
        result.energy.push(e);
        result.dosUp.push(d);
        if (parts.length >= 5) {
          // 5 列格式: E, dosup, intdos_up, dosdown, intdos_down
          const dd = parseFloat(parts[3]);
          if (!isNaN(dd)) {
            if (!result.dosDown) result.dosDown = [];
            result.dosDown.push(dd);
            hasSpinDown = true;
          }
        } else if (parts.length === 4 && isSpinPolarizedHeader) {
          // NOTE: QE nspin=2 标准 .dos 4 列: E, dosup(E), dosdw(E), IntDos
          // spin-down 在 index 2
          const dd = parseFloat(parts[2]);
          if (!isNaN(dd)) {
            if (!result.dosDown) result.dosDown = [];
            result.dosDown.push(dd);
            hasSpinDown = true;
          }
        } else if (parts.length >= 4 && !isSpinPolarizedHeader) {
          // 非标准 4 列格式
          const dd = parseFloat(parts[3]);
          if (!isNaN(dd)) {
            if (!result.dosDown) result.dosDown = [];
            result.dosDown.push(dd);
            hasSpinDown = true;
          }
        } else if (parts.length === 3 && !isSpinPolarizedHeader) {
          // pdos_tot 格式: E, dos_up, dos_down
          const dd = parseFloat(parts[2]);
          if (!isNaN(dd)) {
            if (!result.dosDown) result.dosDown = [];
            result.dosDown.push(dd);
            hasSpinDown = true;
          }
        }
      }
      return { dosData: result, fermi, hasSpinDown };
    };

    let { dosData, fermi, hasSpinDown } = parseColumnarDos(content);

    // NOTE: 如果解析为空（传入的是 dos_post.out 日志），自动搜索实际数据文件（Bug #5 修复）
    if (dosData.energy.length === 0 && fp) {
      const dir = dirname(fp);
      try {
        // 策略 1：从 .out 日志中提取 fildos 参数精确定位
        const fildosMatch = content.match(/fildos\s*=\s*['"]?([^'"\s]+)/i);
        if (fildosMatch) {
          const fildosPath = join(dir, fildosMatch[1]);
          if (existsSync(fildosPath)) {
            autoSource = fildosPath;
            const dosContent = readFileSync(fildosPath, "utf-8");
            ({ dosData, fermi, hasSpinDown } = parseColumnarDos(dosContent));
          }
        }
        // 策略 2：搜索同目录 .dos 文件
        if (dosData.energy.length === 0) {
          const dosFiles = readdirSync(dir).filter((f: string) =>
            (f.endsWith(".dos") || f.includes(".pdos_tot")) && !f.endsWith(".out"),
          );
          if (dosFiles.length > 0) {
            const dosPath = join(dir, dosFiles[0]);
            autoSource = dosPath;
            const dosContent = readFileSync(dosPath, "utf-8");
            ({ dosData, fermi, hasSpinDown } = parseColumnarDos(dosContent));
          }
        }
      } catch { /* 搜索失败不影响主流程 */ }
    }

    // NOTE: Issue #5 修复 — 自动带隙估算
    // 从 DOS 数据中扫描费米能级附近 DOS < 阈值的连续区间
    let estimatedBandGap: Record<string, unknown> | null = null;
    if (dosData.energy.length > 0 && fermi !== null) {
      const gapThreshold = 0.01; // states/eV
      // 找到费米能级位置
      let fermiIdx = 0;
      for (let i = 0; i < dosData.energy.length; i++) {
        if (dosData.energy[i] >= fermi) { fermiIdx = i; break; }
      }
      // 计算合并 DOS（spin-polarized 时取两个通道之和）
      const totalDos = dosData.dosUp.map((d, i) =>
        d + (dosData.dosDown ? dosData.dosDown[i] ?? 0 : 0),
      );
      // 从费米能级向下扫描找 VBM 边缘
      let vbmEdge: number | null = null;
      for (let i = fermiIdx; i >= 0; i--) {
        if (totalDos[i] > gapThreshold) { vbmEdge = dosData.energy[i]; break; }
      }
      // 从费米能级向上扫描找 CBM 边缘
      let cbmEdge: number | null = null;
      for (let i = fermiIdx; i < dosData.energy.length; i++) {
        if (totalDos[i] > gapThreshold) { cbmEdge = dosData.energy[i]; break; }
      }
      if (vbmEdge !== null && cbmEdge !== null && cbmEdge > vbmEdge + 0.05) {
        estimatedBandGap = {
          value: parseFloat((cbmEdge - vbmEdge).toFixed(3)),
          unit: "eV",
          method: `DOS threshold (${gapThreshold} states/eV)`,
          note: "Gaussian broadening may underestimate by 0.3-0.5 eV",
        };
      }
    }

    // NOTE: 费米面态密度 — 判断金属/绝缘体的核心指标
    let dosAtFermi: number | null = null;
    if (dosData.energy.length > 0 && fermi !== null) {
      // 找到最接近 Ef 的能量点
      let closestIdx = 0;
      let minDiff = Math.abs(dosData.energy[0] - fermi);
      for (let i = 1; i < dosData.energy.length; i++) {
        const diff = Math.abs(dosData.energy[i] - fermi);
        if (diff < minDiff) { minDiff = diff; closestIdx = i; }
      }
      dosAtFermi = dosData.dosUp[closestIdx] + (dosData.dosDown ? dosData.dosDown[closestIdx] ?? 0 : 0);
    }

    return {
      n_points: dosData.energy.length,
      energy_range: dosData.energy.length > 0
        ? [Math.min(...dosData.energy), Math.max(...dosData.energy)]
        : null,
      fermi_energy: fermi,
      dos_at_fermi: dosAtFermi !== null ? parseFloat(dosAtFermi.toFixed(4)) : null,
      has_spin: hasSpinDown,
      dos_data: dosData.energy.length > 0 ? dosData : null,
      ...(estimatedBandGap ? { estimated_band_gap: estimatedBandGap } : {}),
      ...(autoSource ? { auto_source: autoSource, note: `数据自动从 ${basename(autoSource)} 提取` } : {}),
    };
  }

  // ---- pDOS ----
  private parsePDOS(workDir: string, summaryOnly = true): Record<string, unknown> {
    // NOTE: readdirSync 已在文件顶部通过 ESM import 导入（Bug #3 修复）
    let files: string[] = [];
    try { files = readdirSync(workDir).filter((f: string) => f.includes("pdos_atm")); } catch {}
    const elements = new Set<string>();
    const orbitals: Record<string, Set<string>> = {};

    // NOTE: Bug #5/A5 修复 — 增加 spin-down 通道解析 + summary_only 模式
    interface PdosChannel {
      element: string;
      orbital: string;
      energy: number[];
      dos: number[];
      dos_down?: number[];
    }
    const channels: PdosChannel[] = [];
    let hasSpin = false;

    for (const f of files) {
      const m = f.match(/pdos_atm#\d+\((\w+)\)_wfc#\d+\((\w+)\)/);
      if (m) {
        elements.add(m[1]);
        if (!orbitals[m[1]]) orbitals[m[1]] = new Set();
        orbitals[m[1]].add(m[2]);

        try {
          const fContent = readFileSync(join(workDir, f), "utf-8");
          const energy: number[] = [];
          const dos: number[] = [];
          const dosDown: number[] = [];
          for (const line of fContent.trim().split("\n")) {
            if (!line.trim() || line.trim().startsWith("#")) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
              const e = parseFloat(parts[0]);
              const d = parseFloat(parts[1]);
              if (!isNaN(e) && !isNaN(d)) {
                energy.push(e);
                dos.push(d);
                // NOTE: nspin=2 的 pdos 文件：E ldos(up) ldos(down) ...
                if (parts.length >= 3) {
                  const dd = parseFloat(parts[2]);
                  if (!isNaN(dd)) dosDown.push(dd);
                }
              }
            }
          }
          if (energy.length > 0) {
            const ch: PdosChannel = { element: m[1], orbital: m[2], energy, dos };
            if (dosDown.length === energy.length) {
              ch.dos_down = dosDown;
              hasSpin = true;
            }
            channels.push(ch);
          }
        } catch {
          // 跳过读取失败的文件
        }
      }
    }

    // 按元素+轨道聚合（同一元素的同一轨道累加）
    const aggregated: Record<string, PdosChannel> = {};
    for (const ch of channels) {
      const key = `${ch.element}_${ch.orbital}`;
      if (!aggregated[key]) {
        aggregated[key] = { ...ch };
      } else {
        for (let i = 0; i < ch.dos.length && i < aggregated[key].dos.length; i++) {
          aggregated[key].dos[i] += ch.dos[i];
        }
        if (ch.dos_down && aggregated[key].dos_down) {
          for (let i = 0; i < ch.dos_down.length && i < aggregated[key].dos_down!.length; i++) {
            aggregated[key].dos_down![i] += ch.dos_down[i];
          }
        } else if (ch.dos_down) {
          aggregated[key].dos_down = [...ch.dos_down];
        }
      }
    }

    const aggValues = Object.values(aggregated);

    // NOTE: Bug #5 修复 — summary_only 模式：只返回统计摘要，不返回完整数组
    // 避免 pdos 数据产生数十万浮点数导致 token 爆炸
    if (summaryOnly && aggValues.length > 0) {
      // 尝试从 projwfc 输出中获取费米能级
      let pdosFermi: number | null = null;
      try {
        const projOutFiles = readdirSync(workDir).filter((f: string) =>
          f.includes("projwfc") && f.endsWith(".out"),
        );
        for (const pf of projOutFiles) {
          const projContent = readFileSync(join(workDir, pf), "utf-8");
          const fermiMatch = projContent.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
          if (fermiMatch) { pdosFermi = parseFloat(fermiMatch[1]); break; }
        }
      } catch { /* 忽略 */ }

      const summary = aggValues.map(ch => {
        const maxDos = Math.max(...ch.dos);
        const peakIdx = ch.dos.indexOf(maxDos);
        const peakEnergy = ch.energy[peakIdx];
        // 简易梯形积分（全范围）
        let integral = 0;
        for (let i = 1; i < ch.energy.length; i++) {
          integral += (ch.dos[i] + ch.dos[i - 1]) * (ch.energy[i] - ch.energy[i - 1]) / 2;
        }
        const result: Record<string, unknown> = {
          element: ch.element,
          orbital: ch.orbital,
          n_points: ch.energy.length,
          energy_range: [ch.energy[0], ch.energy[ch.energy.length - 1]],
          peak_dos: +maxDos.toFixed(4),
          peak_energy_ev: +peakEnergy.toFixed(4),
          integrated_dos: +integral.toFixed(4),
        };

        // NOTE: d-band center — 催化科学最核心的电子结构指标
        // 定义: ε_d = Σ(E × DOS_d(E) × dE) / Σ(DOS_d(E) × dE)，积到费米面
        // 仅对 d 轨道计算（s/p 轨道的 band center 意义不大）
        if (ch.orbital.startsWith("d") && pdosFermi !== null) {
          let numerator = 0, denominator = 0;
          let occupiedIntegral = 0;
          for (let i = 1; i < ch.energy.length; i++) {
            if (ch.energy[i] > pdosFermi) break;
            const dE = ch.energy[i] - ch.energy[i - 1];
            const avgDos = (ch.dos[i] + ch.dos[i - 1]) / 2;
            const avgE = (ch.energy[i] + ch.energy[i - 1]) / 2;
            numerator += avgE * avgDos * dE;
            denominator += avgDos * dE;
            occupiedIntegral += avgDos * dE;
          }
          if (denominator > 1e-10) {
            result.d_band_center_ev = parseFloat((numerator / denominator).toFixed(4));
          }
          result.occupied_dos_integral = parseFloat(occupiedIntegral.toFixed(4));
        }

        // 费米面 DOS 值（所有轨道都计算）
        if (pdosFermi !== null && ch.energy.length > 0) {
          let closestIdx = 0;
          let minDiff = Math.abs(ch.energy[0] - pdosFermi);
          for (let i = 1; i < ch.energy.length; i++) {
            const diff = Math.abs(ch.energy[i] - pdosFermi);
            if (diff < minDiff) { minDiff = diff; closestIdx = i; }
          }
          result.dos_at_fermi = parseFloat(ch.dos[closestIdx].toFixed(4));
        }

        if (ch.dos_down) {
          const maxDown = Math.max(...ch.dos_down);
          const peakDownIdx = ch.dos_down.indexOf(maxDown);
          result.peak_dos_down = +maxDown.toFixed(4);
          result.peak_energy_down_ev = +ch.energy[peakDownIdx].toFixed(4);
        }
        return result;
      });
      return {
        n_channels: files.length,
        n_aggregated: aggValues.length,
        elements: [...elements],
        orbitals_per_element: Object.fromEntries(Object.entries(orbitals).map(([k, v]) => [k, [...v]])),
        has_spin: hasSpin,
        summary_only: true,
        pdos_summary: summary,
        hint: "完整 pdos 数据未返回以节省 token。请使用 plot_chart(chart_type='pdos', work_dir='...') 直接从文件绘图。",
      };
    }

    return {
      n_channels: files.length,
      elements: [...elements],
      orbitals_per_element: Object.fromEntries(Object.entries(orbitals).map(([k, v]) => [k, [...v]])),
      has_spin: hasSpin,
      pdos_data: aggValues.length > 0 ? aggValues : null,
    };
  }

  // ---- Bader ----
  private parseBader(workDir: string): Record<string, unknown> {
    const acfPath = join(workDir, "ACF.dat");
    if (!existsSync(acfPath)) return { error: "ACF.dat 不存在" };
    const lines = readFileSync(acfPath, "utf-8").trim().split("\n");
    const charges: Array<Record<string, unknown>> = [];
    let totalCharge = 0;
    let vacuumCharge: number | null = null;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const idx = parseInt(parts[0]); if (isNaN(idx)) continue;
        const charge = parseFloat(parts[4]);
        const entry: Record<string, unknown> = {
          atom_index: idx, x: parseFloat(parts[1]), y: parseFloat(parts[2]),
          z: parseFloat(parts[3]), charge,
        };
        // ACF.dat 可能有 VOLUME 列（第 6 列）和 MIN DIST 列（第 7 列）
        if (parts.length >= 6 && !isNaN(parseFloat(parts[5]))) {
          entry.volume = parseFloat(parts[5]);
        }
        if (parts.length >= 7 && !isNaN(parseFloat(parts[6]))) {
          entry.min_distance = parseFloat(parts[6]);
        }
        charges.push(entry);
        totalCharge += charge;
      }
    }
    // 最后一行通常是 vacuum / sum 行
    const lastLine = lines[lines.length - 1]?.trim();
    if (lastLine && /vacuum/i.test(lastLine)) {
      const vacMatch = lastLine.match(/([\d.]+)/);
      if (vacMatch) vacuumCharge = parseFloat(vacMatch[1]);
    }
    return {
      n_atoms: charges.length,
      charges,
      total_charge: parseFloat(totalCharge.toFixed(4)),
      ...(vacuumCharge !== null ? { vacuum_charge: vacuumCharge } : {}),
    };
  }

  // ---- 功函数 ----
  private parseWorkfunction(content: string, fp: string): Record<string, unknown> {
    const zVals: number[] = [], vVals: number[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const z = parseFloat(parts[0]), v = parseFloat(parts[1]);
        if (!isNaN(z) && !isNaN(v)) { zVals.push(z); vVals.push(v); }
      }
    }
    if (vVals.length === 0) return { error: "无法解析平面平均势数据" };
    const n = vVals.length;
    const edge = Math.max(1, Math.floor(n / 20));
    const vVacLeft = vVals.slice(0, edge).reduce((a, b) => a + b, 0) / edge;
    const vVacRight = vVals.slice(-edge).reduce((a, b) => a + b, 0) / edge;
    const vVacuum = Math.max(vVacLeft, vVacRight);
    const data: Record<string, unknown> = {
      n_points: n, z_range: [zVals[0], zVals[n - 1]],
      v_vacuum_ry: vVacuum, v_vacuum_ev: vVacuum * 13.6057,
      v_bulk_min_ry: Math.min(...vVals), v_bulk_min_ev: Math.min(...vVals) * 13.6057,
      note: "功函数 = v_vacuum_ev - fermi_energy_ev，需要从 scf.out 获取费米能级",
    };
    // 尝试自动获取费米能级
    const scfOut = join(dirname(fp), "scf.out");
    if (existsSync(scfOut)) {
      const scfContent = readFileSync(scfOut, "utf-8");
      const fermiMatch = scfContent.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
      if (fermiMatch) {
        const fermi = parseFloat(fermiMatch[1]);
        data.fermi_energy_ev = fermi;
        data.work_function_ev = data.v_vacuum_ev as number - fermi;
      }
    }
    return data;
  }

  // ---- NEB ----
  private parseNEB(content: string): Record<string, unknown> {
    const data: Record<string, unknown> = { converged: false, images: [] };
    const actFwd = content.match(/activation energy \(->\)\s*=\s*([-\d.]+)\s*eV/);
    if (actFwd) data.activation_energy_forward_ev = parseFloat(actFwd[1]);
    const actBwd = content.match(/activation energy \(<-\)\s*=\s*([-\d.]+)\s*eV/);
    if (actBwd) data.activation_energy_backward_ev = parseFloat(actBwd[1]);
    const lastTablePos = content.lastIndexOf("image");
    if (lastTablePos >= 0) {
      const tail = content.slice(lastTablePos);
      const imgs: Array<Record<string, unknown>> = [];
      for (const m of tail.matchAll(/^\s*(\d+)\s+([-\d.]+)\s+([-\d.]+)/gm)) {
        imgs.push({ image: parseInt(m[1]), energy_ev: parseFloat(m[2]), error_ev_per_a: parseFloat(m[3]) });
      }
      data.images = imgs;
      if (imgs.length > 0) {
        data.transition_state = imgs.reduce((a, b) => (a.energy_ev as number) > (b.energy_ev as number) ? a : b);
        data.n_images = imgs.length;
      }
    }
    if (/neb: convergence achieved/i.test(content)) data.converged = true;
    const niter = [...content.matchAll(/neb:\s+iteration\s+(\d+)/gi)];
    if (niter.length > 0) data.total_iterations = parseInt(niter[niter.length - 1][1]);

    // 反应能和能量轮廓
    const imgs = data.images as Array<Record<string, unknown>>;
    if (imgs.length >= 2) {
      const firstE = imgs[0].energy_ev as number;
      const lastE = imgs[imgs.length - 1].energy_ev as number;
      data.initial_state_energy_ev = firstE;
      data.final_state_energy_ev = lastE;
      data.reaction_energy_ev = parseFloat((lastE - firstE).toFixed(6));
      data.is_exothermic = lastE < firstE;
      // 归一化能量轮廓（起点 = 0）
      data.energy_profile_ev = imgs.map(img => parseFloat(((img.energy_ev as number) - firstE).toFixed(6)));
    }

    return data;
  }

  // ---- 光学 ----
  private parseOptical(content: string, fp: string): Record<string, unknown> {
    const energies: number[] = [], epsReal: number[] = [], epsImag: number[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const p = line.trim().split(/\s+/);
      if (p.length >= 3) {
        energies.push(parseFloat(p[0])); epsReal.push(parseFloat(p[1])); epsImag.push(parseFloat(p[2]));
      } else if (p.length === 2) {
        energies.push(parseFloat(p[0])); epsImag.push(parseFloat(p[1]));
      }
    }
    if (energies.length === 0) return { error: "无法解析光学数据" };
    const data: Record<string, unknown> = { n_points: energies.length, energy_range_ev: [Math.min(...energies), Math.max(...energies)] };
    if (epsReal.length > 0) { data.has_eps_real = true; data.static_dielectric = epsReal[0]; }
    if (epsImag.length > 0) {
      data.has_eps_imag = true;
      const maxImag = Math.max(...epsImag);
      const threshold = maxImag * 0.05;
      for (let i = 0; i < energies.length; i++) {
        if (epsImag[i] > threshold && energies[i] > 0.5) { data.optical_gap_ev = energies[i]; break; }
      }
      const peakIdx = epsImag.indexOf(maxImag);
      data.absorption_peak_ev = energies[peakIdx];
      data.absorption_peak_value = maxImag;
    }
    if (existsSync(join(dirname(fp), "eels.dat"))) data.eels_available = true;
    // Phase 4: 完整光学数据供前端绘图
    data.optical_data = {
      energies,
      epsReal: epsReal.length > 0 ? epsReal : null,
      epsImag: epsImag.length > 0 ? epsImag : null,
    };
    return data;
  }

  // ---- 声子 ----
  private parsePhonon(content: string): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    // 逐 q 点解析频率
    // NOTE: QE ph.x 格式：
    //   q = (  0.000  0.000  0.000 )
    //   ...
    //   freq (    1) =   -12.3 [cm-1]
    //   freq (    2) =     0.1 [cm-1]
    const qPoints: Array<{ q: number[]; frequencies_cm1: number[] }> = [];
    const allFreqs: number[] = [];

    // NOTE: 使用逐行扫描方式解析，比 split 更可靠
    let currentQ: number[] | null = null;
    let currentFreqs: number[] = [];
    for (const line of content.split("\n")) {
      const qMatch = line.match(/q\s*=\s*\(\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\)/);
      if (qMatch) {
        // 保存上一个 q 点
        if (currentQ && currentFreqs.length > 0) {
          qPoints.push({ q: currentQ, frequencies_cm1: [...currentFreqs] });
        }
        currentQ = [parseFloat(qMatch[1]), parseFloat(qMatch[2]), parseFloat(qMatch[3])];
        currentFreqs = [];
      }
      const freqMatch = line.match(/freq\s*\(\s*\d+\)\s*=\s*([-\d.]+)\s*\[cm-1\]/);
      if (freqMatch) {
        const f = parseFloat(freqMatch[1]);
        currentFreqs.push(f);
        allFreqs.push(f);
      }
      // matdyn.x 的频率格式不同：freq (cm-1) =  xxx  xxx  xxx
      const matdynFreqMatch = line.match(/freq\s*\(cm-1\)\s*=\s*([-\d.\s]+)/);
      if (matdynFreqMatch) {
        const freqs = matdynFreqMatch[1].trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
        currentFreqs.push(...freqs);
        allFreqs.push(...freqs);
      }
    }
    // 保存最后一个 q 点
    if (currentQ && currentFreqs.length > 0) {
      qPoints.push({ q: currentQ, frequencies_cm1: [...currentFreqs] });
    }

    // 如果逐 q 点扫描失败，回退到全局频率提取
    if (allFreqs.length === 0) {
      const freqBlocks = [...content.matchAll(/freq.*?=\s*([-\d.]+)/g)];
      allFreqs.push(...freqBlocks.map(m => parseFloat(m[1])));
    }

    const hasImag = allFreqs.some(f => f < -5);
    const minFreq = allFreqs.length > 0 ? Math.min(...allFreqs) : 0;
    const nModes = qPoints.length > 0 ? qPoints[0].frequencies_cm1.length : allFreqs.length;

    data.n_qpoints = qPoints.length || [...content.matchAll(/q\s*=/g)].length;
    data.n_modes = nModes;
    data.has_imaginary = hasImag;
    data.min_frequency_cm1 = minFreq;
    if (allFreqs.length > 0) data.max_frequency_cm1 = Math.max(...allFreqs);

    // 逐 q 点频率
    if (qPoints.length > 0) data.frequencies_per_qpoint = qPoints;

    // Γ 点频率（q=[0,0,0]，最重要的 q 点）
    const gammaPoint = qPoints.find(qp =>
      Math.abs(qp.q[0]) < 0.001 && Math.abs(qp.q[1]) < 0.001 && Math.abs(qp.q[2]) < 0.001,
    );
    if (gammaPoint) {
      data.gamma_frequencies_cm1 = gammaPoint.frequencies_cm1;
      // 声学支 vs 光学支（声学支频率 < 10 cm⁻¹）
      const acoustic = gammaPoint.frequencies_cm1.filter(f => Math.abs(f) < 10);
      const optical = gammaPoint.frequencies_cm1.filter(f => Math.abs(f) >= 10);
      if (acoustic.length > 0) data.acoustic_modes_cm1 = acoustic;
      if (optical.length > 0) data.optical_modes_cm1 = optical;
    }

    // 虚频详情
    if (hasImag) {
      const imagModes: Array<{ q: number[]; mode_index: number; freq_cm1: number }> = [];
      for (const qp of qPoints) {
        qp.frequencies_cm1.forEach((f, idx) => {
          if (f < -5) imagModes.push({ q: qp.q, mode_index: idx + 1, freq_cm1: f });
        });
      }
      data.imaginary_modes_detail = imagModes;
      data.stability = "UNSTABLE";
      data.stability_note = `存在虚频 (最低: ${minFreq.toFixed(1)} cm⁻¹)，结构热力学不稳定`;
    } else {
      data.stability = "STABLE";
      data.stability_note = "无虚频，结构热力学稳定";
    }

    // 零点能 ZPE = (1/2) Σ ℏω（仅正频率）
    const positiveFreqs = allFreqs.filter(f => f > 0);
    if (positiveFreqs.length > 0) {
      // cm⁻¹ → eV: 1 cm⁻¹ = 1.23981e-4 eV
      const CM1_TO_EV = 1.23981e-4;
      const zpe = 0.5 * positiveFreqs.reduce((sum, f) => sum + f, 0) * CM1_TO_EV;
      data.zero_point_energy_ev = parseFloat(zpe.toFixed(6));
    }

    // Born 有效电荷（绝缘体场景）
    const bornSection = content.match(/Effective charges.*in c\.u\.[\s\S]*?(?=\n\s*\n\s*\n)/i);
    if (bornSection) {
      const bornCharges: Array<Record<string, unknown>> = [];
      for (const m of bornSection[0].matchAll(/atom\s+(\d+)\s+(\w+)[\s\S]*?(?:Z\*|Zstar)\s*=[\s\S]*?([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/g)) {
        bornCharges.push({
          atom_index: parseInt(m[1]),
          element: m[2],
          z_star: [
            [parseFloat(m[3]), parseFloat(m[4]), parseFloat(m[5])],
            [parseFloat(m[6]), parseFloat(m[7]), parseFloat(m[8])],
            [parseFloat(m[9]), parseFloat(m[10]), parseFloat(m[11])],
          ],
        });
      }
      if (bornCharges.length > 0) data.born_effective_charges = bornCharges;
    }

    // 高频介电常数
    const dielMatch = content.match(/Dielectric constant.*\n\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\n\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\n\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i);
    if (dielMatch) {
      data.dielectric_tensor = [
        [parseFloat(dielMatch[1]), parseFloat(dielMatch[2]), parseFloat(dielMatch[3])],
        [parseFloat(dielMatch[4]), parseFloat(dielMatch[5]), parseFloat(dielMatch[6])],
        [parseFloat(dielMatch[7]), parseFloat(dielMatch[8]), parseFloat(dielMatch[9])],
      ];
    }

    // IR 活性模式
    const irModes: Array<{ freq_cm1: number; ir_intensity: number }> = [];
    for (const m of content.matchAll(/freq\s*\(\s*\d+\)\s*=\s*([-\d.]+).*?IR\s*=\s*([-\d.]+)/g)) {
      irModes.push({ freq_cm1: parseFloat(m[1]), ir_intensity: parseFloat(m[2]) });
    }
    if (irModes.length > 0) data.ir_active_modes = irModes;

    return data;
  }


  // ---- 辅助：能量分项 ----
  private parseEnergyComponents(content: string): Record<string, number> {
    const comps: Record<string, number> = {};
    const patterns: Record<string, RegExp> = {
      one_electron: /one-electron contribution\s+=\s+([-\d.]+)/,
      hartree: /hartree contribution\s+=\s+([-\d.]+)/,
      xc: /xc contribution\s+=\s+([-\d.]+)/,
      ewald: /ewald contribution\s+=\s+([-\d.]+)/,
      dft_d3: /DFT-D3 Dispersion\s+=\s+([-\d.]+)/,
      hubbard: /Hubbard energy\s+=\s+([-\d.]+)/,
      paw: /one-center paw contrib\.\s+=\s+([-\d.]+)/,
      smearing: /smearing contrib.*=\s+([-\d.]+)/,
    };
    for (const [key, pat] of Object.entries(patterns)) {
      const m = content.match(pat);
      if (m) comps[key] = parseFloat(m[1]);
    }
    return comps;
  }

  // ---- 辅助：Hubbard 占据 ----
  private parseHubbardOccupations(content: string): Array<Record<string, unknown>> | null {
    const lastStart = content.lastIndexOf("HUBBARD OCCUPATIONS");
    if (lastStart < 0) return null;
    const tail = content.slice(lastStart);
    const results: Array<Record<string, unknown>> = [];
    const pat = /ATOM\s+(\d+)\s*-+\s*\n\s*Tr\[ns\(\s*\d+\)\]\s*\(up,\s*down,\s*total\)\s*=\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\n\s*Atomic magnetic moment.*?=\s+([\d.]+)/g;
    for (const m of tail.matchAll(pat)) {
      results.push({
        atom_index: parseInt(m[1]), occ_up: parseFloat(m[2]),
        occ_down: parseFloat(m[3]), occ_total: parseFloat(m[4]),
        magnetic_moment: parseFloat(m[5]),
      });
    }
    return results.length > 0 ? results : null;
  }

  // ---- 辅助：原子磁矩 ----
  private parseAtomicMagnetization(content: string): Array<Record<string, unknown>> | null {
    const lastPos = content.lastIndexOf("Magnetic moment per site");
    if (lastPos < 0) return null;
    const tail = content.slice(lastPos);
    const results: Array<Record<string, unknown>> = [];
    for (const m of tail.matchAll(/atom\s+(\d+).*?charge=\s*([\d.]+)\s+magn=\s*([-\d.]+)/g)) {
      const magn = parseFloat(m[3]);
      if (Math.abs(magn) > 0.1) {
        results.push({ atom_index: parseInt(m[1]), charge: parseFloat(m[2]), magnetization: magn });
      }
    }
    return results.length > 0 ? results : null;
  }

  // ---- 辅助：提取最终坐标 ----
  private extractFinalCoords(content: string): Array<Record<string, unknown>> | null {
    const blocks = [...content.matchAll(/ATOMIC_POSITIONS.*?\n([\s\S]*?)(?=\n\s*(?:End|ATOMIC|CELL|K_POINTS|\n\s*\n))/g)];
    if (blocks.length === 0) return null;
    const lastBlock = blocks[blocks.length - 1][1];
    const atoms: Array<Record<string, unknown>> = [];
    for (const line of lastBlock.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      // NOTE: 支持自定义 species 标签（Ni1/Ni2/Fe_up 等），不仅限标准元素符号
      if (parts.length >= 4 && /^[A-Z][a-z]?\d?/.test(parts[0])) {
        const rawLabel = parts[0];
        // NOTE: 提取纯元素符号，剥离数字/下划线后缀（Bug #15 修复）
        // Ni1→Ni, Fe_up→Fe, Co2→Co, O→O
        const baseEl = rawLabel.match(/^([A-Z][a-z]?)/)?.[1] ?? rawLabel;
        atoms.push({ element: rawLabel, base_element: baseEl, position: [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])] });
      }
    }
    return atoms.length > 0 ? atoms : null;
  }

  // ---- 辅助：提取最终晶胞 ----
  private extractFinalCell(content: string): number[][] | null {
    const blocks = [...content.matchAll(/CELL_PARAMETERS.*?\n([\s\S]*?)(?=\n\s*(?:ATOMIC|$))/g)];
    if (blocks.length === 0) return null;
    const lastBlock = blocks[blocks.length - 1][1];
    const cell: number[][] = [];
    for (const line of lastBlock.trim().split("\n")) {
      const parts = line.trim().split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every(v => !isNaN(v))) cell.push(parts.slice(0, 3));
      if (cell.length === 3) break;
    }
    return cell.length === 3 ? cell : null;
  }

  // ---- 辅助：从输出或输入文件提取晶胞 ----
  private extractCellFromFiles(content: string, inFile: string): number[][] | null {
    // 从 output 中找 a(1) = (...)
    const cell: number[][] = [];
    const alatMatch = content.match(/lattice parameter \(alat\)\s*=\s*([\d.]+)/);
    for (const m of content.matchAll(/a\(\d\)\s*=\s*\(\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\)/g)) {
      cell.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      if (cell.length === 3) break;
    }
    if (cell.length === 3 && alatMatch) {
      const alat = parseFloat(alatMatch[1]) * 0.529177;
      return cell.map(row => row.map(v => v * alat));
    }
    // fallback: 从输入文件
    if (existsSync(inFile)) {
      const inContent = readFileSync(inFile, "utf-8");
      const cellFromIn: number[][] = [];
      let inCell = false;
      for (const line of inContent.split("\n")) {
        const s = line.trim();
        if (/CELL_PARAMETERS/i.test(s)) { inCell = true; continue; }
        if (inCell) {
          if (!s || s.startsWith("ATOMIC")) break;
          const parts = s.split(/\s+/);
          if (parts.length >= 3) {
            const vals = parts.slice(0, 3).map(Number);
            if (vals.every(v => !isNaN(v))) cellFromIn.push(vals);
          }
        }
      }
      if (cellFromIn.length === 3) return cellFromIn;
    }
    return null;
  }

  // ---- Issue #2: 文件读取 retry ----

  /**
   * 带重试的文件读取
   *
   * NOTE: SCNet 下载大文件后可能尚未完全写入磁盘，
   * 首次 stat/readFile 会失败。等待 2s 后重试最多 3 次。
   */
  private async readFileWithRetry(filePath: string, maxRetries = 3, delayMs = 2000): Promise<string | null> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const info = await stat(filePath);
        // 文件存在但大小为 0 → 可能正在写入，等待
        if (info.size === 0 && i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        const content = await readFile(filePath, { encoding: "utf-8" });
        if (content.length > 0) return content;
      } catch {
        if (i === maxRetries - 1) return null;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  // ---- Issue #6: 错误诊断 ----

  /**
   * 分类 QE 计算失败的错误类型
   *
   * NOTE: 帮助 Agent 快速判断是参数错误、SCF 不收敛还是运行时崩溃，
   * 避免需要阅读整个输出文件来定位问题。
   */
  private diagnoseError(
    content: string,
    converged: boolean,
    jobDone: boolean,
  ): { error_type: string; error_detail: string } {
    // 运行时崩溃：Error in routine
    const routineError = content.match(/Error in routine\s+([^\n]+)\n([^\n]*)/);
    if (routineError) {
      return {
        error_type: "runtime_crash",
        error_detail: `Error in routine ${routineError[1].trim()}: ${routineError[2].trim()}`,
      };
    }
    // SCF 不收敛
    if (/convergence NOT achieved/i.test(content)) {
      return {
        error_type: "scf_not_converged",
        error_detail: "SCF convergence NOT achieved after maximum iterations",
      };
    }
    // 文件为空或无 JOB DONE
    if (content.length < 100) {
      return {
        error_type: "incomplete",
        error_detail: "Output file is too short, computation may have crashed early",
      };
    }
    if (!jobDone && content.length > 100) {
      // 检查是否是早期终止（如 SIGKILL、超时等）
      const lastLines = content.slice(-500);
      if (/ABORT|forrtl|Segmentation/i.test(lastLines)) {
        return {
          error_type: "runtime_crash",
          error_detail: `Process terminated abnormally: ${lastLines.slice(-200).trim()}`,
        };
      }
      return {
        error_type: "incomplete",
        error_detail: "JOB DONE marker not found, computation may have been interrupted",
      };
    }
    return { error_type: "none", error_detail: "" };
  }

  // ---- 辅助：时间字符串解析 ----

  /**
   * 解析 QE 时间格式字符串为秒数
   *
   * NOTE: QE 输出的时间格式不统一：
   * "2m34.56s" / "1h 2m" / "45.32s" / "1h 2m34.56s"
   */
  private parseTimeStr(s: string): number {
    let total = 0;
    const h = s.match(/(\d+)h/);
    const m = s.match(/(\d+)m/);
    const sec = s.match(/([\d.]+)s/);
    if (h) total += parseInt(h[1]) * 3600;
    if (m) total += parseInt(m[1]) * 60;
    if (sec) total += parseFloat(sec[1]);
    return Math.round(total);
  }

  // ---- 辅助：Löwdin 电荷解析 ----

  /**
   * 从 QE 输出中提取 Löwdin 电荷分析
   *
   * NOTE: QE 格式：
   * Lowdin Charges:
   *      Atom #   1: total charge =   3.9812, s =  0.65, p =  2.52, d =  0.81
   */
  private parseLowdinCharges(content: string): Array<Record<string, unknown>> | null {
    // 找到最后一次出现的 Lowdin Charges 块
    const lastPos = content.lastIndexOf("Lowdin Charges");
    if (lastPos < 0) return null;
    const tail = content.slice(lastPos);
    const results: Array<Record<string, unknown>> = [];
    for (const m of tail.matchAll(/Atom\s*#\s*(\d+):\s*total charge\s*=\s*([\d.]+)([^\n]*)/g)) {
      const entry: Record<string, unknown> = {
        atom_index: parseInt(m[1]),
        total_charge: parseFloat(m[2]),
      };
      // 解析各轨道贡献
      for (const om of m[3].matchAll(/([spdf])\s*=\s*([\d.]+)/g)) {
        entry[om[1]] = parseFloat(om[2]);
      }
      results.push(entry);
    }
    return results.length > 0 ? results : null;
  }
}

// ---------------------------------------------------------------------------
// 公共 API — 供 Watchdog 等外部模块复用解析逻辑
// ---------------------------------------------------------------------------

/** 解析器单例（避免重复实例化） */
let _parserInstance: ExtractDFTResultsTool | null = null;
function getParser(): ExtractDFTResultsTool {
  if (!_parserInstance) _parserInstance = new ExtractDFTResultsTool();
  return _parserInstance;
}

/**
 * 从文件名和内容自动检测 QE 输出类型
 *
 * NOTE: Watchdog 用这个判断输出文件是 SCF / Relax / Bands 等
 */
export function detectQeType(filename: string, content: string): string {
  return (getParser() as unknown as { detectType: (fp: string, c: string) => string }).detectType(filename, content);
}

/**
 * 解析 QE 输出文件内容，返回结构化数据
 *
 * NOTE: 这是 extract_dft_results 工具的核心解析逻辑的公共入口。
 * Watchdog 调用此函数取代自己重写的 parseOutputTail()，
 * 确保解析逻辑单一真相源。
 *
 * @param content 输出文件内容（字符串）
 * @param type 结果类型（可选，不传则自动检测）
 * @param filePath 文件路径（部分解析器需要读取同目录文件）
 */
export function parseQeOutput(
  content: string,
  type?: string,
  filePath?: string,
): Record<string, unknown> {
  const parser = getParser();
  const fp = filePath ?? "output.out";
  const resultType = type ?? detectQeType(fp, content);

  // NOTE: 通过 any 跳过 private 限制 — 这些方法的签名稳定，不会随意变动
  const p = parser as unknown as Record<string, (...args: unknown[]) => Record<string, unknown>>;

  let data: Record<string, unknown>;
  switch (resultType) {
    case "scf": data = p.parseSCF(content); break;
    case "relax": data = p.parseRelax(content, fp); break;
    case "bands": data = p.parseBands(content, fp); break;
    case "dos": data = p.parseDOS(content, fp); break;
    case "neb": data = p.parseNEB(content); break;
    case "phonon": data = p.parsePhonon(content); break;
    default: data = p.parseSCF(content); break;
  }

  data.result_type = resultType;
  return data;
}
