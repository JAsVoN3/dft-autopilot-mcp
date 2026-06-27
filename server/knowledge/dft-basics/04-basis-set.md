# 平面波基组与截断能

## 平面波基组原理

在周期性体系的 DFT 计算中，波函数用平面波展开。截断能（cutoff energy）决定了基组的大小和完备性。ecutwfc 越大，基组越完备，计算结果越准确，但计算成本也越高。

## ecutwfc 与 ecutrho

QE 中有两个截断能参数：

### ecutwfc（波函数截断能）
- 控制波函数展开的平面波数目
- 是最关键的收敛参数
- 单位：Rydberg (Ry)
- 典型范围：25-100 Ry

### ecutrho（电荷密度截断能）
- 控制电荷密度和势场的平面波数目
- 与赝势类型相关：
  - NCPP：ecutrho = 4 × ecutwfc
  - USPP：ecutrho = 8-12 × ecutwfc
  - PAW：ecutrho = 8-12 × ecutwfc
- 对 USPP/PAW，增大 ecutrho/ecutwfc 比值可提高精度

## 如何确定 ecutwfc

### 方法1：查阅赝势推荐值
赝势文件头部通常包含推荐的截断能。读取方式：
```bash
head -20 Si.pbe-n-rrkjus_psl.1.0.0.UPF
# 查找 suggested minimum cutoff 字段
```

### 方法2：收敛测试（强烈推荐）
1. 选择一系列 ecutwfc 值（如 20, 30, 40, 50, 60, 80 Ry）
2. 对同一结构分别计算总能量
3. 画出总能量 vs ecutwfc 曲线
4. 当能量变化小于 1 mRy/atom 时，认为已收敛
5. 选择刚好收敛的最小值作为计算参数

### 方法3：使用 SSSP 推荐值
SSSP 库已经为每个元素做过严格的收敛测试，直接使用其推荐值即可。

## 各赝势类型的 ecutwfc 经验值

| 赝势类型 | ecutwfc 范围 | ecutrho/ecutwfc |
|---------|-------------|-----------------|
| USPP | 25-50 Ry | 8-12 |
| PAW | 30-60 Ry | 8-12 |
| NCPP | 60-100 Ry | 4 |

## 多元素体系的截断能

当体系包含多种元素时，ecutwfc 必须取所有元素推荐值中的**最大值**。例如：
- Si 推荐 30 Ry
- O 推荐 40 Ry
- SiO₂ 体系应使用 ecutwfc = 40 Ry

## 实用建议

1. **USPP 是最高效的选择**：典型 ecutwfc 只需 30-40 Ry
2. **不要盲目追求高截断能**：过高的 ecutwfc 浪费计算资源
3. **正式计算前一定要做收敛测试**：哪怕只是快速扫描几个值
4. **ecutrho 对 USPP 影响较大**：如果结果异常，先尝试增大 ecutrho
5. **力和应力的收敛比能量慢**：结构优化需要比能量计算更高的截断能
