import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Atalhos por categoria: características que se repetem em todo produto da
// categoria (ex.: tipo de montagem, acabamento). Ficam guardados no
// computador do usuário e evitam reler e reenviar a lista toda a cada anúncio.

export type PresetAttribute = { id: string; value_id?: string; value_name?: string };
export type Preset = {
  category_id: string;
  category_name?: string;
  attributes: PresetAttribute[];
  catalog_hint?: string;
};

function file(): string {
  const dir = path.join(os.homedir(), ".mcp-mercadolivre");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "presets.json");
}

function readAll(): Record<string, Preset> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

export function getPreset(key: string): Preset | undefined {
  return readAll()[key];
}

export function savePreset(key: string, preset: Preset): void {
  const all = readAll();
  all[key] = preset;
  fs.writeFileSync(file(), JSON.stringify(all, null, 1));
}

export function listPresets(): Array<{ key: string; category_id: string; attributes: number }> {
  return Object.entries(readAll()).map(([key, p]) => ({
    key,
    category_id: p.category_id,
    attributes: p.attributes.length,
  }));
}
