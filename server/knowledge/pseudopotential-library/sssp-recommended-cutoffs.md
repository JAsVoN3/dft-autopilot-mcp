<!-- 来源: https://www.materialscloud.org/discover/sssp/ -->
<!-- 自动下载，请勿手动编辑 -->

# SSSP 赝势推荐参数

> 来源：SSSP (Standard Solid-State Pseudopotentials) v1.3
> 参考文献：G. Prandini et al., npj Computational Materials 4, 72 (2018)

## SSSP Efficiency（效率优先）推荐截断能

以下为 SSSP Efficiency 库中各元素的推荐截断能（ecutwfc，单位 Ry）和赝势类型。
这些值经过严格的 Delta 基准测试验证。

| 元素 | ecutwfc (Ry) | ecutrho (Ry) | 赝势类型 | 赝势文件 |
|------|-------------|-------------|---------|---------|
| H | 30 | 240 | USPP | H.pbe-rrkjus_psl.1.0.0.UPF |
| He | 35 | 280 | NCPP | He.pbe-kjpaw_psl.1.0.0.UPF |
| Li | 40 | 320 | USPP | Li.pbe-s-rrkjus_psl.1.0.0.UPF |
| Be | 40 | 320 | USPP | Be.pbe-n-rrkjus_psl.1.0.0.UPF |
| B | 35 | 280 | USPP | B.pbe-n-rrkjus_psl.1.0.0.UPF |
| C | 40 | 320 | PAW | C.pbe-n-kjpaw_psl.1.0.0.UPF |
| N | 40 | 320 | USPP | N.pbe-n-rrkjus_psl.1.0.0.UPF |
| O | 45 | 360 | PAW | O.pbe-n-kjpaw_psl.1.0.0.UPF |
| F | 45 | 360 | PAW | F.pbe-n-kjpaw_psl.1.0.0.UPF |
| Na | 30 | 240 | USPP | Na.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Mg | 30 | 240 | USPP | Mg.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Al | 30 | 240 | USPP | Al.pbe-n-rrkjus_psl.1.0.0.UPF |
| Si | 30 | 240 | USPP | Si.pbe-n-rrkjus_psl.1.0.0.UPF |
| P | 30 | 240 | USPP | P.pbe-n-rrkjus_psl.1.0.0.UPF |
| S | 35 | 280 | USPP | S.pbe-n-rrkjus_psl.1.0.0.UPF |
| Cl | 40 | 320 | USPP | Cl.pbe-n-rrkjus_psl.1.0.0.UPF |
| K | 40 | 320 | USPP | K.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Ca | 30 | 240 | USPP | Ca.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Ti | 35 | 280 | USPP | Ti.pbe-spn-rrkjus_psl.1.0.0.UPF |
| V | 35 | 280 | USPP | V.pbe-spnl-rrkjus_psl.1.0.0.UPF |
| Cr | 40 | 320 | USPP | Cr.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Mn | 40 | 320 | USPP | Mn.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Fe | 45 | 360 | USPP | Fe.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Co | 45 | 360 | USPP | Co.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Ni | 45 | 360 | USPP | Ni.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Cu | 40 | 320 | USPP | Cu.pbe-dn-rrkjus_psl.1.0.0.UPF |
| Zn | 40 | 320 | USPP | Zn.pbe-dn-rrkjus_psl.1.0.0.UPF |
| Ga | 40 | 320 | USPP | Ga.pbe-dn-rrkjus_psl.1.0.0.UPF |
| Ge | 40 | 320 | USPP | Ge.pbe-dn-rrkjus_psl.1.0.0.UPF |
| As | 35 | 280 | USPP | As.pbe-n-rrkjus_psl.1.0.0.UPF |
| Se | 30 | 240 | USPP | Se.pbe-dn-rrkjus_psl.1.0.0.UPF |
| Mo | 35 | 280 | USPP | Mo.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Ag | 35 | 280 | USPP | Ag.pbe-n-rrkjus_psl.1.0.0.UPF |
| Sn | 40 | 320 | USPP | Sn.pbe-dn-rrkjus_psl.1.0.0.UPF |
| W | 30 | 240 | USPP | W.pbe-spn-rrkjus_psl.1.0.0.UPF |
| Pt | 35 | 280 | USPP | Pt.pbe-spfn-rrkjus_psl.1.0.0.UPF |
| Au | 35 | 280 | USPP | Au.pbe-n-rrkjus_psl.1.0.0.UPF |
| Bi | 40 | 320 | USPP | Bi.pbe-dn-rrkjus_psl.1.0.0.UPF |

## 使用建议

1. **多元素体系**：取所有元素中 ecutwfc 的最大值
2. **统一赝势类型**：同一计算中建议使用同一类型（全 USPP 或全 PAW）
3. **做收敛测试**：以上为推荐起始值，正式计算前仍需测试
4. **赝势下载**：从 https://www.materialscloud.org/discover/sssp/ 批量下载
