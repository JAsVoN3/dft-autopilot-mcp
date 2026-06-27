# &SYSTEM 参数详解

## 概述

`&SYSTEM` 定义体系的物理特性，包括晶格类型、原子数目、截断能、泛函选择等核心参数。

## 结构相关参数

### ibrav（Bravais 晶格类型）
```
ibrav = 0    ! 自定义晶格（推荐，最灵活）
```
- `ibrav = 0`：使用 CELL_PARAMETERS 卡自定义晶格（强烈推荐）
- `ibrav = 1`：简单立方
- `ibrav = 2`：FCC
- `ibrav = 3`：BCC
- `ibrav = 4`：六方
- 推荐始终使用 `ibrav = 0` + CELL_PARAMETERS，避免转换错误

### nat（原子总数）
```
nat = 2      ! 体系中的原子总数
```

### ntyp（原子种类数）
```
ntyp = 1     ! 不同种类的原子数目
```

## 基组参数

### ecutwfc（波函数截断能）
```
ecutwfc = 40.0   ! 单位: Ry
```

### ecutrho（电荷密度截断能）
```
ecutrho = 320.0  ! 单位: Ry
```

## 电子结构参数

### occupations（占据方式）
```
occupations = 'smearing'    ! 金属
occupations = 'fixed'       ! 半导体/绝缘体（默认）
```

### smearing 和 degauss
```
smearing = 'mv'       ! Marzari-Vanderbilt cold smearing
degauss  = 0.02       ! smearing 宽度 (Ry)
```

### nspin（自旋设置）
```
nspin = 1    ! 非自旋极化（默认）
nspin = 2    ! 共线自旋极化
nspin = 4    ! 非共线 / SOC
```

### nbnd（能带数目）
```
nbnd = 20    ! 计算的能带数目
```
- 默认：自动设置（价电子数/2 + 少量空带）
- 能带计算和 DOS 计算时需要增加空带数目
- 推荐：在默认基础上加 50% 的空带

### input_dft（泛函覆盖）
```
input_dft = 'PBE'    ! 覆盖赝势中的默认泛函
```
- 通常不需要设置，赝势自带泛函信息
- 只在需要使用不同泛函时设置

### starting_magnetization（初始磁化）
```
starting_magnetization(1) = 0.5    ! 第1种原子
starting_magnetization(2) = -0.5   ! 第2种原子
```

## DFT+U 参数

```
lda_plus_u = .true.
Hubbard_U(1) = 4.0     ! eV
```

## 范德华修正

```
vdw_corr = 'DFT-D3'          ! Grimme DFT-D3 修正
! 或
input_dft = 'vdw-df2-b86r'   ! vdW-DF2 泛函
```

## 非共线与 SOC

```
noncolin = .true.     ! 非共线磁性
lspinorb = .true.     ! 自旋轨道耦合
```

## 典型配置示例

### 硅（半导体）
```
&SYSTEM
    ibrav       = 0
    nat         = 2
    ntyp        = 1
    ecutwfc     = 30.0
    ecutrho     = 240.0
    occupations = 'fixed'
/
```

### 铁（铁磁金属）
```
&SYSTEM
    ibrav       = 0
    nat         = 1
    ntyp        = 1
    ecutwfc     = 45.0
    ecutrho     = 360.0
    occupations = 'smearing'
    smearing    = 'mv'
    degauss     = 0.02
    nspin       = 2
    starting_magnetization(1) = 0.5
/
```
