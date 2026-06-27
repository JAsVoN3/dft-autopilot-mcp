# VASP 计算流程指南

## 1. 单点 SCF 计算

最基础的计算：给定结构和 k 点网格，求解电子 SCF 得到总能量。

**最小 INCAR**:
```
SYSTEM = SCF calculation
ENCUT = 400         # 截断能（取 ENMAX × 1.3）
EDIFF = 1E-6        # SCF 收敛精度
ALGO = Normal       # 小体系用 Normal，大体系用 Fast
PREC = Accurate     # 精确精度
ISMEAR = 0          # 半导体/绝缘体用 0；金属用 1
SIGMA = 0.05        # 展宽宽度
LORBIT = 11         # 输出分轨道 DOS
```

**所需文件**: INCAR, POSCAR, KPOINTS, POTCAR
**输出文件**: OUTCAR, OSZICAR, CONTCAR, CHGCAR, WAVECAR, DOSCAR

---

## 2. 结构优化（Relaxation）

### 2.1 固定晶格优化原子位置

```
SYSTEM = Relaxation (fixed cell)
ENCUT = 400
EDIFF = 1E-6
EDIFFG = -0.02       # 力收敛判据 (eV/Å)
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
NSW = 100            # 最大离子步
IBRION = 2           # CG 优化
ISIF = 2             # 仅优化原子位置
```

### 2.2 完全弛豫（含晶格）

```
SYSTEM = Full relaxation
ENCUT = 520          # 晶格优化需要更高 ENCUT
EDIFF = 1E-6
EDIFFG = -0.02
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
NSW = 200
IBRION = 2
ISIF = 3             # 优化原子位置 + 晶胞形状 + 体积
```

**⚠️ 注意**: 
- ISIF = 3 时必须使用较高 ENCUT（建议 1.5 × ENMAX 或 520+ eV）
- Pulay 应力：ENCUT 不够高会导致人为压力
- slab 模型**禁止 ISIF = 3**（真空层会坍缩）

---

## 3. 能带计算（Band Structure）

能带计算分两步：

### 步骤 1：SCF 计算获得收敛的 CHGCAR

```
# INCAR (Step 1: SCF)
ENCUT = 400
EDIFF = 1E-6
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
LCHARG = .TRUE.       # 必须输出 CHGCAR！
LWAVE = .FALSE.       # 可以不输出 WAVECAR
```
使用均匀 k 点网格的 KPOINTS 文件。

### 步骤 2：非自洽能带计算

```
# INCAR (Step 2: Band)
ENCUT = 400
EDIFF = 1E-6
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
ICHARG = 11           # 从 CHGCAR 读取，保持固定
LORBIT = 11           # 输出分轨道信息
LCHARG = .FALSE.
LWAVE = .FALSE.
```

KPOINTS 文件使用**高对称路径**（line-mode）：
```
K-Path
40          # 每段采样点数
line
reciprocal
  0.0000  0.0000  0.0000   ! Gamma
  0.5000  0.0000  0.5000   ! X

  0.5000  0.0000  0.5000   ! X
  0.5000  0.2500  0.7500   ! W

  0.5000  0.2500  0.7500   ! W
  0.5000  0.5000  0.5000   ! L

  0.5000  0.5000  0.5000   ! L
  0.0000  0.0000  0.0000   ! Gamma

  0.0000  0.0000  0.0000   ! Gamma
  0.3750  0.3750  0.7500   ! K
```

**关键**: 第二步必须使用第一步的 CHGCAR！

---

## 4. DOS 计算

DOS 通常基于 SCF 收敛的电荷密度进行非自洽计算。

```
# INCAR (DOS)
ENCUT = 400
EDIFF = 1E-6
ALGO = Normal
PREC = Accurate
ISMEAR = -5           # 四面体方法（精确 DOS）
SIGMA = 0.05
ICHARG = 11           # 从 CHGCAR 读取
LORBIT = 11           # 分轨道 DOS
NEDOS = 2001          # DOS 点数
EMIN = -10            # 可选：能量范围
EMAX = 10
```

KPOINTS 使用**更密的**均匀网格（如 SCF 用 8×8×8，DOS 用 12×12×12 或更密）。

---

## 5. Slab/表面计算

### 建模要点
- 真空层厚度 ≥ 12 Å（推荐 15-20 Å）
- slab 厚度 ≥ 4-5 层（视材料）
- 使用 Selective Dynamics 固定底层原子

### INCAR 模板
```
SYSTEM = Slab relaxation
ENCUT = 400
EDIFF = 1E-6
EDIFFG = -0.02
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
NSW = 200
IBRION = 2
ISIF = 2              # ⚠️ slab 必须用 2，不能用 3！
IDIPOL = 3            # 偶极校正（z 方向）
LDIPOL = .TRUE.       # 启用偶极校正
LVHAR = .TRUE.        # 输出静电势（可选）
```

### KPOINTS
- 面内 k 点密度与体相一致
- z 方向（真空方向）只需 1 个 k 点：如 `8 8 1`

---

## 6. 磁性计算

### 铁磁 (FM)
```
ISPIN = 2
MAGMOM = 4*5.0 4*0.0    # 例：4 个 Fe 原子 + 4 个 O 原子
```

### 反铁磁 (AFM)
```
ISPIN = 2
MAGMOM = 2*5.0 2*-5.0 4*0.0   # 2 上旋 Fe + 2 下旋 Fe + 4 个 O
```

### 非共线磁 (NCL)
使用 `vasp_ncl` 可执行文件：
```
ISPIN = 2
LNONCOLLINEAR = .TRUE.
MAGMOM = 0 0 5.0  0 0 5.0      # 每原子 3 个分量 (Sx Sy Sz)
LSORBIT = .TRUE.                 # 可选：自旋轨道耦合
```

---

## 7. DFT+U 计算

适用于强关联体系（含 d/f 电子的过渡金属氧化物等）。

```
SYSTEM = NiO with DFT+U
ENCUT = 520
EDIFF = 1E-6
ALGO = Normal
PREC = Accurate
ISMEAR = 0
SIGMA = 0.05
ISPIN = 2
MAGMOM = 2*2.0 2*0.6     # Ni: 2μB, O: 0.6μB

# DFT+U 设置
LDAU = .TRUE.
LDAUTYPE = 2              # Dudarev (U_eff = U - J)
LDAUL = 2 -1              # Ni: d 轨道, O: 无
LDAUU = 6.2 0.0           # Ni: U=6.2 eV (MP 值)
LDAUJ = 0.0 0.0
LMAXMIX = 4               # d 电子必须设 4
```
