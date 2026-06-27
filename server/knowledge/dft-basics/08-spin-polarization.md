# 自旋极化计算

## 何时需要自旋极化

当体系中存在未配对电子时，需要进行自旋极化计算。典型场景：
- 磁性金属（Fe, Co, Ni）
- 过渡金属氧化物（FeO, NiO, MnO）
- 含未配对电子的分子（O₂, NO）
- 缺陷态（如氧空位）
- 稀土元素化合物

## QE 中的设置

```
&SYSTEM
    nspin = 2                        ! 开启自旋极化（1=非极化，2=极化）
    starting_magnetization(1) = 0.5  ! 第1种原子的初始磁化（-1到1）
    starting_magnetization(2) = -0.3 ! 第2种原子的初始磁化
/
```

### 参数说明
- `nspin = 2`：开启共线性自旋极化
- `starting_magnetization(i)`：第 i 种原子（按 ATOMIC_SPECIES 顺序）的初始磁化
  - 正值：自旋向上为主
  - 负值：自旋向下为主
  - 绝对值范围：0 到 1

## 初始磁矩设置指南

### 铁磁（FM）排列
所有磁性原子的 starting_magnetization 同号：
```
starting_magnetization(1) = 0.5   ! Fe 同向
```

### 反铁磁（AFM）排列
需要使用超胞，将不同磁性位点定义为不同原子类型：
```
ATOMIC_SPECIES
Fe1  55.845  Fe.pbe-spn-rrkjus_psl.1.0.0.UPF
Fe2  55.845  Fe.pbe-spn-rrkjus_psl.1.0.0.UPF

&SYSTEM
    starting_magnetization(1) =  0.5   ! Fe1 自旋向上
    starting_magnetization(2) = -0.5   ! Fe2 自旋向下
/
```

## 常见问题

1. **磁矩收敛到零**：初始磁化可能设得太小，尝试增大到 0.5-0.8
2. **收敛困难**：自旋极化计算通常比非极化更难收敛，减小 mixing_beta
3. **赝势选择**：含 3d/4f 电子的元素推荐使用包含半核态（semicore）的赝势
4. **非共线磁性**：需要设置 `noncolin = .true.`，计算成本更高
