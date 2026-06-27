# Smearing 技术（金属体系必备）

## 为什么金属需要 Smearing

金属的特征是费米面上有部分占据的态。在有限 K 点采样下，费米面附近态的占据数可能在迭代中剧烈跳变，导致 SCF 不收敛。Smearing 通过引入"模糊化"的占据函数来平滑化这个问题。

## QE 中的 Smearing 参数

```
&SYSTEM
    occupations = 'smearing'     ! 使用 smearing
    smearing    = 'mv'           ! smearing 类型
    degauss     = 0.02           ! smearing 宽度 (Ry)
/
```

## Smearing 类型对比

| 类型 | QE 关键字 | 适用场景 | 说明 |
|------|----------|---------|------|
| Marzari-Vanderbilt | `mv` 或 `cold` | 金属（推荐首选） | 冷 smearing，误差小 |
| Methfessel-Paxton | `mp` | 金属 | 适合态密度平滑的金属 |
| Gaussian | `gaussian` 或 `gauss` | 通用 | 简单但误差较大 |
| Fermi-Dirac | `fd` | 有限温度计算 | 有物理意义的温度 |

## degauss（Smearing 宽度）选择

degauss 的选择至关重要：太小不能有效平滑，太大引入人工误差。

### 推荐值
- **金属**：0.01 ~ 0.03 Ry（推荐 0.02 Ry）
- **半金属**：0.005 ~ 0.01 Ry
- **窄带隙半导体**：0.005 Ry 或更小

### 收敛测试
应该对 degauss 做收敛测试：
1. 使用若干不同的 degauss（如 0.005, 0.01, 0.02, 0.05 Ry）
2. 计算总能量
3. 选择使总能量趋于收敛的最小 degauss

## 半导体和绝缘体

对于半导体和绝缘体，**不需要**使用 smearing：
```
&SYSTEM
    occupations = 'fixed'   ! 固定占据数（默认）
    ! 不需要设置 smearing 和 degauss
/
```

但如果不确定体系是金属还是绝缘体，使用很小的 smearing（degauss = 0.005 Ry）通常也不会引入明显误差。

## 常见错误

1. **半导体使用了大的 smearing**：会导致虚假的金属态和错误的带隙
2. **金属不用 smearing**：几乎必然导致 SCF 不收敛
3. **degauss 太大**：总能量中包含大量人工热化误差
4. **态密度计算用了 smearing 的总能量**：DOS 计算应基于非 smearing 计算的电荷密度（先 scf 再 nscf）
