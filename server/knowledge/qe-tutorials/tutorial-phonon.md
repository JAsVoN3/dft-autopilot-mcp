<!-- 来源: https://raw.githubusercontent.com/pranabdas/espresso/refs/heads/main/docs/hands-on/phonon.mdx -->
<!-- 自动下载，请勿手动编辑 -->

# QE 教程：声子计算

---
title: Phonon dispersion
keywords: ["phonon dispersion calculation in Quantum Espresso", "Raman spectra"]
---

In Quantum Espresso, phonon dispersion is calculated using `ph.x` program, which
is implementation of [density functional perturbation theory (DFPT)](
https://doi.org/10.1103/RevModPhys.73.515).

Here are the steps for calculating phonon dispersion:

(1) perform SCF calculation using `pw.x`






We perform the SCF calculation:

```bash
mpirun -np 4 pw.x -i pw.scf.GaAs.in > pw.scf.GaAs.out
```

:::info

1. Usually higher energy cutoff values are used for phonon calculation to get
better accuracy.

2. In case of two dimensional systems, use `assume_isolated = '2D'` in the
`SYSTEM` namelist to avoid negative or imaginary acoustic frequencies near
$\Gamma$ point. Read more [here](https://doi.org/10.1103/PhysRevB.96.075448).

:::


(2) calculate the dynamical matrix on a uniform mesh of q-points using `ph.x`





Run the calculation:

```bash
mpirun -np 4 ph.x -i ph.GaAs.in > ph.GaAs.out
```

The above calculation is computationally demanding. Our example calculation took
about a whole day on a 2.6 GHz quad core processor.

:::info

You can restart an interrupted `ph.x` calculation with `recover = .true.` in the
`INPUTPH` namelist. You can cleanly exit an ongoing calculation by creating an
empty file with name `{prefix}.EXIT`.

:::


(3) perform inverse Fourier transform of the dynamical matrix to obtain inverse
Fourier components in real space using `q2r.x`. Below is our input file:





```bash
mpirun -np 4 q2r.x -i q2r.GaAs.in > q2r.GaAs.out
```

(4) Finally, perform Fourier transformation of the real space components to get
the dynamical matrix at any q by using `matdyn.x`.





```bash
mpirun -np 4 matdyn.x -i matdyn.GaAs.in > matdyn.GaAs.out
```

We can now plot the phonon dispersion of GaAs:

```py title="notebooks/GaAs-phonon.ipynb"



data = np.loadtxt("../src/GaAs-phonon/GaAs.freq.gp")

nbands = data.shape[1] - 1
for band in range(nbands):
    plt.plot(data[:, 0], data[:, band + 1], linewidth=1, alpha=0.5, color='k')
# High symmetry k-points (check matdyn.GaAs.in)
plt.axvline(x=data[0, 0], linewidth=0.5, color='k', alpha=0.5)
plt.axvline(x=data[20, 0], linewidth=0.5, color='k', alpha=0.5)
plt.axvline(x=data[40, 0], linewidth=0.5, color='k', alpha=0.5)
plt.axvline(x=data[60, 0], linewidth=0.5, color='k', alpha=0.5)
plt.xticks(ticks= [0, data[20, 0], data[40, 0], data[60, 0], data[-1, 0]], \
           labels=['L', '$\Gamma$', 'X', 'U,K', '$\Gamma$'])
plt.ylabel("Frequency (cm$^{-1}$)")
plt.xlim(data[0, 0], data[-1, 0])
plt.ylim(0, )
plt.show()
```

<img src={require("../../static/img/GaAs-phonon.webp").default} class="inv-hue-rot-180" alt="GaAs-phonon"/>

:::tip

We may need to lower the value of `conv_thr` in `scf` calculation for more
accurate result.

:::

### Phonon Density of States

Input file for phonon DOS calculation:





Plot phonon DOS:

```py title="notebooks/GaAs-phonon.ipynb"
freq, dos, pdos_Ga, pdos_As = np.loadtxt("../src/GaAs-phonon/GaAs.dos", unpack=True)

plt.plot(freq, dos, c='k', lw=0.5, label='Total')
plt.plot(freq, pdos_Ga, c='b', lw=0.5, label='Ga')
plt.plot(freq, pdos_As, c='r', lw=0.5, label='As')
plt.xlabel('$\\Omega~(cm^{-1}$)')
plt.ylabel('Phonon DOS (state/cm$^{-1}/u.c.$)')
plt.legend(frameon=False, loc='upper left')
plt.xlim(freq[0], freq[-1])
plt.show()
```

<img src={require("../../static/img/GaAs-phonon-dos.webp").default} class="inv-hue-rot-180" alt="GaAs-phonon-dos"/>

## Resources

- [School on Electron-Phonon Physics from First Principles (2018)](https://indico.ictp.it/event/8301/other-view?view=ictptimetable) ([Video lectures on YouTube](https://www.youtube.com/playlist?list=PLYc-eBoIpXTIboem6dKTYD1-1m0sMYnYz))
- https://github.com/nguyen-group/QE-SSP
