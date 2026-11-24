import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Plugin do UpSeller para quem NÃO tem a API (plano Inicial): monta a planilha
// de importação de produtos no modelo do próprio UpSeller. O usuário só
// importa o arquivo em Produtos do Armazém > Importar.

const HOME = path.join(os.homedir(), ".upseller-planilha");
const CONFIG = path.join(HOME, "config.json");

type Fiscal = { ncm?: string; cest?: string; origem?: string };
type Config = {
  modelo?: string;
  ultimo_sku?: number;
  padroes?: { fornecedor?: string; origem?: string; estoque?: number; categoria?: string };
  fiscal?: Record<string, Fiscal>;
};

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(c: Config) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
}

const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Erro: ${(e as Error).message}` }],
});

// --- Campos conhecidos e como as colunas do modelo costumam se chamar -------

type Campo =
  | "sku" | "titulo" | "custo" | "preco_varejo" | "peso_g" | "comprimento_cm"
  | "largura_cm" | "altura_cm" | "gtin" | "ncm" | "cest" | "origem" | "fornecedor"
  | "link_fornecedor" | "imagem" | "categoria" | "apelido" | "estoque" | "marca";

// Termos (já sem acento e minúsculos) que identificam cada campo no cabeçalho.
const SINONIMOS: Record<Campo, string[]> = {
  sku: ["sku"],
  titulo: ["titulo do produto", "nome do produto", "titulo", "nome"],
  custo: ["custo de compra", "preco de custo", "custo"],
  preco_varejo: ["preco de varejo", "preco de venda", "preco"],
  peso_g: ["peso"],
  comprimento_cm: ["comprimento", "profundidade"],
  largura_cm: ["largura"],
  altura_cm: ["altura"],
  gtin: ["codigo de barras", "gtin", "ean", "barcode", "upc"],
  ncm: ["ncm"],
  cest: ["cest"],
  origem: ["origem"],
  fornecedor: ["fornecedor"],
  link_fornecedor: ["link do fornecedor", "link de origem", "url do fornecedor", "link da fonte", "link"],
  imagem: ["imagem", "foto"],
  categoria: ["categoria"],
  apelido: ["apelido"],
  estoque: ["estoque inicial", "estoque"],
  marca: ["marca"],
};

// Ordem de teste: nomes mais específicos primeiro, para "link do fornecedor" não
// ser tomado como "fornecedor" e "preço de custo" não ser tomado como "preço".
const ORDEM: Campo[] = [
  "link_fornecedor", "custo", "preco_varejo", "titulo", "comprimento_cm", "largura_cm",
  "altura_cm", "peso_g", "gtin", "ncm", "cest", "origem", "fornecedor", "imagem",
  "categoria", "apelido", "estoque", "marca", "sku",
];

function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[*:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    return "";
  }
  return String(v);
}

function campoDoCabecalho(h: string): Campo | undefined {
  const n = norm(h);
  if (!n) return undefined;
  // Unidade entre parênteses não atrapalha: "Peso (g)" -> "peso".
  const semParenteses = n.replace(/\(.*?\)/g, "").trim();
  for (const campo of ORDEM) {
    for (const termo of SINONIMOS[campo]) {
      if (semParenteses === termo || semParenteses.startsWith(termo) || n.includes(termo)) {
        if (campo === "sku" && semParenteses.includes("sku") && /(loja|anuncio|pai|spu)/.test(semParenteses)) continue;
        return campo;
      }
    }
  }
  return undefined;
}

type Mapa = { ws: ExcelJS.Worksheet; linhaCab: number; colunas: Map<Campo, number>; naoMapeadas: string[]; todas: string[] };

function acharCabecalho(wb: ExcelJS.Workbook, aba?: string): Mapa {
  const abas = aba ? wb.worksheets.filter((w) => w.name === aba) : wb.worksheets;
  if (abas.length === 0) throw new Error(`Aba "${aba}" não existe no modelo.`);
  let melhor: Mapa | undefined;
  for (const ws of abas) {
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
      const colunas = new Map<Campo, number>();
      const todas: string[] = [];
      const naoMapeadas: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell.value).trim();
        if (!t) return;
        todas.push(t);
        const campo = campoDoCabecalho(t);
        if (campo && !colunas.has(campo)) colunas.set(campo, col);
        else naoMapeadas.push(t);
      });
      if (!melhor || colunas.size > melhor.colunas.size) {
        melhor = { ws, linhaCab: r, colunas, naoMapeadas, todas };
      }
    }
  }
  if (!melhor || melhor.colunas.size < 2) {
    throw new Error("Não reconheci as colunas desse modelo. Use modelo_colunas para ver os cabeçalhos.");
  }
  return melhor;
}

async function abrir(modelo: string): Promise<ExcelJS.Workbook> {
  if (!fs.existsSync(modelo)) throw new Error(`Modelo não encontrado: ${modelo}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(modelo);
  return wb;
}

const EXPAND = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

// O modelo pode ser: um arquivo .xlsx, uma pasta (vale o .xlsx mais recente
// com cara de modelo) ou nada (usa o guardado; se não houver, procura em
// Downloads, Área de Trabalho e OneDrive o modelo baixado do UpSeller).
function modeloMaisRecente(dir: string): string | undefined {
  let melhor: { f: string; t: number } | undefined;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.xlsx$/i.test(e.name) || e.name.startsWith("~$")) continue;
      if (/^importar-upseller_/i.test(e.name)) continue;
      const f = path.join(dir, e.name);
      const t = fs.statSync(f).mtimeMs;
      const pontos = /(modelo|template|produto|import|criar|sku)/i.test(e.name) ? 1e15 : 0;
      if (!melhor || t + pontos > melhor.t) melhor = { f, t: t + pontos };
    }
  } catch {
    /* pasta inexistente */
  }
  return melhor?.f;
}

function resolverModelo(modelo?: string): string {
  const dado = modelo ? EXPAND(modelo) : undefined;
  if (dado && fs.existsSync(dado) && fs.statSync(dado).isDirectory()) {
    const f = modeloMaisRecente(dado);
    if (f) return f;
  } else if (dado) {
    return dado;
  }
  const guardado = readConfig().modelo;
  if (guardado && fs.existsSync(guardado)) return guardado;
  const home = os.homedir();
  const pastas = [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "OneDrive", "Área de Trabalho"),
    path.join(home, "OneDrive", "Desktop"),
    path.join(home, "OneDrive", "Downloads"),
  ];
  let achado: { f: string; t: number } | undefined;
  for (const d of pastas) {
    const f = modeloMaisRecente(d);
    if (f) {
      const t = fs.statSync(f).mtimeMs;
      if (!achado || t > achado.t) achado = { f, t };
    }
  }
  if (achado) return achado.f;
  throw new Error("Não achei o modelo de planilha do UpSeller (baixe em Produtos do Armazém > Importar > Baixar o Modelo).");
}

// --- Servidor --------------------------------------------------------------

const server = new McpServer({ name: "upseller-planilha", version: "0.1.0" });

server.registerTool(
  "modelo_colunas",
  {
    description:
      "Lê o modelo .xlsx de importação do UpSeller, mostra colunas reconhecidas e não reconhecidas e guarda o caminho. Use na primeira vez ou se o modelo mudar.",
    inputSchema: {
      modelo: z.string().optional(),
      aba: z.string().optional(),
    },
  },
  async ({ modelo, aba }) => {
    try {
      const caminho = resolverModelo(modelo);
      const wb = await abrir(caminho);
      const m = acharCabecalho(wb, aba);
      writeConfig({ ...readConfig(), modelo: caminho });
      return text({
        abas: wb.worksheets.map((w) => w.name),
        aba_usada: m.ws.name,
        linha_cabecalho: m.linhaCab,
        reconhecidas: Object.fromEntries([...m.colunas].map(([c, i]) => [c, m.ws.getRow(m.linhaCab).getCell(i).text])),
        nao_reconhecidas: m.naoMapeadas,
        linhas_abaixo_do_cabecalho: Math.max(0, m.ws.rowCount - m.linhaCab),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

const produto = z.object({
  sku: z.string(),
  titulo: z.string(),
  custo: z.number().describe("Custo unitário em R$, da fonte (nunca estimado)"),
  peso_g: z.number().describe("gramas, arredondado para cima"),
  comprimento_cm: z.number(),
  largura_cm: z.number(),
  altura_cm: z.number(),
  gtin: z.string().optional(),
  tipo: z.string().optional().describe("Tipo do produto (ex.: torneira): preenche NCM/CEST/origem guardados por guardar_fiscal"),
  ncm: z.string().optional(),
  cest: z.string().optional(),
  origem: z.string().optional(),
  fornecedor: z.string().optional(),
  link_fornecedor: z.string().optional(),
  imagem: z.string().optional(),
  categoria: z.string().optional(),
  apelido: z.string().optional(),
  marca: z.string().optional(),
  estoque: z.number().optional(),
  preco_varejo: z.number().optional(),
});

server.registerTool(
  "gerar_planilha",
  {
    description:
      "Preenche o modelo de importação do UpSeller e salva um arquivo novo. Obrigatórios: sku, titulo, custo, peso e 3 medidas; se faltar algo em qualquer produto, nada é gerado e todas as pendências voltam de uma vez. Valores padrão (definir_padroes) e NCM/CEST por tipo (guardar_fiscal) são preenchidos sozinhos. Nunca invente valores.",
    inputSchema: {
      produtos: z.array(produto).min(1).max(200),
      modelo: z.string().optional(),
      aba: z.string().optional(),
      pasta_saida: z.string().optional(),
    },
  },
  async ({ produtos, modelo, aba, pasta_saida }) => {
    try {
      const caminho = resolverModelo(modelo);

      const cfg = readConfig();
      const semFiscal = new Set<string>();
      for (const p of produtos) {
        const f = p.tipo ? cfg.fiscal?.[norm(p.tipo)] : undefined;
        if (p.tipo && !f) semFiscal.add(p.tipo);
        p.ncm ??= f?.ncm;
        p.cest ??= f?.cest;
        p.origem ??= f?.origem ?? cfg.padroes?.origem;
        p.fornecedor ??= cfg.padroes?.fornecedor;
        p.categoria ??= cfg.padroes?.categoria;
        p.estoque ??= cfg.padroes?.estoque;
      }

      const pendencias: string[] = [];
      const skus = new Set<string>();
      for (const p of produtos) {
        const falta: string[] = [];
        if (!p.sku.trim()) falta.push("sku");
        if (!p.titulo.trim()) falta.push("titulo");
        if (!(p.custo > 0)) falta.push("custo");
        if (!(p.peso_g > 0)) falta.push("peso");
        if (!(p.comprimento_cm > 0)) falta.push("comprimento");
        if (!(p.largura_cm > 0)) falta.push("largura");
        if (!(p.altura_cm > 0)) falta.push("altura");
        if (skus.has(p.sku)) falta.push("sku repetido na lista");
        skus.add(p.sku);
        if (falta.length) pendencias.push(`${p.sku || p.titulo || "?"}: ${falta.join(", ")}`);
      }
      if (pendencias.length) {
        return text({ gerado: false, pendencias });
      }

      const wb = await abrir(caminho);
      const m = acharCabecalho(wb, aba);

      // Primeira linha livre abaixo do cabeçalho (ignora linhas vazias).
      let linha = m.linhaCab + 1;
      while (linha <= m.ws.rowCount && m.ws.getRow(linha).hasValues) linha++;

      const semColuna = new Set<string>();
      for (const p of produtos) {
        const row = m.ws.getRow(linha);
        const valores: Record<Campo, unknown> = {
          sku: p.sku,
          titulo: p.titulo,
          custo: p.custo,
          preco_varejo: p.preco_varejo,
          peso_g: p.peso_g,
          comprimento_cm: p.comprimento_cm,
          largura_cm: p.largura_cm,
          altura_cm: p.altura_cm,
          gtin: p.gtin,
          ncm: p.ncm,
          cest: p.cest,
          origem: p.origem,
          fornecedor: p.fornecedor,
          link_fornecedor: p.link_fornecedor,
          imagem: p.imagem,
          categoria: p.categoria,
          apelido: p.apelido,
          estoque: p.estoque,
          marca: p.marca,
        };
        for (const [campo, valor] of Object.entries(valores) as Array<[Campo, unknown]>) {
          if (valor === undefined || valor === "") continue;
          const col = m.colunas.get(campo);
          if (!col) {
            semColuna.add(campo);
            continue;
          }
          // Textos que parecem número (SKU, GTIN, NCM) ficam como texto.
          row.getCell(col).value = typeof valor === "number" ? valor : String(valor);
        }
        row.commit();
        linha++;
      }

      const pasta = pasta_saida
        ? pasta_saida.startsWith("~") ? path.join(os.homedir(), pasta_saida.slice(1)) : pasta_saida
        : path.dirname(caminho);
      fs.mkdirSync(pasta, { recursive: true });
      const agora = new Date();
      const carimbo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}_${String(agora.getHours()).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}`;
      const saida = path.join(pasta, `importar-upseller_${carimbo}.xlsx`);
      await wb.xlsx.writeFile(saida);
      writeConfig({ ...readConfig(), modelo: caminho });

      return text({
        gerado: true,
        arquivo: saida,
        produtos: produtos.length,
        aba: m.ws.name,
        campos_sem_coluna_no_modelo: semColuna.size ? [...semColuna] : undefined,
        tipos_sem_ncm: semFiscal.size ? [...semFiscal] : undefined,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "definir_padroes",
  {
    description: "Guarda valores que se repetem em todo produto (fornecedor, origem, estoque inicial, categoria) para não precisar enviá-los a cada cadastro.",
    inputSchema: {
      fornecedor: z.string().optional(),
      origem: z.string().optional(),
      estoque: z.number().optional(),
      categoria: z.string().optional(),
    },
  },
  async (p) => {
    const c = readConfig();
    writeConfig({ ...c, padroes: { ...c.padroes, ...p } });
    return text({ padroes: { ...c.padroes, ...p } });
  }
);

server.registerTool(
  "guardar_fiscal",
  {
    description: "Guarda NCM/CEST/origem de um tipo de produto (ex.: torneira, joelho 90). Pesquise uma vez por tipo; nos próximos cadastros gerar_planilha preenche sozinho pelo campo tipo. Sem certeza, não guarde.",
    inputSchema: { tipo: z.string(), ncm: z.string(), cest: z.string().optional(), origem: z.string().optional() },
  },
  async ({ tipo, ncm, cest, origem }) => {
    const c = readConfig();
    writeConfig({ ...c, fiscal: { ...c.fiscal, [norm(tipo)]: { ncm, cest, origem } } });
    return text({ guardado: tipo });
  }
);

server.registerTool(
  "proximo_sku",
  {
    description:
      "Próximo(s) SKU numérico(s) livre(s); avança o contador guardado.",
    inputSchema: { quantidade: z.number().int().min(1).max(200).optional() },
  },
  async ({ quantidade }) => {
    try {
      const c = readConfig();
      if (c.ultimo_sku === undefined) {
        return fail(new Error("Contador não definido. Chame definir_ultimo_sku com o maior SKU numérico que já existe no UpSeller."));
      }
      const n = quantidade ?? 1;
      const lista = Array.from({ length: n }, (_, i) => String(c.ultimo_sku! + 1 + i));
      writeConfig({ ...c, ultimo_sku: c.ultimo_sku + n });
      return text({ skus: lista });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "definir_ultimo_sku",
  {
    description: "Define o maior SKU numérico já existente no UpSeller (confirmado, não chutado).",
    inputSchema: { ultimo_sku: z.number().int().min(0) },
  },
  async ({ ultimo_sku }) => {
    writeConfig({ ...readConfig(), ultimo_sku });
    return text({ ultimo_sku });
  }
);

await server.connect(new StdioServerTransport());
