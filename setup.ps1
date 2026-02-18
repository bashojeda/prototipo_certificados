param(
    [string]$PythonExe = "python"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command $PythonExe -ErrorAction SilentlyContinue)) {
    Write-Error "No se encontro '$PythonExe' en PATH. Instala Python 3.10+ y vuelve a intentar."
}

if (-not (Test-Path ".venv")) {
    & $PythonExe -m venv .venv
}

$venvPython = Join-Path ".venv" "Scripts\python.exe"

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements.txt

Write-Host ""
Write-Host "Entorno creado e instalado correctamente."
Write-Host "Para ejecutar:"
Write-Host ".\.venv\Scripts\activate"
Write-Host "uvicorn main:app --reload"
