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
from typing import Dict, Any, List

app = FastAPI()

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/output", StaticFiles(directory="output"), name="output")

os.makedirs("output/certificados", exist_ok=True)
os.makedirs("output/previews", exist_ok=True)
os.makedirs("uploads", exist_ok=True)

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


def cargar_registros_excel(file_obj) -> List[Dict[str, str]]:
    df = pd.read_excel(file_obj)

    columnas_requeridas = {"NOMBRE", "CURSO"}
    faltantes = columnas_requeridas.difference(df.columns)
    if faltantes:
        raise HTTPException(
            status_code=400,
            detail=f"Faltan columnas requeridas en Excel: {', '.join(sorted(faltantes))}",
        )

    registros: List[Dict[str, str]] = []
    for _, row in df.iterrows():
        nombre = "" if pd.isna(row["NOMBRE"]) else str(row["NOMBRE"]).strip()
        curso = "" if pd.isna(row["CURSO"]) else str(row["CURSO"]).strip()
        if not nombre and not curso:
            continue
        registros.append({"nombre": nombre, "curso": curso})

    return registros


def render_docx_desde_datos(
    ruta_plantilla: str,
    nombre: str,
    curso: str,
    ruta_docx: str,
    no_valido: bool,
) -> None:
    doc = DocxTemplate(ruta_plantilla)
    doc.render(
        {
            "nombre": nombre,
            "curso": curso,
            "no_valido": no_valido,
            "watermark": "NO VALIDO, DOCUMENTO NO OFICIAL",
        }
    )
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

    registros = cargar_registros_excel(file.file)
    if not registros:
        raise HTTPException(status_code=400, detail="No hay registros validos para previsualizar")

    session_id = uuid.uuid4().hex
    plantilla_id = f"{session_id}_{os.path.basename(plantilla.filename)}"
    ruta_plantilla = os.path.join("uploads", plantilla_id)

    with open(ruta_plantilla, "wb") as f:
        shutil.copyfileobj(plantilla.file, f)

    PREVIEW_SESSIONS[session_id] = {
        "plantilla_path": ruta_plantilla,
        "rows": registros,
    }

    return templates.TemplateResponse(
        "previsualizacion.html",
        {
            "request": request,
            "session_id": session_id,
            "rows": list(enumerate(registros)),
        },
    )


@app.get("/preview/{session_id}/{row_id}")
def preview_pdf(session_id: str, row_id: int, nombre: str, curso: str):
    session = PREVIEW_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sesion de previsualizacion no encontrada")

    if row_id < 0 or row_id >= len(session["rows"]):
        raise HTTPException(status_code=404, detail="Registro no encontrado")

    carpeta_preview = os.path.join("output", "previews", session_id)
    os.makedirs(carpeta_preview, exist_ok=True)

    base_nombre = limpiar_nombre_archivo(f"preview_{row_id}_{nombre}")
    ruta_docx = os.path.join(carpeta_preview, f"{base_nombre}.docx")

    try:
        render_docx_desde_datos(
            session["plantilla_path"],
            nombre=nombre,
            curso=curso,
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
def visor_preview(request: Request, session_id: str, row_id: int, nombre: str, curso: str):
    return templates.TemplateResponse(
        "visor_preview.html",
        {
            "request": request,
            "session_id": session_id,
            "row_id": row_id,
            "nombre": nombre,
            "curso": curso,
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

        nombre = str(form.get(f"nombre_{idx}", session["rows"][idx]["nombre"]))
        curso = str(form.get(f"curso_{idx}", session["rows"][idx]["curso"]))

        nombre_archivo = limpiar_nombre_archivo(nombre)
        ruta_docx = os.path.join("output", "certificados", f"{nombre_archivo}.docx")

        try:
            render_docx_desde_datos(
                session["plantilla_path"],
                nombre=nombre,
                curso=curso,
                ruta_docx=ruta_docx,
                no_valido=False,
            )
            ruta_pdf = convertir_docx_a_pdf(ruta_docx, os.path.join("output", "certificados"))
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))

        generados.append(
            {
                "nombre": nombre,
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
