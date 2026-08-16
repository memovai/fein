# FEIN(FE!N): Harness de agentes híbrido local-y-nube.

**El primer harness de agentes híbrido local-y-nube que te va a enganchar.**

[English](./README.md) · [日本語](./README.ja.md) · Español · [中文](./README.zh.md)

---

Casi todos los harness de agentes le compran cada parte del bucle al mismo
proveedor caro. Decidir qué hacer a continuación, comprimir un log de pruebas de
3.000 líneas y vigilar un comando peligroso se tratan como un solo trabajo, se
cobran como un solo trabajo y se le mandan a un solo modelo.

FE!N parte el bucle en **slots** y te deja asignar un modelo distinto a cada uno:
que el modelo de frontera piense y que un modelo de 3B en tu portátil lea.
TypeScript, **cero dependencias en tiempo de ejecución**, 160 pruebas.

```ts
import { Agent, Router, AnthropicPort, OllamaPort, defaultTools } from "fein";

const cloud = new AnthropicPort({ id: "cloud", model: "claude-sonnet-5",
                                  apiKey: process.env.ANTHROPIC_API_KEY,
                                  costPerMTokIn: 3, costPerMTokOut: 15 });
const local = new OllamaPort({ id: "local", model: "qwen2.5:3b" });

const router = new Router()
  .bind("driver",   cloud)                          // decide qué pasa
  .bind("digester", local, { fallbacks: [cloud] })  // comprime las observaciones
  .bind("verifier", cloud);                         // vigila los cambios de un subagente

await new Agent({ router, tools: defaultTools() }).run("¿Por qué fallan las pruebas?");
```

El código del bucle no cambia cuando reasignas. El mismo harness sirve para todo
en la nube, todo en local o cualquier mezcla, con un libro de cuentas que te dice
cuánto costó realmente la diferencia.

## Pruébalo en 30 segundos

Sin clave de API, sin GPU, sin red: todos los modelos de la demo están
guionizados, así que lo que ves es el harness en sí.

```bash
npm install && npm run demo
```

```
bindings
  driver      cloud/sonnet-sim [cloud]
  digester    local/qwen3b-sim [local] -> cloud/sonnet-sim

[2] driver · cloud/sonnet-sim cloud
Es un proyecto TypeScript. Ejecuto las pruebas para encontrar el fallo.
  tool shell(command: "npm test") via driver
       ok $ npm test ok 1 - unit/parser handles case 1 …
  digest shell: 3100 → 43 tok (99% smaller · local/qwen3b-sim)
  cache: prefix stable — 3 msg reused, 2 new

ledger
calls 4  ·  $0.0024  ·  0.2s
  local    1 calls   $0.0000
  cloud    3 calls   $0.0024
  cache  hit 10.1%   saved $0.0011
```

El driver decidió ejecutar `npm test` **él mismo** —su autoridad queda intacta—
pero nunca vio el log de 330 líneas. Un modelo local lo comprimió antes a 43
tokens. Ese ahorro se acumula en cada turno restante, recupera ventana de
contexto, y el log original nunca salió de la máquina.

## Los slots

| Slot | Trabajo | Por qué se puede separar |
|---|---|---|
| `driver` | Decidir qué pasa a continuación | El razonamiento difícil. Déjalo en la frontera. |
| `digester` | Comprimir salidas voluminosas antes de que el driver las vea | La salida es menor que la entrada, el ahorro se acumula y los datos crudos no salen de la máquina |
| `verifier` | Vigilar las llamadas de un subagente que modifican el mundo | Se activa poco, así que puede permitirse ser caro |
| `titler` | Ponerle nombre a la sesión | Trivial |

Cualquier slot admite cualquier modelo. Todos aceptan una cadena de respaldo, así
que un runtime local caído degrada ese slot a la nube en vez de tumbar la sesión.

**Hubo un quinto slot y lo borramos.** Un `toolformer` convertía la intención de
una línea del driver en argumentos concretos. Medido, costaba **entre 11 y 15
tokens de salida extra en cada llamada y ahorraba cero**: la intención tiene que
llevar los argumentos literalmente, así que es estructuralmente un superconjunto
de lo que reemplaza. El análisis con números está en [DESIGN.md](./DESIGN.md).
La lección: **delega una etapa solo cuando el delegado pueda producir más de lo
que recibió, o sepa algo que quien delega no sabe.**

## ¿Subagente o slot?

No compiten: se diferencian en **cuánto control cedes**.

| | Unidad | Coste fijo | Qué cedes |
|---|---|---|---|
| **Subagente** | Una tarea entera | ~600–900 tokens por arranque, contexto nuevo, caché fría | Todas las decisiones intermedias |
| **Slot** | Una etapa de una decisión | ~150 tokens | Nada |

Leer cuarenta archivos para encontrar un símbolo → **subagente**. «Ejecuta *este*
comando exacto, y su salida son 20k tokens» → **slot**; no puedes delegarlo a un
subagente sin ceder también la elección del comando. Unas pocas llamadas que
podrías hacer tú → **ninguno de los dos**.

## Mantener la caché caliente

La ejecución híbrida crea un riesgo que los harness puramente de nube no tienen:
es facilísimo ahorrar tokens de una forma que cuesta más de lo que ahorra,
reescribiendo un historial que el proveedor ya había cacheado. FE!N trata la
estabilidad del prefijo como un invariante, no como una aspiración:

- **Monotonía del render**: cada render extiende estrictamente al anterior.
  `PrefixGuard` calcula un hash de cada uno y avisa en cuanto se rompe,
  atribuyéndolo al slot culpable. Un fallo de caché deja de ser una factura y
  pasa a ser un bug reproducible.
- **Secciones de prompt verificadas**: el prompt de sistema se arma a partir de
  partes con nombre y volatilidad declarada, y `SectionGuard` detecta que una
  sección «congelada» cambió. `PrefixGuard` dice *el prefijo se rompió en el
  mensaje 4*; `SectionGuard` dice *la sección `identity` cambió entre turnos*.
  Sobre la segunda se puede actuar.
- **Anclas conscientes del alcance**: un breakpoint solo mira hacia atrás 20
  *bloques de contenido*, y un turno con seis llamadas paralelas son trece
  bloques. Dos turnos así dejan el ancla anterior fuera de alcance y pagas el
  precio completo para siempre, en silencio.
- **Añadir en vez de editar**: `registerDeferred` + `surfaceTool()` incorporan
  una herramienta a mitad de sesión sin tocar el bloque de herramientas;
  `injectContext()` añade contexto como mensaje de rol system en vez de
  reescribir el prompt de sistema.
- **Épocas, no ventana deslizante**: descartar mensajes antiguos desplaza cada
  token posterior y falla en *todos* los turnos siguientes, para siempre.
- **Concurrencia ordenada**: los resultados paralelos se añaden en orden de
  llamada, nunca de finalización, para que la transcripción no dependa de los
  tiempos de la máquina.

## Observaciones acotadas

Dos mecanismos, deliberadamente en capas, porque el gratuito debe ir primero.

**Spill** (sin modelo): la salida excesiva se escribe en `.fein/spill/` y se
sustituye por una vista de principio y final más una ruta que el modelo puede
`grep`. Sin pérdida, idempotente, nunca supera su límite, nunca crece.

**Digest** (una inferencia): un modelo local comprime el texto completo con
criterio semántico.

Son complementarios, y el fixture lo demuestra: en un log de 332 líneas con el
único fallo en la línea 241, la vista previa **no lo ve** y el digester sí. Por
eso corren los dos, y la lente prefiere `digest → preview → raw`. Spill además
arregla el peor defecto del digester: un resumen que perdió un detalle ahora
tiene un camino de vuelta al original.

La digestión se **trocea según la ventana de contexto del digester**, y el tope
de trozos depende de la localidad: un digester local lee 16 trozos (su coste
marginal es tiempo de reloj en hardware que ya pagaste), mientras que uno en la
nube **rechaza** de plano el trabajo troceado, porque spill ya acotó el daño
gratis. Esa constante es el argumento híbrido en miniatura.

## ReAct

Un modelo local puede *conducir*, no solo asistir. `ReactPort` envuelve cualquier
modelo de solo texto y presenta una interfaz nativa de llamadas a herramientas,
de modo que el bucle nunca se entera de que existe ReAct: mueve las herramientas
al prompt, reescribe el historial al formato Thought/Action/Observation que el
modelo habla, detiene la generación antes de que el modelo pueda inventarse su
propio `Observation:` y repara localmente la salida malformada.

Ese último punto es el fallo clásico de ReAct y ocurre **en silencio**: si lo
dejas, el modelo escribe tan tranquilo `Observation: el archivo contiene…` y
razona sobre un resultado que ninguna herramienta produjo. La solución es
mecánica —una secuencia de parada— no una petición educada.

## Dirigir sobre la marcha

Escribe mientras trabaja. Tu línea entra en el **siguiente límite de turno**,
nunca a mitad: colarla entre una Action y su Observation le daría al modelo un
mensaje de usuario donde corresponde un resultado de herramienta. Un segundo
`run()` concurrente se rechaza, porque dos escritores entrelazándose sobre la
transcripción hacen que el orden de los mensajes dependa del planificador, lo que
rompe la caché de forma intermitente e imposible de depurar.

## Higiene del bucle

Un bucle ReAct rara vez falla estrellándose. Falla *continuando*: llama a la
misma herramienta, obtiene la misma respuesta y vuelve a razonar sobre ella. Cada
turno parece razonable; lo demente es la secuencia, y el modelo no puede ver su
propio bucle desde dentro.

`LoopGuard` detecta repeticiones, oscilación (A→B→A→B) y estancamiento. El
criterio es **misma llamada, mismo resultado**: repetir una llamada cuya
respuesta cambió es legítimo (sondear una compilación, reintentar un test
inestable), así que nunca se dispara sobre trabajo real. Cada problema avisa una
vez; un guardián que se repite es otro bucle.

Quedarse sin turnos fuerza una respuesta de verdad **sin ofrecer herramientas**,
en lugar de devolver un fragmento suelto. Quitar la capacidad es una garantía;
pedirlo es solo una petición.

## Más allá del bucle

Todo se descubre desde el espacio de trabajo; nada exige un archivo de config.

**Sesiones duraderas** (`node:sqlite`, sin dependencias). `fein chat --resume
<id>` las reproduce. La compactación es un **fork**: la época genera una hija
sembrada con el resumen, la madre conserva todos los eventos y el enlace queda
registrado. «Compactado» significa *reubicado*, no *perdido*. Una sesión
interrumpida entre una llamada a herramienta y su resultado se repara al
reanudar; si no, no queda degradada sino **permanentemente irreanudable**, porque
todos los proveedores rechazan una llamada sin respuesta.

**Recuerdo**: búsqueda FTS5 sobre todas las sesiones previas, expuesta como
`session_search` en vez de inyectarse a espaldas del modelo. La salida de
herramientas no se indexa a propósito, así que el recuerdo devuelve decisiones y
no líneas de log.

**Identidad frente a convención**: `~/.fein/SOUL.md` dice quién es el agente; es
*tuyo*, así que es de confianza. Un `SOUL.md` dentro del repositorio se acordona
como cualquier archivo de proyecto, porque la frontera de confianza la marca
**quién puede escribir el archivo**, no cómo se llama.

**Habilidades**: procedimientos reutilizables en Markdown. El *índice* vive en el
prompt congelado; los *cuerpos* se cargan bajo demanda. Cargarlos todos de
entrada gasta tokens en habilidades que no usarás y, además, escribir una
habilidad invalidaría todas las conversaciones cacheadas.

**Hooks**: funciones o ejecutables en `.fein/hooks/<event>/`. `beforeTool` puede
**denegar**; un hook que solo observa es un sistema de logs, no un mecanismo de
seguridad. Los hooks de observación que lanzan excepción se ignoran; uno de
`beforeTool` que lanza **falla del lado seguro**.

**Subagentes**: la profundidad se limita *en el código*, y un `SpawnBudget` se
comparte por referencia en todo el árbol. Un límite por agente no es un límite:
con crecimiento anchura^profundidad se midieron 40 agentes partiendo de un
«tope» de 3.

**Tareas programadas**: cron POSIX duradero bajo la **misma** maquinaria de
permisos que el trabajo interactivo, en solo lectura salvo que pases `--write`.
Sin recuperación de ejecuciones perdidas: un portátil cerrado toda la noche
despierta con cero pendientes, no con once.

```bash
fein chat [--resume <id>]     fein run "<prompt>"     fein demo
fein sessions list | show <id> | search <q> | lineage <id>
fein skills list | show <name>          fein hooks
fein cron list | add | rm | enable | disable | runs | run | serve
```

## Espacio de trabajo

```
~/.fein/SOUL.md                     quién es el agente (de confianza, nivel 1)
.fein/sessions.db  .fein/jobs.db    sesiones duraderas + tareas programadas
.fein/skills/  .fein/hooks/<event>/ habilidades + hooks de ciclo de vida
.fein/spill/                        salida voluminosa, recuperable
AGENTS.md | CLAUDE.md | SOUL.md     contexto del proyecto (acordonado, nivel 2)
```

## Estructura

```
src/
  core/        types · transcript (log solo-añadir) · loop · guards · steering
  context/     lens + PrefixGuard · spill · repair
  models/      router · react-port · providers/{anthropic,openai,ollama,scripted}
  steps/       digester · verifier · subagent · react · prompts · sections
  tools/       registry · builtin · edit/glob/grep
  cache/       limits (breakpoints, alcance, mínimos) · keeper
  session/     store (SQLite+FTS5) · persist · search-tool
  skills/      hooks/      schedule/      telemetry/ledger
  config/      profiles · workspace        cli/       bench/
```

En [ARCHITECTURE.md](./ARCHITECTURE.md) está el porqué de estas fronteras, y en
[DESIGN.md](./DESIGN.md) el razonamiento tras cada regla, incluida una lista
honesta de lo que sigue sin resolver.

## Pruebas y benchmark

```bash
npm test               # 160 pruebas
npm run bench          # offline, determinista, gratis — coste del mecanismo
npm run bench:live     # modelos reales — la pregunta de la corrección
```

El benchmark compara cada mecanismo contra un control, sobre tareas elegidas para
que cada uno tenga un caso donde debería ganar y otro donde solo puede costar.
Medido: el digester es **un 88% más barato en su caso y un 43% más caro donde no
puede ayudar**, con un neto de **−58%** en cuatro tareas. Se amortizó de
inmediato al detectar un bug en el que el digester se ejecutaba, se facturaba y
su salida se descartaba en silencio.

Requiere Node ≥ 22.5 (por el `node:sqlite` integrado).

---

## Referencias

FE!N se construyó tras leer en paralelo cuatro harness de código abierto. Todos
tienen licencia MIT. **No se copió código**: el valor estaba en las decisiones de
diseño, y cada adopción es una implementación nueva con sus propios invariantes y
pruebas. [COMPARISON.md](./COMPARISON.md) documenta qué se tomó, qué se descartó
y qué sobrevivió intacto al contraste.

- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** —
  «todo es un plugin». Nos enseñó **spill** (vista previa acotada + localizador
  de recuperación, sin modelo), la poda de resultados sin modelo, los guardianes
  de higiene del bucle, y el principio de que el orden debe ser canónico porque
  es un prefijo de caché.
- **[pi](https://github.com/earendil-works/pi)** — paquetes de agente por capas.
  Nos enseñó **el turno como concepto de primera clase** (una respuesta del
  asistente más sus llamadas a herramientas) y una taxonomía de eventos anidada.
- **[nanobot](https://github.com/HKUDS/nanobot)** — un núcleo deliberadamente
  pequeño y legible. Nos enseñó **dirigir sobre la marcha** (inyección de
  mensajes a mitad de turno mediante una cola, en vez de una segunda ejecución
  que compite), los turnos tipados, y las pasadas defensivas que hacen seguro
  reproducir un historial persistido, lo que destapó un bug real: una sesión
  interrumpida quedaba permanentemente irreanudable.
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — sesiones
  como infraestructura e ingeniería de contexto profunda. Nos enseñó las
  **secciones de prompt con nombre** (que convirtieron nuestro invariante
  estrella de convención en algo verificado), un **ámbito de caché estable frente
  a la rotación** derivado de la raíz del linaje de compactación, usar el consumo
  real que informa el proveedor en vez de una estimación por caracteres, y
  acotar la lectura de cuerpos de error.

También influyeron el comportamiento publicado de Claude Code y Codex, y la
documentación de prompt caching de Anthropic para las reglas de breakpoints,
alcance, TTL y prefijo mínimo codificadas en `src/cache/limits.ts`.

## Licencia

MIT © Ziboyan Wang
