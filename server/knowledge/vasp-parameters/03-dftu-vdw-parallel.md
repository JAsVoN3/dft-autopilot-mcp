# VASP INCAR 参数：DFT+U / 范德华修正 / 并行

来源：VASP Wiki (https://www.vasp.at/wiki/) — GNU FDL 1.2

## LDAU — DFT+U 校正

VASP 支持 DFT+U 方法来校正强关联体系（如过渡金属氧化物）中 d/f 电子的自相互作用误差。

### 相关 INCAR 标签

| 参数 | 说明 | 典型值 |
|------|------|--------|
| LDAU | 启用 DFT+U | .TRUE. |
| LDAUTYPE | U 参数类型 | 2（Dudarev 简化形式，最常用） |
| LDAUL | 各元素 l 量子数 | -1(无), 0(s), 1(p), 2(d), 3(f) |
| LDAUU | U 参数 (eV) | 视元素 |
| LDAUJ | J 参数 (eV) | 通常 0 |
| LDAUPRINT | 占据矩阵输出级别 | 0(少), 1(中), 2(详细) |
| LMAXMIX | 混合矩阵最大 l | d 元素: 4; f 元素: 6 |

### Dudarev 方法（LDAUTYPE=2，推荐）

有效 U_eff = U - J，只需指定一个参数。

**配置示例** — FeO (Fe: U=4.0, O: 无):
```
LDAU = .TRUE.
LDAUTYPE = 2
LDAUL = 2 -1      ! Fe: d 轨道, O: 无 U
LDAUU = 4.0 0.0   ! Fe: U=4.0, O: 0
LDAUJ = 0.0 0.0   ! J 通常设 0
LMAXMIX = 4       ! d 元素必须设 4
```

**常见 U 值参考** (Dudarev, LDAUTYPE=2):
| 元素 | 氧化物中 U (eV) | 来源 |
|------|:---------------:|------|
| Fe | 3.0-5.3 | Materials Project: 5.3 |
| Co | 3.0-3.5 | Materials Project: 3.32 |
| Ni | 5.0-6.5 | Materials Project: 6.2 |
| Mn | 3.5-4.0 | Materials Project: 3.9 |
| Cu | 4.0-5.0 | |
| Ti | 2.0-4.0 | |
| V | 3.0-3.5 | Materials Project: 3.25 |
| Cr | 3.0-3.5 | Materials Project: 3.7 |

**注意**: U 值应始终注明来源和方法。Materials Project 使用 GGA+U 的 Wang et al. (2006) 参数集。

---

## IVDW — 范德华/色散校正

**默认值**: 0（不使用色散校正）

控制是否以及使用何种范德华色散校正方法。

| IVDW 值 | 方法 | 说明 |
|---------|------|------|
| 0 | 无校正 | 默认 |
| 1 | DFT-D2 (Grimme) | 经验方法，计算开销小 |
| 11 | DFT-D3 (Grimme, 无阻尼) | 改进版 |
| 12 | DFT-D3-BJ (Grimme, BJ 阻尼) | **推荐：精度和成本最佳平衡** |
| 2 | TS (Tkatchenko-Scheffler) | 基于 Hirshfeld 分析 |
| 20 | TS-SCS | TS + 自洽筛选 |
| 202 | MBD (Many-Body Dispersion) | 最精确但最贵 |

**何时使用色散校正**:
- 层状材料（石墨烯、MoS₂、BN）— **必须**
- 分子在表面的吸附 — **必须**
- 有机分子/MOF — **必须**
- 体相金属 — 通常不需要
- 离子晶体（NaCl、MgO）— 通常不需要

**推荐**: 大多数情况使用 `IVDW = 12`（DFT-D3-BJ）

---

## NCORE / NPAR / KPAR — 并行化参数

### NCORE — 每轨道核数

**默认值**: 1

NCORE 指定处理单个轨道（波函数）的核心数量。

**推荐值**: `NCORE = sqrt(总核数)` 或 `NCORE = 核数/节点数`

| 总核数 | NCORE 推荐 |
|:------:|:---------:|
| 4 | 2 |
| 16 | 4 |
| 32 | 4-8 |
| 64 | 8 |

### KPAR — k 点并行

**默认值**: 1

将 k 点分配到多组处理器并行计算。KPAR 必须能整除 k 点数。

**推荐**: `KPAR = 节点数`（但 KPAR × NCORE 不能超过总核数）

### NPAR — 带并行（旧式）

NPAR = 总核数 / NCORE。通常使用 NCORE 替代 NPAR。

**并行优化示例** — 64 核 2 节点:
```
KPAR = 2     ! 2 组 k 点并行
NCORE = 8    ! 每轨道 8 核
```

**注意**: 
- NCORE 和 NPAR 互斥，不要同时设置
- 错误的并行参数可能导致大幅性能下降
- 对小体系（< 10 原子），增大 NCORE 收益递减
