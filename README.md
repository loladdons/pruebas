# Magis Live TV — Repo para Nuvio / lolplus

Repositorio de **TV en vivo** compatible con tu launcher (`nuvio_launcher` / lolplus).  
Usa el **mismo protocolo** del lib Dart `magis_live` (portal Magis/Xuper): cifrado 3DES, sesión, catálogo y resolve de streams.

## Contenido

| Archivo     | Descripción                                      |
|------------|---------------------------------------------------|
| `lol.json` | Manifest + **config** (email / password obligatorios) |
| `plugin.js`| Lógica del portal en JS (catálogo + getStreams)  |
| `README.md`| Este archivo                                      |

## Cómo usarlo en tu app

1. Sube esta carpeta a un repo de GitHub (ej. `tu-usuario/magis-live`).
2. En el launcher → **Comunidad / Instalar repo** → pega `tu-usuario/magis-live`.
3. Abre **Configuración del repo** e introduce:
   - **Email / Usuario Magis**
   - **Contraseña**
   - (Opcional) hosts o clave 3DES si el portal cambió.
4. En Home del repo verás categorías y canales. Al abrir un canal se llama a `getStreams`.

## Config (lol.json)

La app guarda la config por `repoId + key` (caché local).  
Sin email/password el home muestra un aviso de configuración.

## Limitación importante (playback)

Magis firma **cada segmento** HLS con `sign_o3` (MD5 tweaked + timestamp) y headers:

- `Content-Auth`
- `Content-License`

El `plugin.js` devuelve la playlist + headers iniciales.  
Si el player de la app **no reenvía headers a los .ts** (o no regenera el sign), el stream se corta.

### Solución robusta (recomendada)

Usa el **módulo Dart** que ya tienes en `lib/` (`MagisLiveService` + `LiveHlsProxy`):

```dart
final service = MagisLiveService();
await service.init();
await service.login(email, password);
final channels = await service.fetchAllChannels();
final session = await service.resolve(channels.first.code);
// LiveHlsProxy genera http://127.0.0.1:puerto/... con auth por segmento
```

Puedes:

- Integrar Magis como **fuente nativa** en el launcher (no solo JS), o
- Exponer un bridge desde Dart hacia el JS runtime (más trabajo).

El repo JS sirve para **listar canales y probar** el protocolo; el proxy local del lib es lo ideal para reproducción estable.

## API del plugin (exports)

- `setConfig(map)` — email, password, hosts, desKeyHex  
- `getHome()` → filas de categorías / canales  
- `search(query)`  
- `getMeta(id)` — id = `magis:CHANNEL_CODE`  
- `getStreams(id)` → `[{ url, headers, isHls, ... }]`

## Dependencias en runtime

El JS runtime de la app ya carga **crypto-js** (assets).  
Se usa TripleDES ECB + MD5 estándar + TweakedMd5 portado a mano para `sign_o3`.

## Hosts por defecto

```
bcdod.faolmbghu.com
osuhk.m3x8o50te.com
```

Clave 3DES por defecto (hex 24 bytes):

```
e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8
```

(Igual que `MagisConfig.defaults` en tu lib.)

## Licencia / uso

Solo para uso personal / educativo. Respeta los términos del servicio Magis/Xuper.
