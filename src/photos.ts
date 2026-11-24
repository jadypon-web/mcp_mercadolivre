import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { meliPostForm } from "./meli-client.js";

// Fotos locais: o usuário guarda as fotos de cada produto numa pasta do
// computador ("foto de produtos"). Em vez de mandar a imagem pelo chat
// (caro em tokens), o conector lê o arquivo direto da pasta.

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const SKIP_DIRS = new Set(["appdata", "node_modules", "windows", "program files", "program files (x86)"]);
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function expandPath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

let photosDirCache: string | null | undefined;

// ML_PHOTOS_DIR manda; senão procura uma pasta com "foto" e "produto" no nome
// dentro da pasta do usuário (inclusive OneDrive, Área de Trabalho, Documentos).
export function findPhotosDir(): string | null {
  if (photosDirCache !== undefined) return photosDirCache;
  const env = process.env.ML_PHOTOS_DIR;
  if (env && isDir(expandPath(env))) {
    photosDirCache = expandPath(env);
    return photosDirCache;
  }
  const home = os.homedir();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: home, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    for (const e of listDir(dir)) {
      if (!e.isDirectory()) continue;
      const name = norm(e.name);
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      if (name.includes("foto") && name.includes("produto")) {
        photosDirCache = path.join(dir, e.name);
        return photosDirCache;
      }
      if (depth < 3) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  photosDirCache = null;
  return null;
}

function imagesIn(dir: string): string[] {
  return listDir(dir)
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), "pt-BR", { numeric: true })
    );
}

function findFile(root: string, wanted: string, maxDepth = 4): string | null {
  const target = norm(wanted);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    for (const e of listDir(dir)) {
      if (e.isFile() && norm(e.name) === target) return path.join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

// Acha a subpasta do produto (ex.: "9003" casa com "9003", "SKU 9003", "9003 - Torneira").
function findProductFolder(root: string, name: string): string | null {
  const target = norm(name);
  const exact: string[] = [];
  const partial: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    for (const e of listDir(dir)) {
      if (!e.isDirectory()) continue;
      const n = norm(e.name);
      const full = path.join(dir, e.name);
      if (n === target) exact.push(full);
      else if (n.includes(target)) partial.push(full);
      if (depth < 3) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return exact[0] ?? partial[0] ?? null;
}

const uploaded = new Map<string, string>();

async function uploadFile(file: string): Promise<string> {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.mtimeMs}`;
  const hit = uploaded.get(key);
  if (hit) return hit;
  const ext = path.extname(file).toLowerCase();
  const buffer = fs.readFileSync(file);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: MIME[ext] ?? "application/octet-stream" }),
    path.basename(file)
  );
  const pic = await meliPostForm<Record<string, unknown>>("/pictures", form);
  const id = String(pic.id);
  uploaded.set(key, id);
  return id;
}

const URL_RE = /^https?:\/\//i;
const PICTURE_ID_RE = /^\d+-MLB\d+_\d+$/i;

export function isLocalImageRef(ref: string): boolean {
  return !URL_RE.test(ref) && !PICTURE_ID_RE.test(ref) && IMAGE_EXT.has(path.extname(ref).toLowerCase());
}

// Aceita: URL, id de foto, caminho de arquivo, nome de arquivo (procurado na
// pasta de fotos) ou pasta inteira (todas as imagens, em ordem de nome).
export async function resolvePictureRefs(
  refs: string[] | undefined,
  folder: string | undefined
): Promise<string[]> {
  const out: string[] = [];
  const files: string[] = [];
  const order: Array<string | { file: string }> = [];
  const root = findPhotosDir();

  if (folder) {
    let dir: string | null = isDir(expandPath(folder)) ? expandPath(folder) : null;
    if (!dir && root) dir = findProductFolder(root, folder);
    if (!dir) {
      throw new Error(
        `Pasta de fotos "${folder}" não encontrada${root ? ` dentro de ${root}` : " (pasta de fotos de produtos não localizada; defina ML_PHOTOS_DIR)"}.`
      );
    }
    const imgs = imagesIn(dir);
    if (imgs.length === 0) throw new Error(`A pasta ${dir} não tem imagens.`);
    for (const f of imgs) order.push({ file: f });
  }

  for (const ref of refs ?? []) {
    if (URL_RE.test(ref) || PICTURE_ID_RE.test(ref) || !IMAGE_EXT.has(path.extname(ref).toLowerCase())) {
      order.push(ref);
      continue;
    }
    let file: string | null = fs.existsSync(expandPath(ref)) ? expandPath(ref) : null;
    if (!file && root) file = findFile(root, path.basename(ref));
    if (!file) throw new Error(`Foto "${ref}" não encontrada${root ? ` em ${root}` : ""}.`);
    order.push({ file });
  }

  for (const item of order) if (typeof item !== "string") files.push(item.file);
  const ids = await Promise.all(files.map(uploadFile));
  let i = 0;
  for (const item of order) out.push(typeof item === "string" ? item : ids[i++]);
  return out;
}
