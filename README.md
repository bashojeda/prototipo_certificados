# Prototipo de certificados

## Requisitos
- Windows con PowerShell
- Python 3.10 o superior
- LibreOffice instalado (para convertir DOCX -> PDF)

## Instalacion rapida (otra PC)
1. Abre PowerShell en la carpeta del proyecto.
2. Ejecuta:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

## Ejecutar proyecto
```powershell
.\.venv\Scripts\activate
uvicorn main:app --reload
```

Abre en navegador: `http://127.0.0.1:8000`

## Nota sobre LibreOffice
El sistema usa el comando `soffice` para convertir PDFs.

Si no funciona por PATH, define la variable `SOFFICE_PATH` con la ruta completa, por ejemplo:

```powershell
$env:SOFFICE_PATH = "C:\Program Files\LibreOffice\program\soffice.exe"
uvicorn main:app --reload
```

## Archivos clave
- `main.py`: backend FastAPI
- `templates/formulario.html`: carga de Excel + plantilla
- `templates/previsualizacion.html`: edicion + seleccion + previsualizar
- `templates/visor_preview.html`: visor de previsualizacion con marca de agua PNG
- `templates/resultado.html`: resultado final con links a PDF/DOCX
- `static/watermark.png`: imagen PNG usada como marca de agua en preview

## Despliegue para demo

### Opcion 1 (recomendada): Render + Docker
Este proyecto **no puede correr completo en GitHub Pages** porque tiene backend (FastAPI), subida de archivos y conversion DOCX -> PDF con LibreOffice.

Pasos:

1. Sube el proyecto a un repositorio en GitHub.
2. En Render, crea un servicio nuevo desde tu repo.
3. Render detectara `Dockerfile` automaticamente y desplegara.
4. Cuando termine, abre la URL publica de Render y prueba el flujo.

Notas:
- El comando de arranque ya queda configurado en `Dockerfile`.
- En plan free, el disco es efimero: los archivos en `uploads/` y `output/` se pueden perder al reiniciar.

### Opcion 2: Railway (similar a Render)
Tambien funciona con este mismo `Dockerfile` conectando el repo desde Railway.
