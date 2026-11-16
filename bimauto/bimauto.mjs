/**
 * BIMblioteca · automatización (GitHub Action)
 *
 * Cada vez que se sube un IFC al repositorio:
 *   1. Para la última versión de cada modelo (Nombre_00.ifc, Nombre_01.ifc…), si no existe un .glb / .usdz
 *      con el MISMO nombre (o existe pero está vacío o roto), lo genera a partir del IFC.
 *      Si subes tú un GLB/USDZ optimizado con el mismo nombre que el IFC, se respeta y no se genera.
 *   2. Actualiza la hoja de Google: añade una fila por cada modelo nuevo y rellena/actualiza sus URLs.
 *      Nunca toca Fabricante, Modelo ni Slug de filas que ya existen (puedes renombrarlos a mano).
 *
 * El CMS de Framer y la publicación de la web se siguen haciendo a mano.
 *
 * Variables de entorno (GitHub → Settings → Secrets and variables → Actions):
 *   GOOGLE_SERVICE_ACCOUNT  JSON completo de la clave de la cuenta de servicio (secret)
 *   SHEET_ID                id de la hoja (la parte larga de la URL entre /d/ y /edit)
 *   SHEET_NAME              pestaña de la hoja (por defecto "Hoja 1")
 *   GITHUB_REPOSITORY       lo pone GitHub solo (usuario/repo)
 *   BRANCH                  rama (por defecto main)
 *   ONLY_CONVERT=1          solo genera archivos, sin tocar la hoja (para pruebas locales)
 */
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import * as THREE from "three"
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js"
import { Document, NodeIO } from "@gltf-transform/core"
import { ALL_EXTENSIONS } from "@gltf-transform/extensions"
import { draco, weld, dedup, prune } from "@gltf-transform/functions"
import draco3d from "draco3dgltf"

const require = createRequire(import.meta.url)
const WebIFC = require("web-ifc")

const ROOT = process.env.REPO_ROOT || process.cwd()
const REPO = process.env.GITHUB_REPOSITORY || "BIMketing/BIMblioteca"
const BRANCH = process.env.BRANCH || "main"
const MANIFEST = path.join(ROOT, "bimauto", "generated.json")
const MIN_BYTES = 64

/* ---------------------------------------------------------------- */
/*  Archivos del repositorio                                         */
/* ---------------------------------------------------------------- */

function repoFiles() {
    const out = execSync("git ls-files -z", { cwd: ROOT, maxBuffer: 1 << 28 }).toString("utf8")
    return out.split("\0").filter(Boolean)
}

/** "Carpeta/Fabricante_Modelo_02.ifc" → { key: "carpeta/fabricante_modelo", version: 2 } */
function parseName(p) {
    const ext = path.extname(p)
    const noExt = p.slice(0, -ext.length)
    const m = noExt.match(/^(.*?)(?:[_\- ]v?(\d+))?$/i)
    return { key: (m[1] || noExt).toLowerCase(), version: m[2] ? Number(m[2]) : -1, ext: ext.toLowerCase() }
}

/** Un archivo existe y parece válido (no vacío, cabecera correcta) */
function fileOk(rel) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) return false
    const st = fs.statSync(abs)
    if (st.size < MIN_BYTES) return false
    const fd = fs.openSync(abs, "r")
    const b = Buffer.alloc(4)
    fs.readSync(fd, b, 0, 4, 0)
    fs.closeSync(fd)
    const head = b.toString("latin1")
    if (rel.toLowerCase().endsWith(".glb")) return head === "glTF"
    if (rel.toLowerCase().endsWith(".usdz")) return head.startsWith("PK")
    return true
}

const blobUrl = (rel) =>
    `https://github.com/${REPO}/blob/${BRANCH}/${rel.split("/").map(encodeURIComponent).join("/")}`

/* ---------------------------------------------------------------- */
/*  IFC → mallas (mismo criterio que el visor: web-ifc, Y arriba)     */
/* ---------------------------------------------------------------- */

let ifcApi = null
async function getIfcApi() {
    if (ifcApi) return ifcApi
    ifcApi = new WebIFC.IfcAPI()
    ifcApi.SetWasmPath(path.dirname(require.resolve("web-ifc")) + "/", true)
    await ifcApi.Init()
    return ifcApi
}

/** Devuelve las mallas agrupadas por color: [{ color:[r,g,b] (sRGB), opacity, pos, nor, idx }] */
async function ifcToGroups(bytes) {
    const api = await getIfcApi()
    const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 12 })
    const groups = new Map()
    const mtx = new THREE.Matrix4()
    const nmx = new THREE.Matrix3()
    const v = new THREE.Vector3()
    api.StreamAllMeshes(id, (fm) => {
        const n = fm.geometries.size()
        for (let i = 0; i < n; i++) {
            const pg = fm.geometries.get(i)
            const g = api.GetGeometry(id, pg.geometryExpressID)
            const va = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize())
            const ia = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize())
            mtx.fromArray(pg.flatTransformation)
            nmx.getNormalMatrix(mtx)
            const c = pg.color
            const key = [c.x, c.y, c.z, c.w].map((x) => x.toFixed(3)).join(",")
            let gr = groups.get(key)
            if (!gr) groups.set(key, (gr = { color: [c.x, c.y, c.z], opacity: c.w, pos: [], nor: [], idx: [] }))
            const base = gr.pos.length / 3
            for (let k = 0; k < va.length; k += 6) {
                v.set(va[k], va[k + 1], va[k + 2]).applyMatrix4(mtx)
                gr.pos.push(v.x, v.y, v.z)
                v.set(va[k + 3], va[k + 4], va[k + 5]).applyMatrix3(nmx).normalize()
                gr.nor.push(v.x, v.y, v.z)
            }
            for (let k = 0; k < ia.length; k++) gr.idx.push(ia[k] + base)
            g.delete?.()
        }
    })
    api.CloseModel(id)
    const list = [...groups.values()].filter((g) => g.idx.length).map(weldGroup)
    if (!list.length) throw new Error("El IFC no tiene geometría visible")
    // Apoyado en el suelo (y = 0) y centrado en planta, como espera el AR
    const box = new THREE.Box3()
    for (const g of list)
        for (let k = 0; k < g.pos.length; k += 3) box.expandByPoint(v.set(g.pos[k], g.pos[k + 1], g.pos[k + 2]))
    const cx = (box.min.x + box.max.x) / 2
    const cz = (box.min.z + box.max.z) / 2
    for (const g of list)
        for (let k = 0; k < g.pos.length; k += 3) {
            g.pos[k] -= cx
            g.pos[k + 1] -= box.min.y
            g.pos[k + 2] -= cz
        }
    return list
}

/** Une vértices repetidos (misma posición y normal): el IFC los duplica por cara y engorda los archivos */
function weldGroup(g) {
    const map = new Map()
    const pos = []
    const nor = []
    const remap = new Uint32Array(g.pos.length / 3)
    for (let i = 0; i < g.pos.length / 3; i++) {
        const k =
            Math.round(g.pos[i * 3] * 1e4) + "," + Math.round(g.pos[i * 3 + 1] * 1e4) + "," + Math.round(g.pos[i * 3 + 2] * 1e4) + "|" +
            Math.round(g.nor[i * 3] * 100) + "," + Math.round(g.nor[i * 3 + 1] * 100) + "," + Math.round(g.nor[i * 3 + 2] * 100)
        let j = map.get(k)
        if (j == null) {
            j = pos.length / 3
            map.set(k, j)
            pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2])
            nor.push(g.nor[i * 3], g.nor[i * 3 + 1], g.nor[i * 3 + 2])
        }
        remap[i] = j
    }
    const idx = []
    for (let t = 0; t < g.idx.length; t += 3) {
        const a = remap[g.idx[t]], b = remap[g.idx[t + 1]], c = remap[g.idx[t + 2]]
        if (a !== b && b !== c && a !== c) idx.push(a, b, c) // fuera triángulos degenerados
    }
    return { ...g, pos, nor, idx }
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

/** Mallas → GLB (una malla por color, materiales PBR simples, doble cara) */
async function groupsToGlb(groups, name) {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const scene = doc.createScene(name)
    const root = doc.createNode(name)
    scene.addChild(root)
    groups.forEach((g, i) => {
        const transparent = g.opacity < 0.99
        const mat = doc
            .createMaterial(`Material_${i}`)
            .setBaseColorFactor([...g.color.map(srgbToLinear), Math.max(g.opacity, 0.15)])
            .setRoughnessFactor(0.85)
            .setMetallicFactor(0)
            .setDoubleSided(true)
            .setAlphaMode(transparent ? "BLEND" : "OPAQUE")
        const nVerts = g.pos.length / 3
        const prim = doc
            .createPrimitive()
            .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(g.pos)).setBuffer(buffer))
            .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(g.nor)).setBuffer(buffer))
            .setIndices(
                doc
                    .createAccessor()
                    .setType("SCALAR")
                    .setArray(nVerts > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx))
                    .setBuffer(buffer)
            )
            .setMaterial(mat)
        root.addChild(doc.createNode(`Parte_${i}`).setMesh(doc.createMesh(`Malla_${i}`).addPrimitive(prim)))
    })
    // Compresión Draco: el GLB pesa una fracción (model-viewer y el AR de Google la admiten)
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        "draco3d.encoder": await draco3d.createEncoderModule(),
        "draco3d.decoder": await draco3d.createDecoderModule(),
    })
    await doc.transform(dedup(), prune(), draco({ quantizePosition: 16, quantizeNormal: 10 }))
    return Buffer.from(await io.writeBinary(doc))
}

/** Mallas → USDZ (Quick Look de iPhone/iPad) */
async function groupsToUsdz(groups) {
    const scene = new THREE.Scene()
    for (const g of groups) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3))
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(g.nor, 3))
        geo.setIndex(g.idx)
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color().setRGB(g.color[0], g.color[1], g.color[2], THREE.SRGBColorSpace),
            roughness: 0.85,
            metalness: 0,
            transparent: g.opacity < 0.99,
            opacity: Math.max(g.opacity, 0.15),
        })
        scene.add(new THREE.Mesh(geo, mat))
    }
    scene.updateMatrixWorld(true)
    const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true })
    return Buffer.from(data)
}

/** USDZ en texto → USDZ binario con la librería oficial de Pixar (usd-core): ~3-4 veces menos peso */
function compactUsdz(file) {
    try {
        execSync(`python3 ${JSON.stringify(path.join(path.dirname(new URL(import.meta.url).pathname), "usdz_compact.py"))} ${JSON.stringify(file)} ${JSON.stringify(file)}`, {
            stdio: "pipe",
        })
        return true
    } catch (e) {
        console.warn("  (USDZ sin compactar: falta usd-core)", String(e.stderr || e.message).split("\n")[0])
        return false
    }
}

/* ---------------------------------------------------------------- */
/*  Generación de archivos                                           */
/* ---------------------------------------------------------------- */

function loadManifest() {
    try {
        return new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8")))
    } catch {
        return new Set()
    }
}

async function generate() {
    const files = repoFiles()
    const generated = loadManifest()
    // Última versión de cada modelo IFC
    const latest = new Map()
    for (const f of files) {
        if (!f.toLowerCase().endsWith(".ifc")) continue
        const p = parseName(f)
        const cur = latest.get(p.key)
        if (!cur || p.version > cur.version) latest.set(p.key, { ...p, file: f })
    }
    // Si ya hay un GLB/USDZ válido del mismo modelo con versión igual o posterior al IFC (p. ej. uno optimizado
    // que subiste tú como _01 junto a un IFC _00), se usa ese y no se genera nada
    const own = (key, ext, minVersion) => {
        let best = null
        for (const f of files) {
            if (!f.toLowerCase().endsWith(ext) || generated.has(f)) continue
            const p = parseName(f)
            if (p.key !== key || p.version < minVersion || !fileOk(f)) continue
            if (!best || p.version > best.version) best = { file: f, version: p.version }
        }
        return best?.file || ""
    }
    const models = []
    for (const m of latest.values()) {
        const base = m.file.slice(0, -4)
        const ownGlb = own(m.key, ".glb", m.version)
        const ownUsdz = own(m.key, ".usdz", m.version)
        const glb = ownGlb || base + ".glb"
        const usdz = ownUsdz || base + ".usdz"
        const needGlb = !fileOk(glb)
        const needUsdz = !fileOk(usdz)
        if (needGlb || needUsdz) {
            console.log(`· ${m.file}: generando${needGlb ? " GLB" : ""}${needUsdz ? " USDZ" : ""}…`)
            try {
                const groups = await ifcToGroups(new Uint8Array(fs.readFileSync(path.join(ROOT, m.file))))
                if (needGlb) {
                    fs.writeFileSync(path.join(ROOT, glb), await groupsToGlb(groups, path.basename(base)))
                    generated.add(glb)
                }
                if (needUsdz) {
                    const abs = path.join(ROOT, usdz)
                    fs.writeFileSync(abs, await groupsToUsdz(groups))
                    compactUsdz(abs)
                    // GitHub no admite archivos de más de 100 MB
                    if (fs.statSync(abs).size > 95 * 1048576) {
                        fs.rmSync(abs)
                        console.warn("  ✗ El USDZ supera los 95 MB: no se sube (el visor lo generará en el iPhone)")
                    } else generated.add(usdz)
                }
            } catch (e) {
                console.error(`  ✗ No se pudo convertir ${m.file}: ${e.message}`)
            }
        }
        models.push({ ...m, glb: fileOk(glb) ? glb : "", usdz: fileOk(usdz) ? usdz : "" })
    }
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
    fs.writeFileSync(MANIFEST, JSON.stringify([...generated].sort(), null, 2) + "\n")
    return { models, generated }
}

/* ---------------------------------------------------------------- */
/*  Hoja de Google                                                   */
/* ---------------------------------------------------------------- */

/** URL (de GitHub, jsDelivr, Pages…) → ruta dentro del repositorio */
function urlToRel(url) {
    if (!url) return ""
    let m =
        url.match(/github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/[^/]+\/([^?#]+)/i) ||
        url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:refs\/heads\/)?[^/]+\/([^?#]+)/i) ||
        url.match(/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@[^/]+\/([^?#]+)/i) ||
        url.match(/[^./]+\.github\.io\/[^/]+\/([^?#]+)/i)
    if (!m) return ""
    try {
        return decodeURIComponent(m[1])
    } catch {
        return m[1]
    }
}

const slugify = (s) =>
    s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

/** "BIMketing/Logo/BIMketing_Logo 3D_00.ifc" → { fabricante: "BIMketing", modelo: "Logo 3D" } */
function guessNames(rel) {
    const parts = rel.split("/")
    const fabricante = parts.length > 1 ? parts[0] : ""
    let name = path.basename(rel, path.extname(rel)).replace(/[_\- ]v?\d+$/i, "")
    if (fabricante && name.toLowerCase().startsWith(fabricante.toLowerCase() + "_")) name = name.slice(fabricante.length + 1)
    return { fabricante, modelo: name.replace(/_/g, " ").trim() }
}

/** Calcula los cambios de la hoja (separado para poder probarlo sin Google) */
export function planSheet(rows, models, generated, tab = "Hoja 1") {
    const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase())
    const col = (name) => header.indexOf(name.toLowerCase())
    const C = {
        fab: col("Fabricante"),
        mod: col("Modelo"),
        slug: col("Slug"),
        ifc: col("URL IFC"),
        glb: col("URL GLB"),
        usdz: col("URL USDZ"),
    }
    for (const [k, v] of Object.entries(C)) if (v < 0) throw new Error(`La hoja no tiene la columna de ${k}`)

    // Índice de filas por modelo (clave de la URL del IFC, sin versión)
    const byKey = new Map()
    rows.slice(1).forEach((r, i) => {
        const rel = urlToRel(r[C.ifc] || "")
        if (rel) byKey.set(parseName(rel).key, i + 1)
    })

    const updates = []
    const appends = []
    const set = (rowIdx, c, value) => {
        const a1 = `'${tab}'!${String.fromCharCode(65 + c)}${rowIdx + 1}`
        updates.push({ range: a1, values: [[value]] })
    }
    for (const m of models) {
        const urlIfc = blobUrl(m.file)
        const urlGlb = m.glb ? blobUrl(m.glb) : ""
        const urlUsdz = m.usdz ? blobUrl(m.usdz) : ""
        const rowIdx = byKey.get(m.key)
        if (rowIdx == null) {
            const { fabricante, modelo } = guessNames(m.file)
            const r = []
            r[C.fab] = fabricante
            r[C.mod] = modelo
            r[C.slug] = slugify(`${fabricante} ${modelo}`)
            r[C.ifc] = urlIfc
            r[C.glb] = urlGlb
            r[C.usdz] = urlUsdz
            appends.push(Array.from({ length: Math.max(...Object.values(C)) + 1 }, (_, i) => r[i] ?? ""))
            console.log(`+ Fila nueva: ${fabricante} · ${modelo}`)
            continue
        }
        const row = rows[rowIdx] || []
        if ((row[C.ifc] || "") !== urlIfc) set(rowIdx, C.ifc, urlIfc)
        // GLB / USDZ: se rellena si está vacío, si apunta a un archivo roto o a uno generado aquí antes.
        // Un archivo tuyo con otro nombre se respeta.
        for (const [c, url, rel] of [
            [C.glb, urlGlb, m.glb],
            [C.usdz, urlUsdz, m.usdz],
        ]) {
            if (!rel) continue
            const cur = row[c] || ""
            const curRel = urlToRel(cur)
            // También se sustituye un archivo tuyo de una versión anterior del mismo modelo (p. ej. _00.glb con _02.ifc)
            const curP = curRel ? parseName(curRel) : null
            const older = !!curP && curP.key === m.key && curP.version < m.version
            const replace = !cur || !curRel || !fileOk(curRel) || generated.has(curRel) || older
            if (replace && cur !== url) set(rowIdx, c, url)
        }
    }
    return { updates, appends }
}

async function updateSheet(models, generated) {
    const { google } = await import("googleapis")
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}")
    if (!credentials.client_email) throw new Error("Falta el secret GOOGLE_SERVICE_ACCOUNT")
    const sheetId = process.env.SHEET_ID
    if (!sheetId) throw new Error("Falta SHEET_ID")
    const tab = process.env.SHEET_NAME || "Hoja 1"
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
    const sheets = google.sheets({ version: "v4", auth })
    const range = `'${tab}'!A1:Z`
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values || []
    const { updates, appends } = planSheet(rows, models, generated, tab)
    if (updates.length)
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: { valueInputOption: "RAW", data: updates },
        })
    if (appends.length)
        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: appends },
        })
    console.log(`Hoja: ${updates.length} celdas actualizadas, ${appends.length} filas nuevas`)
}

/* ---------------------------------------------------------------- */

// (BIMAUTO_TEST=1 solo carga las funciones, para pruebas)
if (process.env.BIMAUTO_TEST !== "1") {
    const { models, generated } = await generate()
    console.log(`${models.length} modelos IFC revisados`)
    if (process.env.ONLY_CONVERT !== "1") await updateSheet(models, generated)
}
export { fileOk, parseName }
