# VASP POTCAR 选择指南

来源：VASP Wiki (https://www.vasp.at/wiki/index.php/Available_PAW_potentials) — GNU FDL 1.2

## POTCAR 变体选择原则

VASP 为每个元素提供多种 PAW 赝势变体。选择正确的变体对计算精度至关重要。

### 通用规则

1. **无后缀（标准）**: 适用于大多数情况
2. **_sv (semi-core valence)**: 将半芯态电子当作价电子处理，更精确但 ENCUT 更高
3. **_pv (p-valence)**: 将 p 半芯态加入价态
4. **_d**: 将 d 态加入价态
5. **_GW**: 用于 GW/BSE 计算，价电子更多
6. **_h (hard)**: 更硬的赝势，ENCUT 更高，精度更高
7. **_s (soft)**: 更软的赝势，ENCUT 更低，速度更快（精度可能较低）

### 推荐变体表

#### 第一主族 (碱金属)
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| Li | Li_sv | 271 | 半芯 1s² 必须包含 |
| Na | Na_pv | 260 | 半芯 2p⁶ |
| K | K_sv | 259 | 半芯 3s²3p⁶ |

#### 第二主族 (碱土金属)
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| Be | Be | 309 | 标准即可 |
| Mg | Mg_pv | 264 | 含 2p 半芯态 |
| Ca | Ca_sv | 267 | 含半芯态 |
| Sr | Sr_sv | 229 | 含半芯态 |
| Ba | Ba_sv | 253 | 含半芯态 |

#### 常见非金属
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| H | H | 250 | 标准 |
| C | C | 400 | 标准 |
| N | N | 400 | 标准 |
| O | O | 400 | 标准（最常用） |
| O_s | O_s | 283 | 软，快速测试 |
| F | F | 400 | 标准 |
| S | S | 259 | 标准 |
| P | P | 255 | 标准 |
| Cl | Cl | 262 | 标准 |

#### 3d 过渡金属（最常用）
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| Ti | Ti_pv | 222 | 含 3p 半芯态 |
| V | V_pv | 264 | 含 3p 半芯态 |
| Cr | Cr_pv | 266 | 含 3p 半芯态 |
| Mn | Mn_pv | 270 | 含 3p 半芯态 |
| Fe | Fe_pv | 268 | 含 3p 半芯态 (**推荐用于发表**) |
| Fe | Fe | 268 | 标准（快速测试可用） |
| Co | Co | 268 | 标准 |
| Ni | Ni_pv | 368 | 含 3p 半芯态 |
| Cu | Cu_pv | 369 | 含 3p 半芯态 |
| Zn | Zn | 277 | 标准 |

#### 4d 过渡金属
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| Zr | Zr_sv | 230 | 含 4s 半芯态 |
| Mo | Mo_pv | 225 | 含 4p 半芯态 |
| Ru | Ru_pv | 240 | 含 4p |
| Rh | Rh_pv | 247 | 含 4p |
| Pd | Pd | 251 | 标准 |
| Ag | Ag | 250 | 标准 |

#### 5d 过渡金属
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| W | W_pv | 224 | 含 5p 半芯态 |
| Pt | Pt | 230 | 标准 |
| Au | Au | 230 | 标准 |

#### 稀土 / f 电子
| 元素 | 推荐变体 | ENMAX (eV) | 说明 |
|------|---------|:----------:|------|
| Ce | Ce | 273 | 注意 DFT+U |
| Gd | Gd_3 | 275 | f 电子在芯态 |

### POTCAR 顺序规则

POTCAR 文件中的元素顺序**必须**与 POSCAR 中 `元素行` 的顺序完全一致。

例如，POSCAR 为：
```
Fe2O3
1.0
...
Fe O
4 6
```
则 POTCAR 必须先放 Fe_pv 再放 O：`cat Fe_pv/POTCAR O/POTCAR > POTCAR`

### Materials Project 推荐变体

Materials Project 计算使用以下标准变体（参考 pymatgen MPRelaxSet）：

| 元素 | MP 使用变体 |
|------|-----------|
| Li | Li_sv |
| Na | Na_pv |
| K | K_sv |
| Ca | Ca_sv |
| Rb | Rb_sv |
| Cs | Cs_sv |
| Ba | Ba_sv |
| Sc | Sc_sv |
| Ti | Ti_pv |
| V | V_pv |
| Cr | Cr_pv |
| Mn | Mn_pv |
| Fe | Fe_pv |
| Ni | Ni_pv |
| Cu | Cu_pv |
| Ga | Ga_d |
| Ge | Ge_d |
| Y | Y_sv |
| Zr | Zr_sv |
| Nb | Nb_pv |
| Mo | Mo_pv |
| Tc | Tc_pv |
| Ru | Ru_pv |
| Rh | Rh_pv |
| W | W_pv |
