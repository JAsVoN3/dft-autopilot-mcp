# VASP 常见问题排查

## 1. SCF 不收敛

### 症状
OSZICAR 中电子能量震荡不收敛，达到 NELM 上限。

### 排查步骤

| 步骤 | 操作 | INCAR 修改 |
|------|------|-----------|
| 1 | 降低 POTIM | `POTIM = 0.1` |
| 2 | 换算法 | `ALGO = All` 或 `ALGO = Damped; TIME = 0.05` |
| 3 | 增加混合参数 | `AMIX = 0.1; BMIX = 0.001` |
| 4 | 增大 NELM | `NELM = 200` |
| 5 | 检查 ISMEAR/SIGMA | 金属：`ISMEAR = 1; SIGMA = 0.2` |
| 6 | 检查初始结构 | 原子是否太近？（键长 < 1 Å） |

### 特定体系建议
- **磁性体系**: 尝试不同初始 MAGMOM
- **slab/表面**: `ALGO = Damped; TIME = 0.05`
- **杂化泛函**: `ALGO = All; TIME = 0.4`
- **含 f 电子**: `LMAXMIX = 6`

---

## 2. 结构优化不收敛

### 症状
离子步达到 NSW 上限但力未收敛。

### 排查步骤
1. **检查 EDIFFG**: 是否太严格？先用 `-0.05` 测试
2. **减小 POTIM**: `POTIM = 0.2` 或更小
3. **换优化器**: `IBRION = 1`（准牛顿法）→ `IBRION = 2`（CG）
4. **检查 ISIF**: slab 不能用 ISIF=3
5. **增大 ENCUT**: 晶格优化时 Pulay 应力可能导致问题
6. **预弛豫**: 先用低精度粗优化，再用高精度精细优化

---

## 3. "internal error in subroutine SGRCON" / 对称性错误

### 原因
POSCAR 中的原子坐标与声称的空间群不完全一致。

### 解决方案
```
ISYM = 0     # 关闭对称性（最简单但最慢）
SYMPREC = 1E-4   # 放宽对称性容差（推荐）
```

---

## 4. "BRMIX: very serious problems"

### 原因
电荷密度混合出现严重问题，通常见于磁性体系或 DFT+U。

### 解决方案
```
ALGO = All
AMIX = 0.1
BMIX = 0.001
AMIX_MAG = 0.2    # 磁性混合参数
BMIX_MAG = 0.001
```

---

## 5. 负频率 / 虚频

### 原因
结构优化未充分收敛，或体系处于鞍点。

### 排查步骤
1. 用更严格的 EDIFFG 重新优化
2. 沿虚频模式方向微扰结构，重新优化
3. 增大 k 点网格
4. 检查 ENCUT 是否足够

---

## 6. "Sub-Space-Matrix is not hermitian" / "ZHEGV"

### 原因
通常是 POTCAR 与 POSCAR 元素不匹配，或 POTCAR 顺序错误。

### 检查
- POTCAR 中元素顺序是否与 POSCAR 元素行一致
- POTCAR 文件是否完整（未被截断）
- 重新生成 POTCAR: `cat El1/POTCAR El2/POTCAR > POTCAR`

---

## 7. VASP 输出文件说明

| 文件 | 内容 | 主要用途 |
|------|------|---------|
| OUTCAR | 完整计算日志 | 查能量、力、应力、收敛信息 |
| OSZICAR | 每步能量摘要 | 快速查看收敛历史 |
| CONTCAR | 优化后结构 | 续算/分析用 |
| CHGCAR | 电荷密度 | 能带计算、电荷分析 |
| WAVECAR | 波函数 | 续算 |
| DOSCAR | 态密度 | DOS 图 |
| EIGENVAL | 本征值 | 能带图 |
| PROCAR | 分轨道投影 | 分轨道能带/DOS |
| vasprun.xml | XML 格式完整输出 | pymatgen 解析 |
| XDATCAR | MD 轨迹 | 分子动力学分析 |

---

## 8. KPOINTS 文件格式

### 均匀网格（Monkhorst-Pack / Gamma）
```
Automatic mesh
0            # 0 表示自动生成
Gamma        # 或 Monkhorst-Pack
8 8 8        # kx ky kz 网格密度
0 0 0        # 平移（通常 0 0 0）
```

### k 点密度推荐
| 体系 | k 点密度 (kppa) | 示例 (FCC 原胞) |
|------|:---------------:|:--------------:|
| 粗测试 | ~500 | 4×4×4 |
| 标准 | ~1000 | 6×6×6 |
| 精确 | ~2000 | 8×8×8 |
| DOS/光学 | ~4000+ | 12×12×12 |

### 高对称路径（能带计算）
```
K-Path
40         # 每段点数
line
reciprocal
 0.0  0.0  0.0   GAMMA
 0.5  0.0  0.5   X
               
 0.5  0.0  0.5   X
 0.5  0.5  0.5   L
```

**常见晶系高对称点**:
- FCC: Γ-X-W-L-Γ-K
- BCC: Γ-H-N-Γ-P
- HCP: Γ-M-K-Γ-A-L-H-A
- 简单立方: Γ-X-M-Γ-R-X
