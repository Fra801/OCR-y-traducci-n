# OCR y traducción

Pasá un PDF a texto ordenado (títulos, párrafos, listas, tablas, citas y notas al pie) y, si querés, traducilo de forma fiel y literal. Sirve para libros enteros, apuntes y documentos escaneados.

**Usarla:** `https://fra801.github.io/OCR-y-traducci-n/`. Desde el celular, abrí esa dirección y elegí **Agregar a pantalla de inicio**.

## Cómo funciona

1. **Lee cada página en el navegador.** Las páginas que ya tienen texto seleccionable se leen al instante, sin gastar OCR. Las que son imágenes (escaneos) se marcan para OCR. El **mapa de páginas** muestra cuáles son cuáles.
2. **Lo que no necesita IA, se hace en la app.** En las páginas con texto seleccionable, los títulos, párrafos, listas y notas se arman en el navegador a partir del tamaño y la posición de cada renglón (y se sacan los encabezados y números de página repetidos). Si no traducís, esas páginas no usan Gemini y salen al instante. Si traducís, a Gemini solo va el texto para traducir, y el original para la vista lado a lado no se le vuelve a pedir. En **Avanzado → Páginas con texto → Con Gemini** se puede volver al armado con Gemini, más lento pero mejor con tablas y diseños complicados.
3. **Procesa por tramos.** El documento se divide en pedidos chicos a Gemini: unas 12.000 letras de texto por pedido, o 4 páginas escaneadas (ajustable). Así la respuesta nunca se corta y el avance se ve página por página. Si una respuesta igual se corta, ese tramo se divide en dos y se vuelve a pedir.
4. **Se recupera sola de los errores.** Arranca con 2 pedidos a la vez y sube solo (hasta 6, o lo que pongas en Avanzado) mientras Gemini responda sin demoras; si Gemini está saturado, baja, reintenta con espera creciente (respeta el tiempo que indica Google) y después prueba con otros modelos. Si algo falla o la detenés, **Continuar** retoma desde donde quedó, incluso otro día: todo queda guardado en el **Historial**.
5. **Fórmulas en LaTeX.** Las ecuaciones salen escritas en LaTeX y se dibujan con KaTeX, como en un libro. Las páginas con fórmulas se leen con visión aunque tengan texto seleccionable, porque ese texto suele traer las fórmulas rotas.
6. **Figuras recortadas.** Fotos, gráficos y diagramas se recortan de la página y quedan en su lugar dentro del texto (tocándolas se ven en grande). Opcionalmente, Gemini agrega una descripción breve de cada una, marcada como «Descripción».
7. **Traduce sin resumir.** Traducción fiel al español (u otro idioma), con el mismo tono y registro. Podés guardar el original para leerlo **lado a lado** y agregar un **glosario** para que los términos técnicos salgan siempre iguales.

## Qué podés hacer con el resultado

- Leerlo con índice, buscador (sin importar tildes), número de página en el margen y tamaño de letra ajustable.
- Ver la traducción, el original o los dos lado a lado.
- Copiar todo, o exportarlo a **Word (.doc)**, **Markdown**, **texto**, **página web** o **PDF** (con Imprimir).

| Formato | Fórmulas | Figuras |
|---|---|---|
| Imprimir / PDF | dibujadas (KaTeX) | sí |
| Página web (.html) | dibujadas (MathML) | sí, incrustadas |
| Markdown (.md) | `$…$` y `$$…$$` (Obsidian, Notion, Typora) | sí, incrustadas |
| Word (.doc) | código LaTeX: en Word 365 se seleccionan y se insertan como ecuación (modo LaTeX) | sí |
| Texto (.txt) | código LaTeX | se indica «[Figura, p. N]» |

## API key de Gemini

La app llama a Gemini directamente desde tu navegador, con tu propia key:

1. Entrá a [Google AI Studio](https://aistudio.google.com/apikey) y tocá **Create API key**.
2. En la app, tocá **Poner API key**, pegala y tocá **Probar y cargar modelos**.

La key se guarda solo en ese dispositivo. Con la key gratuita, Google puede usar lo que se envía para mejorar sus modelos; para documentos confidenciales conviene una key con facturación.

**Velocidad:** Gemini se usa con el razonamiento al mínimo (para transcribir y traducir no hace falta y es lo que más demora). Con el modelo recomendado, el texto plano va con Flash-Lite y las páginas con visión con Flash. Las páginas escaneadas o con figuras se mandan como imagen; las que solo tienen fórmulas, como PDF recortado, que pesa mucho menos. Debajo del botón, **Tiempos** muestra cuánto tardó cada tramo.

**Modelo:** de entrada usa `gemini-flash-latest`, un alias que Google mantiene apuntando al Flash vigente. En **Avanzado** se puede elegir Flash-Lite (más barato), Pro (más preciso) o cualquier modelo que tenga tu key.

## API key de Claude (opcional)

También se pueden usar los modelos de Claude (Haiku, Sonnet u Opus), elegiéndolos en **Avanzado → Modelo**:

1. Entrá a la [Consola de Claude](https://platform.claude.com/settings/keys) y creá una API key. El uso de la API se cobra aparte de la suscripción de Claude; los planes Max, Ultra y Team traen créditos mensuales si vinculás una organización de la Consola.
2. En la app, abrí **API keys**, pegala en la sección **Claude** y tocá **Probar**.

La app llama a la API de Anthropic directamente desde el navegador (con el encabezado `anthropic-dangerous-direct-browser-access`), con esfuerzo bajo y salida JSON con esquema. Si el modelo elegido está saturado, prueba con Haiku y después con Sonnet. Con Claude conviene apagar **Recortar figuras**: ubica los recuadros con menos precisión que Gemini.

## Privacidad

No hay servidor propio: la página es estática. El PDF y los resultados quedan en el navegador (IndexedDB). Lo único que sale del dispositivo son los tramos que se mandan a Google (o a Anthropic, si elegís Claude) para el OCR o la traducción.

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html`, `styles.css` | Interfaz |
| `js/app.js` | Pantallas, opciones, proceso por tramos, lector, historial |
| `js/engine.js` | Plan de tramos, prompts, esquema JSON, traducción por fragmentos, división automática, unión de párrafos |
| `js/layout.js` | Armado de títulos, párrafos, listas y notas a partir de los renglones del PDF, sin IA |
| `js/gemini.js` | Llamadas a Gemini: reintentos, modelos de respaldo, lista de modelos |
| `js/claude.js` | Llamadas a la API de Claude: traduce el pedido y la respuesta al formato de Gemini |
| `js/pdf.js` | Lectura del PDF con pdf.js, miniaturas, recorte de páginas con pdf-lib |
| `js/store.js` | Historial en IndexedDB |
| `js/export.js` | Exportación a texto, Markdown, HTML y Word |
| `lib/` | pdf.js 4.10 (Mozilla, Apache 2.0), pdf-lib 1.17 (MIT) y KaTeX 0.19 (MIT), incluidas para que funcione sin conexión a CDNs |
| `sw.js`, `manifest.webmanifest` | App instalable |

Para probarla en la computadora: `python3 -m http.server` en la carpeta y abrir `http://localhost:8000`.
