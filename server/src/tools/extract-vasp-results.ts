/**
 * extract_vasp_results — 从 VASP 输出文件提取结构化计算结果
 *
 * 支持解析：OUTCAR、OSZICAR、CONTCAR、DOSCAR、EIGENVAL
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, basename, isAbsolute, resolve } from "path";
import { DFTTool, type ToolResult } from "./base.js";

export class ExtractVaspResultsTool extends DFTTool {
  readonly name = "extract_vasp_results";

  readonly description =
    "从 VASP 输出文件（OUTCAR/OSZICAR/CONTCAR 等）提取结构化计算结果。\n" +
    "支持 result_type: scf / relax / band / dos / md / neb。\n" +
    "NEB 类型时 file_path 传 NEB 根目录（包含 00/ 01/ ... 子目录），返回：\n" +
    "  每 image 的能量/ΔE/最大力/磁矩/是否力收敛、climbing image、band 最大力、\n" +
    "  converged(全 image 力达标)、nsw_limit_reached、Hammond 自洽性 + TS 几何 sanity 警告。\n" +
    "  ⚠️ warnings 非空时务必先核查：未收敛或几何假象的 barrier 不可写入结论。\n" +
    "relax 类型返回 force_converged / nsw_limit_reached 及 CONTCAR vs XDATCAR 警示。\n" +
    "不指定 result_type 时自动检测。";

  readonly inputSchema = {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "输出文件路径（OUTCAR 或计算目录路径）",
      },
      result_type: {
        type: "string",
        enum: ["scf", "relax", "band", "dos", "md", "neb"],
        description: "结果类型（可选，不传则自动检测）",
      },
    },
    required: ["file_path"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let filePath = args.file_path as string;
    const resultType = args.result_type as string | undefined;

    // NOTE: 相对路径自动解析到 workspaceDir（与 submit_compute_job/create_vasp_input 统一）
    if (!isAbsolute(filePath) && this.workspaceDir) {
      filePath = resolve(this.workspaceDir, filePath);
    }

    // 确定工作目录和 OUTCAR 路径
    let workDir: string;
    let outcarPath: string;

    if (existsSync(join(filePath, "OUTCAR"))) {
      // 传入的是目录
      workDir = filePath;
      outcarPath = join(filePath, "OUTCAR");
    } else if (basename(filePath) === "OUTCAR" && existsSync(filePath)) {
      workDir = dirname(filePath);
      outcarPath = filePath;
    } else if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      // NOTE: 目录但根目录无 OUTCAR → 可能是 NEB 根目录（OUTCAR 在 00/ 01/ 子目录里）。
      // 之前此情况误把 workDir 设为父目录，导致传 NEB 根目录时解析失败。
      workDir = filePath;
      outcarPath = join(filePath, "OUTCAR");
    } else if (existsSync(filePath)) {
      workDir = dirname(filePath);
      outcarPath = join(workDir, "OUTCAR");
    } else {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    // --- NEB 类型：特殊处理，遍历各 image 目录 ---
    if (resultType === "neb" || this.isNebDir(workDir)) {
      return this.parseNEB(workDir);
    }

    try {
      const results: Record<string, unknown> = { work_dir: workDir };

      // 解析 OUTCAR
      if (existsSync(outcarPath)) {
        const outcar = readFileSync(outcarPath, "utf-8");
        Object.assign(results, this.parseOutcar(outcar));
      }

      // 解析 OSZICAR
      const oszicarPath = join(workDir, "OSZICAR");
      if (existsSync(oszicarPath)) {
        const oszicar = readFileSync(oszicarPath, "utf-8");
        Object.assign(results, { oszicar: this.parseOszicar(oszicar) });
      }

      // 解析 CONTCAR（弛豫后结构）
      const contcarPath = join(workDir, "CONTCAR");
      if (existsSync(contcarPath)) {
        const contcar = readFileSync(contcarPath, "utf-8");
        const structData = this.parseContcar(contcar);
        if (structData) {
          results.structure_data = structData;
        }
      }

      // 自动检测结果类型
      const detected = resultType ?? this.detectType(results);
      results.result_type = detected;

      // NOTE: Bug #1/#9/#15 — relax/md 补充力收敛、NSW 限位、CONTCAR vs XDATCAR 警示
      if (detected === "relax" || detected === "md") {
        this.annotateRelaxConvergence(results);
      }

      const display = this.buildDisplay(results, detected);

      return { success: true, data: results, display };
    } catch (e) {
      return { success: false, error: `解析失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  /** 解析 OUTCAR 提取关键数据 */
  private parseOutcar(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // 总能量（取最后一个）
    const energyMatches = [...content.matchAll(/free  energy   TOTEN\s*=\s*([-\d.]+)\s*eV/g)];
    if (energyMatches.length > 0) {
      result.final_energy_ev = parseFloat(energyMatches[energyMatches.length - 1][1]);
      result.all_energies_ev = energyMatches.map((m) => parseFloat(m[1]));
    }

    // sigma→0 能量
    const e0Matches = [...content.matchAll(/energy\(sigma->0\)\s*=\s*([-\d.]+)/g)];
    if (e0Matches.length > 0) {
      result.energy_sigma0_ev = parseFloat(e0Matches[e0Matches.length - 1][1]);
    }

    // 费米能级
    const fermiMatch = content.match(/E-fermi\s*:\s*([-\d.]+)/);
    if (fermiMatch) {
      result.fermi_energy_ev = parseFloat(fermiMatch[1]);
    }

    // 磁矩：取最后一个匹配 = 最终自洽磁矩。
    // NOTE: "number of electron ... magnetization" 每个电子步都打印一行，第一行是初始磁化
    // （≈ MAGMOM 初值之和）。旧实现用 content.match 取第一个，会误读初值（如 Fe relax 读到
    // 4.0 而非收敛的 2.20）。改用 matchAll 取最后一个，与 OSZICAR 末行 mag= 一致。
    const magMatches = [...content.matchAll(/number of electron\s+(\S+)\s+magnetization\s+([-\d.]+)/g)];
    if (magMatches.length > 0) {
      result.total_magnetization = parseFloat(magMatches[magMatches.length - 1][2]);
    }

    // 收敛判定
    result.converged = content.includes("reached required accuracy");

    // 力（取最后一组）
    const forceBlocks = [...content.matchAll(/TOTAL-FORCE \(eV\/Angst\)\n\s*-+\n([\s\S]*?)(?=\n\s*-+)/g)];
    if (forceBlocks.length > 0) {
      const lastBlock = forceBlocks[forceBlocks.length - 1][1];
      const forces = lastBlock.trim().split("\n").map((line) => {
        const parts = line.trim().split(/\s+/).map(Number);
        return { fx: parts[3], fy: parts[4], fz: parts[5] };
      });
      const maxForce = Math.max(...forces.map((f) => Math.sqrt(f.fx ** 2 + f.fy ** 2 + f.fz ** 2)));
      result.forces_max_ev_ang = maxForce;
      result.n_atoms = forces.length;
    }

    // 离子步数
    const ionicSteps = (content.match(/Iteration\s+\d+\(/g) ?? []).length;
    result.n_ionic_steps = ionicSteps;

    // NOTE: 精确离子步数 = TOTAL-FORCE 块数（每个离子步一块）。
    // 上面的 "Iteration N(" 计数实为电子步，离子步限位判断应使用 total_ionic_steps（Bug #15）
    result.total_ionic_steps = forceBlocks.length;

    // EDIFFG / NSW（用于力收敛与 NSW 限位判定）
    const ediffgMatch = content.match(/EDIFFG\s*=\s*([-\d.E+]+)/);
    if (ediffgMatch) result.ediffg = parseFloat(ediffgMatch[1]);
    const nswMatch = content.match(/NSW\s*=\s*(\d+)/);
    if (nswMatch) result.nsw = parseInt(nswMatch[1], 10);

    // ENCUT
    const encutMatch = content.match(/ENCUT\s*=\s*([\d.]+)/);
    if (encutMatch) result.encut_ev = parseFloat(encutMatch[1]);

    // K 点数
    const kpointMatch = content.match(/NKPTS\s*=\s*(\d+)/);
    if (kpointMatch) result.n_kpoints = parseInt(kpointMatch[1]);

    return result;
  }

  /** 解析 OSZICAR — 电子步和离子步能量历史 */
  private parseOszicar(content: string): Record<string, unknown> {
    const lines = content.trim().split("\n");
    const ionicSteps: { step: number; energy: number; dE: number; mag?: number }[] = [];

    for (const line of lines) {
      // 离子步格式: N F= ... E0= ... d E = ... mag= ...
      const match = line.match(/^\s*(\d+)\s+F=\s*([-\d.E+]+)\s+E0=\s*([-\d.E+]+)\s+d E\s*=\s*([-\d.E+]+)/);
      if (match) {
        const step: Record<string, unknown> = {
          step: parseInt(match[1]),
          energy: parseFloat(match[2]),
          dE: parseFloat(match[4]),
        };
        const magMatch = line.match(/mag=\s*([-\d.E+]+)/);
        if (magMatch) step.mag = parseFloat(magMatch[1]);
        ionicSteps.push(step as typeof ionicSteps[0]);
      }
    }

    return {
      n_ionic_steps: ionicSteps.length,
      ionic_steps: ionicSteps.slice(-20), // 最近 20 步
    };
  }

  /** 解析 CONTCAR 提取弛豫后结构 */
  private parseContcar(content: string): Record<string, unknown> | null {
    try {
      const lines = content.trim().split("\n");
      if (lines.length < 8) return null;

      const scale = parseFloat(lines[1]);
      const cell: number[][] = [];
      for (let i = 2; i <= 4; i++) {
        cell.push(lines[i].trim().split(/\s+/).map((v) => parseFloat(v) * scale));
      }

      const elements = lines[5].trim().split(/\s+/);
      const counts = lines[6].trim().split(/\s+/).map(Number);

      // 检测坐标类型
      const coordLine = lines[7].trim();
      const isCartesian = coordLine.startsWith("C") || coordLine.startsWith("c");
      const startLine = coordLine.startsWith("S") || coordLine.startsWith("s") ? 9 : 8;
      const actualCoordType = lines[startLine - 1]?.trim();
      const iCart = actualCoordType?.startsWith("C") || actualCoordType?.startsWith("c");

      const atoms: { element: string; position: number[] }[] = [];
      let lineIdx = startLine;
      for (let ei = 0; ei < elements.length; ei++) {
        for (let ci = 0; ci < counts[ei]; ci++) {
          if (lineIdx >= lines.length) break;
          const parts = lines[lineIdx].trim().split(/\s+/).map(Number);
          atoms.push({ element: elements[ei], position: [parts[0], parts[1], parts[2]] });
          lineIdx++;
        }
      }

      return {
        atoms,
        cell_parameters: cell,
        coords_are_cartesian: iCart ?? isCartesian,
      };
    } catch {
      return null;
    }
  }

  /** 自动检测结果类型 */
  private detectType(results: Record<string, unknown>): string {
    const nIonic = (results.n_ionic_steps as number) ?? 0;
    if (nIonic > 1) return "relax";
    return "scf";
  }

  /**
   * relax/md 收敛性标注（Bug #1/#9/#15）
   *
   * - 给出明确的 last_evaluated_step / total_ionic_steps / force_converged / nsw_limit_reached
   * - NSW 限位且未收敛时：CONTCAR 是优化器外推的下一步几何（未评估），可能含非物理键长，
   *   提示改用 XDATCAR 末帧；并对 CONTCAR 结构做键长 sanity。
   */
  private annotateRelaxConvergence(results: Record<string, unknown>): void {
    const warnings: string[] = [];

    const ediffg = results.ediffg as number | undefined;
    const nsw = results.nsw as number | undefined;
    const totalSteps = (results.total_ionic_steps as number) ?? (results.n_ionic_steps as number) ?? 0;
    const maxForce = results.forces_max_ev_ang as number | undefined;
    const reachedAccuracy = results.converged === true; // OUTCAR "reached required accuracy"

    const forceTol = ediffg !== undefined && ediffg < 0 ? Math.abs(ediffg) : 0.05;
    const forceCriterionIsEnergy = ediffg !== undefined && ediffg > 0;

    results.force_tol_ev_ang = forceTol;
    results.last_evaluated_step = totalSteps;
    const forceConverged = maxForce !== undefined ? maxForce <= forceTol : null;
    results.force_converged = forceConverged;

    const nswReached = nsw !== undefined && totalSteps >= nsw;
    results.nsw_limit_reached = nswReached;

    // 整体是否收敛：能量判据看 OUTCAR 字样，力判据看最大力
    const trulyConverged = forceCriterionIsEnergy ? reachedAccuracy : (forceConverged === true || reachedAccuracy);
    results.converged = trulyConverged;

    if (nswReached && !trulyConverged) {
      warnings.push(
        "❌ relax 撞 NSW=" + nsw + " 限位但未达收敛" +
        (maxForce !== undefined ? `（最大力 ${maxForce.toFixed(4)} > ${forceTol} eV/Å）` : "") + "。"
      );
      warnings.push(
        "⚠️ 此时 CONTCAR 是优化器外推的【下一步输入几何】（从未被评估），单步外推过大可能产生非物理键长（如 C-H≈0.57 Å）。" +
        "真正最后评估的结构在 XDATCAR 末帧；请勿直接把 CONTCAR 当作弛豫终态做后续分析或判断'结构崩坏'。"
      );
    } else if (forceConverged === false && !reachedAccuracy) {
      warnings.push(
        "⚠️ relax 未达力收敛：最大力 " +
        (maxForce !== undefined ? maxForce.toFixed(4) : "?") +
        " eV/Å > 阈值 " + forceTol + " eV/Å（未撞 NSW，可能仍在进行或异常中止）。"
      );
    }

    // CONTCAR 键长 sanity（无论是否收敛都查一下；非物理键长是危险信号）
    const sd = results.structure_data as
      | { atoms: { element: string; position: number[] }[]; cell_parameters: number[][]; coords_are_cartesian: boolean }
      | undefined;
    if (sd && Array.isArray(sd.atoms) && sd.atoms.length > 1) {
      const sanity = this.geometrySanity(sd);
      results.contcar_geometry = {
        min_distance_ang: sanity.minDistance,
        issues: sanity.issues,
      };
      for (const issue of sanity.issues) {
        warnings.push("⚠️ CONTCAR 几何: " + issue);
      }
    }

    if (warnings.length > 0) {
      results.warnings = warnings;
    }
  }

  /** 检测目录是否为 NEB 结构（00/ 01/ ... 子目录包含 OUTCAR） */
  private isNebDir(dir: string): boolean {
    try {
      const entries = readdirSync(dir);
      const imageDirs = entries.filter((f) => {
        if (!/^\d{2}$/.test(f)) return false;
        const p = join(dir, f);
        return statSync(p).isDirectory() && existsSync(join(p, "OUTCAR"));
      });
      // 至少有 3 个数字目录（00 + 1+ images + final）才认为是 NEB
      return imageDirs.length >= 3;
    } catch {
      return false;
    }
  }

  /**
   * 解析单个 image 的 OUTCAR — 能量 / 最大力 / 磁矩 / 离子步 / EDIFFG / NSW
   *
   * NOTE: 最大力取最后一个 TOTAL-FORCE 块（= 最后一次评估的几何），
   * 离子步数按 TOTAL-FORCE 块数计（每个离子步一块），比 "Iteration N(" 计数准确。
   */
  private parseImageOutcar(content: string): {
    energy: number | null;
    maxForce: number | null;
    mag: number | null;
    nIonicSteps: number;
    ediffg: number | null;
    nsw: number | null;
  } {
    // 能量：优先 sigma→0，回退 TOTEN
    let energy: number | null = null;
    const e0 = [...content.matchAll(/energy\(sigma->0\)\s*=\s*([-\d.]+)/g)];
    if (e0.length > 0) {
      energy = parseFloat(e0[e0.length - 1][1]);
    } else {
      const toten = [...content.matchAll(/free  energy   TOTEN\s*=\s*([-\d.]+)\s*eV/g)];
      if (toten.length > 0) energy = parseFloat(toten[toten.length - 1][1]);
    }

    // 最大单原子力（最后一个 TOTAL-FORCE 块）
    const forceBlocks = [...content.matchAll(/TOTAL-FORCE \(eV\/Angst\)\n\s*-+\n([\s\S]*?)(?=\n\s*-+)/g)];
    let maxForce: number | null = null;
    if (forceBlocks.length > 0) {
      const lastBlock = forceBlocks[forceBlocks.length - 1][1];
      const forces = lastBlock.trim().split("\n").map((line) => {
        const parts = line.trim().split(/\s+/).map(Number);
        return { fx: parts[3], fy: parts[4], fz: parts[5] };
      }).filter((f) => Number.isFinite(f.fx) && Number.isFinite(f.fy) && Number.isFinite(f.fz));
      if (forces.length > 0) {
        maxForce = Math.max(...forces.map((f) => Math.sqrt(f.fx ** 2 + f.fy ** 2 + f.fz ** 2)));
      }
    }

    // 磁矩：取最后一个匹配 = 最终自洽磁矩（同 parseOutcar，避免误读 MAGMOM 初值）
    const magMatches = [...content.matchAll(/number of electron\s+\S+\s+magnetization\s+([-\d.]+)/g)];
    const mag = magMatches.length > 0 ? parseFloat(magMatches[magMatches.length - 1][1]) : null;

    // EDIFFG / NSW（VASP 在 OUTCAR 头部打印参数）
    const ediffgMatch = content.match(/EDIFFG\s*=\s*([-\d.E+]+)/);
    const ediffg = ediffgMatch ? parseFloat(ediffgMatch[1]) : null;
    const nswMatch = content.match(/NSW\s*=\s*(\d+)/);
    const nsw = nswMatch ? parseInt(nswMatch[1], 10) : null;

    return { energy, maxForce, mag, nIonicSteps: forceBlocks.length, ediffg, nsw };
  }

  /**
   * 解析 NEB 结果 — 遍历各 image 目录提取能量、力、收敛性、可信度
   *
   * NEB 目录结构：
   * base_dir/00/OUTCAR  ← 初态
   * base_dir/01/OUTCAR  ← Image 1
   * ...
   * base_dir/0N+1/OUTCAR ← 终态
   *
   * NOTE: Bug #17 修复 — 不仅提取能量，还提取每个 image 的最大力、是否力收敛、
   * climbing image、band 整体收敛性、Hammond 自洽性、TS 几何 sanity。
   * 目的：堵住"未收敛当收敛"和"几何假象 barrier 当真"两个最危险的坑。
   */
  private parseNEB(baseDir: string): ToolResult {
    try {
      const entries = readdirSync(baseDir);
      const imageDirs = entries
        .filter((f) => /^\d{2,3}$/.test(f) && statSync(join(baseDir, f)).isDirectory())
        .sort();

      if (imageDirs.length < 3) {
        return { success: false, error: `NEB 目录不完整：只找到 ${imageDirs.length} 个子目录，至少需要 3 个（00 + images + final）。` };
      }

      type ImageResult = {
        dir: string;
        energy_ev: number | null;
        rel_energy_ev: number | null;
        max_force_ev_ang: number | null;
        mag: number | null;
        n_ionic_steps: number;
        force_converged: boolean | null;
        is_climbing: boolean;
      };
      const imageResults: ImageResult[] = [];
      const energies: number[] = [];

      // EDIFFG / NSW 全 image 共享，取首个能解析到的
      let ediffg: number | null = null;
      let nsw: number | null = null;
      const raw: ReturnType<typeof this.parseImageOutcar>[] = [];

      for (const imgDir of imageDirs) {
        const outcarPath = join(baseDir, imgDir, "OUTCAR");
        if (existsSync(outcarPath)) {
          const parsed = this.parseImageOutcar(readFileSync(outcarPath, "utf-8"));
          raw.push(parsed);
          if (ediffg === null && parsed.ediffg !== null) ediffg = parsed.ediffg;
          if (nsw === null && parsed.nsw !== null) nsw = parsed.nsw;
        } else {
          raw.push({ energy: null, maxForce: null, mag: null, nIonicSteps: 0, ediffg: null, nsw: null });
        }
      }

      // 力收敛判据：EDIFFG<0 → |EDIFFG|；否则（能量判据或缺失）回退默认 0.05 eV/Å
      const forceTol = ediffg !== null && ediffg < 0 ? Math.abs(ediffg) : 0.05;
      const forceCriterionIsEnergy = ediffg !== null && ediffg > 0;

      const eInitRef = raw[0].energy;
      for (let i = 0; i < imageDirs.length; i++) {
        const p = raw[i];
        if (p.energy !== null) energies.push(p.energy);
        imageResults.push({
          dir: imageDirs[i],
          energy_ev: p.energy,
          rel_energy_ev: p.energy !== null && eInitRef !== null ? p.energy - eInitRef : null,
          max_force_ev_ang: p.maxForce,
          mag: p.mag,
          n_ionic_steps: p.nIonicSteps,
          force_converged: p.maxForce !== null ? p.maxForce <= forceTol : null,
          is_climbing: false,
        });
      }

      const results: Record<string, unknown> = {
        result_type: "neb",
        work_dir: baseDir,
        n_images: imageDirs.length - 2,
        n_total_dirs: imageDirs.length,
        ediffg,
        force_tol_ev_ang: forceTol,
        nsw,
        image_results: imageResults,
      };

      const warnings: string[] = [];

      // --- 能量学：活化能 / 反应能 / climbing image ---
      let tsIndex = -1;
      if (energies.length >= 3) {
        const eInit = energies[0];
        const eFinal = energies[energies.length - 1];
        const eMax = Math.max(...energies);
        tsIndex = energies.indexOf(eMax);
        imageResults[tsIndex].is_climbing = true;

        results.energies_ev = energies;
        results.relative_energies_ev = energies.map((e) => e - eInit);
        results.activation_energy_forward_ev = eMax - eInit;
        results.activation_energy_backward_ev = eMax - eFinal;
        results.reaction_energy_ev = eFinal - eInit;
        results.transition_state_image = imageDirs[tsIndex];
        results.transition_state_energy_ev = eMax;

        // climbing image 落在端点上 → 路径有问题（真正过渡态应在中间）
        if (tsIndex === 0 || tsIndex === energies.length - 1) {
          warnings.push(
            "⚠️ 能量最高点落在端点（image " + imageDirs[tsIndex] + "），不是中间 image。" +
            "说明路径可能单调、端点未充分弛豫，或 barrier 极小。activation energy 可能无意义。"
          );
        }
      }

      // --- 力收敛性（band 整体） ---
      const middle = imageResults.slice(1, -1);
      const middleForces = middle.map((r) => r.max_force_ev_ang).filter((f): f is number => f !== null);
      const maxForceOverBand = middleForces.length > 0 ? Math.max(...middleForces) : null;
      results.max_force_over_band_ev_ang = maxForceOverBand;

      const allMiddleConverged = middle.length > 0 && middle.every((r) => r.force_converged === true);
      results.converged = allMiddleConverged;
      // 向后兼容旧字段名
      results.all_images_converged = allMiddleConverged;

      // NSW 限位检测：任一中间 image 离子步数达到 NSW
      const nswReached = nsw !== null && middle.some((r) => r.n_ionic_steps >= (nsw as number));
      results.nsw_limit_reached = nswReached;

      if (forceCriterionIsEnergy) {
        warnings.push(
          "⚠️ EDIFFG=" + ediffg + " > 0（能量判据）。NEB 应使用力判据（EDIFFG<0，如 -0.05），" +
          "否则力收敛性无法从能量判断。下方力收敛判定按默认阈值 " + forceTol + " eV/Å 估算，仅供参考。"
        );
      }
      if (!allMiddleConverged) {
        warnings.push(
          "❌ NEB 未达力收敛：band 最大力 " +
          (maxForceOverBand !== null ? maxForceOverBand.toFixed(4) : "?") +
          " eV/Å > 阈值 " + forceTol + " eV/Å" +
          (nswReached ? "，且已撞 NSW=" + nsw + " 限位" : "") +
          "。**未收敛的 barrier 不可写入结论**，需续算（建议 VTST IOPT 优化器）后再取能量。"
        );
      }

      // --- Hammond 自洽性 flag ---
      const Ef = results.activation_energy_forward_ev as number | undefined;
      const dErxn = results.reaction_energy_ev as number | undefined;
      if (Ef !== undefined && dErxn !== undefined) {
        if (Ef > 1.5 && Ef > 3 * Math.max(Math.abs(dErxn), 0.3)) {
          warnings.push(
            "⚠️ Hammond 自洽性可疑：前向 barrier " + Ef.toFixed(2) + " eV 远高于反应能 " +
            dErxn.toFixed(2) + " eV（近热中性/温和步骤却出现巨大 barrier）。" +
            "高度疑似 climbing image 几何假象（如悬空/穿越原子），请核查 TS 几何与收敛性后再采信。"
          );
        }
      }

      // --- TS（climbing image）几何 sanity ---
      if (tsIndex >= 0) {
        const tsDir = imageDirs[tsIndex];
        // 优先 CONTCAR（弛豫后），回退 POSCAR
        const tsContcar = join(baseDir, tsDir, "CONTCAR");
        const tsPoscar = join(baseDir, tsDir, "POSCAR");
        const geomFile = existsSync(tsContcar) ? tsContcar : (existsSync(tsPoscar) ? tsPoscar : null);
        if (geomFile) {
          const struct = this.parseContcar(readFileSync(geomFile, "utf-8")) as
            | { atoms: { element: string; position: number[] }[]; cell_parameters: number[][]; coords_are_cartesian: boolean }
            | null;
          if (struct && struct.atoms.length > 1) {
            const sanity = this.geometrySanity(struct);
            results.ts_geometry = {
              image: tsDir,
              source: basename(geomFile),
              min_distance_ang: sanity.minDistance,
              issues: sanity.issues,
            };
            for (const issue of sanity.issues) {
              warnings.push("⚠️ TS 几何 (image " + tsDir + "): " + issue);
            }
            if (nswReached && existsSync(tsContcar)) {
              warnings.push(
                "ℹ️ TS 取自 CONTCAR 且作业撞 NSW 限位：CONTCAR 是优化器外推的下一步几何（未评估），" +
                "可能含非物理键长。分析真实最后一帧请改看该 image 的 XDATCAR 末帧。"
              );
            }
          }
        }
      }

      if (warnings.length > 0) results.warnings = warnings;

      const display = this.buildNebDisplay(results);
      return { success: true, data: results, display };
    } catch (e) {
      return { success: false, error: `NEB 解析失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  /**
   * 几何 sanity 检查（最小镜像约定 MIC，处理周期性边界）
   *
   * 检测两类非物理几何：
   * - 原子重叠/穿越：键长过短（如 CG 外推产生的 C-H = 0.57 Å）
   * - 悬空原子：最近邻距离过远（> 3.0 Å），疑似脱离体系
   */
  private geometrySanity(struct: {
    atoms: { element: string; position: number[] }[];
    cell_parameters: number[][];
    coords_are_cartesian: boolean;
  }): { minDistance: number; issues: string[] } {
    const cell = struct.cell_parameters;
    // 转笛卡尔坐标
    const cart: number[][] = struct.atoms.map((a) => {
      if (struct.coords_are_cartesian) return [a.position[0], a.position[1], a.position[2]];
      const [fx, fy, fz] = a.position;
      return [
        fx * cell[0][0] + fy * cell[1][0] + fz * cell[2][0],
        fx * cell[0][1] + fy * cell[1][1] + fz * cell[2][1],
        fx * cell[0][2] + fy * cell[1][2] + fz * cell[2][2],
      ];
    });

    const n = cart.length;
    const issues: string[] = [];
    let globalMin = Infinity;
    const nearestOf = new Array<number>(n).fill(Infinity);

    // 27 个周期镜像平移
    const shifts: number[][] = [];
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++)
          shifts.push([
            a * cell[0][0] + b * cell[1][0] + c * cell[2][0],
            a * cell[0][1] + b * cell[1][1] + c * cell[2][1],
            a * cell[0][2] + b * cell[1][2] + c * cell[2][2],
          ]);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let minPair = Infinity;
        const dx = cart[i][0] - cart[j][0];
        const dy = cart[i][1] - cart[j][1];
        const dz = cart[i][2] - cart[j][2];
        for (const s of shifts) {
          const d = Math.sqrt((dx + s[0]) ** 2 + (dy + s[1]) ** 2 + (dz + s[2]) ** 2);
          if (d < minPair) minPair = d;
        }
        if (minPair < nearestOf[i]) nearestOf[i] = minPair;
        if (minPair < nearestOf[j]) nearestOf[j] = minPair;
        if (minPair < globalMin) globalMin = minPair;

        const ei = struct.atoms[i].element;
        const ej = struct.atoms[j].element;
        const hasH = ei === "H" || ej === "H";
        // 重叠/穿越：含 H 键 < 0.65 Å，重原子-重原子键 < 1.0 Å
        if (minPair < 0.65 || (!hasH && minPair < 1.0)) {
          issues.push(
            `${ei}(${i})-${ej}(${j}) 键长 ${minPair.toFixed(3)} Å 过短，疑似原子重叠/穿越（非物理）`
          );
        }
      }
    }

    // 悬空原子：最近邻 > 3.0 Å
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(nearestOf[i]) && nearestOf[i] > 3.0) {
        issues.push(
          `${struct.atoms[i].element}(${i}) 最近邻 ${nearestOf[i].toFixed(2)} Å 过远，疑似悬空原子`
        );
      }
    }

    return { minDistance: Number.isFinite(globalMin) ? globalMin : 0, issues: issues.slice(0, 8) };
  }

  /** 构建 NEB 结果展示 */
  private buildNebDisplay(results: Record<string, unknown>): string {
    const lines = [`📊 VASP NEB 结果\n━━━━━━━━━━━━━━━━━━━━━━`];

    if (results.activation_energy_forward_ev !== undefined) {
      lines.push(`• 活化能 (前向): ${(results.activation_energy_forward_ev as number).toFixed(4)} eV`);
      lines.push(`• 活化能 (反向): ${(results.activation_energy_backward_ev as number).toFixed(4)} eV`);
      lines.push(`• 反应能: ${(results.reaction_energy_ev as number).toFixed(4)} eV`);
      lines.push(`• 过渡态(climbing): image ${results.transition_state_image}`);
    }

    lines.push(`• Images: ${results.n_images} (共 ${results.n_total_dirs} 个目录)`);

    const converged = results.converged as boolean;
    const maxF = results.max_force_over_band_ev_ang as number | null;
    const tol = results.force_tol_ev_ang as number;
    lines.push(
      `• 力收敛: ${converged ? "✅ 全部达标" : "❌ 未达标"}` +
      (maxF !== null ? ` | band 最大力 ${maxF.toFixed(4)} / 阈值 ${tol} eV/Å` : "") +
      (results.nsw_limit_reached ? " | ⚠️ 撞 NSW 限位" : "")
    );

    // 能量 + 力路径表
    const relE = results.relative_energies_ev as number[] | undefined;
    const imageResults = results.image_results as Array<{
      dir: string; max_force_ev_ang: number | null; force_converged: boolean | null; is_climbing: boolean;
    }>;
    if (relE && relE.length > 0) {
      lines.push("");
      lines.push("image | ΔE(eV) | maxF(eV/Å) | 收敛 | 能量路径");
      for (let i = 0; i < relE.length; i++) {
        const ir = imageResults[i];
        const bar = relE[i] >= 0
          ? "█".repeat(Math.min(Math.round(relE[i] * 20), 40))
          : "░".repeat(Math.min(Math.round(Math.abs(relE[i]) * 20), 40));
        const f = ir.max_force_ev_ang;
        const fc = ir.force_converged === null ? "?" : ir.force_converged ? "✓" : "✗";
        lines.push(
          `  ${ir.dir}${ir.is_climbing ? "*" : " "} | ${relE[i] >= 0 ? "+" : ""}${relE[i].toFixed(3)} | ` +
          `${f !== null ? f.toFixed(3) : "  -  "} | ${fc} | ${bar}`
        );
      }
      lines.push("(* = climbing image / 能量最高点)");
    }

    const warnings = results.warnings as string[] | undefined;
    if (warnings && warnings.length > 0) {
      lines.push("");
      lines.push(...warnings);
    }

    return lines.join("\n");
  }

  /** 构建前端展示内容 */
  private buildDisplay(results: Record<string, unknown>, resultType: string): string {
    const lines = [`📊 VASP 结果提取 (${resultType})\n━━━━━━━━━━━━━━━━━━━━━━`];

    if (results.final_energy_ev !== undefined) {
      lines.push(`• 总能量: ${(results.final_energy_ev as number).toFixed(6)} eV`);
    }
    if (results.energy_sigma0_ev !== undefined) {
      lines.push(`• E(σ→0): ${(results.energy_sigma0_ev as number).toFixed(6)} eV`);
    }
    if (results.fermi_energy_ev !== undefined) {
      lines.push(`• 费米能: ${(results.fermi_energy_ev as number).toFixed(4)} eV`);
    }
    if (results.total_magnetization !== undefined) {
      lines.push(`• 总磁矩: ${(results.total_magnetization as number).toFixed(4)} μB`);
    }
    if (results.forces_max_ev_ang !== undefined) {
      const fc = results.force_converged;
      const tol = results.force_tol_ev_ang as number | undefined;
      lines.push(
        `• 最大力: ${(results.forces_max_ev_ang as number).toFixed(6)} eV/Å` +
        (tol !== undefined ? ` (阈值 ${tol})` : "") +
        (fc === true ? " ✅" : fc === false ? " ❌" : "")
      );
    }
    if (results.converged !== undefined) {
      lines.push(`• 收敛: ${results.converged ? "✅ 是" : "❌ 否"}`);
    }
    if (results.nsw_limit_reached === true) {
      lines.push(`• ⚠️ 已撞 NSW 限位（离子步 ${results.last_evaluated_step}/${results.nsw}）`);
    }
    const ionicShown = (results.total_ionic_steps as number | undefined) ?? (results.n_ionic_steps as number | undefined);
    if (ionicShown !== undefined) {
      lines.push(`• 离子步: ${ionicShown}`);
    }
    if (results.structure_data) {
      lines.push(`• 结构: 已从 CONTCAR 提取`);
    }

    const warnings = results.warnings as string[] | undefined;
    if (warnings && warnings.length > 0) {
      lines.push("");
      lines.push(...warnings);
    }

    return lines.join("\n");
  }
}
