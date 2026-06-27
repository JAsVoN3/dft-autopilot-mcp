<!-- 来源: QE 邮件列表和社区经验汇总 -->
<!-- 自动下载，请勿手动编辑 -->

# SCF 不收敛排查指南

> 基于 QE 邮件列表和社区经验汇总

## 诊断步骤

### 第1步：检查输出中的能量变化趋势

```bash
grep 'estimated scf accuracy' scf.out
```

- **能量持续下降但很慢** → K 点或 ecutwfc 不够
- **能量在两个值之间振荡** → mixing_beta 太大
- **能量不降反升** → 初始结构有问题

### 第2步：常见原因和解决方案

| 症状 | 可能原因 | 解决方案 |
|------|---------|---------|
| 能量振荡 | mixing_beta 过大 | 减小到 0.1-0.3 |
| 缓慢下降 | K 点太稀 | 增加 K 点密度 |
| 缓慢下降（金属） | 缺少 smearing | 添加 `occupations='smearing'` |
| 第一步就崩溃 | 原子重叠 | 检查 ATOMIC_POSITIONS |
| charge is wrong | 赝势不匹配 | 检查赝势文件完整性 |
| 磁性体系不收敛 | 初始磁矩不对 | 调整 starting_magnetization |

### 第3步：自愈策略（按优先级）

1. **降低 mixing_beta**：从 0.7 → 0.3 → 0.1
2. **增大 mixing_ndim**：从 8 → 12
3. **改用 local-TF mixing**：`mixing_mode = 'local-TF'`
4. **增大 electron_maxstep**：200 → 500
5. **先粗后精**：先用 conv_thr=1d-4 收敛，再 restart 用高精度
6. **增加 K 点密度**
7. **增大 ecutwfc / ecutrho**

### 第4步：金属体系专项

金属不收敛最常见原因是缺少 smearing：
```
&SYSTEM
    occupations = 'smearing'
    smearing    = 'mv'        ! Marzari-Vanderbilt 冷 smearing
    degauss     = 0.02        ! 0.01-0.03 Ry
/
```

### 第5步：磁性体系专项

- 确保 `nspin = 2`
- 设置合理的 `starting_magnetization`（0.3-0.8）
- 使用更小的 `mixing_beta`（0.1-0.2）
