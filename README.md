# YouTube Demo — Repo con UI custom (structures)

Ejemplo completo de repositorio para Nuvio usando el **nuevo sistema de estructuras**.

## Qué incluye

| Ruta | Descripción |
|------|-------------|
| `lol.json` | Manifest (theme rojo YouTube, config API key / región / idioma) |
| `plugin.js` | Lógica YouTube (Data API + Innertube + Invidious + Piped) |
| `structures/mobile/` | UI móvil: home, search, detail, player, library, settings + navigation |
| `structures/tv/` | UI TV: hero grande, rail, grid de búsqueda, ficha split player+lista |
| `structures/desktop/` | UI escritorio: layout ancho, player + sidebar relacionados |

## Instalación en la app

1. Sube esta carpeta a un repo de GitHub (ej. `tu-usuario/youtube-demo-structures`).
2. En Nuvio → Comunidad / Instalar → pega `tu-usuario/youtube-demo-structures`.
3. (Opcional) En ajustes del repo pon tu **YouTube Data API Key**.

## Cómo se ve

### Mobile
- Barra inferior: Inicio · Buscar · Biblioteca · Ajustes
- Home estilo YouTube: logo, chips de categorías, hero, filas horizontales
- Ficha: **player arriba**, título, stats, acciones (like/share/save), canal, descripción, relacionados
- Player: superficie de vídeo + controles de calidad + “A continuación”

### TV
- Navegación lateral (rail)
- Hero grande + filas anchas
- Ficha en **dos columnas**: player + info | lista “A continuación”
- Búsqueda en grid 5 columnas

### Desktop
- Layout ancho tipo web
- Ficha 70/30: player+meta | relacionados
- Player con selector de calidad

## Formato structures

Cada plataforma tiene su carpeta. Si abres en TV y no hay `structures/tv/`, se usa `common` o la UI clásica de la app.

Los `source` apuntan a datos del plugin:

- `getHome.rows.0.items` → primera fila del home
- `search.results` → resultados de búsqueda
- `library.continue` / `favorites` / `history`
- `related.items` → relacionados en ficha

Los nodos `native: "player"` / `"config"` reutilizan el player y ajustes nativos de la app **dentro** del layout del repo.

## Nota

Este demo es para **probar el formato de UI**. El binding completo de `source` → datos en vivo depende de que la app inyecte el mapa `data` al abrir cada página (getHome, search, etc.). Las estructuras ya están listas para cuando ese pipeline esté conectado.
