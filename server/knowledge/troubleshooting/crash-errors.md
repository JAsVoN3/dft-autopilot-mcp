<!-- 来源: QE 社区经验整理 -->
<!-- 自动下载，请勿手动编辑 -->

# QE 常见崩溃错误排查

## 错误汇总表

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `pseudo_dir not found` | 赝势目录路径错误 | 检查 pseudo_dir 路径 |
| `file not found` (UPF) | 赝势文件名不匹配 | 检查 ATOMIC_SPECIES 中的赝势文件名 |
| `wrong atomic coordinates` | 原子坐标格式错误 | 检查 ATOMIC_POSITIONS 单位 |
| `S matrix not positive definite` | 原子距离太近 | 检查晶体结构，重新优化 |
| `charge is wrong` | 电子数不匹配 | 检查赝势和价电子数 |
| `too few bands` | nbnd 设置太小 | 增大 nbnd |
| `out of memory` | 内存不足 | 降低 ecutwfc 或减少 K 点 |
| `segmentation fault` | 多种原因 | 检查 QE 安装和 MPI 配置 |
| `buffer overflow detected` | glibc 兼容性问题 | 使用 conda 安装的 QE |
| `error in davcio` | 磁盘空间不足 | 清理 outdir 目录 |
| `wrong ibrav` | ibrav 和晶格参数不匹配 | 使用 ibrav=0 + CELL_PARAMETERS |
| `K-point generation failed` | K 点设置错误 | 检查 K_POINTS 格式 |
| `No convergence in N iterations` | SCF 不收敛 | 见 SCF 不收敛排查指南 |

## 排查通用步骤

1. **阅读完整错误信息**：错误通常出现在输出文件的末尾
2. **检查输入文件格式**：不要使用 Tab，只用空格
3. **检查赝势文件**：确保文件完整且与泛函匹配
4. **验证晶体结构**：可用 VESTA 或 ASE 可视化检查
5. **减小体系做测试**：先用小体系验证参数设置
