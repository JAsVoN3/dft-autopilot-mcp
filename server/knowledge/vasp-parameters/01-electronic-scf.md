# VASP INCAR 参数：电子结构 SCF 计算

来源：VASP Wiki (https://www.vasp.at/wiki/) — GNU FDL 1.2

## ENCUT — 平面波截断能 (eV)

**默认值**: 取自 POTCAR 中所有元素 ENMAX 的最大值

ENCUT 指定平面波基组的能量截断，单位 eV。所有动能小于 ENCUT 的平面波被包含在基组中。

**关键规则**:
- POTCAR 中包含默认 ENMAX，但**强烈建议在 INCAR 中显式指定 ENCUT**
- 不显式指定时，不同计算（如计算内聚能时原子和体相）可能使用不同默认 ENMAX，导致能量不可比较
- 通常取 ENMAX 的 1.3~1.5 倍作为 ENCUT
- 必须进行 ENCUT 收敛性测试

**推荐值**:
| 体系类型 | ENCUT 倍率 | 典型值 |
|----------|-----------|--------|
| 简单金属/半导体 | 1.3 × ENMAX | 300-400 eV |
| 含 O/N/F 等第一行元素 | 1.3-1.5 × ENMAX | 400-520 eV |
| slab/表面计算 | 1.3 × ENMAX | 同体相 |
| 高精度（EOS 拟合） | 1.5 × ENMAX | 500+ eV |

**相关参数**: ENMAX, ENMIN, ENAUG, PREC

---

## EDIFF — 电子 SCF 收敛判据 (eV)

**默认值**: 1E-4

EDIFF 指定电子自洽计算（SCF loop）的总能量收敛判据。当连续两次 SCF 迭代的总能量变化小于 EDIFF 时，SCF 被认为收敛。

**推荐值**:
| 计算类型 | EDIFF | 说明 |
|----------|-------|------|
| 结构优化 | 1E-6 | 需要精确的力 |
| 单点 SCF | 1E-5 ~ 1E-6 | 标准精度 |
| 分子动力学 | 1E-5 | 速度优先 |
| 能带/DOS | 1E-6 | 需要精确本征值 |
| 高精度（声子/弹性常数） | 1E-8 | 极高精度 |

**注意事项**:
- EDIFF 过大会导致力不准确，结构优化震荡
- EDIFF 过小（< 1E-8）通常没有物理意义，浪费计算资源
- 结构优化时 EDIFF 应至少比 EDIFFG 小 2-3 个数量级

---

## ALGO — 电子最小化算法

**默认值**: Normal

控制电子自洽迭代的算法。

| ALGO 值 | 算法 | 适用场景 |
|---------|------|---------|
| Normal | DAV (blocked Davidson) | 小中体系，最稳定 |
| Fast | DAV + RMM-DIIS 混合 | 大体系首选，速度快 |
| VeryFast | 纯 RMM-DIIS | 最快，但可能不稳定 |
| All | DAV + 共轭梯度 | 对初始波函数质量差的情况有效 |
| Damped | 阻尼速度淬灭 MD | 难收敛体系，如 slab/分子 |

**推荐选择**:
- 小体系 (< 20 原子): `ALGO = Normal`
- 中大体系 (20-100 原子): `ALGO = Fast`
- 表面/slab/困难体系: `ALGO = Damped` + `TIME = 0.05`
- 杂化泛函: `ALGO = All` 或 `ALGO = Damped`

---

## PREC — 精度控制

**默认值**: Normal

控制 VASP 内部若干精度相关设置（FFT 网格、PAW 参数等）。

| PREC 值 | 说明 |
|---------|------|
| Low | 较低精度，快速测试 |
| Medium | 中等精度 |
| Normal | 标准精度（推荐日常使用） |
| Accurate | 高精度（推荐发表计算） |
| Single | 单精度算术（节省内存） |

**关键影响**:
- PREC 影响 FFT 网格密度、wrap-around error 修正、charge density 插值
- PREC = Accurate 时 ENCUT 取 ENMAX（而非 ENMAX × 0.9）
- 发表级计算应始终使用 `PREC = Accurate`

---

## ISMEAR — 展宽方法

**默认值**: 1

控制部分占据数的展宽方法和占据函数类型。

| ISMEAR 值 | 方法 | 适用体系 |
|-----------|------|---------|
| -5 | 四面体方法 + Blöchl 修正 | DOS/精确总能量（需 ≥ 4个 k 点） |
| -4 | 四面体方法（无修正） | 不推荐 |
| -1 | Fermi 展宽 | 金属（有限温度 DFT） |
| 0 | Gaussian 展宽 | 半导体/绝缘体/分子 |
| 1, 2, ... | Methfessel-Paxton 1阶/2阶 | 金属（力、结构优化） |

**推荐规则**:
- **半导体/绝缘体**: `ISMEAR = 0; SIGMA = 0.05`
- **金属 SCF/Relax**: `ISMEAR = 1; SIGMA = 0.2`
- **金属精确 DOS**: `ISMEAR = -5`（仅限足够 k 点网格）
- **分子/原子**: `ISMEAR = 0; SIGMA = 0.01`
- **⚠️ 禁止对金属使用 ISMEAR = -5 进行结构优化**

---

## SIGMA — 展宽宽度 (eV)

**默认值**: 0.2

与 ISMEAR 配合使用，指定展宽宽度。

**规则**: 选择 SIGMA 使 `entropy T*S`（OUTCAR 中可查）每原子 < 1 meV。
- SIGMA 过大: 总能量不准确
- SIGMA 过小: SCF 收敛困难

---

## LREAL — 实空间投影

**默认值**: .FALSE.

控制非局域投影算子是在倒空间还是实空间评估。

| LREAL 值 | 说明 |
|----------|------|
| .FALSE. | 倒空间（精确，小体系推荐） |
| Auto | 自动选择实空间（大体系推荐） |
| .TRUE. | 强制实空间 |

**推荐**:
- 原子数 < 20: `LREAL = .FALSE.`
- 原子数 ≥ 20: `LREAL = Auto`

---

## LORBIT — 分轨道投影 DOS

**默认值**: None（不输出 PROCAR/DOSCAR 分轨道数据）

| LORBIT 值 | 输出 | 需要 RWIGS？ |
|-----------|------|:----------:|
| 0 | DOSCAR + PROCAR（l 分解） | 是 |
| 1 | DOSCAR + PROCAR（lm 分解） | 是 |
| 2 | DOSCAR + PROCAR（lm + 相位因子） | 是 |
| 10 | DOSCAR + PROCAR（l 分解） | 否 |
| 11 | DOSCAR + PROCAR（lm 分解） | 否 |
| 12 | DOSCAR + PROCAR（lm + 相位因子） | 否 |
| 14 | 与 11 类似，增强的 Cartesian 分量 | 否 |

**推荐**: `LORBIT = 11`（最常用，无需 RWIGS）

---

## NEDOS — DOS 点数

**默认值**: 301

指定 DOSCAR 文件中的能量网格点数。

**推荐**: DOS 计算时设 `NEDOS = 2001` 或更高以获得平滑的态密度曲线。

---

## ICHARG — 初始电荷密度

**默认值**: 取决于 ISTART

| ICHARG 值 | 来源 | 典型用途 |
|-----------|------|---------|
| 0 | 从初始波函数构造 | ISTART > 0 时默认 |
| 1 | 从 CHGCAR 读取 | 续算 |
| 2 | 从原子电荷密度叠加 | 全新计算（ISTART = 0 时默认） |
| 11 | 从 CHGCAR 读取，保持固定 | 非自洽能带计算 |

**能带计算关键**: `ICHARG = 11` + CHGCAR（来自先前 SCF 计算）
