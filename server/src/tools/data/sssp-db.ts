/**
 * SSSP 赝势数据库 — 双数据源架构
 *
 * 数据源 1: SSSP Efficiency v1.3.0 官方 JSON（经过严格收敛测试的推荐值）
 * 数据源 2: 本地 UPF 文件头解析（赝势开发者建议的最低截断能）
 *
 * Agent 同时获取两组数据，根据计算精度需求自行决策。
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// NOTE: ESM 环境需要手动构建 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SSSPEntry {
  filename: string;
  type: string;  // "PAW" | "US" | "NC"
  cutoff_wfc: number;
  cutoff_rho: number;
  mass: number;
}

/** SSSP 官方 JSON 条目结构 */
interface SSSPOfficialEntry {
  filename: string;
  md5: string;
  pseudopotential: string;
  cutoff_wfc: number;
  cutoff_rho: number;
}

// NOTE: 标准原子量表，用于补充 SSSP JSON 中缺失的质量数据
const ATOMIC_MASS: Record<string, number> = {
  H: 1.008, He: 4.003, Li: 6.941, Be: 9.012, B: 10.81, C: 12.011,
  N: 14.007, O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305,
  Al: 26.982, Si: 28.086, P: 30.974, S: 32.065, Cl: 35.453, Ar: 39.948,
  K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996,
  Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38,
  Ga: 69.723, Ge: 72.630, As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798,
  Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224, Nb: 92.906, Mo: 95.95,
  Ru: 101.07, Rh: 102.906, Pd: 106.42, Ag: 107.868, Cd: 112.414, In: 114.818,
  Sn: 118.710, Sb: 121.760, Te: 127.60, I: 126.904, Xe: 131.293,
  Cs: 132.905, Ba: 137.327, La: 138.906, Ce: 140.116, Hf: 178.49,
  Ta: 180.948, W: 183.84, Re: 186.207, Os: 190.23, Ir: 192.217, Pt: 195.084,
  Au: 196.967, Bi: 208.980, Pb: 207.2,
};

/** 缓存：SSSP 官方数据 */
let officialCache: Record<string, SSSPOfficialEntry> | null = null;

/** 缓存：本地 UPF 文件映射 */
let localCache: Record<string, SSSPEntry> | null = null;

/**
 * 加载 SSSP Efficiency v1.3.0 官方 JSON
 * 数据来源: https://www.materialscloud.org/discover/sssp/table/efficiency
 */
function loadOfficialDB(): Record<string, SSSPOfficialEntry> {
  if (officialCache) return officialCache;

  const jsonPath = join(__dirname, "sssp-efficiency-official.json");
  if (existsSync(jsonPath)) {
    try {
      officialCache = JSON.parse(readFileSync(jsonPath, "utf-8"));
      console.log(`[SSSP] 官方数据库加载成功: ${Object.keys(officialCache!).length} 元素`);
      return officialCache!;
    } catch (e) {
      console.warn(`[SSSP] 官方数据库解析失败: ${e}`);
    }
  } else {
    console.warn(`[SSSP] 官方数据库不存在: ${jsonPath}`);
  }
  officialCache = {};
  return officialCache;
}

/**
 * 扫描本地赝势目录，解析 UPF 文件头获取截断能
 * 这是赝势开发者在文件中写入的建议最低截断能
 */
function loadLocalDB(pseudoDir: string): Record<string, SSSPEntry> {
  if (localCache) return localCache;

  localCache = {};
  if (!existsSync(pseudoDir)) return localCache;

  const files = readdirSync(pseudoDir).filter(f => f.endsWith(".UPF") || f.endsWith(".upf"));

  for (const f of files) {
    // NOTE: SSSP 赝势命名有两种格式:
    //   旧版: Co.pbe-spn-kjpaw_psl.1.0.0.UPF → 用 '.' 分割取首段
    //   新版: Co_pbe_v1.2.uspp.F.UPF → 用 '_' 分割取首段
    // 需要同时兼容两种格式
    const dotPart = f.split(".")[0];       // "Co" 或 "Co_pbe_v1"
    const elem = dotPart.split("_")[0];    // 再用 '_' 分割确保得到纯元素名
    // NOTE: 元素名首字母大写标准化
    const normalizedElem = elem.charAt(0).toUpperCase() + elem.slice(1).toLowerCase();

    try {
      const filepath = join(pseudoDir, f);
      const header = readFileSync(filepath, { encoding: "utf-8", flag: "r" }).slice(0, 3000);

      let wfc: number | null = null;
      let rho: number | null = null;

      const wfcMatch = header.match(/Suggested minimum cutoff for wavefunctions:\s*([\d.]+)/);
      if (wfcMatch) wfc = parseFloat(wfcMatch[1]);

      const rhoMatch = header.match(/Suggested minimum cutoff for charge density:\s*([\d.]+)/);
      if (rhoMatch) rho = parseFloat(rhoMatch[1]);

      const ppType = header.slice(0, 500).includes("PAW") ? "PAW" : "US";

      localCache[normalizedElem] = {
        filename: f,
        type: ppType,
        cutoff_wfc: wfc ?? 50,
        cutoff_rho: rho ?? 400,
        mass: ATOMIC_MASS[normalizedElem] ?? 1.0,
      };
    } catch {
      // 跳过无法读取的文件
    }
  }

  console.log(`[SSSP] 本地赝势扫描完成: ${Object.keys(localCache).length} 个 UPF 文件`);
  return localCache;
}

/**
 * 获取元素赝势信息（优先本地文件，截断能取两个源的较高值）
 *
 * NOTE: 返回的截断能是 max(SSSP官方, UPF文件头)，确保计算安全
 */
export function getPseudo(element: string, pseudoDir?: string): SSSPEntry | null {
  const official = loadOfficialDB();
  const local = pseudoDir ? loadLocalDB(pseudoDir) : {};

  const localEntry = local[element];
  const officialEntry = official[element];

  if (localEntry) {
    // 如果有官方数据，取两者的较高截断能
    if (officialEntry) {
      return {
        ...localEntry,
        cutoff_wfc: Math.max(localEntry.cutoff_wfc, officialEntry.cutoff_wfc),
        cutoff_rho: Math.max(localEntry.cutoff_rho, officialEntry.cutoff_rho),
      };
    }
    return localEntry;
  }

  // 没有本地文件但有官方数据
  if (officialEntry) {
    return {
      filename: officialEntry.filename,
      type: officialEntry.pseudopotential.includes("PAW") ? "PAW" : "US",
      cutoff_wfc: officialEntry.cutoff_wfc,
      cutoff_rho: officialEntry.cutoff_rho,
      mass: ATOMIC_MASS[element] ?? 1.0,
    };
  }

  return null;
}

/**
 * 获取多元素体系的最大截断能
 * NOTE: QE 要求所有原子使用同一截断能，取各元素最大值
 */
export function getMaxCutoffs(elements: string[], pseudoDir?: string): [number, number] {
  let maxWfc = 30.0;
  let maxRho = 240.0;
  for (const el of elements) {
    const info = getPseudo(el, pseudoDir);
    if (info) {
      maxWfc = Math.max(maxWfc, info.cutoff_wfc);
      maxRho = Math.max(maxRho, info.cutoff_rho);
    }
  }
  return [maxWfc, maxRho];
}

/**
 * 获取多元素的赝势信息列表（供 ATOMIC_SPECIES 卡使用）
 *
 * NOTE: 只返回本地实际存在的赝势文件信息，确保 QE 运行时文件可用
 */
export function getSpeciesInfo(
  elements: string[],
  pseudoDir?: string,
): Array<{ element: string; mass: number; pseudo_file: string }> {
  const seen = new Set<string>();
  const species: Array<{ element: string; mass: number; pseudo_file: string }> = [];

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);
    const info = getPseudo(el, pseudoDir);
    if (info) {
      species.push({ element: el, mass: info.mass, pseudo_file: info.filename });
    } else {
      console.warn(`[SSSP] ${el} 无赝势数据，使用默认`);
      species.push({ element: el, mass: ATOMIC_MASS[el] ?? 1.0, pseudo_file: `${el}.UPF` });
    }
  }
  return species;
}

/**
 * 获取双源详细信息（供 Agent 决策参考）
 */
export function getDetailedInfo(element: string, pseudoDir?: string): {
  official: { filename: string; cutoff_wfc: number; cutoff_rho: number; library: string } | null;
  local: { filename: string; cutoff_wfc: number; cutoff_rho: number; type: string } | null;
  recommended: { cutoff_wfc: number; cutoff_rho: number };
} {
  const official = loadOfficialDB()[element];
  const local = pseudoDir ? loadLocalDB(pseudoDir)[element] : null;

  const recWfc = Math.max(official?.cutoff_wfc ?? 0, local?.cutoff_wfc ?? 0) || 50;
  const recRho = Math.max(official?.cutoff_rho ?? 0, local?.cutoff_rho ?? 0) || 400;

  return {
    official: official ? {
      filename: official.filename,
      cutoff_wfc: official.cutoff_wfc,
      cutoff_rho: official.cutoff_rho,
      library: official.pseudopotential,
    } : null,
    local: local ? {
      filename: local.filename,
      cutoff_wfc: local.cutoff_wfc,
      cutoff_rho: local.cutoff_rho,
      type: local.type,
    } : null,
    recommended: { cutoff_wfc: recWfc, cutoff_rho: recRho },
  };
}

/** 获取所有可用元素（合并两个源） */
export function getAvailableElements(pseudoDir?: string): string[] {
  const official = new Set(Object.keys(loadOfficialDB()));
  const local = pseudoDir ? new Set(Object.keys(loadLocalDB(pseudoDir))) : new Set<string>();
  return [...new Set([...official, ...local])].sort();
}

// NOTE: SSSP Efficiency 赝势对应的价电子数（纯物理常数，不会变更）
// 用于自动计算 nbnd，确保 bands/nscf/dos 计算包含足够导带（Bug #6 修复）
const Z_VALENCE: Record<string, number> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 3, C: 4,
  N: 5, O: 6, F: 7, Ne: 8, Na: 9, Mg: 10,
  Al: 3, Si: 4, P: 5, S: 6, Cl: 7, Ar: 8,
  K: 9, Ca: 10, Sc: 11, Ti: 12, V: 13, Cr: 14,
  Mn: 15, Fe: 16, Co: 17, Ni: 18, Cu: 19, Zn: 20,
  Ga: 13, Ge: 14, As: 5, Se: 6, Br: 7, Kr: 8,
  Rb: 9, Sr: 10, Y: 11, Zr: 12, Nb: 13, Mo: 14,
  Ru: 16, Rh: 17, Pd: 18, Ag: 19, Cd: 12, In: 13,
  Sn: 14, Sb: 5, Te: 6, I: 7, Xe: 8,
  Cs: 9, Ba: 10, La: 11, Ce: 12, Hf: 12,
  Ta: 13, W: 14, Re: 15, Os: 8, Ir: 17, Pt: 18,
  Au: 11, Pb: 14, Bi: 15,
};

/**
 * 获取单个元素的价电子数
 * 优先查 Z_VALENCE 表，未收录的元素返回保守估计值 6
 */
export function getValenceElectrons(element: string): number {
  return Z_VALENCE[element] ?? 6;
}

/**
 * 计算体系总价电子数
 * @param elements 元素列表（含重复，如 ["Ni", "Ni", "O", "O"]）
 * @param totCharge 总电荷（正=失电子，负=得电子），默认 0
 */
export function getTotalValenceElectrons(elements: string[], totCharge = 0): number {
  const total = elements.reduce((sum, el) => sum + getValenceElectrons(el), 0);
  return total - totCharge;
}
