# Túnel de viento (vgpu)

Simulación de fluidos 3D en tiempo real en el navegador, hecha con [vgpu](https://vgpu.sh) sobre WebGPU.

```bash
npm install
npm run dev            # http://localhost:5173  (?q=low|medium|high para la grilla)
npm run check:sim      # corrida headless (Dawn) + capturas en .check/
npm run check:wings    # sensibilidad de fuerzas a modelos de alerón y aero activa (promedios)
```

## Cómo funciona

- **Fluido**: lattice Boltzmann D3Q19 con turbulencia Smagorinsky (LES), en compute shaders. Se simula medio túnel con plano de simetría y se espeja al renderizar.
- **Túnel**: entrada de velocidad, salida a presión con zona de amortiguación, piso móvil (cinta rodante) y campo lejano en techo y laterales.
- **Geometría**: una SDF compartida (`src/engine/f1.ts`: F1 genérico de reglamento 2026 —3,40 m entre ejes, 1,90 m de ancho, gomas más angostas, piso más plano, sin beam wing y con aero activa en lugar de DRS—, pintado con los colores de Mercedes: plata, negro y turquesa) que el voxelizador usa para la simulación y el raymarcher para el render. Los alerones se re-voxelizan en vivo cuando se mueven o se cambian: hay piezas intercambiables dentro del reglamento —4 alerones delanteros, 3 traseros, 4 pontones (downwash, zero-pod, bañera, cintura alta), 3 tapas de motor y 3 narices— seleccionables tocando la pieza en 3D, su etiqueta o el panel, más altura delantera y trasera (rake) independientes.
- **Colisión**: LBM regularizado (proyección del no-equilibrio sobre momentos de 2º orden) + Smagorinsky, más estable que BGK a baja viscosidad.
- **Render**: estudio con softboxes, fibra de carbono procedural, piso con reflejo de contacto, antialiasing y bloom. Líneas de corriente integradas sobre el campo de velocidad (RK2) con pulsos animados, y emisores de vórtices en las puntas de los alerones.
- **Fuerzas**: intercambio de momento en cada enlace fluido-sólido, separado por componente (alerón delantero, trasero y resto). Validación: un cubo de 1 m da Cd ≈ 1.04 (experimental ≈ 1.05).
- **Calor**: escalar advectado (semi-Lagrangiano) desde frenos, escape y radiadores, más el calentamiento adiabático por presión (estancamiento).
- **Dibujo**: silueta 2D → campo de distancia (EDT) → extrusión o revolución en 3D.

Las fuerzas son orientativas: la grilla es de ~4.5 cm, así que el efecto suelo del piso queda fuera de alcance (en esta resolución piso y ruedas dan sustentación) y el alerón delantero está ~10 cm más alto que en un auto real para que no quede atrapado en ese mismo efecto. Los alerones y la aero activa responden en la dirección correcta; sirven para comparar configuraciones.

En celulares y tablets sin mouse se muestra una pantalla de "pitstop" en lugar del túnel (agregá `?force` a la URL para saltearla).

## Modelo del W17

El auto por defecto es el modelo [“2026 Mercedes W17”](https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b) de Dave Love, con licencia [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Se dibuja rasterizando la malla con sus texturas originales en un G-buffer que después se combina con el raymarcher (piso, sombras, reflejos y campos de flujo).

Para la simulación y las sombras se usa un campo de distancias de la carrocería horneado a 1,5 cm (`public/models/w17.sdf.bin`); las ruedas se modelan de forma analítica.

Los alerones están articulados sobre la malla real (`w17.rig.*`): los dos flaps delanteros giran sobre una bisagra que sigue su borde de ataque y se desvanece hacia la nariz y las placas, y el plano principal y los flaps traseros giran como sólidos. Cada pieza móvil tiene su propia grilla de distancias (`w17.parts.bin`) que la simulación lee con la rotación inversa, así que el túnel ve exactamente la geometría que se dibuja. Los niveles de carga (alta, media, baja) y la aero activa son rotaciones de esas piezas.

### Fuerzas de los alerones

Con celdas de 4,5 cm el túnel no puede resolver elementos de 1–2 cm de espesor ni las ranuras entre ellos, y su viscosidad efectiva deja el número de Reynolds en ~300 (el real es ~1,8 millones): los alerones casi no generan carga en la simulación. Por eso, en el W17, la carga y la resistencia de los alerones se calculan con un método de paneles (vortex lattice) sobre las secciones reales de cada elemento (`src/engine/vlm.ts`, en un Web Worker), con efecto suelo por imágenes y la misma articulación del render. El túnel sigue dando el flujo visible y las fuerzas de carrocería, piso y ruedas.

```bash
npm run check:loads   # cargas de los alerones del W17 para cada configuración
```

### Herramientas de túnel

- **Mapa aerodinámico**: barrido automático de 5×5 alturas (delantera × trasera); cada punto se mide en el túnel y se muestra como mapa de carga, eficiencia o balance. Tocando una celda se aplican esas alturas.
- **Balance por eje**: reparto de la carga de los alerones entre ejes, usando el centro de presión de cada alerón (método de paneles) respecto de los ejes. El indicador se centra en la configuración de referencia.
- **Gurney flap**: pestaña de 15 mm en el borde de fuga del alerón trasero; en el método de paneles se modela con una altura efectiva calibrada al +10–15 % de carga típico.
- **Piezas y especificaciones**: los alerones se pueden desmontar (salen volando y la simulación los quita), el trasero tiene forma estándar, cuchara (Monza) o tablón (Mónaco) por torsión de las puntas, y hay perfiles finos (flaps más cortos). Los pontones compactos deforman la carrocería real (con su inversa en el campo de distancias) y la refrigeración cerrada/normal/abierta cambia las rejillas, la temperatura y la resistencia.
- **Fuerzas de carrocería**: la estela oscila lento (±50 kg), así que la carrocería se informa con sus coeficientes promediados ~12 s; refrigeración y pontones suman deltas calibrados (±10–15 kg), porque actúan sobre todo por flujo interno y detalles que la grilla no resuelve. Como a esta resolución el piso no genera efecto suelo, al Cl·A del túnel se le suma la carga faltante del piso y el Cd·A se escala (la configuración por defecto queda cerca de 340 km/h de punta); los cambios de setup siguen saliendo de la simulación.
- **Conductos de refrigeración**: los pontones tienen un conducto que solo ve el túnel (el render mantiene la malla cerrada): el aire entra por la toma y sale por la zona de la botella de Coca-Cola. Con celdas de 4,5 cm la viscosidad del conducto frenaría todo el caudal, así que la presión dinámica que alimenta un radiador real se modela relajando el aire hacia un flujo de refrigeración. El tamaño sigue a la refrigeración (cerrada, normal, abierta) y sus paredes no suman fuerzas, para no contar dos veces el delta calibrado. La simulación corre a una velocidad de red fija y las fuerzas se escalan con la velocidad real, así que los coeficientes no cambian con la velocidad del viento.
- **Estela**: plano a 1,2 m detrás del alerón trasero con el déficit de velocidad (el aire que el auto frenó), como un rastrillo de estela. Si cambiás el `.glb`, regenerá el rig y los campos con:

```bash
npm run bake:car
```

Las marcas y logos de la decoración pertenecen a sus dueños; el modelo se usa con fines demostrativos.
