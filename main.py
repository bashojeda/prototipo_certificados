from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
import pandas as pd
import os
from docxtpl import DocxTemplate
import shutil
import subprocess
import uuid
import re
import zipfile
import json
from typing import Dict, Any, List, Set

app = FastAPI()

templates = Jinja2Templates(directory="templates")

# Crear directorios antes de montarlos como archivos estáticos
os.makedirs("output/certificados", exist_ok=True)
os.makedirs("output/previews", exist_ok=True)
os.makedirs("uploads", exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/output", StaticFiles(directory="output"), name="output")

PREVIEW_SESSIONS: Dict[str, Dict[str, Any]] = {}


def convertir_docx_a_pdf(ruta_docx: str, carpeta_salida: str) -> str:
    """
    Convierte un DOCX a PDF usando LibreOffice (soffice).
    Devuelve la ruta del PDF generado.
    """
    exe = os.getenv("SOFFICE_PATH", "soffice")
    comando = [
        exe,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        carpeta_salida,
        ruta_docx,
    ]

    try:
        subprocess.run(comando, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise RuntimeError(
            "No se encontro LibreOffice. Define SOFFICE_PATH o agrega 'soffice' al PATH."
        )
    except subprocess.CalledProcessError as exc:
        salida = exc.stderr.decode(errors="ignore")
        raise RuntimeError(f"Error al convertir a PDF: {salida}")

    base = os.path.splitext(os.path.basename(ruta_docx))[0]
    return os.path.join(carpeta_salida, f"{base}.pdf")


def limpiar_nombre_archivo(nombre: str) -> str:
    limpio = re.sub(r'[\\/:*?"<>|]+', "_", str(nombre)).strip()
    return limpio or "certificado"


def extraer_variables_plantilla(ruta_plantilla: str) -> Set[str]:
    """
    Extrae todas las variables {{variable}} de una plantilla DOCX.
    Lee el XML interno del DOCX (que es un ZIP) y busca patrones.
    """
    variables = set()
    try:
        with zipfile.ZipFile(ruta_plantilla, 'r') as docx:
            # Los documentos DOCX tienen el contenido en document.xml
            with docx.open('word/document.xml') as xml_file:
                contenido = xml_file.read().decode('utf-8')
                # Buscar patrones {{ variable }}
                matches = re.findall(r'\{\{\s*(\w+)\s*\}\}', contenido)
                variables.update(matches)
    except Exception as e:
        print(f"Error extrayendo variables: {e}")
    
    return variables


def cargar_registros_excel(file_obj, variables_requeridas: Set[str]) -> List[Dict[str, str]]:
    """
    Carga registros desde Excel detectando dinámicamente las columnas necesarias.
    """
    df = pd.read_excel(file_obj)
    
    # Hacer case-insensitive: crear mapeo de columnas en minúsculas
    df_columns_lower = {col.lower(): col for col in df.columns}
    
    # Buscar columnas (case-insensitive)
    faltantes = []
    columnas_mapeo = {}
    
    for var in variables_requeridas:
        var_lower = var.lower()
        if var_lower in df_columns_lower:
            columnas_mapeo[var] = df_columns_lower[var_lower]
        else:
            faltantes.append(var)
    
    if faltantes:
        raise HTTPException(
            status_code=400,
            detail=f"Faltan columnas en Excel: {', '.join(sorted(faltantes))}. Se esperaban: {', '.join(sorted(variables_requeridas))}",
        )

    registros: List[Dict[str, str]] = []
    for _, row in df.iterrows():
        registro = {}
        tiene_datos = False
        
        for var, col_real in columnas_mapeo.items():
            valor = "" if pd.isna(row[col_real]) else str(row[col_real]).strip()
            registro[var] = valor
            if valor:
                tiene_datos = True
        
        if tiene_datos:
            registros.append(registro)

    return registros


def render_docx_desde_datos(
    ruta_plantilla: str,
    datos: Dict[str, str],
    ruta_docx: str,
    no_valido: bool,
) -> None:
    """
    Renderiza DOCX con datos dinámicos.
    datos debe ser un diccionario con las variables de la plantilla.
    """
    doc = DocxTemplate(ruta_plantilla)
    
    # Preparar contexto: agregar variables dinámicas + no_valido
    contexto = dict(datos)
    contexto["no_valido"] = no_valido
    if no_valido:
        contexto["watermark"] = "NO VALIDO, DOCUMENTO NO OFICIAL"
    
    doc.render(contexto)
    doc.save(ruta_docx)


@app.get("/", response_class=HTMLResponse)
def formulario(request: Request):
    return templates.TemplateResponse("formulario.html", {"request": request})


@app.post("/previsualizar", response_class=HTMLResponse)
async def previsualizar(
    request: Request,
    file: UploadFile = File(...),
    plantilla: UploadFile = File(...),
):
    if not plantilla.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="La plantilla debe ser un archivo .docx")

    # Guardar plantilla temporalmente para extraer variables
    session_id = uuid.uuid4().hex
    plantilla_id = f"{session_id}_{os.path.basename(plantilla.filename)}"
    ruta_plantilla = os.path.join("uploads", plantilla_id)

    with open(ruta_plantilla, "wb") as f:
        await plantilla.seek(0)
        shutil.copyfileobj(plantilla.file, f)

    # Extraer variables de la plantilla
    variables = extraer_variables_plantilla(ruta_plantilla)
    if not variables:
        raise HTTPException(status_code=400, detail="No se encontraron variables en la plantilla DOCX")

    # Cargar Excel con las variables detectadas
    registros = cargar_registros_excel(file.file, variables)
    if not registros:
        raise HTTPException(status_code=400, detail="No hay registros validos para previsualizar")

    PREVIEW_SESSIONS[session_id] = {
        "plantilla_path": ruta_plantilla,
        "rows": registros,
        "variables": variables,
    }

    return templates.TemplateResponse(
        "previsualizacion.html",
        {
            "request": request,
            "session_id": session_id,
            "rows": list(enumerate(registros)),
            "variables": sorted(variables),
            "variables_json": json.dumps(sorted(variables)),
        },
    )


@app.get("/preview/{session_id}/{row_id}")
async def preview_pdf(request: Request, session_id: str, row_id: int):
    session = PREVIEW_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sesion de previsualizacion no encontrada")

    if row_id < 0 or row_id >= len(session["rows"]):
        raise HTTPException(status_code=404, detail="Registro no encontrado")

    # Obtener datos del registro
    registro_base = session["rows"][row_id]
    
    # Obtener datos editados del formulario si existen
    query_params = request.query_params
    datos = {}
    for var in session["variables"]:
        # Buscar en query params o usar el valor base
        datos[var] = query_params.get(var, registro_base.get(var, ""))

    carpeta_preview = os.path.join("output", "previews", session_id)
    os.makedirs(carpeta_preview, exist_ok=True)

    # Usar primera variable para nombrar archivo
    primera_var = list(session["variables"])[0] if session["variables"] else "preview"
    base_nombre = limpiar_nombre_archivo(f"preview_{row_id}_{datos.get(primera_var, '')}")
    ruta_docx = os.path.join(carpeta_preview, f"{base_nombre}.docx")

    try:
        render_docx_desde_datos(
            session["plantilla_path"],
            datos=datos,
            ruta_docx=ruta_docx,
            no_valido=True,
        )
        ruta_pdf = convertir_docx_a_pdf(ruta_docx, carpeta_preview)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    filename = os.path.basename(ruta_pdf)
    return FileResponse(
        path=ruta_pdf,
        media_type="application/pdf",
        filename=filename,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.get("/visor-preview/{session_id}/{row_id}", response_class=HTMLResponse)
def visor_preview(request: Request, session_id: str, row_id: int):
    session = PREVIEW_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sesion no encontrada")
    
    # Obtener datos editados desde query params
    query_params = request.query_params
    datos = {}
    for var in session["variables"]:
        datos[var] = query_params.get(var, session["rows"][row_id].get(var, ""))
    
    return templates.TemplateResponse(
        "visor_preview.html",
        {
            "request": request,
            "session_id": session_id,
            "row_id": row_id,
            "datos": datos,
            "datos_json": json.dumps(datos),
            "variables": sorted(session["variables"]),
        },
    )


@app.post("/generar-final", response_class=HTMLResponse)
async def generar_final(
    request: Request,
    session_id: str = Form(...),
    selected_ids: List[str] = Form(default=[]),
):
    session = PREVIEW_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sesion de previsualizacion no encontrada")

    form = await request.form()

    ids_seleccionados = selected_ids
    if isinstance(ids_seleccionados, str):
        ids_seleccionados = [ids_seleccionados]

    if not ids_seleccionados:
        raise HTTPException(status_code=400, detail="Debes seleccionar al menos un certificado")

    generados = []
    for id_txt in ids_seleccionados:
        idx = int(id_txt)
        if idx < 0 or idx >= len(session["rows"]):
            continue

        # Construir datos dinámicamente desde el formulario
        datos = {}
        for var in session["variables"]:
            valor_form = form.get(f"{var}_{idx}")
            datos[var] = str(valor_form) if valor_form else session["rows"][idx].get(var, "")

        # Usar primera variable para nombrar archivo
        primera_var = list(session["variables"])[0] if session["variables"] else "certificado"
        nombre_archivo = limpiar_nombre_archivo(datos.get(primera_var, "certificado"))
        ruta_docx = os.path.join("output", "certificados", f"{nombre_archivo}.docx")

        try:
            render_docx_desde_datos(
                session["plantilla_path"],
                datos=datos,
                ruta_docx=ruta_docx,
                no_valido=False,
            )
            ruta_pdf = convertir_docx_a_pdf(ruta_docx, os.path.join("output", "certificados"))
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))

        generados.append(
            {
                "nombre": nombre_archivo,
                "pdf": "/output/certificados/" + os.path.basename(ruta_pdf),
                "docx": "/output/certificados/" + os.path.basename(ruta_docx),
            }
        )

    return templates.TemplateResponse(
        "resultado.html",
        {
            "request": request,
            "generados": generados,
        },
    )
