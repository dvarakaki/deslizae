# Receita do PyInstaller para gerar dist/Deslizae.exe (arquivo único).
#
#   python -m PyInstaller packaging/deslizae.spec --noconfirm
#
# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

ROOT = Path(SPECPATH).parent  # noqa: F821 — SPECPATH é definido pelo PyInstaller
sys.path.insert(0, str(ROOT))
from deslizae import __version__  # noqa: E402

# Versão nas propriedades do arquivo (botão direito → Propriedades → Detalhes).
parts = tuple(int(p) for p in __version__.split(".")) + (0,) * (4 - len(__version__.split(".")))
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=parts, prodvers=parts),
    kids=[
        StringFileInfo([
            StringTable("041604B0", [
                StringStruct("CompanyName", "Deslizae"),
                StringStruct("FileDescription", "Deslizae - celular como touchpad do PC"),
                StringStruct("FileVersion", __version__),
                StringStruct("InternalName", "Deslizae"),
                StringStruct("LegalCopyright", "Licença MIT"),
                StringStruct("OriginalFilename", "Deslizae.exe"),
                StringStruct("ProductName", "Deslizae"),
                StringStruct("ProductVersion", __version__),
            ])
        ]),
        VarFileInfo([VarStruct("Translation", [0x0416, 1200])]),
    ],
)

a = Analysis(
    [str(ROOT / "packaging" / "entry.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "deslizae" / "static"), "deslizae/static")],
    # O WebRTC carrega partes do aiortc/aioice dinamicamente.
    hiddenimports=collect_submodules("aiortc") + collect_submodules("aioice"),
    excludes=["tkinter", "pytest", "unittest", "pydoc"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Deslizae",
    icon=str(ROOT / "packaging" / "deslizae.ico"),
    version=version_info,
    console=True,  # a janela mostra o QR code e os avisos; fechá-la encerra o agente
    upx=False,     # UPX aumenta falsos positivos de antivírus
    runtime_tmpdir=None,
)
