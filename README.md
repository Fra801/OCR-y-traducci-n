# OCR y traducción

Pasá un PDF a texto ordenado (títulos, párrafos, listas, tablas, citas y notas al pie) y, si querés, traducilo de forma fiel y literal. Sirve para libros enteros, apuntes y documentos escaneados.

**Usarla:** `https://fra801.github.io/OCR-y-traducci-n/`. Desde el celular, abrí esa dirección y elegí **Agregar a pantalla de inicio**.

## Cómo funciona

1. **Lee cada página en el navegador.** Las páginas que ya tienen texto seleccionable se leen al instante, sin gastar OCR. Las que son imágenes (escaneos) se marcan para OCR. El **mapa de páginas** muestra cuáles son cuáles.
2. **Procesa por tramos.** El documento se divide en pedidos chicos a Gemini: unas 12.000 letras de texto por pedido, o 4 páginas escaneadas (ajustable). Así la respuesta nunca se corta y el avance se ve página por página. Si una respuesta igual se corta, ese tramo se divide en dos y se vuelve a pedir.
3. **Se recupera sola de los errores.** Si Gemini está saturado, reintenta con espera creciente (respeta el tiempo que indica Google) y después prueba con otros modelos. Si algo falla o la detenés, **Continuar** retoma desde donde quedó, incluso otro día: todo queda guardado en el **Historial**.
4. **Traduce sin resumir.** Traducción fiel al español (u otro idioma), con el mismo tono y registro. Podés guardar el original para leerlo **lado a lado** y agregar un **glosario** para que los términos técnicos salgan siempre iguales.

## Qué podés hacer con el resultado

- Leerlo con índice, buscador (sin importar tildes), número de página en el margen y tamaño de letra ajustable.
- Ver la traducción, el original o los dos lado a lado.
- Copiar todo, o exportarlo a **Word (.doc)**, **Markdown**, **texto**, **página web** o **PDF** (con Imprimir).

## API key de Gemini

La app llama a Gemini directamente desde tu navegador, con tu propia key:

1. Entrá a [Google AI Studio](https://aistudio.google.com/apikey) y tocá **Create API key**.
2. En la app, tocá **Poner API key**, pegala y tocá **Probar y cargar modelos**.

La key se guarda solo en ese dispositivo. Con la key gratuita, Google puede usar lo que se envía para mejorar sus modelos; para documentos confidenciales conviene una key con facturación.

**Modelo:** de entrada usa `gemini-flash-latest`, un alias que Google mantiene apuntando al Flash vigente. En **Avanzado** se puede elegir Flash-Lite (más barato), Pro (más preciso) o cualquier modelo que tenga tu key.

## Privacidad

No hay servidor propio: la página es estática. El PDF y los resultados quedan en el navegador (IndexedDB). Lo único que sale del dispositivo son los tramos que se mandan a Google para el OCR o la traducción.

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html`, `styles.css` | Interfaz |
| `js/app.js` | Pantallas, opciones, proceso por tramos, lector, historial |
| `js/engine.js` | Plan de tramos, prompts, esquema JSON, división automática, unión de párrafos |
| `js/gemini.js` | Llamadas a Gemini: reintentos, modelos de respaldo, lista de modelos |
| `js/pdf.js` | Lectura del PDF con pdf.js, miniaturas, recorte de páginas con pdf-lib |
| `js/store.js` | Historial en IndexedDB |
| `js/export.js` | Exportación a texto, Markdown, HTML y Word |
| `lib/` | pdf.js 4.10 (Mozilla, Apache 2.0) y pdf-lib 1.17 (MIT), incluidas para que funcione sin conexión a CDNs |
| `sw.js`, `manifest.webmanifest` | App instalable |

Para probarla en la computadora: `python3 -m http.server` en la carpeta y abrir `http://localhost:8000`.
