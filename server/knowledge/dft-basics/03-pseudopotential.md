# 赝势类型与选择指南

## 什么是赝势

赝势（Pseudopotential）是一种将原子核和核心电子的影响用一个等效势场来替代的近似方法。在 DFT 计算中，只需要显式处理价电子，核心电子由赝势描述，大幅降低计算成本。

## 赝势的三大类型

### 1. 模守恒赝势（NCPP, Norm-Conserving Pseudopotential）
- **特点**：赝波函数在截断半径外与全电子波函数完全一致
- **优点**：可靠性高，适用范围广
- **缺点**：需要较高的截断能（ecutwfc 60-100 Ry）
- **适用**：精度要求高、体系较小的计算
- **QE 中**：ecutrho = 4 × ecutwfc

### 2. 超软赝势（USPP, Ultrasoft Pseudopotential）
- **特点**：放宽了模守恒条件，允许更软的赝势
- **优点**：所需截断能低（ecutwfc 25-50 Ry），计算效率高
- **缺点**：精度略低于 NCPP，但对大多数应用足够
- **适用**：大体系计算、结构优化、常规计算（最推荐）
- **QE 中**：ecutrho = 8-12 × ecutwfc

### 3. PAW（Projector Augmented Wave）
- **特点**：在增广区域内重建全电子波函数
- **优点**：兼具 NCPP 的精度和 USPP 的效率
- **缺点**：内存占用较大
- **适用**：需要高精度的计算（磁性、XAS/XES 等）
- **QE 中**：ecutrho = 8-12 × ecutwfc

## 赝势库推荐

### PSlibrary（推荐首选）
- **官网**：https://dalcorso.github.io/pslibrary/
- **特点**：QE 官方推荐，覆盖元素周期表大部分元素
- **命名规则**：`元素.泛函-类型-赝势类型_psl.版本号.UPF`
- **示例**：`Si.pbe-n-rrkjus_psl.1.0.0.UPF`（Si 的 PBE 超软赝势）

### SSSP (Standard Solid-State Pseudopotentials)
- **官网**：https://www.materialscloud.org/discover/sssp/
- **特点**：经过严格精度和效率基准测试
- **两个版本**：
  - SSSP Efficiency：优化计算效率（推荐用于常规计算）
  - SSSP Precision：优化计算精度（推荐用于高精度计算）

### GBRV
- **特点**：超软赝势，很低的截断能需求
- **适用**：大体系快速计算

## 赝势文件命名规则（PSlibrary）

文件名格式：`元素.泛函-配置-类型_psl.版本.UPF`

- 泛函部分：`pbe`（PBE）、`pbesol`（PBEsol）、`pz`（LDA）
- 配置部分：`n`（包含非线性核心修正 NLCC）、`nl`（不含 NLCC）
- 类型部分：
  - `rrkjus`：USPP (Rappe-Rabe-Kaxiras-Joannopoulos ultrasoft)
  - `kjpaw`：PAW
  - `nc`：NCPP

## 常见元素赝势推荐

| 元素 | 推荐赝势 | ecutwfc (Ry) | ecutrho (Ry) |
|------|---------|-------------|-------------|
| H | H.pbe-rrkjus_psl.1.0.0.UPF | 30 | 240 |
| C | C.pbe-n-kjpaw_psl.1.0.0.UPF | 40 | 320 |
| N | N.pbe-n-rrkjus_psl.1.0.0.UPF | 40 | 320 |
| O | O.pbe-n-rrkjus_psl.1.0.0.UPF | 30 | 240 |
| Si | Si.pbe-n-rrkjus_psl.1.0.0.UPF | 30 | 240 |
| Fe | Fe.pbe-spn-rrkjus_psl.1.0.0.UPF | 45 | 360 |
| Mo | Mo.pbe-spn-rrkjus_psl.1.0.0.UPF | 40 | 320 |
| S | S.pbe-n-rrkjus_psl.1.0.0.UPF | 35 | 280 |

## 关键选择原则

1. **泛函必须与赝势匹配**：PBE 泛函必须配 PBE 赝势
2. **首选 USPP**：对于大多数计算，USPP 是效率和精度的最佳平衡
3. **需要高精度时用 PAW**：磁性计算、光谱计算推荐 PAW
4. **永远做收敛测试**：实际使用前必须测试 ecutwfc 的收敛性
5. **同一计算中赝势类型要统一**：不要混用 USPP 和 NCPP
