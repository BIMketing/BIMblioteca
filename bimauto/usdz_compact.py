"""Convierte un USDZ en texto (el que genera three.js) a USDZ binario (usdc): mismo contenido, mucho menos peso."""
import sys, os, tempfile, zipfile
from pxr import Usd, UsdUtils

src, dst = sys.argv[1], sys.argv[2]
with tempfile.TemporaryDirectory() as tmp:
    zipfile.ZipFile(src).extractall(tmp)
    stage = Usd.Stage.Open(os.path.join(tmp, "model.usda"))
    flat = stage.Flatten()
    usdc = os.path.join(tmp, "model.usdc")
    flat.Export(usdc)
    out = dst + ".tmp.usdz"
    if not UsdUtils.CreateNewARKitUsdzPackage(usdc, out):
        sys.exit("No se pudo empaquetar el USDZ")
    os.replace(out, dst)
