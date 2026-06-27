/**
 * search_materials — 材料科学数据库搜索工具
 *
 * 接入 Materials Project + OQMD，帮助 Agent 查询已有的 DFT 计算结果：
 * - 晶体结构参数（晶格常数、空间群）
 * - 电子性质（能带间隙、磁矩）
 * - 热力学性质（形成能、稳定性）
 *
 * 核心价值：Agent 可以用这些数据验证自己的计算结果是否合理，
 * 或在建模前获取参考结构。
 *
 * 数据源优先级：Materials Project → AFLOW → OQMD（三级降级）
 */

import { DFTTool, type ToolResult } from "./base.js";
import { appConfig } from "../config.js";

const API_TIMEOUT_MS = 20000;
const MAX_RESULTS_LIMIT = 10;

interface MaterialResult {
  materialId: string;
  formula: string;
  spaceGroup: string | null;
  bandGap: number | null;
  formationEnergy: number | null;
  magneticMoment: number | null;
  volume: number | null;
  nsites: number | null;
  isStable: boolean | null;
  /** 相对凸包的能量（eV/atom），0 = 最稳定 */
  eAboveHull: number | null;
  source: string;
}

export class SearchMaterialsTool extends DFTTool {
  readonly name = "search_materials";
  readonly description =
    "在材料科学数据库中搜索已有的 DFT 计算结果。" +
    "数据源: Materials Project + AFLOW + OQMD（三级降级，覆盖数百万材料）。" +
    "可获取：晶体结构、能带间隙、形成能、磁矩、空间群等。" +
    "适用场景：获取参考结构、验证计算结果、查找已知材料的性质数据。" +
    "支持按化学式或化学体系（元素组合）搜索。";

  readonly inputSchema = {
    type: "object",
    properties: {
      formula: {
        type: "string",
        description:
          "化学式搜索，如 'CoN4'、'Fe2O3'、'LiFePO4'。" +
          "也支持通配符如 'Co*N*' 用于模糊匹配。",
      },
      chemsys: {
        type: "string",
        description:
          "化学体系搜索（元素组合，用 '-' 分隔），如 'Co-N-C'、'Li-Fe-P-O'。" +
          "搜索该元素组合下的所有已知材料。与 formula 二选一。",
      },
      max_results: {
        type: "integer",
        description: "最大返回数量（默认 5，最大 10）",
      },
      band_gap_max: {
        type: "number",
        description: "能带间隙上限过滤（eV），用于筛选金属/半导体",
      },
      is_stable: {
        type: "boolean",
        description: "仅返回热力学稳定的材料（位于凸包上）",
      },
    },
    // NOTE: formula 和 chemsys 至少提供一个
    required: [],
  };

  get isReadOnly() {
    return true;
  }

  validateInput(args: Record<string, unknown>): string | null {
    const formula = args.formula as string | undefined;
    const chemsys = args.chemsys as string | undefined;
    if (!formula?.trim() && !chemsys?.trim()) {
      return "formula 或 chemsys 至少提供一个";
    }
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const formula = args.formula as string | undefined;
    const chemsys = args.chemsys as string | undefined;
    const maxResults = Math.min(
      (args.max_results as number) ?? 5,
      MAX_RESULTS_LIMIT,
    );
    const bandGapMax = args.band_gap_max as number | undefined;
    const isStable = args.is_stable as boolean | undefined;

    // NOTE: 三级降级链：Materials Project → AFLOW → OQMD
    const sources: Array<{
      name: string;
      fn: () => Promise<MaterialResult[]>;
    }> = [
      {
        name: "Materials Project",
        fn: () => this.searchMaterialsProject(formula, chemsys, maxResults, bandGapMax, isStable),
      },
      {
        name: "AFLOW",
        fn: () => this.searchAFLOW(formula, chemsys, maxResults),
      },
      {
        name: "OQMD",
        fn: () => this.searchOQMD(formula, chemsys, maxResults),
      },
    ];

    let materials: MaterialResult[] = [];
    let dataSource = "";
    const errors: string[] = [];

    for (const src of sources) {
      try {
        materials = await src.fn();
        dataSource = src.name;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${src.name}: ${msg.slice(0, 60)}`);
        console.warn(`[search_materials] ${src.name} 失败: ${msg}`);
      }
    }

    const queryLabel = formula ?? chemsys ?? "";

    // 全部失败
    if (!dataSource) {
      return {
        success: true,
        data: {
          query: queryLabel,
          results: [],
          note:
            `三个材料数据库均不可用。${errors.join("; ")}。` +
            `请使用 search_knowledge（本地 RAG）中的参考数据。`,
        },
      };
    }

    return {
      success: true,
      data: {
        query: queryLabel,
        data_source: dataSource,
        n_results: materials.length,
        results: materials,
        ...(errors.length > 0
          ? { fallback_note: `前置数据源不可用 (${errors.join("; ")})，已降级到 ${dataSource}` }
          : {}),
      },
      display:
        materials.length > 0
          ? `🔬 材料搜索: ${materials.length} 种材料 [${dataSource}] (${queryLabel})`
          : `🔬 材料搜索: 无结果 (${queryLabel})`,
    };
  }

  // ---------------------------------------------------------------------------
  // Materials Project API v3
  // https://api.materialsproject.org/docs
  // ---------------------------------------------------------------------------

  private async searchMaterialsProject(
    formula?: string,
    chemsys?: string,
    limit = 5,
    bandGapMax?: number,
    isStable?: boolean,
  ): Promise<MaterialResult[]> {
    if (!appConfig.mpApiKey) {
      throw new Error("MP_API_KEY 未配置");
    }

    const params = new URLSearchParams({
      _limit: String(limit),
      _fields:
        "material_id,formula_pretty,symmetry,band_gap," +
        "formation_energy_per_atom,total_magnetization," +
        "volume,nsites,is_stable,energy_above_hull",
    });

    if (formula) params.set("formula", formula);
    if (chemsys) params.set("chemsys", chemsys);
    if (bandGapMax !== undefined) params.set("band_gap_max", String(bandGapMax));
    if (isStable === true) params.set("is_stable", "true");

    // NOTE: 如果配置了 MP_PROXY_URL，请求走本地中继绕过 ASN 封禁
    const baseUrl = appConfig.mpProxyUrl || "https://api.materialsproject.org";
    const url = `${baseUrl}/materials/summary/?${params}`;

    const response = await fetch(url, {
      headers: {
        "X-API-KEY": appConfig.mpApiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `MP API ${response.status}: ${await response.text().catch(() => "")}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{
        material_id?: string;
        formula_pretty?: string;
        symmetry?: { symbol?: string };
        band_gap?: number;
        formation_energy_per_atom?: number;
        total_magnetization?: number;
        volume?: number;
        nsites?: number;
        is_stable?: boolean;
        energy_above_hull?: number;
      }>;
    };

    if (!data.data) return [];

    // NOTE: Bug #9 修复 — 按 e_above_hull 升序排序，确保最稳定相（如 GaAs F-43m）排在最前面
    const results = data.data.map((m) => ({
      materialId: m.material_id ?? "unknown",
      formula: m.formula_pretty ?? "unknown",
      spaceGroup: m.symmetry?.symbol ?? null,
      bandGap: m.band_gap ?? null,
      formationEnergy: m.formation_energy_per_atom ?? null,
      magneticMoment: m.total_magnetization ?? null,
      volume: m.volume ?? null,
      nsites: m.nsites ?? null,
      isStable: m.is_stable ?? null,
      eAboveHull: m.energy_above_hull ?? null,
      source: "Materials Project",
    }));
    results.sort((a, b) => (a.eAboveHull ?? Infinity) - (b.eAboveHull ?? Infinity));
    return results;
  }

  // ---------------------------------------------------------------------------
  // OQMD REST API（降级备选）
  // http://oqmd.org/oqmdapi/
  // ---------------------------------------------------------------------------

  private async searchOQMD(
    formula?: string,
    chemsys?: string,
    limit = 5,
  ): Promise<MaterialResult[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      fields: "name,entry_id,spacegroup,band_gap,delta_e,volume,natoms",
    });

    // NOTE: OQMD 使用 element_set 过滤，不支持 composition 关键字
    // 需要从化学式中提取元素符号
    if (formula) {
      const elements = this.extractElements(formula);
      params.set("filter", `element_set=(${elements.join(",")})`);
    } else if (chemsys) {
      const elements = chemsys.split("-").map((e) => e.trim());
      params.set("filter", `element_set=(${elements.join(",")})`);
    }

    const url = `http://oqmd.org/oqmdapi/formationenergy?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `OQMD API ${response.status}: ${await response.text().catch(() => "")}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{
        name?: string;
        entry_id?: number;
        spacegroup?: string;
        band_gap?: number;
        delta_e?: number;
        volume?: number;
        natoms?: number;
      }>;
    };

    if (!data.data) return [];

    return data.data.map((m) => ({
      materialId: `oqmd-${m.entry_id ?? "?"}`,
      formula: m.name ?? "unknown",
      spaceGroup: m.spacegroup ?? null,
      bandGap: m.band_gap ?? null,
      formationEnergy: m.delta_e ?? null,
      magneticMoment: null, // OQMD API 不直接返回磁矩
      volume: m.volume ?? null,
      nsites: m.natoms ?? null,
      isStable: null, // OQMD 不直接提供稳定性标记
      eAboveHull: null, // OQMD 不直接返回 e_above_hull
      source: "OQMD",
    }));
  }

  /**
   * 从化学式中提取元素符号
   *
   * "Fe2O3" → ["Fe", "O"]
   * "LiFePO4" → ["Li", "Fe", "P", "O"]
   */
  private extractElements(formula: string): string[] {
    // 匹配大写字母开头、可选跟一个小写字母的模式
    const matches = formula.match(/[A-Z][a-z]?/g);
    if (!matches) return [];
    // 去重
    return [...new Set(matches)];
  }

  // ---------------------------------------------------------------------------
  // AFLOW AFLUX API（第 2 降级源）
  // https://aflow.org/API/aflux/
  // NOTE: 无需 API Key，使用 URI 查询语法
  // ---------------------------------------------------------------------------

  private async searchAFLOW(
    formula?: string,
    chemsys?: string,
    limit = 5,
  ): Promise<MaterialResult[]> {
    // NOTE: AFLUX 使用 species() 过滤元素，matchbook 语法用逗号分隔条件
    let elements: string[];
    if (formula) {
      elements = this.extractElements(formula);
    } else if (chemsys) {
      elements = chemsys.split("-").map((e) => e.trim());
    } else {
      throw new Error("需要 formula 或 chemsys");
    }

    // 构建 AFLUX matchbook 查询
    // NOTE: Bug #3 修复 — 使用 nspecies() 约束元素种类数，避免返回无关化合物
    // 例如搜 Si 时不会返回 Ag1As2Si1（3种元素）
    const speciesFilter = `species(${elements.join(",")})`;
    const nspeciesFilter = `nspecies(${elements.length})`;
    const fields =
      "auid,compound,spacegroup_relax,Egap,enthalpy_formation_atom,spin_atom,volume_atom,natoms";
    const matchbook =
      `${speciesFilter},${nspeciesFilter},${fields},paging(${limit}),format(json)`;

    const url = `https://aflow.org/API/aflux/?${matchbook}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`AFLOW API ${response.status}`);
    }

    // NOTE: AFLOW 返回的是 { "1 of N": {...}, "2 of N": {...} } 格式的对象，不是数组
    const raw = await response.json() as Record<string, {
      auid?: string;
      compound?: string;
      spacegroup_relax?: string | number;
      Egap?: number;
      enthalpy_formation_atom?: number;
      spin_atom?: number;
      volume_atom?: number;
      natoms?: number;
    }>;

    const entries = Object.values(raw);
    if (entries.length === 0) return [];

    // NOTE: Bug #3 修复 — 结果后处理：验证化合物确实只包含目标元素
    const targetElements = new Set(elements);
    return entries
      .filter((m) => {
        if (!m.compound) return true;
        const compElements = this.extractElements(m.compound);
        return compElements.every((el) => targetElements.has(el));
      })
      .slice(0, limit)
      .map((m) => ({
        materialId: m.auid ?? "unknown",
        formula: m.compound ?? "unknown",
        spaceGroup: m.spacegroup_relax != null ? String(m.spacegroup_relax) : null,
        bandGap: m.Egap ?? null,
        formationEnergy: m.enthalpy_formation_atom ?? null,
        magneticMoment: m.spin_atom ?? null,
        volume: m.volume_atom ?? null,
        nsites: m.natoms ?? null,
        isStable: null, // AFLOW 不直接返回稳定性标记
        eAboveHull: null, // AFLOW 不直接返回 e_above_hull
        source: "AFLOW",
      }));
  }
}
