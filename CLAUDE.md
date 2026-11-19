# OCR y traducción — notas para trabajar en el repo

App estática (GitHub Pages, sin build) que pasa PDFs a texto estructurado con Gemini y opcionalmente lo traduce. Todo en español rioplatense (voseo) en la interfaz y la documentación.

## Reglas

- Sin dependencias de build: HTML + módulos ES. Las librerías van copiadas en `lib/` (no CDN), así funciona instalada y sin conexión a terceros.
- La API key de Gemini vive solo en `localStorage` (`ocrt.settings`). Nunca agregar un servidor ni mandar la key a otro lado.
- Cada vez que se cambie un archivo de la app: subir la versión de caché en `sw.js` (`ocr-traduccion-vN`) y `APP_VERSION` en `js/app.js`; si se agrega un archivo, sumarlo a la lista de `sw.js`. No nombrar archivos con guion bajo inicial (`.nojekyll` existe, pero mejor evitarlo).
- Mantener las traducciones fieles: el prompt de `js/engine.js` pide traducción literal, sin resumir ni omitir. No relajar esas reglas.
- Si cambia la forma de los bloques (`BLOCK_TYPES`, esquema `SCHEMA`), actualizar también `blockHtml` y los exportes de `js/export.js`.
- Fórmulas: dentro del texto van entre `\(` y `\)`; las de renglón aparte son bloques `math` con LaTeX sin delimitadores. Se dibujan con `tex()` de `js/export.js` (KaTeX en el lector, MathML en .html, código LaTeX en Word y .txt). Nunca usar `$` como delimitador: choca con montos de dinero.
- Figuras: bloques `figure` con la imagen recortada en `img` (data URL JPEG). Gemini da la caja `box` [ymin, xmin, ymax, xmax] en 0–1000 sobre la imagen de la página que se le mandó; se recorta de ese mismo canvas (`cropFigure` en `js/pdf.js`).
- Páginas con `fig` o `math` (detectadas en `analyze`) van con visión en modo automático.
- No cambiar la forma de `doc` guardado en IndexedDB sin migrar los documentos viejos (el historial del usuario se perdería).

## Probar

Servir la carpeta (`python3 -m http.server`) y abrirla con Playwright, interceptando `generativelanguage.googleapis.com` con respuestas simuladas: probar un PDF mixto (páginas con texto y una escaneada), un 503 (debe reintentar), una respuesta con `finishReason: "MAX_TOKENS"` en un tramo de varias páginas (debe dividirlo), la vista lado a lado, la búsqueda y los exportes. Para fórmulas y figuras: un PDF con una imagen y texto con símbolos (∫, ρ, ≈), respuesta simulada con bloques `math`, `\(…\)` y `figure` con `box`. Revisar también en 390 px de ancho.

## Commits

Commit y push a `main`.
