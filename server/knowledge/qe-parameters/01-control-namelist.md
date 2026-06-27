# &CONTROL 参数详解

## 概述

`&CONTROL` 是 QE pw.x 输入文件的第一个 namelist，控制计算类型、输入输出路径和基本行为。

## 关键参数

### calculation（计算类型）
```
calculation = 'scf'
```
| 值 | 含义 | 用途 |
|----|------|------|
| `'scf'` | 自洽场计算 | 单点能、电子结构 |
| `'relax'` | 原子位置优化 | 找到能量最低的原子排列 |
| `'vc-relax'` | 可变晶胞优化 | 同时优化原子和晶格 |
| `'nscf'` | 非自洽场计算 | 能带/态密度的前置步骤 |
| `'bands'` | 能带计算 | 沿高对称路径计算能带 |
| `'md'` | 分子动力学 | Born-Oppenheimer MD |

### prefix（输出前缀）
```
prefix = 'silicon'
```
- QE 中间文件和输出文件的名称前缀
- 建议使用有意义的名称（如材料名）
- 同一目录下不同计算必须使用不同 prefix

### outdir（输出目录）
```
outdir = './tmp'
```
- 存放临时文件和中间数据的目录
- 包含波函数文件 `.wfc`、电荷密度 `.save` 等
- 建议放在高速磁盘上（SSD）
- 计算结束后可删除以节省空间

### pseudo_dir（赝势目录）
```
pseudo_dir = '/home/user/pseudo'
```
- 赝势文件所在的目录路径

### verbosity（输出详细程度）
```
verbosity = 'high'
```
- `'low'`：最小输出（默认）
- `'high'`：详细输出（推荐，包含更多有用信息）

### tprnfor（打印受力）
```
tprnfor = .true.
```
- 是否在输出中打印原子受力
- 结构优化时必须开启
- 建议始终开启，方便检查结构稳定性

### tstress（打印应力）
```
tstress = .true.
```
- 是否计算和打印应力张量
- `vc-relax` 计算时必须开启
- note: 计算应力会增加额外计算量

### forc_conv_thr（力收敛阈值）
```
forc_conv_thr = 1.0d-4
```
- 结构优化（relax/vc-relax）的力收敛标准
- 单位：Ry/Bohr
- 默认：1.0d-3（比较粗糙）
- 推荐：1.0d-4（常规优化）
- 高精度：1.0d-5

### etot_conv_thr（能量收敛阈值）
```
etot_conv_thr = 1.0d-5
```
- 结构优化的能量收敛标准
- 单位：Ry
- 与 forc_conv_thr 取其中先满足的

### restart_mode（重启模式）
```
restart_mode = 'from_scratch'   ! 从头开始（默认）
restart_mode = 'restart'        ! 从上次中断处恢复
```

## 典型配置示例

### 单点能计算
```
&CONTROL
    calculation   = 'scf'
    prefix        = 'material'
    outdir        = './tmp'
    pseudo_dir    = '../pseudo'
    verbosity     = 'high'
    tprnfor       = .true.
/
```

### 结构优化
```
&CONTROL
    calculation   = 'relax'
    prefix        = 'material'
    outdir        = './tmp'
    pseudo_dir    = '../pseudo'
    verbosity     = 'high'
    tprnfor       = .true.
    forc_conv_thr = 1.0d-4
/
```
