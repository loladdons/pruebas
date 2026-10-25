# CineHax+ (Repositorio adaptado para Nuvio / App)

Este paquete contiene el repositorio **CineHax+** (`cinehaxplus.com`) completamente adaptado a la arquitectura de tu aplicación (`RepoLoader`, `ContentService` y `JsAddonRuntime`).

## Archivos incluidos
- `lol.json`: Manifiesto principal con configuración de tema, paginación de episodios (`24` por página), estilo de novedades (`poster`), campos de usuario y aviso (`notices`) de primera versión.
- `plugin.js`: Código completo en CommonJS compatible con QuickJS (`getNews`, `getHome` con fila de Catálogos, `getCatalogs`, `getCatalog`, `getDiscoverFilters`, `getDiscover`, `search`, `getMeta`, `getStreams` con extracción de `pass` + `PM_UI` + `PM_EMBED` y filtro anti-anuncios HLS, y `getNotices`).
- `contract.json`: Contrato de capacidades y permisos para el diálogo de instalación.
- `icon.png`: Ícono oficial de CineHax+.
