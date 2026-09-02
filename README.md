# Mis Partituras - App de Partituras Offline

App PWA para ver partituras en tablet Android.

## Instalación rápida

1. Abre `generate-icons.html` en Safari
2. Haz clic en los enlaces para descargar los iconos
3. Colópalos en la carpeta `icons/`
4. Abre `index.html` en el navegador de tu tablet Android
5. Toca "Agregar a pantalla de inicio" para instalar como app

## Uso

- **Ver partituras**: Toca cualquier partitura en la cuadrícula
- **Buscar**: Escribe en el buscador
- **Filtrar**: Selecciona una categoría (Guitarra, Piano, Otros)
- **Agregar**: Toca el botón + para agregar un PDF
- **Navegar**: Usa las flechas para cambiar de página
- **Pantalla completa**: Toca el icono ⛶

## Funcionalidades

- ✅ Visor de PDFs
- ✅ Organización por categorías
- ✅ Búsqueda por nombre
- ✅ Funciona offline
- ✅ Se puede instalar como app
- ✅ Aviso automático de actualizaciones
- ✅ Las partituras NUNCA se pierden al actualizar

## Cómo publicar una actualización (para el desarrollador)

Cada vez que hagas cambios a la app, sigue estos pasos para que los
usuarios sean avisados automáticamente:

1. **Cambia la versión** en dos lugares:
   - `js/app.js` → `const APP_VERSION = '1.2.0';` (incrementa el número)
   - `manifest.json` → `"version": "1.2.0"`
2. **Sube los archivos** al servidor (GitHub Pages o el que uses)
3. Actualiza el nombre del cache en `service-worker.js`:
   - `const CACHE_NAME = 'partituras-vN';` (incrementa N)

Los usuarios verán: "🚀 ¡Nueva versión disponible!" y podrán elegir
actualizar ahora o más tarde. Sus partituras quedan intactas porque
viven en IndexedDB, separadas de los archivos de la app.

## Cómo funciona la protección de datos

- **IndexedDB**: Las partituras (PDFs) se guardan aquí. Nunca se toca
  al actualizar la app.
- **Migración automática**: Si en el futuro cambia el formato de guardado,
  la app convierte tus partituras viejas al nuevo formato solo.
- **Service Worker tolerante**: Si falla una actualización, la app sigue
  usando la versión anterior sin romperse.

## Notas

- Los datos se guardan en IndexedDB del navegador (las partituras)
- Para agregar partituras, necesitas un archivo PDF
- La app funciona sin internet después de la primera carga
